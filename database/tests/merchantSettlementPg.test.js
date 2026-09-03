// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Merchant settlement — domain 2 of the full-authority migration.
 *
 * Against a REAL PostgreSQL, because every property worth asserting is a
 * behaviour of the database: the row locks, the expected-previous-state guard
 * in the UPDATE's WHERE clause, two UNIQUE idempotency gates firing inside one
 * transaction, the CHECK constraints on state and direction, and the append-only
 * trigger on the transition history.
 *
 * The invariants, asserted rather than a particular winner:
 *   • a settlement's state and its money can never disagree — they commit or
 *     unwind together
 *   • one transition happens exactly once however many copies of the request
 *     arrive, and a duplicate is reported as ALREADY DONE, never as a failure
 *   • a caller arriving with a stale idea of the state is refused, not obeyed
 *   • the merchant's committed pockets are always explained by its outstanding
 *     settlements
 *   • a transaction that dies part-way leaves nothing behind
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../client.js';
import { getMerchantBalances, adminIssueToMerchant, reconcileMerchant } from '../repositories/merchantWallets.core.js';
import {
  SETTLEMENT_STATES, DIRECTIONS,
  openSettlement, completeSettlement, cancelSettlement, reverseSettlement,
  getSettlement, getSettlementHistory, reconcileSettlements,
  findUnexplainedSettlementPockets,
} from '../repositories/merchantSettlements.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const M = 'pg-settle-merchant';
const bal = () => getMerchantBalances(M);

/** Give the merchant spendable inventory to settle against. */
const fund = (paise, key = 'fund') =>
  adminIssueToMerchant({ merchantId: M, amountPaise: paise, txId: key, reason: 'test funding' });

const open = (id, direction, amountPaise, extra = {}) =>
  openSettlement({
    settlementId: id, merchantId: M, orderId: `order_${id}`,
    direction, amountPaise, ...extra,
  });

describePg('Merchant settlement (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(
      'TRUNCATE merchant_settlement_transitions, merchant_settlements, merchant_wallets, merchant_wallet_entries RESTART IDENTITY CASCADE',
    );
  });

  // ── DEPOSIT: inventory leaves the merchant ─────────────────────────────────
  describe('deposit lifecycle', () => {
    it('reserves inventory out of available, then dispenses it on complete', async () => {
      await fund(100_000);

      const reserved = await open('ms_d1', DIRECTIONS.DEPOSIT, 30_000);
      expect(reserved).toMatchObject({ ok: true, idempotent: false });
      expect(await bal()).toMatchObject({ available: 70_000, reserved: 30_000, liability: 30_000 });

      const done = await completeSettlement({ settlementId: 'ms_d1', merchantId: M });
      expect(done).toMatchObject({ ok: true, idempotent: false });
      // The tokens are gone — dispensed to the user, not returned to available.
      expect(await bal()).toMatchObject({ available: 70_000, reserved: 0, liability: 0 });
      expect((await getSettlement('ms_d1')).state).toBe(SETTLEMENT_STATES.SETTLED);
    });

    it('returns the reservation to available on cancel', async () => {
      await fund(100_000);
      await open('ms_d2', DIRECTIONS.DEPOSIT, 30_000);

      await cancelSettlement({ settlementId: 'ms_d2', merchantId: M, reason: 'order expired' });
      expect(await bal()).toMatchObject({ available: 100_000, reserved: 0 });
      expect((await getSettlement('ms_d2')).state).toBe(SETTLEMENT_STATES.CANCELLED);
    });

    it('refuses to reserve more inventory than the merchant has', async () => {
      await fund(10_000);
      const r = await open('ms_d3', DIRECTIONS.DEPOSIT, 30_000);
      expect(r).toMatchObject({ ok: false, reason: 'insufficient' });
      expect(await bal()).toMatchObject({ available: 10_000, reserved: 0 });
      // The settlement row must not survive a reservation that never happened.
      expect(await getSettlement('ms_d3')).toBeNull();
    });

    it('stops a merchant spending the same inventory on two orders', async () => {
      // The gap this domain closes. Without reservations a merchant assigned
      // several deposits can promise the same tokens to all of them, and only
      // the last debit discovers there is nothing left.
      await fund(50_000);
      expect(await open('ms_d4a', DIRECTIONS.DEPOSIT, 40_000)).toMatchObject({ ok: true });
      expect(await open('ms_d4b', DIRECTIONS.DEPOSIT, 40_000)).toMatchObject({ ok: false, reason: 'insufficient' });
      expect(await bal()).toMatchObject({ available: 10_000, reserved: 40_000 });
    });
  });

  // ── WITHDRAWAL: value arrives owed, then becomes spendable ─────────────────
  describe('withdrawal lifecycle', () => {
    it('holds the merchant\'s tokens in settlement before releasing them', async () => {
      const held = await open('ms_w1', DIRECTIONS.WITHDRAWAL, 25_000);
      expect(held).toMatchObject({ ok: true, idempotent: false });
      // Owed, and NOT spendable. A single balance cannot say this — there
      // the tokens simply do not exist until the hold expires.
      expect(await bal()).toMatchObject({ available: 0, settlement: 25_000, liability: 25_000 });

      await completeSettlement({ settlementId: 'ms_w1', merchantId: M });
      expect(await bal()).toMatchObject({ available: 25_000, settlement: 0, liability: 0 });
    });

    it('takes the owed tokens back on cancel, leaving nothing spendable', async () => {
      await open('ms_w2', DIRECTIONS.WITHDRAWAL, 25_000);
      await cancelSettlement({ settlementId: 'ms_w2', merchantId: M, reason: 'dispute upheld' });
      expect(await bal()).toMatchObject({ available: 0, settlement: 0 });
      expect((await getSettlement('ms_w2')).state).toBe(SETTLEMENT_STATES.CANCELLED);
    });

    it('claws back a released withdrawal even after the tokens were spent', async () => {
      await open('ms_w3', DIRECTIONS.WITHDRAWAL, 25_000);
      await completeSettlement({ settlementId: 'ms_w3', merchantId: M });
      // The merchant spends everything it just received.
      await adminIssueToMerchant({ merchantId: M, amountPaise: 1, txId: 'noop' });
      await pgQuery('UPDATE merchant_wallets SET available_paise = 0 WHERE merchant_id = $1', [M]);

      const r = await reverseSettlement({ settlementId: 'ms_w3', merchantId: M, reason: 'fiat never sent' });
      expect(r).toMatchObject({ ok: true, idempotent: false });
      // Negative available is the correct record of a debt that already exists
      // in the real world. Refusing to record it would be the worse failure.
      expect((await bal()).available).toBe(-25_000);
      expect((await getSettlement('ms_w3')).state).toBe(SETTLEMENT_STATES.REVERSED);
    });
  });

  // ── Idempotency: duplicate retries must be reported as success ─────────────
  describe('idempotency', () => {
    it('opens one settlement however many times the request arrives', async () => {
      await fund(100_000);
      const first = await open('ms_i1', DIRECTIONS.DEPOSIT, 20_000);
      const second = await open('ms_i1', DIRECTIONS.DEPOSIT, 20_000);

      expect(first.idempotent).toBe(false);
      expect(second).toMatchObject({ ok: true, idempotent: true });
      expect(await bal()).toMatchObject({ available: 80_000, reserved: 20_000 });
    });

    it('reports a repeated transition as ALREADY DONE, not as a failure', async () => {
      // Collapsing "already done" into "invalid" is how a retry-safe API stops
      // being retry-safe: the caller sees an error and compensates for
      // something that actually succeeded.
      await fund(100_000);
      await open('ms_i2', DIRECTIONS.DEPOSIT, 20_000);
      const a = await completeSettlement({ settlementId: 'ms_i2', merchantId: M });
      const b = await completeSettlement({ settlementId: 'ms_i2', merchantId: M });

      expect(a).toMatchObject({ ok: true, idempotent: false });
      expect(b).toMatchObject({ ok: true, idempotent: true });
      expect(await bal()).toMatchObject({ available: 80_000, reserved: 0 });
    });

    it('survives a 200-copy retry storm on one transition', async () => {
      await fund(100_000);
      await open('ms_i3', DIRECTIONS.DEPOSIT, 20_000);

      const results = await Promise.all(
        Array.from({ length: 200 }, () => completeSettlement({ settlementId: 'ms_i3', merchantId: M })),
      );

      expect(results.filter((r) => r.ok && !r.idempotent)).toHaveLength(1);
      expect(results.filter((r) => r.ok)).toHaveLength(200); // every copy sees success
      expect(await bal()).toMatchObject({ available: 80_000, reserved: 0 });
      const { rows } = await pgQuery(
        `SELECT COUNT(*)::int AS n FROM merchant_settlement_transitions WHERE settlement_id = 'ms_i3'`);
      expect(rows[0].n).toBe(2); // reserve + complete, once each
    });

    it('survives a 200-copy storm of OPENS on one settlement', async () => {
      await fund(100_000);
      const results = await Promise.all(
        Array.from({ length: 200 }, () => open('ms_i4', DIRECTIONS.DEPOSIT, 20_000)),
      );
      expect(results.filter((r) => r.ok && !r.idempotent)).toHaveLength(1);
      expect(await bal()).toMatchObject({ available: 80_000, reserved: 20_000 });
    });
  });

  // ── Out-of-order arrival: the state guard, under contention ────────────────
  describe('state machine', () => {
    it('refuses a transition from the wrong state and says which state it found', async () => {
      await fund(100_000);
      await open('ms_s1', DIRECTIONS.DEPOSIT, 20_000);
      await cancelSettlement({ settlementId: 'ms_s1', merchantId: M });

      const late = await completeSettlement({ settlementId: 'ms_s1', merchantId: M });
      expect(late).toMatchObject({
        ok: false, reason: 'invalid_transition',
        state: SETTLEMENT_STATES.CANCELLED, expected: SETTLEMENT_STATES.RESERVED,
      });
      // The cancel already returned the reservation; the refused complete must
      // leave that untouched rather than dispensing tokens a second time.
      expect(await bal()).toMatchObject({ available: 100_000, reserved: 0 });
    });

    it('refuses to reverse something that was never settled', async () => {
      await fund(100_000);
      await open('ms_s2', DIRECTIONS.DEPOSIT, 20_000);
      expect(await reverseSettlement({ settlementId: 'ms_s2', merchantId: M }))
        .toMatchObject({ ok: false, reason: 'invalid_transition', expected: SETTLEMENT_STATES.SETTLED });
    });

    it('distinguishes an unknown settlement from a wrong-state one', async () => {
      expect(await completeSettlement({ settlementId: 'nope', merchantId: M }))
        .toEqual({ ok: false, reason: 'not_found' });
    });

    it('lets exactly ONE of a racing complete and cancel win', async () => {
      // Both are legal from RESERVED. Only one may happen, and whichever loses
      // must leave no trace — a settlement cannot be both dispensed and
      // returned.
      await fund(100_000);
      await open('ms_s3', DIRECTIONS.DEPOSIT, 20_000);

      const [done, cancelled] = await Promise.all([
        completeSettlement({ settlementId: 'ms_s3', merchantId: M }),
        cancelSettlement({ settlementId: 'ms_s3', merchantId: M }),
      ]);

      expect([done.ok, cancelled.ok].filter(Boolean)).toHaveLength(1);
      const finalState = (await getSettlement('ms_s3')).state;
      expect([SETTLEMENT_STATES.SETTLED, SETTLEMENT_STATES.CANCELLED]).toContain(finalState);
      // available is 80_000 if completed (tokens dispensed) or 100_000 if
      // cancelled (returned) — never something in between.
      const after = await bal();
      expect(after.reserved).toBe(0);
      expect(after.available).toBe(finalState === SETTLEMENT_STATES.SETTLED ? 80_000 : 100_000);
    });

    it('records an append-only history that cannot be edited', async () => {
      await fund(100_000);
      await open('ms_s4', DIRECTIONS.DEPOSIT, 20_000, { actor: 'merchant-7' });
      await completeSettlement({ settlementId: 'ms_s4', merchantId: M, actor: 'sweeper' });

      const history = await getSettlementHistory('ms_s4');
      expect(history.map((h) => [h.from, h.to])).toEqual([
        [null, SETTLEMENT_STATES.RESERVED],
        [SETTLEMENT_STATES.RESERVED, SETTLEMENT_STATES.SETTLED],
      ]);

      await expect(
        pgQuery(`UPDATE merchant_settlement_transitions SET to_state = 'CANCELLED' WHERE settlement_id = 'ms_s4'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        pgQuery(`DELETE FROM merchant_settlement_transitions WHERE settlement_id = 'ms_s4'`),
      ).rejects.toThrow(/append-only/);
    });
  });

  // ── Concurrency across DIFFERENT settlements on one merchant ───────────────
  describe('concurrency', () => {
    it('lets exactly as many reservations through as the inventory covers', async () => {
      await fund(100_000); // ₹1000 — fits 100 reservations of ₹10

      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          open(`ms_c_${i}`, DIRECTIONS.DEPOSIT, 1_000)),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(100);
      expect(results.filter((r) => !r.ok && r.reason === 'insufficient')).toHaveLength(100);
      expect(await bal()).toMatchObject({ available: 0, reserved: 100_000 });
      // Every pocket is still explained by its entries, and by its settlements.
      expect((await reconcileMerchant(M)).ok).toBe(true);
      expect((await reconcileSettlements(M)).ok).toBe(true);
    });

    it('keeps the books straight through an interleaved storm of every transition', async () => {
      await fund(200_000);
      // 40 deposits reserved up front, then completed/cancelled concurrently,
      // interleaved with withdrawals opening and settling at the same time.
      const deposits = Array.from({ length: 40 }, (_, i) => `ms_x_d${i}`);
      await Promise.all(deposits.map((id) => open(id, DIRECTIONS.DEPOSIT, 1_000)));

      await Promise.all([
        ...deposits.map((id, i) => (i % 2
          ? completeSettlement({ settlementId: id, merchantId: M })
          : cancelSettlement({ settlementId: id, merchantId: M }))),
        ...Array.from({ length: 20 }, (_, i) => open(`ms_x_w${i}`, DIRECTIONS.WITHDRAWAL, 500)),
      ]);

      const after = await bal();
      // 40 × ₹10 reserved; 20 completed (dispensed), 20 cancelled (returned).
      expect(after.available).toBe(200_000 - 40_000 + 20_000);
      expect(after.reserved).toBe(0);
      expect(after.settlement).toBe(20 * 500); // 20 withdrawals still held
      expect((await reconcileMerchant(M)).ok).toBe(true);
      expect((await reconcileSettlements(M)).ok).toBe(true);
    });
  });

  // ── Failure injection ──────────────────────────────────────────────────────
  describe('failure injection', () => {
    it('leaves nothing behind when the connection dies mid-transition', async () => {
      await fund(100_000);
      await open('ms_f1', DIRECTIONS.DEPOSIT, 20_000);

      // Kill this session's backend from another connection while the
      // transition is in flight. The transaction cannot commit, so state and
      // money must both be untouched — the composition's central claim.
      const pool = await getPool();
      const victim = await pool.connect();
      try {
        await victim.query('BEGIN');
        await victim.query(
          `UPDATE merchant_settlements SET state = 'SETTLED' WHERE settlement_id = 'ms_f1'`);
        await victim.query(
          `UPDATE merchant_wallets SET reserved_paise = 0 WHERE merchant_id = $1`, [M]);
        const { rows: [me] } = await victim.query('SELECT pg_backend_pid() AS pid');
        await pgQuery('SELECT pg_terminate_backend($1)', [me.pid]);
      } catch { /* the terminate is the point; the error is expected */ }
      // release(err) DESTROYS the client. A plain release() would put the dead
      // socket back in the pool and the next caller would inherit the error —
      // which is exactly what happened when this test was first written, and
      // why withMerchantLock now releases with its failure.
      try { victim.release(new Error('backend terminated')); } catch { /* already gone */ }

      expect((await getSettlement('ms_f1')).state).toBe(SETTLEMENT_STATES.RESERVED);
      expect(await bal()).toMatchObject({ available: 80_000, reserved: 20_000 });
      expect((await reconcileSettlements(M)).ok).toBe(true);

      // And the settlement is still advanceable afterwards — a killed
      // connection must not strand it.
      expect(await completeSettlement({ settlementId: 'ms_f1', merchantId: M }))
        .toMatchObject({ ok: true, idempotent: false });
    });

    it('refuses a malformed settlement rather than storing one', async () => {
      await expect(open('ms_f2', 'SIDEWAYS', 1_000)).rejects.toThrow(/Unknown settlement direction/);
      await expect(open('ms_f3', DIRECTIONS.DEPOSIT, 0)).rejects.toThrow(/positive integer/);
      await expect(open('ms_f4', DIRECTIONS.DEPOSIT, 10.5)).rejects.toThrow(/positive integer/);
      await expect(open('ms_f5', DIRECTIONS.DEPOSIT, -100)).rejects.toThrow(/positive integer/);
      const { rows } = await pgQuery('SELECT COUNT(*)::int AS n FROM merchant_settlements');
      expect(rows[0].n).toBe(0);
    });

    it('rejects a state the database does not know, even by direct SQL', async () => {
      await fund(10_000);
      await open('ms_f6', DIRECTIONS.DEPOSIT, 1_000);
      await expect(
        pgQuery(`UPDATE merchant_settlements SET state = 'HALFWAY' WHERE settlement_id = 'ms_f6'`),
      ).rejects.toThrow(/merchant_settlements_state_known/);
    });
  });

  // ── Reconciliation ─────────────────────────────────────────────────────────
  describe('reconciliation', () => {
    it('proves the committed pockets are explained by outstanding settlements', async () => {
      await fund(100_000);
      await open('ms_r1', DIRECTIONS.DEPOSIT, 20_000);
      await open('ms_r2', DIRECTIONS.WITHDRAWAL, 5_000);

      expect(await reconcileSettlements(M)).toMatchObject({
        ok: true,
        pockets: { reserved: 20_000, settlement: 5_000 },
        outstanding: { DEPOSIT: 20_000, WITHDRAWAL: 5_000 },
        drift: { reserved: 0, settlement: 0 },
      });
      expect(await findUnexplainedSettlementPockets()).toEqual([]);
    });

    it('catches a committed pocket with no settlement behind it', async () => {
      await fund(100_000);
      await open('ms_r3', DIRECTIONS.DEPOSIT, 20_000);
      // Simulate something outside this module moving a committed pocket.
      await pgQuery(
        'UPDATE merchant_wallets SET reserved_paise = reserved_paise + 777 WHERE merchant_id = $1', [M]);

      const r = await reconcileSettlements(M);
      expect(r.ok).toBe(false);
      expect(r.drift.reserved).toBe(777);
      expect(await findUnexplainedSettlementPockets())
        .toEqual([{ merchantId: M, reservedDrift: 777, settlementDrift: 0 }]);
    });

    it('stops counting a settlement once it leaves RESERVED', async () => {
      await fund(100_000);
      await open('ms_r4', DIRECTIONS.DEPOSIT, 20_000);
      await completeSettlement({ settlementId: 'ms_r4', merchantId: M });
      expect(await reconcileSettlements(M)).toMatchObject({
        ok: true, pockets: { reserved: 0 }, outstanding: { DEPOSIT: 0 },
      });
    });
  });
});
