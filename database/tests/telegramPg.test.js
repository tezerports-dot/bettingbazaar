// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The one bot, the links it proves and the "Continue with Telegram" sign-ins
 * the Mini App answers (owner, 2026-10-13/14), against a REAL PostgreSQL.
 *
 * The properties here are the database's: one bot row; a link whose phone IS
 * the account's mobile and whose panel IS the account's type; one account per
 * Telegram account per panel; a signed Mini App string acted on once; a
 * sign-in redeemed by exactly one of N racing polls, only at its own door; a
 * first Verify that links (or makes) the account and books the referral in
 * the same transaction; and a refusal that rolls back everything it touched,
 * the claim of the proof included.
 *
 * Expiry is asserted on the READS: a sweep that is late must not make a
 * challenge usable.
 */
import crypto from 'crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createUser, getUser, newUserId } from '../repositories/users.js';
import { getSystemConfig, setConfigPath } from '../repositories/config.js';
import {
  getBot, getBots, getBotSecrets, saveBot, removeBot, setBotSuspended,
  getLinkByUserId, getLinkByTelegramId, listLinksForTelegramUser,
  createChallenge, getChallenge, redeemChallenge, redeemTicket,
  answerChallenge, sweepExpired, DELIVERY,
} from '../repositories/telegram.js';

const describePg = pgConfigured() ? describe : describe.skip;

let seq = 0;
/** A fresh signed-string stand-in: the hash is what the database claims. */
const proof = () => ({ hash: `h${Date.now()}_${seq += 1}`, expiresAt: new Date(Date.now() + 300_000) });
const tgUser = (id, over = {}) => ({ id, username: `u${id}`, firstName: `F${id}`, ...over });
const contactOf = (user, phone) => ({ ...proof(), userId: user.id, phone });
/** The number the asking browser shows, and the three the Mini App offers. */
const MATCH = { number: 42, choices: [17, 42, 88] };
const ticketOf = () => {
  const ticket = crypto.randomBytes(32).toString('hex');
  return { ticket, hash: crypto.createHash('sha256').update(ticket).digest('hex'), ttlSeconds: 120 };
};

async function account({ mobile = '9876543210', accountType = 'PLAYER', referredBy = null, ...over } = {}) {
  const userId = newUserId();
  await createUser({
    userId, username: `acct${seq += 1}`, mobile,
    accountType, referredBy, referralCode: `RC${seq}`, ...over,
  });
  return userId;
}

async function challenge({ audience = 'PLAYER', ttlSeconds = 300, delivery = DELIVERY.MATCH } = {}) {
  return createChallenge({
    challengeId: `c${newUserId()}${seq += 1}`, audience, ttlSeconds,
    delivery, match: delivery === DELIVERY.MATCH ? MATCH : null,
  });
}

/** The Mini App's Verify on `ch`, with the right number unless told otherwise. */
const approve = (ch, user, { phone = null, initData = proof(), pick = MATCH.number, ...over } = {}) => answerChallenge({
  challengeId: ch.challengeId, decision: 'approve', telegramUser: user, initData,
  contact: phone ? contactOf(user, phone) : null, pick, ...over,
});

/** A first Verify on `audience` by `user`, sharing the contact `phone`. */
async function verify(user, phone, audience = 'PLAYER') {
  return approve(await challenge({ audience }), user, { phone });
}

const count = async (table, where = 'TRUE', params = []) =>
  (await pgQuery(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n;

describePg('Telegram, Continue with Telegram (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE telegram_bot, telegram_links, telegram_challenges, telegram_handoff_tickets,
                            telegram_init_data_uses, referral_earnings, users
                   RESTART IDENTITY CASCADE`);
  });

  describe('the bot and its standbys', () => {
    it('is absent until saved, and saving a slot twice keeps one row', async () => {
      expect(await getBot()).toBeNull();
      await saveBot({ botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'c1', miniAppShortName: 'app' });
      await saveBot({ botId: '2', botUsername: 'bb2_bot', tokenEncrypted: 'c2' });
      expect(await count('telegram_bot')).toBe(1);
      // A token change keeps the short name it was not given.
      expect(await getBot()).toMatchObject({ slot: 1, botId: '2', botUsername: 'bb2_bot', miniAppShortName: 'app' });
    });

    it('never returns the token from the read a screen renders', async () => {
      await saveBot({ botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'cipher' });
      expect(JSON.stringify(await getBot())).not.toContain('cipher');
      expect(JSON.stringify(await getBots())).not.toContain('cipher');
      expect((await getBotSecrets())[0]).toMatchObject({ slot: 1, tokenEncrypted: 'cipher', suspended: false });
    });

    it('changes the short name alone only when a bot exists', async () => {
      expect(await saveBot({ miniAppShortName: 'x' })).toBeNull();
      await saveBot({ botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'c' });
      expect((await saveBot({ miniAppShortName: 'play' })).miniAppShortName).toBe('play');
    });

    it('holds standbys in slots 2 to 4, one slot per bot, and removes only a standby', async () => {
      await saveBot({ botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'c1' });
      await saveBot({ slot: 3, botId: '3', botUsername: 'bb3_bot', tokenEncrypted: 'c3' });
      expect((await getBots()).map((b) => b.slot)).toEqual([1, 3]);
      expect((await getBotSecrets()).map((b) => b.slot)).toEqual([1, 3]);
      expect(await saveBot({ slot: 2, botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'again' })).toEqual({ conflict: 1 });
      await expect(saveBot({ slot: 5, botId: '5', botUsername: 'b5', tokenEncrypted: 'c5' })).rejects.toThrow(/telegram_bot_slots/);
      expect(await removeBot(1)).toBe(false);
      expect(await removeBot(3)).toBe(true);
      expect(await count('telegram_bot')).toBe(1);
    });

    it('suspends and lifts a bot once, guarded by its id, and a new token lifts it too', async () => {
      await saveBot({ botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'c1' });
      expect(await setBotSuspended({ slot: 1, reason: 'refused', botId: 'other' })).toBeNull();
      expect(await setBotSuspended({ slot: 1, reason: 'refused', botId: '1' })).toMatchObject({ suspendedReason: 'refused' });
      expect(await setBotSuspended({ slot: 1, reason: 'again' })).toBeNull();
      expect((await getBotSecrets())[0].suspended).toBe(true);
      expect(await setBotSuspended({ slot: 1, reason: null })).toMatchObject({ suspendedAt: null, suspendedReason: '' });
      await setBotSuspended({ slot: 1, reason: 'refused' });
      expect(await saveBot({ botId: '1', botUsername: 'bb_bot', tokenEncrypted: 'new' })).toMatchObject({ suspendedAt: null });
    });

    it('refuses a short name Telegram would not accept', async () => {
      await expect(saveBot({ botId: '1', botUsername: 'b', tokenEncrypted: 'c', miniAppShortName: 'bad name!' }))
        .rejects.toThrow(/telegram_bot_short_name_shape/);
    });
  });


  describe('the first Verify on a panel: the contact share', () => {
    it('links the account whose mobile the shared phone is, and books the joining number', async () => {
      const id = await account();
      const r = await verify(tgUser('111'), '9876543210');
      expect(r).toMatchObject({ ok: true, approved: true, verified: true, created: false, userId: id });
      expect(await getLinkByUserId(id)).toMatchObject({ telegramUserId: '111', phone: '9876543210', audience: 'PLAYER' });
      expect((await getUser(id)).joiningNumber).toBeTruthy();
    });

    it('refuses a contact on a number with no account and leaves no claim, so the person can retry', async () => {
      const id = await account();
      const ch = await challenge();
      const user = tgUser('111');
      const initData = proof();
      const r = await approve(ch, user, { initData, phone: '9000000000' });
      expect(r).toEqual({ ok: false, code: 'NO_ACCOUNT' });
      expect(await getLinkByUserId(id)).toBeNull();
      expect(await count('telegram_init_data_uses')).toBe(0);
      expect((await getChallenge(ch.challengeId)).status).toBe('PENDING');
      // The same initData, now with the right contact, goes through.
      const ok = await approve(ch, user, { initData, phone: '9876543210' });
      expect(ok).toMatchObject({ ok: true, userId: id });
    });

    it('refuses a contact that belongs to another Telegram account', async () => {
      const id = await account();
      const ch = await challenge();
      const r = await answerChallenge({
        challengeId: ch.challengeId, decision: 'approve', telegramUser: tgUser('111'), pick: MATCH.number,
        initData: proof(), contact: contactOf(tgUser('222'), '9876543210'),
      });
      expect(r.code).toBe('CONTACT_NOT_OWN');
      expect(await getLinkByUserId(id)).toBeNull();
    });

    it('acts on a signed string once', async () => {
      await account();
      const user = tgUser('111');
      const initData = proof();
      expect((await approve(await challenge(), user, { initData, phone: '9876543210' })).ok).toBe(true);
      const again = await approve(await challenge(), user, { initData });
      expect(again.code).toBe('INIT_DATA_REPLAYED');
    });

    it('needs a contact from a Telegram account this panel has never seen', async () => {
      const id = await account();
      const r = await approve(await challenge(), tgUser('111'));
      expect(r.code).toBe('CONTACT_REQUIRED');
      expect(await getLinkByUserId(id)).toBeNull();
    });

    it('a wrong number links nothing: the whole act rolls back, the claim of the proof included', async () => {
      const id = await account();
      const ch = await challenge();
      const r = await approve(ch, tgUser('111'), { phone: '9876543210', pick: 17 });
      expect(r.code).toBe('WRONG_NUMBER');
      expect(await getLinkByUserId(id)).toBeNull();
      expect((await getUser(id)).joiningNumber).toBeFalsy();
      expect(await count('telegram_init_data_uses')).toBe(0);
      expect((await getChallenge(ch.challengeId)).status).toBe('PENDING');
    });

    it('one Telegram account verifies one account per panel, and one per panel only', async () => {
      const player = await account({ mobile: '9876543210' });
      const merchant = await account({ mobile: '9876543210', accountType: 'MERCHANT' });
      const other = await account({ mobile: '9123456789' });
      const user = tgUser('111');
      expect((await verify(user, '9876543210')).userId).toBe(player);
      expect((await verify(user, '9876543210', 'MERCHANT')).userId).toBe(merchant);
      // A Telegram account already linked on this panel signs in ITS account:
      // another number's contact does not move it to a second player.
      expect((await verify(user, '9123456789')).userId).toBe(player);
      expect(await getLinkByUserId(other)).toBeNull();
      expect(await listLinksForTelegramUser('111')).toHaveLength(2);
      // And the index is the guarantee for any writer.
      await expect(pgQuery(`INSERT INTO telegram_links (user_id, audience, telegram_user_id, phone) VALUES ($1,'PLAYER','111','9123456789')`, [other]))
        .rejects.toThrow(/telegram_links_one_per_panel/);
    });

    it('the row refuses a phone that is not the mobile, any staff link, and a link across panels', async () => {
      const id = await account();
      const staff = await account({ mobile: '9111111111', accountType: 'STAFF' });
      await expect(pgQuery(`INSERT INTO telegram_links (user_id, audience, telegram_user_id, phone) VALUES ($1,'PLAYER','9','9000000000')`, [id]))
        .rejects.toThrow(/telegram_link_phone_is_mobile|mobile/);
      await expect(pgQuery(`INSERT INTO telegram_links (user_id, audience, telegram_user_id, phone) VALUES ($1,'STAFF','9','9111111111')`, [staff]))
        .rejects.toThrow(/telegram_links_audience_check/);
      await expect(pgQuery(`INSERT INTO telegram_links (user_id, audience, telegram_user_id, phone) VALUES ($1,'MERCHANT','9','9876543210')`, [id]))
        .rejects.toThrow(/telegram_links_account/);
      expect(await count('telegram_links')).toBe(0);
    });

    it('books level-1 and level-2 referral earnings at verification, never before', async () => {
      const top = await account({ mobile: '9000000001' });
      const mid = await account({ mobile: '9000000002', referredBy: top });
      await verify(tgUser('1'), '9000000001');
      await verify(tgUser('2'), '9000000002');
      const joiner = await account({ mobile: '9000000003', referredBy: mid });
      expect(await count('referral_earnings', 'source_user_id = $1', [joiner])).toBe(0);
      await verify(tgUser('3'), '9000000003');
      const { rows } = await pgQuery(`SELECT earner_id, level FROM referral_earnings WHERE source_user_id = $1 ORDER BY level`, [joiner]);
      expect(rows).toEqual([{ earner_id: mid, level: 1 }, { earner_id: top, level: 2 }]);
    });

    it('books what the admin set per level when the joiner verifies, and nothing at a level set to 0', async () => {
      const saved = (await getSystemConfig()).referralRewards;
      try {
        await setConfigPath('system', 'referralRewards.levelRupees', [50, 0]);
        const top = await account({ mobile: '9000000001' });
        const mid = await account({ mobile: '9000000002', referredBy: top });
        await verify(tgUser('1'), '9000000001');
        await verify(tgUser('2'), '9000000002');
        const joiner = await account({ mobile: '9000000003', referredBy: mid });
        await verify(tgUser('3'), '9000000003');
        const { rows } = await pgQuery(
          `SELECT earner_id, level, amount_paise::int AS paise FROM referral_earnings WHERE source_user_id = $1 ORDER BY level`, [joiner]);
        expect(rows).toEqual([{ earner_id: mid, level: 1, paise: 5_000 }]);
      } finally {
        await setConfigPath('system', 'referralRewards.levelRupees', saved.levelRupees);
      }
      expect((await getSystemConfig()).referralRewards).toEqual(saved);
    });

    // Owner, 2026-10-17: the admin adds or removes levels, 1 to 10.
    it('pays as many levels up the chain as the admin set, and no further', async () => {
      const saved = (await getSystemConfig()).referralRewards;
      try {
        await setConfigPath('system', 'referralRewards.levelRupees', [40, 30, 20]);
        // a ← b ← c ← d ← joiner: four inviters above the joiner, three levels paid.
        const ids = [];
        for (let i = 1; i <= 4; i += 1) {
          ids.push(await account({ mobile: `900000000${i}`, referredBy: ids[i - 2] ?? null }));
          await verify(tgUser(String(i)), `900000000${i}`);
        }
        const joiner = await account({ mobile: '9000000009', referredBy: ids[3] });
        await verify(tgUser('9'), '9000000009');
        const { rows } = await pgQuery(
          `SELECT earner_id, level, amount_paise::int AS paise FROM referral_earnings WHERE source_user_id = $1 ORDER BY level`, [joiner]);
        expect(rows).toEqual([
          { earner_id: ids[3], level: 1, paise: 4_000 },
          { earner_id: ids[2], level: 2, paise: 3_000 },
          { earner_id: ids[1], level: 3, paise: 2_000 },
        ]);
      } finally {
        await setConfigPath('system', 'referralRewards.levelRupees', saved.levelRupees);
      }
      expect((await getSystemConfig()).referralRewards).toEqual(saved);
    });

    it('stops at a loop in the invite chain instead of paying anyone twice', async () => {
      const saved = (await getSystemConfig()).referralRewards;
      try {
        await setConfigPath('system', 'referralRewards.levelRupees', [10, 10, 10, 10, 10, 10]);
        const a = await account({ mobile: '9000000001' });
        const b = await account({ mobile: '9000000002', referredBy: a });
        await pgQuery(`UPDATE users SET referred_by = $2 WHERE user_id = $1`, [a, b]);   // a ↔ b
        const joiner = await account({ mobile: '9000000003', referredBy: b });
        await verify(tgUser('3'), '9000000003');
        const { rows } = await pgQuery(
          `SELECT earner_id, level FROM referral_earnings WHERE source_user_id = $1 ORDER BY level`, [joiner]);
        expect(rows).toEqual([{ earner_id: b, level: 1 }, { earner_id: a, level: 2 }]);
      } finally {
        await setConfigPath('system', 'referralRewards.levelRupees', saved.levelRupees);
      }
    });

    it('refuses more than 10 levels, a negative amount, and an empty list', async () => {
      await expect(setConfigPath('system', 'referralRewards.levelRupees', Array(11).fill(5))).rejects.toThrow(/at most 10/);
      await expect(setConfigPath('system', 'referralRewards.levelRupees', [25, -1])).rejects.toThrow(/at least 0/);
      await expect(setConfigPath('system', 'referralRewards.levelRupees', [])).rejects.toThrow(/at least 1/);
    });

    it('a later Verify from the same Telegram account books nothing twice', async () => {
      const top = await account({ mobile: '9000000001' });
      const joiner = await account({ mobile: '9000000003', referredBy: top });
      await verify(tgUser('3'), '9000000003');
      const number = (await getUser(joiner)).joiningNumber;
      const again = await verify(tgUser('3'), '9000000003');
      expect(again).toMatchObject({ ok: true, verified: false, relinked: false, userId: joiner });
      expect((await getUser(joiner)).joiningNumber).toBe(number);
      expect(await count('referral_earnings', 'source_user_id = $1', [joiner])).toBe(1);
    });

    it('refuses a blocked or closed account, and links neither', async () => {
      const blocked = await account();
      await pgQuery(`UPDATE users SET is_blocked = TRUE, block_reason = 'test', blocked_at = now() WHERE user_id = $1`, [blocked]);
      expect((await verify(tgUser('1'), '9876543210')).code).toBe('ACCOUNT_BLOCKED');
      const closed = await account({ mobile: '9123456789' });
      await pgQuery(`UPDATE users SET status = 'DELETED', deleted_at = now(), deleted_by = 'admin-test' WHERE user_id = $1`, [closed]);
      expect((await verify(tgUser('2'), '9123456789')).code).toBe('ACCOUNT_CLOSED');
      expect(await getLinkByUserId(blocked)).toBeNull();
      expect(await getLinkByUserId(closed)).toBeNull();
    });
  });

  describe('challenges', () => {
    it('ten racing polls redeem one approval once', async () => {
      const id = await account();
      const ch = await challenge();
      expect((await approve(ch, tgUser('1'), { phone: '9876543210' })).ok).toBe(true);
      const polls = await Promise.all(Array.from({ length: 10 }, () =>
        redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER' })));
      expect(polls.filter((p) => p.ok)).toEqual([{ ok: true, userId: id }]);
      expect(polls.filter((p) => !p.ok).every((p) => p.state === 'EXPIRED')).toBe(true);
    });

    it('a pending challenge says PENDING, a denied one DENIED, and neither redeems', async () => {
      await account();
      const ch = await challenge();
      expect(await redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER' }))
        .toEqual({ ok: false, state: 'PENDING' });
      const denied = await answerChallenge({ challengeId: ch.challengeId, decision: 'deny', telegramUser: tgUser('1'), initData: proof() });
      expect(denied).toMatchObject({ ok: true, approved: false });
      expect(await redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER' }))
        .toEqual({ ok: false, state: 'DENIED' });
    });

    it('is redeemed only at its own door, and only by its own delivery', async () => {
      const id = await account();
      const ch = await challenge();
      await approve(ch, tgUser('1'), { phone: '9876543210' });
      expect((await redeemChallenge({ challengeId: ch.challengeId, audience: 'MERCHANT' })).ok).toBe(false);
      expect(await redeemChallenge({ challengeId: ch.challengeId, audience: 'PLAYER' })).toEqual({ ok: true, userId: id });

      // A HANDOFF sign-in is never spent by a poll: only its ticket, once, at its door.
      const handoff = await challenge({ delivery: DELIVERY.HANDOFF });
      const t = ticketOf();
      expect((await approve(handoff, tgUser('1'), { pick: null, ticket: t })).ok).toBe(true);
      expect(await redeemChallenge({ challengeId: handoff.challengeId, audience: 'PLAYER' }))
        .toEqual({ ok: false, state: 'APPROVED' });
      // A ticket presented at another door is spent and opens nothing.
      expect(await redeemTicket({ ticketHash: t.hash, audience: 'MERCHANT' })).toEqual({ ok: false });
      expect(await redeemTicket({ ticketHash: t.hash, audience: 'PLAYER' })).toEqual({ ok: false });

      const handoff2 = await challenge({ delivery: DELIVERY.HANDOFF });
      const t2 = ticketOf();
      await approve(handoff2, tgUser('1'), { pick: null, ticket: t2 });
      const both = await Promise.all([1, 2, 3].map(() => redeemTicket({ ticketHash: t2.hash, audience: 'PLAYER' })));
      expect(both.filter((r) => r.ok)).toEqual([{ ok: true, userId: id }]);
    });

    it('an expired challenge can be neither answered nor redeemed, before any sweep', async () => {
      const id = await account();
      const ch = await challenge();
      await pgQuery(`UPDATE telegram_challenges SET expires_at = now() - interval '1 second' WHERE challenge_id = $1`, [ch.challengeId]);
      const r = await approve(ch, tgUser('1'), { phone: '9876543210' });
      expect(r.code).toBe('CHALLENGE_EXPIRED');
      expect(await getLinkByUserId(id)).toBeNull();

      const approved = await challenge();
      expect((await approve(approved, tgUser('1'), { phone: '9876543210' })).ok).toBe(true);
      await pgQuery(`UPDATE telegram_challenges SET expires_at = now() - interval '1 second' WHERE challenge_id = $1`, [approved.challengeId]);
      expect(await redeemChallenge({ challengeId: approved.challengeId, audience: 'PLAYER' }))
        .toEqual({ ok: false, state: 'EXPIRED' });
    });

    it('an approval re-dates the challenge to the short redeem window', async () => {
      await account();
      const ch = await challenge({ ttlSeconds: 900 });
      await approve(ch, tgUser('1'), { phone: '9876543210', redeemWindowSeconds: 60 });
      const { rows } = await pgQuery(`SELECT extract(epoch FROM expires_at - now())::int AS s FROM telegram_challenges WHERE challenge_id = $1`, [ch.challengeId]);
      expect(rows[0].s).toBeLessThanOrEqual(60);
    });

    it('the linked Telegram needs no contact; a new one needs a matching contact, which relinks', async () => {
      const id = await account();
      await verify(tgUser('1'), '9876543210');
      expect(await approve(await challenge(), tgUser('1'))).toMatchObject({ ok: true, userId: id });

      const ch2 = await challenge();
      expect((await approve(ch2, tgUser('2'))).code).toBe('CONTACT_REQUIRED');
      const moved = await approve(ch2, tgUser('2'), { phone: '9876543210' });
      expect(moved).toMatchObject({ ok: true, relinked: true, verified: false, userId: id });
      const link = await getLinkByUserId(id);
      expect(link.telegramUserId).toBe('2');
      expect(new Date(link.linkedAt).getTime()).toBeGreaterThanOrEqual(new Date(link.verifiedAt).getTime());
      expect(await getLinkByTelegramId('1', 'PLAYER')).toBeNull();
    });

    it('a relink to another Telegram account ends old sessions and holds withdrawals; signing in again does neither', async () => {
      const id = await account();
      await verify(tgUser('1'), '9876543210');
      const read = async () => (await pgQuery(
        `SELECT sessions_valid_from, payout_hold_until FROM users WHERE user_id = $1`, [id])).rows[0];
      await approve(await challenge(), tgUser('1'));
      const same = await read();
      expect(same.payout_hold_until).toBeNull();

      const ch2 = await challenge();
      await approve(ch2, tgUser('2'), { phone: '9876543210' });
      const moved = await read();
      expect(new Date(moved.sessions_valid_from).getTime())
        .toBeGreaterThan(new Date(same.sessions_valid_from ?? 0).getTime());
      expect(new Date(moved.payout_hold_until).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    });

    it('a Telegram account linked on one panel is a stranger on the other', async () => {
      await account();
      await verify(tgUser('1'), '9876543210');
      expect((await approve(await challenge({ audience: 'MERCHANT' }), tgUser('1'))).code).toBe('CONTACT_REQUIRED');
      expect(await getLinkByTelegramId('1', 'MERCHANT')).toBeNull();
    });

    it('an unlinked Telegram account must share a contact, and a number with no account is refused', async () => {
      const ch = await challenge();
      expect((await approve(ch, tgUser('9'))).code).toBe('CONTACT_REQUIRED');
      expect((await approve(ch, tgUser('9'), { phone: '9000000009' })).code).toBe('NO_ACCOUNT');
      expect(await count('users')).toBe(0);
    });

    it('refuses the STAFF audience in every writer and reader: staff have no Telegram', async () => {
      await account({ mobile: '9111111111', accountType: 'STAFF', isAdmin: true, passwordHash: '$argon2id$fake' });
      await expect(challenge({ audience: 'STAFF' })).rejects.toThrow(/audience/i);
      await expect(redeemChallenge({ challengeId: 'x', audience: 'STAFF' })).rejects.toThrow(/audience/i);
      await expect(redeemTicket({ ticketHash: 'a'.repeat(64), audience: 'STAFF' })).rejects.toThrow(/audience/i);
      await expect(getLinkByTelegramId('7', 'STAFF')).rejects.toThrow(/audience/i);
      await expect(answerChallenge({
        challengeId: 'cstaff0', decision: 'approve', telegramUser: tgUser('7'), initData: proof(),
        contact: contactOf(tgUser('7'), '9111111111'), open: { audience: 'STAFF', ttlSeconds: 300 },
      })).rejects.toThrow(/audience/i);
      await expect(pgQuery(`INSERT INTO telegram_challenges (challenge_id, audience, status, expires_at, delivery) VALUES ('cstaff2','STAFF','PENDING', now() + interval '5 minutes', 'HANDOFF')`))
        .rejects.toThrow(/telegram_challenges_audience_check|violates/);
      expect(await count('telegram_challenges')).toBe(0);
      expect(await count('telegram_init_data_uses')).toBe(0);
    });
  });

  describe('signup is the first Verify', () => {
    it('makes the player already verified, its mobile taken from Telegram, with the referral booked', async () => {
      const ref = await account({ mobile: '9000000001' });
      await verify(tgUser('1'), '9000000001');
      const userId = newUserId();
      const r = await approve(await challenge(), tgUser('5'), {
        phone: '9555555555', signup: { userId, referralCode: 'NEWP0001', referredBy: ref },
      });
      expect(r).toMatchObject({ ok: true, created: true, verified: true, userId });
      expect(await getUser(userId)).toMatchObject({ mobile: '9555555555', referredBy: ref, accountType: 'PLAYER' });
      expect(await getLinkByTelegramId('5', 'PLAYER')).toMatchObject({ userId });
      expect(await count('referral_earnings', 'source_user_id = $1', [userId])).toBe(1);
      const { rows } = await pgQuery('SELECT password_hash FROM users WHERE user_id = $1', [userId]);
      expect(rows[0].password_hash).toBeNull();
    });

    it('never makes a merchant: a number with no merchant account is refused, and nothing is written', async () => {
      // Owner, 2026-10-14: an admin makes merchant accounts; Telegram only
      // confirms one. Even a caller that hands the writer a signup gets none.
      const userId = newUserId();
      const mobile = `96${String(Date.now()).slice(-8)}`;
      try {
        await expect(approve(await challenge({ audience: 'MERCHANT' }), tgUser('6'), {
          phone: mobile, signup: { userId },
        })).resolves.toMatchObject({ ok: false, code: 'NO_MERCHANT_ACCOUNT' });
        expect(await getUser(userId)).toBeNull();
        expect(await getLinkByTelegramId('6', 'MERCHANT')).toBeNull();
      } finally {
        await pgQuery('DELETE FROM merchants WHERE user_id = $1', [userId]);
      }
    });

    it('a number that already has an account links that account and makes no second one', async () => {
      const existing = await account({ mobile: '9555555555' });
      const r = await approve(await challenge(), tgUser('5'), {
        phone: '9555555555', signup: { userId: newUserId(), referralCode: 'NEWP0002' },
      });
      expect(r).toMatchObject({ ok: true, created: false, userId: existing });
      expect(await count('users')).toBe(1);
    });

    it('a refused signup leaves nothing behind: no account, no link, no claim', async () => {
      const userId = newUserId();
      const r = await approve(await challenge(), tgUser('5'), {
        phone: '9555555555', pick: 88, signup: { userId, referralCode: 'NEWP0003' },
      });
      expect(r.code).toBe('WRONG_NUMBER');
      expect(await getUser(userId)).toBeNull();
      expect(await count('telegram_links')).toBe(0);
      expect(await count('telegram_init_data_uses')).toBe(0);
    });
  });

  describe('the sweep', () => {
    it('reclaims expired proofs, lapsed tickets and day-old challenges, and leaves live ones', async () => {
      await pgQuery(`INSERT INTO telegram_init_data_uses (hash, expires_at) VALUES ('old', now() - interval '1 second'), ('live', now() + interval '5 minutes')`);
      const old = await challenge();
      await pgQuery(`UPDATE telegram_challenges SET expires_at = now() - interval '25 hours' WHERE challenge_id = $1`, [old.challengeId]);
      const live = await challenge();
      await pgQuery(`INSERT INTO telegram_handoff_tickets (ticket_hash, challenge_id, expires_at) VALUES ($1, $2, now() - interval '1 second')`,
        [ticketOf().hash, live.challengeId]);
      const swept = await sweepExpired();
      expect(swept).toEqual({ challenges: 1, initDataUses: 1, tickets: 1 });
      expect(await count('telegram_init_data_uses')).toBe(1);
      expect(await getChallenge(live.challengeId)).toBeTruthy();
    });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The player writer behind the first Verify.
//
// `createAccountFromSignup` writes a player from the mobile Telegram proved,
// inside the approving transaction (`answerChallenge`). There is no password
// and no Aadhaar (owner, 2026-10-02 and 2026-10-14). It writes no Telegram link
// itself: the approval links the account in the same transaction.
// ─────────────────────────────────────────────────────────────────────────────
import { createAccountFromSignup } from '../repositories/identity.js';

const signup = (over = {}) => ({
  userId: newUserId(), mobile: '9990001111', username: 'newplayer',
  referralCode: 'MYCODE01', ...over,
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

  it('creates NO Telegram link by itself — the approval that called it links it', async () => {
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

  it('writes no password: a player signs in with Telegram alone', async () => {
    const r = await createAccountFromSignup(signup());
    const { rows } = await pgQuery('SELECT password_hash FROM users WHERE user_id = $1', [r.userId]);
    expect(rows[0].password_hash).toBeNull();
  });

  it('the row refuses a password on any account but staff', async () => {
    const r = await createAccountFromSignup(signup());
    await expect(pgQuery(`UPDATE users SET password_hash = '$argon2id$x' WHERE user_id = $1`, [r.userId]))
      .rejects.toThrow(/users_password_staff_only/);
    const { rows } = await pgQuery('SELECT password_hash FROM users WHERE user_id = $1', [r.userId]);
    expect(rows[0].password_hash).toBeNull();
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
