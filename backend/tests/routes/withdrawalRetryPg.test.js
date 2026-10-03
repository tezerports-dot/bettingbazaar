// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Retrying an expired WITHDRAWAL twice, and the tokens the second attempt locks.
 *
 * ── Why a sell needs its own suite ─────────────────────────────────────────
 * `retryAndMatchPg.test.js` retries BUYS, and on a buy the one-open-buy rule
 * refuses a duplicate before anything is written. A SELL has no such rule — a
 * player may hold several withdrawals at once — so the only thing standing
 * between one expired withdrawal and two retries of it is the partial UNIQUE
 * on `retry_of_order_id`.
 *
 * That index is reached at INSERT. On a withdrawal the escrow debit (winnings
 * → locked) has already COMMITTED by then, so a refusal there is §21's shape
 * exactly: a write that follows a commit, failing. The row that is left says
 * "locked" and no order exists to ever release it.
 *
 * The assertions are therefore about the WALLET, not the response: a second
 * retry may be refused however it likes, but it must leave the player's
 * winnings and locked balance exactly where the first retry left them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getBalances } from '#db/repositories/wallets.js';
import { updateUser } from '#db/repositories/users.js';
import { PAYMENT_MODES } from '#db/repositories/teamRouting.js';
import { retryOrder } from '../../domains/payment/paymentProcessing.service.js';
import { cancelOrder as cancelState } from '../../domains/payment/orderLifecycle.service.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('retrying an expired withdrawal', () => {
  let seq = 0;
  // Every player this run made, so their orders can be removed afterwards: a
  // queued withdrawal left behind is offered to the next suite's team (trap 10).
  const players = [];
  const oid = () => `wr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  /** A player who can withdraw: bank details, and winnings. */
  const withdrawer = async (winningsRupees) => {
    const player = await actor({});
    players.push(player.userId);
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(
      player.userId, winningsRupees, 'withdrawal retry suite seed', 'Test',
      `seed_${player.userId}`, `wr_seed_${player.userId}`,
    );
    return player;
  };

  /** A withdrawal nobody served: it ended CANCELLED/EXPIRED holding nothing. */
  const expiredSell = async (player, rupees) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: rupees, fiatAmountRupees: rupees, state: 'PENDING_QUEUE',
    });
    await cancelState(orderId, { set: { cancelReason: 'EXPIRED', cancelledAt: new Date() } });
    return orderId;
  };

  // ₹1,000 is a cash denomination, so the rail is CASH — derived from the size
  // of the order, never from a switch (PROJECT_STATUS §3.10, 2c). There is no
  // splitting any more, so one withdrawal is one order and one lock, and what
  // this measures is the retry and nothing else.
  beforeAll(async () => { await applySchema(); }, 60_000);

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
    await closePg();
  });

  it('a first retry locks the withdrawal once', async () => {
    const player = await withdrawer(2_000);
    const expired = await expiredSell(player, 1_000);
    const before = await getBalances(player.userId);

    const result = await retryOrder(player.userId, expired);
    const fresh = await getOrderRecord(result.order.orderId ?? result.order._id);
    expect(fresh.retryOfOrderId).toBe(expired);
    // One order, on the rail its size names — not parts of a split.
    expect(result).not.toHaveProperty('parts');
    expect(fresh.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);

    const after = await getBalances(player.userId);
    expect(Number(before.winningsBalance) - Number(after.winningsBalance)).toBe(1_000);
    expect(Number(after.lockedBalance) - Number(before.lockedBalance)).toBe(1_000);
  });

  it('a second retry of the same withdrawal is refused AND locks nothing', async () => {
    // Enough winnings for the second debit to succeed — which is exactly the
    // case where a debit that runs before the duplicate is noticed strands it.
    const player = await withdrawer(2_000);
    const expired = await expiredSell(player, 1_000);
    await retryOrder(player.userId, expired);
    const afterFirst = await getBalances(player.userId);

    await expect(retryOrder(player.userId, expired)).rejects.toBeTruthy();

    const afterSecond = await getBalances(player.userId);
    expect(Number(afterSecond.winningsBalance)).toBe(Number(afterFirst.winningsBalance));
    expect(Number(afterSecond.lockedBalance)).toBe(Number(afterFirst.lockedBalance));
  });

  it('two retries arriving together create one withdrawal and lock it once', async () => {
    const player = await withdrawer(2_000);
    const expired = await expiredSell(player, 1_000);
    const before = await getBalances(player.userId);

    const results = await Promise.allSettled([
      retryOrder(player.userId, expired),
      retryOrder(player.userId, expired),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const after = await getBalances(player.userId);
    expect(Number(before.winningsBalance) - Number(after.winningsBalance)).toBe(1_000);
    expect(Number(after.lockedBalance) - Number(before.lockedBalance)).toBe(1_000);
  });
});
