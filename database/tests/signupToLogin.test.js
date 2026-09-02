// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * An account created by signup can be found by the thing that authenticates it.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 * Signup was moved to PostgreSQL while `authenticate` still read the document.
 * The write succeeded. The read found nothing. Nothing errored anywhere — the
 * middleware simply answered "User not found. Token may be invalid." So a
 * player could complete the whole onboarding, receive their login link, click
 * it, and be told their account did not exist.
 *
 * No unit test caught it, because each half worked. No integration test caught
 * it, because that tier is deleted. `check:no-mongo` did not, because it counts
 * references rather than asking whether reads and writes agree on a store.
 *
 * So this walks the seam directly: create through the signup path, then read
 * through EVERY function the login path calls, against a real database. If a
 * future change moves one side without the other, one of these goes red.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createAccountFromOnboarding, getIdentityByTelegramId, issueLoginToken, consumeLoginToken } from '../repositories/telegram.js';
import { getUser, getUserByMobile, getUserCredentials, newUserId, claimJoiningNumber } from '../repositories/users.js';
import { getVerification } from '../repositories/identity.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('signup → login, end to end on one store', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE telegram_login_tokens, kyc_verifications,
                            telegram_identities, telegram_pending_links, users
                   RESTART IDENTITY CASCADE`);
  });

  async function signUp(over = {}) {
    const r = await createAccountFromOnboarding({
      telegramUserId: 't-1', mobile: '9995550001', username: 'newplayer',
      aadhaarHash: 'ah-1', aadhaarEncrypted: 'ac-1', aadhaarLast4: '0001',
      newUserId: newUserId(), ...over,
    });
    expect(r.ok).toBe(true);
    return r.userId;
  }

  it('authenticate can find the account signup just created', async () => {
    const userId = await signUp();
    // This is the exact call `authenticate` makes on every request. When it
    // read the document instead, this returned null for every new player.
    const user = await getUser(userId);
    expect(user).not.toBeNull();
    expect(user.mobile).toBe('9995550001');
    expect(user.isBlocked).toBe(false);
  });

  it('the password-login lookup finds it by mobile', async () => {
    await signUp();
    expect((await getUserByMobile('9995550001')).username).toBe('newplayer');
  });

  it('the credential lookup finds the same account', async () => {
    const userId = await signUp();
    expect((await getUserCredentials(userId)).userId).toBe(userId);
  });

  it('the login link resolves to the account that signed up', async () => {
    const userId = await signUp();
    await issueLoginToken({ tokenHash: 'tok', telegramUserId: 't-1', userId });

    // The full bridge: bot issues a token, the site exchanges it, and the id it
    // gets back has to be one `authenticate` can then resolve.
    const claim = await consumeLoginToken({ tokenHash: 'tok', telegramUserId: 't-1' });
    expect(claim.userId).toBe(userId);
    expect(await getUser(claim.userId)).not.toBeNull();
  });

  it('the identity, the KYC row and the account all point at each other', async () => {
    const userId = await signUp();
    const identity = await getIdentityByTelegramId('t-1');
    const verification = await getVerification(userId);

    expect(identity.userId).toBe(userId);
    expect(verification.userId).toBe(userId);
    // A signup that produced three rows which do not agree on who the account
    // is would pass every table's own constraints and still be broken.
    expect(identity.phone).toBe((await getUser(userId)).mobile);
  });

  it('completing onboarding numbers the account the login path can read', async () => {
    const userId = await signUp();
    expect(await claimJoiningNumber(userId)).toBe(1);
    expect((await getUser(userId)).joiningNumber).toBe(1);
  });

  it('a blocked account is visible as blocked to the middleware that gates it', async () => {
    const userId = await signUp();
    await pgQuery(
      `UPDATE users SET is_blocked = true, block_reason = 'fraud', blocked_at = now()
        WHERE user_id = $1`, [userId]);
    // authenticate refuses on this exact field. Reading a stale copy would let
    // a blocked player keep trading.
    expect((await getUser(userId)).isBlocked).toBe(true);
  });
});
