// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/markets.js — the betting cycle.
 *
 * A cycle opens, takes bets on two sides, closes, declares a winner, and
 * settles. This module owns the row; `bets.core.js` owns the wagers against it
 * and `settlements.js` owns the payout.
 *
 * ── Three rules that cost real incidents ────────────────────────────────────
 *
 * 1. REAL POOLS ARE DERIVED, NEVER STORED. A bet holds `FOR SHARE` on the cycle
 *    row while it commits. A bet that also UPDATEd that row would block against
 *    another bet doing the same — 40P01, on the hottest path on the platform.
 *    `getPools` reads them from `bets`; only the phantom figures, which nothing
 *    concurrent writes, live on the row.
 *
 * 2. THE WINNER IS WRITTEN BEFORE THE STATUS, in the same statement. Ordering
 *    them the other way opens a window in which a cycle is COMPLETED with no
 *    winner, and the settlement sweep reads exactly that.
 *
 * 3. A CYCLE WITH NO WINNER IS NOT OFFERED FOR SETTLEMENT. `claimSettleable`
 *    filters on it, and the table's CHECK makes the state unreachable anyway —
 *    two layers, because this one silently paid nobody for an entire release.
 */
import { pgQuery } from '../client.js';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';

export const CYCLE_STATUS = Object.freeze({
  OPEN: 'OPEN', CLOSED: 'CLOSED', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED',
});
export const SIDES = Object.freeze(['DELHI', 'BOMBAY']);

const COLUMNS = `cycle_id, cycle_type, start_time, end_time, status,
  phantom_delhi_paise, phantom_bombay_paise, phantom_balanced, phantom_bets_closed,
  winner, pending_result, is_paused, winner_determined_at, winner_determined_by,
  winner_confidence, is_settled, settled_at, total_paid_out_paise, net_profit_paise,
  total_platform_fees_paise, winnings_fee_percent_used, created_at, updated_at`;

/** BIGINT arrives as a STRING. Cast once, here. */
const num = (v) => Number(v ?? 0);

function toCycle(r) {
  if (!r) return null;
  return {
    cycleId: r.cycle_id, _id: r.cycle_id,
    type: r.cycle_type,
    startTime: r.start_time, endTime: r.end_time,
    status: r.status,
    phantomDelhi: paiseToRupees(num(r.phantom_delhi_paise)),
    phantomBombay: paiseToRupees(num(r.phantom_bombay_paise)),
    phantomBalanced: r.phantom_balanced,
    phantomBetsClosed: r.phantom_bets_closed,
    winner: r.winner,
    pendingResult: r.pending_result,
    isPaused: r.is_paused,
    winnerDetermined: r.winner !== null,
    winnerDeterminedAt: r.winner_determined_at,
    winnerDeterminedBy: r.winner_determined_by,
    winnerConfidence: r.winner_confidence === null ? null : Number(r.winner_confidence),
    isSettled: r.is_settled,
    settledAt: r.settled_at,
    totalPaidOut: paiseToRupees(num(r.total_paid_out_paise)),
    netProfit: paiseToRupees(num(r.net_profit_paise)),
    totalPlatformFees: paiseToRupees(num(r.total_platform_fees_paise)),
    winningsFeePercentUsed: r.winnings_fee_percent_used === null
      ? null : Number(r.winnings_fee_percent_used),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getCycle(cycleId) {
  if (!cycleId) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles WHERE cycle_id = $1`, [String(cycleId)], 'cycle_get',
  );
  return toCycle(rows[0]);
}

/** The cycle currently taking bets for a type, if there is one. */
export async function getOpenCycle(cycleType) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE cycle_type = $1 AND status = 'OPEN' AND end_time > now()
      ORDER BY start_time DESC LIMIT 1`,
    [String(cycleType)], 'cycle_get_open',
  );
  return toCycle(rows[0]);
}

/**
 * The REAL pools, derived from the bets themselves.
 *
 * Never stored on the cycle row — see rule 1. Phantom figures come from the row
 * because nothing concurrent writes them; the two are added here so a caller
 * sees one displayed total without needing to know which half came from where.
 */
export async function getPools(cycleId) {
  const { rows } = await pgQuery(
    `SELECT
       COALESCE(SUM(stake_paise) FILTER (WHERE side = 'DELHI'), 0)  AS delhi,
       COALESCE(SUM(stake_paise) FILTER (WHERE side = 'BOMBAY'), 0) AS bombay,
       COUNT(*) FILTER (WHERE side = 'DELHI')::int  AS delhi_bets,
       COUNT(*) FILTER (WHERE side = 'BOMBAY')::int AS bombay_bets
     FROM bets WHERE cycle_id = $1 AND status NOT IN ('VOID', 'REFUNDED')`,
    [String(cycleId)], 'cycle_pools',
  );
  const r = rows[0];
  const cycle = await getCycle(cycleId);
  const realDelhi = num(r.delhi);
  const realBombay = num(r.bombay);
  const phantomDelhi = rupeesToPaise(cycle?.phantomDelhi ?? 0);
  const phantomBombay = rupeesToPaise(cycle?.phantomBombay ?? 0);
  return {
    realDelhiPaise: realDelhi, realBombayPaise: realBombay,
    realDelhi: paiseToRupees(realDelhi), realBombay: paiseToRupees(realBombay),
    phantomDelhi: paiseToRupees(phantomDelhi), phantomBombay: paiseToRupees(phantomBombay),
    totalDelhi: paiseToRupees(realDelhi + phantomDelhi),
    totalBombay: paiseToRupees(realBombay + phantomBombay),
    delhiBets: r.delhi_bets, bombayBets: r.bombay_bets,
  };
}

/** Recent cycles for a type, newest first — the results page. */
export async function listCycles({ cycleType = null, status = null, limit = 50, before = null } = {}) {
  const where = []; const params = [];
  if (cycleType) { params.push(String(cycleType)); where.push(`cycle_type = $${params.length}`); }
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  if (before) { params.push(before); where.push(`start_time < $${params.length}`); }
  const size = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY start_time DESC LIMIT ${size}`,
    params, 'cycle_list',
  );
  return rows.map(toCycle);
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create the cycle for a type and start instant, or return the existing one.
 *
 * Two generators waking together must produce ONE cycle. The unique index
 * decides, not a prior existence check — `ON CONFLICT DO NOTHING` makes the
 * loser a no-op rather than an error, and the loser then reads the winner's row.
 */
export async function ensureCycle({ cycleId, cycleType, startTime, endTime }) {
  const { rows } = await pgQuery(
    `INSERT INTO cycles (cycle_id, cycle_type, start_time, end_time)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (cycle_type, start_time) DO NOTHING
     RETURNING ${COLUMNS}`,
    [String(cycleId), String(cycleType), startTime, endTime], 'cycle_ensure',
  );
  if (rows[0]) return { cycle: toCycle(rows[0]), created: true };
  const { rows: existing } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles WHERE cycle_type = $1 AND start_time = $2`,
    [String(cycleType), startTime], 'cycle_ensure_read',
  );
  return { cycle: toCycle(existing[0]), created: false };
}

/** Close betting. Guarded by the state IN the statement, so it happens once. */
export async function closeCycle(cycleId) {
  const { rows } = await pgQuery(
    `UPDATE cycles SET status = 'CLOSED', updated_at = now()
      WHERE cycle_id = $1 AND status = 'OPEN'
      RETURNING ${COLUMNS}`,
    [String(cycleId)], 'cycle_close',
  );
  return rows[0] ? { ok: true, cycle: toCycle(rows[0]) } : { ok: false, reason: 'NOT_OPEN' };
}

/**
 * Declare the winner.
 *
 * ONE STATEMENT, and the winner is set in the same UPDATE as the status —
 * never two. Ordering them apart opens a window in which the cycle reads as
 * COMPLETED with no winner, and the settlement sweep reads exactly that.
 *
 * Guarded on `winner IS NULL`, so a second declaration for the same cycle
 * matches no row rather than overwriting a result players have already seen.
 */
export async function declareWinner(cycleId, winner, { by = 'engine', confidence = null } = {}) {
  if (!SIDES.includes(winner)) throw new Error(`declareWinner: unknown side '${winner}'`);
  const { rows } = await pgQuery(
    `UPDATE cycles SET
       winner = $2, winner_determined_at = now(), winner_determined_by = $3,
       winner_confidence = $4, status = 'COMPLETED', updated_at = now()
      WHERE cycle_id = $1 AND winner IS NULL AND status IN ('OPEN', 'CLOSED')
      RETURNING ${COLUMNS}`,
    [String(cycleId), winner, String(by), confidence], 'cycle_declare',
  );
  if (rows[0]) return { ok: true, cycle: toCycle(rows[0]) };
  const current = await getCycle(cycleId);
  if (!current) return { ok: false, reason: 'NOT_FOUND' };
  return { ok: false, reason: 'ALREADY_DECLARED', winner: current.winner };
}

/**
 * Claim cycles that are ready to settle.
 *
 * `FOR UPDATE SKIP LOCKED` so several settlement workers can run at once
 * without two of them claiming the same cycle. `winner IS NOT NULL` is rule 3:
 * a cycle with no result must never be offered, whatever its status says.
 */
export async function claimSettleable({ limit = 10 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE winner IS NOT NULL AND NOT is_settled AND end_time <= now()
      ORDER BY end_time ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [Math.min(Math.max(Number(limit) || 10, 1), 100)], 'cycle_claim_settleable',
  );
  return rows.map(toCycle);
}

/**
 * Record the settlement outcome.
 *
 * The totals are RECONSTRUCTED by the caller from the settled bet rows, never
 * accumulated across passes: an accumulator counts passes rather than rows, and
 * a crash mid-settlement loses the count permanently while the money stays
 * correct. Guarded on `NOT is_settled` so a replay writes nothing.
 */
export async function markSettled(cycleId, { paidOutRupees, netProfitRupees, platformFeesRupees, feePercentUsed }) {
  const { rows } = await pgQuery(
    `UPDATE cycles SET
       is_settled = TRUE, settled_at = now(),
       total_paid_out_paise = $2, net_profit_paise = $3,
       total_platform_fees_paise = $4, winnings_fee_percent_used = $5,
       updated_at = now()
      WHERE cycle_id = $1 AND NOT is_settled AND winner IS NOT NULL
      RETURNING ${COLUMNS}`,
    [String(cycleId), rupeesToPaise(paidOutRupees || 0), rupeesToPaise(netProfitRupees || 0),
      rupeesToPaise(platformFeesRupees || 0), feePercentUsed ?? null],
    'cycle_mark_settled',
  );
  return rows[0] ? { ok: true, cycle: toCycle(rows[0]) } : { ok: false, reason: 'ALREADY_SETTLED_OR_NO_WINNER' };
}

/** Phantom liquidity. Admin-set, and the only pool figures stored on the row. */
export async function setPhantomPools(cycleId, { delhiRupees, bombayRupees, balanced = null, betsClosed = null }) {
  const { rows } = await pgQuery(
    `UPDATE cycles SET
       phantom_delhi_paise  = COALESCE($2, phantom_delhi_paise),
       phantom_bombay_paise = COALESCE($3, phantom_bombay_paise),
       phantom_balanced     = COALESCE($4, phantom_balanced),
       phantom_bets_closed  = COALESCE($5, phantom_bets_closed),
       updated_at = now()
      WHERE cycle_id = $1
      RETURNING ${COLUMNS}`,
    [String(cycleId),
      delhiRupees === undefined || delhiRupees === null ? null : rupeesToPaise(delhiRupees),
      bombayRupees === undefined || bombayRupees === null ? null : rupeesToPaise(bombayRupees),
      balanced, betsClosed],
    'cycle_set_phantom',
  );
  return toCycle(rows[0]);
}

/** Pause or resume a cycle. An admin control, separate from its lifecycle. */
export async function setPaused(cycleId, isPaused) {
  const { rows } = await pgQuery(
    `UPDATE cycles SET is_paused = $2, updated_at = now()
      WHERE cycle_id = $1 RETURNING ${COLUMNS}`,
    [String(cycleId), Boolean(isPaused)], 'cycle_set_paused',
  );
  return toCycle(rows[0]);
}

/** A pending result an admin has staged but not yet declared. */
export async function setPendingResult(cycleId, side) {
  if (side !== null && !SIDES.includes(side)) throw new Error(`setPendingResult: unknown side '${side}'`);
  const { rows } = await pgQuery(
    `UPDATE cycles SET pending_result = $2, updated_at = now()
      WHERE cycle_id = $1 AND winner IS NULL
      RETURNING ${COLUMNS}`,
    [String(cycleId), side], 'cycle_set_pending',
  );
  return rows[0] ? { ok: true, cycle: toCycle(rows[0]) } : { ok: false, reason: 'ALREADY_DECLARED' };
}

/**
 * Cycles that ended but were never given a result.
 *
 * This is the check that would have caught the silent-never-settled defect on
 * the day it shipped: the engine looked healthy, every individual read
 * succeeded, and no cycle ever left OPEN.
 */
export async function findStalledCycles({ olderThanMinutes = 5 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE winner IS NULL
        AND status IN ('OPEN', 'CLOSED')
        AND end_time < now() - ($1 || ' minutes')::interval
      ORDER BY end_time ASC LIMIT 100`,
    [String(Math.max(Number(olderThanMinutes) || 5, 1))], 'cycle_find_stalled',
  );
  return rows.map(toCycle);
}
