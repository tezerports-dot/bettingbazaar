// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/markets/cyclePool.service.js — the real bet pools, derived.
 *
 * ── Two problems, and only one of them was solved before ────────────────────
 * Every real bet used to run an increment against the SAME cycle document, so
 * bet #2 could not proceed until bet #1's had landed — a read-modify-write on
 * the hottest path on the platform, and a ceiling that does not lift by adding
 * instances. That was correctly identified, and the fix was to DERIVE the real
 * pools by summing the bets.
 *
 * But the fix still WROTE the derived value back onto the cycle row, which
 * carries the same defect in a new place. Here it is worse than slow: a bet
 * holds `FOR SHARE` on the cycle row while it commits, so a writer that also
 * UPDATEs that row blocks against another bet doing the same, and PostgreSQL
 * ends it with a 40P01 deadlock. Only the PHANTOM figures live on the row,
 * because nothing concurrent writes them.
 *
 * So the pools are derived and NOT stored. `db.markets.realPools` sums the
 * stakes; `cycleWithPools` adds the phantom figures at read time.
 *
 * ── What this deletes, and why none of it is needed ─────────────────────────
 *
 * THE MEMO. A 5-second freshness cache existed because each refresh was a write
 * and writes were expensive. A sum over an indexed column is not.
 *
 * `exact: true` AND THE MAJORITY READ CONCERN. Two moments turn the pool into
 * money — deciding the winning side, and `netProfit = realPool − paidOut` — and
 * both needed a guarantee the ordinary read did not give. A single statement
 * against a consistent snapshot gives it to every caller, so there is no longer
 * a weaker mode to remember to avoid.
 *
 * `forgetCycle`. There is no memo to invalidate.
 *
 * The phantom figures stay stored: the equalizer OVERWRITES them with
 * `max(phantomDelhi, phantomBombay)` rather than adding bets, so no sum over
 * rows can reproduce them — and they come from a handful of admin agents, never
 * from the contention path.
 */
import { db } from '#db';

/**
 * The real pools for a cycle: stake summed per side, from the bets.
 *
 * REFUNDED and VOID stakes are excluded. Money returned to a player is not in
 * the pool the winner is paid from, and counting it inflates both the winner's
 * share and the platform's reported profit.
 */
export function computeRealPools(cycleId) {
  return db.markets.realPools(cycleId);
}

/**
 * The cycle with its real pools and combined totals.
 *
 * Replaces `refreshRealPools`, which recomputed and then wrote the result back.
 * Callers that used it to make the numbers current now simply read: there is no
 * refresh to run and no window in which the stored value trails the bets.
 */
export function cycleWithPools(cycleId) {
  return db.markets.cycleWithPools(cycleId);
}

/**
 * Kept as a no-op so the settlement path need not change shape.
 *
 * It dropped a cycle from the freshness memo when the cycle settled, so a stale
 * entry could not outlive it. There is no memo.
 */
export function forgetCycle() { /* no memo to forget */ }
