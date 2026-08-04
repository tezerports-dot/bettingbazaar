// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/settlementPg.js — cycle settlement, in PostgreSQL.
 *
 * Domain 6. A cycle closes, a side wins, and every bet on it becomes WON or
 * LOST. The per-bet money movements belong to betPg; this module owns the RUN.
 *
 * ── What the Mongo path is missing, and what it gets right ──────────────────
 * It gets the hard part right. `Cycle.isSettled` PENDING→PROCESSING deliberately
 * RE-ADMITS a PROCESSING cycle so a recovery task can resume an interrupted
 * payout, which means two passes over one cycle is a SUPPORTED scenario rather
 * than a bug — and money safety rests entirely on per-bet idempotency. That is
 * the right design, and it is why `settlementConcurrency.integration.test.js`
 * can assert no double-credit across two concurrent passes.
 *
 * What it lacks is a record of what a pass actually DID. A half-finished run
 * cannot be distinguished from a finished one except by re-deriving it from the
 * bets, so "did settlement complete?" has no answer an operator can read —
 * only one they can reconstruct.
 *
 * Here a run is a row: which cycle, which side won, how many bets it has
 * settled so far, and how much it paid out. Resuming is still supported and
 * still safe, but now it is also VISIBLE.
 *
 * ── One settlement per cycle, ever ──────────────────────────────────────────
 * `cycle_settlements.cycle_id` is UNIQUE. A second run for the same cycle is
 * not a new settlement; it is the same one being resumed, and it finds the row
 * already there. That single constraint is what makes "settle this cycle twice"
 * structurally impossible rather than merely guarded against — and it is the
 * property the Mongo `isSettled` flag cannot express, because a flag can be
 * flipped back.
 *
 * ── Why the result cannot change under a resumed run ────────────────────────
 * `winning_side` is written when the run is opened and is never updated. A
 * resumed pass settles the remaining bets against the side the FIRST pass
 * recorded, so a cycle whose result was corrected mid-settlement cannot pay
 * some bets on one result and the rest on another. Correcting a declared result
 * is a void-and-resettle, not an in-place edit.
 */
import { getPool, pgQuery, connectGuarded } from './pgClient.js';
import { moneyOperations } from '../services/metrics.service.js';
import { MONEY_PATHS } from './moneyAuthority.js';
import { BET_STATUS, winBet, loseBet, voidBet } from './betPg.js';

export const SETTLEMENT_STATUS = Object.freeze({
  RUNNING:   'RUNNING',
  COMPLETED: 'COMPLETED',
  VOIDED:    'VOIDED',
});

const toPaise = (v) => Number(v ?? 0);

function count(operation, outcome) {
  moneyOperations.inc({ path: MONEY_PATHS.SETTLEMENTS, store: 'postgres', operation, outcome });
}

function rowToSettlement(row) {
  if (!row) return null;
  return {
    settlementId: row.settlement_id,
    cycleId:      row.cycle_id,
    winningSide:  row.winning_side,
    status:       row.status,
    betsTotal:    Number(row.bets_total),
    betsSettled:  Number(row.bets_settled),
    payoutPaise:  toPaise(row.payout_paise),
    stakePaise:   toPaise(row.stake_paise),
    startedAt:    row.started_at,
    completedAt:  row.completed_at,
  };
}

/** The settlement run for a cycle, or null. */
export async function getCycleSettlement(cycleId) {
  const { rows } = await pgQuery(
    `SELECT * FROM cycle_settlements WHERE cycle_id = $1`,
    [String(cycleId)], 'cycle_settlement_read',
  );
  return rowToSettlement(rows[0]);
}

/**
 * Claim a cycle for settlement, or join the run that already owns it.
 *
 * Returns `{ resumed: true }` when a previous pass opened it. That is not an
 * error and must not be treated as one: an interrupted payout resuming is the
 * scenario this domain is built around, and a caller that backed off on
 * `resumed` would strand exactly the cycles that need finishing.
 */
export async function openSettlement({ cycleId, winningSide, betsTotal = 0, stakePaise = 0 }) {
  if (!cycleId) throw new Error('openSettlement requires a cycleId');
  if (!winningSide) throw new Error('openSettlement requires a winningSide');

  const settlementId = `cs_${cycleId}`;
  // ON CONFLICT on the CYCLE, not the settlement id: one settlement per cycle
  // is the invariant, and the id is derived from the cycle only as a
  // convenience. DO UPDATE with a no-op SET is what makes RETURNING give back
  // the existing row rather than nothing.
  const { rows } = await pgQuery(
    `INSERT INTO cycle_settlements
       (settlement_id, cycle_id, winning_side, status, bets_total, stake_paise)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (cycle_id) DO UPDATE SET updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [settlementId, String(cycleId), String(winningSide), SETTLEMENT_STATUS.RUNNING, betsTotal, stakePaise],
    'cycle_settlement_open',
  );

  const settlement = rowToSettlement(rows[0]);
  const resumed = rows[0].inserted === false;
  count('SETTLEMENT_OPEN', resumed ? 'resumed' : 'applied');
  return { ok: true, resumed, settlement };
}

/**
 * Settle one bet against the run, and account for it on the run's totals.
 *
 * The bet transition is idempotent in betPg, so a resumed pass re-offering a
 * bet it already settled moves no money. The run's counters are advanced ONLY
 * when the transition actually happened, which is what keeps `betsSettled`
 * meaningful across a resume instead of inflating on every pass.
 */
export async function settleBet({
  settlementId, cycleId, betId, userId, slices, won, payoutPaise = 0, actor = 'settlement',
}) {
  const outcome = won
    ? await winBet({ betId, userId, slices, payoutPaise, actor, reason: `Cycle ${cycleId} settled` })
    : await loseBet({ betId, userId, slices, actor, reason: `Cycle ${cycleId} settled` });

  if (!outcome.ok) {
    count('SETTLEMENT_BET', outcome.reason ?? 'error');
    return outcome;
  }
  if (outcome.idempotent) {
    // Already settled by an earlier pass. Not an error, and deliberately not
    // counted again — see the note above.
    count('SETTLEMENT_BET', 'idempotent');
    return outcome;
  }

  await pgQuery(
    `UPDATE cycle_settlements
        SET bets_settled = bets_settled + 1,
            payout_paise = payout_paise + $2,
            updated_at = now()
      WHERE settlement_id = $1`,
    [String(settlementId), payoutPaise], 'cycle_settlement_progress',
  );
  count('SETTLEMENT_BET', 'applied');
  return outcome;
}

/**
 * RUNNING → COMPLETED. The guard is in the WHERE clause, so two passes
 * finishing at once complete it once.
 */
export async function completeSettlement({ cycleId }) {
  const { rows } = await pgQuery(
    `UPDATE cycle_settlements
        SET status = $2, completed_at = now(), updated_at = now()
      WHERE cycle_id = $1 AND status = $3
      RETURNING *`,
    [String(cycleId), SETTLEMENT_STATUS.COMPLETED, SETTLEMENT_STATUS.RUNNING],
    'cycle_settlement_complete',
  );
  if (!rows.length) {
    const existing = await getCycleSettlement(cycleId);
    if (existing?.status === SETTLEMENT_STATUS.COMPLETED) {
      count('SETTLEMENT_COMPLETE', 'idempotent');
      return { ok: true, idempotent: true, settlement: existing };
    }
    count('SETTLEMENT_COMPLETE', 'invalid_transition');
    return { ok: false, reason: existing ? 'invalid_transition' : 'not_found', status: existing?.status };
  }
  count('SETTLEMENT_COMPLETE', 'applied');
  return { ok: true, idempotent: false, settlement: rowToSettlement(rows[0]) };
}

/**
 * RUNNING → VOIDED. The cycle is abandoned and every outstanding bet on it has
 * its stake returned.
 *
 * Voiding is not a way to correct a declared result — a corrected result means
 * voiding and settling afresh, which leaves both runs in the history. Editing
 * `winning_side` in place would let a single run pay some bets on one result
 * and the rest on another.
 */
export async function voidSettlement({ cycleId, bets = [], actor = 'settlement', reason = null }) {
  const { rows } = await pgQuery(
    `UPDATE cycle_settlements
        SET status = $2, completed_at = now(), updated_at = now()
      WHERE cycle_id = $1 AND status = $3
      RETURNING *`,
    [String(cycleId), SETTLEMENT_STATUS.VOIDED, SETTLEMENT_STATUS.RUNNING],
    'cycle_settlement_void',
  );

  const existing = rows.length ? rowToSettlement(rows[0]) : await getCycleSettlement(cycleId);
  if (!existing) {
    count('SETTLEMENT_VOID', 'not_found');
    return { ok: false, reason: 'not_found' };
  }
  if (!rows.length && existing.status !== SETTLEMENT_STATUS.VOIDED) {
    count('SETTLEMENT_VOID', 'invalid_transition');
    return { ok: false, reason: 'invalid_transition', status: existing.status };
  }

  // Return every outstanding stake. voidBet is idempotent per bet, so a
  // re-voided run returns nothing further — which is what makes this safe to
  // call again after a partial failure.
  const returned = [];
  for (const bet of bets) {
    const r = await voidBet({
      betId: bet.betId, userId: bet.userId, slices: bet.slices,
      actor, reason: reason || `Cycle ${cycleId} voided`,
    });
    if (r.ok && !r.idempotent) returned.push(bet.betId);
  }

  count('SETTLEMENT_VOID', rows.length ? 'applied' : 'idempotent');
  return { ok: true, idempotent: !rows.length, settlement: existing, returned };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Runs that claim to be COMPLETED while bets on their cycle are still PENDING.
 *
 * The single strongest statement this domain can make about itself. A completed
 * settlement with unsettled bets means either the run stopped early and marked
 * itself done, or a bet was placed after settlement began — and both are
 * situations where a player's stake is locked with nothing coming to release it.
 */
export async function findIncompleteSettlements() {
  const { rows } = await pgQuery(
    `SELECT s.cycle_id, s.status, s.bets_settled,
            COUNT(b.id) FILTER (WHERE b.status = $1) AS still_pending
       FROM cycle_settlements s
       JOIN bets b ON b.cycle_id = s.cycle_id
      WHERE s.status = $2
      GROUP BY s.cycle_id, s.status, s.bets_settled
     HAVING COUNT(b.id) FILTER (WHERE b.status = $1) > 0
      LIMIT 500`,
    [BET_STATUS.PENDING, SETTLEMENT_STATUS.COMPLETED], 'settlement_incomplete',
  );
  return rows.map((r) => ({
    cycleId: r.cycle_id, status: r.status,
    betsSettled: Number(r.bets_settled), stillPending: Number(r.still_pending),
  }));
}

/** Does a run's recorded payout match what its bets actually paid? */
export async function reconcileSettlement(cycleId) {
  const [settlement, { rows }] = await Promise.all([
    getCycleSettlement(cycleId),
    pgQuery(
      `SELECT COALESCE(SUM(payout_paise), 0) AS payout,
              COUNT(*) FILTER (WHERE status <> $2) AS settled
         FROM bets WHERE cycle_id = $1`,
      [String(cycleId), BET_STATUS.PENDING], 'settlement_reconcile',
    ),
  ]);
  if (!settlement) return { ok: false, reason: 'not_found' };

  const fromBets = { payoutPaise: toPaise(rows[0].payout), betsSettled: Number(rows[0].settled) };
  const drift = {
    payoutPaise: settlement.payoutPaise - fromBets.payoutPaise,
    betsSettled: settlement.betsSettled - fromBets.betsSettled,
  };
  return { ok: drift.payoutPaise === 0 && drift.betsSettled === 0, settlement, fromBets, drift };
}
