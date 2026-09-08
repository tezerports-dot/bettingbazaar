// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
import { createUser, newUserId } from '#db/repositories/users.js';
import {
  createIdentity, issueLoginCode, consumeLoginCode, getActiveIdentityByPhone,
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

  it('finds the identity behind a number, and only while it is active', async () => {
    const who = await linked();
    expect((await getActiveIdentityByPhone(who.mobile))?.userId).toBe(who.userId);
    // Account recovery keeps the displaced row as history. Messaging the
    // identity that just LOST the account would send a sign-in code for
    // somebody's account to the person they took it back from.
    await pgQuery(
      `UPDATE telegram_identities SET contact_active = FALSE WHERE telegram_user_id = $1`,
      [who.telegramUserId],
    );
    expect(await getActiveIdentityByPhone(who.mobile)).toBeNull();
  });

  it('returns null for a number nobody has linked', async () => {
    expect(await getActiveIdentityByPhone('9111111111')).toBeNull();
    expect(await getActiveIdentityByPhone('')).toBeNull();
    expect(await getActiveIdentityByPhone(null)).toBeNull();
  });
});
