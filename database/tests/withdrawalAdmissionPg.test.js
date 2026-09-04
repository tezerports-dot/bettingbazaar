// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Withdrawal admission — the path where money LEAVES the platform.
 *
 * The service used to admit a withdrawal by reading the player's winnings,
 * summing their in-flight withdrawals, and comparing. Three reads, then a
 * debit, with nothing holding them together. This suite exercises the two
 * failures that shape had, against a real database:
 *
 *   1. TWO REQUESTS ARRIVING TOGETHER both passed the check and both debited.
 *   2. THE PENDING SUM DOUBLE-COUNTED. The escrow debit moves winnings into
 *      `lockedBalance`, so an in-flight withdrawal is ALREADY out of the
 *      winnings figure the check compared against — and the second legitimate
 *      withdrawal was refused against money the player held.
 *
 * Admission is now the debit itself: winnings → locked under the wallet's row
 * lock, in one transaction with its ledger entry. There is no second decision
 * to disagree with it.
 *
 * These run through `debitWinningsForWithdrawal` — the real writer — rather
 * than mocking it. A suite that mocked the settlement writer once reported
 * settlement working while the real function threw on every call.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { debitWinningsForWithdrawal, creditWinnings, getBalances } from '../repositories/wallets.js';
import { createOrderRecord, pendingWithdrawalTotal, getOrderRecord } from '../repositories/orders.record.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

// Ledger tx ids are globally unique, so a fixed id collides across runs against
// a persistent database. Every run gets its own prefix.
const RUN = Math.random().toString(36).slice(2, 8);
let n = 0;
const uid = () => `wd-u-${RUN}-${n += 1}`;
const oid = () => `WD_${RUN}_${n += 1}`;

/** Give a player winnings to withdraw, through the real credit path. */
async function fund(userId, rupees) {
  await creditWinnings(userId, rupees, `test funding ${userId}`, 'Test', null, `fund_${userId}`);
  return userId;
}

describePg('withdrawal admission', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => { /* per-run ids keep runs isolated; no truncation */ });

  it('moves winnings into locked rather than out of the wallet', async () => {
    const u = await fund(uid(), 1000);
    const before = await getBalances(u);
    expect(before.winningsBalance).toBe(1000);

    const result = await debitWinningsForWithdrawal(u, 400, oid());
    expect(result.winningsAfter).toBe(600);
    expect(result.lockedAfter).toBe(400);

    // The player's money did not leave — it moved pocket. Total is unchanged,
    // which is what makes an escrow reversible.
    const after = await getBalances(u);
    expect(after.winningsBalance + after.lockedBalance).toBe(1000);
  });

  it('admits a SECOND withdrawal the old pending-sum guard would have refused', async () => {
    const u = await fund(uid(), 1000);

    await debitWinningsForWithdrawal(u, 400, oid());
    // The old guard compared `pendingTotal + amount > availableWinnings`, i.e.
    // 400 + 400 > 600 — refusing a player who genuinely held 600 withdrawable.
    // The escrow already accounted for the first 400; counting it again charged
    // the player twice for the same withdrawal.
    const second = await debitWinningsForWithdrawal(u, 400, oid());
    expect(second.winningsAfter).toBe(200);
    expect(second.lockedAfter).toBe(800);
  });

  it('refuses the amount the wallet cannot fund, with the real figure', async () => {
    const u = await fund(uid(), 500);
    await expect(debitWinningsForWithdrawal(u, 900, oid())).rejects.toMatchObject({
      code: 'INSUFFICIENT_WITHDRAWABLE',
      availableWinnings: 500,
      requested: 900,
      status: 400,
    });
    // A refusal moves nothing.
    expect((await getBalances(u)).winningsBalance).toBe(500);
  });

  it('lets only as many concurrent withdrawals through as the wallet funds', async () => {
    const u = await fund(uid(), 1000);

    // Ten simultaneous ₹300 withdrawals against ₹1,000. Exactly three can be
    // funded. The read-then-compare guard let all ten past its check — every
    // one of them read the same 1,000 before any of them wrote.
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => debitWinningsForWithdrawal(u, 300, oid())),
    );
    const admitted = attempts.filter((a) => a.status === 'fulfilled');
    const refused = attempts.filter((a) => a.status === 'rejected');

    expect(admitted).toHaveLength(3);
    expect(refused).toHaveLength(7);
    expect(refused.every((r) => r.reason.code === 'INSUFFICIENT_WITHDRAWABLE')).toBe(true);

    const after = await getBalances(u);
    expect(after.winningsBalance).toBe(100);
    expect(after.lockedBalance).toBe(900);
    // Nothing was created and nothing destroyed.
    expect(after.winningsBalance + after.lockedBalance).toBe(1000);
  });

  it('never overdraws, whatever the interleaving', async () => {
    const u = await fund(uid(), 1000);
    // Mixed sizes, so the winners are not simply the first three.
    await Promise.allSettled([100, 700, 400, 250, 600, 50].map(
      (amount) => debitWinningsForWithdrawal(u, amount, oid()),
    ));
    const after = await getBalances(u);
    expect(after.winningsBalance).toBeGreaterThanOrEqual(0);
    expect(after.winningsBalance + after.lockedBalance).toBe(1000);
  });

  it('treats a resubmitted withdrawal as the same one', async () => {
    const u = await fund(uid(), 1000);
    const orderId = oid();

    const first = await debitWinningsForWithdrawal(u, 400, orderId);
    expect(first.winningsAfter).toBe(600);

    // Same order, delivered twice. Keyed `wd_<orderId>`, so the second collides
    // inside the transaction rather than locking another 400.
    const replay = await debitWinningsForWithdrawal(u, 400, orderId);
    expect(replay.idempotent).toBe(true);
    expect((await getBalances(u)).winningsBalance).toBe(600);
  });

  it('leaves nothing behind when the debit refuses', async () => {
    const u = await fund(uid(), 100);
    const orderId = oid();

    // The service debits BEFORE writing the order, so a refusal has nothing to
    // undo. Writing the order first would need a compensating delete that can
    // itself fail — and a crash between the two leaves an escrow-flagged order
    // holding money that was never taken.
    await expect(debitWinningsForWithdrawal(u, 500, orderId)).rejects.toMatchObject({
      code: 'INSUFFICIENT_WITHDRAWABLE',
    });
    expect(await getOrderRecord(orderId)).toBeNull();
  });

  it('reports in-flight withdrawals without letting them gate anything', async () => {
    const u = uid();
    await createOrderRecord({
      orderId: oid(), userId: u, type: 'WITHDRAWAL',
      tokenAmountRupees: 300, escrowLocked: true, escrowStatus: 'LOCKED',
    });
    await createOrderRecord({
      orderId: oid(), userId: u, type: 'WITHDRAWAL',
      tokenAmountRupees: 200, escrowLocked: true, escrowStatus: 'LOCKED',
    });
    // A DISPLAY figure, for telling a player why their spendable winnings look
    // lower than they expect. It is deliberately not consulted before a debit.
    expect(await pendingWithdrawalTotal(u)).toBe(500);
  });
});
