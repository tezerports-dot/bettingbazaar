// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The MERCHANT door's "Continue with Telegram", and what the staff door does
 * not have, at the HTTP boundary on a real PostgreSQL.
 *
 * Owner, 2026-10-13/14: players and merchants sign up and sign in only by
 * Continue with Telegram (no password); staff by password and an authenticator
 * app, with no Telegram anywhere. The player door's flow — the number match,
 * the handoff ticket, signup by the first contact share, the bot-opened
 * Verify — is proven in continueWithTelegramPg.test.js; the staff code legs in
 * staffSignInPg.test.js. This file holds what neither does: a merchant's first
 * Verify links the account an admin made for their mobile (Telegram never
 * makes a merchant, owner 2026-10-14), a
 * merchant session carries the merchant profile (a supervisor told so), the
 * Mini App's refusals at the merchant door, the two Telegram doors never
 * redeeming each other's approvals, and the staff door's lack of any of it.
 *
 * Nothing here reaches Telegram. The Mini App's strings are signed with the
 * test token (miniAppFixture.js), the algorithm the server verifies, and the
 * server holds that token as its one bot.
 *
 * Each case uses its own accounts and its own address: the Telegram limiters
 * key on the address.
 */
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { setSupervisorRole } from '#db/repositories/teams.js';
import { newUserId, createUser, setRoles, getUserByMobile } from '#db/repositories/users.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import { verifyJwt, signToken } from '../../domains/identity/jwt.util.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId,
} from '../miniAppFixture.js';

const describePg = pgConfigured() ? describe : describe.skip;
const SITE = 'https://bb.example';
const STAFF_PASSWORD = 'Telegram-Step3-Pass-7q!';

let addr = 0;
const from = () => { addr += 1; return `10.${90 + ((addr >> 16) & 7)}.${(addr >> 8) & 255}.${addr & 255}`; };
let n = 0;
// A random tail: a merchant application is named `merchant<last four>`
// (telegram.js `signUpWithin`), so a counter tail repeats its last four on the
// next run against the same database.
const freshMobile = (lead = '9') => `${lead}${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;

const DOOR = { PLAYER: '/api/v1/auth', MERCHANT: '/api/merchant/auth' };

describePg('Continue with Telegram at the merchant door; none at the staff door', () => {
  let app;
  const originBefore = process.env.PUBLIC_APP_ORIGIN;

  beforeAll(async () => {
    process.env.PUBLIC_APP_ORIGIN = SITE;
    await applySchema();
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/auth', (await import('../../domains/identity/playerAuth.routes.js')).default);
    app.post('/api/admin/login', ...doorRoute('STAFF', 'login'));
    app.use('/api/admin', (await import('../../routes/admin/telegram.admin.routes.js')).default);
    app.use('/api/merchant', (await import('../../domains/merchant/merchant.routes.js')).default);
    app.use('/api/telegram', (await import('../../domains/telegram/miniApp.routes.js')).default);
    await saveTestBot();
  }, 60_000);

  afterAll(async () => {
    if (originBefore === undefined) delete process.env.PUBLIC_APP_ORIGIN; else process.env.PUBLIC_APP_ORIGIN = originBefore;
    await removeTestBot();
    await closePg();
  });

  const post = (path, body) => request(app).post(path).set('X-Forwarded-For', from()).send(body);
  const startParam = (opened) => new URL(opened.telegram.url).searchParams.get('startapp');
  const open = (door, delivery = 'MATCH') => post(`${DOOR[door]}/login/telegram`, { delivery, returnOrigin: SITE }).then((r) => r.body);
  const complete = (door, opened) => post(`${DOOR[door]}/login/telegram/complete`, { challengeToken: opened.challengeToken });
  const redeem = (door, ticket) => post(`${DOOR[door]}/login/telegram/ticket`, { ticket });
  const ticketOf = (url) => new URL(url).hash.replace(/^#\/tg\//, '');

  /** The Mini App page answering the sign-in it was opened on. */
  const approve = (opened, tgId, {
    decision = 'approve', phone = null, contactFrom = tgId, initData, pick = opened.matchNumber ?? undefined,
  } = {}) => post('/api/telegram/mini-app/approve', {
    initData: initData ?? signInitData({ telegramUserId: tgId, startParam: startParam(opened) }),
    contact: phone ? signContact({ telegramUserId: contactFrom, phone }) : undefined,
    decision, pick,
  });

  /** A staff account: it has no Telegram to link (owner, 2026-10-13). */
  const staff = async () => {
    const mobile = freshMobile('8');
    const userId = newUserId();
    await createUser({ userId, username: 's', mobile, passwordHash: await hashPassword(STAFF_PASSWORD), accountType: 'STAFF', isAdmin: true });
    await setRoles(userId, ['admin']);
    return { userId, mobile };
  };

  /** An approved merchant whose Telegram is linked (what their first Verify left). */
  const merchant = async () => {
    const mobile = freshMobile('7');
    const created = await createMerchantAccount({
      userId: newUserId(), username: `t3m${Date.now()}${n += 1}`, mobile, currency: 'INR',
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    await pgQuery(`UPDATE merchants SET status = 'ACTIVE', merchant_approval_status = 'APPROVED' WHERE merchant_id = $1`,
      [created.merchant.merchantId]);
    const tgId = await linkTelegram(created.userId);
    return { userId: created.userId, merchantId: created.merchant.merchantId, mobile, tgId };
  };

  /** Continue with Telegram at the merchant door, approved, and polled. */
  const signIn = async (who) => {
    const opened = await open('MERCHANT');
    expect((await approve(opened, who.tgId)).body.approved).toBe(true);
    return complete('MERCHANT', opened);
  };

  // ── A merchant signs in ────────────────────────────────────────────────
  describe('a merchant signs in', () => {
    it('by the number match: the poll waits, then answers a merchant session with Telegram alone on it', async () => {
      const m = await merchant();
      const opened = await open('MERCHANT');
      expect(opened).toMatchObject({ pending: true, delivery: 'MATCH' });
      // Nobody has approved: the browser waits, and nothing is redeemed.
      expect((await complete('MERCHANT', opened)).status).toBe(202);

      const ctx = (await post('/api/telegram/mini-app/context', {
        initData: signInitData({ telegramUserId: m.tgId, startParam: startParam(opened) }),
      })).body.start;
      expect(ctx).toMatchObject({ kind: 'TELEGRAM_LOGIN', panel: 'MERCHANT', destination: 'bb.example/merchant', account: { isNew: false } });

      expect((await approve(opened, m.tgId)).body.approved).toBe(true);
      const session = await complete('MERCHANT', opened);
      expect(session.status, JSON.stringify(session.body)).toBe(200);
      expect(verifyJwt(session.body.token)).toMatchObject({ userId: m.userId, merchantId: m.merchantId, isMerchant: true, amr: ['tg'] });
      expect(session.body.merchant._id).toBe(m.merchantId);
      expect(session.body.actor).toEqual({ isOwner: true });
    });

    it('by the handoff ticket: Verify sends the merchant panel the ticket, and the player door signs nobody in on one', async () => {
      const m = await merchant();
      const opened = await open('MERCHANT', 'HANDOFF');
      const ok = await approve(opened, m.tgId);
      expect(ok.body.redirectUrl).toMatch(/^https:\/\/bb\.example\/merchant\/#\/tg\/[A-Za-z0-9_-]{43}$/);
      const ticket = ticketOf(ok.body.redirectUrl);

      const session = await redeem('MERCHANT', ticket);
      expect(session.status, JSON.stringify(session.body)).toBe(200);
      expect(verifyJwt(session.body.token)).toMatchObject({ merchantId: m.merchantId, amr: ['tg'] });

      // Another merchant ticket, presented at the PLAYER door: nobody is signed in.
      const again = await open('MERCHANT', 'HANDOFF');
      const atPlayer = await redeem('PLAYER', ticketOf((await approve(again, m.tgId)).body.redirectUrl));
      expect(atPlayer.status).toBe(401);
      expect(atPlayer.body.code).toBe('TICKET_INVALID');
      expect(atPlayer.body.token).toBeUndefined();
    });

    it('a denied approval is refused and opens nothing', async () => {
      const m = await merchant();
      const opened = await open('MERCHANT');
      expect((await approve(opened, m.tgId, { decision: 'deny' })).body).toMatchObject({ success: true, approved: false });
      const res = await complete('MERCHANT', opened);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TWO_FACTOR_DENIED');
    });

    // The sign-in hands the panel the profile's own projection (§5). A copy
    // built by hand lacked `isSupervisor`, so a supervisor who had just signed
    // in was shown a member's online switch until the next reload.
    it('a supervisor is told so by the sign-in itself, and a member is not (the opposite)', async () => {
      const sup = await merchant();
      const role = await setSupervisorRole(sup.merchantId, { rail: 'CASH' });
      expect(role.ok, JSON.stringify(role)).toBe(true);
      const mem = await merchant();
      for (const [who, isSupervisor] of [[sup, true], [mem, false]]) {
        const session = await signIn(who);
        expect(session.status, JSON.stringify(session.body)).toBe(200);
        expect(session.body.merchant.isSupervisor).toBe(isSupervisor);
        expect(session.body.merchant).toHaveProperty('assignmentPausedAt');
      }
    });

    it('a merchant approval is not redeemed at the player door, and still is at its own', async () => {
      const m = await merchant();
      const opened = await open('MERCHANT');
      await approve(opened, m.tgId);
      const atPlayer = await complete('PLAYER', opened);
      expect(atPlayer.status).toBe(401);
      expect(atPlayer.body.token).toBeUndefined();
      expect((await complete('MERCHANT', opened)).status).toBe(200);
    });

    it('a merchant an admin suspended between Verify and the poll is refused at the poll', async () => {
      const m = await merchant();
      const opened = await open('MERCHANT');
      await approve(opened, m.tgId);
      await pgQuery(`UPDATE merchants SET status = 'SUSPENDED', suspension_reason = 'test' WHERE merchant_id = $1`, [m.merchantId]);
      const res = await complete('MERCHANT', opened);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MERCHANT_NOT_ACTIVE');
      expect(res.body.token).toBeUndefined();
    });

    it('a merchant login an admin blocked between Verify and the ticket is refused at the ticket', async () => {
      const m = await merchant();
      const opened = await open('MERCHANT', 'HANDOFF');
      const ok = await approve(opened, m.tgId);
      await pgQuery(`UPDATE users SET is_blocked = TRUE, block_reason = 'test', blocked_at = now() WHERE user_id = $1`, [m.userId]);
      const res = await redeem('MERCHANT', ticketOf(ok.body.redirectUrl));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_BLOCKED');
      expect(res.body.token).toBeUndefined();
    });
  });

  // ── A merchant account is made by an admin; Telegram confirms it ───────
  // Owner, 2026-10-14: an admin creates the merchant, supervisor or agent with
  // their mobile; their first Verify shares the contact, which finds that
  // account by its mobile, links it and signs them in. Telegram never makes a
  // merchant: the panel used to make a PENDING application for anyone who
  // pressed the button.
  describe('a merchant account made by an admin', () => {
    /** What `POST /api/admin/merchants/create` makes: approved, active, nothing linked. */
    const adminMade = async () => {
      const mobile = freshMobile('7');
      const created = await createMerchantAccount({
        userId: newUserId(), username: `adm${Date.now()}${n += 1}`, mobile, currency: 'INR',
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      await db.merchants.approveMerchant(created.merchant.merchantId, { actor: 'test-admin' });
      return { userId: created.userId, merchantId: created.merchant.merchantId, mobile };
    };

    it('the first Verify with the contact of its mobile links it and signs in, with no password', async () => {
      const m = await adminMade();
      const tgId = freshTelegramUserId();
      const opened = await open('MERCHANT');
      expect((await approve(opened, tgId)).body.code).toBe('CONTACT_REQUIRED');

      const ok = await approve(opened, tgId, { phone: `+91${m.mobile}` });
      expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ success: true, approved: true, created: false, panel: 'MERCHANT' });
      expect((await db.telegram.getLinkByUserId(m.userId)).telegramUserId).toBe(tgId);
      expect((await db.users.getUserCredentials(m.userId)).passwordHash).toBeNull();

      const session = await complete('MERCHANT', opened);
      expect(session.status, JSON.stringify(session.body)).toBe(200);
      expect(verifyJwt(session.body.token)).toMatchObject({ userId: m.userId, amr: ['tg'] });
      // And later, by Telegram alone.
      expect((await signIn({ tgId })).status).toBe(200);
    });

    it('a mobile no admin made an account for is refused, says to ask an admin, and nothing is made', async () => {
      const tgId = freshTelegramUserId();
      const mobile = freshMobile('7');
      const opened = await open('MERCHANT');
      const res = await approve(opened, tgId, { phone: `+91${mobile}` });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NO_MERCHANT_ACCOUNT');
      expect(res.body.message).toMatch(/Ask an admin/);
      expect(await getUserByMobile(mobile, 'MERCHANT')).toBeNull();
      expect(await db.telegram.getLinkByTelegramId(tgId, 'MERCHANT')).toBeNull();
      expect((await complete('MERCHANT', opened)).status).toBe(202);
    });

    it('a player signing up the same way is still made (the opposite door)', async () => {
      const tgId = freshTelegramUserId();
      const mobile = freshMobile('9');
      const ok = await approve(await open('PLAYER'), tgId, { phone: `+91${mobile}` });
      expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ approved: true, created: true, panel: 'PLAYER' });
      expect(await getUserByMobile(mobile, 'PLAYER')).toBeTruthy();
    });

    it('another Telegram account cannot enter a merchant: asked for a contact, and refused with its own', async () => {
      const m = await merchant();
      const intruderTg = freshTelegramUserId();
      const opened = await open('MERCHANT');
      expect((await approve(opened, intruderTg)).body.code).toBe('CONTACT_REQUIRED');
      const res = await approve(opened, intruderTg, { phone: freshMobile('7') });
      expect(res.body.code).toBe('NO_MERCHANT_ACCOUNT');
      expect((await complete('MERCHANT', opened)).status).toBe(202);
      expect((await db.telegram.getLinkByUserId(m.userId)).telegramUserId).toBe(m.tgId);
    });

    it('a contact signed for ANOTHER Telegram account is refused, and nothing is made', async () => {
      const tgId = freshTelegramUserId();
      const mobile = freshMobile('7');
      const opened = await open('MERCHANT');
      const res = await approve(opened, tgId, { phone: mobile, contactFrom: freshTelegramUserId() });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CONTACT_NOT_OWN');
      expect(await getUserByMobile(mobile, 'MERCHANT')).toBeNull();
      expect((await complete('MERCHANT', opened)).status).toBe(202);
    });
  });

  // ── The Mini App's own refusals ────────────────────────────────────────
  describe("the Mini App's proof", () => {
    it('a forged initData is refused before anything is read', async () => {
      const res = await post('/api/telegram/mini-app/approve', {
        initData: signInitData({ telegramUserId: '1', startParam: 'c'.padEnd(33, '0'), token: '1:not-our-bot' }),
        decision: 'approve',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INIT_DATA_INVALID');
    });

    it('the initData of a used merchant Verify is refused a second time', async () => {
      const m = await merchant();
      const opened = await open('MERCHANT', 'HANDOFF');
      const initData = signInitData({ telegramUserId: m.tgId, startParam: startParam(opened) });
      expect((await approve(opened, m.tgId, { initData })).body.approved).toBe(true);
      const again = await approve(opened, m.tgId, { initData });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INIT_DATA_REPLAYED');
    });
  });

  // ── The staff door has no Telegram ─────────────────────────────────────
  describe('the staff door', () => {
    it('mounts no Telegram leg, and the Telegram doors mount no password leg', async () => {
      const { doorRoute } = await import('../../domains/identity/loginDoors.js');
      for (const leg of ['telegram', 'telegramComplete', 'telegramTicket']) {
        expect(() => doorRoute('STAFF', leg), leg).toThrow(/no .* leg/);
        expect(() => doorRoute('PLAYER', leg), leg).not.toThrow();
        expect(() => doorRoute('MERCHANT', leg), leg).not.toThrow();
      }
      for (const door of ['PLAYER', 'MERCHANT']) {
        for (const leg of ['login', 'totp', 'totpSetup', 'totpActivate']) {
          expect(() => doorRoute(door, leg), `${door} ${leg}`).toThrow(/no .* leg/);
        }
      }
      expect(() => doorRoute('STAFF', 'login')).not.toThrow();
    });

    it('the staff password leg opens no Telegram step: it asks for an authenticator code', async () => {
      const s = await staff();
      const first = await post('/api/admin/login', { mobile: s.mobile, password: STAFF_PASSWORD });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ success: false, twoFactorRequired: true, totpSetupRequired: true });
      expect(first.body.telegram).toBeUndefined();
      expect(first.body.token).toBeFalsy();
      // Nothing was written for Telegram to answer.
      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM telegram_challenges WHERE user_id = $1', [s.userId]);
      expect(rows[0].n).toBe(0);
    });

    it('a staff session is admitted on an authenticator code, never on Telegram', async () => {
      const s = await staff();
      const bot = (amr) => request(app).get('/api/admin/telegram/bot')
        .set('Authorization', `Bearer ${signToken({ userId: s.userId, amr })}`);
      for (const amr of [['pwd'], ['pwd', 'tg'], ['tg']]) {
        const res = await bot(amr);
        expect(res.status, amr.join('+')).toBe(403);
        expect(res.body.code).toBe('TWO_FACTOR_REQUIRED');
      }
      expect((await bot(['pwd', 'otp'])).status).toBe(200);
    });

    it('staff have no Telegram account routes', async () => {
      const s = await staff();
      const auth = `Bearer ${signToken({ userId: s.userId, amr: ['pwd', 'otp'] })}`;
      expect((await request(app).get('/api/admin/account/telegram').set('Authorization', auth)).status).toBe(404);
      expect((await request(app).post('/api/admin/account/telegram/relink').set('Authorization', auth).send({})).status).toBe(404);
    });
  });

  // ── No bot ─────────────────────────────────────────────────────────────
  describe('with no bot configured', () => {
    it('staff still owe their authenticator code (there is no bootstrap); merchants and players are told Telegram is unavailable', async () => {
      await removeTestBot();
      try {
        const s = await staff();
        const res = await post('/api/admin/login', { mobile: s.mobile, password: STAFF_PASSWORD });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ success: false, twoFactorRequired: true, totpSetupRequired: true });
        expect(res.body.token).toBeFalsy();
        expect(res.body.bootstrap).toBeUndefined();

        for (const door of ['MERCHANT', 'PLAYER']) {
          const refused = await post(`${DOOR[door]}/login/telegram`, { delivery: 'MATCH' });
          expect(refused.status, door).toBe(503);
          expect(refused.body.code, door).toBe('TELEGRAM_UNAVAILABLE');
          expect(refused.body.challengeToken).toBeUndefined();
        }
        for (const panel of ['PLAYER', 'MERCHANT']) {
          expect((await request(app).get(`/api/telegram/mini-app?panel=${panel}`)).body.available, panel).toBe(false);
        }
      } finally { await saveTestBot(); }
    });
  });
});
