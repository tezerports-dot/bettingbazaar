// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import jwt from 'jsonwebtoken';

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
        this.stats   = { totalConnections: 0, totalMessages: 0 };

        // Keep-alive ping every 25s — prevents Railway 30s idle timeout
        this._pingInterval = setInterval(() => this._ping(), 25000);
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
        const set = this.userClients.get(String(userId));
        if (!set || set.size === 0) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const dead = [];
        for (const res of set) {
            try { res.write(payload); this.stats.totalMessages++; }
            catch { dead.push(res); }
        }
        for (const res of dead) set.delete(res);
    }

    /** Broadcast a named SSE event to ALL public clients. */
    broadcast(event, data) {
        if (this.clients.size === 0) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const dead = [];
        for (const [id, res] of this.clients) {
            try { res.write(payload); this.stats.totalMessages++; }
            catch { dead.push(id); }
        }
        for (const id of dead) this.clients.delete(id);
    }

    /** Send a named event to a single public client (initial connect push). */
    sendToClient(clientId, event, data) {
        const res = this.clients.get(clientId);
        if (!res) return;
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
        catch { this.clients.delete(clientId); }
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
        const key = merchantId.toString();
        const set = this.merchantClients.get(key);
        if (!set || set.size === 0) return;

        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const dead = [];
        for (const res of set) {
            try { res.write(payload); this.stats.totalMessages++; }
            catch { dead.push(res); }
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
        if (this.adminClients.size === 0) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const dead = [];
        for (const res of this.adminClients) {
            try { res.write(payload); this.stats.totalMessages++; }
            catch { dead.push(res); }
        }
        for (const res of dead) this.adminClients.delete(res);
    }

    // ── KEEP-ALIVE ────────────────────────────────────────────────────────────

    _ping() {
        const ping = ': ping\n\n';

        // Public clients
        const deadPublic = [];
        for (const [id, res] of this.clients) {
            try { res.write(ping); }
            catch { deadPublic.push(id); }
        }
        for (const id of deadPublic) this.clients.delete(id);

        // Merchant clients
        for (const [key, set] of this.merchantClients) {
            const dead = [];
            for (const res of set) {
                try { res.write(ping); }
                catch { dead.push(res); }
            }
            for (const res of dead) set.delete(res);
            if (set.size === 0) this.merchantClients.delete(key);
        }

        // Admin clients
        const deadAdmin = [];
        for (const res of this.adminClients) {
            try { res.write(ping); }
            catch { deadAdmin.push(res); }
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
