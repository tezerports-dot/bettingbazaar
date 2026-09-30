// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A disputed withdrawal must not settle itself while the dispute is open.
 *
 * ── What the hold is for ────────────────────────────────────────────────────
 * On a sell, the merchant asserting they sent the money settles NOTHING. The
 * order reaches PAID, the merchant's credit is HELD, the player's stake stays
 * locked, and a worker settles it once the window passes. That gap is the whole
 * design: until it closes neither side has moved, so a dispute is a REVERSAL
 * rather than a clawback.
 *
 * The player's reason for disputing a sell is precisely this: the merchant
 * clicked paid and nothing arrived in their bank.
 *
 * ── What is being checked ───────────────────────────────────────────────────
 * The dispute writes `disputeReason`, `disputeRaisedAt` and `disputeRaisedBy`
 * and moves the state. It does NOT touch `merchantCreditStatus` or
 * `merchantCreditHoldUntil` — and `findDueHolds` selects purely on those two,
 * with no filter on state, while `settleHold` guards only on the credit status.
 *
 * So the question this file answers is whether raising a dispute actually stops
 * the money, or only records that somebody objected while the worker pays out
 * on schedule anyway.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { creditWinnings, lockWithdrawal } from '../../domains/wallet/walletAuthority.service.js';
import { settleDueHolds, settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a disputed withdrawal hold', () => {
  let playerApp;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => {
    await applySchema();
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /**
   * A sell the merchant has asserted they paid: PAID, credit HELD, and the hold
   * deadline already in the past so the worker considers it due right now.
   */
  const heldWithdrawal = async (merchantId) => {
    seq += 1;
    const who = await actor({});
    const orderId = `HLD-${RUN}-${seq}`;

    // The stake is ACTUALLY LOCKED, and that is not fixture decoration.
    //
    // The first version of this file set `escrowLocked: true` on the row and
    // left `lockedBalance` at zero. Every test passed — and all of them passed
    // for the WRONG REASON: `settleHold` reached `releaseWithdrawal`, which
    // threw `lockedBalance would go negative`, so the settlement reversed and
    // the assertions read that as the dispute having stopped it. In production,
    // where the stake is real, it would have proceeded.
    //
    // That is §0.5's lesson landing on this very file: a green result is not
    // evidence until you know what made it green.
    await creditWinnings(who.userId, 1000, 'hold test float', 'Test', orderId, `hf_${orderId}`);
    await lockWithdrawal(who.userId, 1000, orderId);

    await createOrderRecord({
      orderId, userId: who.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000, state: 'PAID',
      merchantId,
      paidAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    await setOrderFields(orderId, {
      merchantCreditStatus: 'HELD',
      merchantCreditHoldUntil: new Date(Date.now() - 60 * 1000),
      escrowLocked: true,
    });
    return { orderId, who };
  };

  it('is picked up by the worker as due — the precondition', async () => {
    // Establishes that the fixture reaches the worker at all, so a green result
    // below cannot mean "nothing was ever going to happen anyway".
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await heldWithdrawal(m.merchantId);

    const row = await getOrderRecord(orderId);
    expect(row.merchantCreditStatus).toBe('HELD');
    expect(new Date(row.merchantCreditHoldUntil).getTime()).toBeLessThan(Date.now());
    // And the stake is genuinely locked, so a settlement that reaches
    // `releaseWithdrawal` can actually complete rather than throwing.
    const bal = await getBalancesPaise(row.userId);
    expect(bal.lockedBalance, 'the fixture never locked a stake').toBe(100_000);
  });

  it('DOES NOT SETTLE once the player has disputed it', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId, who } = await heldWithdrawal(m.merchantId);

    const raised = await as(playerApp, who).post(`/order/${orderId}/dispute`)
      .send({ reason: 'The merchant marked this sent and nothing reached my bank.' });
    expect(raised.status, raised.body?.message).toBe(200);
    expect((await getOrderRecord(orderId)).state).toBe('DISPUTED');

    const before = await getBalancesPaise(who.userId);
    await settleDueHolds({ limit: 200 });
    const after = await getOrderRecord(orderId);

    // The assertion that matters, written as the CORRECT expectation so it
    // fails until the behaviour is right rather than freezing what it is.
    expect(
      after.merchantCreditStatus,
      'the worker settled a withdrawal the player is disputing — the hold exists '
      + 'so a dispute is a reversal rather than a clawback, and settling it makes '
      + 'the dispute about money that has already moved',
    ).not.toBe('RELEASED');

    // And the player's locked stake is still theirs to have returned.
    const bal = await getBalancesPaise(who.userId);
    expect(bal.lockedBalance ?? before.lockedBalance).toBe(before.lockedBalance);
    expect(after.state).toBe('DISPUTED');
  });

  it('is refused by settleHold DIRECTLY, not only by the sweep', async () => {
    // The two guards are deliberately independent — the WHERE in `findDueHolds`
    // and an eligibility check in `settleHold` — because `settleHold` is
    // exported and callable on its own. Each covers the other, which means a
    // test that only drives the sweep cannot tell you when one of them
    // regresses. This one names the second.
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId, who } = await heldWithdrawal(m.merchantId);

    await as(playerApp, who).post(`/order/${orderId}/dispute`)
      .send({ reason: 'Marked sent, nothing arrived.' });

    expect(await settleHold(orderId), 'settleHold settled a disputed withdrawal').toBe(false);
    expect((await getOrderRecord(orderId)).merchantCreditStatus).toBe('HELD');
  });

  it('an UNDISPUTED hold still settles — the fix must not stop the ordinary case', async () => {
    // The mirror. A change that simply stops the worker settling anything would
    // pass the test above and break every honest payout.
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await heldWithdrawal(m.merchantId);

    await settleDueHolds({ limit: 200 });

    const after = await getOrderRecord(orderId);
    expect(after.merchantCreditStatus, 'an ordinary due hold did not settle').not.toBe('HELD');
  });
});
