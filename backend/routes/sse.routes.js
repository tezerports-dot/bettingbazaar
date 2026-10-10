// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * SSE ROUTES — backend/routes/sse.routes.js  v2.0.0
 * ════════════════════════════════════════════════════════════════════════════
 *
 * v2.0.0 — Added private SSE channels for merchant and admin panels.
 *
 * FOUR ENDPOINTS:
 *   GET /api/sse/events                — Public: cycles, branding, system_config
 *   GET /api/sse/player/events         — The public stream PLUS one signed-in
 *                                        player's own pushes (balance, payout,
 *                                        order). The player app's only live
 *                                        connection; it opens no socket.
 *   GET /api/sse/merchant/events       — Private: merchant order events (PASETO auth)
 *   GET /api/sse/admin/events          — Private: admin queue/cycle events (PASETO auth)
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
import {
    isTokenRevoked, sessionSuperseded, refuseSupersededSession, merchantLoginRow,
    secondFactorMissing, refuseMissingSecondFactor,
} from '../domains/identity/auth.middleware.js';
import { decodeOrderCursor, encodeOrderCursor, normalizeLimit } from '../utils/cursorPagination.js';
import { fetchCycleHistory } from '../domains/markets/cycleHistory.service.js';
import { AUDIENCES } from '#db/repositories/markets.js';
// The one shape a merchant receives. The merchant stream is a merchant-facing
// responder like any route handler, and it was the only one not going through
// this.
import { toMerchantOrderViews } from '../domains/merchant/merchantOrderView.js';
import { staffMayReceive } from '../domains/notification/staffEventAreas.js';
// The player door, whole: the same admission every player route asks (§32 S32).
import { authenticatePlayer } from '../domains/identity/auth.middleware.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { systemConfigPayload, systemConfigFallback } from '../domains/configuration/systemConfigPayload.js';
import { brandingPayload, currentBranding } from '../domains/branding/brandingPayload.js';

// The admin queue projection used to be a hand-written field list here. It is
// the repository's `toOrder` now — one description of what an order looks like
// rather than two, so a column added to the order does not have to be
// remembered in a string in a route file to reach the screen that shows it.

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

/**
 * EventSource sends no headers, so the player stream's token arrives as
 * `?token=`; it is handed to `authenticatePlayer` as the bearer header that
 * door reads. A cookie or a real header, when present, wins.
 */
function playerTokenFromQuery(req, _res, next) {
    const { token } = req.query;
    if (typeof token === 'string' && token && !req.headers.authorization) {
        req.headers.authorization = `Bearer ${token}`;
    }
    next();
}

export function initSSERoutes(sseManager, cycleGenerator) {
    const router = express.Router();
    router.use('/player/events', playerTokenFromQuery);

    /**
     * What every public stream is sent the moment it opens: both audiences'
     * snapshots, the system config, the branding and recent history.
     *
     * The config and branding are READ here, through their one builder each
     * (systemConfigPayload, currentBranding). This used to send
     * `global.cachedSystemConfig` filtered through a second, eight-field list
     * of its own, and `global.cachedBranding`; both caches were filled only by
     * a socket connecting to the same process, so a stream opened before any
     * socket got neither, and one opened after got a config without the order
     * sizes, footer tabs or player-screen switches the screens read (§5).
     */
    async function sendOpening(clientId, req) {
        // 1. Cycle snapshot — one per audience, each tagged: the panel applies
        //    its player's own.
        try {
            for (const audience of AUDIENCES) {
                const snapshot = await cycleGenerator.getCycleSnapshotData(audience);
                sseManager.sendToClient(clientId, 'cycle_snapshot', {
                    audience, cycles: snapshot, timestamp: Date.now()
                });
            }
        } catch (e) {
            console.error('❌ SSE initial cycle_snapshot error:', e.message);
        }

        // 2. System config — the builder with no row on a database blip, the
        //    same answer the HTTP route and the admin broadcast give.
        let config;
        try { config = systemConfigPayload(await getSystemConfig()); } catch { config = systemConfigFallback(); }
        sseManager.sendToClient(clientId, 'system_config', config);

        // 3. Branding — the declared defaults on a database blip.
        let branding;
        try { branding = await currentBranding(); } catch { branding = brandingPayload(db.config.defaultsFor('branding')); }
        sseManager.sendToClient(clientId, 'branding', branding);

        // 4. Cycle history — every type, `limit` rows EACH, both audiences.
        //    Deeper windows are one board at a time over
        //    GET /api/v1/game/cycles/history.
        try {
            const limit = normalizeLimit(req.query.limit, 50, 100);
            for (const audience of AUDIENCES) {
                sseManager.sendToClient(clientId, 'cycle_history', {
                    ...(await fetchCycleHistory({ limit, audience })),
                    serverTime: Date.now(),
                });
            }
        } catch (e) {
            console.error('❌ SSE initial cycle_history error:', e.message);
        }
    }

    // ── GET /api/sse/events ── PUBLIC ─────────────────────────────────────────
    // A visitor who is not signed in.
    router.get('/events', async (req, res) => {
        initSSEResponse(res);
        await sendOpening(sseManager.addClient(res), req);
    });

    // ── GET /api/sse/player/events ── PUBLIC + ONE PLAYER ─────────────────────
    //
    // Query param: ?token=<player PASETO> (EventSource sends no headers).
    //
    // A signed-in player's one live connection: everything the public stream
    // carries, plus the pushes addressed to them (`sseManager.sendToUser`:
    // user_balance_update, user_update, payout_success, order_update). One
    // connection rather than two, so a player costs the server one stream.
    //
    // Admission is `authenticatePlayer` itself — revocation, challenge token,
    // session cutoff, closed or blocked account, wrong panel — not a copy of
    // it: the socket's `join_user_room` was a second door that once admitted
    // on the signature alone (R6). The query token is presented to it as the
    // bearer header; a cookie, when the browser sends one, is read first by
    // the middleware exactly as on every other player route.
    router.get('/player/events', authenticatePlayer, async (req, res) => {
        initSSEResponse(res);
        const clientId = sseManager.addClient(res);
        sseManager.addUserClient(String(req.userId), res);
        await sendOpening(clientId, req);
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
            // A password reset ends this stream too, not only the REST API.
            if (sessionSuperseded(await merchantLoginRow(merchant), decoded)) {
                return refuseSupersededSession(res);
            }
            if (await secondFactorMissing('MERCHANT', decoded)) return refuseMissingSecondFactor(res);
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

            // Through the merchant projection, like every other merchant-facing
            // responder. This sent `page.orders` RAW — the player's phone
            // number, their UPI id, their bank details, the platform's treasury
            // split and the risk verdicts on them — to every merchant, on every
            // connect. `check:merchant-privacy` read only `merchant.routes.js`,
            // so it never looked at this file.
            sseManager.writeEvent(res, 'merchant_orders_snapshot', {
                orders: toMerchantOrderViews(page.orders),
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
        // stream carries every order and every cycle
        // result — the last thing a revoked admin should keep receiving.
        const adminUser = await db.users.getUser(decoded.userId);
        if (!adminUser || adminUser.isBlocked
            || (!adminUser.isAdmin && !adminUser.isSubAdmin && !adminUser.isQueueManager)) {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }
        // A password reset ends this stream too, not only the REST API.
        if (sessionSuperseded(adminUser, decoded)) return refuseSupersededSession(res);
        // A staff account's own population (§33.5), and a session its Telegram
        // approved: the same two questions `authenticate` asks (§32 S32).
        if (adminUser.accountType !== 'STAFF') {
            return res.status(403).json({ success: false, code: 'WRONG_PANEL', message: 'Admin access required' });
        }
        if (await secondFactorMissing('STAFF', decoded)) return refuseMissingSecondFactor(res);

        initSSEResponse(res);
        sseManager.addAdminClient(res, adminUser);

        // The queue snapshot is every pending order with its player: it goes
        // only to staff who work the queue, the same rule as the
        // `queue_order_update` events that follow it (staffEventAreas.js).
        if (!staffMayReceive(adminUser, 'queue_snapshot')) return;
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

    // `GET /api/sse/stats` was removed 2026-10-01: nothing called it, and it
    // told any unauthenticated caller how many streams were open.

    return router;
}
