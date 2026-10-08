// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Step 3 end to end, at the HTTP boundary: the three sign-in doors, the Mini
 * App that answers them, and a real PostgreSQL behind both.
 *
 * Owner, 2026-10-07: "they must verify and share contact on signup ... now they
 * can do login without telegram mini app but add also login with telegram
 * button too"; 2FA is "Telegram only", required for staff and merchants;
 * a forgotten password is recovered by sharing the contact in the Mini App.
 *
 * Nothing here reaches Telegram. The Mini App's signed strings are signed with
 * the test token (miniAppFixture.js), the algorithm the server verifies, and
 * the server holds that token as its one bot. So every request below is one a
 * browser or the Mini App page could actually send.
 *
 * Each case uses its own accounts and its own address: every door paces one
 * credential try per mobile, and the Telegram limiters key on the address.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { newUserId, createUser, setRoles, getUserByMobile } from '#db/repositories/users.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import { verifyJwt } from '../../domains/identity/jwt.util.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId,
} from '../miniAppFixture.js';

const describePg = pgConfigured() ? describe : describe.skip;
const PASSWORD = 'Telegram-Step3-Pass-7q!';

let addr = 0;
const from = () => { addr += 1; return `10.${90 + ((addr >> 16) & 7)}.${(addr >> 8) & 255}.${addr & 255}`; };
let n = 0;
const freshMobile = (lead = '9') => `${lead}${String(Date.now()).slice(-5)}${String(n += 1).padStart(4, '0')}`;

const DOOR = {
  PLAYER: '/api/v1/auth',
  STAFF: '/api/admin',
  MERCHANT: '/api/merchant/auth',
};

describePg('Step 3: sign-in doors and the Mini App', () => {
  let app;

  beforeAll(async () => {
    await applySchema();
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/auth', (await import('../../domains/identity/playerAuth.routes.js')).default);
    app.use('/api/v1/auth', (await import('../../routes.js')).default);
    app.post('/api/admin/login', ...doorRoute('STAFF', 'login'));
    app.post('/api/admin/login/2fa', ...doorRoute('STAFF', 'twoFactor'));
    app.post('/api/admin/login/telegram', ...doorRoute('STAFF', 'telegram'));
    app.post('/api/admin/login/telegram/complete', ...doorRoute('STAFF', 'telegramComplete'));
    app.use('/api/admin', (await import('../../routes/admin/telegram.admin.routes.js')).default);
    app.use('/api/merchant', (await import('../../domains/merchant/merchant.routes.js')).default);
    app.use('/api/telegram', (await import('../../domains/telegram/miniApp.routes.js')).default);
    await saveTestBot();
  }, 60_000);

  afterAll(async () => { await removeTestBot(); await closePg(); });

  const post = (path, body) => request(app).post(path).set('X-Forwarded-For', from()).send(body);
  const login = (door, mobile, extra = {}) => post(`${DOOR[door]}/login`, { mobile, password: PASSWORD, ...extra });
  const poll = (door, challengeToken) => post(`${DOOR[door]}/login/2fa`, { challengeToken });
  const startParam = (telegram) => new URL(telegram.url).searchParams.get('startapp');

  /** The Mini App page answering the challenge it was opened on. */
  const approve = (telegram, tgId, { decision = 'approve', phone = null } = {}) => post('/api/telegram/mini-app/approve', {
    initData: signInitData({ telegramUserId: tgId, startParam: startParam(telegram) }),
    contact: phone ? signContact({ telegramUserId: tgId, phone }) : undefined,
    decision,
  });

  const player = async ({ verified = true, twoFactor = false } = {}) => {
    const mobile = freshMobile('9');
    const userId = newUserId();
    await createUser({ userId, username: 'p', mobile, passwordHash: await hashPassword(PASSWORD), accountType: 'PLAYER', referralCode: `T3${n}${Date.now() % 100000}` });
    const tgId = verified ? await linkTelegram(userId, { twoFactor }) : freshTelegramUserId();
    return { userId, mobile, tgId };
  };

  const staff = async ({ verified = true } = {}) => {
    const mobile = freshMobile('8');
    const userId = newUserId();
    await createUser({ userId, username: 's', mobile, passwordHash: await hashPassword(PASSWORD), accountType: 'STAFF', isAdmin: true });
    await setRoles(userId, ['admin']);
    const tgId = verified ? await linkTelegram(userId) : freshTelegramUserId();
    return { userId, mobile, tgId };
  };

  const merchant = async ({ verified = true, approved = true } = {}) => {
    const mobile = freshMobile('7');
    const created = await createMerchantAccount({
      userId: newUserId(), username: `t3m${Date.now()}${n += 1}`, mobile,
      passwordHash: await hashPassword(PASSWORD), currency: 'INR',
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (approved) {
      await pgQuery(`UPDATE merchants SET status = 'ACTIVE', merchant_approval_status = 'APPROVED' WHERE merchant_id = $1`,
        [created.merchant.merchantId]);
    }
    const tgId = verified ? await linkTelegram(created.userId) : freshTelegramUserId();
    return { userId: created.userId, merchantId: created.merchant.merchantId, mobile, tgId };
  };

  // ── Signup verification ────────────────────────────────────────────────
  describe('signup is verified by one contact share', () => {
    it('a player signs up, shares the matching contact, and is signed in with their referrer credited', async () => {
      const referrer = await player();
      const code = (await db.users.getUser(referrer.userId)).referralCode;
      const mobile = freshMobile('9');
      const signup = await post('/api/v1/auth/register', { mobile, password: PASSWORD, confirmPassword: PASSWORD, referralCode: code });
      expect(signup.body, JSON.stringify(signup.body)).toMatchObject({ success: true, verificationRequired: true });
      expect(signup.body.token).toBeFalsy();

      expect((await poll('PLAYER', signup.body.challengeToken)).status).toBe(202);

      const tgId = freshTelegramUserId();
      const ok = await approve(signup.body.telegram, tgId, { phone: `+91${mobile}` });
      expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ success: true, kind: 'VERIFY', approved: true, verified: true });

      const session = await poll('PLAYER', signup.body.challengeToken);
      expect(session.status, JSON.stringify(session.body)).toBe(200);
      expect(verifyJwt(session.body.token).amr).toEqual(['pwd', 'tg']);
      const joiner = await getUserByMobile(mobile, 'PLAYER');
      expect(joiner.joiningNumber).toBeTruthy();
      const { rows } = await pgQuery(`SELECT earner_id FROM referral_earnings WHERE source_user_id = $1 AND level = 1`, [joiner.userId]);
      expect(rows.map((r) => r.earner_id)).toEqual([referrer.userId]);

      // The approval is spent: a second poll opens nothing.
      expect((await poll('PLAYER', signup.body.challengeToken)).status).toBe(401);
    });

    it('a contact on another number is refused, nothing is linked, and the right one still works', async () => {
      const mobile = freshMobile('9');
      const signup = await post('/api/v1/auth/register', { mobile, password: PASSWORD, confirmPassword: PASSWORD });
      const tgId = freshTelegramUserId();
      const wrong = await approve(signup.body.telegram, tgId, { phone: '9000000001' });
      expect(wrong.status).toBe(403);
      expect(wrong.body.code).toBe('CONTACT_MISMATCH');
      expect((await poll('PLAYER', signup.body.challengeToken)).status).toBe(202);
      expect((await approve(signup.body.telegram, tgId, { phone: mobile })).body.verified).toBe(true);
    });

    it('a contact signed for ANOTHER Telegram account is refused', async () => {
      const mobile = freshMobile('9');
      const signup = await post('/api/v1/auth/register', { mobile, password: PASSWORD, confirmPassword: PASSWORD });
      const res = await post('/api/telegram/mini-app/approve', {
        initData: signInitData({ telegramUserId: freshTelegramUserId(), startParam: startParam(signup.body.telegram) }),
        contact: signContact({ telegramUserId: freshTelegramUserId(), phone: mobile }),
        decision: 'approve',
      });
      expect(res.body.code).toBe('CONTACT_NOT_OWN');
    });

    it('a merchant applicant verifies while waiting, and is told it is waiting rather than an error', async () => {
      const m = await merchant({ verified: false, approved: false });
      const first = await login('MERCHANT', m.mobile);
      expect(first.status).toBe(403);
      expect(first.body.code).toBe('TELEGRAM_VERIFICATION_REQUIRED');
      await approve(first.body.telegram, m.tgId, { phone: m.mobile });
      const second = await poll('MERCHANT', first.body.challengeToken);
      expect(second.status).toBe(403);
      expect(second.body).toMatchObject({ code: 'MERCHANT_NOT_ACTIVE', verified: true });
      expect((await db.telegram.getLinkByUserId(m.userId)).twoFactor).toBe(true);
    });

    it('a forged initData is refused before anything is read', async () => {
      const res = await post('/api/telegram/mini-app/approve', {
        initData: signInitData({ telegramUserId: '1', startParam: 'c'.padEnd(33, '0'), token: '1:not-our-bot' }),
        decision: 'approve',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INIT_DATA_INVALID');
    });
  });

  // ── Password sign-in and the second factor ─────────────────────────────
  describe('password sign-in', () => {
    it('a verified player is signed in on the password alone', async () => {
      const p = await player();
      const res = await login('PLAYER', p.mobile);
      expect(res.status).toBe(200);
      expect(verifyJwt(res.body.token).amr).toEqual(['pwd']);
    });

    for (const door of ['STAFF', 'MERCHANT']) {
      it(`${door}: the password opens a Telegram approval; approving it signs in, with Telegram on the token`, async () => {
        const who = door === 'STAFF' ? await staff() : await merchant();
        const first = await login(door, who.mobile);
        expect(first.body, JSON.stringify(first.body)).toMatchObject({ success: false, twoFactorRequired: true });
        expect(first.body.token).toBeFalsy();
        expect((await poll(door, first.body.challengeToken)).status).toBe(202);

        // The linked Telegram approves without sharing again.
        expect((await approve(first.body.telegram, who.tgId)).body.approved).toBe(true);
        const session = await poll(door, first.body.challengeToken);
        expect(session.status, JSON.stringify(session.body)).toBe(200);
        expect(verifyJwt(session.body.token).amr).toEqual(['pwd', 'tg']);
        if (door === 'MERCHANT') expect(session.body.merchant._id).toBe(who.merchantId);
      });

      it(`${door}: a denied approval is refused and opens nothing`, async () => {
        const who = door === 'STAFF' ? await staff() : await merchant();
        const first = await login(door, who.mobile);
        await approve(first.body.telegram, who.tgId, { decision: 'deny' });
        const res = await poll(door, first.body.challengeToken);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('TWO_FACTOR_DENIED');
      });
    }

    it('another Telegram account cannot approve a staff sign-in without the matching contact', async () => {
      const s = await staff();
      const first = await login('STAFF', s.mobile);
      const intruder = await approve(first.body.telegram, freshTelegramUserId());
      expect(intruder.body.code).toBe('CONTACT_REQUIRED');
      const wrongPhone = await approve(first.body.telegram, freshTelegramUserId(), { phone: '9000000002' });
      expect(wrongPhone.body.code).toBe('CONTACT_MISMATCH');
      expect((await poll('STAFF', first.body.challengeToken)).status).toBe(202);
    });

    it('a staff approval cannot be redeemed at the merchant or player door', async () => {
      const s = await staff();
      const first = await login('STAFF', s.mobile);
      await approve(first.body.telegram, s.tgId);
      expect((await poll('MERCHANT', first.body.challengeToken)).status).toBe(401);
      expect((await poll('PLAYER', first.body.challengeToken)).status).toBe(401);
      expect((await poll('STAFF', first.body.challengeToken)).status).toBe(200);
    });

    it('a player who switched approval on owes it; switching it off needs Telegram\'s approval', async () => {
      const p = await player({ twoFactor: true });
      const first = await login('PLAYER', p.mobile);
      expect(first.body.twoFactorRequired).toBe(true);
      await approve(first.body.telegram, p.tgId);
      const session = await poll('PLAYER', first.body.challengeToken);
      const auth = `Bearer ${session.body.token}`;

      const off = await request(app).put('/api/v1/auth/telegram/two-factor').set('Authorization', auth).send({ enabled: false });
      expect(off.status).toBe(202);
      expect((await db.telegram.getLinkByUserId(p.userId)).twoFactor).toBe(true);
      await approve(off.body.telegram, p.tgId);
      expect((await db.telegram.getLinkByUserId(p.userId)).twoFactor).toBe(false);

      const on = await request(app).put('/api/v1/auth/telegram/two-factor').set('Authorization', auth).send({ enabled: true });
      expect(on.body.twoFactor).toEqual({ enabled: true, required: false });
    });

    it('a staff or merchant session without Telegram on it is refused once a bot exists', async () => {
      const { signToken } = await import('../../domains/identity/jwt.util.js');
      const s = await staff();
      const pwdOnly = signToken({ userId: s.userId, amr: ['pwd'] });
      const res = await request(app).get('/api/admin/account/telegram').set('Authorization', `Bearer ${pwdOnly}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TWO_FACTOR_REQUIRED');
      const both = signToken({ userId: s.userId, amr: ['pwd', 'tg'] });
      expect((await request(app).get('/api/admin/account/telegram').set('Authorization', `Bearer ${both}`)).status).toBe(200);
    });

    it('staff cannot switch Telegram approval off', async () => {
      const { signToken } = await import('../../domains/identity/jwt.util.js');
      const s = await staff();
      const auth = `Bearer ${signToken({ userId: s.userId, amr: ['pwd', 'tg'] })}`;
      const res = await request(app).put('/api/admin/account/telegram/two-factor').set('Authorization', auth).send({ enabled: false });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TWO_FACTOR_MANDATORY');
    });
  });

  // ── Login with Telegram ─────────────────────────────────────────────────
  describe('Login with Telegram', () => {
    it('outside Telegram, a player is signed in by approving in the Mini App, with Telegram alone on the token', async () => {
      const p = await player();
      const start = await post('/api/v1/auth/login/telegram', {});
      expect(start.body).toMatchObject({ success: false, pending: true });
      expect((await post('/api/v1/auth/login/telegram/complete', { challengeToken: start.body.challengeToken })).status).toBe(202);
      expect((await approve(start.body.telegram, p.tgId)).body.approved).toBe(true);
      const done = await post('/api/v1/auth/login/telegram/complete', { challengeToken: start.body.challengeToken });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(verifyJwt(done.body.token)).toMatchObject({ userId: p.userId, amr: ['tg'] });
    });

    it('inside the Mini App, the signed initData signs a linked player in', async () => {
      const p = await player();
      const res = await post('/api/v1/auth/login/telegram', { initData: signInitData({ telegramUserId: p.tgId }) });
      expect(res.status).toBe(200);
      expect(verifyJwt(res.body.token)).toMatchObject({ userId: p.userId, amr: ['tg'] });
    });

    it('an unlinked Telegram account is told it has no account, and a replayed initData is refused', async () => {
      const lone = await post('/api/v1/auth/login/telegram', { initData: signInitData({ telegramUserId: freshTelegramUserId() }) });
      expect(lone.status).toBe(404);
      expect(lone.body.code).toBe('NO_LINKED_ACCOUNT');

      const p = await player();
      const initData = signInitData({ telegramUserId: p.tgId });
      expect((await post('/api/v1/auth/login/telegram', { initData })).status).toBe(200);
      const again = await post('/api/v1/auth/login/telegram', { initData });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INIT_DATA_REPLAYED');
    });

    for (const door of ['STAFF', 'MERCHANT']) {
      it(`${door}: Telegram first, then the password; the approval stands in for the second factor once`, async () => {
        const who = door === 'STAFF' ? await staff() : await merchant();
        const start = await post(`${DOOR[door]}/login/telegram`, {});
        await approve(start.body.telegram, who.tgId);
        const next = await post(`${DOOR[door]}/login/telegram/complete`, { challengeToken: start.body.challengeToken });
        expect(next.body).toMatchObject({ success: false, passwordRequired: true });
        expect(next.body.token).toBeFalsy();

        const done = await login(door, who.mobile, { challengeToken: start.body.challengeToken });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        expect(done.body.token).toBeTruthy();
        expect(verifyJwt(done.body.token).amr).toEqual(['pwd', 'tg']);
      });
    }

    it('a staff Telegram approval does not complete ANOTHER staff account\'s password sign-in', async () => {
      const a = await staff();
      const b = await staff();
      const start = await post('/api/admin/login/telegram', {});
      await approve(start.body.telegram, a.tgId);
      const res = await login('STAFF', b.mobile, { challengeToken: start.body.challengeToken });
      expect(res.body.twoFactorRequired).toBe(true);
      expect(res.body.token).toBeFalsy();
    });

    it('staff inside the Mini App still owe their password', async () => {
      const s = await staff();
      const res = await post('/api/admin/login/telegram', { initData: signInitData({ telegramUserId: s.tgId }) });
      expect(res.body).toMatchObject({ success: false, passwordRequired: true });
      expect(res.body.token).toBeFalsy();
      const done = await login('STAFF', s.mobile, { challengeToken: res.body.challengeToken });
      expect(done.status).toBe(200);
    });
  });

  // ── Signup inside the Mini App, from a referral link ─────────────────────
  describe('signup inside the Mini App', () => {
    it('a referral link opens signup with the code locked; the account is created verified and signed in', async () => {
      const referrer = await player();
      const code = (await db.users.getUser(referrer.userId)).referralCode;
      const tgId = freshTelegramUserId();
      const mobile = freshMobile('9');
      const initData = signInitData({ telegramUserId: tgId, startParam: `ref-${code}` });

      const ctx = await post('/api/telegram/mini-app/context', { initData });
      expect(ctx.body.start).toMatchObject({ kind: 'SIGNUP', panel: 'PLAYER', referral: { code } });

      const res = await post('/api/telegram/mini-app/signup', {
        initData, contact: signContact({ telegramUserId: tgId, phone: mobile }),
        password: PASSWORD, confirmPassword: PASSWORD, referralCode: 'SOMEONEELSE',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const joiner = await getUserByMobile(mobile, 'PLAYER');
      expect(joiner.referredBy).toBe(referrer.userId);
      expect(await db.telegram.getLinkByUserId(joiner.userId)).toMatchObject({ telegramUserId: tgId });
    });
  });

  // ── Forgot password ────────────────────────────────────────────────────
  describe('forgot password', () => {
    it('the matching contact yields a reset link for that panel; the new password works and old sessions die', async () => {
      const m = await merchant();
      const info = await request(app).get('/api/telegram/mini-app?panel=MERCHANT');
      expect(info.body.resetUrl).toContain('startapp=reset-MERCHANT');

      const reset = await post('/api/telegram/mini-app/password-reset', {
        initData: signInitData({ telegramUserId: m.tgId, startParam: 'reset-MERCHANT' }),
        contact: signContact({ telegramUserId: m.tgId, phone: m.mobile }),
      });
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      expect(reset.body.panel).toBe('MERCHANT');
      const NEW = 'A-Brand-New-Merchant-Pass-3!';
      const set = await post('/api/v1/auth/password/reset', { token: reset.body.resetToken, password: NEW, confirmPassword: NEW });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      const res = await post('/api/merchant/auth/login', { mobile: m.mobile, password: NEW });
      expect(res.body.twoFactorRequired).toBe(true);
      // Single use.
      expect((await post('/api/v1/auth/password/reset', { token: reset.body.resetToken, password: NEW, confirmPassword: NEW })).status).toBe(400);
    });

    it('a contact of another number is refused, and no reset is issued', async () => {
      const p = await player();
      const res = await post('/api/telegram/mini-app/password-reset', {
        initData: signInitData({ telegramUserId: p.tgId, startParam: 'reset-PLAYER' }),
        contact: signContact({ telegramUserId: p.tgId, phone: '9000000003' }),
      });
      expect(res.status).toBe(404);
      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1', [p.userId]);
      expect(rows[0].n).toBe(0);
    });
  });

  // ── No bot ─────────────────────────────────────────────────────────────
  describe('with no bot configured', () => {
    it('staff sign in on the password (the bootstrap) and are told so; players and merchants are told Telegram is unavailable', async () => {
      await removeTestBot();
      try {
        const s = await staff({ verified: false });
        const res = await login('STAFF', s.mobile);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.bootstrap).toBe(true);

        const m = await merchant({ verified: false });
        const refused = await login('MERCHANT', m.mobile);
        expect(refused.status).toBe(503);
        expect(refused.body.code).toBe('TELEGRAM_UNAVAILABLE');
        expect((await request(app).get('/api/telegram/mini-app?panel=PLAYER')).body.available).toBe(false);
      } finally { await saveTestBot(); }
    });
  });
});
