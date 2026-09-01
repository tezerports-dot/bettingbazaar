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
    phantomDelhiPaise:  num(row.phantom_delhi_paise),
    phantomBombayPaise: num(row.phantom_bombay_paise),
    phantomBetCount:    num(row.phantom_bet_count),
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
  phantom_delhi_paise, phantom_bombay_paise, phantom_bet_count,
  phantom_balanced, phantom_bets_closed,
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

  // ── Why this catches instead of relying on ON CONFLICT alone ──────────────
  // The row has TWO ways to already exist, and `ON CONFLICT` can name only one
  // target. `(type, start_at)` is the one that matters for correctness — one
  // cycle per block — so it is the declared target. The other is the primary
  // key: the same `cycle_id` arriving for a DIFFERENT block, which happens
  // whenever two cycles are minted inside one millisecond, because the id
  // carries `Date.now()`. Rare in the wall-clock case, routine under a test's
  // fake timers, and certain in a recovery pass that walks several blocks in a
  // tight loop.
  //
  // Reproduced against PostgreSQL 16 before this guard existed: the second
  // call raised `23505 cycles_pkey` and, because the generator awaits this,
  // took cycle creation down with it.
  try {
    const { rows } = await pgQuery(
      `INSERT INTO cycles (cycle_id, type, status, start_at, end_at)
       VALUES ($1, $2, $3, to_timestamp($4::bigint / 1000.0), to_timestamp($5::bigint / 1000.0))
       ON CONFLICT (type, start_at) DO UPDATE SET updated_at = now()
       RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
      [String(cycleId), String(type), String(status), Number(startTime), Number(endTime)],
      'cycle_ensure',
    );
    return { cycle: rowToCycle(rows[0]), inserted: rows[0].inserted === true };
  } catch (error) {
    if (error?.code !== '23505') throw error;
    // Some unique constraint already holds this cycle. Return whichever row
    // owns it — by id first, because `cycle_id` is the identity every caller
    // holds — rather than surfacing a raw driver error for a row that exists.
    const existing = await getCycle(cycleId);
    if (existing) return { cycle: existing, inserted: false };

    const { rows } = await pgQuery(
      `SELECT ${COLUMNS} FROM cycles
        WHERE type = $1 AND start_at = to_timestamp($2::bigint / 1000.0)`,
      [String(type), Number(startTime)], 'cycle_ensure_recheck',
    );
    if (rows.length) return { cycle: rowToCycle(rows[0]), inserted: false };
    throw error; // a constraint we do not know about — do not swallow it
  }
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
 * Add a PHANTOM stake to one side's pool.
 *
 * Real stakes are not written here and there is no equivalent for them: they
 * are summed from `bets` by `derivePoolsForCycle`. That is not a shortcut —
 * incrementing a column on this row from inside a bet's transaction means
 * upgrading the row's SHARED boundary lock to exclusive, and two bets doing
 * that concurrently deadlock (`40P01`, demonstrated). See the POOLS note in
 * schema.sql.
 *
 * Phantom stakes have neither problem: they never reach the `bets` table, and
 * the equalizer writes them once per cycle rather than once per bet.
 */
export async function addPhantomToPool({ cycleId, side, amountPaise, betCount = 1 }) {
  const s = String(side).toUpperCase();
  if (s !== 'DELHI' && s !== 'BOMBAY') throw new Error(`addPhantomToPool: unknown side ${side}`);
  if (!Number.isInteger(amountPaise) || amountPaise < 0) {
    throw new TypeError(`addPhantomToPool: amountPaise must be a non-negative integer, got ${amountPaise}`);
  }
  const column = `phantom_${s.toLowerCase()}_paise`;
  const { rows } = await pgQuery(
    `UPDATE cycles SET ${column} = ${column} + $2, phantom_bet_count = phantom_bet_count + $3
      WHERE cycle_id = $1 RETURNING ${COLUMNS}`,
    [String(cycleId), amountPaise, Number(betCount) || 0], 'cycle_phantom_add',
  );
  if (!rows.length) return { ok: false, reason: 'not_found' };
  return { ok: true, cycle: rowToCycle(rows[0]) };
}

/**
 * The cycle's pools, right now: real summed from the bets, phantom read from
 * the cycle row, and the totals composed from both.
 *
 * This is the authoritative answer for both consumers that need one — the
 * per-second realtime snapshot, and the exact read the winner is determined
 * from — and it is authoritative in the strongest available sense: the real
 * pools ARE the bets, so they cannot drift from them. A stored counter can, and
 * the Mongo document's six hand-maintained fields are what that looks like.
 *
 * REFUNDED bets are excluded. A refunded stake was returned to the player and
 * is not in the pool the winner is computed from; every other status counts,
 * because a bet that is PENDING, WON or LOST was staked.
 *
 * Served by `bets_cycle_pool_idx` as an index-only scan.
 */
export async function derivePoolsForCycle(cycleId) {
  const [{ rows: sums }, cycle] = await Promise.all([
    pgQuery(
      `SELECT side,
              COALESCE(SUM(stake_paise), 0) AS staked,
              COUNT(*)                      AS bets
         FROM bets
        WHERE cycle_id = $1 AND status <> $2
        GROUP BY side`,
      [String(cycleId), 'REFUNDED'], 'cycle_pools_derive',
    ),
    getCycle(cycleId),
  ]);

  const bySide = { DELHI: { staked: 0, bets: 0 }, BOMBAY: { staked: 0, bets: 0 } };
  for (const r of sums) {
    const key = String(r.side).toUpperCase();
    if (bySide[key]) bySide[key] = { staked: num(r.staked), bets: num(r.bets) };
  }

  const phantomDelhi  = cycle?.phantomDelhiPaise  ?? 0;
  const phantomBombay = cycle?.phantomBombayPaise ?? 0;

  return {
    cycleId: String(cycleId),
    // Real — admin-only. Never put these in a public payload; cyclePublicView's
    // assertPublicCycleSafe exists because showing them lets a player infer the
    // phantom side by subtraction.
    realDelhiPaise:  bySide.DELHI.staked,
    realBombayPaise: bySide.BOMBAY.staked,
    realBetCount:    bySide.DELHI.bets + bySide.BOMBAY.bets,
    phantomDelhiPaise:  phantomDelhi,
    phantomBombayPaise: phantomBombay,
    phantomBetCount:    cycle?.phantomBetCount ?? 0,
    // Total — what the public sees.
    totalDelhiPaise:  bySide.DELHI.staked  + phantomDelhi,
    totalBombayPaise: bySide.BOMBAY.staked + phantomBombay,
    totalPoolPaise:   bySide.DELHI.staked + bySide.BOMBAY.staked + phantomDelhi + phantomBombay,
    betCount:         bySide.DELHI.bets + bySide.BOMBAY.bets + (cycle?.phantomBetCount ?? 0),
  };
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

// ── THE ENGINE'S THREE QUESTIONS ────────────────────────────────────────────
// gameEngine asked all three of these of MongoDB. They are the last reads that
// decide where money goes, and each one translates into something the Mongo
// document could not express.

/** The same column list, qualified — for the queries below that join. */
const columnsOn = (alias) => COLUMNS.split(',').map((c) => `${alias}.${c.trim()}`).join(', ');

/**
 * "What cycle is running right now?"
 *
 * The most recent cycle that has not been archived. Note this is deliberately
 * NOT per-type: it backs the legacy global `getGameState()`, which predates
 * there being more than one cycle type and answers for whichever is newest.
 * `findOpenCycleOfType` is the per-type question and is what new callers want.
 */
export async function findCurrentCycle() {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM cycles
      WHERE status = ANY($1)
      ORDER BY start_at DESC, created_at DESC
      LIMIT 1`,
    [[CYCLE_STATUS.OPEN, CYCLE_STATUS.MERGED, CYCLE_STATUS.CLOSED, CYCLE_STATUS.RESULT_DECLARED]],
    'cycle_current',
  );
  return rowToCycle(rows[0]);
}

/**
 * "Which declared cycles has nobody started paying out yet?"
 *
 * The Mongo query was `{ status: 'RESULT_DECLARED', isSettled: 'PENDING' }` —
 * two fields on one document, where the second is a flag someone has to
 * remember to write. Here the CLAIM IS THE ROW: `cycle_settlements.cycle_id` is
 * UNIQUE, so a cycle with no settlement row has never been claimed by anyone.
 * There is no PENDING state to write, and therefore none to forget.
 *
 * Ordered oldest-first, which the Mongo version was not — it took whatever came
 * back first with no sort at all, so a cycle that failed to settle could be
 * passed over indefinitely while newer ones kept arriving.
 */
export async function findCyclesAwaitingSettlement({ limit = 1 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${columnsOn('c')} FROM cycles c
       LEFT JOIN cycle_settlements s ON s.cycle_id = c.cycle_id
      WHERE c.status = $1 AND s.cycle_id IS NULL
      ORDER BY c.end_at ASC
      LIMIT $2`,
    [CYCLE_STATUS.RESULT_DECLARED, Math.max(1, Math.min(100, Number(limit) || 1))],
    'cycle_awaiting_settlement',
  );
  return rows.map(rowToCycle);
}

/**
 * "Which payouts started and never finished?"
 *
 * The recovery sweep, formerly `Cycle.find({ isSettled: 'PROCESSING' })`.
 *
 * `winner` is deliberately taken from the RUN, not from the cycle. The run
 * records `winning_side` once and never updates it, precisely so a pass that
 * resumes settles the remaining bets against the side the FIRST pass paid
 * against. Reading the cycle's `winner` here would mean that a result corrected
 * mid-settlement pays some bets on one outcome and the rest on the other —
 * which is the failure `cycle_settlements.winning_side` exists to make
 * impossible, and it only works if the resume actually reads it.
 */
export async function findResumableSettlements() {
  const { rows } = await pgQuery(
    `SELECT ${columnsOn('c')}, s.winning_side FROM cycles c
       JOIN cycle_settlements s ON s.cycle_id = c.cycle_id
      WHERE s.status = 'RUNNING'
      ORDER BY s.started_at ASC`,
    [], 'cycle_resumable_settlements',
  );
  return rows.map((r) => ({ ...rowToCycle(r), winner: r.winning_side }));
}
