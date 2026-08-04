// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The settlement domain's ROLLBACK LEG — Postgres → Mongo, per committed
 * transition.
 *
 * ── The gap this covers ─────────────────────────────────────────────────────
 * merchantSettlementPg composes merchantWalletPg.applyMovementWithin DIRECTLY,
 * so it never passes through merchantWalletPgAuthority — the module that owns
 * the merchant path's reverse mirror. Until this was wired, a settlement moved
 * a merchant's tokens in Postgres and left `Merchant.tokenBalance` and the
 * entire MerchantWalletLedger untouched. Two failures, not one:
 *
 *   • falling back to Mongo would lose the movement outright, which is exactly
 *     the zero-RPO guarantee DATA_ROLLBACK_PLAN.md rests on; and
 *   • Mongo's idempotency gate for merchant money is
 *     `MerchantWalletLedger.findOne({ txId })` — with no row there, the first
 *     retry after a fallback applies the movement a SECOND time.
 *
 * The mirror is mocked and the DATABASE is real, which is the split that
 * matters: what needs proving is which committed facts get handed to the mirror
 * and when, and those come from real transactions, real guards and real
 * UNIQUE-key collisions rather than from a stubbed settlement.
 *
 * ── Authority ───────────────────────────────────────────────────────────────
 * moneyAuthority is mocked because merchant_settlement is not cutover-eligible
 * (it waits on ORDERS), so `isPostgresAuthoritative` cannot be made true by any
 * environment variable — and hard-coding the mirror to always fire is precisely
 * the bug the "runs only under Postgres authority" rule exists to prevent.
 * Both answers are tested.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const authoritative = { value: true };

vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: () => authoritative.value };
});

vi.mock('../../postgres/reverseMirror.js', () => ({
  reverseMirrorMerchantMovement: vi.fn(),
  reverseMirrorMerchantSettlement: vi.fn(),
}));

const { pgConfigured, pgQuery, applySchema, closePg, getPool } = await import('../../postgres/pgClient.js');
const { getMerchantBalances, adminIssueToMerchant } = await import('../../postgres/merchantWalletPg.js');
const {
  SETTLEMENT_STATES, DIRECTIONS,
  openSettlement, completeSettlement, cancelSettlement, reverseSettlement,
} = await import('../../postgres/merchantSettlementPg.js');
const {
  reverseMirrorMerchantMovement, reverseMirrorMerchantSettlement,
} = await import('../../postgres/reverseMirror.js');

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const M = 'pg-mirror-merchant';

const fund = (paise, key = 'mfund') =>
  adminIssueToMerchant({ merchantId: M, amountPaise: paise, txId: key, reason: 'test funding' });

const openWithdrawal = (id, amountPaise, merchantId = M) =>
  openSettlement({
    settlementId: id, merchantId, orderId: `order_${id}`,
    direction: DIRECTIONS.WITHDRAWAL, amountPaise,
  });

const complete = (id, merchantId = M) =>
  completeSettlement({ settlementId: id, merchantId, actor: 'test' });

/** The settlement leg of the mirror, as a plain object per call. */
const settlementMirrors = () => reverseMirrorMerchantSettlement.mock.calls.map(([row]) => row);
const movementMirrors = () => reverseMirrorMerchantMovement.mock.calls.map(([arg]) => arg);

describePg('Merchant settlement → Mongo reverse mirror (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(
      'TRUNCATE merchant_settlement_transitions, merchant_settlements, merchant_wallets, merchant_wallet_entries RESTART IDENTITY CASCADE',
    );
    authoritative.value = true;
    vi.clearAllMocks();
  });

  // ── What gets mirrored, and what it says ───────────────────────────────────
  describe('a committed transition is handed to both mirrors', () => {
    it('mirrors the reservation: the settlement state AND the pocket movement', async () => {
      const r = await openWithdrawal('ms_mirror_open', 5_000);
      expect(r.ok).toBe(true);

      expect(settlementMirrors()).toEqual([{
        order_id: 'order_ms_mirror_open',
        direction: DIRECTIONS.WITHDRAWAL,
        state: SETTLEMENT_STATES.RESERVED,
        updated_at: expect.any(Date),
      }]);

      // The movement leg carries the rows that actually committed, so Mongo's
      // ledger ends up describing the same facts rather than a reconstruction.
      const [movement] = movementMirrors();
      expect(movement.merchantId).toBe(M);
      expect(movement.balances).toEqual(await getMerchantBalances(M));
      expect(movement.entries).toHaveLength(1);
      expect(movement.entries[0]).toMatchObject({
        txId: 'ms_mirror_open_reserve', pocket: 'settlement', amountPaise: 5_000, entryType: 'CREDIT',
      });
    });

    it('mirrors a multi-leg completion with the movementId Mongo needs to key on', async () => {
      await openWithdrawal('ms_mirror_done', 5_000);
      vi.clearAllMocks();

      const r = await complete('ms_mirror_done');
      expect(r.ok).toBe(true);
      expect(r.idempotent).toBe(false);

      expect(settlementMirrors()).toEqual([{
        order_id: 'order_ms_mirror_done',
        direction: DIRECTIONS.WITHDRAWAL,
        state: SETTLEMENT_STATES.SETTLED,
        updated_at: expect.any(Date),
      }]);

      // Two pockets move, so Postgres suffixes each entry's tx_id — and every
      // row must still carry the LOGICAL key, because that is the one Mongo's
      // idempotency gate matches on. reverseMirrorMerchantMovement refuses a
      // multi-leg movement without it, which would surface as a mirror failure
      // rather than a silent double-apply, but only if it is actually set.
      const [movement] = movementMirrors();
      expect(movement.entries.map((e) => e.txId).sort()).toEqual([
        'ms_mirror_done_complete:available', 'ms_mirror_done_complete:settlement',
      ]);
      expect(movement.entries.every((e) => e.movementId === 'ms_mirror_done_complete')).toBe(true);
    });

    it('carries the timestamp Postgres wrote, not the moment the mirror ran', async () => {
      await openWithdrawal('ms_mirror_ts', 5_000);
      const openedAt = settlementMirrors()[0].updated_at;
      vi.clearAllMocks();

      await complete('ms_mirror_ts');
      const settledAt = settlementMirrors()[0].updated_at;

      // The row's own updated_at, read back from the database, is what the
      // mirror was given. A `new Date()` taken at mirror time would back-date
      // the decision to whenever Mongo happened to catch up — and a reconcile
      // repair running days later would write a wildly different one.
      const { rows } = await pgQuery(
        `SELECT updated_at FROM merchant_settlements WHERE settlement_id = $1`, ['ms_mirror_ts'],
      );
      expect(settledAt).toEqual(rows[0].updated_at);
      expect(settledAt.getTime()).toBeGreaterThanOrEqual(openedAt.getTime());
    });

    it('mirrors a reversal as REVERSED, so Mongo does not read it as a fresh completion', async () => {
      await fund(10_000);
      await openWithdrawal('ms_mirror_rev', 5_000);
      await complete('ms_mirror_rev');
      vi.clearAllMocks();

      const r = await reverseSettlement({ settlementId: 'ms_mirror_rev', merchantId: M, actor: 'admin' });
      expect(r.ok).toBe(true);
      expect(settlementMirrors()[0].state).toBe(SETTLEMENT_STATES.REVERSED);
    });

    it('mirrors a cancellation as CANCELLED', async () => {
      await openWithdrawal('ms_mirror_cancel', 5_000);
      vi.clearAllMocks();

      await cancelSettlement({ settlementId: 'ms_mirror_cancel', merchantId: M, actor: 'dispute' });
      expect(settlementMirrors()[0].state).toBe(SETTLEMENT_STATES.CANCELLED);
    });
  });

  // ── What must NOT be mirrored ──────────────────────────────────────────────
  describe('nothing is mirrored when nothing committed', () => {
    it('a replayed transition mirrors once, not twice', async () => {
      await openWithdrawal('ms_mirror_replay', 5_000);
      await complete('ms_mirror_replay');
      vi.clearAllMocks();

      const again = await complete('ms_mirror_replay');
      expect(again).toMatchObject({ ok: true, idempotent: true });

      // Mirroring a replay would be harmless in Mongo (every write is an
      // upsert), and still wrong to do: it would make the mirror's call count
      // meaningless as a signal, and it is the same swallowed-duplicate
      // reasoning that let a broken merchant-ledger upsert survive in a PASSING
      // job for weeks.
      expect(reverseMirrorMerchantSettlement).not.toHaveBeenCalled();
      expect(reverseMirrorMerchantMovement).not.toHaveBeenCalled();
    });

    it('a refused transition mirrors nothing', async () => {
      await openWithdrawal('ms_mirror_refused', 5_000);
      await cancelSettlement({ settlementId: 'ms_mirror_refused', merchantId: M });
      vi.clearAllMocks();

      const r = await complete('ms_mirror_refused');
      expect(r).toMatchObject({ ok: false, reason: 'invalid_transition' });
      expect(reverseMirrorMerchantSettlement).not.toHaveBeenCalled();
      expect(reverseMirrorMerchantMovement).not.toHaveBeenCalled();
    });

    it('an insufficient-balance refusal mirrors nothing and moves nothing', async () => {
      // A DEPOSIT reserve takes from `available`, and there is none.
      const r = await openSettlement({
        settlementId: 'ms_mirror_broke', merchantId: M, orderId: 'order_broke',
        direction: DIRECTIONS.DEPOSIT, amountPaise: 5_000,
      });
      expect(r).toMatchObject({ ok: false, reason: 'insufficient' });
      expect(reverseMirrorMerchantSettlement).not.toHaveBeenCalled();
      expect(await getMerchantBalances(M)).toMatchObject({ available: 0, reserved: 0 });
    });

    it('mirrors nothing at all while MONGO is authoritative', async () => {
      authoritative.value = false;

      const r = await openWithdrawal('ms_mirror_mongo', 5_000);
      expect(r.ok).toBe(true);
      await complete('ms_mirror_mongo');

      // On a Mongo-authoritative path the FORWARD mirror owns the direction.
      // Writing back would fight the real write — and it is also what would
      // make every Postgres-only suite, which has no Mongo at all, log a mirror
      // failure per assertion.
      expect(reverseMirrorMerchantSettlement).not.toHaveBeenCalled();
      expect(reverseMirrorMerchantMovement).not.toHaveBeenCalled();
    });
  });

  // ── Concurrency: the mandate ───────────────────────────────────────────────
  describe('concurrency and pool safety', () => {
    it('100 racing completions mirror EXACTLY ONCE', async () => {
      await openWithdrawal('ms_mirror_race', 5_000);
      vi.clearAllMocks();

      const results = await Promise.all(Array.from({ length: 100 }, () => complete('ms_mirror_race')));

      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => !r.idempotent)).toHaveLength(1);

      // The point of the whole exercise. 99 callers were told "already done"
      // and exactly one committed, so Mongo is told once — a mirror that fired
      // per caller would re-post the same ledger row 100 times and, worse,
      // would mean the "did this commit?" answer the mirror keys off is not
      // actually the transaction's answer.
      expect(reverseMirrorMerchantSettlement).toHaveBeenCalledTimes(1);
      expect(reverseMirrorMerchantMovement).toHaveBeenCalledTimes(1);
      expect(settlementMirrors()[0].state).toBe(SETTLEMENT_STATES.SETTLED);
    });

    it('60 merchants settling at once neither deadlock nor exhaust the pool', async () => {
      const pool = await getPool();
      const ids = Array.from({ length: 60 }, (_, i) => `race${i}`);

      const started = Date.now();
      const results = await Promise.all(ids.map(async (id) => {
        const merchantId = `pg-mirror-m-${id}`;
        const opened = await openSettlement({
          settlementId: `ms_${id}`, merchantId, orderId: `order_${id}`,
          direction: DIRECTIONS.WITHDRAWAL, amountPaise: 1_000,
        });
        const done = await complete(`ms_${id}`, merchantId);
        return opened.ok && done.ok && !done.idempotent;
      }));

      expect(results.every(Boolean)).toBe(true);
      // Every checkout was returned. A leaked client shows up here as a pool
      // that never drains, and the next suite inherits the exhaustion rather
      // than this one failing — which is how a pool bug hides.
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(pool.totalCount);
      // Deadlocks in Postgres are broken by a 1s timeout, so a run that
      // deadlocked and retried takes seconds longer than one that queued.
      expect(Date.now() - started).toBeLessThan(20_000);

      expect(reverseMirrorMerchantSettlement).toHaveBeenCalledTimes(120); // open + complete, each merchant
      expect(new Set(settlementMirrors().map((r) => r.order_id)).size).toBe(60);
    });

    it('never holds two pooled connections at once for one transition', async () => {
      // The rule that makes the above hold: a transition takes ONE client and
      // does everything inside it — the wallet lock, the settlement lock, the
      // state UPDATE, the pocket movement and both idempotency gates. A second
      // checkout while the first is held is the classic self-deadlock, and with
      // a pool this small it is not subtle: it hangs.
      const pool = await getPool();
      const max = pool.options.max ?? 10;

      await Promise.all(Array.from({ length: max }, (_, i) =>
        openWithdrawal(`ms_mirror_pool_${i}`, 100, `pg-mirror-pool-${i}`)));

      // If any single transition needed a second connection, `max` concurrent
      // transitions could not all have completed — they would each be holding
      // one and waiting for another that will never be free.
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBeLessThanOrEqual(max);
    });
  });
});
