// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A dispute raised WHILE the hold worker is settling that withdrawal.
 *
 * `disputedHoldPg` proves a withdrawal disputed BEFORE the worker looks at it
 * does not settle: `findDueHolds` excludes DISPUTED in its WHERE and
 * `settleHold` repeats the check. Both are READS. This file asks §0.5's second
 * question of them — is the check a snapshot or a guarantee — by putting the
 * dispute in the gap between `settleHold` reading the order and the settlement
 * committing, and then asking what the row says and where the money went.
 *
 * The gap is made deterministic, not hoped for: the test holds the merchant's
 * wallet row (the first lock the settlement transaction takes), so
 * `settleHold` has already passed its DISPUTED check and is parked on the
 * lock when the player's dispute lands. Then the lock is released.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { creditWinnings, lockWithdrawal } from '../../domains/wallet/walletAuthority.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

/** Resolve once some backend is waiting on a lock for a statement matching `like`. */
async function untilBlocked(like, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pgQuery(
      `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE $1 LIMIT 1`,
      [like]);
    if (rows.length) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`nothing blocked on ${like} within ${timeoutMs}ms — the interleaving never happened`);
}

describePg('a dispute that lands while the hold is being settled', () => {
  let playerApp;
  const RUN = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    await applySchema();
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  let seq = 0;
  /** A due held withdrawal with a genuinely locked stake (see disputedHoldPg). */
  const dueHold = async () => {
    seq += 1;
    const m = await merchantActor({ tokensRupees: 5000 });
    const who = await actor({});
    const orderId = `RACE-${RUN}-${seq}`;
    await creditWinnings(who.userId, 1000, 'race float', 'Test', orderId, `rf_${orderId}`);
    await lockWithdrawal(who.userId, 1000, orderId);
    await createOrderRecord({
      orderId, userId: who.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000, state: 'PAID',
      merchantId: m.merchantId, paidAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    await setOrderFields(orderId, {
      merchantCreditStatus: 'HELD',
      merchantCreditHoldUntil: new Date(Date.now() - 60 * 1000),
      escrowLocked: true,
    });
    const lockedBefore = (await getBalancesPaise(who.userId)).lockedBalance;
    expect(lockedBefore, 'the fixture never locked a stake').toBe(100_000);
    return { m, who, orderId, lockedBefore };
  };

  /** Hold one row lock in its own transaction until `release()` is called. */
  const holdRow = async (sql, params) => {
    let release;
    const released = new Promise((r) => { release = r; });
    let locked;
    const isLocked = new Promise((r) => { locked = r; });
    const done = withTransaction(async (client) => {
      await client.query(sql, params);
      locked();
      await released;
    });
    await isLocked;
    return async () => { release(); await done; };
  };

  it('is not settled underneath, and is not erased from the dispute queue', async () => {
    const { m, who, orderId, lockedBefore } = await dueHold();

    // Hold the merchant's wallet row: the settlement transaction's first lock.
    const unlock = await holdRow('SELECT 1 FROM merchant_wallets WHERE merchant_id = $1 FOR UPDATE', [m.merchantId]);

    // The worker reads the order (PAID, not disputed), then parks on the lock.
    const settling = settleHold(orderId);
    await untilBlocked('%merchant_wallets%FOR UPDATE%');

    // The player disputes in the gap.
    const raised = await as(playerApp, who).post(`/order/${orderId}/dispute`)
      .send({ reason: 'Marked sent, nothing reached my bank.' });
    expect(raised.status, raised.body?.message).toBe(200);

    await unlock();
    await settling.catch(() => false);

    const after = await getOrderRecord(orderId);
    // The dispute is still an open dispute — not written over with COMPLETED.
    expect(after.state, 'the settlement mirror wrote over an open dispute').toBe('DISPUTED');
    // And no money moved under it: the stake is still locked, the merchant was
    // not credited. A dispute raised in time is a REVERSAL, not a clawback.
    expect(after.merchantCreditStatus, 'the worker settled a withdrawal disputed in time').not.toBe('RELEASED');
    expect((await getBalancesPaise(who.userId)).lockedBalance).toBe(lockedBefore);
  });

  it('a dispute landing AFTER the settlement committed stays an open dispute over money that moved', async () => {
    // The other interleaving. The settlement commits (tokens to the merchant),
    // then the worker parks on the PLAYER's wallet — releasing their stake —
    // and the dispute lands before the order is mirrored. The money moving is
    // correct: the settlement won the lock first. Erasing the dispute is not.
    const { who, orderId } = await dueHold();

    const unlock = await holdRow('SELECT 1 FROM wallets WHERE user_id = $1 FOR UPDATE', [who.userId]);
    const settling = settleHold(orderId);
    await untilBlocked('%FROM wallets WHERE user_id%FOR UPDATE%');

    const raised = await as(playerApp, who).post(`/order/${orderId}/dispute`)
      .send({ reason: 'Marked sent, nothing reached my bank.' });
    expect(raised.status, raised.body?.message).toBe(200);

    await unlock();
    await settling.catch(() => false);

    const after = await getOrderRecord(orderId);
    expect(after.state, 'the mirror wrote COMPLETED over a dispute raised after settlement').toBe('DISPUTED');
    // The credit status tells the truth about the money, so the admin who picks
    // the dispute up is resolving a clawback, not a hold.
    expect(after.merchantCreditStatus).toBe('RELEASED');
    expect((await getBalancesPaise(who.userId)).lockedBalance).toBe(0);
  });
});
