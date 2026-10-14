// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Continue with Telegram" end to end, at the HTTP boundary, on a real
 * PostgreSQL (owner, 2026-10-13): the Verify screen, the number match, the
 * one-time handoff ticket, and signup by the first contact share.
 *
 * Nothing here reaches Telegram: the Mini App's strings are signed with the
 * test bot's token (miniAppFixture.js), which the server holds as its one bot.
 *
 * Each case uses its own Telegram account and its own address: the Telegram
 * limiters key on the address.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { newUserId, createUser, getUserByMobile } from '#db/repositories/users.js';
import { verifyJwt } from '../../domains/identity/jwt.util.js';
import { ticketHash } from '../../domains/identity/telegramChallenge.service.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId,
  STANDBY_BOT, STANDBY_BOT_TOKEN,
} from '../miniAppFixture.js';
import { invalidateBotCache } from '../../domains/telegram/telegramClient.js';

const describePg = pgConfigured() ? describe : describe.skip;
const SITE = 'https://bb.example';

let addr = 0;
const from = () => { addr += 1; return `10.${120 + ((addr >> 16) & 7)}.${(addr >> 8) & 255}.${addr & 255}`; };
let n = 0;
const freshMobile = (lead = '9') => `${lead}${String(Date.now()).slice(-5)}${String(n += 1).padStart(4, '0')}`;

describePg('Continue with Telegram (PostgreSQL)', () => {
  let app;
  const before = process.env.PUBLIC_APP_ORIGIN;

  beforeAll(async () => {
    process.env.PUBLIC_APP_ORIGIN = SITE;
    await applySchema();
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/auth', (await import('../../domains/identity/playerAuth.routes.js')).default);
    app.use('/api/telegram', (await import('../../domains/telegram/miniApp.routes.js')).default);
    await saveTestBot();
  }, 60_000);

  afterAll(async () => {
    if (before === undefined) delete process.env.PUBLIC_APP_ORIGIN; else process.env.PUBLIC_APP_ORIGIN = before;
    await removeTestBot();
    await closePg();
  });

  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  const post = (path, body, ip = from()) => request(app).post(path).set('X-Forwarded-For', ip)
    .set('User-Agent', ANDROID).set('CF-IPCity', 'Forged').send(body);
  const startParam = (telegram) => new URL(telegram.url).searchParams.get('startapp');
  const open = (body = {}) => post('/api/v1/auth/login/telegram', body);
  const complete = (challengeToken) => post('/api/v1/auth/login/telegram/complete', { challengeToken });
  const redeem = (ticket) => post('/api/v1/auth/login/telegram/ticket', { ticket });
  const context = (initData) => post('/api/telegram/mini-app/context', { initData });
  const ticketOf = (url) => new URL(url).hash.replace(/^#\/tg\//, '');

  /** The Mini App page answering the sign-in it was opened on. */
  const approve = (opened, tgId, { decision = 'approve', pick, phone = null, initData } = {}) => post('/api/telegram/mini-app/approve', {
    initData: initData ?? signInitData({ telegramUserId: tgId, startParam: startParam(opened.telegram) }),
    contact: phone ? signContact({ telegramUserId: tgId, phone }) : undefined,
    decision, pick,
  });

  const player = async () => {
    const mobile = freshMobile('9');
    const userId = newUserId();
    await createUser({ userId, username: 'p', mobile, accountType: 'PLAYER', referralCode: `CT${n}${Date.now() % 100000}` });
    const tgId = await linkTelegram(userId);
    return { userId, mobile, tgId };
  };

  const wrongOf = (choices, right) => choices.find((c) => c !== right);

  // ── MATCH: the browser that asked shows the number ─────────────────────
  describe('number match', () => {
    it('the Verify screen offers three numbers, never says which, and the right pick signs the asking browser in', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'MATCH' })).body;
      expect(opened).toMatchObject({ pending: true, delivery: 'MATCH' });
      expect(opened.matchNumber).toBeGreaterThanOrEqual(10);
      expect(opened.matchNumber).toBeLessThanOrEqual(99);

      const initData = signInitData({ telegramUserId: p.tgId, startParam: startParam(opened.telegram) });
      const ctx = (await context(initData)).body;
      expect(ctx.start).toMatchObject({
        kind: 'TELEGRAM_LOGIN', delivery: 'MATCH', destination: 'bb.example',
        account: { panel: 'PLAYER', isNew: false, mobileHint: `••••••${p.mobile.slice(-4)}` },
      });
      expect(ctx.start.choices).toHaveLength(3);
      expect(ctx.start.choices).toContain(opened.matchNumber);
      expect(JSON.stringify(ctx)).not.toMatch(/matchNumber/);
      expect(ctx.start.request).toMatchObject({ city: '', device: 'Chrome on Android' });

      expect((await complete(opened.challengeToken)).status).toBe(202);
      const ok = await approve(opened, p.tgId, { pick: opened.matchNumber, initData });
      expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ success: true, approved: true, redirectUrl: null });

      const session = await complete(opened.challengeToken);
      expect(session.status, JSON.stringify(session.body)).toBe(200);
      expect(verifyJwt(session.body.token)).toMatchObject({ userId: p.userId, amr: ['tg'] });
      // Spent once.
      expect((await complete(opened.challengeToken)).status).toBe(401);
    });

    it('a wrong pick costs one try and spends nothing; the third refuses the sign-in', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'MATCH' })).body;
      const initData = signInitData({ telegramUserId: p.tgId, startParam: startParam(opened.telegram) });
      const { choices } = (await context(initData)).body.start;
      const wrong = wrongOf(choices, opened.matchNumber);

      const first = await approve(opened, p.tgId, { pick: wrong, initData });
      expect(first.status).toBe(400);
      expect(first.body.code).toBe('WRONG_NUMBER');
      expect(first.body.message).toMatch(/2 tries left/);
      // The same page may pick again: its initData was not spent by a wrong pick.
      expect((await context(initData)).body.start.strikesLeft).toBe(2);
      expect((await approve(opened, p.tgId, { pick: wrong, initData })).body.code).toBe('WRONG_NUMBER');
      const third = await approve(opened, p.tgId, { pick: wrong, initData });
      expect(third.status).toBe(403);
      expect(third.body.code).toBe('TOO_MANY_WRONG');

      // Refused for good: the right number now changes nothing, and the poll is told.
      expect((await approve(opened, p.tgId, { pick: opened.matchNumber, initData })).body.success).toBe(false);
      expect((await complete(opened.challengeToken)).body.code).toBe('TWO_FACTOR_DENIED');
      const { rows } = await pgQuery(`SELECT status, match_strikes, telegram_user_id FROM telegram_challenges WHERE challenge_id = $1`,
        [startParam(opened.telegram)]);
      expect(rows[0]).toMatchObject({ status: 'DENIED', match_strikes: 3, telegram_user_id: p.tgId });
    });

    it('an approval with no pick is a wrong pick: refused, and it costs a try', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'MATCH' })).body;
      const res = await approve(opened, p.tgId, {});
      expect(res.body.code).toBe('WRONG_NUMBER');
      const { rows } = await pgQuery(`SELECT status, match_strikes FROM telegram_challenges WHERE challenge_id = $1`, [startParam(opened.telegram)]);
      expect(rows[0]).toMatchObject({ status: 'PENDING', match_strikes: 1 });
    });

    it('Deny refuses it, with no number and no contact', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'MATCH' })).body;
      const res = await approve(opened, p.tgId, { decision: 'deny' });
      expect(res.body).toMatchObject({ success: true, approved: false });
      expect((await complete(opened.challengeToken)).body.code).toBe('TWO_FACTOR_DENIED');
    });
  });

  // ── HANDOFF: the session lands where Verify was pressed ────────────────
  describe('handoff ticket', () => {
    // After a blocked domain is retired, an APK or installed web app still at
    // the old address would never be the one Verify opens: it gets a MATCH,
    // and the number reaches it wherever it runs (deliveryFor).
    it('a HANDOFF asked from any address but the site\'s own is opened as a MATCH, and the MATCH signs that app in', async () => {
      const p = await player();
      for (const returnOrigin of [undefined, 'https://retired.example', 'https://localhost', `${SITE}.evil.example`]) {
        const opened = (await open({ delivery: 'HANDOFF', ...(returnOrigin ? { returnOrigin } : {}) })).body;
        expect(opened.delivery).toBe('MATCH');
        expect(opened.matchNumber).toEqual(expect.any(Number));
      }
      const opened = (await open({ delivery: 'HANDOFF', returnOrigin: 'https://retired.example' })).body;
      const ok = await approve(opened, p.tgId, { pick: opened.matchNumber });
      expect(ok.body).toMatchObject({ approved: true, redirectUrl: null });
      const done = await post('/api/v1/auth/login/telegram/complete', { challengeToken: opened.challengeToken });
      expect(done.status).toBe(200);
      expect(done.body.token).toEqual(expect.any(String));
    });

    it('Verify answers the site with a ticket; the asking browser can never spend it; the ticket signs in once', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'HANDOFF', returnOrigin: SITE })).body;
      expect(opened).toMatchObject({ delivery: 'HANDOFF', matchNumber: null });

      const initData = signInitData({ telegramUserId: p.tgId, startParam: startParam(opened.telegram) });
      expect((await context(initData)).body.start).toMatchObject({ delivery: 'HANDOFF', choices: null, destination: 'bb.example' });
      const ok = await approve(opened, p.tgId, { initData });
      expect(ok.body.redirectUrl).toMatch(/^https:\/\/bb\.example\/#\/tg\/[A-Za-z0-9_-]{43}$/);
      const ticket = ticketOf(ok.body.redirectUrl);

      // Only the hash is at rest.
      const { rows } = await pgQuery(`SELECT ticket_hash FROM telegram_handoff_tickets WHERE challenge_id = $1`, [startParam(opened.telegram)]);
      expect(rows[0].ticket_hash).toBe(ticketHash(ticket));
      expect(JSON.stringify(rows)).not.toContain(ticket);

      // The browser that asked is told it went elsewhere, and gets no session:
      // not from the route, and not from the repository's own redeem either.
      expect((await db.telegram.redeemChallenge({
        challengeId: startParam(opened.telegram), audience: 'PLAYER', purposes: ['TELEGRAM_LOGIN'],
      })).ok).toBe(false);
      const polled = await complete(opened.challengeToken);
      expect(polled.body).toMatchObject({ handedOff: true });
      expect(polled.body.token).toBeUndefined();

      const session = await redeem(ticket);
      expect(session.status, JSON.stringify(session.body)).toBe(200);
      expect(verifyJwt(session.body.token)).toMatchObject({ userId: p.userId, amr: ['tg'] });
      expect((await redeem(ticket)).body.code).toBe('TICKET_INVALID');
      // Still "handed off" to the asking browser once spent.
      expect((await complete(opened.challengeToken)).body.handedOff).toBe(true);
    });

    it('ten tabs presenting one ticket at once get one session', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'HANDOFF', returnOrigin: SITE })).body;
      const ticket = ticketOf((await approve(opened, p.tgId)).body.redirectUrl);
      const answers = await Promise.all(Array.from({ length: 10 }, () => redeem(ticket)));
      expect(answers.filter((r) => r.status === 200)).toHaveLength(1);
      expect(answers.filter((r) => r.body.code === 'TICKET_INVALID')).toHaveLength(9);
    });

    it('an expired ticket, a made-up ticket and a ticket of a refused challenge sign nobody in', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'HANDOFF', returnOrigin: SITE })).body;
      const ticket = ticketOf((await approve(opened, p.tgId)).body.redirectUrl);
      await pgQuery(`UPDATE telegram_handoff_tickets SET expires_at = now() - interval '1 second' WHERE ticket_hash = $1`, [ticketHash(ticket)]);
      expect((await redeem(ticket)).body.code).toBe('TICKET_INVALID');
      expect((await redeem('A'.repeat(43))).body.code).toBe('TICKET_INVALID');
      expect((await redeem('')).body.code).toBe('TICKET_INVALID');

      // A live ticket whose challenge is no longer APPROVED (wrong challenge state) is refused.
      const again = (await open({ delivery: 'HANDOFF', returnOrigin: SITE })).body;
      const t2 = ticketOf((await approve(again, p.tgId)).body.redirectUrl);
      await pgQuery(`UPDATE telegram_challenges SET status = 'DENIED' WHERE challenge_id = $1`, [startParam(again.telegram)]);
      expect((await redeem(t2)).body.code).toBe('TICKET_INVALID');
    });

    it('no website address configured: Verify says so instead of sending the person nowhere', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'HANDOFF', returnOrigin: SITE })).body;
      delete process.env.PUBLIC_APP_ORIGIN;
      try {
        const res = await approve(opened, p.tgId);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('SITE_ADDRESS_UNSET');
      } finally { process.env.PUBLIC_APP_ORIGIN = SITE; }
      const { rows } = await pgQuery(`SELECT status FROM telegram_challenges WHERE challenge_id = $1`, [startParam(opened.telegram)]);
      expect(rows[0].status).toBe('PENDING');
    });
  });

  // ── Signup is the same action ──────────────────────────────────────────
  describe('signup by the first contact share', () => {
    it('a Telegram account with no player account shares its contact once: the account, link and referral commit with the approval, with no password', async () => {
      const referrer = await player();
      const code = (await db.users.getUser(referrer.userId)).referralCode;
      const opened = (await open({ delivery: 'HANDOFF', returnOrigin: SITE, referralCode: code })).body;
      const tgId = freshTelegramUserId();
      const mobile = freshMobile('9');

      const initData = signInitData({ telegramUserId: tgId, startParam: startParam(opened.telegram) });
      const ctx = (await context(initData)).body.start;
      expect(ctx.account).toMatchObject({ isNew: true });
      expect(ctx.needsContact).toBe(true);
      expect(ctx.referral).toMatchObject({ code, unknown: false });

      // No contact: refused, nothing written.
      expect((await approve(opened, tgId, { initData })).body.code).toBe('CONTACT_REQUIRED');
      expect(await getUserByMobile(mobile, 'PLAYER')).toBeNull();

      const ok = await approve(opened, tgId, { initData, phone: `+91${mobile}` });
      expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ success: true, approved: true, created: true });
      const joiner = await getUserByMobile(mobile, 'PLAYER');
      expect(joiner.joiningNumber).toBeTruthy();
      expect((await db.users.getUserCredentials(joiner.userId)).passwordHash).toBeNull();
      expect((await db.telegram.getLinkByUserId(joiner.userId)).telegramUserId).toBe(tgId);
      const { rows } = await pgQuery(`SELECT earner_id FROM referral_earnings WHERE source_user_id = $1 AND level = 1`, [joiner.userId]);
      expect(rows.map((r) => r.earner_id)).toEqual([referrer.userId]);

      const session = await redeem(ticketOf(ok.body.redirectUrl));
      expect(verifyJwt(session.body.token).userId).toBe(joiner.userId);
    });

    it('a contact on a number that already has a player account links that account instead of making another', async () => {
      const mobile = freshMobile('9');
      const userId = newUserId();
      await createUser({ userId, username: 'unlinked', mobile, accountType: 'PLAYER', referralCode: `UL${n}${Date.now() % 100000}` });
      const opened = (await open({ delivery: 'MATCH' })).body;
      const tgId = freshTelegramUserId();
      const ok = await approve(opened, tgId, { pick: opened.matchNumber, phone: mobile });
      expect(ok.body).toMatchObject({ approved: true, created: false, verified: true });
      expect(verifyJwt((await complete(opened.challengeToken)).body.token).userId).toBe(userId);
    });

    it('the replayed initData of a used Verify is refused', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'MATCH' })).body;
      const initData = signInitData({ telegramUserId: p.tgId, startParam: startParam(opened.telegram) });
      expect((await approve(opened, p.tgId, { initData, pick: opened.matchNumber })).body.approved).toBe(true);
      expect((await approve(opened, p.tgId, { initData, pick: opened.matchNumber })).body.code).toBe('INIT_DATA_REPLAYED');
    });

    it('an initData older than its five minutes is refused before anything is read', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'MATCH' })).body;
      const stale = signInitData({ telegramUserId: p.tgId, startParam: startParam(opened.telegram), authDate: Math.floor(Date.now() / 1000) - 3600 });
      expect((await context(stale)).body.code).toBe('INIT_DATA_STALE');
      expect((await approve(opened, p.tgId, { initData: stale, pick: opened.matchNumber })).body.code).toBe('INIT_DATA_STALE');
    });
  });

  // ── Opened from the bot itself ─────────────────────────────────────────
  describe('opened from the bot itself', () => {
    it('Verify creates the sign-in, answers a ticket, and the ticket signs the player in on this device', async () => {
      const p = await player();
      const initData = signInitData({ telegramUserId: p.tgId });
      const ctx = (await context(initData)).body.start;
      expect(ctx).toMatchObject({ kind: 'CONTINUE', destination: 'bb.example', needsContact: false, account: { isNew: false } });

      const res = await post('/api/telegram/mini-app/continue', { initData });
      expect(res.body, JSON.stringify(res.body)).toMatchObject({ success: true, created: false });
      const session = await redeem(ticketOf(res.body.redirectUrl));
      expect(verifyJwt(session.body.token).userId).toBe(p.userId);
    });

    it('a referral link (ref-<CODE>) signs a new player up with that referrer', async () => {
      const referrer = await player();
      const code = (await db.users.getUser(referrer.userId)).referralCode;
      const tgId = freshTelegramUserId();
      const mobile = freshMobile('9');
      const initData = signInitData({ telegramUserId: tgId, startParam: `ref-${code}` });
      expect((await context(initData)).body.start).toMatchObject({ kind: 'CONTINUE', needsContact: true, referral: { code } });
      const res = await post('/api/telegram/mini-app/continue', { initData, contact: signContact({ telegramUserId: tgId, phone: mobile }) });
      expect(res.body, JSON.stringify(res.body)).toMatchObject({ success: true, created: true });
      const joiner = await getUserByMobile(mobile, 'PLAYER');
      expect(joiner.referredBy).toBe(referrer.userId);
    });

    it('somebody else\'s contact is refused and creates nothing', async () => {
      const tgId = freshTelegramUserId();
      const mobile = freshMobile('9');
      const res = await post('/api/telegram/mini-app/continue', {
        initData: signInitData({ telegramUserId: tgId }),
        contact: signContact({ telegramUserId: freshTelegramUserId(), phone: mobile }),
      });
      expect(res.body.code).toBe('CONTACT_NOT_OWN');
      expect(await getUserByMobile(mobile, 'PLAYER')).toBeNull();
    });
  });

  // ── Standby bots (owner, 2026-10-14) ────────────────────────────────────
  describe('a standby bot', () => {
    const suspendPrimary = async (on) => {
      await db.telegram.setBotSuspended({ slot: 1, reason: on ? 'test: refused' : null });
      invalidateBotCache();
    };

    it('opens the same account, and takes every new sign-in once the primary is suspended', async () => {
      await saveTestBot({ slot: 2, bot: STANDBY_BOT, token: STANDBY_BOT_TOKEN });
      try {
        const p = await player();
        // A Mini App opened from the standby is proved by the standby's token: same person, same account.
        const initData = signInitData({ telegramUserId: p.tgId, token: STANDBY_BOT_TOKEN });
        const res = await post('/api/telegram/mini-app/continue', { initData });
        expect(res.body, JSON.stringify(res.body)).toMatchObject({ success: true, created: false });
        expect(verifyJwt((await redeem(ticketOf(res.body.redirectUrl))).body.token).userId).toBe(p.userId);

        // New links name the primary while it works, the standby once it is suspended.
        expect((await open({ delivery: 'MATCH' })).body.telegram.url).toContain('/bb_test_miniapp_bot');
        await suspendPrimary(true);
        const opened = (await open({ delivery: 'MATCH' })).body;
        expect(opened.telegram.url).toContain(`/${STANDBY_BOT.username}`);
        // A Mini App from the suspended primary, opened on an older link, is still ours and still proved.
        const old = signInitData({ telegramUserId: p.tgId });
        expect((await context(old)).body.success).toBe(true);
      } finally {
        await suspendPrimary(false);
        await db.telegram.removeBot(2);
        invalidateBotCache();
      }
    });

    it('a contact must be signed by the bot whose Mini App sent it', async () => {
      await saveTestBot({ slot: 2, bot: STANDBY_BOT, token: STANDBY_BOT_TOKEN });
      try {
        const tgId = freshTelegramUserId();
        const mobile = freshMobile('9');
        const res = await post('/api/telegram/mini-app/continue', {
          initData: signInitData({ telegramUserId: tgId, token: STANDBY_BOT_TOKEN }),
          contact: signContact({ telegramUserId: tgId, phone: mobile }),
        });
        expect(res.body.success).toBe(false);
        expect(await getUserByMobile(mobile, 'PLAYER')).toBeNull();
      } finally {
        await db.telegram.removeBot(2);
        invalidateBotCache();
      }
    });

    it('a string signed by no saved bot is refused', async () => {
      const res = await context(signInitData({ telegramUserId: freshTelegramUserId(), token: '7000000009:not-ours-at-all_0123456789abcdef' }));
      expect(res.body.success).toBe(false);
    });
  });

  describe('who asked, on the Verify screen', () => {
    it('names the city only from the header the operator declared', async () => {
      const prior = process.env.GEO_CITY_HEADER;
      process.env.GEO_CITY_HEADER = 'X-Edge-City';
      try {
        const p = await player();
        const opened = (await request(app).post('/api/v1/auth/login/telegram').set('X-Forwarded-For', '203.0.113.44')
          .set('X-Edge-City', 'Mumbai').set('CF-IPCity', 'Forged').send({ delivery: 'MATCH' })).body;
        const ctx = (await context(signInitData({ telegramUserId: p.tgId, startParam: startParam(opened.telegram) }))).body;
        expect(ctx.start.request).toMatchObject({ ip: '203.0.113.44', city: 'Mumbai' });
        expect(ctx.start.request.at).toBeTruthy();
      } finally {
        if (prior === undefined) delete process.env.GEO_CITY_HEADER; else process.env.GEO_CITY_HEADER = prior;
      }
    });
  });

  // ── What the database holds to, for every writer ───────────────────────
  describe('what the database holds to', () => {
    it("a player's ticket opens nothing at the merchant door, and is gone once tried there", async () => {
      const p = await player();
      const opened = (await open({ delivery: 'HANDOFF', returnOrigin: SITE })).body;
      const ok = await approve(opened, p.tgId);
      const hash = ticketHash(ticketOf(ok.body.redirectUrl));
      expect((await db.telegram.redeemTicket({ ticketHash: hash, audience: 'MERCHANT' })).ok).toBe(false);
      expect((await db.telegram.redeemTicket({ ticketHash: hash, audience: 'PLAYER' })).ok).toBe(false);
    });

    it('a database from before Telegram-only sign-in converges when the schema is applied twice', async () => {
      const p = await player();
      const opened = (await open({ delivery: 'HANDOFF', returnOrigin: SITE })).body;
      const challengeId = startParam(opened.telegram);
      // What that database held: a player password, the merchant approval
      // switch, challenge purposes (one a password reset), the reset table.
      await pgQuery('ALTER TABLE users DROP CONSTRAINT users_password_staff_only');
      try {
        await pgQuery(`UPDATE users SET password_hash = 'argon2id$old' WHERE user_id = $1`, [p.userId]);
        await pgQuery('ALTER TABLE telegram_links ADD COLUMN IF NOT EXISTS two_factor BOOLEAN NOT NULL DEFAULT false');
        await pgQuery(`ALTER TABLE telegram_challenges ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'TELEGRAM_LOGIN'`);
        await pgQuery(`UPDATE telegram_challenges SET purpose = 'VERIFY' WHERE challenge_id = $1`, [challengeId]);
        await pgQuery('CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY)');
      } finally {
        await applySchema();
        await applySchema();
      }
      expect((await db.users.getUserCredentials(p.userId)).passwordHash).toBeNull();
      expect(await db.telegram.getChallenge(challengeId)).toBeNull();
      const { rows } = await pgQuery(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE (table_name = 'telegram_links' AND column_name = 'two_factor')
             OR (table_name = 'telegram_challenges' AND column_name = 'purpose')
             OR table_name = 'password_resets'`);
      expect(rows).toEqual([]);
      const check = await pgQuery(`SELECT 1 FROM pg_constraint WHERE conname = 'users_password_staff_only'`);
      expect(check.rowCount).toBe(1);
    });

    it('only a staff account may hold a password (users_password_staff_only)', async () => {
      const ids = [];
      try {
        for (const accountType of ['PLAYER', 'MERCHANT']) {
          const userId = newUserId(); ids.push(userId);
          await expect(createUser({
            userId, username: userId, mobile: freshMobile('8'), accountType, passwordHash: 'argon2id$x',
          })).rejects.toThrow(/users_password_staff_only/);
        }
        const staffId = newUserId(); ids.push(staffId);
        await createUser({ userId: staffId, username: staffId, mobile: freshMobile('8'), accountType: 'STAFF', passwordHash: 'argon2id$x' });
        expect((await db.users.getUserCredentials(staffId)).passwordHash).toBe('argon2id$x');
      } finally {
        await pgQuery('DELETE FROM users WHERE user_id = ANY($1::text[])', [ids]);
      }
    });
  });
});
