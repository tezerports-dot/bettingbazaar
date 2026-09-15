// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sign-in code, at the layer that makes it safe.
 *
 * ── Why these are here and not in the route suite ───────────────────────────
 * The route is paced at one attempt per 10 seconds per step (owner directive),
 * so the properties that need several attempts against ONE code — single use,
 * the five-attempt cap, replacement — cannot be driven over HTTP without
 * sleeping a minute per assertion. They are repository properties in any case:
 * the guarantee is that the redemption is ONE atomic statement, and that is a
 * claim about SQL, not about Express.
 *
 * The pace and the cap are different controls and both matter. The pace makes a
 * script slow; the cap makes a code die. Six digits with neither is guessable
 * in under an hour.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createUser, newUserId, softDeleteUser } from '#db/repositories/users.js';
import {
  createIdentity, relinkIdentity, issueLoginCode, consumeLoginCode, getLoginTargetByMobile,
} from '#db/repositories/telegram.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('telegram sign-in codes', () => {
  let seq = 0;
  const base = Math.floor(Math.random() * 800_000_000);

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });

  const h = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

  /** An account with a live Telegram identity, as the bot signup leaves it. */
  const linked = async () => {
    const userId = newUserId();
    // Random base, not a fixed one: the database persists between runs and
    // `one_active_identity_per_phone` is a real constraint, so a deterministic
    // generator collides with its own previous run on the second execution.
    const mobile = `9${String(base + (seq += 1)).padStart(9, '0')}`;
    await createUser({ userId, username: `p${seq}`, mobile, passwordHash: 'x' });
    const telegramUserId = `tgc-${Date.now().toString(36)}-${seq}`;
    await createIdentity({
      telegramUserId, userId, telegramUsername: 'p', firstName: 'P', phone: mobile,
    });
    return { userId, mobile, telegramUserId, mobileHash: h(mobile) };
  };

  const issue = (who, code, ttl = 300) => issueLoginCode({
    mobileHash: who.mobileHash, codeHash: h(`${who.mobile}:${code}`),
    userId: who.userId, telegramUserId: who.telegramUserId, ttlSeconds: ttl,
  });
  const consume = (who, code) => consumeLoginCode({
    mobileHash: who.mobileHash, codeHash: h(`${who.mobile}:${code}`),
  });

  it('redeems a correct code once and never again', async () => {
    // Read-then-consume is two statements and two requests fit between them,
    // which for a sign-in credential means two sessions from one code. The
    // `consumed_at IS NULL` in the WHERE clause is what makes exactly one of N
    // racing redemptions win.
    const who = await linked();
    await issue(who, '123456');

    expect(await consume(who, '123456')).toMatchObject({ userId: who.userId });
    expect(await consume(who, '123456')).toBeNull();
  });

  it('refuses a wrong code without spending the right one', async () => {
    const who = await linked();
    await issue(who, '123456');

    expect(await consume(who, '654321')).toBeNull();
    // A typo must not cost the player their code.
    expect(await consume(who, '123456')).toMatchObject({ userId: who.userId });
  });

  it('burns the code at five wrong attempts', async () => {
    // Unbounded, 10^6 falls to a script. At five it is 1-in-200000, and the row
    // is consumed AT the cap rather than left alive until it expires — so the
    // remaining lifetime cannot be spent guessing.
    const who = await linked();
    await issue(who, '123456');

    for (let i = 1; i <= 5; i += 1) {
      expect(await consume(who, '000000'), `attempt ${i}`).toBeNull();
    }
    expect(await consume(who, '123456'), 'the correct code survived the cap').toBeNull();
  });

  it('counts attempts against the live row, not across reissues', async () => {
    const who = await linked();
    await issue(who, '111111');
    await consume(who, '000000');
    await consume(who, '000000');

    // A new code has not been guessed at. Carrying the count over would let two
    // bad guesses on a code the player abandoned kill the one they are reading.
    await issue(who, '222222');
    for (let i = 0; i < 4; i += 1) await consume(who, '999999');
    expect(await consume(who, '222222')).toMatchObject({ userId: who.userId });
  });

  it('replaces the outstanding code rather than leaving two live', async () => {
    // A player who taps "send code" twice must not leave a spare credential
    // alive in a chat they have already scrolled past.
    const who = await linked();
    await issue(who, '111111');
    await issue(who, '222222');

    expect(await consume(who, '111111')).toBeNull();
    expect(await consume(who, '222222')).toMatchObject({ userId: who.userId });
  });

  it('refuses an expired code, whatever the sweep has done', async () => {
    // Expiry is checked by the READ. A row the retention sweep has not reclaimed
    // yet is still expired, and a sweep that is late, failing or never scheduled
    // must not make one redeemable.
    const who = await linked();
    await issue(who, '123456', 300);
    await pgQuery(
      `UPDATE telegram_login_codes SET expires_at = now() - interval '1 second' WHERE mobile_hash = $1`,
      [who.mobileHash],
    );
    expect(await consume(who, '123456')).toBeNull();
  });

  it('will not redeem one account’s code against another number', async () => {
    // The code hash is bound to the mobile it was minted for. Without that, a
    // code read over a shoulder redeems whoever the reader chooses.
    const a = await linked();
    const b = await linked();
    await issue(a, '123456');

    expect(await consumeLoginCode({
      mobileHash: b.mobileHash, codeHash: h(`${a.mobile}:123456`),
    })).toBeNull();
    expect(await consume(a, '123456')).toMatchObject({ userId: a.userId });
  });

  it('finds where to send, and only while an identity is active', async () => {
    const who = await linked();
    expect((await getLoginTargetByMobile(who.mobile))?.userId).toBe(who.userId);
    // Account recovery keeps the displaced row as history. Messaging the
    // identity that just LOST the account would send a sign-in code for
    // somebody's account to the person they took it back from.
    await pgQuery(
      `UPDATE telegram_identities SET contact_active = FALSE WHERE telegram_user_id = $1`,
      [who.telegramUserId],
    );
    expect(await getLoginTargetByMobile(who.mobile)).toBeNull();
  });

  it('returns null for a number nobody has linked', async () => {
    expect(await getLoginTargetByMobile('9111111111')).toBeNull();
    expect(await getLoginTargetByMobile('')).toBeNull();
    expect(await getLoginTargetByMobile(null)).toBeNull();
  });

  /**
   * ── The number typed is the KYC number, and so is the one we send to ─────
   *
   * `users.mobile` is captured from the shared contact at signup, is immutable,
   * and is the number the Aadhaar is verified against.
   * `telegram_identities.phone` is the number on the Telegram account that is
   * currently linked.
   *
   * Both must be the KYC number, and both are checked. Today they cannot
   * disagree — signup stamps them from one contact share, and `attemptRecovery`
   * only ever re-links with the number that just matched `getUserByMobile` —
   * so the second check is the invariant made ENFORCED rather than assumed. A
   * future writer that links an identity carrying some other number gets a
   * refused sign-in instead of a code delivered to a Telegram account the
   * platform has no verified claim about.
   */
  describe('recovery onto a different Telegram account', () => {
    it('keeps working, and sends to the NEW Telegram account', async () => {
      // What recovery actually produces: a different Telegram ACCOUNT holding
      // the SAME KYC number. Identification and delivery are different
      // questions — the mobile identifies the account, the active identity is
      // where the person reads messages now.
      const who = await linked();
      const newTelegramUserId = `tgr-${Date.now().toString(36)}-${(seq += 1)}`;
      const res = await relinkIdentity({
        telegramUserId: newTelegramUserId, userId: who.userId, phone: who.mobile,
      });
      expect(res.ok, 'relink failed').toBe(true);

      const target = await getLoginTargetByMobile(who.mobile);
      expect(target?.userId).toBe(who.userId);
      expect(target?.telegramUserId).toBe(newTelegramUserId);
    });

    it('refuses an identity carrying a number that is not the KYC one', async () => {
      // No production path writes this — `attemptRecovery` matches the shared
      // contact against `users.mobile` before it re-links, so the two cannot
      // come apart. Asserted anyway: the guard is what keeps that true when
      // somebody adds a second way to link an identity.
      const who = await linked();
      const strayTelegramUserId = `tgs-${Date.now().toString(36)}-${(seq += 1)}`;
      const strayPhone = `9${String(base + 500_000 + seq).padStart(9, '0')}`;
      const res = await relinkIdentity({
        telegramUserId: strayTelegramUserId, userId: who.userId, phone: strayPhone,
      });
      expect(res.ok).toBe(true);

      // Neither number gets in: not the stray one (it is not the KYC number),
      // and not the KYC one (the only live identity no longer carries it).
      expect(await getLoginTargetByMobile(strayPhone)).toBeNull();
      expect(await getLoginTargetByMobile(who.mobile)).toBeNull();
    });
  });

  it('will not send to a deleted account', async () => {
    // Through `softDeleteUser`, not a raw UPDATE: `users_deleted_has_actor`
    // refuses a DELETED row with no actor, so the raw version was writing a
    // state the platform cannot actually produce.
    const who = await linked();
    await softDeleteUser(who.userId, { actor: 'admin-1' });
    expect(await getLoginTargetByMobile(who.mobile)).toBeNull();
  });
});
