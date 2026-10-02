// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The amounts the cash rail deals in — and that both directions are held to
 * them.
 *
 * ── What changed (PROJECT_STATUS §3.10, 2c) ─────────────────────────────────
 * This suite used to prove ONE MERCHANT, ONE DENOMINATION: a column on
 * `merchants`, a CHECK duplicating the list, an admin route that set it, and a
 * selector that offered a cash order only to a merchant approved for that
 * exact amount. All of that is gone. Nobody is approved for an amount any
 * more: a cash order goes to a member of a CASH team who has pressed Ready
 * (`railSnapshotPg` drives that through the router). Withdrawal SPLITTING is
 * gone too (owner, 2026-10-02: one withdrawal is one payout), and with it the
 * legs, the floor and the ₹40,000 payout tier.
 *
 * ── What still holds, and is asserted here ──────────────────────────────────
 * 1. The list itself, and the ceiling derived from it rather than stated twice.
 * 2. A cash-rail WITHDRAWAL must be one of the buy denominations — a machine
 *    pays out a note-run, not an amount — and is refused by name BEFORE any of
 *    the player's money is locked. Discovering it after the lock would mean
 *    unwinding a committed movement.
 * 3. Above the ceiling a withdrawal is UPI/bank and held to no ladder.
 *
 * The buy side of rule 2 — a cash buy that is not a denomination is refused —
 * is asserted where the buy path's admission lives, in `buyLimitsPg`.
 *
 * Nobody is routed here: every team member in the database is put offline, so
 * each admitted withdrawal waits queued with its stake locked and no member.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { PAYMENT_MODES } from '#db/repositories/orderRails.js';
import { createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import {
  CASH_DENOMINATIONS_PAISE, BUY_DENOMINATIONS_PAISE, MAX_CASH_BUY_PAISE,
  isCashDenomination, isBuyDenomination,
} from '../../domains/merchant/denominations.js';
import { teamFixture } from '../teamFixture.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the amounts the cash rail deals in', () => {
  const teams = teamFixture();
  const orders = [];
  let priorFee;

  beforeAll(async () => {
    await applySchema();
    await teams.onlyOnline([]);
    // A payout fee makes the cash paid out smaller than the tokens given up,
    // and it is the CASH figure a machine must be able to dispense. So the fee
    // this suite reasons about is set here rather than read from whatever the
    // database holds (§32 S19), and put back afterwards (trap 10).
    priorFee = (await getSystemConfig())?.payoutFeePercent;
    if (priorFee !== 0) await applySystemConfig({ payoutFeePercent: 0 }, { actor: 'denominations-suite' });
  }, 60_000);

  afterAll(async () => {
    if (priorFee !== undefined && priorFee !== 0) {
      await applySystemConfig({ payoutFeePercent: priorFee }, { actor: 'denominations-suite' });
    }
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await closePg();
  });

  /** A player who can withdraw: bank details, and winnings. */
  const withdrawer = async (winningsRupees) => {
    const player = await actor({});
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(
      player.userId, winningsRupees, 'denominations suite seed', 'Test',
      `seed_${player.userId}`, `dn_seed_${player.userId}`,
    );
    return player;
  };

  const sell = async (userId, rupees) => {
    const out = await createWithdrawalOrder(userId, rupees);
    orders.push(out.order.orderId);
    return out.order;
  };

  // ── The list ──────────────────────────────────────────────────────────────
  it('deals in five amounts, of which a cash order may be the four up to the ceiling', () => {
    expect(CASH_DENOMINATIONS_PAISE).toEqual([50_000, 100_000, 500_000, 1_000_000, 4_000_000]);
    // Derived from the list, never a second statement of it.
    expect(BUY_DENOMINATIONS_PAISE).toEqual(CASH_DENOMINATIONS_PAISE.filter((p) => p <= MAX_CASH_BUY_PAISE));
    expect(BUY_DENOMINATIONS_PAISE).toEqual([50_000, 100_000, 500_000, 1_000_000]);
    expect(Math.max(...BUY_DENOMINATIONS_PAISE)).toBe(MAX_CASH_BUY_PAISE);

    // ₹40,000 is a machine's note-run but above the ceiling, so it is never a
    // cash ORDER — a check that merely asked "is this a denomination" would
    // let it through, which is why there are two predicates.
    expect(isCashDenomination(4_000_000)).toBe(true);
    expect(isBuyDenomination(4_000_000)).toBe(false);
    for (const bad of [0, 1, 999, 25_000, 200_000, '50000x']) {
      expect(isCashDenomination(bad)).toBe(false);
      expect(isBuyDenomination(bad)).toBe(false);
    }
    // A string of the right digits is the same amount: callers pass both.
    expect(isBuyDenomination('500000')).toBe(true);
  });

  // ── A cash withdrawal is a note-run ──────────────────────────────────────
  it('refuses a cash-rail withdrawal that is not a denomination, before any money is locked', async () => {
    const player = await withdrawer(5_000);
    const before = await getBalancesPaise(player.userId);

    // ₹1,500 passes min/max and multiples-of-ten. No machine pays it out.
    await expect(sell(player.userId, 1_500)).rejects.toMatchObject({ status: 400, code: 'NOT_A_CASH_AMOUNT' });
    // And says what they CAN take, not only what they cannot (§25).
    await expect(sell(player.userId, 1_500)).rejects.toThrow(/₹500, ₹1,000, ₹5,000, ₹10,000/);

    // Refused BEFORE the lock: not a paisa moved from winnings.
    expect(await getBalancesPaise(player.userId)).toEqual(before);
  });

  it('admits a cash-rail withdrawal that is a denomination, locking exactly its stake', async () => {
    // The opposite case (§37 step 6) — a guard that refused every cash sell
    // would pass the test above.
    const player = await withdrawer(5_000);
    const before = await getBalancesPaise(player.userId);

    const order = await sell(player.userId, 1_000);
    const row = await getOrderRecord(order.orderId);
    expect(row.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
    expect(row.status).toBe('PENDING_QUEUE');
    expect(row.escrowLocked).toBe(true);

    const after = await getBalancesPaise(player.userId);
    expect(before.winningsBalance - after.winningsBalance).toBe(1_000_00);
    expect(after.lockedBalance - before.lockedBalance).toBe(1_000_00);
  });

  it('holds a withdrawal above the ceiling to no ladder — it is UPI/bank', async () => {
    // ₹12,340 is no machine's amount, and above ₹10,000 it does not need to be.
    // The neighbour of the refusal above: the same rule must not leak onto the
    // rail where there is no machine.
    const player = await withdrawer(20_000);
    const order = await sell(player.userId, 12_340);
    const row = await getOrderRecord(order.orderId);
    expect(row.paymentMode).toBe(PAYMENT_MODES.P2P_UPI);
    expect(row.tokenAmount).toBe(12_340);
  });
});
