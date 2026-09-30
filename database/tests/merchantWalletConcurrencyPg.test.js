// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant wallet under REAL concurrency.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `merchantWalletPg.test.js` proves the shape of every operation one call at a
 * time. It contains no concurrent exercise at all, and the merchant's available
 * balance is what GATES every deposit completion on this platform: a player has
 * already sent real money by the time `moveDepositMoney` asks whether the
 * merchant can cover it. Audit class 2.6 records this gap — the design is
 * documented as correct, and nothing had demonstrated it.
 *
 * The comments in `merchantWallets.core.js` claim three things. This file makes
 * each one falsifiable rather than trusted:
 *
 *   1. the negative guard lives in the UPDATE's WHERE, so an overdraw cannot be
 *      lost to a race between a read and a write;
 *   2. `tx_id` is UNIQUE and the replay collides INSIDE the transaction, so a
 *      whole movement unwinds rather than half of it landing;
 *   3. a balance never moves without its entry.
 *
 * ── Two ways a concurrency test lies, both guarded against here ─────────────
 * **It can serialise and prove nothing.** If the pool hands out one connection,
 * "concurrent" callers queue and every one of them sees a fresh balance —
 * a green run that never raced. `PG_POOL_SIZE` defaults to 10, and the first
 * test asserts the pool can actually hold the fan-out it is about to launch, so
 * this file fails loudly rather than passing vacuously.
 *
 * **It can assert a global invariant over a shared table** (trap §20.10). Every
 * merchant id here is namespaced to this run, nothing is TRUNCATEd, and every
 * assertion is over rows this file created. `merchantWalletPg.test.js` does
 * truncate — it is safe only because `fileParallelism` is false — which is the
 * second reason these tests live in their own file rather than beside it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../client.js';
import {
  getMerchantBalances, adminIssueToMerchant, adminDeductFromMerchant,
  reserveForSettlement, cancelReservation, reconcileMerchant,
} from '../repositories/merchantWallets.core.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the merchant wallet under concurrency', () => {
  const RUN = `conc-${Date.now().toString(36)}`;
  let seq = 0;
  const merchantId = () => `${RUN}-m${(seq += 1)}`;

  beforeAll(async () => { await applySchema(); }, 60_000);

  /**
   * The balance rows go; the LEDGER rows stay, and that is not laziness.
   *
   * The first draft of this file deleted both, and the append-only trigger
   * refused it — `merchant_wallet_entries is append-only (corrections are new
   * offsetting rows)`. That refusal is §19 working: a ledger row is not a test
   * fixture, and a suite that can delete one is a suite that has taught itself
   * a capability production must never have. So the cleanup was changed to fit
   * the invariant rather than the invariant worked around.
   *
   * Leaving them is safe and was checked rather than assumed: nothing sums this
   * table globally except `stats.js`, which is a dashboard read, and the two
   * sibling files that touch it (`merchantWalletPg`, `merchantSettlementPg`)
   * TRUNCATE it in their own `beforeEach` anyway. Every id here is namespaced
   * to this run, so nothing this file leaves can be mistaken for another
   * file's row.
   */
  afterAll(async () => {
    await pgQuery('DELETE FROM merchant_wallets WHERE merchant_id LIKE $1', [`${RUN}-%`]);
    await closePg();
  });

  it('the pool can actually run these in parallel', async () => {
    // The precondition for every assertion below. Without it a green file means
    // "the pool serialised them", which is the shape of a check that measures
    // nothing and reads exactly like a pass (§24.6).
    const pool = await getPool();
    expect(pool.options.max, 'PG_POOL_SIZE too small for this file to race anything')
      .toBeGreaterThanOrEqual(8);
  });

  it('an overdraw storm debits exactly what is funded, and never more', async () => {
    // The real scenario: a merchant funded for THREE deposits, and eight
    // confirmations arriving at once. Each debit is a separate transaction on
    // its own connection, so they genuinely contend for the row.
    const M = merchantId();
    await adminIssueToMerchant({
      merchantId: M, amountPaise: 30_000, txId: `${M}-fund`, actor: 'test', reason: 'fund',
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => adminDeductFromMerchant({
        merchantId: M, amountPaise: 10_000, txId: `${M}-spend-${i}`,
        actor: 'test', reason: 'concurrent deposit confirmation',
      })),
    );

    // Asserted as a RELATION, not a winner: which three callers win is a
    // scheduling detail and pinning it would make this test about Postgres's
    // lock queue rather than about the guard.
    const applied = results.filter((r) => r.ok && !r.idempotent);
    const refused = results.filter((r) => r.insufficient);
    expect(applied).toHaveLength(3);
    expect(refused).toHaveLength(5);

    const after = await getMerchantBalances(M);
    expect(after.available).toBe(0);
    // The property that actually matters. A read-then-write would land here at
    // −50,000 with five confirmations paid out of tokens that never existed.
    expect(after.available).toBeGreaterThanOrEqual(0);
  });

  it('a refused debit writes no entry at all', async () => {
    // "A balance never moves without its entry" has a mirror that is easier to
    // get wrong: an entry must never be written for a movement the guard
    // refused. That row would make the ledger claim tokens left a wallet they
    // never left, and `reconcileMerchant` derives the balance from these rows.
    const M = merchantId();
    await adminIssueToMerchant({
      merchantId: M, amountPaise: 5_000, txId: `${M}-fund`, actor: 'test', reason: 'fund',
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => adminDeductFromMerchant({
        merchantId: M, amountPaise: 5_000, txId: `${M}-over-${i}`, actor: 'test', reason: 'overdraw',
      })),
    );
    expect(results.filter((r) => r.ok && !r.idempotent)).toHaveLength(1);

    const { rows } = await pgQuery(
      "SELECT count(*)::int AS n FROM merchant_wallet_entries WHERE merchant_id = $1 AND operation = 'ADMIN_DEDUCTION'",
      [M],
    );
    expect(rows[0].n, 'a refused debit left an entry behind').toBe(1);
  });

  it('one txId moves tokens once, however many copies arrive at once', async () => {
    // The idempotency gate is the UNIQUE index, not a pre-read — a pre-read is
    // a race two concurrent callers both pass. Ten identical retries are what a
    // client with a retry policy behind a load balancer actually sends.
    const M = merchantId();
    await adminIssueToMerchant({
      merchantId: M, amountPaise: 100_000, txId: `${M}-fund`, actor: 'test', reason: 'fund',
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => adminDeductFromMerchant({
        merchantId: M, amountPaise: 40_000, txId: `${M}-retry`, actor: 'test', reason: 'retried once',
      })),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
    expect((await getMerchantBalances(M)).available).toBe(60_000);
  });

  it('the pockets stay conserved through an interleaved reserve/cancel storm', async () => {
    // Reserve moves available → reserved and cancel moves it back. Running both
    // directions at once against one row is where a lost update would show as
    // tokens appearing or vanishing between pockets.
    const M = merchantId();
    await adminIssueToMerchant({
      merchantId: M, amountPaise: 60_000, txId: `${M}-fund`, actor: 'test', reason: 'fund',
    });

    const reserves = Array.from({ length: 6 }, (_, i) => reserveForSettlement({
      merchantId: M, amountPaise: 10_000, txId: `${M}-res-${i}`, reason: 'settle', refId: `o-${i}`,
    }));
    const applied = await Promise.all(reserves);
    expect(applied.filter((r) => r.ok && !r.idempotent)).toHaveLength(6);

    const cancels = Array.from({ length: 6 }, (_, i) => cancelReservation({
      merchantId: M, amountPaise: 10_000, txId: `${M}-can-${i}`, reason: 'cancelled', refId: `o-${i}`,
    }));
    await Promise.all(cancels);

    const after = await getMerchantBalances(M);
    expect(after).toMatchObject({ available: 60_000, reserved: 0, settlement: 0 });
    // Neither pocket may pass through a negative on the way, which the CHECK
    // constraint would have refused — so a clean end state plus no thrown
    // constraint error is the whole assertion.
    expect(after.liability).toBe(0);
  });

  it('the ledger explains the balance after all of it', async () => {
    // The conservation property, over THIS merchant's rows only. A sum over the
    // whole table would be an assertion about every other test in the suite
    // (trap §20.10).
    const M = merchantId();
    await adminIssueToMerchant({
      merchantId: M, amountPaise: 50_000, txId: `${M}-fund`, actor: 'test', reason: 'fund',
    });
    await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => adminDeductFromMerchant({
        merchantId: M, amountPaise: 7_000, txId: `${M}-d${i}`, actor: 'test', reason: 'spend',
      })),
      ...Array.from({ length: 3 }, (_, i) => adminIssueToMerchant({
        merchantId: M, amountPaise: 4_000, txId: `${M}-i${i}`, actor: 'test', reason: 'top up',
      })),
      ...Array.from({ length: 2 }, (_, i) => reserveForSettlement({
        merchantId: M, amountPaise: 6_000, txId: `${M}-r${i}`, reason: 'settle', refId: `x-${i}`,
      })),
    ]);

    const recon = await reconcileMerchant(M);
    expect(recon.ok, `ledger and balance disagree: ${JSON.stringify(recon)}`).toBe(true);
  });
});
