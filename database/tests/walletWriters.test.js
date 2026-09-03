// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The four order-facing wallet writers, against a REAL PostgreSQL.
 *
 * ── What this replaces, and why it is not the same test ─────────────────────
 * There was a unit suite over the same four writers on the document-store path,
 * with the data layer MOCKED. It existed because a refactor had rewritten `refId:
 * orderId` to a shorthand `refId` at four call sites while declaring the
 * variable at one — so deposits, reserve credits and withdrawals all threw
 * ReferenceError inside the transaction, and every one of them returned 500.
 * `node --check` passed, the unit suite passed, the Postgres suite passed. Only
 * a suite that ran the real bodies caught it.
 *
 * That module is deleted and the writers now live on PostgreSQL, so the tests
 * come with them — but against a real database rather than a mock. A mock of
 * the thing that breaks proves the mock works. Three of the four had some
 * incidental coverage elsewhere; `creditReserve` had NONE, which is the gap
 * that made writing this worth doing rather than deleting the old file.
 *
 * The assertions are about the LEDGER ROW each writer produces, because that
 * row is the audit record. A wrong field there is not cosmetic — it is a money
 * movement nobody can afterwards explain.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  creditDeposit, creditReserve, refundOrder, debitWinningsForWithdrawal, getBalances,
} from '../repositories/wallets.js';

const describePg = pgConfigured() ? describe : describe.skip;
const USER = 'wallet-writer-user';
const ORDER = 'ord_12345';

/** The ledger rows for a transaction id, in write order. */
async function ledgerFor(txId) {
  const { rows } = await pgQuery(
    `SELECT tx_id, field, tx_type, amount_paise, balance_before_paise,
            balance_after_paise, description, ref_id
       FROM wallet_ledger WHERE tx_id = $1 ORDER BY id`, [txId]);
  return rows;
}

describePg('the order-facing wallet writers (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE wallets, wallet_ledger RESTART IDENTITY CASCADE');
  });

  describe('creditDeposit', () => {
    it('credits the deposit pocket and writes one row that explains it', async () => {
      const r = await creditDeposit(USER, 25, ORDER);
      expect(r.depositAfter).toBe(25);

      const [row] = await ledgerFor(`dep_complete_${ORDER}`);
      expect(row).toMatchObject({
        field: 'depositBalance', amount_paise: '2500', ref_id: ORDER,
      });
      // The row must say what happened, in a form a human reading a dispute
      // can follow back to the order.
      expect(row.description).toContain(ORDER);
      expect(await getBalances(USER)).toMatchObject({ depositBalance: 25, winningsBalance: 0 });
    });

    it('is idempotent — a redelivered confirmation credits once', async () => {
      await creditDeposit(USER, 25, ORDER);
      const again = await creditDeposit(USER, 25, ORDER);
      expect(again.idempotent).toBe(true);
      expect((await getBalances(USER)).depositBalance).toBe(25);
      expect(await ledgerFor(`dep_complete_${ORDER}`)).toHaveLength(1);
    });
  });

  describe('creditReserve', () => {
    // This writer had NO coverage on either path. It allocates the reserve
    // portion of a deposit, and crediting the wrong pocket would make a
    // non-withdrawable balance withdrawable.
    it('credits the RESERVE pocket, not deposit or winnings', async () => {
      const r = await creditReserve(USER, 10, ORDER);
      expect(r.reserveAfter).toBe(10);

      const [row] = await ledgerFor(`reserve_credit_${ORDER}`);
      expect(row).toMatchObject({ field: 'reserveBalance', amount_paise: '1000' });

      const balances = await getBalances(USER);
      expect(balances.reserveBalance).toBe(10);
      expect(balances.depositBalance).toBe(0);
      expect(balances.winningsBalance).toBe(0);
    });

    it('is idempotent under the same order id', async () => {
      await creditReserve(USER, 10, ORDER);
      expect((await creditReserve(USER, 10, ORDER)).idempotent).toBe(true);
      expect((await getBalances(USER)).reserveBalance).toBe(10);
    });
  });

  describe('refundOrder', () => {
    it('credits back the field it was given, not a default', async () => {
      await creditDeposit(USER, 50, 'seed');
      await refundOrder(USER, 20, ORDER, 'winningsBalance');

      const [row] = await ledgerFor(`refund_${ORDER}`);
      expect(row.field).toBe('winningsBalance');
      const balances = await getBalances(USER);
      expect(balances.winningsBalance).toBe(20);
      expect(balances.depositBalance).toBe(50);   // untouched
    });

    it('accepts an order id that is not an object id at all', async () => {
      // The casino path passes a PROVIDER-supplied round id — an arbitrary
      // string. Casting it threw inside the transaction on the old path, so
      // every rollback and refund returned 500: no money lost, and no refund
      // ever succeeded either.
      const weird = 'round-42/xyz:provider';
      await expect(refundOrder(USER, 5, weird, 'depositBalance')).resolves.toMatchObject({ after: 5 });
      expect(await ledgerFor(`refund_${weird}`)).toHaveLength(1);
    });
  });

  describe('debitWinningsForWithdrawal', () => {
    it('takes from winnings and never from deposit', async () => {
      await creditDeposit(USER, 100, 'seed-dep');
      await pgQuery(
        `UPDATE wallets SET winnings_paise = 4000 WHERE user_id = $1`, [USER]);

      await debitWinningsForWithdrawal(USER, 30, ORDER);
      const balances = await getBalances(USER);
      expect(balances.winningsBalance).toBe(10);
      // Deposit is NOT withdrawable. A withdrawal that reached into it would
      // pay out money the player was never entitled to take.
      expect(balances.depositBalance).toBe(100);
    });

    it('REFUSES to overdraw winnings, and moves nothing when it refuses', async () => {
      await pgQuery(
        `INSERT INTO wallets (user_id, winnings_paise) VALUES ($1, 1000)`, [USER]);
      await expect(debitWinningsForWithdrawal(USER, 50, ORDER)).rejects.toThrow();
      expect((await getBalances(USER)).winningsBalance).toBe(10);
      expect(await ledgerFor(`wd_${ORDER}`)).toHaveLength(0);
    });
  });

  describe('every writer leaves the books explicable', () => {
    it('the ledger sums to the balance it produced', async () => {
      await creditDeposit(USER, 40, 'o1');
      await creditReserve(USER, 15, 'o2');
      await refundOrder(USER, 5, 'o3', 'depositBalance');

      const { rows } = await pgQuery(
        `SELECT field, SUM(CASE WHEN tx_type = 'CREDIT' THEN amount_paise ELSE -amount_paise END)::bigint AS net
           FROM wallet_ledger WHERE user_id = $1 GROUP BY field`, [USER]);
      const net = Object.fromEntries(rows.map((r) => [r.field, Number(r.net)]));

      const balances = await getBalances(USER);
      // A balance the ledger cannot explain is the P1 this whole design exists
      // to make impossible.
      expect(net.depositBalance).toBe(balances.depositBalance * 100);
      expect(net.reserveBalance).toBe(balances.reserveBalance * 100);
    });
  });
});
