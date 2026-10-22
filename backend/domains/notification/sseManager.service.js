// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)


import crypto from 'crypto';
import { staffMayReceive } from './staffEventAreas.js';
import { seesContact, shieldContact } from '../identity/staffContactShield.js';

const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

function resolveMaxBufferedBytes(value) {
    if (value == null || String(value).trim() === '') return DEFAULT_MAX_BUFFERED_BYTES;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_BUFFERED_BYTES;
    return Math.max(1024, parsed);
}

class SSEManager {
    constructor() {
        // Public broadcast clients  Map<clientId, response>
        this.clients = new Map();

        // Private merchant channels  Map<merchantId_string, Set<response>>
        this.merchantClients = new Map();
        // res → the login that opened a merchant stream (see addMerchantClient).
        this.merchantStreamLogins = new Map();

        // Private staff channel  Map<response, viewer>. The viewer is the staff
        // account as it was when the stream opened: what it may receive is
        // decided per event from its permissions (staffEventAreas.js), and a
        // change to those permissions closes the stream (closeAdminClientsFor),
        // so a stream never outlives the grant it was opened under.
        this.adminClients = new Map();

        // Private USER channels  Map<userId_string, Set<response>>
        // Wallet service calls sendToUser after every balance change.
        this.userClients = new Map();

        this.nextId  = 0;
        this.stats   = { totalConnections: 0, totalMessages: 0, droppedBackpressure: 0 };
        this.maxBufferedBytes = resolveMaxBufferedBytes(process.env.SSE_MAX_BUFFERED_BYTES);

        // ── Horizontal-scale bridge (Phase X, 2026-07-10) ─────────────────────
        // SSE connections are pinned to one backend instance, but an event
        // (bet_placed, cycle_result, balance_update) can be produced on ANY
        // instance. attachRedis() wires a Redis pub/sub relay so a fan-out on
        // one instance reaches SSE clients on all of them. Unset (single
        // instance / no REDIS_URL) → purely local, identical to before.
        this._origin = crypto.randomUUID(); // this instance's id (dedup tag)
        this._pub = null;                    // ioredis publisher (or null)
        this._channel = 'bb:sse';
        // Instance-to-instance messages that are not deliveries (sharePeer).
        this._peerHandlers = new Map();

        // Keep-alive ping every 25s — prevents Railway 30s idle timeout
        this._pingInterval = setInterval(() => this._ping(), 25000);
    }

    // ── REDIS BRIDGE ──────────────────────────────────────────────────────────

    /**
     * attachRedis — enable cross-instance fan-out. `pub` publishes; `sub` is a
     * dedicated subscriber connection (subscribe-mode). A message this instance
     * originated is skipped on receipt (it already delivered locally), so no
     * client is written to twice.
     */
    attachRedis(pub, sub) {
        this._pub = pub;
        sub.subscribe(this._channel).catch((e) =>
            console.warn('[sse-bridge] subscribe failed:', e.message));
        sub.on('message', (channel, raw) => {
            if (channel !== this._channel) return;
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (!msg || msg.origin === this._origin) return; // our own echo
            this._dispatchLocal(msg);
        });
        console.log('📡 SSE Redis bridge active (cross-instance fan-out).');
    }

    /** Publish a fan-out to the other instances (no-op without the bridge). */
    _publish(kind, args) {
        if (!this._pub) return;
        try {
            this._pub.publish(this._channel, JSON.stringify({ origin: this._origin, kind, args }));
        } catch { /* delivery to remote instances is best-effort */ }
    }

    /** Apply a fan-out that arrived from another instance to LOCAL clients. */
    _dispatchLocal({ kind, args }) {
        switch (kind) {
            case 'broadcast':        return this._localBroadcast(...args);
            case 'sendToUser':       return this._localSendToUser(...args);
            case 'sendToMerchant':   return this._localSendToMerchant(...args);
            case 'broadcastToAdmins':return this._localBroadcastToAdmins(...args);
            case 'closeAdminClientsFor': return this._localCloseAdminClientsFor(...args);
            case 'closeMerchantClientsFor': return this._localCloseMerchantClientsFor(...args);
            case 'broadcastToMerchants': return this._localBroadcastToMerchants(...args);
            case 'peer':             return this._peerHandlers.get(args[0])?.(args[1]);
        }
    }

    /**
     * sharePeer / onPeer — hand data to the OTHER instances without writing it
     * to any client. A producer that batches its own deliveries (the cycle pool
     * publisher) shares what it produced here and lets every instance send its
     * own clients one combined message, instead of relaying each copy through
     * `broadcast`, which writes every instance's copy to every stream.
     */
    sharePeer(kind, payload) {
        this._publish('peer', [kind, payload]);
    }

    onPeer(kind, handler) {
        this._peerHandlers.set(kind, handler);
    }

    // ── WRITE SAFETY / BACKPRESSURE ───────────────────────────────────────────

    _writeOrDrop(res, payload, onDrop) {
        if (!res || res.destroyed || res.writableEnded) {
            onDrop?.();
            return false;
        }
        const projectedBytes = (res.writableLength || 0) + Buffer.byteLength(String(payload));
        if (projectedBytes > this.maxBufferedBytes) {
            this.stats.droppedBackpressure++;
            try { res.end(); } catch { /* drop slow client */ }
            onDrop?.();
            return false;
        }
        try {
            const accepted = res.write(payload);
            this.stats.totalMessages++;
            if (!accepted && (res.writableLength || 0) > this.maxBufferedBytes) {
                this.stats.droppedBackpressure++;
                try { res.end(); } catch { /* drop slow client */ }
                onDrop?.();
                return false;
            }
            return true;
        } catch {
            onDrop?.();
            return false;
        }
    }

    writeEvent(res, event, data, onDrop) {
        return this._writeOrDrop(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, onDrop);
    }

    // ── PUBLIC CHANNEL ────────────────────────────────────────────────────────

    /** Register a new public SSE client. Returns the assigned clientId. */
    addClient(res) {
        const id = ++this.nextId;
        this.clients.set(id, res);
        this.stats.totalConnections++;
        res.on('close', () => { this.clients.delete(id); });
        console.log(`📡 SSE public: client ${id} connected (total: ${this.clients.size})`);
        return id;
    }

    // ── USER PRIVATE CHANNEL ──────────────────────────────────────────────────

    addUserClient(userId, res) {
        const uid = String(userId);
        if (!this.userClients.has(uid)) this.userClients.set(uid, new Set());
        this.userClients.get(uid).add(res);
        this.stats.totalConnections++;
        res.on('close', () => {
            const set = this.userClients.get(uid);
            if (set) { set.delete(res); if (set.size === 0) this.userClients.delete(uid); }
        });
    }

    /**
     * sendToUser — push balance_update or order_status to a specific user.
     * Called by realtimeEmitters.sseBalancePush after every wallet movement.
     * Zero extra infrastructure: reuses the existing SSE HTTP connection.
     */
    sendToUser(userId, event, data) {
        this._localSendToUser(userId, event, data);
        this._publish('sendToUser', [String(userId), event, data]);
    }

    _localSendToUser(userId, event, data) {
        const set = this.userClients.get(String(userId));
        if (!set || set.size === 0) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const dead = [];
        for (const res of set) {
            this._writeOrDrop(res, payload, () => dead.push(res));
        }
        for (const res of dead) set.delete(res);
    }

    /** Broadcast a named SSE event to ALL public clients (all instances). */
    broadcast(event, data) {
        this._localBroadcast(event, data);
        this._publish('broadcast', [event, data]);
    }

    /** Broadcast to THIS instance's public clients only (see sharePeer). */
    broadcastLocal(event, data) {
        this._localBroadcast(event, data);
    }

    _localBroadcast(event, data) {
        if (this.clients.size === 0) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const dead = [];
        for (const [id, res] of this.clients) {
            this._writeOrDrop(res, payload, () => dead.push(id));
        }
        for (const id of dead) this.clients.delete(id);
    }

    /** Send a named event to a single public client (initial connect push). */
    sendToClient(clientId, event, data) {
        const res = this.clients.get(clientId);
        if (!res) return;
        this.writeEvent(res, event, data, () => this.clients.delete(clientId));
    }

    // ── MERCHANT PRIVATE CHANNEL ──────────────────────────────────────────────

    /**
     * Register a merchant SSE connection.
     * @param {string} merchantId  — Merchant._id as string
     * @param {Response} res       — Express response object
     */
    addMerchantClient(merchantId, res, { loginUserId = null } = {}) {
        const key = merchantId.toString();
        // Which login opened it: the owner's, or a sub-member's of a merchant
        // account (owner, 2026-10-11), so a change of that sub-member's roles
        // can end their streams (`closeMerchantClientsFor`).
        if (loginUserId) this.merchantStreamLogins.set(res, String(loginUserId));
        if (!this.merchantClients.has(key)) {
            this.merchantClients.set(key, new Set());
        }
        this.merchantClients.get(key).add(res);
        this.stats.totalConnections++;

        res.on('close', () => {
            const set = this.merchantClients.get(key);
            this.merchantStreamLogins.delete(res);
            if (set) {
                set.delete(res);
                if (set.size === 0) this.merchantClients.delete(key);
            }
        });

        console.log(`📡 SSE merchant [${key}]: client connected`);
    }

    /**
     * Send an event to all SSE connections for a specific merchant.
     * @param {string} merchantId
     * @param {string} event
     * @param {object} data
     */
    sendToMerchant(merchantId, event, data) {
        this._localSendToMerchant(String(merchantId), event, data);
        this._publish('sendToMerchant', [String(merchantId), event, data]);
    }

    _localSendToMerchant(merchantId, event, data) {
        const key = merchantId.toString();
        const set = this.merchantClients.get(key);
        if (!set || set.size === 0) return;

        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const dead = [];
        for (const res of set) {
            this._writeOrDrop(res, payload, () => dead.push(res));
        }
        for (const res of dead) set.delete(res);
    }

    /**
     * Broadcast to EVERY connected merchant.
     *
     * `sendToMerchant('*', …)` does not do this and never did: it looks up the
     * literal key '*' in `merchantClients`, finds no set, and returns — reaching
     * nobody, with no error and no log. A platform-wide announcement (the
     * settlement rail changing under a merchant mid-shift) needs a real fan-out,
     * so it gets one rather than a wildcard that reads like one.
     */
    broadcastToMerchants(event, data) {
        this._localBroadcastToMerchants(event, data);
        this._publish('broadcastToMerchants', [event, data]);
    }

    _localBroadcastToMerchants(event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const [key, set] of this.merchantClients) {
            const dead = [];
            for (const res of set) {
                this._writeOrDrop(res, payload, () => dead.push(res));
            }
            for (const res of dead) set.delete(res);
            if (set.size === 0) this.merchantClients.delete(key);
        }
    }

    // ── ADMIN PRIVATE CHANNEL ─────────────────────────────────────────────────

    /**
     * Register an admin SSE connection.
     * @param {Response} res — Express response object
     */
    /**
     * @param {import('http').ServerResponse} res
     * @param {{userId:string,isAdmin?:boolean,isSubAdmin?:boolean,subAdminPermissions?:object}} viewer
     *   REQUIRED. A stream with no viewer would have to be sent everything or
     *   nothing, and "everything" is the defect this exists to stop.
     */
    addAdminClient(res, viewer) {
        if (!viewer?.userId) throw new Error('addAdminClient: the staff viewer is required');
        this.adminClients.set(res, viewer);
        this.stats.totalConnections++;

        res.on('close', () => { this.adminClients.delete(res); });

        console.log(`📡 SSE admin: client connected (total admins: ${this.adminClients.size})`);
    }

    /**
     * Broadcast an event to the connected staff ALLOWED it — the areas
     * `staffEventAreas.js` names for this event, and full admins.
     * @param {string} event
     * @param {object} data
     */
    broadcastToAdmins(event, data) {
        this._localBroadcastToAdmins(event, data);
        this._publish('broadcastToAdmins', [event, data]);
    }

    _localBroadcastToAdmins(event, data) {
        if (this.adminClients.size === 0) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        // Contact and payout details go to full admins only (staffContactShield.js).
        let shielded = null;
        const shieldedPayload = () => (shielded ??= `event: ${event}\ndata: ${JSON.stringify(shieldContact(data))}\n\n`);
        const dead = [];
        for (const [res, viewer] of this.adminClients) {
            if (!staffMayReceive(viewer, event)) continue;
            this._writeOrDrop(res, seesContact(viewer) ? payload : shieldedPayload(), () => dead.push(res));
        }
        for (const res of dead) this.adminClients.delete(res);
    }

    /**
     * End every staff stream this account holds, on every instance. Called when
     * an admin changes or removes a sub-admin's permissions: the panel
     * reconnects, and the new stream is opened under the new grant.
     */
    closeAdminClientsFor(userId) {
        this._localCloseAdminClientsFor(userId);
        this._publish('closeAdminClientsFor', [userId]);
    }

    _localCloseAdminClientsFor(userId) {
        for (const [res, viewer] of this.adminClients) {
            if (String(viewer.userId) !== String(userId)) continue;
            this.adminClients.delete(res);
            try { res.end(); } catch { /* already gone */ }
        }
    }

    /**
     * End every merchant-panel stream one LOGIN holds, on every instance: a
     * merchant account's sub-member whose roles changed or who was removed
     * (owner, 2026-10-11). Their sessions are already dead (the login's
     * `sessions_valid_from` moved); this closes what is open now.
     */
    closeMerchantClientsFor(loginUserId) {
        this._localCloseMerchantClientsFor(loginUserId);
        this._publish('closeMerchantClientsFor', [loginUserId]);
    }

    _localCloseMerchantClientsFor(loginUserId) {
        for (const [res, login] of this.merchantStreamLogins) {
            if (login !== String(loginUserId)) continue;
            this.merchantStreamLogins.delete(res);
            for (const [key, set] of this.merchantClients) {
                if (set.delete(res) && set.size === 0) this.merchantClients.delete(key);
            }
            try { res.end(); } catch { /* already gone */ }
        }
    }

    // ── KEEP-ALIVE ────────────────────────────────────────────────────────────

    _ping() {
        const ping = ': ping\n\n';

        // Public clients
        const deadPublic = [];
        for (const [id, res] of this.clients) {
            this._writeOrDrop(res, ping, () => deadPublic.push(id));
        }
        for (const id of deadPublic) this.clients.delete(id);

        // Merchant clients
        for (const [key, set] of this.merchantClients) {
            const dead = [];
            for (const res of set) {
                this._writeOrDrop(res, ping, () => dead.push(res));
            }
            for (const res of dead) set.delete(res);
            if (set.size === 0) this.merchantClients.delete(key);
        }

        // Admin clients
        const deadAdmin = [];
        for (const res of this.adminClients.keys()) {
            this._writeOrDrop(res, ping, () => deadAdmin.push(res));
        }
        for (const res of deadAdmin) this.adminClients.delete(res);
    }

    getStats() {
        return {
            active:        this.clients.size,
            activeUsers:   [...this.userClients.values()].reduce((a, s) => a + s.size, 0),
            activeMerchants: [...this.merchantClients.values()].reduce((a, s) => a + s.size, 0),
            activeAdmins:  this.adminClients.size,
            totalIn:       this.stats.totalConnections,
            totalOut:      this.stats.totalMessages,
            droppedBackpressure: this.stats.droppedBackpressure,
            maxBufferedBytes: this.maxBufferedBytes,
        };
    }

    destroy() {
        clearInterval(this._pingInterval);
        this.clients.clear();
        this.merchantClients.clear();
        this.merchantStreamLogins.clear();
        this.adminClients.clear();
    }
}

export default SSEManager;
