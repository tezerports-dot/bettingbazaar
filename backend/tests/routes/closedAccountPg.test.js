// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A deleted account is CLOSED: it cannot sign in, and no session it already
 * holds still works. Through the real routers and a real database.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `DELETE /api/admin/users/:userId` soft-deletes: status DELETED, who and
 * when. Until 2026-10-01 nothing anywhere ASKED about that status. The login
 * refused BLOCKED only, `authenticate` and `/me` checked `isBlocked` only, so
 * a deleted player signed in and transacted exactly as before — "Delete"
 * removed them from nothing but the admin's list. No button called the route
 * (route coverage: "client methods no screen calls"), which is the only reason
 * it was harmless; wiring that button without this would have been a control
 * that says it did something it did not.
 *
 * The route is the PLAYERS area (`canManageUsers`). Unscoped, a sub-admin
 * holding it could close the full admin's own account, or a merchant's login
 * — so the scope is asserted here too, from the sub-admin's side.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { newUserId, getUser } from '#db/repositories/users.js';
import { verifyJwt } from '../../domains/identity/jwt.util.js';
import { sessionIsLive } from '../../domains/identity/auth.middleware.js';
import { linkTelegram, saveTestBot, removeTestBot, signInitData } from '../miniAppFixture.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const SITE = 'https://bb.example';

describePg('a deleted account is closed', () => {
  let admin; let usersApp; let authApp; let walletApp;
  const originBefore = process.env.PUBLIC_APP_ORIGIN;

  beforeAll(async () => {
    process.env.PUBLIC_APP_ORIGIN = SITE;
    await applySchema();
    admin = await actor({ isAdmin: true, roles: ['admin'] });
    usersApp = mountRouter((await import('../../routes/admin/users.admin.routes.js')).default);
    // The player door exactly as server.js mounts it: the Continue with
    // Telegram legs on `/api/v1/auth` (playerAuth) and the session routes
    // beside them, and the Mini App that answers the sign-in.
    authApp = express();
    authApp.set('trust proxy', true);
    authApp.use(express.json()); authApp.use(cookieParser());
    authApp.use('/api/v1/auth', (await import('../../domains/identity/playerAuth.routes.js')).default);
    authApp.use('/api/v1/auth', (await import('../../routes.js')).default);
    authApp.use('/api/telegram', (await import('../../domains/telegram/miniApp.routes.js')).default);
    await saveTestBot();
    // Any route behind `authenticate`, to stand for the rest of the API.
    const { authenticate } = await import('../../domains/identity/auth.middleware.js');
    walletApp = express();
    walletApp.get('/anything', authenticate, (req, res) => res.json({ success: true }));
  }, 60_000);

  afterAll(async () => {
    if (originBefore === undefined) delete process.env.PUBLIC_APP_ORIGIN; else process.env.PUBLIC_APP_ORIGIN = originBefore;
    await removeTestBot();
    await closePg();
  });

  /** A player with their Telegram linked (what their first Verify leaves). */
  const player = async () => {
    const who = await actor({});
    who.tgId = await linkTelegram(who.userId);
    return who;
  };
  // A distinct address per request, so the Telegram limiters (keyed on the
  // address) are not what is measured (they have their own suite).
  let n = 0;
  const post = (path, body) => {
    n += 1;
    return request(authApp).post(path).set('X-Forwarded-For', `10.77.${n >> 8}.${n & 255}`).send(body);
  };
  const startParam = (opened) => new URL(opened.telegram.url).searchParams.get('startapp');
  /** "Continue with Telegram" at the player door: the browser's first leg. */
  const open = (delivery = 'MATCH') => post('/api/v1/auth/login/telegram', { delivery }).then((r) => r.body);
  const complete = (opened) => post('/api/v1/auth/login/telegram/complete', { challengeToken: opened.challengeToken });
  /** The account's own Telegram presses Verify in the Mini App. */
  const verify = (opened, who) => post('/api/telegram/mini-app/approve', {
    initData: signInitData({ telegramUserId: who.tgId, startParam: startParam(opened) }),
    decision: 'approve', pick: opened.matchNumber ?? undefined,
  });
  const ticketOf = (url) => new URL(url).hash.replace(/^#\/tg\//, '');
  const remove = (who, as_ = admin) => as(usersApp, as_).delete(`/users/${who.userId}`);

  it('refuses a deleted player at Continue with Telegram, and says the account is closed', async () => {
    const gone = await player();
    const bystander = await player();

    expect((await remove(gone)).status).toBe(200);
    const opened = await open();
    const res = await verify(opened, gone);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_CLOSED');
    // Nothing was approved: the browser is still waiting, and gets no session.
    const polled = await complete(opened);
    expect(polled.status).toBe(202);
    expect(polled.body.token).toBeUndefined();

    // The opposite case: closing one account closes nobody else's.
    const other = await open();
    expect((await verify(other, bystander)).body.approved).toBe(true);
    const session = await complete(other);
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    expect(verifyJwt(session.body.token).userId).toBe(bystander.userId);
  });

  it('ends every session the account already held — REST, /me, and the realtime check', async () => {
    const gone = await player();
    const bystander = await player();
    // Precondition, established by THIS test (§32 S19): the token works.
    expect((await request(walletApp).get('/anything').set('Authorization', gone.auth)).status).toBe(200);

    expect((await remove(gone)).status).toBe(200);

    const api = await request(walletApp).get('/anything').set('Authorization', gone.auth);
    expect(api.status).toBe(403);
    expect(api.body.code).toBe('ACCOUNT_CLOSED');
    const me = await request(authApp).get('/api/v1/auth/me').set('Authorization', gone.auth);
    expect(me.status).toBe(403);
    expect(me.body.code).toBe('ACCOUNT_CLOSED');

    // Sockets and SSE streams ask `sessionIsLive`, which reads the cutoff the
    // delete moved — the same mechanism a password reset uses.
    const token = gone.auth.replace(/^Bearer /, '');
    const row = await getUser(gone.userId);
    expect(row.sessionsValidFrom).toBeTruthy();
    expect(await sessionIsLive(token, verifyJwt(token), row)).toBe(false);

    // And the bystander's session is untouched.
    expect((await request(walletApp).get('/anything').set('Authorization', bystander.auth)).status).toBe(200);
  });

  it('refuses the SECOND leg of a sign-in when the account was closed between the legs', async () => {
    // Approved in Telegram while the account was still open…
    const gone = await player();
    const opened = await open('MATCH');
    expect((await verify(opened, gone)).body.approved).toBe(true);
    // …and closed before the browser redeemed it.
    expect((await remove(gone)).status).toBe(200);
    const second = await complete(opened);
    expect(second.status).toBe(403);
    expect(second.body.code).toBe('ACCOUNT_CLOSED');
    expect(second.body.token).toBeUndefined();
  });

  it('refuses the handoff ticket when the account was closed after Verify', async () => {
    const gone = await player();
    const opened = await open('HANDOFF');
    const ok = await verify(opened, gone);
    expect(ok.body.redirectUrl, JSON.stringify(ok.body)).toBeTruthy();
    expect((await remove(gone)).status).toBe(200);
    const res = await post('/api/v1/auth/login/telegram/ticket', { ticket: ticketOf(ok.body.redirectUrl) });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_CLOSED');
    expect(res.body.token).toBeUndefined();
  });

  it('deletes PLAYER accounts only: a sub-admin cannot close the admin, a colleague or a merchant login', async () => {
    const sub = await actor({ isSubAdmin: true, permissions: { canManageUsers: true } });
    const colleague = await actor({ isSubAdmin: true, permissions: {} });
    const merchant = await createMerchantAccount({
      userId: newUserId(), username: `closed${Date.now()}`, mobile: `7${String(Date.now()).slice(-9)}`,
      currency: 'INR',
    });
    expect(merchant.ok, JSON.stringify(merchant)).toBe(true);
    const merchantLogin = { userId: merchant.userId };

    for (const target of [admin, colleague, merchantLogin]) {
      const res = await remove(target, sub);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      const row = await getUser(target.userId);
      expect(row.status, `${row.accountType} row`).not.toBe('DELETED');
      expect(row.sessionsValidFrom).toBeNull();
    }

    // The legitimate case on the same route, by the same sub-admin.
    const p = await player();
    expect((await remove(p, sub)).status).toBe(200);
    expect((await getUser(p.userId)).status).toBe('DELETED');
  });
});
