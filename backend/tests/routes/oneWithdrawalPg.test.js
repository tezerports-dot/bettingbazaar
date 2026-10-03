// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * One withdrawal is ONE order — and the money it locks.
 *
 * ── Why it is one ───────────────────────────────────────────────────────────
 * The owner removed splitting (PROJECT_STATUS §3.10, 2026-10-02) and, in 2d,
 * made every order exactly one of a fixed list of sizes: the size puts it on
 * its rail, and one withdrawal is one bank payout (2026-10-03).
 *
 * ── What is still protected here, and why it is the same worry ─────────────
 * Every failure here is a MONEY failure and none of them looks like an error:
 *
 *   • a withdrawal locked more or less than once — the split's old risk, and
 *     still the risk of any path that writes more than one order per request;
 *   • an amount that is not an order size accepted onto a rail, where no team
 *     is organised to serve it, with the player's tokens locked behind it;
 *   • a waiting withdrawal that refunds nothing when it is cancelled;
 *   • a withdrawal nobody has taken that no queue shows anybody.
 *
 * So the assertions are about the WALLET and the row set, not about responses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import {
  getOrderRecord, stalledWithdrawals, pendingWithdrawalTotal,
} from '#db/repositories/orders.record.js';
import { getBalances } from '#db/repositories/wallets.js';
import { updateUser } from '#db/repositories/users.js';
import { PAYMENT_MODES } from '#db/repositories/teamRouting.js';
import { createWithdrawalOrder, cancelOrder } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('one withdrawal is one order', () => {
  const teams = teamFixture();
  // Every player this run made, so their orders can be removed afterwards: a
  // queued withdrawal left behind is offered to the next suite's team (trap 10).
  const players = [];

  /**
   * A player who can actually withdraw: bank details on file, and winnings to
   * draw on. The withdrawal path checks both before it reaches anything this
   * suite is about.
   */
  const withdrawer = async (winningsRupees) => {
    const player = await actor({});
    players.push(player.userId);
    // Through the repository, not raw SQL — a fixture written in hand-rolled
    // SQL keeps passing after the column it names is renamed.
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(
      player.userId, winningsRupees, 'single withdrawal suite seed', 'Test',
      `seed_${player.userId}`, `sw_seed_${player.userId}`,
    );
    return player;
  };

  beforeAll(async () => {
    await applySchema();
    // Nobody online in any team, so every withdrawal here WAITS in the queue —
    // the state the cancel and the stalled-queue cases are about. Otherwise a
    // team another suite left online would take them, and the case would be
    // measuring that team rather than the queue.
    await teams.onlyOnline([]);
  }, 60_000);

  afterAll(async () => {
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await pgQuery('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await teams.cleanup();
    await closePg();
  });

  /** The order a withdrawal request produced: there is exactly one. */
  const orderOf = (result) => {
    expect(result.order, 'a withdrawal answered with no order').toBeTruthy();
    // One request, one order: nothing in the answer may describe siblings.
    expect(result).not.toHaveProperty('parts');
    return result.order.orderId ?? result.order._id;
  };

  it('creates ONE withdrawal of a bank-rail size, for the whole amount', async () => {
    // 50,000 tokens is the smallest UPI/bank size (PROJECT_STATUS §3.10, 2d).
    const player = await withdrawer(100_000);
    const row = await getOrderRecord(orderOf(await createWithdrawalOrder(player.userId, 50_000)));
    expect(row.type).toBe('WITHDRAWAL');
    expect(row.paymentMode).toBe(PAYMENT_MODES.P2P_UPI);
    expect(row.tokenAmount).toBe(50_000);
    expect(row.escrowLocked).toBe(true);
  });

  it('locks exactly the withdrawal, once', async () => {
    const player = await withdrawer(100_000);
    const before = await getBalances(player.userId);
    await createWithdrawalOrder(player.userId, 50_000);
    const after = await getBalances(player.userId);

    // Both sides of the one movement: out of winnings, into locked. Not twice
    // the amount (a second write for the same request) and not none.
    expect(Number(before.winningsBalance) - Number(after.winningsBalance)).toBe(50_000);
    expect(Number(after.lockedBalance) - Number(before.lockedBalance)).toBe(50_000);
  });

  it('counts the withdrawal once — there is nothing to double-count', async () => {
    const player = await withdrawer(100_000);
    await createWithdrawalOrder(player.userId, 50_000);
    expect(await pendingWithdrawalTotal(player.userId)).toBe(50_000);
  });

  it.each([
    ['under the cash ceiling', 7_700],
    ['between the two rails', 45_000],
    ['above every size', 600_000],
  ])('refuses an amount that is not an order size (%s), before taking any money', async (_, amount) => {
    const player = await withdrawer(700_000);
    const before = await getBalances(player.userId);

    await expect(createWithdrawalOrder(player.userId, amount)).rejects.toMatchObject({
      code: 'NOT_AN_ORDER_SIZE', status: 400,
    });

    // Nothing moved. Discovering this after a debit means unwinding a lock that
    // has already committed.
    const after = await getBalances(player.userId);
    expect(Number(after.winningsBalance)).toBe(Number(before.winningsBalance));
    expect(Number(after.lockedBalance)).toBe(Number(before.lockedBalance));
    expect(await pendingWithdrawalTotal(player.userId)).toBe(0);
  });

  it('creates a single CASH-rail withdrawal for a cash size', async () => {
    // The cash team serves it; the member still pays by bank transfer (owner,
    // 2026-10-03: every sell is paid to the player's bank account).
    const player = await withdrawer(20_000);
    const row = await getOrderRecord(orderOf(await createWithdrawalOrder(player.userId, 10_000)));
    expect(row.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
    expect(row.tokenAmount).toBe(10_000);
  });

  it('gives the money back when a waiting withdrawal is cancelled', async () => {
    const player = await withdrawer(20_000);
    const orderId = orderOf(await createWithdrawalOrder(player.userId, 5_000));
    expect((await getOrderRecord(orderId)).status).toBe('PENDING_QUEUE');

    const before = await getBalances(player.userId);
    await cancelOrder(player.userId, false, orderId);
    const after = await getBalances(player.userId);

    // Both sides: the lock comes down and winnings go back up by the same.
    expect(Number(after.lockedBalance)).toBe(Number(before.lockedBalance) - 5_000);
    expect(Number(after.winningsBalance)).toBe(Number(before.winningsBalance) + 5_000);
    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('CANCELLED');
    expect(row.escrowStatus).toBe('REFUNDED');
  });

  it('lists a withdrawal nobody has taken, so somebody is accountable for the lock', async () => {
    const player = await withdrawer(20_000);
    const orderId = orderOf(await createWithdrawalOrder(player.userId, 5_000));

    // Zero minutes — "everything waiting right now", the question an incident
    // asks and the one a falsy default silently answers differently.
    const stalled = await stalledWithdrawals({ olderThanMinutes: 0, limit: 1000 });
    expect(stalled.map((o) => o.orderId)).toContain(orderId);
  });
});
