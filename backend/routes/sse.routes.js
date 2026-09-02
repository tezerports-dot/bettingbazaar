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
import { db } from '#db';
// AQ-1/AQ-2: verify via the single PASETO authority. This replaces a
// `process.env.JWT_SECRET || 'fallback-secret'` default that verified user and
// admin SSE tokens against a PUBLIC string whenever the env var was unset —
// anyone could have forged a token and opened these streams. verifyJwt pins
// HS256 and uses the fail-fast secret.
import { verifyJwt } from '../domains/identity/jwt.util.js';
import { isTokenRevoked } from '../domains/identity/auth.middleware.js';
import { decodeOrderCursor, encodeOrderCursor, normalizeLimit } from '../utils/cursorPagination.js';
import { fetchCycleHistory } from '../domains/markets/cycleHistory.service.js';

// The admin queue projection used to be a hand-written field list here. It is
// the repository's `toOrder` now — one description of what an order looks like
// rather than two, so a column added to the order does not have to be
// remembered in a string in a route file to reach the screen that shows it.

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

        // Verify the merchant is still active. FAILS CLOSED: a token is a
        // claim about who somebody was when it was issued, and this is the
        // check that they still are. Letting a database blip open the stream
        // would keep a suspended merchant connected to the live order feed.
        try {
            const merchant = await db.merchants.getMerchant(decoded.merchantId);
            if (!merchant || merchant.status !== 'ACTIVE') {
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
            const limit = normalizeLimit(req.query.limit, 50, 100);
            // KEYSET, through the repository. The cursor is `(createdAt, orderId)`
            // and the filter is part of the statement rather than a spread of
            // query fragments assembled here — an order created while a merchant
            // pages shifts every later row by one, and the page after it
            // silently skips an order the merchant is meant to work.
            const page = await db.orders.findOrders({
                merchantId,
                states: ['ASSIGNED', 'PROCESSING', 'PAID', 'PENDING_QUEUE'],
                limit,
                cursor: decodeOrderCursor(req.query.cursor),
            });

            sseManager.writeEvent(res, 'merchant_orders_snapshot', {
                orders: page.orders,
                nextCursor: page.nextCursor ? encodeOrderCursor(page.nextCursor) : null,
                hasMore: Boolean(page.nextCursor),
                serverTime: Date.now(),
                timestamp: Date.now(),
            });
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

        // Re-checked against the ROW, not taken from the token. A token issued
        // before an admin was blocked still carries their old claims, and this
        // stream carries every order, every KYC submission and every cycle
        // result — the last thing a revoked admin should keep receiving.
        const adminUser = await db.users.getUser(decoded.userId);
        if (!adminUser || adminUser.isBlocked
            || (!adminUser.isAdmin && !adminUser.isSubAdmin && !adminUser.isQueueManager)) {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        initSSEResponse(res);
        sseManager.addAdminClient(res);

        // Push queue snapshot immediately on connect
        try {
            const limit = normalizeLimit(req.query.limit, 100, 250);
            const page = await db.orders.findOrders({
                state: 'PENDING_QUEUE',
                limit,
                cursor: decodeOrderCursor(req.query.cursor),
            });

            sseManager.writeEvent(res, 'queue_snapshot', {
                orders: page.orders,
                nextCursor: page.nextCursor ? encodeOrderCursor(page.nextCursor) : null,
                hasMore: Boolean(page.nextCursor),
                serverTime: Date.now(),
                timestamp: Date.now(),
            });
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
