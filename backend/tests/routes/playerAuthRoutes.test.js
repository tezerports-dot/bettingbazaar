// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The player's door, through a real database and the real routers: what it
 * still serves, what it no longer serves, and where its limits are.
 *
 * Since 2026-10-13/14 (owner) a player signs up and signs in by "Continue with
 * Telegram" alone: no form, no password, no reset. The sign-in itself — the
 * number match, the handoff ticket, signup by the first contact share — is
 * driven in continueWithTelegramPg.test.js. This file holds what sits around
 * it:
 *
 *   · the invite check (`GET /api/v1/auth/invite/:code`), which the sign-in
 *     screen asks before the player presses anything;
 *   · the account questions the door asks after Telegram has approved (a
 *     blocked player gets no session; a staff account on the same mobile is
 *     never the account a player's Verify enters);
 *   · the removed form legs answer nothing;
 *   · the limits, asserted by BEHAVIOUR through the mounted routers (§22: a
 *     test reading a file's source is not a consumer): the captcha on the
 *     player's Continue with Telegram and not the merchant's; the per-address
 *     Telegram limiter; the account-creation budget on the Mini App doors that
 *     make accounts, counting only the requests that made one.
 *
 * Nothing reaches Telegram or Cloudflare: Mini App strings are signed with the
 * test bot's token (miniAppFixture.js), and the captcha is refused for a
 * MISSING token, which is answered before any network call.
 *
 * Every case comes from its own addresses: the limiters are real and key on
 * the address (`trust proxy` reads X-Forwarded-For).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { newUserId, createUser, getUserByMobile, setRoles } from '#db/repositories/users.js';
import { verifyJwt } from '../../domains/identity/jwt.util.js';
import { doorRoute } from '../../domains/identity/loginDoors.js';
import { RATE_LIMIT_TIERS } from '../../config/security.config.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId,
} from '../miniAppFixture.js';

const describePg = pgConfigured() ? describe : describe.skip;

// A /8 of this file's own, a fresh /24 per address: no subnet budget is shared
// between cases, or with a rerun in the same process.
const NET = 20 + Math.floor(Math.random() * 60);
let addr = 0;
const from = () => { addr += 1; return `${NET}.${(addr >> 8) & 255}.${addr & 255}.7`; };
let n = 0;
const RUN = String(Math.floor(Math.random() * 900) + 100);
const freshMobile = (lead = '9') => `${lead}${RUN}${String(Date.now()).slice(-2)}${String(n += 1).padStart(4, '0')}`;

describePg('the player door (PostgreSQL)', () => {
  let app;
  const made = [];
  const origin = process.env.PUBLIC_APP_ORIGIN;

  beforeAll(async () => {
    // Verify sends a HANDOFF to the site: it needs the site's address.
    process.env.PUBLIC_APP_ORIGIN = 'https://bb.example';
    await applySchema();
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/auth', (await import('../../domains/identity/playerAuth.routes.js')).default);
    app.use('/api/merchant', (await import('../../domains/merchant/merchant.routes.js')).default);
    app.use('/api/telegram', (await import('../../domains/telegram/miniApp.routes.js')).default);
    await saveTestBot();
  }, 60_000);

  afterAll(async () => {
    try {
      // Trap 10: only this run's accounts. A STAFF twin is removed here; the
      // players stay (referral rows and wallets point at them).
      if (made.length) await pgQuery(`DELETE FROM users WHERE user_id = ANY($1) AND account_type = 'STAFF'`, [made]);
    } finally {
      if (origin === undefined) delete process.env.PUBLIC_APP_ORIGIN; else process.env.PUBLIC_APP_ORIGIN = origin;
      await removeTestBot();
      await closePg();
    }
  });

  const post = (path, body, ip = from()) => request(app).post(path).set('X-Forwarded-For', ip).send(body);
  const startParam = (telegram) => new URL(telegram.url).searchParams.get('startapp');

  /** A verified player with an invite code of their own. */
  const player = async () => {
    const mobile = freshMobile('9');
    const userId = newUserId();
    const referralCode = `PA${RUN}${n}${Date.now() % 10000}`.slice(0, 16).toUpperCase();
    await createUser({ userId, username: `player${mobile.slice(-4)}`, mobile, accountType: 'PLAYER', referralCode });
    const tgId = await linkTelegram(userId);
    return { userId, mobile, tgId, referralCode };
  };

  /** Continue with Telegram at the player door, MATCH, answered by `tgId`. */
  const signInMatch = async (tgId, { phone = null } = {}) => {
    const opened = (await post('/api/v1/auth/login/telegram', { delivery: 'MATCH' })).body;
    expect(opened.challengeToken, JSON.stringify(opened)).toBeTruthy();
    const ok = await post('/api/telegram/mini-app/approve', {
      initData: signInitData({ telegramUserId: tgId, startParam: startParam(opened.telegram) }),
      contact: phone ? signContact({ telegramUserId: tgId, phone }) : undefined,
      decision: 'approve', pick: opened.matchNumber,
    });
    const done = await post('/api/v1/auth/login/telegram/complete', { challengeToken: opened.challengeToken });
    return { opened, approval: ok, done };
  };

  // ── GET /invite/:code ──────────────────────────────────────────────────
  describe('GET /api/v1/auth/invite/:code', () => {
    it('confirms a real code, in any case, and names who it belongs to', async () => {
      const inviter = await player();
      for (const code of [inviter.referralCode, inviter.referralCode.toLowerCase()]) {
        const res = await request(app).get(`/api/v1/auth/invite/${code}`).set('X-Forwarded-For', from());
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ valid: true, code: inviter.referralCode, invitedBy: `player${inviter.mobile.slice(-4)}` });
      }
    });

    it('answers a nonsense code without an error', async () => {
      // The sign-in screen asks this before the player can act; a 500 would
      // render as a broken screen for somebody who did nothing wrong.
      const res = await request(app).get('/api/v1/auth/invite/NOSUCHCODE').set('X-Forwarded-For', from());
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });

    it('leaks nothing beyond the username for a code somebody already holds', async () => {
      const inviter = await player();
      const res = await request(app).get(`/api/v1/auth/invite/${inviter.referralCode}`).set('X-Forwarded-For', from());
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(inviter.mobile);
      expect(body).not.toContain(inviter.userId);
    });

    it('checks no credential, so no credential limiter answers it (§32 S27, S28)', async () => {
      const ip = from();
      const answers = await Promise.all(Array.from({ length: RATE_LIMIT_TIERS.telegramLogin.max + 5 }, () => request(app)
        .get('/api/v1/auth/invite/NOSUCHCODE').set('X-Forwarded-For', ip)));
      expect(answers.every((r) => r.status === 200)).toBe(true);
    });
  });

  // ── What the door asks after Telegram approved ─────────────────────────
  describe('the account questions after the approval', () => {
    it('a blocked player\'s Verify is refused in Telegram, saying why, and the browser gets no session', async () => {
      const p = await player();
      await pgQuery(`UPDATE users SET is_blocked = true, block_reason = 'x', blocked_at = now() WHERE user_id = $1`, [p.userId]);
      const { approval, done } = await signInMatch(p.tgId);
      expect(approval.status, JSON.stringify(approval.body)).toBe(403);
      expect(approval.body.code).toBe('ACCOUNT_BLOCKED');
      expect(approval.body.message).toMatch(/blocked/i);
      expect(done.body.token).toBeFalsy();
    });

    it('a player blocked between the approval and the poll gets no session: the door asks again', async () => {
      const p = await player();
      const opened = (await post('/api/v1/auth/login/telegram', { delivery: 'MATCH' })).body;
      const ok = await post('/api/telegram/mini-app/approve', {
        initData: signInitData({ telegramUserId: p.tgId, startParam: startParam(opened.telegram) }),
        decision: 'approve', pick: opened.matchNumber,
      });
      expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ approved: true });
      await pgQuery(`UPDATE users SET is_blocked = true, block_reason = 'x', blocked_at = now() WHERE user_id = $1`, [p.userId]);
      const done = await post('/api/v1/auth/login/telegram/complete', { challengeToken: opened.challengeToken });
      expect(done.status, JSON.stringify(done.body)).toBe(403);
      expect(done.body.code).toBe('ACCOUNT_BLOCKED');
      expect(done.body.token).toBeFalsy();
    });

    it('a staff account on the same mobile is never what a player\'s Verify enters (§33.5)', async () => {
      const mobile = freshMobile('9');
      const staffId = newUserId();
      made.push(staffId);
      const staff = await createUser({
        userId: staffId, username: `staff${mobile.slice(-4)}`, mobile, status: 'ACTIVE',
        isAdmin: true, accountType: 'STAFF', passwordHash: 'argon2id$not-a-real-hash',
      });
      expect(staff.created).toBe(true);
      await setRoles(staffId, ['admin']);

      // A Telegram account whose own number is the staff member's shares it at
      // the player door: a PLAYER account is made for it, the staff row is
      // neither linked nor signed into.
      const tgId = freshTelegramUserId();
      const { approval, done } = await signInMatch(tgId, { phone: mobile });
      expect(approval.body, JSON.stringify(approval.body)).toMatchObject({ approved: true, created: true });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const playerRow = await getUserByMobile(mobile, 'PLAYER');
      expect(playerRow.userId).not.toBe(staffId);
      expect(verifyJwt(done.body.token).userId).toBe(playerRow.userId);
      expect(await db.telegram.getLinkByUserId(staffId)).toBeFalsy();
    });
  });

  // ── The removed legs ───────────────────────────────────────────────────
  describe('no form, no password', () => {
    it('the player door serves no signup form, password login or reset; the merchant door no signup or password login', async () => {
      for (const path of ['/register', '/login', '/login/2fa', '/password/reset', '/forgot-password']) {
        const res = await post(`/api/v1/auth${path}`, { mobile: freshMobile('9'), password: 'a-long-enough-phrase', confirmPassword: 'a-long-enough-phrase' });
        expect(res.status, path).toBe(404);
      }
      for (const path of ['/auth/signup', '/auth/login', '/auth/login/2fa']) {
        const res = await post(`/api/merchant${path}`, { mobile: freshMobile('7'), password: 'a-long-enough-phrase' });
        expect(res.status, path).toBe(404);
      }
    });

    it('no door can be given a password leg but the staff door', () => {
      expect(() => doorRoute('PLAYER', 'login')).toThrow(/no login leg/);
      expect(() => doorRoute('MERCHANT', 'login')).toThrow(/no login leg/);
      expect(() => doorRoute('STAFF', 'telegram')).toThrow(/no telegram leg/);
    });
  });

  // ── Where the limits are, by behaviour ─────────────────────────────────
  describe('the limits', () => {
    it('the player\'s Continue with Telegram owes the captcha; the merchant\'s does not', async () => {
      const before = process.env.TURNSTILE_SECRET_KEY;
      process.env.TURNSTILE_SECRET_KEY = 'test-only-secret-never-sent';
      try {
        // No token: refused before any network call, and before a sign-in is opened.
        const { rows: [{ c: challengesBefore }] } = await pgQuery(`SELECT count(*)::int AS c FROM telegram_challenges WHERE audience = 'PLAYER'`);
        const playerDoor = await post('/api/v1/auth/login/telegram', { delivery: 'MATCH' });
        expect(playerDoor.status, JSON.stringify(playerDoor.body)).toBe(403);
        expect(playerDoor.body.code).toBe('CAPTCHA_REQUIRED');
        const { rows: [{ c: challengesAfter }] } = await pgQuery(`SELECT count(*)::int AS c FROM telegram_challenges WHERE audience = 'PLAYER'`);
        expect(challengesAfter).toBe(challengesBefore);

        const merchantDoor = await post('/api/merchant/auth/login/telegram', { delivery: 'MATCH' });
        expect(merchantDoor.status, JSON.stringify(merchantDoor.body)).toBe(200);
        expect(merchantDoor.body).toMatchObject({ pending: true });
      } finally {
        if (before === undefined) delete process.env.TURNSTILE_SECRET_KEY; else process.env.TURNSTILE_SECRET_KEY = before;
      }
      // Without a secret it is a pass-through, as it ships.
      expect((await post('/api/v1/auth/login/telegram', { delivery: 'MATCH' })).status).toBe(200);
    });

    it('opening a sign-in is paced per address', async () => {
      const ip = from();
      const { max } = RATE_LIMIT_TIERS.telegramLogin;
      for (let i = 0; i < max; i += 1) {
        expect((await post('/api/v1/auth/login/telegram', { delivery: 'MATCH' }, ip)).status).toBe(200);
      }
      const paced = await post('/api/v1/auth/login/telegram', { delivery: 'MATCH' }, ip);
      expect(paced.status).toBe(429);
      expect(paced.body.code).toBe('LOGIN_PACED');
      // Another address is not paced by it.
      expect((await post('/api/v1/auth/login/telegram', { delivery: 'MATCH' })).status).toBe(200);
    });

    it('the account-creation budget counts accounts made, never a refusal or a returning player (§32 S13)', async () => {
      const ip = from();
      const { max } = RATE_LIMIT_TIERS.signup;
      const cont = (body) => post('/api/telegram/mini-app/continue', body, ip);

      // Refusals from one address, past the budget: none is counted.
      for (let i = 0; i < max + 2; i += 1) {
        const tgId = freshTelegramUserId();
        const res = await cont({
          initData: signInitData({ telegramUserId: tgId }),
          contact: signContact({ telegramUserId: freshTelegramUserId(), phone: freshMobile('9') }),
        });
        expect(res.body.code, JSON.stringify(res.body)).toBe('CONTACT_NOT_OWN');
      }
      // Returning players signing in from it, past the budget: none is counted.
      for (let i = 0; i < max + 2; i += 1) {
        const p = await player();
        const res = await cont({ initData: signInitData({ telegramUserId: p.tgId }) });
        expect(res.body, JSON.stringify(res.body)).toMatchObject({ success: true, created: false });
      }
      // Accounts made: the budget is spent by exactly these.
      for (let i = 0; i < max; i += 1) {
        const tgId = freshTelegramUserId();
        const res = await cont({ initData: signInitData({ telegramUserId: tgId }), contact: signContact({ telegramUserId: tgId, phone: freshMobile('9') }) });
        expect(res.body, JSON.stringify(res.body)).toMatchObject({ success: true, created: true });
      }
      const tgId = freshTelegramUserId();
      const mobile = freshMobile('9');
      const over = await cont({ initData: signInitData({ telegramUserId: tgId }), contact: signContact({ telegramUserId: tgId, phone: mobile }) });
      expect(over.status, JSON.stringify(over.body)).toBe(429);
      expect(await getUserByMobile(mobile, 'PLAYER')).toBeNull();
    }, 60_000);

    it('the Verify that answers a website\'s sign-in carries the same budget', async () => {
      const ip = from();
      const { max } = RATE_LIMIT_TIERS.signup;
      const approveNew = async () => {
        const opened = (await post('/api/v1/auth/login/telegram', { delivery: 'HANDOFF', returnOrigin: 'https://bb.example' })).body;
        const tgId = freshTelegramUserId();
        const mobile = freshMobile('9');
        const res = await post('/api/telegram/mini-app/approve', {
          initData: signInitData({ telegramUserId: tgId, startParam: startParam(opened.telegram) }),
          contact: signContact({ telegramUserId: tgId, phone: mobile }),
          decision: 'approve',
        }, ip);
        return { res, mobile };
      };
      for (let i = 0; i < max; i += 1) {
        const { res } = await approveNew();
        expect(res.body, JSON.stringify(res.body)).toMatchObject({ approved: true, created: true });
      }
      const { res, mobile } = await approveNew();
      expect(res.status, JSON.stringify(res.body)).toBe(429);
      expect(await getUserByMobile(mobile, 'PLAYER')).toBeNull();
    }, 60_000);
  });
});
