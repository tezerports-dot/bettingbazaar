// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/settlementPgAuthority.js — the cycle settlement RUN, behind the resolver.
 *
 * `gameEngine.processPayoutsOptimized` opens a settlement by flipping
 * `Cycle.isSettled` to PROCESSING and closes it by writing COMPLETED with the
 * totals. This module is the other implementation of those two moments, and
 * `isPostgresAuthoritative(MONEY_PATHS.SETTLEMENTS)` decides per call which one
 * is the source of truth.
 *
 * ── What routing this actually buys ─────────────────────────────────────────
 * Not the per-bet money — that belongs to the bets domain and already routes
 * through `betPgAuthority`. What the Mongo flag cannot express is the RUN:
 *
 *   - `cycle_settlements.cycle_id` is UNIQUE, so "settle this cycle twice" is
 *     structurally impossible rather than guarded by a field that can be
 *     written back to PENDING.
 *   - `winning_side` is written once and never updated, so a resumed pass
 *     settles the remaining bets against the result the FIRST pass recorded.
 *     A cycle whose declared result was corrected mid-payout cannot pay some
 *     bets on one result and the rest on another.
 *   - A COMPLETED run with bets still PENDING is a query
 *     (`findIncompleteSettlements`) rather than something an operator has to
 *     re-derive from the bets.
 *
 * ── Resuming is a supported outcome, not an error ───────────────────────────
 * `openSettlement` returns `{ resumed: true }` when a previous pass already
 * owns the cycle, and callers MUST treat that as permission to continue.
 * gameEngine deliberately re-admits a PROCESSING cycle so `payoutRecoveryTask`
 * can finish an interrupted payout; a caller that backed off on `resumed` would
 * strand exactly the cycles that need finishing, with player stakes locked and
 * nothing coming to release them.
 *
 * ── The Mongo write is not skipped when Postgres wins ───────────────────────
 * It becomes the MIRROR instead of the source of truth. The engine reads
 * `Cycle.isSettled` in several places (the tick query, the recovery sweep,
 * `getGameState`), so a Postgres-authoritative run that stopped writing it
 * would leave the engine unable to see its own work. The reverse mirror is what
 * keeps that field current, which is also what makes falling back to Mongo a
 * redeploy rather than a data recovery.
 */
import { rupeesToPaise } from '../shared/money.js';
import { isPostgresAuthoritative, MONEY_PATHS } from './moneyAuthority.js';
import {
  openSettlement, completeSettlement, getCycleSettlement, SETTLEMENT_STATUS,
} from './settlementPg.js';
import { reverseMirrorCycleSettlement } from './reverseMirror.js';

/** Is Postgres the source of truth for the settlement run? */
export const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.SETTLEMENTS);

/**
 * Claim a cycle for settlement.
 *
 * Returns `{ ok, resumed, source }`. On the Mongo path the caller's own
 * `findOneAndUpdate` lock is still the gate and this reports `source: 'mongo'`
 * without touching anything — the forward mirror in `dualWrite` covers that
 * direction, and doing it from here as well would write the row twice.
 */
export async function beginSettlement({ cycleId, winningSide, betsTotal = 0, stakeRupees = 0 }) {
  if (!onPostgres()) return { ok: true, resumed: false, source: 'mongo' };

  const result = await openSettlement({
    cycleId, winningSide, betsTotal,
    stakePaise: rupeesToPaise(Number(stakeRupees) || 0),
  });
  // Push the claim back to Mongo immediately. The engine's own queries read
  // `Cycle.isSettled`, so a run that exists only in Postgres would be invisible
  // to the recovery sweep that has to finish it if this node dies.
  if (result.ok) {
    reverseMirrorCycleSettlement({
      cycle_id: cycleId, status: SETTLEMENT_STATUS.RUNNING,
      payout_paise: result.settlement?.payoutPaise ?? 0,
      completed_at: null, updated_at: new Date(),
    });
  }
  return { ...result, source: 'postgres' };
}

/**
 * RUNNING → COMPLETED, with the totals the pass actually paid.
 *
 * `idempotent: true` comes back when another pass finished it first. That is
 * not an error either: two passes racing to the end is the same supported
 * scenario as two passes racing to the start, and the guard is in the UPDATE's
 * WHERE clause so exactly one of them wins.
 */
export async function finishSettlement({ cycleId, payoutRupees = 0 }) {
  if (!onPostgres()) return { ok: true, idempotent: false, source: 'mongo' };

  const result = await completeSettlement({ cycleId });
  if (result.ok) {
    reverseMirrorCycleSettlement({
      cycle_id: cycleId, status: SETTLEMENT_STATUS.COMPLETED,
      payout_paise: rupeesToPaise(Number(payoutRupees) || 0),
      completed_at: result.settlement?.completedAt ?? new Date(),
      updated_at: new Date(),
    });
  }
  return { ...result, source: 'postgres' };
}

/** The run for a cycle, or null. Reads follow authority like the writes do. */
export async function readSettlement(cycleId) {
  if (!onPostgres()) return null;
  return getCycleSettlement(cycleId);
}
