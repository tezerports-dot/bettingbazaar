// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Player, staff and merchant are THREE accounts, and one mobile may hold all of
 * them — each reached only at its own door: staff by password and
 * authenticator code, player and merchant by "Continue with Telegram" (owner,
 * 2026-10-14: players and merchants have no password).
 *
 * ── The owner's requirement, 2026-09-24 ────────────────────────────────────
 * "Users, merchants and admin/sub-admin are three separate entities. If a user
 * opens an account on the user panel those credentials only work for the user
 * panel, not the merchant panel or the admin panel — and the same person can
 * create each account separately."
 *
 * ── Why this is a test and not a comment ──────────────────────────────────
 * Because it was already wrong twice while being built, in ways nothing else
 * would have caught:
 *
 *   · `users.mobile` was globally UNIQUE, so the second account was refused by
 *     an index whose message named neither panel;
 *   · merchant signup writes a `users` row too, and without a type of its own
 *     that row defaulted to PLAYER — so a merchant could have signed into the
 *     PLAYER panel. Merchants living in their own table made them look
 *     separate when the login row was not.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 * One person, one mobile, one Telegram account: Verify at the player door
 * enters the player account and at the merchant door the merchant account,
 * never the other; the staff door takes the staff password and nobody else's
 * attempt. Wrong-door attempts are answered IDENTICALLY within a door — a
 * refusal that distinguished "wrong password" from "no account here" would let
 * anybody map which of the three account types a phone number holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { linkTelegram, saveTestBot, removeTestBot, signInitData, freshTelegramUserId } from '../miniAppFixture.js';
import { getUserByMobile, newUserId, createUser, setRoles, ACCOUNT_TYPES } from '#db/repositories/users.js';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import playerAuthRoutes from '../../domains/identity/playerAuth.routes.js';
import merchantRoutes from '../../domains/merchant/merchant.routes.js';
import miniAppRoutes from '../../domains/telegram/miniApp.routes.js';
import { loginHandler, LOGIN_DOOR } from '../../routes.js';
import { loginPaceLimiter } from '../../middleware/security.js';
import { verifyJwt } from '../../domains/identity/jwt.util.js';
import { request } from './_harness.js';
import express from 'express';

const describePg = pgConfigured() ? describe : describe.skip;

/** One mobile, three accounts. Unique per RUN (§32 S19). */
const RUN = String(Math.floor(Math.random() * 90000) + 10000);
const MOBILE = `9${RUN}0007`;
// A mobile no door has an account for (same RUN, different tail).
const NOBODY = `9${RUN}0008`;
/** The staff account's password: the only password there is. */
const STAFF_PW = 'the-staff-passphrase-x';
/** The one Telegram account of the person who holds all three. */
const TG = freshTelegramUserId();

/**
 * The three doors, mounted as `server.js` mounts them.
 *
 * The STAFF door is `loginHandler` with `LOGIN_DOOR.STAFF`, which is exactly
 * what `app.post('/api/admin/login', …)` does — mounted here rather than
 * imported from server.js because importing server.js starts a server.
 */
const app = express();
app.use(express.json());
app.set('trust proxy', true);
app.use('/api/v1/auth', playerAuthRoutes);
app.post('/api/admin/login',
  (req, res, next) => { req.loginDoor = LOGIN_DOOR.STAFF; next(); }, loginHandler);
app.use('/api/merchant', merchantRoutes);
app.use('/api/telegram', miniAppRoutes);

/**
 * A fresh address per request, in a fresh /24.
 *
 * The limiters are real and mounted on these routes — that is the point of
 * putting them there — so without this the second login in the file is answered
 * by the pace limiter and every assertion after it measures a 429.
 */
let addr = 0;
const from = () => { addr += 1; return `10.${(addr >> 8) & 255}.${addr & 255}.9`; };
const post = (path, body) => request(app).post(path).set('X-Forwarded-For', from()).send(body);

/** The two Telegram doors' legs. */
const TG_DOOR = { PLAYER: '/api/v1/auth', MERCHANT: '/api/merchant/auth' };
const STAFF_LOGIN = '/api/admin/login';

describePg('three separate entities, one mobile', () => {
  const ids = {};
  const startParam = (opened) => new URL(opened.telegram.url).searchParams.get('startapp');
  /** Continue with Telegram at a door, Verify by the person's Telegram, and the poll. */
  const continueAt = async (door, tgId = TG) => {
    const opened = (await post(`${TG_DOOR[door]}/login/telegram`, { delivery: 'MATCH' })).body;
    const verified = await post('/api/telegram/mini-app/approve', {
      initData: signInitData({ telegramUserId: tgId, startParam: startParam(opened) }),
      decision: 'approve', pick: opened.matchNumber,
    });
    return { opened, verified, session: await post(`${TG_DOOR[door]}/login/telegram/complete`, { challengeToken: opened.challengeToken }) };
  };

  beforeAll(async () => {
    await applySchema();

    // The PLAYER, through the signup writer the first Verify calls.
    const { createAccountFromSignup } = await import('#db/repositories/identity.js');
    const player = await createAccountFromSignup({
      userId: newUserId(), username: 'the player', mobile: MOBILE, referralCode: `TRI${RUN}`,
    });
    expect(player.ok, 'the player account').toBe(true);

    // The STAFF account, the way `POST /admin/sub-admins` writes one.
    const staff = await createUser({
      userId: newUserId(), username: 'the staff', mobile: MOBILE,
      passwordHash: await hashPassword(STAFF_PW),
      status: 'ACTIVE', isAdmin: true, accountType: 'STAFF',
    });
    expect(staff.created, 'the staff account on the SAME mobile').toBe(true);
    await setRoles(staff.user.userId, ['admin']);
    ids.staff = staff.user.userId;

    // The MERCHANT, the writer an application goes through, approved.
    const merchant = await createMerchantAccount({
      userId: newUserId(), username: `merchant${RUN}`, mobile: MOBILE, currency: 'INR',
    });
    expect(merchant.ok, 'the merchant account on the SAME mobile').toBe(true);
    await pgQuery(
      `UPDATE merchants SET status='ACTIVE', merchant_approval_status='APPROVED'
        WHERE merchant_id = $1`, [merchant.merchant.merchantId]);
    Object.assign(ids, { player: player.userId, merchant: merchant.userId, merchantId: merchant.merchant.merchantId });

    // One Telegram account verifies both: one link per panel (owner,
    // 2026-10-13). Staff have no Telegram at all.
    for (const id of [player.userId, merchant.userId]) await linkTelegram(id, { telegramUserId: TG });
    await saveTestBot();
  });
  afterAll(async () => { await removeTestBot(); await closePg(); });

  it('writes THREE rows on one mobile, one per type', async () => {
    const { rows } = await pgQuery(
      'SELECT account_type FROM users WHERE mobile = $1 ORDER BY account_type', [MOBILE]);
    expect(rows.map((r) => r.account_type)).toEqual(['MERCHANT', 'PLAYER', 'STAFF']);
  });

  it('the repository and the SCHEMA name the same three types', async () => {
    // §32 S12, on an enum. The CHECK is what the database enforces and
    // ACCOUNT_TYPES is what every caller is validated against; a value in one
    // and not the other is either a type nobody can write or a write nobody
    // validates. Read from the constraint rather than restated here, so this
    // fails when the two drift rather than when somebody forgets to update it.
    const { rows } = await pgQuery(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'users_account_type_check'`);
    for (const type of ACCOUNT_TYPES) expect(rows[0].def).toContain(`'${type}'`);
    expect((rows[0].def.match(/'/g) || []).length / 2).toBe(ACCOUNT_TYPES.length);
  });

  it('gives each door its OWN account', async () => {
    // Read through the repository the doors read through, so a lookup that
    // stopped scoping by type fails here rather than at a login six months on.
    expect((await getUserByMobile(MOBILE, 'PLAYER')).username).toBe('the player');
    expect((await getUserByMobile(MOBILE, 'STAFF')).username).toBe('the staff');
    expect((await getUserByMobile(MOBILE, 'MERCHANT')).accountType).toBe('MERCHANT');
  });

  it('REFUSES a lookup that does not say which population it means', async () => {
    // The argument is required, with no default. A default of 'PLAYER' would
    // have made every un-updated caller silently correct for players and
    // silently wrong for staff — failing only on the accounts that move money.
    await expect(getUserByMobile(MOBILE)).rejects.toThrow(/accountType/);
  });

  it('holds a password on the staff row only', async () => {
    const { rows } = await pgQuery(
      'SELECT account_type, password_hash IS NOT NULL AS has_pw FROM users WHERE mobile = $1 ORDER BY account_type', [MOBILE]);
    expect(rows).toEqual([
      { account_type: 'MERCHANT', has_pw: false },
      { account_type: 'PLAYER', has_pw: false },
      { account_type: 'STAFF', has_pw: true },
    ]);
  });

  it('admits each account at its OWN door, and nowhere else', async () => {
    // The player door, Verify by the person's Telegram: the PLAYER account.
    const atPlayer = await continueAt('PLAYER');
    expect(atPlayer.session.status, JSON.stringify(atPlayer.session.body)).toBe(200);
    expect(verifyJwt(atPlayer.session.body.token)).toMatchObject({ userId: ids.player, amr: ['tg'] });
    expect(atPlayer.session.body.user.id).toBe(ids.player);

    // The merchant door, the same Telegram: the MERCHANT account.
    const atMerchant = await continueAt('MERCHANT');
    expect(atMerchant.session.status, JSON.stringify(atMerchant.session.body)).toBe(200);
    expect(verifyJwt(atMerchant.session.body.token)).toMatchObject({ userId: ids.merchant, merchantId: ids.merchantId, amr: ['tg'] });

    // The staff door: the staff password opens the code step, for the staff row.
    await loginPaceLimiter.resetKey(`p:${MOBILE}`);
    const atStaff = await post(STAFF_LOGIN, { mobile: MOBILE, password: STAFF_PW });
    expect(atStaff.body, JSON.stringify(atStaff.body)).toMatchObject({ success: false, twoFactorRequired: true });
    expect(atStaff.body.telegram).toBeUndefined();

    // And no Telegram door has a staff account behind it: Telegram cannot
    // even be linked to one (the audience CHECK).
    await expect(linkTelegram(ids.staff)).rejects.toThrow();
  });

  it('answers every wrong-door attempt IDENTICALLY within a door', async () => {
    // The staff door: another account's guess, a second guess, and a mobile
    // with no account at this door at all. The merchant door once answered an
    // unknown mobile "No merchant account found for this mobile number" and a
    // wrong password "Invalid credentials", so one request told anybody
    // whether a number held an account (2g review, 2026-10-04).
    const said = [];
    for (const [mobile, password] of [[MOBILE, 'not-the-staff-password'], [MOBILE, 'the-player-passphrase'], [NOBODY, STAFF_PW]]) {
      // The pace (one try per mobile per 10 s) is not what this asks.
      await loginPaceLimiter.resetKey(`p:${mobile}`);
      const res = await post(STAFF_LOGIN, { mobile, password });
      said.push(`${res.status}:${res.body.message}`);
    }
    expect(new Set(said).size, `STAFF door said: ${said.join(' | ')}`).toBe(1);
    expect(said[0], 'STAFF door answered the limiter, not the login').toMatch(/^401:/);

    // The Telegram doors: a sign-in opened at the OTHER door, and a token
    // that is nobody's, are answered alike — the approval of one account is
    // never redeemed at another account's door.
    const other = { PLAYER: 'MERCHANT', MERCHANT: 'PLAYER' };
    for (const door of ['PLAYER', 'MERCHANT']) {
      const { opened } = await continueAt(other[door]);
      const tgSaid = [];
      for (const challengeToken of [opened.challengeToken, 'not-a-token']) {
        const res = await post(`${TG_DOOR[door]}/login/telegram/complete`, { challengeToken });
        tgSaid.push(`${res.status}:${res.body.code}:${res.body.message}`);
        expect(res.body.token).toBeUndefined();
      }
      expect(new Set(tgSaid).size, `${door} door said: ${tgSaid.join(' | ')}`).toBe(1);
      expect(tgSaid[0]).toMatch(/^401:TWO_FACTOR_EXPIRED:/);
    }
  });

  it('a Telegram account that verifies neither is not let into either', async () => {
    const stranger = freshTelegramUserId();
    for (const door of ['PLAYER', 'MERCHANT']) {
      const { verified, session } = await continueAt(door, stranger);
      expect(verified.body.code, door).toBe('CONTACT_REQUIRED');
      expect(session.status, door).toBe(202);
    }
  });

  it('keeps one account per type — a second of the same type is refused', async () => {
    // The uniqueness rule MOVED; it did not go away.
    const again = await createUser({
      userId: newUserId(), username: 'a second staff', mobile: MOBILE,
      passwordHash: await hashPassword('another-passphrase-x'), accountType: 'STAFF',
    });
    expect(again.created).toBe(false);
    expect(again.user.username).toBe('the staff');
  });
});
