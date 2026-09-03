// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The Postgres-authoritative wallet path — the first path the cutover flips.
 *
 * These run against a REAL PostgreSQL (skipped when DATABASE_URL is unset), for
 * the reason the money tests exist at all: row locking, the negative-balance
 * guard and the unique-tx_id idempotency gate are behaviours of the database,
 * and asserting them against a mock proves nothing about production.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  getBalancesPaise, getBalancesRupees, applyDeltaPaise, applyDeltaRupees, transferPaise,
} from '../repositories/wallets.core.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const USER = 'pg-wallet-user-1';

describePg('Postgres-authoritative wallet', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE wallets, wallet_ledger RESTART IDENTITY CASCADE');
  });

  describe('reads', () => {
    it('reports zeros for a user who has never transacted', async () => {
      expect(await getBalancesPaise(USER)).toEqual({
        depositBalance: 0, winningsBalance: 0, tokenBalance: 0, reserveBalance: 0, lockedBalance: 0,
        lockedDepositAmount: 0, lockedWinningsAmount: 0,
      });
    });

    it('converts to rupees for callers above the paise wall', async () => {
      await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 12345, txId: 'r1' });
      const rupees = await getBalancesRupees(USER);
      expect(rupees.depositBalance).toBe(123.45);
    });
  });

  describe('credits and debits', () => {
    it('credits, then debits, tracking the running balance in paise', async () => {
      const credit = await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 50000, txId: 'c1' });
      expect(credit).toMatchObject({ ok: true, idempotent: false, balanceAfterPaise: 50000 });

      const debit = await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: -20000, txId: 'd1' });
      expect(debit).toMatchObject({ ok: true, balanceAfterPaise: 30000 });

      expect((await getBalancesPaise(USER)).depositBalance).toBe(30000);
    });

    it('REFUSES a debit that would leave the balance negative', async () => {
      await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 10000, txId: 'c2' });
      const result = await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: -10001, txId: 'd2' });

      expect(result).toMatchObject({ ok: false, insufficient: true });
      expect((await getBalancesPaise(USER)).depositBalance).toBe(10000); // untouched
    });

    it('permits a negative balance only when explicitly allowed (corrective admin path)', async () => {
      const result = await applyDeltaPaise({
        userId: USER, field: 'depositBalance', deltaPaise: -500, txId: 'adj1', allowNegative: true,
      });
      expect(result).toMatchObject({ ok: true, balanceAfterPaise: -500 });
    });

    it('writes the balance and its ledger row in ONE transaction', async () => {
      await applyDeltaPaise({
        userId: USER, field: 'winningsBalance', deltaPaise: 7700, txId: 'l1',
        type: 'WIN', reason: 'Cycle payout', refId: 'cycle-9',
      });
      const { rows } = await pgQuery('SELECT * FROM wallet_ledger WHERE tx_id = $1', ['l1']);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: USER, field: 'winningsBalance', tx_type: 'WIN',
        description: 'Cycle payout', ref_id: 'cycle-9',
      });
      expect(Number(rows[0].amount_paise)).toBe(7700);
      expect(Number(rows[0].balance_after_paise)).toBe(7700);
    });

    it('rejects a movement with no idempotency key', async () => {
      await expect(applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 1 }))
        .rejects.toThrow(/requires a txId/);
    });

    it('rejects a non-integer paise amount rather than rounding it', async () => {
      await expect(applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 10.5, txId: 'f1' }))
        .rejects.toThrow(/integer number of paise/);
    });

    it('rejects an unknown balance field', async () => {
      await expect(applyDeltaPaise({ userId: USER, field: 'bonusBalance', deltaPaise: 1, txId: 'f2' }))
        .rejects.toThrow(/Unknown balance field/);
    });
  });

  describe('idempotency', () => {
    it('replaying the same txId does not move the balance twice', async () => {
      const first = await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 25000, txId: 'same' });
      const replay = await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 25000, txId: 'same' });

      expect(first).toMatchObject({ ok: true, idempotent: false, balanceAfterPaise: 25000 });
      expect(replay).toMatchObject({ ok: true, idempotent: true, balanceAfterPaise: 25000 });
      expect((await getBalancesPaise(USER)).depositBalance).toBe(25000);
    });

    it('holds under CONCURRENT replays of one movement', async () => {
      // The bug class GOVERNANCE §20 (2026-07-10) records:
      // concurrent calls both pass a pre-read check and double-credit. The gate
      // has to be the unique index inside the transaction, not a read.
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 10000, txId: 'race' })),
      );

      expect(attempts.every((r) => r.ok)).toBe(true);
      expect(attempts.filter((r) => !r.idempotent)).toHaveLength(1); // exactly one real movement
      expect((await getBalancesPaise(USER)).depositBalance).toBe(10000);

      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM wallet_ledger WHERE tx_id = $1', ['race']);
      expect(rows[0].n).toBe(1);
    });

    it('serialises concurrent DISTINCT movements without losing any', async () => {
      // Eight independent credits of ₹100 must total exactly ₹800 — the row lock
      // is what makes read-modify-write safe under concurrency.
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 10000, txId: `distinct-${i}` })),
      );
      expect((await getBalancesPaise(USER)).depositBalance).toBe(80000);

      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM wallet_ledger WHERE user_id = $1', [USER]);
      expect(rows[0].n).toBe(8);
    });

    it('does not let concurrent debits overdraw the balance', async () => {
      await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 30000, txId: 'seed' });

      // Five simultaneous ₹100 debits against a ₹300 balance: three succeed.
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: -10000, txId: `spend-${i}` })),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(results.filter((r) => r.insufficient)).toHaveLength(2);
      expect((await getBalancesPaise(USER)).depositBalance).toBe(0);
    });
  });

  describe('transfers between fields', () => {
    it('moves value atomically and writes both ledger legs', async () => {
      await applyDeltaPaise({ userId: USER, field: 'winningsBalance', deltaPaise: 40000, txId: 't-seed' });

      const result = await transferPaise({
        userId: USER, fromField: 'winningsBalance', toField: 'lockedBalance',
        amountPaise: 15000, txId: 'lock-1', type: 'WITHDRAWAL_LOCK',
      });
      expect(result).toMatchObject({ ok: true, fromAfterPaise: 25000, toAfterPaise: 15000 });

      const balances = await getBalancesPaise(USER);
      expect(balances.winningsBalance).toBe(25000);
      expect(balances.lockedBalance).toBe(15000);

      // Amounts are stored as a positive magnitude with the direction in
      // tx_type — the convention the forward mirror writes, and the one the
      // reverse mirror copies straight into WalletLedger.amount (a positive
      // a positive Number).
      const { rows } = await pgQuery(
        'SELECT tx_id, field, amount_paise, tx_type FROM wallet_ledger WHERE tx_id LIKE $1 ORDER BY tx_id', ['lock-1%'],
      );
      expect(rows.map((r) => [r.tx_id, r.field, Number(r.amount_paise), r.tx_type])).toEqual([
        ['lock-1:from', 'winningsBalance', 15000, 'WITHDRAWAL_LOCK'],
        ['lock-1:to', 'lockedBalance', 15000, 'WITHDRAWAL_LOCK'],
      ]);
    });

    it('refuses a transfer larger than the source balance, moving neither field', async () => {
      await applyDeltaPaise({ userId: USER, field: 'winningsBalance', deltaPaise: 5000, txId: 't-seed-2' });

      const result = await transferPaise({
        userId: USER, fromField: 'winningsBalance', toField: 'lockedBalance',
        amountPaise: 5001, txId: 'lock-2',
      });

      expect(result).toMatchObject({ ok: false, insufficient: true });
      const balances = await getBalancesPaise(USER);
      expect(balances.winningsBalance).toBe(5000);
      expect(balances.lockedBalance).toBe(0);
    });

    it('is idempotent as a pair — a replay moves nothing', async () => {
      await applyDeltaPaise({ userId: USER, field: 'winningsBalance', deltaPaise: 20000, txId: 't-seed-3' });
      const args = {
        userId: USER, fromField: 'winningsBalance', toField: 'lockedBalance',
        amountPaise: 8000, txId: 'lock-3',
      };
      await transferPaise(args);
      const replay = await transferPaise(args);

      expect(replay).toMatchObject({ ok: true, idempotent: true });
      const balances = await getBalancesPaise(USER);
      expect(balances.winningsBalance).toBe(12000);
      expect(balances.lockedBalance).toBe(8000);
    });

    it('rejects a transfer to the same field', async () => {
      await expect(transferPaise({
        userId: USER, fromField: 'depositBalance', toField: 'depositBalance',
        amountPaise: 100, txId: 'same-field',
      })).rejects.toThrow(/two different fields/);
    });

    it('rejects a non-positive amount', async () => {
      await expect(transferPaise({
        userId: USER, fromField: 'winningsBalance', toField: 'lockedBalance',
        amountPaise: 0, txId: 'zero',
      })).rejects.toThrow(/positive integer/);
    });
  });

  describe('rupee convenience wrapper', () => {
    it('converts at the boundary and stores integer paise', async () => {
      await applyDeltaRupees({ userId: USER, field: 'depositBalance', deltaRupees: 99.99, txId: 'rup-1' });
      expect((await getBalancesPaise(USER)).depositBalance).toBe(9999);
    });

    it('kills float dust rather than storing it', async () => {
      // 0.1 + 0.2 style error must not reach the ledger.
      await applyDeltaRupees({ userId: USER, field: 'depositBalance', deltaRupees: 0.1, txId: 'dust-1' });
      await applyDeltaRupees({ userId: USER, field: 'depositBalance', deltaRupees: 0.2, txId: 'dust-2' });
      expect((await getBalancesPaise(USER)).depositBalance).toBe(30); // exactly ₹0.30
    });
  });

  describe('the append-only guarantee', () => {
    it('refuses to rewrite a settled ledger row', async () => {
      await applyDeltaPaise({ userId: USER, field: 'depositBalance', deltaPaise: 1000, txId: 'immutable' });
      await expect(
        pgQuery(`UPDATE wallet_ledger SET amount_paise = 999999 WHERE tx_id = 'immutable'`),
      ).rejects.toThrow(/append-only/);
    });
  });
});
