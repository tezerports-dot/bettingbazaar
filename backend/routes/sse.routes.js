// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * SSE ROUTES — backend/routes/sse.routes.js  v2.0.0
 * ════════════════════════════════════════════════════════════════════════════
 *
 * v2.0.0 — Added private SSE channels for merchant and admin panels.
 *
 * THREE ENDPOINTS:
 *   GET /api/sse/events                — Public: cycles, branding, system_config
 *   GET /api/sse/merchant/events       — Private: merchant order events (PASETO auth)
 *   GET /api/sse/admin/events          — Private: admin queue/KYC/cycle events (PASETO auth)
 *
 * PRIVATE CHANNEL AUTH:
 *   Pass PASETO as ?token=... query param (EventSource doesn't support headers).
 *   Token is verified before registering the SSE client.
 *
 * CRITICAL HEADERS (required for SSE through Railway nginx):
 *   Content-Type: text/event-stream
 *   X-Accel-Buffering: no   ← disables nginx buffering (events arrive instantly)
 *   Cache-Control: no-cache
 *   Connection: keep-alive
 */

import express from 'express';
// AQ-1/AQ-2: verify via the single PASETO authority. This replaces a
// `process.env.JWT_SECRET || 'fallback-secret'` default that verified user and
// admin SSE tokens against a PUBLIC string whenever the env var was unset —
// anyone could have forged a token and opened these streams. verifyJwt pins
// HS256 and uses the fail-fast secret.
import { verifyJwt } from '../domains/identity/jwt.util.js';
import { isTokenRevoked } from '../domains/identity/auth.middleware.js';
import { buildDescendingCursorFilter, normalizeLimit, paginatedResponse } from '../utils/cursorPagination.js';
import { fetchCycleHistory } from '../domains/markets/cycleHistory.service.js';

const ADMIN_QUEUE_SNAPSHOT_FIELDS = [
    'orderId', 'userId', 'type', 'status',
    'tokenAmount', 'fiatAmount', 'amount', 'rateUsed',
    'merchantProfit', 'merchantFee', 'payoutFee',
    'utrWarning', 'utrWarningMessage', 'requiresReview',
    'redFlagged', 'redFlagReason',
    'assignedAt', 'expiresAt', 'paidAt', 'completedAt',
    'bulkPayoutDate', 'bulkPaidAt', 'bulkPayoutBatch',
    'createdAt', 'updatedAt',
].join(' ');

const PUBLIC_SYSTEM_CONFIG_FIELDS = [
    'minBetAmount',
    'maxBetAmount',
    'bettingEnabled',
    'maintenanceMode',
    'supportMessage',
    'appVersion',
    'downloadLinks',
    'publicAnnouncements',
];

function toPublicSystemConfig(config) {
    const source = typeof config?.toObject === 'function' ? config.toObject() : (config || {});
    return PUBLIC_SYSTEM_CONFIG_FIELDS.reduce((safe, key) => {
        if (Object.prototype.hasOwnProperty.call(source, key)) safe[key] = source[key];
        return safe;
    }, {});
}

/** Apply the required SSE headers and flush immediately. */
function initSSEResponse(res) {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    // Access-Control-Allow-Origin is set by the global CORS middleware in server.js
    // DO NOT set it here — overwriting with '*' breaks credentialed requests
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.flushHeaders();
    res.write('retry: 3000\n\n');
}

export function initSSERoutes(sseManager, cycleGenerator) {
    const router = express.Router();

    // ── GET /api/sse/events ── PUBLIC ─────────────────────────────────────────
    router.get('/events', async (req, res) => {
        initSSEResponse(res);

        const clientId = sseManager.addClient(res);

        // ── Cycle topics ──────────────────────────────────────────────────────
        // `?cycles=<id>,<id>` scopes the live pool stream to the cycles this
        // client is actually looking at. Omitted (the default) means it wants
        // none — see cycleSnapshotPublisher.flush() for why that is the right
        // default: a client with a working WebSocket already receives the same
        // snapshot room-scoped, and the SSE copy was pure duplication.
        //
        // The subscription is in the URL rather than settable over the stream
        // because SSE is one-way: there is no client→server channel to carry a
        // `watch_cycle`, and adding a POST endpoint to mutate it would be a
        // second, unauthenticated way to reach into a live connection. Changing
        // boards means reopening the EventSource, which the browser does in
        // milliseconds and only on the fallback path.
        const requested = String(req.query.cycles ?? '')
            .split(',').map((s) => s.trim()).filter(Boolean);
        if (requested.length) sseManager.watchCycles(clientId, requested);

        // 1. Cycle snapshot
        try {
            const snapshot = await cycleGenerator.getCycleSnapshotData();
            sseManager.sendToClient(clientId, 'cycle_snapshot', {
                cycles: snapshot, timestamp: Date.now()
            });
        } catch (e) {
            console.error('❌ SSE initial cycle_snapshot error:', e.message);
        }

        // 2. System config
        if (global.cachedSystemConfig) {
            sseManager.sendToClient(clientId, 'system_config', toPublicSystemConfig(global.cachedSystemConfig));
        }

        // 3. Branding
        if (global.cachedBranding) {
            sseManager.sendToClient(clientId, 'branding', global.cachedBranding);
        }

        // 4. Cycle history — every type, `limit` rows EACH.
        //
        // The endTime cursor this used to carry is gone: it paginated one
        // interleaved list, and there is no longer one list to page through.
        // Nothing sent a cursor — the client takes this payload as its whole
        // history and re-requests over the socket when it wants more — so this
        // removes an unused parameter rather than a feature. Per-type paging
        // belongs on `request_cycle_history`, which takes a type.
        try {
            const limit = normalizeLimit(req.query.limit, 50, 100);
            sseManager.sendToClient(clientId, 'cycle_history', {
                ...(await fetchCycleHistory({ limit })),
                serverTime: Date.now(),
            });
        } catch (e) {
            console.error('❌ SSE initial cycle_history error:', e.message);
        }
    });

    // ── GET /api/sse/merchant/events ── PRIVATE ───────────────────────────────
    //
    
    // Query param: ?token=<merchant PASETO>
    // Events emitted to this stream:
    //   new_order       — new order assigned to this merchant
    //   order_update    — status change on an existing order
    //   merchant_stats  — balance / earnings snapshot
    //
    router.get('/merchant/events', async (req, res) => {
        const { token } = req.query;

        if (!token) {
            return res.status(401).json({ success: false, message: 'token query param required' });
        }

        let decoded;
        try {
            decoded = verifyJwt(token);
        } catch {
            return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }
        if (await isTokenRevoked(token)) {
            return res.status(401).json({ success: false, message: 'Token has been invalidated' });
        }

        if (!decoded.isMerchant || !decoded.merchantId) {
            return res.status(403).json({ success: false, message: 'Not a merchant token' });
        }

        // Verify merchant is still active
        try {
            const mongoose = await import('mongoose');
            const Merchant = mongoose.default.model('Merchant');
            const merchant = await Merchant.findById(decoded.merchantId).lean();
            if (!merchant || !['ACTIVE'].includes(merchant.status)) {
                return res.status(403).json({ success: false, message: 'Merchant account is not active' });
            }
        } catch (e) {
            console.error('❌ SSE merchant auth check error:', e.message);
            return res.status(500).json({ success: false, message: 'Auth check failed' });
        }

        initSSEResponse(res);

        const merchantId = decoded.merchantId.toString();
        sseManager.addMerchantClient(merchantId, res);

        // Push current active merchant orders snapshot immediately on connect.
        // ✅ FIXED BUG-6: PaymentOrder.merchantId now stores Merchant._id = decoded.merchantId
        // so this query now correctly returns the merchant's orders (was always empty before)
        try {
            const mongoose = await import('mongoose');
            const PaymentOrder = mongoose.default.model('PaymentOrder');
            const limit = normalizeLimit(req.query.limit, 50, 100);
            const cursorFilter = buildDescendingCursorFilter(req.query.cursor);
            const orders = await PaymentOrder.find({
                merchantId,
                status: { $in: ['ASSIGNED', 'PROCESSING', 'PAID', 'PENDING_QUEUE'] },
                ...cursorFilter,
            }).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
            const page = paginatedResponse(orders, limit);

            sseManager.writeEvent(res, 'merchant_orders_snapshot', { orders: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore, serverTime: page.serverTime, timestamp: Date.now() });
        } catch (e) {
            console.error('❌ SSE merchant snapshot error:', e.message);
        }
    });

    // ── GET /api/sse/admin/events ── PRIVATE ──────────────────────────────────
    //
    
    // Query param: ?token=<admin PASETO>
    // Events emitted to this stream:
    //   new_order           — new order in the PENDING_QUEUE
    //   queue_order_update  — any order status change
    //   kyc_update          — KYC submission / action
    //   admin_cycle_update  — cycle pool breakdown (real + phantom)
    //   admin_new_cycle     — new cycle created
    //   admin_cycle_result  — cycle result declared
    //
    router.get('/admin/events', async (req, res) => {
        const { token } = req.query;

        if (!token) {
            return res.status(401).json({ success: false, message: 'token query param required' });
        }

        let decoded;
        try {
            decoded = verifyJwt(token);
        } catch {
            return res.status(401).json({ success: false, message: 'Invalid or expired token' });
        }
        if (await isTokenRevoked(token)) {
            return res.status(401).json({ success: false, message: 'Token has been invalidated' });
        }

        const mongoose = await import('mongoose');
        const User = mongoose.default.model('User');
        const adminUser = await User.findById(decoded.userId).select('isAdmin isSubAdmin isQueueManager isBlocked subAdminPermissions').lean();
        if (!adminUser || adminUser.isBlocked ||
            (!adminUser.isAdmin && !adminUser.isSubAdmin && !adminUser.isQueueManager)) {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        initSSEResponse(res);
        sseManager.addAdminClient(res);

        // Push queue snapshot immediately on connect
        try {
            const PaymentOrder = mongoose.default.model('PaymentOrder');
            const limit = normalizeLimit(req.query.limit, 100, 250);
            const cursorFilter = buildDescendingCursorFilter(req.query.cursor);
            const pendingOrders = await PaymentOrder.find({ status: 'PENDING_QUEUE', ...cursorFilter })
                .select(ADMIN_QUEUE_SNAPSHOT_FIELDS)
                .populate('userId', 'username mobile')
                .sort({ createdAt: -1, _id: -1 })
                .limit(limit + 1)
                .lean();
            const page = paginatedResponse(pendingOrders, limit);

            sseManager.writeEvent(res, 'queue_snapshot', { orders: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore, serverTime: page.serverTime, timestamp: Date.now() });
        } catch (e) {
            console.error('❌ SSE admin queue snapshot error:', e.message);
        }
    });

    // ── GET /api/sse/stats ── MONITORING ──────────────────────────────────────
    router.get('/stats', (req, res) => {
        res.json({
            success: true,
            sse: sseManager.getStats(),
            timestamp: new Date().toISOString()
        });
    });

    return router;
}
