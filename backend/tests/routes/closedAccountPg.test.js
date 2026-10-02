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
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { newUserId, getUser } from '#db/repositories/users.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import { verifyJwt } from '../../domains/identity/jwt.util.js';
import { sessionIsLive } from '../../domains/identity/auth.middleware.js';
import { generateSecret, generateToken, encryptSecret } from '../../domains/identity/totp.service.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const PASSWORD = 'closed-account-phrase-9';

describePg('a deleted account is closed', () => {
  let admin; let usersApp; let authApp; let walletApp;

  beforeAll(async () => {
    await applySchema();
    admin = await actor({ isAdmin: true, roles: ['admin'] });
    usersApp = mountRouter((await import('../../routes/admin/users.admin.routes.js')).default);
    // Both player doors exactly as server.js mounts them: the password routes
    // on `/api/v1/auth` (playerAuth) and the session routes beside them.
    authApp = express();
    authApp.use(express.json()); authApp.use(cookieParser());
    authApp.use('/api/v1/auth', (await import('../../domains/identity/playerAuth.routes.js')).default);
    authApp.use('/api/v1/auth', (await import('../../routes.js')).default);
    // Any route behind `authenticate`, to stand for the rest of the API.
    const { authenticate } = await import('../../domains/identity/auth.middleware.js');
    walletApp = express();
    walletApp.get('/anything', authenticate, (req, res) => res.json({ success: true }));
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const player = async () => {
    const who = await actor({});
    await db.users.updateUser(who.userId, { passwordHash: await hashPassword(PASSWORD) });
    return who;
  };
  // A distinct address per login, so the pace and subnet limiters are not
  // what is measured (they have their own suite).
  let n = 0;
  const login = (mobile) => {
    n += 1;
    return request(authApp).post('/api/v1/auth/login')
      .set('X-Forwarded-For', `10.77.${n}.9`).send({ mobile, password: PASSWORD });
  };
  const remove = (who, as_ = admin) => as(usersApp, as_).delete(`/users/${who.userId}`);

  it('refuses a deleted player at the login door, and says the account is closed', async () => {
    const gone = await player();
    const bystander = await player();
    // No precondition login on `gone`: the pace limiter keys on the MOBILE,
    // so a second attempt on it inside ten seconds measures the pace (429),
    // not the door. The bystander, made the same way, is the precondition.

    expect((await remove(gone)).status).toBe(200);
    const res = await login(gone.mobile);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_CLOSED');
    expect(res.body.token).toBeUndefined();

    // The opposite case: closing one account closes nobody else's.
    expect((await login(bystander.mobile)).status).toBe(200);
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

  it('refuses the SECOND leg of a login when the account was closed between the legs', async () => {
    const gone = await player();
    const secret = generateSecret();
    await pgQuery(`UPDATE users SET two_factor_enabled = TRUE, two_factor_secret = $2 WHERE user_id = $1`,
      [gone.userId, encryptSecret(secret)]);
    const first = await login(gone.mobile);
    expect(first.body.challengeToken, JSON.stringify(first.body)).toBeTruthy();

    expect((await remove(gone)).status).toBe(200);
    const second = await request(authApp).post('/api/v1/auth/login/2fa')
      .set('X-Forwarded-For', '10.78.1.9')
      .send({ challengeToken: first.body.challengeToken, code: generateToken(secret) });
    expect(second.status).toBe(403);
    expect(second.body.code).toBe('ACCOUNT_CLOSED');
    expect(second.body.token).toBeUndefined();
  });

  it('deletes PLAYER accounts only: a sub-admin cannot close the admin, a colleague or a merchant login', async () => {
    const sub = await actor({ isSubAdmin: true, permissions: { canManageUsers: true } });
    const colleague = await actor({ isSubAdmin: true, permissions: {} });
    const merchant = await createMerchantAccount({
      userId: newUserId(), username: `closed${Date.now()}`, mobile: `7${String(Date.now()).slice(-9)}`,
      passwordHash: await hashPassword(PASSWORD), currency: 'INR',
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
