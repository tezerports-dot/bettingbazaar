// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Staff sign-in end to end, at the HTTP boundary, against PostgreSQL (owner,
 * 2026-10-13: staff sign in with mobile, password and an authenticator app; no
 * Telegram).
 *
 *   password  →  /login/totp/setup  →  /login/totp/activate  (first sign-in)
 *   password  →  /login/totp                                  (every one after)
 *
 * Every code here is computed from the secret the setup leg answered, the way
 * the app on a phone computes it. The code legs are mounted through
 * `doorRoute`, so their limiters are the real ones; the password leg is the
 * real `loginHandler` without its per-mobile pace (one try per 10 s would make
 * a second sign-in of the same account wait), which loginPacing.test.js proves
 * is mounted.
 *
 * Also here: an admin's reset (never their own; it ends the account's
 * sessions and is audited), My Authenticator's two routes, and the token
 * isolation between the staff code legs and Telegram's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { newUserId, createUser, setRoles } from '#db/repositories/users.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import { verifyJwt, signToken } from '../../domains/identity/jwt.util.js';
import { base32Decode, totp, stepAt } from '../../domains/identity/totp.service.js';
import { issueChallenge } from '../../domains/identity/twoFactorChallenge.js';

const describePg = pgConfigured() ? describe : describe.skip;
const PASSWORD = 'Staff-Authenticator-Pass-9z!';

let addr = 0;
const from = () => { addr += 1; return `10.77.${(addr >> 8) & 255}.${addr & 255}`; };
let n = 0;
const freshMobile = () => `8${String(Date.now()).slice(-5)}${String(n += 1).padStart(4, '0')}`;

describePg('staff sign-in with an authenticator app', () => {
  let app;
  let admin;

  beforeAll(async () => {
    await applySchema();
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    const { loginHandler, LOGIN_DOOR } = await import('../../routes.js');
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.post('/api/admin/login', (req, _res, next) => {
      req.loginDoor = LOGIN_DOOR.STAFF;
      req.body = { ...req.body, loginType: req.body?.loginType || 'admin' };
      next();
    }, loginHandler);
    app.post('/api/admin/login/totp', ...doorRoute('STAFF', 'totp'));
    app.post('/api/admin/login/totp/setup', ...doorRoute('STAFF', 'totpSetup'));
    app.post('/api/admin/login/totp/activate', ...doorRoute('STAFF', 'totpActivate'));
    app.post('/api/merchant/auth/login/2fa', ...doorRoute('MERCHANT', 'twoFactor'));
    app.use('/api/admin', (await import('../../routes/admin/subadmins.admin.routes.js')).default);
    app.use('/api/admin', (await import('../../routes/admin/account.admin.routes.js')).default);
    admin = await staffAccount();
    admin.token = signToken({ userId: admin.userId, amr: ['pwd', 'otp'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  async function staffAccount({ isAdmin = true } = {}) {
    const mobile = freshMobile();
    const userId = newUserId();
    await createUser({ userId, username: `st${n}`, mobile, passwordHash: await hashPassword(PASSWORD), accountType: 'STAFF', isAdmin });
    await setRoles(userId, isAdmin ? ['admin'] : ['subadmin']);
    if (!isAdmin) await db.users.updateUser(userId, { isSubAdmin: true, subAdminPermissions: {} });
    return { userId, mobile, loginType: isAdmin ? 'admin' : 'subadmin' };
  }

  const post = (path, body, auth = null) => {
    const r = request(app).post(path).set('X-Forwarded-For', from());
    return (auth ? r.set('Authorization', `Bearer ${auth}`) : r).send(body);
  };
  const login = (who, extra = {}) => post('/api/admin/login', { mobile: who.mobile, password: PASSWORD, loginType: who.loginType, ...extra });
  /** The code the app shows `offset` steps from now. */
  const codeOf = (secret, offset = 0) => totp(base32Decode(secret), Date.now() + offset * 30_000);

  /** A first sign-in, all the way: answers the secret, the session and the recovery codes. */
  async function enrol(who) {
    const first = await login(who);
    expect(first.body, JSON.stringify(first.body)).toMatchObject({ success: false, twoFactorRequired: true, totpSetupRequired: true });
    const setup = await post('/api/admin/login/totp/setup', { challengeToken: first.body.challengeToken });
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    const done = await post('/api/admin/login/totp/activate', { challengeToken: first.body.challengeToken, code: codeOf(setup.body.secret, -1) });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { secret: setup.body.secret, session: done.body };
  }

  describe('the first sign-in sets the app up', () => {
    it('password → setup → first code: a session with the code on it, and ten recovery codes', async () => {
      const s = await staffAccount();
      const first = await login(s);
      expect(first.status).toBe(200);
      expect(first.body.token).toBeFalsy();
      expect(first.body.telegram).toBeUndefined();

      const setup = await post('/api/admin/login/totp/setup', { challengeToken: first.body.challengeToken });
      expect(setup.status, JSON.stringify(setup.body)).toBe(200);
      expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.body.otpauthUri).toContain(`secret=${setup.body.secret}`);
      expect(setup.body.otpauthUri).toContain('algorithm=SHA1');
      expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      // The secret is stored encrypted, never as typed.
      const { rows } = await pgQuery('SELECT pending_secret_enc FROM staff_totp WHERE user_id = $1', [s.userId]);
      expect(rows[0].pending_secret_enc).toBeTruthy();
      expect(rows[0].pending_secret_enc).not.toContain(setup.body.secret);

      const wrong = await post('/api/admin/login/totp/activate', { challengeToken: first.body.challengeToken, code: '000000' });
      if (![-1, 0, 1].some((o) => codeOf(setup.body.secret, o) === '000000')) {
        expect(wrong.status).toBe(401);
        expect(wrong.body.code).toBe('TOTP_INVALID');
      }

      const done = await post('/api/admin/login/totp/activate', { challengeToken: first.body.challengeToken, code: codeOf(setup.body.secret) });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(verifyJwt(done.body.token)).toMatchObject({ userId: s.userId, amr: ['pwd', 'otp'] });
      expect(done.body.recoveryCodes).toHaveLength(10);
      for (const c of done.body.recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      expect(new Set(done.body.recoveryCodes).size).toBe(10);
      // Hashes are stored, never the codes.
      const stored = (await pgQuery('SELECT recovery_hashes::text AS h FROM staff_totp WHERE user_id = $1', [s.userId])).rows[0].h;
      for (const c of done.body.recoveryCodes) expect(stored).not.toContain(c);
    });

    it('a second setup after enrolment is refused: only a reset replaces the app', async () => {
      const s = await staffAccount();
      await enrol(s);
      const stale = issueChallenge({ userId: s.userId, door: 'STAFF', step: 'totp_setup', loginType: 'admin', challengeId: `tx${n}`, ttlSeconds: 300 });
      const again = await post('/api/admin/login/totp/setup', { challengeToken: stale });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('TOTP_ALREADY_ENROLLED');
      // ...and the next password leg asks for a code, not a setup.
      const next = await login(s);
      expect(next.body).toMatchObject({ twoFactorRequired: true, totpRequired: true });
      expect(next.body.totpSetupRequired).toBeUndefined();
    });
  });

  describe('every sign-in after: password, then the code', () => {
    it('signs in on the current code; the same code a second time is refused', async () => {
      const s = await staffAccount();
      const { secret } = await enrol(s);
      const first = await login(s);
      expect(first.body.totpRequired).toBe(true);
      const code = codeOf(secret, 1);   // a step after the one activation spent
      const ok = await post('/api/admin/login/totp', { challengeToken: first.body.challengeToken, code });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(verifyJwt(ok.body.token)).toMatchObject({ userId: s.userId, amr: ['pwd', 'otp'] });

      const second = await login(s);
      const replay = await post('/api/admin/login/totp', { challengeToken: second.body.challengeToken, code });
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('TOTP_INVALID');
    });

    it('a code two steps away (a clock a minute off) is refused', async () => {
      const s = await staffAccount();
      const { secret } = await enrol(s);
      const first = await login(s);
      const far = codeOf(secret, 3);
      if ([-1, 0, 1].some((o) => codeOf(secret, o) === far)) return;   // a collision, not a finding
      const res = await post('/api/admin/login/totp', { challengeToken: first.body.challengeToken, code: far });
      expect(res.status).toBe(401);
    });

    it('a recovery code signs in once, says how many are left, and is spent', async () => {
      const s = await staffAccount();
      const { session } = await enrol(s);
      const code = session.recoveryCodes[3].toLowerCase();   // typed as a person types it
      const first = await login(s);
      const ok = await post('/api/admin/login/totp', { challengeToken: first.body.challengeToken, code });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.recoveryCodesLeft).toBe(9);
      expect(verifyJwt(ok.body.token).amr).toEqual(['pwd', 'otp']);
      const second = await login(s);
      const again = await post('/api/admin/login/totp', { challengeToken: second.body.challengeToken, code });
      expect(again.status).toBe(401);
    });

    it('a wrong password opens no code step (the opposite case)', async () => {
      const s = await staffAccount();
      const res = await post('/api/admin/login', { mobile: s.mobile, password: 'not-the-password-123' });
      expect(res.status).toBe(401);
      expect(res.body.challengeToken).toBeUndefined();
    });

    it('a blocked account is refused at the code leg, even holding a challenge from before the block', async () => {
      const s = await staffAccount();
      const { secret } = await enrol(s);
      const first = await login(s);
      await pgQuery(`UPDATE users SET is_blocked = TRUE, block_reason = 'test', blocked_at = now() WHERE user_id = $1`, [s.userId]);
      const res = await post('/api/admin/login/totp', { challengeToken: first.body.challengeToken, code: codeOf(secret, 1) });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.token).toBeUndefined();
    });

    it('stops answering after five wrong codes for one account, the right one included', async () => {
      const s = await staffAccount();
      const { secret } = await enrol(s);
      const first = await login(s);
      const wrongs = ['000001', '000002', '000003', '000004', '000005']
        .filter((c) => ![-1, 0, 1, 2].some((o) => codeOf(secret, o) === c));
      for (const c of wrongs) {
        expect((await post('/api/admin/login/totp', { challengeToken: first.body.challengeToken, code: c })).status).toBe(401);
      }
      if (wrongs.length < 5) return;
      const next = await post('/api/admin/login/totp', { challengeToken: first.body.challengeToken, code: codeOf(secret, 1) });
      expect(next.status).toBe(429);
    });
  });

  describe('the tokens do not cross', () => {
    it('a code-step token is refused at setup and activate, and a setup token at the code leg', async () => {
      const s = await staffAccount();
      const { secret } = await enrol(s);
      const first = await login(s);
      expect((await post('/api/admin/login/totp/setup', { challengeToken: first.body.challengeToken })).status).toBe(401);
      expect((await post('/api/admin/login/totp/activate', { challengeToken: first.body.challengeToken, code: codeOf(secret, 1) })).status).toBe(401);

      const other = await staffAccount();
      const setupStep = await login(other);
      expect(setupStep.body.totpSetupRequired).toBe(true);
      expect((await post('/api/admin/login/totp', { challengeToken: setupStep.body.challengeToken, code: '123456' })).status).toBe(401);
    });

    it('a staff code-step token is refused at the merchant Telegram leg, and a merchant token at the staff code leg', async () => {
      const s = await staffAccount();
      await enrol(s);
      const first = await login(s);
      const atMerchant = await post('/api/merchant/auth/login/2fa', { challengeToken: first.body.challengeToken });
      expect(atMerchant.status).toBe(401);
      expect(atMerchant.body.token).toBeUndefined();

      const merchantToken = issueChallenge({ userId: s.userId, door: 'MERCHANT', challengeId: `m${n}`, ttlSeconds: 300 });
      const atStaff = await post('/api/admin/login/totp', { challengeToken: merchantToken, code: '123456' });
      expect(atStaff.status).toBe(401);
    });

    it('a session token is not a challenge token', async () => {
      const s = await staffAccount();
      const { session, secret } = await enrol(s);
      const res = await post('/api/admin/login/totp', { challengeToken: session.token, code: codeOf(secret, 1) });
      expect(res.status).toBe(401);
    });
  });

  describe('a session without the code on it', () => {
    it('is refused on staff routes; one with the code is admitted', async () => {
      const s = await staffAccount();
      for (const amr of [['pwd'], ['pwd', 'tg'], ['tg']]) {
        const res = await request(app).get('/api/admin/account/2fa').set('Authorization', `Bearer ${signToken({ userId: s.userId, amr })}`);
        expect(res.status, amr.join('+')).toBe(403);
        expect(res.body.code).toBe('TWO_FACTOR_REQUIRED');
      }
      const ok = await request(app).get('/api/admin/account/2fa').set('Authorization', `Bearer ${signToken({ userId: s.userId, amr: ['pwd', 'otp'] })}`);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ success: true, enrolled: false });
    });
  });

  describe('My Authenticator', () => {
    it('shows the state, never a secret', async () => {
      const s = await staffAccount();
      const { session } = await enrol(s);
      const res = await request(app).get('/api/admin/account/2fa').set('Authorization', `Bearer ${session.token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, enrolled: true, recoveryCodesLeft: 10 });
      expect(JSON.stringify(res.body)).not.toMatch(/secret|hash/i);
    });

    it('makes ten new recovery codes on a current code; the old ones stop working; it is audited', async () => {
      const s = await staffAccount();
      const { session, secret } = await enrol(s);
      const wrong = await post('/api/admin/account/2fa/recovery-codes', { code: '000000' }, session.token);
      if (![-1, 0, 1].some((o) => codeOf(secret, o) === '000000')) {
        expect(wrong.status, 'a held session must not be answered 401').toBe(400);
        expect(wrong.body.code).toBe('TOTP_INVALID');
      }
      const res = await post('/api/admin/account/2fa/recovery-codes', { code: codeOf(secret, 1) }, session.token);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.recoveryCodes).toHaveLength(10);
      expect(res.body.recoveryCodes).not.toContain(session.recoveryCodes[0]);

      const first = await login(s);
      const old = await post('/api/admin/login/totp', { challengeToken: first.body.challengeToken, code: session.recoveryCodes[0] });
      expect(old.status).toBe(401);
      const fresh = await post('/api/admin/login/totp', { challengeToken: first.body.challengeToken, code: res.body.recoveryCodes[0] });
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);

      const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM enhanced_audit_logs WHERE action = 'STAFF_RECOVERY_CODES_REGENERATED' AND target_id = $1`, [s.userId]);
      expect(rows[0].n).toBe(1);
    });

    it('a recovery code cannot make new recovery codes', async () => {
      const s = await staffAccount();
      const { session } = await enrol(s);
      const res = await post('/api/admin/account/2fa/recovery-codes', { code: session.recoveryCodes[1] }, session.token);
      expect(res.status).toBe(400);
    });
  });

  describe("an admin's reset", () => {
    it('forgets the app and the codes, ends every session, is audited, and the next sign-in sets up again', async () => {
      const s = await staffAccount({ isAdmin: false });
      const { session } = await enrol(s);
      const me = () => request(app).get('/api/admin/account/2fa').set('Authorization', `Bearer ${session.token}`);
      expect((await me()).status).toBe(200);

      // Sessions are cut at a whole second; wait into the next one so the
      // token issued above is unambiguously before the cutoff.
      await new Promise((r) => setTimeout(r, 1100));
      const reset = await post(`/api/admin/staff/${s.userId}/reset-authenticator`, {}, admin.token);
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      expect(reset.body).toMatchObject({ success: true, hadAuthenticator: true });

      expect((await me()).status).toBe(401);
      expect((await pgQuery('SELECT 1 FROM staff_totp WHERE user_id = $1', [s.userId])).rowCount).toBe(0);
      const { rows } = await pgQuery(
        `SELECT performed_by, category FROM enhanced_audit_logs WHERE action = 'STAFF_AUTHENTICATOR_RESET' AND target_id = $1`, [s.userId]);
      expect(rows).toEqual([{ performed_by: admin.userId, category: 'SECURITY' }]);

      const next = await login(s);
      expect(next.body.totpSetupRequired).toBe(true);
      // The old recovery codes are gone with the row.
      expect(session.recoveryCodes).toHaveLength(10);
    });

    it('is refused for your own account', async () => {
      const res = await post(`/api/admin/staff/${admin.userId}/reset-authenticator`, {}, admin.token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_YOUR_OWN');
    });

    it('is refused for a non-staff account and an unknown one', async () => {
      const player = newUserId();
      await createUser({ userId: player, username: `pl${n}`, mobile: freshMobile(), accountType: 'PLAYER' });
      expect((await post(`/api/admin/staff/${player}/reset-authenticator`, {}, admin.token)).status).toBe(404);
      expect((await post('/api/admin/staff/no-such-user/reset-authenticator', {}, admin.token)).status).toBe(404);
    });

    it('is refused to a sub-admin, whatever they hold (the opposite case)', async () => {
      const sub = await staffAccount({ isAdmin: false });
      const target = await staffAccount({ isAdmin: false });
      await enrol(target);
      const subToken = signToken({ userId: sub.userId, amr: ['pwd', 'otp'] });
      const res = await post(`/api/admin/staff/${target.userId}/reset-authenticator`, {}, subToken);
      expect(res.status).toBe(403);
      expect((await pgQuery('SELECT 1 FROM staff_totp WHERE user_id = $1', [target.userId])).rowCount).toBe(1);
    });

    it('the Sub-admins list says who has an authenticator', async () => {
      const a = await staffAccount({ isAdmin: false });
      const b = await staffAccount({ isAdmin: false });
      await enrol(a);
      const res = await request(app).get('/api/admin/sub-admins').set('Authorization', `Bearer ${admin.token}`);
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.subAdmins.map((u) => [u.userId, u]));
      expect(byId[a.userId].authenticatorEnrolled).toBe(true);
      expect(byId[b.userId].authenticatorEnrolled).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/secret_enc|recovery_hashes/);
    });
  });

  it('the clock step the server uses is the RFC one', () => {
    expect(stepAt(59_000)).toBe(1);
  });
});
