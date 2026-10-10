// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A password reset ends a session EVERYWHERE the session could still be used,
 * not only on the REST API (§32 S32, R6 2026-09-30).
 *
 * `sessions_valid_from` was checked by `authenticate` and `/me`. The socket
 * room joins and both private SSE streams verified tokens inline and checked
 * neither the cutoff nor, for the sockets, the revocation list — so a player
 * who reset their password because somebody else held a session left that
 * session receiving their balance pushes, and a reset staff session kept the
 * admin order feed. A player's pushes now travel on their SSE stream
 * (`/api/sse/player/events`, 2026-10-10), admitted by `authenticatePlayer`.
 *
 * The cutoff is set the way a reset sets it (`sessions_valid_from = now()`),
 * AFTER the token is signed; `iat` is whole seconds, so the test waits one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { signToken } from '../../domains/identity/paseto.util.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

/** A socket with the real handlers attached, and a record of what it joined. */
async function connectSocket(token) {
  const { attachSocketHandlers } = await import('../../startup/socketHandlers.js');
  const handlers = {};
  const joined = [];
  const socket = {
    id: 'rt-socket', handshake: { headers: {}, auth: { token } },
    on: (event, fn) => { handlers[event] = fn; },
    emit: () => {}, join: (room) => joined.push(...[room].flat()), leave: () => {},
  };
  let connect;
  attachSocketHandlers({ on: (_e, fn) => { connect = fn; } });
  await connect(socket);
  return { handlers, joined };
}

/** The player's live stream, real route and admission; records the channel it opened. */
async function openPlayerStream(token) {
  const { initSSERoutes } = await import('../../routes/sse.routes.js');
  const joined = [];
  const sse = {
    addClient: () => 1,
    addUserClient: (uid, res) => { joined.push(uid); res.end(); },
    sendToClient: () => {},
  };
  const app = express();
  app.use(cookieParser());
  app.use('/sse', initSSERoutes(sse, { getCycleSnapshotData: async () => ({}) }));
  const res = await request(app).get(`/sse/player/events?token=${encodeURIComponent(token)}`);
  return { status: res.status, body: res.body, joined };
}

describePg('a superseded session is refused everywhere', () => {
  let sseApp;
  const supersede = (userId) => pgQuery(
    `UPDATE users SET sessions_valid_from = now() WHERE user_id = $1`, [userId]);

  beforeAll(async () => {
    await applySchema();
    const { initSSERoutes } = await import('../../routes/sse.routes.js');
    sseApp = express();
    sseApp.use('/sse', initSSERoutes({ addAdminClient: () => {}, addMerchantClient: () => {} }, {}));
  }, 60_000);

  afterAll(async () => { await closePg(); });

  it("a player's stream opens their channel while live, and not once the session is superseded", async () => {
    const p = await actor({});
    const live = await openPlayerStream(p.token);
    expect(live.status).toBe(200);
    expect(live.joined).toEqual([String(p.userId)]);

    await new Promise((r) => setTimeout(r, 1100));
    await supersede(p.userId);
    const stale = await openPlayerStream(p.token);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('SESSION_SUPERSEDED');
    expect(stale.joined).toEqual([]);
  });

  it('an admin joins the admin room while live, and not once superseded', async () => {
    const admin = await actor({ isAdmin: true });
    const live = await connectSocket(admin.token);
    await live.handlers.join_admin_room({});
    // One room per area since 2026-10-01; a full admin's is the admin room,
    // plus the personal room a permission change disconnects.
    expect(live.joined).toEqual([`staff:${admin.userId}`, 'staff-area:admin']);

    await new Promise((r) => setTimeout(r, 1100));
    await supersede(admin.userId);
    const stale = await connectSocket(admin.token);
    await stale.handlers.join_admin_room({});
    expect(stale.joined).toEqual([]);
  });

  it('the admin SSE stream refuses a superseded session', async () => {
    const admin = await actor({ isAdmin: true });
    await new Promise((r) => setTimeout(r, 1100));
    await supersede(admin.userId);
    const res = await request(sseApp).get(`/sse/admin/events?token=${encodeURIComponent(admin.token)}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_SUPERSEDED');
  });

  it("a signed-out (revoked) token opens no player's channel", async () => {
    const p = await actor({});
    const token = signToken({ userId: p.userId });
    const { revokeToken } = await import('#db/repositories/identity.js');
    await revokeToken(token);
    const s = await openPlayerStream(token);
    expect(s.status).toBe(401);
    expect(s.joined).toEqual([]);
  });
});
