// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import jwt from 'jsonwebtoken';
import crypto from 'crypto';

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

        // Private admin channel  Set<response>
        this.adminClients = new Set();

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
        } catch (e) { /* delivery to remote instances is best-effort */ }
    }

    /** Apply a fan-out that arrived from another instance to LOCAL clients. */
    _dispatchLocal({ kind, args }) {
        switch (kind) {
            case 'broadcast':        return this._localBroadcast(...args);
            case 'sendToUser':       return this._localSendToUser(...args);
            case 'sendToMerchant':   return this._localSendToMerchant(...args);
            case 'broadcastToAdmins':return this._localBroadcastToAdmins(...args);
        }
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
     * Called by wallet.service.js after every atomic wallet operation.
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
    addMerchantClient(merchantId, res) {
        const key = merchantId.toString();
        if (!this.merchantClients.has(key)) {
            this.merchantClients.set(key, new Set());
        }
        this.merchantClients.get(key).add(res);
        this.stats.totalConnections++;

        res.on('close', () => {
            const set = this.merchantClients.get(key);
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

    // ── ADMIN PRIVATE CHANNEL ─────────────────────────────────────────────────

    /**
     * Register an admin SSE connection.
     * @param {Response} res — Express response object
     */
    addAdminClient(res) {
        this.adminClients.add(res);
        this.stats.totalConnections++;

        res.on('close', () => { this.adminClients.delete(res); });

        console.log(`📡 SSE admin: client connected (total admins: ${this.adminClients.size})`);
    }

    /**
     * Broadcast an event to ALL connected admin SSE clients.
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
        const dead = [];
        for (const res of this.adminClients) {
            this._writeOrDrop(res, payload, () => dead.push(res));
        }
        for (const res of dead) this.adminClients.delete(res);
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
        for (const res of this.adminClients) {
            this._writeOrDrop(res, ping, () => deadAdmin.push(res));
        }
        for (const res of deadAdmin) this.adminClients.delete(res);
    }

    getStats() {
        return {
            active:        this.clients.size,
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
        this.adminClients.clear();
    }
}

export default SSEManager;
