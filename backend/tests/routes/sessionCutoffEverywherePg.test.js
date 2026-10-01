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
 * admin order feed.
 *
 * The cutoff is set the way a reset sets it (`sessions_valid_from = now()`),
 * AFTER the token is signed; `iat` is whole seconds, so the test waits one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
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
  attachSocketHandlers(
    { on: (_e, fn) => { connect = fn; } },
    { sendCycleSnapshot: () => {}, getCycleSnapshotData: async () => [] },
    { getGameState: async () => ({}) },
  );
  await connect(socket);
  return { handlers, joined };
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

  it('a player joins their own room while live, and not once the session is superseded', async () => {
    const p = await actor({});
    const live = await connectSocket(p.token);
    await live.handlers.join_user_room(p.userId);
    expect(live.joined).toEqual([`user-${p.userId}`]);

    await new Promise((r) => setTimeout(r, 1100));
    await supersede(p.userId);
    const stale = await connectSocket(p.token);
    await stale.handlers.join_user_room(p.userId);
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

  it('a signed-out (revoked) token cannot join a room', async () => {
    const p = await actor({});
    const token = signToken({ userId: p.userId });
    const { revokeToken } = await import('#db/repositories/identity.js');
    await revokeToken(token);
    const s = await connectSocket(token);
    await s.handlers.join_user_room(p.userId);
    expect(s.joined).toEqual([]);
  });
});
