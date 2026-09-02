// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The Postgres merchant wallet — domain 1 of the full-authority migration.
 *
 * Runs against a REAL PostgreSQL, because everything worth asserting here is a
 * behaviour of the database: the row lock, the negative guard in the UPDATE's
 * WHERE clause, the UNIQUE tx_id idempotency gate, the append-only trigger and
 * the arithmetic CHECK. Asserting those against a mock proves nothing.
 *
 * Invariants, asserted rather than a particular winner:
 *   • tokens are never created — the ledger explains every pocket
 *   • reserved and settlement never go negative (CHECK + guard)
 *   • available goes negative ONLY on an explicitly authorised correction
 *   • one txId moves tokens exactly once, however many copies arrive
 *   • a balance never moves without its entry
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  POCKETS, getMerchantBalances, applyMerchantMovement, reconcileMerchant,
  adminIssueToMerchant, adminDeductFromMerchant,
  reserveForSettlement, cancelReservation, completeReservation, payoutSettlement,
  reverseMovement,
} from '../repositories/merchantWallets.core.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const M = 'pg-merchant-1';
const bal = () => getMerchantBalances(M);

describePg('Postgres merchant wallet', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE merchant_wallets, merchant_wallet_entries RESTART IDENTITY CASCADE');
  });

  describe('reads', () => {
    it('reports zeros for a merchant that has never transacted', async () => {
      expect(await bal()).toEqual({ available: 0, reserved: 0, settlement: 0, liability: 0 });
    });
  });

  describe('admin ↔ merchant', () => {
    it('issues tokens and records the entry in the same transaction', async () => {
      const r = await adminIssueToMerchant({
        merchantId: M, amountPaise: 100_000, txId: 'iss_1', actor: 'admin-7', reason: 'Token purchase',
      });
      expect(r).toMatchObject({ ok: true, idempotent: false });
      expect((await bal()).available).toBe(100_000);

      const { rows } = await pgQuery('SELECT * FROM merchant_wallet_entries WHERE tx_id = $1', ['iss_1']);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pocket: 'available', entry_type: 'CREDIT', operation: 'ADMIN_ISSUANCE', actor: 'admin-7',
      });
      expect(Number(rows[0].balance_before_paise)).toBe(0);
      expect(Number(rows[0].balance_after_paise)).toBe(100_000);
    });

    it('replays an issuance as a no-op', async () => {
      await adminIssueToMerchant({ merchantId: M, amountPaise: 50_000, txId: 'iss_dup' });
      const again = await adminIssueToMerchant({ merchantId: M, amountPaise: 50_000, txId: 'iss_dup' });
      expect(again).toMatchObject({ ok: true, idempotent: true });
      expect((await bal()).available).toBe(50_000);
    });

    it('refuses a deduction that would overdraw', async () => {
      await adminIssueToMerchant({ merchantId: M, amountPaise: 10_000, txId: 'iss_2' });
      const r = await adminDeductFromMerchant({ merchantId: M, amountPaise: 10_001, txId: 'ded_1' });
      expect(r).toMatchObject({ ok: false, insufficient: true });
      expect((await bal()).available).toBe(10_000); // untouched
      const { rows } = await pgQuery('SELECT 1 FROM merchant_wallet_entries WHERE tx_id = $1', ['ded_1']);
      expect(rows).toHaveLength(0); // refused movements leave no entry
    });

    it('allows an overdraft only when explicitly authorised', async () => {
      const r = await adminDeductFromMerchant({
        merchantId: M, amountPaise: 5_000, txId: 'ded_auth',
        reason: 'Corrective adjustment', allowNegativeAvailable: true,
      });
      expect(r.ok).toBe(true);
      expect((await bal()).available).toBe(-5_000);
    });
  });

  describe('reservation lifecycle', () => {
    beforeEach(async () => {
      await adminIssueToMerchant({ merchantId: M, amountPaise: 100_000, txId: 'seed' });
    });

    it('moves available → reserved, and both entries land together', async () => {
      const r = await reserveForSettlement({ merchantId: M, amountPaise: 30_000, txId: 'res_1' });
      expect(r.ok).toBe(true);
      expect(await bal()).toMatchObject({ available: 70_000, reserved: 30_000, liability: 30_000 });

      const { rows } = await pgQuery(
        `SELECT pocket, entry_type FROM merchant_wallet_entries WHERE tx_id LIKE 'res_1%' ORDER BY pocket`,
      );
      expect(rows).toEqual([
        { pocket: 'available', entry_type: 'DEBIT' },
        { pocket: 'reserved',  entry_type: 'CREDIT' },
      ]);
    });

    it('cancels a reservation back to available', async () => {
      await reserveForSettlement({ merchantId: M, amountPaise: 30_000, txId: 'res_2' });
      await cancelReservation({ merchantId: M, amountPaise: 30_000, txId: 'res_2_cancel' });
      expect(await bal()).toMatchObject({ available: 100_000, reserved: 0, liability: 0 });
    });

    it('completes a reservation into the settlement pocket', async () => {
      await reserveForSettlement({ merchantId: M, amountPaise: 40_000, txId: 'res_3' });
      await completeReservation({ merchantId: M, amountPaise: 40_000, txId: 'res_3_done' });
      expect(await bal()).toMatchObject({
        available: 60_000, reserved: 0, settlement: 40_000, liability: 40_000,
      });
    });

    it('pays out what is owed, clearing the liability', async () => {
      await reserveForSettlement({ merchantId: M, amountPaise: 40_000, txId: 'res_4' });
      await completeReservation({ merchantId: M, amountPaise: 40_000, txId: 'res_4_done' });
      await payoutSettlement({ merchantId: M, amountPaise: 40_000, txId: 'res_4_paid', actor: 'admin-1' });
      expect(await bal()).toMatchObject({ settlement: 0, liability: 0 });
    });

    it('refuses to reserve more than is available', async () => {
      const r = await reserveForSettlement({ merchantId: M, amountPaise: 100_001, txId: 'res_over' });
      expect(r).toMatchObject({ ok: false, insufficient: true });
      expect(await bal()).toMatchObject({ available: 100_000, reserved: 0 });
    });

    it('refuses to complete a reservation that does not exist', async () => {
      // reserved is 0, so the guard matches no row — reserved can never go
      // negative, which is what the CHECK constraint also enforces.
      const r = await completeReservation({ merchantId: M, amountPaise: 1_000, txId: 'res_phantom' });
      expect(r).toMatchObject({ ok: false, insufficient: true });
      expect(await bal()).toMatchObject({ reserved: 0, settlement: 0 });
    });
  });

  describe('concurrency', () => {
    beforeEach(async () => {
      await adminIssueToMerchant({ merchantId: M, amountPaise: 100_000, txId: 'seed_c' });
    });

    it('never overdraws when 200 reservations race a balance that fits 100', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 200 }, (_, i) =>
          reserveForSettlement({ merchantId: M, amountPaise: 1_000, txId: `race_${i}` })),
      );
      const committed = results.filter((r) => r.status === 'fulfilled' && r.value.ok && !r.value.idempotent).length;
      const after = await bal();

      expect(committed).toBe(100);
      expect(after.available).toBe(0);
      expect(after.reserved).toBe(100_000);
      expect(after.available).toBeGreaterThanOrEqual(0);
    });

    it('applies one txId exactly once under a 200-way retry storm', async () => {
      await Promise.allSettled(
        Array.from({ length: 200 }, () =>
          reserveForSettlement({ merchantId: M, amountPaise: 5_000, txId: 'storm' })),
      );
      expect(await bal()).toMatchObject({ available: 95_000, reserved: 5_000 });

      const { rows } = await pgQuery(
        `SELECT COUNT(*)::int AS n FROM merchant_wallet_entries WHERE tx_id LIKE 'storm%'`,
      );
      expect(rows[0].n).toBe(2); // exactly one movement — one entry per pocket
    });

    it('keeps the ledger explaining every pocket with issuance and reservation interleaved', async () => {
      await Promise.allSettled([
        ...Array.from({ length: 50 }, (_, i) =>
          reserveForSettlement({ merchantId: M, amountPaise: 500, txId: `mix_r${i}` })),
        ...Array.from({ length: 50 }, (_, i) =>
          adminIssueToMerchant({ merchantId: M, amountPaise: 500, txId: `mix_i${i}` })),
      ]);
      const recon = await reconcileMerchant(M);
      expect(recon.ok).toBe(true);
      expect(recon.drift).toEqual({ available: 0, reserved: 0, settlement: 0 });
    });
  });

  describe('ledger integrity', () => {
    it('is append-only — the database refuses an update', async () => {
      await adminIssueToMerchant({ merchantId: M, amountPaise: 1_000, txId: 'immutable' });
      await expect(
        pgQuery(`UPDATE merchant_wallet_entries SET amount_paise = 999 WHERE tx_id = 'immutable'`),
      ).rejects.toThrow(/append-only/);
    });

    it('is append-only — the database refuses a delete', async () => {
      await adminIssueToMerchant({ merchantId: M, amountPaise: 1_000, txId: 'undeletable' });
      await expect(
        pgQuery(`DELETE FROM merchant_wallet_entries WHERE tx_id = 'undeletable'`),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses an entry whose arithmetic does not add up', async () => {
      await expect(pgQuery(
        `INSERT INTO merchant_wallet_entries
           (tx_id, merchant_id, pocket, amount_paise, balance_before_paise, balance_after_paise, entry_type, operation)
         VALUES ('bad', $1, 'available', 100, 0, 5000, 'CREDIT', 'ADMIN_ISSUANCE')`, [M],
      )).rejects.toThrow(/arithmetic/);
    });

    it('refuses a non-positive amount — direction lives in entry_type', async () => {
      await expect(pgQuery(
        `INSERT INTO merchant_wallet_entries
           (tx_id, merchant_id, pocket, amount_paise, balance_before_paise, balance_after_paise, entry_type, operation)
         VALUES ('neg', $1, 'available', -100, 0, -100, 'DEBIT', 'ADMIN_DEDUCTION')`, [M],
      )).rejects.toThrow(/amount_positive/);
    });

    it('records a reversal as a new offsetting entry, not an edit', async () => {
      await adminIssueToMerchant({ merchantId: M, amountPaise: 10_000, txId: 'orig' });
      await reverseMovement({
        merchantId: M, txId: 'orig_rev', reversesTxId: 'orig',
        legs: { available: -10_000 }, actor: 'admin-2', reason: 'Issued in error',
      });
      expect((await bal()).available).toBe(0);

      const { rows } = await pgQuery(
        `SELECT reverses_tx_id, operation FROM merchant_wallet_entries WHERE tx_id = 'orig_rev'`,
      );
      expect(rows[0]).toMatchObject({ reverses_tx_id: 'orig', operation: 'REVERSAL' });

      // The original is untouched — that is what append-only buys.
      const orig = await pgQuery(`SELECT amount_paise FROM merchant_wallet_entries WHERE tx_id = 'orig'`);
      expect(Number(orig.rows[0].amount_paise)).toBe(10_000);
    });

    it('reconciles to zero drift after a mixed lifecycle', async () => {
      await adminIssueToMerchant({ merchantId: M, amountPaise: 100_000, txId: 'r_seed' });
      await reserveForSettlement({ merchantId: M, amountPaise: 30_000, txId: 'r_res' });
      await completeReservation({ merchantId: M, amountPaise: 30_000, txId: 'r_done' });
      await payoutSettlement({ merchantId: M, amountPaise: 30_000, txId: 'r_paid' });
      await adminDeductFromMerchant({ merchantId: M, amountPaise: 20_000, txId: 'r_ded' });

      const recon = await reconcileMerchant(M);
      expect(recon.ok).toBe(true);
      expect(recon.balances).toMatchObject({ available: 50_000, reserved: 0, settlement: 0 });
    });
  });

  describe('input validation', () => {
    it('rejects a movement with no idempotency key', async () => {
      await expect(applyMerchantMovement({
        merchantId: M, operation: 'ADMIN_ISSUANCE', legs: { available: 100 },
      })).rejects.toThrow(/txId/);
    });

    it('rejects a non-integer amount before touching the database', async () => {
      await expect(applyMerchantMovement({
        merchantId: M, txId: 'frac', operation: 'ADMIN_ISSUANCE', legs: { available: 1.5 },
      })).rejects.toThrow(/integer/);
    });

    it('rejects an unknown pocket', async () => {
      await expect(applyMerchantMovement({
        merchantId: M, txId: 'bad_pocket', operation: 'X', legs: { winnings: 100 },
      })).rejects.toThrow(/Unknown merchant pocket/);
    });

    it('rejects a non-positive amount at the operation boundary', async () => {
      expect(() => adminIssueToMerchant({ merchantId: M, amountPaise: 0, txId: 'zero' }))
        .toThrow(/positive integer/);
    });
  });
});
