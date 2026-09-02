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
import { pgQuery, withTransaction } from '../client.js';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';

/**
 * The states a cycle moves through, in order.
 *
 * OPEN takes bets · MERGED folds in the phantom pools · CLOSED stops betting ·
 * RESULT_DECLARED names the winner · COMPLETED settles. PAUSED and CANCELLED
 * are admin interventions rather than steps.
 *
 * This is the ENGINE's vocabulary, not a tidier one: a state the engine uses
 * and the table refuses is a betting round that stops mid-cycle.
 */
export const CYCLE_STATUS = Object.freeze({
  OPEN: 'OPEN', MERGED: 'MERGED', CLOSED: 'CLOSED',
  RESULT_DECLARED: 'RESULT_DECLARED', COMPLETED: 'COMPLETED',
  PAUSED: 'PAUSED', CANCELLED: 'CANCELLED',
});

/** The states in which a cycle is still taking or holding live bets. */
export const LIVE_STATUSES = Object.freeze(['OPEN', 'MERGED', 'CLOSED', 'RESULT_DECLARED']);
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

/**
 * Place a phantom bet: the row, and the cycle's phantom pool, together.
 *
 * -- Why phantom pools ARE stored, when real ones are not -------------------
 * They are not a sum of phantom bet rows. `equalizePhantomPools` OVERWRITES
 * them with `max(delhi, bombay)` rather than adding, so no aggregation over
 * rows can reproduce them. They are also not the contention source: phantom
 * bets come from a handful of admin agents, never from thousands of players, so
 * the row lock this takes costs nothing.
 *
 * The bet row and the counter move in ONE transaction. They were two writes,
 * and a failure between them left a phantom bet the pools did not include —
 * invisible in the total a player sees, and still there at settlement.
 */
export async function placePhantomBet({ betId, userId, cycleId, side, amountRupees, cycleType = null }) {
  if (!betId) throw new Error('placePhantomBet requires a betId');
  const amountPaise = rupeesToPaise(amountRupees);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`placePhantomBet: amount must be positive, got ${amountRupees}`);
  }
  const column = side === 'DELHI' ? 'phantom_delhi_paise' : 'phantom_bombay_paise';

  return withTransaction(async (client) => {
    const { rows: cycle } = await client.query(
      `SELECT status, phantom_bets_closed FROM cycles WHERE cycle_id = $1 FOR UPDATE`,
      [String(cycleId)],
    );
    if (!cycle.length) return { ok: false, reason: 'CYCLE_NOT_FOUND' };
    if (!['OPEN', 'MERGED'].includes(cycle[0].status)) {
      return { ok: false, reason: 'CYCLE_CLOSED', status: cycle[0].status };
    }
    // Checked under the lock, so an admin closing phantom betting cannot be
    // raced by an agent's last bet.
    if (cycle[0].phantom_bets_closed) return { ok: false, reason: 'PHANTOM_CLOSED' };

    const { rows: bet } = await client.query(
      `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status,
                         is_phantom, phantom_manager_id, cycle_type)
       VALUES ($1,$2,$3,$4,$5,'PENDING',TRUE,$2,$6)
       ON CONFLICT (bet_id) DO NOTHING
       RETURNING *`,
      [String(betId), String(userId), String(cycleId), String(side), amountPaise, cycleType],
    );
    // A replayed request must not move the pool a second time.
    if (!bet.length) return { ok: true, idempotent: true };

    const { rows: updated } = await client.query(
      `UPDATE cycles SET ${column} = ${column} + $2, updated_at = now()
        WHERE cycle_id = $1 RETURNING ${COLUMNS}`,
      [String(cycleId), amountPaise],
    );
    return { ok: true, idempotent: false, cycle: toCycle(updated[0]) };
  });
}

/**
 * This cycle, but only if it is still taking bets.
 *
 * A READ, deliberately, and not the gate. The document version made it an
 * `$inc` on the pool totals with the status in the filter, so the "is it still
 * open" question and the pool update were one atomic act. That cannot be done
 * here and must not be: a bet holds `FOR SHARE` on the cycle row, so a bet that
 * also UPDATEd it would block against every other bet doing the same — 40P01,
 * on the hottest path on the platform. The pools are derived from the bets
 * instead, so there is nothing to increment.
 *
 * What settles the race is the BET insert, which carries the stake movement in
 * its own transaction. A cycle that closes between this read and that insert
 * costs at most one bet accepted a moment late — and the settlement pays from
 * the bet rows, so a late bet is paid or refunded like any other rather than
 * being lost.
 *
 * MERGED is accepted alongside OPEN: a merged cycle is still live, it has
 * simply been folded into a longer round.
 */
export async function getAcceptingCycle(cycleId) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE cycle_id = $1 AND status IN ('OPEN', 'MERGED')`,
    [String(cycleId)], 'cycle_get_accepting',
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
 * Every cycle still running, across all types — the public "what can I bet on"
 * read.
 *
 * `end_time > now()` as well as the status, because a cycle whose generator
 * died still reads OPEN and offering it would take bets on a round that will
 * never settle.
 */
export async function listActiveCycles() {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE status = ANY($1::text[]) AND end_time > now()
      ORDER BY cycle_type ASC, start_time ASC`,
    [['OPEN', 'MERGED']], 'cycle_list_active',
  );
  return rows.map(toCycle);
}

/**
 * The cycle covering an instant, for a type.
 *
 * A two-minute tolerance either side, because the caller's clock and the
 * server's differ and a page loading on the boundary must still find the round
 * it is showing. Falls back to the most recent declared result: during the
 * celebration window the current cycle has completed and the next has not
 * opened, and returning nothing would blank the page mid-animation.
 */
export async function getCycleAt(cycleType, atMs, { toleranceMs = 120_000 } = {}) {
  const at = new Date(Number(atMs));
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE cycle_type = $1
        AND start_time <= $2::timestamptz + ($3 || ' milliseconds')::interval
        AND end_time   >= $2::timestamptz - ($3 || ' milliseconds')::interval
        AND status = ANY($4::text[])
      ORDER BY start_time DESC LIMIT 1`,
    [String(cycleType), at, String(toleranceMs), LIVE_STATUSES], 'cycle_get_at',
  );
  if (rows[0]) return toCycle(rows[0]);

  const { rows: declared } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE cycle_type = $1 AND winner IS NOT NULL
      ORDER BY end_time DESC LIMIT 1`,
    [String(cycleType)], 'cycle_get_last_declared',
  );
  return toCycle(declared[0]);
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
/**
 * The REAL bet pools for a cycle, summed from the bets.
 *
 * -- Derived, never stored, and that is trap 4 ------------------------------
 * Storing these on the cycle row DEADLOCKS. A bet holds `FOR SHARE` on that row
 * while it commits, so a bet that also UPDATEs it blocks against another bet
 * doing the same — 40P01 on the hottest path on the platform. Only the PHANTOM
 * figures live on the row, because nothing concurrent writes them.
 *
 * PHANTOM bets are excluded, and this is the whole point of the word REAL:
 * phantom stakes are house figures that move the displayed total without
 * anybody having staked anything. Counting them here would inflate the pool a
 * winner is paid a share of, and decide the winning side — which is the
 * MINORITY real-bet side — from numbers nobody bet.
 *
 * REFUNDED and VOID are excluded too: a returned stake is not in the pool.
 *
 * There is no `exact` option and no memo. A sum over an indexed column is a
 * single statement against a consistent snapshot — the staleness the document
 * version had to reason about, and refresh around, does not exist here.
 */
export async function realPools(cycleId) {
  const { rows } = await pgQuery(
    `SELECT
       COALESCE(SUM(stake_paise) FILTER (WHERE side = 'DELHI'), 0)  AS delhi,
       COALESCE(SUM(stake_paise) FILTER (WHERE side = 'BOMBAY'), 0) AS bombay,
       COUNT(*) FILTER (WHERE side = 'DELHI')::int  AS delhi_bets,
       COUNT(*) FILTER (WHERE side = 'BOMBAY')::int AS bombay_bets
     FROM bets
     WHERE cycle_id = $1 AND NOT is_phantom AND status NOT IN ('REFUNDED', 'VOID')`,
    [String(cycleId)], 'cycle_real_pools',
  );
  const r = rows[0];
  return {
    realDelhi: paiseToRupees(Number(r.delhi)),
    realBombay: paiseToRupees(Number(r.bombay)),
    delhiBets: r.delhi_bets,
    bombayBets: r.bombay_bets,
  };
}

/**
 * A cycle with its real pools attached, and the combined totals.
 *
 * `totalDelhi` is real + phantom computed at READ time. The document version
 * wrote it back onto the row, which meant a broadcast and a settlement could
 * see different totals depending on which refresh had last run.
 */
export async function cycleWithPools(cycleId) {
  const cycle = await getCycle(cycleId);
  if (!cycle) return null;
  const pools = await realPools(cycleId);
  return {
    ...cycle,
    ...pools,
    totalDelhi: pools.realDelhi + (cycle.phantomDelhi || 0),
    totalBombay: pools.realBombay + (cycle.phantomBombay || 0),
  };
}

/**
 * Claim cycles to settle, and mean it.
 *
 * ── The claim that was not one ──────────────────────────────────────────────
 * This was a SELECT with `FOR UPDATE SKIP LOCKED`. That does nothing here:
 * `pgQuery` runs each statement in its own implicit transaction, so the lock
 * released the moment the SELECT returned and both settlement workers walked
 * the same cycles. `markSettled` is guarded on `NOT is_settled`, so only one
 * final write landed and nothing was paid twice — but both workers did the
 * entire settlement pass, and the function called "claim" claimed nothing.
 *
 * A lock cannot serve, either: the claim has to OUTLIVE the transaction that
 * takes it, because settling means walking a cycle's bets through other calls,
 * and holding a pooled client across those is the deadlock this codebase has
 * already paid for once.
 *
 * So the claim is a column, taken and released in ONE statement whose WHERE
 * clause is the gate. `leaseMinutes` bounds it: a worker that dies mid-pass
 * releases its cycles when the lease expires, rather than stranding them
 * forever — the failure mode a claim column has to answer for.
 */
export async function claimSettleable({ limit = 10, worker = 'settlement-engine', leaseMinutes = 15 } = {}) {
  const { rows } = await pgQuery(
    `UPDATE cycles SET
       settlement_claimed_at = now(),
       settlement_claimed_by = $2
     WHERE cycle_id IN (
       SELECT cycle_id FROM cycles
        WHERE winner IS NOT NULL AND NOT is_settled AND end_time <= now()
          AND (settlement_claimed_at IS NULL
               OR settlement_claimed_at < now() - ($3 || ' minutes')::interval)
        ORDER BY end_time ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING ${COLUMNS}`,
    [Math.min(Math.max(Number(limit) || 10, 1), 100), String(worker),
      // `Number(x) || 15` swallows an explicit 0, and 0 is meaningful here:
      // "reclaim everything now", which is how an operator drains a queue after
      // a worker fleet dies. Falsy-coalescing a number is the same trap the
      // withdrawal hold window already had.
      String(Number.isFinite(Number(leaseMinutes)) ? Math.max(Number(leaseMinutes), 0) : 15)],
    'cycle_claim_settleable',
  );
  return rows.map(toCycle);
}

/**
 * Hand a claimed cycle back without settling it.
 *
 * For a worker that claimed a cycle and could not finish — a refusal, a
 * shutdown. Returning it immediately beats waiting out the lease, and a lease
 * that is only ever waited out is a queue that stalls for fifteen minutes every
 * time anything goes wrong.
 */
export async function releaseSettlementClaim(cycleId) {
  const { rowCount } = await pgQuery(
    `UPDATE cycles SET settlement_claimed_at = NULL, settlement_claimed_by = NULL
      WHERE cycle_id = $1 AND NOT is_settled`,
    [String(cycleId)], 'cycle_release_claim',
  );
  return rowCount > 0;
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
 * The last N cycles with a declared result, newest first.
 *
 * `winner IS NOT NULL` rather than a status filter, because that is the
 * property the caller actually wants: a cycle whose result is in. Filtering on
 * status alone would miss a declared cycle whose settlement is still running,
 * and would include a COMPLETED one whose winner was somehow never written —
 * which the table now refuses, but the query should not depend on that.
 */
export async function recentResults(cycleType, { limit = 10 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE cycle_type = $1 AND winner IS NOT NULL
      ORDER BY end_time DESC LIMIT $2`,
    [String(cycleType), Math.min(Math.max(Number(limit) || 10, 1), 200)],
    'cycle_recent_results',
  );
  return rows.map(toCycle);
}

/**
 * Settled cycles whose accounting event was never posted.
 *
 * The betting-side twin of `findCompletedOrdersMissingEvents`. Same shape, same
 * reason: a LEFT JOIN answers "which of these has no ledger row" in one pass,
 * where a lookup per cycle answers it one round trip at a time and gets slower
 * exactly as the backlog it is meant to clear grows.
 */
export async function findSettledCyclesMissingEvents({ limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT c.* FROM cycles c
       LEFT JOIN accounting_events e
         ON e.ref_model = 'Cycle' AND e.ref_id = c.cycle_id
      WHERE c.status = 'COMPLETED' AND e.id IS NULL
      ORDER BY c.end_time ASC
      LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`,
    [], 'cycle_missing_accounting_event',
  );
  return rows.map(toCycle);
}

/**
 * Cycles that ended but were never given a result.
 *
 * This is the check that would have caught the silent-never-settled defect on
 * the day it shipped: the engine looked healthy, every individual read
 * succeeded, and no cycle ever left OPEN.
 *
 * ── Why it returns a count as well as a page ────────────────────────────────
 * It used to return a bare array under a hard `LIMIT 100`, which is the wrong
 * shape for the thing it feeds. An alarm that reads `stalled.length` cannot
 * tell a hundred stalled cycles from four hundred — it reports 100 either way,
 * and the number stops moving exactly when the outage is getting worse. The
 * total is counted over the whole matching set in the same snapshot as the
 * page, so the alarm has the real figure and the operator still gets the oldest
 * offenders to look at.
 */
export async function findStalledCycles({ olderThanMinutes = 5, limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS}, COUNT(*) OVER () AS total_rows FROM cycles
      WHERE winner IS NULL
        AND status IN ('OPEN', 'CLOSED')
        AND end_time < now() - ($1 || ' minutes')::interval
      ORDER BY end_time ASC LIMIT $2`,
    [String(Math.max(Number(olderThanMinutes) || 5, 1)),
      Math.min(Math.max(Number(limit) || 100, 1), 1000)],
    'cycle_find_stalled',
  );
  return { total: rows.length ? Number(rows[0].total_rows) : 0, cycles: rows.map(toCycle) };
}
