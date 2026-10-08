// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An account created by the FORM can be found by everything that authenticates it.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 * Signup was moved to PostgreSQL while `authenticate` still read the document.
 * The write succeeded. The read found nothing. Nothing errored anywhere — the
 * middleware simply answered "User not found. Token may be invalid." So a
 * player could complete the whole onboarding, receive their login link, click
 * it, and be told their account did not exist.
 *
 * No unit test caught it, because each half worked. No integration test caught
 * it, because that tier is deleted. The single-store gate did not, because it
 * counts references rather than asking whether reads and writes agree on a
 * store.
 *
 * So this walks the seam directly: create through the signup path, then read
 * through EVERY function the login path calls, against a real database. If a
 * future change moves one side without the other, one of these goes red.
 *
 * ── What changed on 2026-09-23 ──────────────────────────────────────────────
 * The two ends. Signup is `createAccountFromSignup` — a form, with a password —
 * and login is the password, not a one-time link the bot DMed. The SEAM is the
 * same seam and the reason for this file is unchanged, which is why it was
 * rewritten rather than deleted: `getUserByMobile` → `getUserCredentials` →
 * `verifyPassword` is now the whole login path, and every one of those reads
 * has to find what the form wrote.
 *
 * Two rows this deliberately asserts the ABSENCE of at signup: the Telegram
 * link and the joining number (the contact share creates both, later; Step 3). Both were present at this point in the old flow, and
 * a change that quietly restored either would break the referral queue's
 * ordering without breaking anything a happy path would notice.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { getLinkByUserId, createChallenge, answerChallenge } from '../repositories/telegram.js';
import { getUser, getUserByMobile, getUserCredentials, newUserId, claimJoiningNumber } from '../repositories/users.js';
import { createAccountFromSignup } from '../repositories/identity.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('signup → login, end to end on one store', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE telegram_links, telegram_challenges, telegram_init_data_uses, users
                   RESTART IDENTITY CASCADE`);
  });

  async function signUp(over = {}) {
    const r = await createAccountFromSignup({
      userId: newUserId(), mobile: '9995550001', username: 'newplayer',
      passwordHash: '$argon2id$v=19$fake-hash',
      referralCode: 'FORMCODE', ...over,
    });
    expect(r.ok).toBe(true);
    return r.userId;
  }

  it('authenticate can find the account the form just created', async () => {
    const userId = await signUp();
    // This is the exact call `authenticate` makes on every request. When it
    // read the document instead, this returned null for every new player.
    const user = await getUser(userId);
    expect(user).not.toBeNull();
    expect(user.mobile).toBe('9995550001');
    expect(user.isBlocked).toBe(false);
  });

  it('the login lookup finds it by mobile', async () => {
    await signUp();
    expect((await getUserByMobile('9995550001', 'PLAYER')).username).toBe('newplayer');
  });

  it('the credential lookup returns the hash the form stored', async () => {
    // The whole login path in one line now. `getUserCredentials` is the ONLY
    // function that returns a password hash, and an ordinary user read must not
    // — so if this ever came back empty, every player's password would be
    // rejected and the account read would still look perfectly healthy.
    const userId = await signUp();
    const creds = await getUserCredentials(userId);
    expect(creds.userId).toBe(userId);
    expect(creds.passwordHash).toBe('$argon2id$v=19$fake-hash');
    expect(JSON.stringify(await getUser(userId))).not.toContain('argon2id');
  });

  it('creates NO Telegram link and NO joining number at signup', async () => {
    const userId = await signUp();
    expect(await getLinkByUserId(userId)).toBeNull();
    expect((await getUser(userId)).joiningNumber).toBeFalsy();
  });

  it('the contact share links the Telegram account to the form account', async () => {
    const userId = await signUp();
    // The seam the whole verification step rests on: Telegram's own verified
    // number, matched against what was typed on the form.
    const ch = await createChallenge({ challengeId: 'cseam1', purpose: 'VERIFY', audience: 'PLAYER', userId, ttlSeconds: 300 });
    const at = new Date(Date.now() + 300_000);
    const linked = await answerChallenge({
      challengeId: ch.challengeId, decision: 'approve', telegramUser: { id: 't-1' },
      initData: { hash: 'seam-i', expiresAt: at }, contact: { hash: 'seam-c', expiresAt: at, userId: 't-1', phone: '9995550001' },
    });
    expect(linked).toMatchObject({ ok: true, userId, verified: true });
    const link = await getLinkByUserId(userId);
    expect(link.userId).toBe(userId);
    expect(link.phone).toBe((await getUser(userId)).mobile);
  });

  it('completing verification numbers the account, once', async () => {
    const userId = await signUp();
    // The number is derived from MAX + 1 over the rows themselves, so its VALUE
    // depends on what else this database holds. What matters is that completing
    // assigns one, that the login path reads the same one, and that completing
    // twice does not consume two.
    const claimed = await claimJoiningNumber(userId);
    expect(Number.isInteger(claimed) && claimed > 0).toBe(true);
    expect((await getUser(userId)).joiningNumber).toBe(claimed);
    expect(await claimJoiningNumber(userId)).toBe(claimed);
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
