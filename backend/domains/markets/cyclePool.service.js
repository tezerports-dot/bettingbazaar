// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/markets/cyclePool.service.js — derive the real bet pools from the
 * bets themselves instead of maintaining a running total on the Cycle document.
 *
 * ── The problem this exists to remove ──────────────────────────────────────
 * Every real bet used to run `$inc: { realDelhi, totalDelhi }` against the SAME
 * Cycle document. MongoDB writes are document-atomic, so bet #2's increment
 * cannot proceed until bet #1's has landed — not because the bets need
 * ordering (addition is commutative and nothing cares which came first), but
 * because a running total is a read-modify-write and two of them interleaved
 * lose an update.
 *
 * That serialisation does not improve when you add application instances: they
 * all queue on the same document. It is the horizontal-scaling ceiling
 * described in docs/governance/LATENCY.md, and `loadtest/bet-contention.js`
 * exists to measure where it sits.
 *
 * ── The approach ───────────────────────────────────────────────────────────
 * The Bet documents are already the source of truth — settlement pays out by
 * querying them (`gameEngine.processPayouts`), never from the pool counters.
 * So the counters are a projection, and a projection can be recomputed:
 *
 *     realDelhi  = SUM(Bet.amount) WHERE cycleId, side=DELHI,  isPhantom=false
 *     realBombay = SUM(Bet.amount) WHERE cycleId, side=BOMBAY, isPhantom=false
 *
 * Each bet is its own document insert, which contends with nothing.
 *
 * This mirrors the rule the money ledger already follows: "balances always
 * derived from postings, never stored" (04-GOVERNANCE.md §1, Revenue &
 * Settlement). The pool is the same shape of value.
 *
 * ── What is NOT derived, and why ───────────────────────────────────────────
 * `phantomDelhi`/`phantomBombay` stay stored fields. They are not a sum of
 * phantom Bet documents: the equalizer in `cycleGenerator.equalizePhantomPools`
 * OVERWRITES them with `$max(phantomDelhi, phantomBombay)` rather than adding
 * bets, so no aggregation over Bet rows can reproduce them. They also do not
 * need to be derived — phantom bets come from a handful of admin agents, not
 * from thousands of users, so they were never the contention source.
 *
 * The Cycle document therefore keeps carrying all six fields. Only the two
 * REAL pools change how they get their value, and `totalDelhi`/`totalBombay`
 * are recomputed as real + phantom whenever either moves. Every existing
 * reader — admin routes, broadcasts, the settlement engine — keeps reading
 * `cycle.realDelhi` exactly as before and needs no change.
 *
 * ── Staleness, and the two places it is not allowed ────────────────────────
 * Between refreshes the stored value trails the bets by up to one refresh
 * interval. That is fine for the live pool display, which is already a
 * throttled broadcast rather than a per-bet push.
 *
 * It is NOT fine for two moments, because both convert the number into money:
 *
 *   1. Winner determination — the minority real-bet side wins
 *      (`cycleGenerator.completeCycle`).
 *   2. `netProfit = realPool − totalPaidOut` (`gameEngine.processPayouts`).
 *
 * Both call `refreshRealPools(cycleId, { exact: true })` first, which reads
 * with `readConcern: 'majority'` and awaits the write. Both happen once per
 * cycle, so the cost is irrelevant and the correctness is absolute.
 *
 * ── Dormant by default ─────────────────────────────────────────────────────
 * Gated on `FLAGS.DERIVED_CYCLE_POOLS`, default false. With the flag off every
 * function here is a no-op and bet placement keeps its `$inc`, so importing
 * this module changes nothing. Do not enable it in production before
 * `loadtest/bet-contention.js` has been run — it is a money-path change, and
 * the load test is what says whether it is needed at all.
 */
import mongoose from 'mongoose';
import { isEnabled, FLAGS } from '../../services/featureFlags.service.js';

/** Cheap in-process memo so a broadcast burst does not re-aggregate per tick. */
const _lastRefresh = new Map();

/** How long a refreshed projection is considered fresh enough to reuse. */
const REFRESH_TTL_MS = Number(process.env.CYCLE_POOL_REFRESH_MS || 1000);

/** Bound the memo so a long-lived scheduler cannot leak one entry per cycle. */
const MAX_TRACKED_CYCLES = 500;

export async function derivedPoolsEnabled() {
  return isEnabled(FLAGS.DERIVED_CYCLE_POOLS);
}

/**
 * Sum the real (non-phantom) stakes on a cycle, per side, straight from the
 * bets.
 *
 * REFUNDED bets are excluded: a refund gives the stake back, so it is no
 * longer in the pool and must not influence the winner or netProfit. Every
 * other status counts — PENDING during the betting window, WON/LOST after
 * settlement has relabelled them — because the money was staked either way.
 * Filtering to PENDING alone would make the pool collapse to zero the moment
 * settlement ran, which is exactly when `netProfit` reads it.
 *
 * @param {string} cycleId
 * @param {{exact?: boolean}} [opts] exact reads with majority read concern.
 * @returns {Promise<{realDelhi: number, realBombay: number}>}
 */
export async function computeRealPools(cycleId, { exact = false } = {}) {
  const Bet = mongoose.model('Bet');

  const pipeline = [
    { $match: { cycleId, isPhantom: false, status: { $ne: 'REFUNDED' } } },
    { $group: { _id: '$side', total: { $sum: '$amount' } } },
  ];

  const rows = await Bet.aggregate(pipeline)
    .readConcern(exact ? 'majority' : 'local')
    .exec();

  let realDelhi = 0;
  let realBombay = 0;
  for (const row of rows) {
    if (row._id === 'DELHI') realDelhi = row.total || 0;
    else if (row._id === 'BOMBAY') realBombay = row.total || 0;
  }
  return { realDelhi, realBombay };
}

/**
 * Recompute the real pools and write them onto the Cycle, re-deriving the
 * combined totals from the phantom values as they stand at that instant.
 *
 * The write is a pipeline update so `totalDelhi` is computed from the
 * `phantomDelhi` present in the document at write time, not from a value read
 * earlier. Reading phantom first and writing `realDelhi + phantomWeRead` would
 * silently discard an equalizer run that landed in between — the same class of
 * bug the equalizer itself was fixed for (see `equalizePhantomPools`).
 *
 * @param {string} cycleId
 * @param {{exact?: boolean, force?: boolean}} [opts]
 *   exact — majority read concern; use at winner determination and settlement.
 *   force — bypass the freshness memo.
 * @returns {Promise<{realDelhi: number, realBombay: number} | null>}
 *   null when the flag is off or the cycle no longer exists.
 */
export async function refreshRealPools(cycleId, { exact = false, force = false } = {}) {
  if (!(await derivedPoolsEnabled())) return null;
  if (!cycleId) return null;

  if (!exact && !force) {
    const last = _lastRefresh.get(cycleId);
    if (last && Date.now() - last.at < REFRESH_TTL_MS) return last.pools;
  }

  const pools = await computeRealPools(cycleId, { exact });
  const Cycle = mongoose.model('Cycle');

  const updated = await Cycle.findOneAndUpdate(
    { cycleId },
    [
      { $set: { realDelhi: pools.realDelhi, realBombay: pools.realBombay } },
      {
        $set: {
          totalDelhi: { $add: [pools.realDelhi, { $ifNull: ['$phantomDelhi', 0] }] },
          totalBombay: { $add: [pools.realBombay, { $ifNull: ['$phantomBombay', 0] }] },
        },
      },
    ],
    { new: true },
  );

  if (!updated) return null;

  if (_lastRefresh.size >= MAX_TRACKED_CYCLES) _lastRefresh.clear();
  _lastRefresh.set(cycleId, { at: Date.now(), pools });
  return pools;
}

/** Drop a cycle's memo — call when a cycle settles so it cannot go stale. */
export function forgetCycle(cycleId) {
  _lastRefresh.delete(cycleId);
}

/** Test seam. */
export function _resetPoolMemo() {
  _lastRefresh.clear();
}
