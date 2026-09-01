// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/cyclePg.js — the cycle, owned by PostgreSQL.
 *
 * The game's central entity. It lived only in MongoDB until now, and that
 * absence shaped the money path: with no row to lock, the bet-versus-settlement
 * boundary had to be arbitrated by an ADVISORY lock keyed on `hashtext(cycleId)`.
 *
 * ── Why a row lock is strictly better than the advisory lock it replaces ────
 * The advisory lock is correct but blunt, in two ways a real row is not:
 *
 *   1. `hashtext` returns int32. Two different cycle ids CAN hash to the same
 *      key. That never corrupts anything — the lock is still mutual — but it
 *      means a bet on one cycle can serialise behind the settlement of a
 *      completely unrelated one, which is invisible, unreproducible, and
 *      exactly the kind of thing that shows up as an unexplained latency spike.
 *   2. The lock and the question are separate statements. `placeBet` took the
 *      lock, then ran a SECOND query against `cycle_settlements` to ask whether
 *      the cycle was settling. With a row lock the lock IS the read: one
 *      statement returns the cycle's status under the lock that protects it.
 *
 * So the two primitives here are `lockForBet` (FOR SHARE) and
 * `lockForSettlement` (FOR UPDATE). PostgreSQL's row-level share/exclusive
 * semantics give exactly what the shared/exclusive advisory pair gave — many
 * bets in parallel, a settlement that waits for all of them and then excludes
 * new ones — with the hash and the second query both gone.
 *
 * ── Money and time at the boundary ─────────────────────────────────────────
 * Pools are BIGINT paise here, because integer paise is the only representation
 * money has at rest in this schema. The Mongo document carried rupee floats and
 * kept `total = real + phantom` by hand across six independently-incremented
 * fields; the totals are now GENERATED columns, so that invariant is structural
 * and no caller can write it wrong.
 *
 * Times are TIMESTAMPTZ in the table and epoch MILLISECONDS in the objects this
 * module returns. The database gets a value it can compare and index; callers
 * keep the `startTime`/`endTime` numbers they already read, so moving them onto
 * this store is not also a rewrite of every clock comparison in the engine.
 */
import { pgQuery } from './pgClient.js';

export const CYCLE_STATUS = Object.freeze({
  OPEN: 'OPEN', MERGED: 'MERGED', CLOSED: 'CLOSED',
  RESULT_DECLARED: 'RESULT_DECLARED', COMPLETED: 'COMPLETED',
  PAUSED: 'PAUSED', CANCELLED: 'CANCELLED',
});

/** Statuses in which a stake may still be accepted. */
export const BETTABLE_STATUSES = Object.freeze([CYCLE_STATUS.OPEN, CYCLE_STATUS.MERGED]);

const ms = (t) => (t == null ? null : new Date(t).getTime());
const num = (v) => Number(v ?? 0);

function rowToCycle(row) {
  if (!row) return null;
  return {
    cycleId: row.cycle_id,
    type: row.type,
    status: row.status,
    startTime: ms(row.start_at),
    endTime: ms(row.end_at),
    realDelhiPaise:     num(row.real_delhi_paise),
    realBombayPaise:    num(row.real_bombay_paise),
    phantomDelhiPaise:  num(row.phantom_delhi_paise),
    phantomBombayPaise: num(row.phantom_bombay_paise),
    totalDelhiPaise:    num(row.total_delhi_paise),
    totalBombayPaise:   num(row.total_bombay_paise),
    phantomBalanced:   !!row.phantom_balanced,
    phantomBetsClosed: !!row.phantom_bets_closed,
    winner: row.winner ?? null,
    pendingResult: row.pending_result ?? null,
    winnerDeterminedAt: row.winner_determined_at ?? null,
    winnerDeterminedBy: row.winner_determined_by ?? null,
    winnerConfidence:   row.winner_confidence ?? null,
  };
}

const COLUMNS = `cycle_id, type, status, start_at, end_at,
  real_delhi_paise, real_bombay_paise, phantom_delhi_paise, phantom_bombay_paise,
  total_delhi_paise, total_bombay_paise, phantom_balanced, phantom_bets_closed,
  winner, pending_result, winner_determined_at, winner_determined_by, winner_confidence`;

// ── LOCKING PRIMITIVES ──────────────────────────────────────────────────────

/**
 * Take the cycle's SHARED row lock and read it, for a transaction that is
 * placing a bet.
 *
 * Shared, because a bet must exclude the SETTLEMENT of its cycle and never
 * another bet: two bets on one cycle contend on their own wallet rows and on
 * nothing else. Many bets hold this at once; a settlement's `FOR UPDATE` waits
 * for every one of them and then locks them out.
 *
 * Returns the cycle as it is UNDER the lock, so the caller decides on state
 * that cannot change underneath it — the lock and the read are one statement,
 * which is the property the advisory lock could not offer.
 *
 * Null means no such cycle. A caller must treat that as a refusal, not as
 * "probably fine": a bet on a cycle that does not exist belongs to nothing.
 */
export async function lockForBet(client, cycleId) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM cycles WHERE cycle_id = $1 FOR SHARE`,
    [String(cycleId)],
  );
  return rowToCycle(rows[0]);
}

/**
 * Take the cycle's EXCLUSIVE row lock and read it, for a transaction that is
 * settling.
 *
 * Waits for every bet in flight on this cycle to commit — so no stake is
 * missing from the pools the winner is computed from — and blocks the ones that
 * arrive while the settlement runs, which then see the status this transaction
 * wrote and refuse.
 */
export async function lockForSettlement(client, cycleId) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM cycles WHERE cycle_id = $1 FOR UPDATE`,
    [String(cycleId)],
  );
  return rowToCycle(rows[0]);
}

/**
 * Is this cycle still taking bets, as of the moment the lock was taken?
 *
 * Both halves matter and neither is sufficient. The STATUS says whether the
 * cycle has been closed or settled; the CLOCK says whether its window has
 * passed. A cycle whose end time has gone by but whose status has not yet been
 * advanced by the engine's tick is not open, and accepting a stake into it is
 * the late-bet defect.
 */
export function isBettable(cycle, now = Date.now()) {
  if (!cycle) return false;
  if (!BETTABLE_STATUSES.includes(cycle.status)) return false;
  return cycle.endTime > now;
}

// ── LIFECYCLE ───────────────────────────────────────────────────────────────

/**
 * Create the cycle for a (type, start) block, or return the one already there.
 *
 * `ON CONFLICT (type, start_at)` is what makes this safe to call from several
 * instances at once during a rolling restart: the unique index decides, not the
 * caller's read-then-write. `inserted` distinguishes "I made it" from "it was
 * already there" for callers that only want to announce a genuinely new cycle.
 */
export async function ensureCycle({
  cycleId, type, startTime, endTime, status = CYCLE_STATUS.OPEN,
}) {
  if (!cycleId) throw new Error('ensureCycle requires a cycleId');
  if (!type) throw new Error('ensureCycle requires a type');
  const { rows } = await pgQuery(
    `INSERT INTO cycles (cycle_id, type, status, start_at, end_at)
     VALUES ($1, $2, $3, to_timestamp($4::bigint / 1000.0), to_timestamp($5::bigint / 1000.0))
     ON CONFLICT (type, start_at) DO UPDATE SET updated_at = now()
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [String(cycleId), String(type), String(status), Number(startTime), Number(endTime)],
    'cycle_ensure',
  );
  return { cycle: rowToCycle(rows[0]), inserted: rows[0].inserted === true };
}

/** One cycle by id, with no lock. For reads that are not deciding anything. */
export async function getCycle(cycleId) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles WHERE cycle_id = $1`, [String(cycleId)], 'cycle_read',
  );
  return rowToCycle(rows[0]);
}

/**
 * Move a cycle's status, refusing a transition from a state the caller did not
 * expect.
 *
 * The guard is in the WHERE clause rather than in a read above it, because
 * between reading a status and writing it another pass could have moved it and
 * only the database can settle that. `from` may be a list — the engine advances
 * OPEN and MERGED alike into CLOSED.
 */
export async function setStatus({ cycleId, to, from = null }) {
  const expected = from == null ? null : (Array.isArray(from) ? from : [from]);
  const { rows } = await pgQuery(
    `UPDATE cycles SET status = $2
      WHERE cycle_id = $1 ${expected ? 'AND status = ANY($3)' : ''}
      RETURNING ${COLUMNS}`,
    expected ? [String(cycleId), String(to), expected] : [String(cycleId), String(to)],
    'cycle_status',
  );
  if (!rows.length) {
    const current = await getCycle(cycleId);
    return {
      ok: false,
      reason: current ? 'invalid_transition' : 'not_found',
      status: current?.status ?? null,
    };
  }
  return { ok: true, cycle: rowToCycle(rows[0]) };
}

/**
 * Record the declared result.
 *
 * Guarded on `winner IS NULL` so a result is written ONCE. A cycle whose winner
 * could be overwritten mid-settlement would pay some bets on one outcome and
 * the rest on another — the same reason `cycle_settlements.winning_side` is
 * written once and never updated.
 */
export async function declareWinner({
  cycleId, winner, determinedBy = 'AUTOMATIC', confidence = 'HIGH',
}) {
  const { rows } = await pgQuery(
    `UPDATE cycles
        SET winner = $2, winner_determined_at = now(),
            winner_determined_by = $3, winner_confidence = $4
      WHERE cycle_id = $1 AND winner IS NULL
      RETURNING ${COLUMNS}`,
    [String(cycleId), String(winner), String(determinedBy), String(confidence)],
    'cycle_declare',
  );
  if (!rows.length) {
    const current = await getCycle(cycleId);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.winner) return { ok: true, idempotent: true, cycle: current };
    return { ok: false, reason: 'not_declared' };
  }
  return { ok: true, idempotent: false, cycle: rowToCycle(rows[0]) };
}

// ── POOLS ───────────────────────────────────────────────────────────────────

/**
 * Add a stake to one side's pool.
 *
 * Only the REAL and PHANTOM columns are writable — the totals are generated, so
 * `total = real + phantom` holds by construction rather than by every caller
 * remembering to increment two fields. The Mongo path `$inc`'d both and any
 * writer that forgot one left the pools quietly disagreeing.
 *
 * Written as a read-modify-write-free `x = x + $n` so concurrent stakes on the
 * same cycle do not need the row lock to be correct — they serialise on the row
 * only for the duration of the UPDATE itself.
 */
export async function addToPool({ cycleId, side, amountPaise, phantom = false }) {
  const s = String(side).toUpperCase();
  if (s !== 'DELHI' && s !== 'BOMBAY') throw new Error(`addToPool: unknown side ${side}`);
  if (!Number.isInteger(amountPaise) || amountPaise < 0) {
    throw new TypeError(`addToPool: amountPaise must be a non-negative integer, got ${amountPaise}`);
  }
  const column = `${phantom ? 'phantom' : 'real'}_${s.toLowerCase()}_paise`;
  const { rows } = await pgQuery(
    `UPDATE cycles SET ${column} = ${column} + $2
      WHERE cycle_id = $1 RETURNING ${COLUMNS}`,
    [String(cycleId), amountPaise], 'cycle_pool_add',
  );
  if (!rows.length) return { ok: false, reason: 'not_found' };
  return { ok: true, cycle: rowToCycle(rows[0]) };
}

/** Mark the phantom equalizer as having run; phantom bets close with it. */
export async function closePhantomBetting(cycleId) {
  const { rows } = await pgQuery(
    `UPDATE cycles SET phantom_balanced = TRUE, phantom_bets_closed = TRUE
      WHERE cycle_id = $1 RETURNING ${COLUMNS}`,
    [String(cycleId)], 'cycle_phantom_close',
  );
  return rows.length ? { ok: true, cycle: rowToCycle(rows[0]) } : { ok: false, reason: 'not_found' };
}

// ── QUERIES ─────────────────────────────────────────────────────────────────

/** The cycles the engine should be ticking: live, or recently ended. */
export async function findLiveCycles({ graceMs = 60_000 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE status = ANY($1)
        AND end_at > now() - ($2::bigint || ' milliseconds')::interval
      ORDER BY end_at ASC`,
    [[CYCLE_STATUS.OPEN, CYCLE_STATUS.MERGED, CYCLE_STATUS.CLOSED], String(graceMs)],
    'cycle_live',
  );
  return rows.map(rowToCycle);
}

/**
 * Resolved history for one type, most recent first.
 *
 * Per type, because a single interleaved list starves the shorter intervals:
 * with the 1-minute board live, one shared feed is all 1-minute results and the
 * 30-minute tab shows nothing.
 */
export async function findCycleHistory(type, { limit = 50 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE type = $1 AND status IN ('RESULT_DECLARED','COMPLETED')
      ORDER BY end_at DESC LIMIT $2`,
    [String(type), Math.max(1, Math.min(1440, Number(limit) || 50))],
    'cycle_history',
  );
  return rows.map(rowToCycle);
}

/** The open cycle for a type, if there is one. */
export async function findOpenCycleOfType(type) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE type = $1 AND status = ANY($2)
      ORDER BY start_at DESC LIMIT 1`,
    [String(type), BETTABLE_STATUSES], 'cycle_open_of_type',
  );
  return rowToCycle(rows[0]);
}
