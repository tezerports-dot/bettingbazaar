// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * loginSessionPg.test.js — the payload every login hands back.
 *
 * `issueSession` is the ONE place a session comes into existence: the staff
 * password path, the second-factor path and the Telegram path all mint here.
 * So a defect in this payload is a defect in every login on the platform, which
 * is what made the one below worth a suite of its own.
 *
 * It read `user.depositBalance` and `user.winningsBalance` off the account.
 * There is no balance column on the accounts table, by design — balances live
 * in `wallets`, in integer paise, behind a row lock, with one writer — so every
 * field fell through to its `|| 0` and EVERY LOGIN told the player their wallet
 * was empty.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createUser, getUserByMobile, getUser } from '../repositories/users.js';
import { applyDeltaPaise } from '../repositories/wallets.core.js';

// PASETO refuses to load without a key, and this suite imports the login path.
process.env.JWT_SECRET ||= 'test-only-secret-long-enough-for-paseto-key-derivation';

const describePg = pgConfigured() ? describe : describe.skip;

/** A response object that records rather than sends. */
function recorder() {
  const captured = {};
  return {
    res: { cookie() {}, json(payload) { Object.assign(captured, payload); return payload; } },
    captured,
  };
}

const fund = (field, paise, key) =>
  applyDeltaPaise({ userId: 'u1', field, deltaPaise: paise, txId: key, type: 'CREDIT', reason: 'test' });

describePg('the session a login hands back', () => {
  let issueSession;

  beforeAll(async () => {
    await applySchema();
    ({ issueSession } = await import('../../backend/routes.js'));
  });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE users, wallets, wallet_ledger RESTART IDENTITY CASCADE');
    await createUser({ userId: 'u1', username: 'Asha', mobile: '9990001111' });
  });

  it('reports the balances the wallet actually holds', async () => {
    await fund('depositBalance', 250_00, 'f1');
    await fund('winningsBalance', 75_50, 'f2');

    const { res, captured } = recorder();
    await issueSession(await getUserByMobile('9990001111'), res);

    expect(captured.user.depositBalance).toBe(250);
    expect(captured.user.winningsBalance).toBe(75.5);
    // Rupees at the boundary, from integer paise. A player logging in after a
    // win must be shown what they have.
    expect(captured.user.walletBalance).toBe(325.5);
  });

  it('keeps the reserve out of the headline balance', async () => {
    await fund('depositBalance', 100_00, 'f1');
    await fund('reserveBalance', 500_00, 'f2');

    const { res, captured } = recorder();
    await issueSession(await getUserByMobile('9990001111'), res);

    // The reserve is NOT freely spendable — only a percentage of a stake may
    // come from it — so folding it into "available" is what made players try
    // bets the engine then refused.
    expect(captured.user.reserveBalance).toBe(500);
    expect(captured.user.walletBalance).toBe(100);
  });

  it('reports a locked stake apart from the spendable balance', async () => {
    await fund('depositBalance', 100_00, 'f1');
    await fund('lockedBalance', 40_00, 'f2');

    const { res, captured } = recorder();
    await issueSession(await getUserByMobile('9990001111'), res);

    expect(captured.user.lockedBalance).toBe(40);
    expect(captured.user.walletBalance).toBe(100);
  });

  it('shows zero for an account that genuinely has nothing', async () => {
    const { res, captured } = recorder();
    await issueSession(await getUserByMobile('9990001111'), res);
    // Zero is the right answer here — the bug was that it was the ONLY answer.
    expect(captured.user.walletBalance).toBe(0);
  });

  it('records the login against the account', async () => {
    const { res, captured } = recorder();
    await issueSession(await getUserByMobile('9990001111'), res);

    // Written to the ROW. The version this replaced assigned `lastLogin` to a
    // plain object and called `.save()` on it — a TypeError, so no login has
    // been recorded since accounts moved.
    expect((await getUser('u1')).lastLogin).toBeInstanceOf(Date);
    expect(captured.user.lastLogin).toBeTruthy();
  });

  it('identifies the account by its real id', async () => {
    const { res, captured } = recorder();
    await issueSession(await getUserByMobile('9990001111'), res);
    expect(captured.user.id).toBe('u1');
    expect(captured.user._id).toBe('u1');
    expect(captured.token).toBeTruthy();
  });
});
