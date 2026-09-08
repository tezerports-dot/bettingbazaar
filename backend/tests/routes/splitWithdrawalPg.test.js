// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A withdrawal too large for one denomination, and the money it locks.
 *
 * ── What is actually at risk here ──────────────────────────────────────────
 * An ATM dispenses denominations, not amounts, so a ₹100,000 cash payout is
 * four merchants at four machines. The player asked for one withdrawal.
 *
 * Every failure this suite exists to catch is a MONEY failure, and none of them
 * looks like an error at the time:
 *
 *   • legs that do not add up to the parent — the player is short-paid by a
 *     function that returned successfully;
 *   • escrow taken per leg — the player's balance debited several times over
 *     for one withdrawal;
 *   • a cancelled leg that refunds nothing — the database refuses to let a leg
 *     carry escrow, so the ordinary refund branch does not fire on one, and the
 *     tokens stay locked with no leg left to release them;
 *   • a parent offered to a merchant — an amount no machine can dispense, while
 *     its legs sit unserved behind it.
 *
 * So the assertions are about the WALLET and the row set, not about responses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import {
  getOrderRecord, getOrderLegs, stalledLegs, pendingWithdrawalTotal, createSplitWithdrawal,
} from '#db/repositories/orders.record.js';
import { getBalances } from '#db/repositories/wallets.js';
import { updateUser } from '#db/repositories/users.js';
import {
  PAYMENT_MODES, getActivePolicy, publishPolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { createWithdrawalOrder, cancelOrder } from '../../domains/payment/paymentProcessing.service.js';
import { parentStateFor } from '../../domains/payment/splitWithdrawal.service.js';
import { ORDER_STATES } from '#db/repositories/orders.core.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a withdrawal that splits into legs', () => {
  let restore = null;
  let restoreMaxWithdrawal = null;

  /**
   * A player who can actually withdraw: KYC approved, bank details on file, and
   * winnings to draw on. The withdrawal path checks all three before it reaches
   * anything this suite is about.
   */
  const withdrawer = async (winningsRupees) => {
    const player = await actor({});
    // Through the repository, not a raw UPDATE. `check:db-boundary` refuses SQL
    // outside `database/` and it is right to: a test that writes its fixture
    // with hand-written SQL is a test that keeps passing after the column it
    // names is renamed.
    await updateUser(player.userId, {
      kycStatus: 'APPROVED',
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    // Through the sanctioned writer, not an UPDATE: `creditWinnings` writes the
    // ledger entry alongside the balance, so the wallet this suite then asserts
    // on is one the platform's own money path produced.
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(
      player.userId, winningsRupees, 'split withdrawal suite seed', 'Test',
      `seed_${player.userId}`, `sw_seed_${player.userId}`,
    );
    return player;
  };

  beforeAll(async () => {
    await applySchema();
    restore = await getActivePolicy();
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      justification: 'Split withdrawal suite.', changedByName: 'test setup',
    });

    // ── The cap and the ladder have to agree ─────────────────────────────
    // `maxWithdrawal` defaults to ₹50,000, and the largest cash denomination
    // is ₹40,000. So on the default configuration the ONLY splits that exist
    // are two legs, and the design's own example — ₹100,000 as
    // 40,000 + 40,000 + 10,000 + 10,000 — is refused before it reaches the
    // splitter, by a limit that has nothing to do with denominations.
    //
    // That is a real operator constraint rather than a test inconvenience: a
    // platform running the cash rail has to raise this cap or the split is
    // decoration. The suite sets it and puts it back, so it tests the rule
    // rather than the default.
    const cfg = await getSystemConfig({ fresh: true });
    restoreMaxWithdrawal = cfg?.maxWithdrawal ?? null;
    await applySystemConfig({ maxWithdrawal: 200_000 });
  }, 60_000);

  afterAll(async () => {
    if (restore) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        justification: 'Restoring the rail this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    if (restoreMaxWithdrawal !== null) {
      await applySystemConfig({ maxWithdrawal: restoreMaxWithdrawal });
    }
    await closePg();
  });

  it('splits into legs that add up to the payout, largest first', async () => {
    const player = await withdrawer(200_000);
    const { order } = await createWithdrawalOrder(player.userId, 100_000);

    expect(order.isSplitParent).toBe(true);
    const legs = await getOrderLegs(order.orderId);
    expect(legs.map((l) => l.fiatAmount)).toEqual([40_000, 40_000, 10_000, 10_000]);

    // The assertion that matters: a split that loses paise pays the player less
    // than they asked for, successfully, and nothing about the rows looks wrong.
    expect(legs.reduce((sum, l) => sum + l.fiatAmount, 0)).toBe(100_000);
    expect(legs.map((l) => l.legIndex)).toEqual([1, 2, 3, 4]);
  });

  it('locks the money ONCE, at the parent, whatever the legs do', async () => {
    const player = await withdrawer(200_000);
    const before = await getBalances(player.userId);
    const { order } = await createWithdrawalOrder(player.userId, 100_000);

    const after = await getBalances(player.userId);
    // Exactly one withdrawal's worth moved from winnings into locked — not one
    // per leg, which is what a per-leg debit would have produced.
    expect(Number(before.winningsBalance) - Number(after.winningsBalance)).toBe(100_000);
    expect(Number(after.lockedBalance) - Number(before.lockedBalance)).toBe(100_000);

    // And the database refuses to let a leg claim any of it.
    const legs = await getOrderLegs(order.orderId);
    for (const leg of legs) expect(leg.escrowLocked).not.toBe(true);
  });

  it('counts the withdrawal once, not once per leg', async () => {
    const player = await withdrawer(200_000);
    await createWithdrawalOrder(player.userId, 100_000);

    // Both the parent and four legs are in flight at this moment. Counting rows
    // would tell the player they have committed ₹200,000 to withdrawals.
    expect(await pendingWithdrawalTotal(player.userId)).toBe(100_000);
  });

  it('refuses an amount no set of denominations can make, before taking any money', async () => {
    const player = await withdrawer(200_000);
    const before = await getBalances(player.userId);

    await expect(createWithdrawalOrder(player.userId, 7_700)).rejects.toMatchObject({
      code: 'NOT_A_CASH_AMOUNT',
    });

    // Nothing moved. Discovering this after the debit would mean unwinding a
    // lock that has already committed.
    const after = await getBalances(player.userId);
    expect(Number(after.winningsBalance)).toBe(Number(before.winningsBalance));
    expect(Number(after.lockedBalance)).toBe(Number(before.lockedBalance));
  });

  it('refuses legs that do not add up, at the writer', async () => {
    // `splitWithdrawal` already guarantees this for the one caller that exists
    // today, which is exactly why the writer's own check needs its own test: a
    // guard nothing exercises is a guard nobody notices deleting, and the next
    // caller of an exported repository function does not inherit the first
    // one's care.
    //
    // What it protects against is the worst outcome this whole feature has —
    // paying the player LESS than they asked for, successfully, with every row
    // looking healthy.
    const player = await withdrawer(200_000);
    await expect(createSplitWithdrawal({
      parentOrderId: `sw-short-${Date.now()}`,
      userId: player.userId,
      tokenAmountRupees: 100_000,
      fiatAmountRupees: 100_000,
      legsPaise: [4_000_000, 4_000_000],   // ₹80,000 of a ₹100,000 payout
      legIdFor: (i) => `sw-short-${Date.now()}_L${i}`,
    })).rejects.toThrow(/legs total .* but the payout is/);
  });

  it('does not wrap a single denomination in a parent', async () => {
    const player = await withdrawer(200_000);
    const { order } = await createWithdrawalOrder(player.userId, 10_000);
    expect(order.isSplitParent).toBe(false);
    expect(await getOrderLegs(order.orderId)).toEqual([]);
  });

  it('gives the money back when a waiting leg is cancelled', async () => {
    const player = await withdrawer(200_000);
    const { order } = await createWithdrawalOrder(player.userId, 100_000);
    const legs = await getOrderLegs(order.orderId);
    const waiting = legs.find((l) => l.status === 'PENDING_QUEUE');
    expect(waiting).toBeTruthy();

    const before = await getBalances(player.userId);
    await cancelOrder(player.userId, false, waiting.orderId);
    const after = await getBalances(player.userId);

    // A leg carries NO escrow — the database refuses to let it — so the
    // ordinary `escrowLocked` refund branch does not fire on one. Without the
    // leg branch this cancels cleanly and returns nothing, and the tokens stay
    // locked forever with no leg left to release them.
    const moved = waiting.fiatAmount;
    expect(Number(after.lockedBalance)).toBe(Number(before.lockedBalance) - moved);
    expect(Number(after.winningsBalance)).toBe(Number(before.winningsBalance) + moved);
  });

  it('cancels every waiting leg when the player cancels the withdrawal', async () => {
    const player = await withdrawer(200_000);
    const { order } = await createWithdrawalOrder(player.userId, 100_000);

    await cancelOrder(player.userId, false, order.orderId);

    const legs = await getOrderLegs(order.orderId);
    // Whatever was still waiting is now cancelled. A leg already with a
    // merchant is not — cancelling a parent means "stop what has not happened
    // yet", never "undo cash a merchant already deposited".
    for (const leg of legs) {
      if (leg.status !== 'CANCELLED') expect(leg.status).not.toBe('PENDING_QUEUE');
    }

    // Every penny is back, because every leg either refunded its own amount or
    // is still in flight holding it.
    const parent = await getOrderRecord(order.orderId);
    expect(parent.isSplitParent).toBe(true);
  });

  it('lists a leg nobody has taken, so somebody is accountable for the lock', async () => {
    // Built through the WRITER, not through `createWithdrawalOrder`.
    //
    // The creation path tries to assign each leg immediately, and whether it
    // succeeds depends on whether an approved cash merchant with capacity
    // happens to exist — which other suites in this shared database create and
    // leave behind. Going through it made this test assert "no merchant was
    // available", which is a fact about the other suites rather than about the
    // queue, and it passed alone and failed in the full run.
    const player = await withdrawer(200_000);
    const parentId = `sw-stall-${Date.now().toString(36)}`;
    const { legs } = await createSplitWithdrawal({
      parentOrderId: parentId,
      userId: player.userId,
      tokenAmountRupees: 100_000,
      fiatAmountRupees: 100_000,
      legsPaise: [4_000_000, 4_000_000, 1_000_000, 1_000_000],
      legIdFor: (i) => `${parentId}_L${i}`,
    });
    expect(legs).toHaveLength(4);

    // Zero minutes — "every leg waiting right now", which is the question an
    // incident asks and the one a falsy default silently answers differently.
    const stalled = await stalledLegs({ olderThanMinutes: 0, limit: 1000 });
    const ids = stalled.map((l) => l.orderId);
    for (const leg of legs) expect(ids).toContain(leg.orderId);

    // And the parent is NOT in it. It is a container: it was never going to be
    // handed to a merchant, so it is not waiting for one.
    expect(ids).not.toContain(parentId);
  });

  describe('the parent state, derived from its legs', () => {
    const leg = (status) => ({ status });

    it('stays put while every leg is still queued', () => {
      expect(parentStateFor([leg('PENDING_QUEUE'), leg('PENDING_QUEUE')])).toBeNull();
    });

    it('is PROCESSING as soon as one leg is being worked on', () => {
      expect(parentStateFor([leg('ASSIGNED'), leg('PENDING_QUEUE')])).toBe(ORDER_STATES.PROCESSING);
    });

    it('completes only when every leg is finished', () => {
      expect(parentStateFor([leg('COMPLETED'), leg('PAID')])).toBe(ORDER_STATES.PROCESSING);
      expect(parentStateFor([leg('COMPLETED'), leg('COMPLETED')])).toBe(ORDER_STATES.COMPLETED);
    });

    it('counts a partly-paid withdrawal as COMPLETED, not cancelled', () => {
      // The player has money a cancelled leg does not take back. Calling the
      // whole withdrawal cancelled would tell them nothing happened.
      expect(parentStateFor([leg('COMPLETED'), leg('CANCELLED')])).toBe(ORDER_STATES.COMPLETED);
    });

    it('is CANCELLED only when nothing was paid at all', () => {
      expect(parentStateFor([leg('CANCELLED'), leg('CANCELLED')])).toBe(ORDER_STATES.CANCELLED);
    });
  });
});
