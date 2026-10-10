// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The socket.io connection handlers.
 *
 * ── What is NOT here any more (2026-10-10) ──────────────────────────────────
 * The player app opens no socket. Its live data — cycle snapshots, timers,
 * phases, results, pools, history, branding, system config — and its own
 * pushes (balance, payout, order) come down ONE SSE stream
 * (`routes/sse.routes.js`: `/api/sse/events`, or `/api/sse/player/events`
 * signed in), and what it used to ASK over the socket it asks over HTTP. So the
 * handlers only it called are deleted, not kept for nobody (§22): the
 * connect-time pushes, `request_cycle_snapshot`, `request_system_config`,
 * `request_branding`, `request_cycle_history`, `request_promo`, `watch_cycle`
 * / `unwatch_cycle` and `join_user_room`.
 */
import { db } from '#db';
// AQ-2: verify via the single PASETO authority (Ed25519 signature + iss/aud stamped).
import { verifyJwt } from '../domains/identity/jwt.util.js';
import { sessionIsLive } from '../domains/identity/auth.middleware.js';
import { roomsForViewer } from '../domains/notification/staffEventAreas.js';
import { PERMISSION_KEYS } from '../domains/identity/staffPermissions.js';

export function attachSocketHandlers(io) {

  io.on('connection', async (socket) => {
    console.log('👤 Client connected:', socket.id);

    const socketToken = () => {
      const cookieHeader = socket.handshake.headers?.cookie || '';
      const cookieToken  = cookieHeader.split(';').map(s => s.trim())
        .find(s => s.startsWith('auth_token='))?.split('=')[1];
      return cookieToken || socket.handshake.auth?.token;
    };

    const loadActiveUser = async (decoded) => {
      if (!decoded?.userId) return null;
      const user = await db.users.getUser(decoded.userId);
      if (!user || user.isBlocked || user.status === 'BLOCKED') return null;
      return user;
    };

    // `join_merchant_room` was here. No panel ever emitted it — the merchant
    // panel's live feed is the SSE stream `/api/sse/merchant/events` — so the
    // room had no member, and the handler's one other branch let a full
    // admin's session into ANY merchant's room. Deleted, not restricted:
    // code nothing calls is not code (CLAUDE.md §22). Merchant pushes go
    // through `emitMerchantUpdate`.

    socket.on('join_admin_room', async (data) => {
      try {
        const token = data?.token || socketToken();
        if (!token) return;
        const decoded = verifyJwt(token);
        const user = await loadActiveUser(decoded);
        if ((user?.isAdmin || user?.isSubAdmin || user?.isQueueManager) && await sessionIsLive(token, decoded, user)) {
          // One room per AREA the account holds, not one room for all staff:
          // an emit then reaches exactly who `staffMayReceive` allows, and the
          // personal room lets a permission change disconnect this socket.
          socket.join(roomsForViewer(user, PERMISSION_KEYS));
          socket.emit('joined_admin_room', { success: true });
        }
      } catch { console.warn('⚠️  join_admin_room rejected — invalid token'); }
    });

    socket.on('disconnect', () => {
      console.log('👋 Client disconnected:', socket.id);
    });
  });
}
