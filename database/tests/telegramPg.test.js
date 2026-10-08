// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The one bot, the links it proves and the questions the Mini App answers
 * (Step 3, owner 2026-10-07), against a REAL PostgreSQL.
 *
 * The properties here are the database's: one bot row; a link whose phone IS
 * the account's mobile and whose panel IS the account's type; one account per
 * Telegram account per panel; a signed Mini App string acted on once; a
 * challenge redeemed by exactly one of N racing polls; and a refusal that rolls
 * back everything it touched, the claim of the proof included.
 *
 * Expiry is asserted on the READS: a sweep that is late must not make a
 * challenge or a reset usable.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createUser, getUser, newUserId } from '../repositories/users.js';
import {
  getBot, getBotSecrets, saveBot,
  getLinkByUserId, getLinkByTelegramId, listLinksForTelegramUser, listAlertRecipients,
  enablePlayerTwoFactor,
  createChallenge, getChallenge, redeemChallenge,
  answerChallenge, telegramSignIn, signUpVerifiedPlayer, resetPasswordByContact,
  consumePasswordReset, sweepExpired,
} from '../repositories/telegram.js';

const describePg = pgConfigured() ? describe : describe.skip;

let seq = 0;
/** A fresh signed-string stand-in: the hash is what the database claims. */
const proof = () => ({ hash: `h${Date.now()}_${seq += 1}`, expiresAt: new Date(Date.now() + 300_000) });
const tgUser = (id, over = {}) => ({ id, username: `u${id}`, firstName: `F${id}`, ...over });
const contactOf = (user, phone) => ({ ...proof(), userId: user.id, phone });

async function account({ mobile = '9876543210', accountType = 'PLAYER', referredBy = null, ...over } = {}) {
  const userId = newUserId();
  await createUser({
    userId, username: `acct${seq += 1}`, mobile, passwordHash: '$argon2id$fake',
    accountType, referredBy, referralCode: `RC${seq}`, ...over,
  });
  return userId;
}

async function challenge({ purpose = 'VERIFY', audience = 'PLAYER', userId = null, ttlSeconds = 300 } = {}) {
  return createChallenge({ challengeId: `c${newUserId()}${seq += 1}`, purpose, audience, userId, ttlSeconds });
}

async function verify(userId, user, phone, audience = 'PLAYER') {
  const ch = await challenge({ purpose: 'VERIFY', audience, userId });
  return answerChallenge({
    challengeId: ch.challengeId, decision: 'approve', telegramUser: user,
    initData: proof(), contact: contactOf(user, phone),
  });
}

const count = async (table, where = 'TRUE', params = []) =>
  (await pgQuery(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n;

describePg('Telegram, Step 3 (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE telegram_bot, telegram_links, telegram_challenges,
                            telegram_init_data_uses, password_resets, referral_earnings, users
                   RESTART IDENTITY CASCADE`);
  });

  describe('the one bot', () => {
    it('is absent until saved, and saving twice keeps one row', async () => {
      expect(await getBot()).toBeNull();
      await saveBot({ botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'c1', miniAppShortName: 'app' });
      await saveBot({ botId: '2', botUsername: 'bb2_bot', tokenEncrypted: 'c2' });
      expect(await count('telegram_bot')).toBe(1);
      // A token change keeps the short name it was not given.
      expect(await getBot()).toMatchObject({ botId: '2', botUsername: 'bb2_bot', miniAppShortName: 'app' });
    });

    it('never returns the token from the read a screen renders', async () => {
      await saveBot({ botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'cipher' });
      expect(JSON.stringify(await getBot())).not.toContain('cipher');
      expect((await getBotSecrets()).tokenEncrypted).toBe('cipher');
    });

    it('changes the short name alone only when a bot exists', async () => {
      expect(await saveBot({ miniAppShortName: 'x' })).toBeNull();
      await saveBot({ botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'c' });
      expect((await saveBot({ miniAppShortName: 'play' })).miniAppShortName).toBe('play');
    });

    it('refuses a second row and a short name Telegram would not accept', async () => {
      await expect(pgQuery(`INSERT INTO telegram_bot (id, bot_id, username, token_encrypted) VALUES (2,'x','y','z')`))
        .rejects.toThrow(/telegram_bot_one_row/);
      await expect(saveBot({ botId: '1', botUsername: 'b', tokenEncrypted: 'c', miniAppShortName: 'bad name!' }))
        .rejects.toThrow(/telegram_bot_short_name_shape/);
    });
  });

  describe('verification at signup', () => {
    it('links the account when the shared phone is its mobile, and books the joining number', async () => {
      const id = await account();
      const r = await verify(id, tgUser('111'), '9876543210');
      expect(r).toMatchObject({ ok: true, kind: 'VERIFY', approved: true, verified: true, userId: id });
      expect(await getLinkByUserId(id)).toMatchObject({ telegramUserId: '111', phone: '9876543210', twoFactor: false });
      expect((await getUser(id)).joiningNumber).toBeTruthy();
    });

    it('refuses a contact on another number and leaves no claim, so the person can retry', async () => {
      const id = await account();
      const ch = await challenge({ userId: id });
      const user = tgUser('111');
      const initData = proof();
      const r = await answerChallenge({
        challengeId: ch.challengeId, decision: 'approve', telegramUser: user,
        initData, contact: contactOf(user, '9000000000'),
      });
      expect(r).toEqual({ ok: false, code: 'CONTACT_MISMATCH' });
      expect(await getLinkByUserId(id)).toBeNull();
      expect(await count('telegram_init_data_uses')).toBe(0);
      expect((await getChallenge(ch.challengeId)).status).toBe('PENDING');
      // The same initData, now with the right contact, goes through.
      const ok = await answerChallenge({
        challengeId: ch.challengeId, decision: 'approve', telegramUser: user,
        initData, contact: contactOf(user, '9876543210'),
      });
      expect(ok.ok).toBe(true);
    });

    it('refuses a contact that belongs to another Telegram account', async () => {
      const id = await account();
      const ch = await challenge({ userId: id });
      const r = await answerChallenge({
        challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('111'),
        initData: proof(), contact: contactOf(tgUser('222'), '9876543210'),
      });
      expect(r.code).toBe('CONTACT_NOT_OWN');
    });

    it('acts on a signed string once', async () => {
      const id = await account();
      const user = tgUser('111');
      const initData = proof();
      const ch = await challenge({ userId: id });
      await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: user, initData, contact: contactOf(user, '9876543210') });
      const ch2 = await challenge({ purpose: 'LOGIN', userId: id });
      const again = await answerChallenge({ challengeId: ch2.challengeId, decision: 'approve', telegramUser: user, initData });
      expect(again.code).toBe('INIT_DATA_REPLAYED');
    });

    it('needs a contact to verify, even from the right Telegram account', async () => {
      const id = await account();
      const ch = await challenge({ userId: id });
      const r = await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('111'), initData: proof() });
      expect(r.code).toBe('CONTACT_REQUIRED');
    });

    it('one Telegram account verifies one account per panel, and one per panel only', async () => {
      const player = await account({ mobile: '9876543210' });
      const merchant = await account({ mobile: '9876543210', accountType: 'MERCHANT' });
      const other = await account({ mobile: '9123456789' });
      const user = tgUser('111');
      expect((await verify(player, user, '9876543210')).ok).toBe(true);
      expect((await verify(merchant, user, '9876543210', 'MERCHANT')).ok).toBe(true);
      // The other player's number is not this Telegram account's, so it is
      // refused for that first; a forged phone match is the index's to refuse.
      expect((await verify(other, user, '9123456789')).code).toBe('TELEGRAM_ALREADY_LINKED');
      expect(await listLinksForTelegramUser('111')).toHaveLength(2);
      expect((await getLinkByUserId(merchant)).twoFactor).toBe(true);
    });

    it('the row refuses a phone that is not the mobile, a staff link without 2FA, and a link across panels', async () => {
      const id = await account();
      const staff = await account({ mobile: '9111111111', accountType: 'STAFF' });
      await expect(pgQuery(`INSERT INTO telegram_links (user_id, audience, telegram_user_id, phone) VALUES ($1,'PLAYER','9','9000000000')`, [id]))
        .rejects.toThrow(/telegram_link_phone_is_mobile|mobile/);
      await expect(pgQuery(`INSERT INTO telegram_links (user_id, audience, telegram_user_id, phone, two_factor) VALUES ($1,'STAFF','9','9111111111',FALSE)`, [staff]))
        .rejects.toThrow(/telegram_links_staff_two_factor/);
      await expect(pgQuery(`INSERT INTO telegram_links (user_id, audience, telegram_user_id, phone, two_factor) VALUES ($1,'MERCHANT','9','9876543210',TRUE)`, [id]))
        .rejects.toThrow(/telegram_links_account/);
    });

    it('books level-1 and level-2 referral earnings at verification, never at signup', async () => {
      const top = await account({ mobile: '9000000001' });
      const mid = await account({ mobile: '9000000002', referredBy: top });
      await verify(top, tgUser('1'), '9000000001');
      await verify(mid, tgUser('2'), '9000000002');
      const joiner = await account({ mobile: '9000000003', referredBy: mid });
      expect(await count('referral_earnings', 'source_user_id = $1', [joiner])).toBe(0);
      await verify(joiner, tgUser('3'), '9000000003');
      const { rows } = await pgQuery(`SELECT earner_id, level FROM referral_earnings WHERE source_user_id = $1 ORDER BY level`, [joiner]);
      expect(rows).toEqual([{ earner_id: mid, level: 1 }, { earner_id: top, level: 2 }]);
    });

    it('a relink from the same Telegram account books nothing twice', async () => {
      const top = await account({ mobile: '9000000001' });
      const joiner = await account({ mobile: '9000000003', referredBy: top });
      await verify(joiner, tgUser('3'), '9000000003');
      const number = (await getUser(joiner)).joiningNumber;
      const again = await verify(joiner, tgUser('3'), '9000000003');
      expect(again).toMatchObject({ ok: true, verified: false, relinked: false });
      expect((await getUser(joiner)).joiningNumber).toBe(number);
      expect(await count('referral_earnings', 'source_user_id = $1', [joiner])).toBe(1);
    });

    it('refuses a blocked or closed account', async () => {
      const id = await account();
      await pgQuery(`UPDATE users SET is_blocked = TRUE, block_reason = 'test', blocked_at = now() WHERE user_id = $1`, [id]);
      expect((await verify(id, tgUser('1'), '9876543210')).code).toBe('ACCOUNT_BLOCKED');
    });
  });

  describe('challenges', () => {
    it('ten racing polls redeem one approval once', async () => {
      const id = await account();
      const ch = await challenge({ userId: id });
      await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('1'), initData: proof(), contact: contactOf(tgUser('1'), '9876543210') });
      const polls = await Promise.all(Array.from({ length: 10 }, () =>
        redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER', purposes: ['VERIFY', 'LOGIN'] })));
      expect(polls.filter((p) => p.ok)).toHaveLength(1);
      expect(polls.filter((p) => !p.ok).every((p) => p.state === 'EXPIRED')).toBe(true);
    });

    it('a pending challenge says PENDING, a denied one DENIED, and neither redeems', async () => {
      const id = await account();
      const ch = await challenge({ purpose: 'LOGIN', userId: id });
      expect(await redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER', purposes: ['LOGIN'] }))
        .toEqual({ ok: false, state: 'PENDING' });
      await answerChallenge({ challengeId: ch.challengeId, decision: 'deny', telegramUser: tgUser('1'), initData: proof() });
      expect(await redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER', purposes: ['LOGIN'] }))
        .toEqual({ ok: false, state: 'DENIED' });
    });

    it('is redeemed only at its own door, for its own purposes and account', async () => {
      const id = await account();
      const other = await account({ mobile: '9123456789' });
      const ch = await challenge({ userId: id });
      await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('1'), initData: proof(), contact: contactOf(tgUser('1'), '9876543210') });
      expect((await redeemChallenge({ challengeId: ch.challengeId, audience: 'STAFF', purposes: ['VERIFY'] })).ok).toBe(false);
      expect((await redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER', purposes: ['TELEGRAM_LOGIN'] })).ok).toBe(false);
      expect((await redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER', purposes: ['VERIFY'], userId: other })).ok).toBe(false);
      expect((await redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER', purposes: ['VERIFY'], userId: id })).ok).toBe(true);
    });

    it('an expired challenge can be neither answered nor redeemed, before any sweep', async () => {
      const id = await account();
      const ch = await challenge({ userId: id });
      await pgQuery(`UPDATE telegram_challenges SET expires_at = now() - interval '1 second' WHERE challenge_id = $1`, [ch.challengeId]);
      const r = await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('1'), initData: proof(), contact: contactOf(tgUser('1'), '9876543210') });
      expect(r.code).toBe('CHALLENGE_EXPIRED');
      expect(await getLinkByUserId(id)).toBeNull();
    });

    it('an approval re-dates the challenge to the short redeem window', async () => {
      const id = await account();
      const ch = await challenge({ userId: id, ttlSeconds: 900 });
      await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('1'), initData: proof(), contact: contactOf(tgUser('1'), '9876543210'), redeemWindowSeconds: 60 });
      const { rows } = await pgQuery(`SELECT extract(epoch FROM expires_at - now())::int AS s FROM telegram_challenges WHERE challenge_id = $1`, [ch.challengeId]);
      expect(rows[0].s).toBeLessThanOrEqual(60);
    });

    it('a sign-in approval from the linked Telegram needs no contact; from a new one it needs a matching contact, which relinks', async () => {
      const id = await account();
      await verify(id, tgUser('1'), '9876543210');
      const ch = await challenge({ purpose: 'LOGIN', userId: id });
      expect((await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('1'), initData: proof() })).ok).toBe(true);

      const ch2 = await challenge({ purpose: 'LOGIN', userId: id });
      expect((await answerChallenge({ challengeId: ch2.challengeId, decision: 'approve', telegramUser: tgUser('2'), initData: proof() })).code)
        .toBe('CONTACT_REQUIRED');
      const moved = await answerChallenge({ challengeId: ch2.challengeId, decision: 'approve', telegramUser: tgUser('2'), initData: proof(), contact: contactOf(tgUser('2'), '9876543210') });
      expect(moved).toMatchObject({ ok: true, relinked: true });
      const link = await getLinkByUserId(id);
      expect(link.telegramUserId).toBe('2');
      expect(new Date(link.linkedAt).getTime()).toBeGreaterThanOrEqual(new Date(link.verifiedAt).getTime());
    });

    it('a player turns Telegram approval on directly, and off only through an approved challenge', async () => {
      const id = await account();
      await verify(id, tgUser('1'), '9876543210');
      expect((await enablePlayerTwoFactor(id)).twoFactor).toBe(true);
      const ch = await challenge({ purpose: 'TWO_FACTOR_OFF', userId: id });
      expect((await getLinkByUserId(id)).twoFactor).toBe(true);
      await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('1'), initData: proof() });
      expect((await getLinkByUserId(id)).twoFactor).toBe(false);
    });

    it('a merchant\'s Telegram approval cannot be switched off', async () => {
      const id = await account({ accountType: 'MERCHANT' });
      await verify(id, tgUser('1'), '9876543210', 'MERCHANT');
      expect(await enablePlayerTwoFactor(id)).toBeNull();
      await expect(pgQuery(`UPDATE telegram_links SET two_factor = FALSE WHERE user_id = $1`, [id]))
        .rejects.toThrow(/telegram_links_staff_two_factor/);
    });
  });

  describe('Login with Telegram', () => {
    it('inside the Mini App: finds the linked account of THIS panel only', async () => {
      const id = await account();
      await verify(id, tgUser('1'), '9876543210');
      expect(await telegramSignIn({ audience: 'PLAYER', telegramUser: tgUser('1'), initData: proof() }))
        .toEqual({ ok: true, userId: id });
      expect((await telegramSignIn({ audience: 'MERCHANT', telegramUser: tgUser('1'), initData: proof() })).code)
        .toBe('NO_LINKED_ACCOUNT');
    });

    it('for staff, writes an APPROVED challenge the password then spends, bound to that account', async () => {
      const staff = await account({ mobile: '9111111111', accountType: 'STAFF', isAdmin: true });
      await verify(staff, tgUser('7'), '9111111111', 'STAFF');
      const r = await telegramSignIn({ audience: 'STAFF', telegramUser: tgUser('7'), initData: proof(), challengeId: 'cstaff1' });
      expect(r.ok).toBe(true);
      const other = await account({ mobile: '9222222222', accountType: 'STAFF', isAdmin: true });
      expect((await redeemChallenge({ challengeId: 'cstaff1', audience: 'STAFF', purposes: ['TELEGRAM_LOGIN'], userId: other })).ok).toBe(false);
      expect((await redeemChallenge({ challengeId: 'cstaff1', audience: 'STAFF', purposes: ['TELEGRAM_LOGIN'], userId: staff })).ok).toBe(true);
    });

    it('outside Telegram: an unbound challenge is bound to the account the Mini App proves', async () => {
      const id = await account();
      await verify(id, tgUser('1'), '9876543210');
      const ch = await challenge({ purpose: 'TELEGRAM_LOGIN' });
      const r = await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('1'), initData: proof() });
      expect(r).toMatchObject({ ok: true, userId: id });
      expect(await redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER', purposes: ['TELEGRAM_LOGIN'] }))
        .toMatchObject({ ok: true, userId: id });
    });

    it('an unlinked Telegram account must share a contact, and a number with no account is refused', async () => {
      const ch = await challenge({ purpose: 'TELEGRAM_LOGIN' });
      expect((await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('9'), initData: proof() })).code)
        .toBe('CONTACT_REQUIRED');
      expect((await answerChallenge({ challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('9'), initData: proof(), contact: contactOf(tgUser('9'), '9000000009') })).code)
        .toBe('NO_ACCOUNT');
    });
  });

  describe('signup inside the Mini App', () => {
    it('creates the account already verified, its mobile taken from Telegram, with the referral booked', async () => {
      const ref = await account({ mobile: '9000000001' });
      await verify(ref, tgUser('1'), '9000000001');
      const user = tgUser('5');
      const r = await signUpVerifiedPlayer({
        userId: newUserId(), username: 'newp', passwordHash: '$argon2id$x', referralCode: 'NEWP0001',
        referredBy: ref, telegramUser: user, initData: proof(), contact: contactOf(user, '9555555555'),
      });
      expect(r.ok).toBe(true);
      expect(await getUser(r.userId)).toMatchObject({ mobile: '9555555555', referredBy: ref });
      expect(await getLinkByTelegramId('5', 'PLAYER')).toMatchObject({ userId: r.userId });
      expect(await count('referral_earnings', 'source_user_id = $1', [r.userId])).toBe(1);
    });

    it('a taken mobile is refused and nothing is left behind', async () => {
      await account({ mobile: '9555555555' });
      const user = tgUser('5');
      const r = await signUpVerifiedPlayer({
        userId: newUserId(), username: 'newp', passwordHash: '$argon2id$x', referralCode: 'NEWP0002',
        telegramUser: user, initData: proof(), contact: contactOf(user, '9555555555'),
      });
      expect(r.code).toBe('MOBILE_TAKEN');
      expect(await count('users')).toBe(1);
      expect(await count('telegram_init_data_uses')).toBe(0);
    });
  });

  describe('password reset by contact', () => {
    it('issues one live reset for the account of that mobile on that panel, verifying it on the way', async () => {
      const id = await account();
      const user = tgUser('1');
      const first = await resetPasswordByContact({ panel: 'PLAYER', telegramUser: user, initData: proof(), contact: contactOf(user, '9876543210'), tokenHash: 't1' });
      expect(first).toMatchObject({ ok: true, userId: id, verified: true });
      await resetPasswordByContact({ panel: 'PLAYER', telegramUser: user, initData: proof(), contact: contactOf(user, '9876543210'), tokenHash: 't2' });
      expect(await consumePasswordReset('t1')).toBeNull();
      expect(await consumePasswordReset('t2')).toMatchObject({ userId: id, telegramUserId: '1' });
      expect(await consumePasswordReset('t2')).toBeNull();
    });

    it('a panel with no account on that mobile is refused', async () => {
      await account();
      const user = tgUser('1');
      expect((await resetPasswordByContact({ panel: 'MERCHANT', telegramUser: user, initData: proof(), contact: contactOf(user, '9876543210'), tokenHash: 't3' })).code)
        .toBe('NO_ACCOUNT');
    });

    it('an expired reset is refused before any sweep', async () => {
      const id = await account();
      await pgQuery(`INSERT INTO password_resets (token_hash, user_id, telegram_user_id, expires_at) VALUES ('old', $1, '1', now() - interval '1 second')`, [id]);
      expect(await consumePasswordReset('old')).toBeNull();
      expect((await sweepExpired()).passwordResets).toBe(1);
    });
  });

  describe('security alerts', () => {
    it('go to linked staff who are not blocked, and to no player or merchant', async () => {
      const staff = await account({ mobile: '9111111111', accountType: 'STAFF', isAdmin: true });
      const blocked = await account({ mobile: '9222222222', accountType: 'STAFF', isAdmin: true });
      const player = await account({ mobile: '9333333333' });
      await verify(staff, tgUser('7'), '9111111111', 'STAFF');
      await verify(blocked, tgUser('8'), '9222222222', 'STAFF');
      await verify(player, tgUser('9'), '9333333333');
      await pgQuery(`UPDATE users SET is_blocked = TRUE, block_reason = 'test', blocked_at = now() WHERE user_id = $1`, [blocked]);
      expect(await listAlertRecipients()).toEqual(['7']);
    });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Signup: a FORM, and nothing else.
//
// `createAccountFromSignup` takes what a person typed — the mobile on their
// Telegram account and a password — and writes the account. There is no
// Aadhaar (KYC removed, owner 2026-10-02). No Telegram identity is created
// here, by design: the contact share proves the number AFTERWARDS, and an
// identity written at signup would be an unproven one that the gate would then
// have to distinguish from a proven one.
// ─────────────────────────────────────────────────────────────────────────────
import { createAccountFromSignup } from '../repositories/identity.js';
import { getUser, newUserId } from '../repositories/users.js';

const signup = (over = {}) => ({
  userId: newUserId(), mobile: '9990001111', username: 'newplayer',
  passwordHash: '$argon2id$fake', referralCode: 'MYCODE01', ...over,
});

describePg('signup (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE telegram_links, users RESTART IDENTITY CASCADE`);
  });

  it('writes an ACTIVE player account', async () => {
    const r = await createAccountFromSignup(signup());
    expect(r.ok).toBe(true);
    expect(await getUser(r.userId)).toMatchObject({ mobile: '9990001111', status: 'ACTIVE' });
  });

  it('creates NO Telegram link — that is the next step, and it is separate', async () => {
    const r = await createAccountFromSignup(signup());
    expect(await getLinkByUserId(r.userId)).toBeNull();
    const { rows } = await pgQuery('SELECT count(*)::int AS n FROM telegram_links');
    expect(rows[0].n).toBe(0);
  });

  it('claims NO joining number, so an unverified signup cannot jump the queue', async () => {
    // The number orders the referral payout queue and is claimed when the
    // Telegram step COMPLETES. Allocating it here would let a form submitted in
    // a loop consume positions ahead of people who actually verified — and pay
    // somebody 25 rupees for each one.
    const r = await createAccountFromSignup(signup());
    expect((await getUser(r.userId)).joiningNumber).toBeFalsy();
  });

  it('sets a password hash, because the form is now the door', async () => {
    const r = await createAccountFromSignup(signup());
    const { rows } = await pgQuery('SELECT password_hash FROM users WHERE user_id = $1', [r.userId]);
    expect(rows[0].password_hash).toBe('$argon2id$fake');
  });

  it('refuses to write an account with no password at all', async () => {
    // A row with a NULL hash would be an account nobody can sign into and
    // nothing would ever say so. Refused at the boundary rather than written.
    await expect(createAccountFromSignup(signup({ passwordHash: null })))
      .rejects.toThrow(/passwordHash/);
  });

  it('refuses a second account on one mobile, and leaves nothing behind', async () => {
    await createAccountFromSignup(signup());
    expect(await createAccountFromSignup(signup({ userId: newUserId(), referralCode: 'MYCODE03' })))
      .toEqual({ ok: false, reason: 'mobile_taken' });
    expect((await pgQuery(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(1);
  });

  it('10 concurrent submissions of one form produce ONE account', async () => {
    // Somebody double-tapping Sign Up on a slow connection. The unique index
    // decides, not a read the route did first.
    const attempts = Array.from({ length: 10 }, () =>
      createAccountFromSignup(signup({ userId: newUserId(), referralCode: null })));
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await pgQuery(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(1);
  });

  it('carries the referral attribution the form captured', async () => {
    const first = await createAccountFromSignup(signup());
    const second = await createAccountFromSignup(signup({
      userId: newUserId(), mobile: '9990002222', referralCode: 'MYCODE02', referredBy: first.userId,
    }));
    expect((await getUser(second.userId)).referredBy).toBe(first.userId);
  });

  it('gives each account an unpredictable id, not one derived from the phone', async () => {
    // Account ids travel in URLs and payloads. An id computable from a phone
    // number would let anyone holding the number address the account.
    const r = await createAccountFromSignup(signup());
    expect(r.userId).toMatch(/^[0-9a-f]{24}$/);
    expect(r.userId).not.toContain('9990001111');
    expect(newUserId()).not.toBe(newUserId());
  });
});
