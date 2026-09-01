// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The cycle, owned by PostgreSQL.
 *
 * Two things are being proved here, and the second is the reason this table
 * exists at all.
 *
 * 1. The row behaves: uniqueness per (type, block), guarded transitions, a
 *    result written once, pools that cannot drift.
 * 2. `FOR SHARE` / `FOR UPDATE` on the cycle row give exactly the
 *    bet-versus-settlement semantics the advisory lock gave — many bets in
 *    parallel, a settlement that waits for them and then excludes new ones —
 *    without the hash, and with the lock and the status read in ONE statement.
 *
 * The advisory lock this replaces was correct. It was also keyed on
 * `hashtext(cycleId)`, an int32, so two unrelated cycles could collide and
 * serialise against each other: never wrong, but invisible when it happened.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureCycle, getCycle, setStatus, declareWinner, addPhantomToPool,
  derivePoolsForCycle, closePhantomBetting, findLiveCycles, findCycleHistory, findOpenCycleOfType,
  findCurrentCycle, findCyclesAwaitingSettlement, findResumableSettlements,
  lockForBet, lockForSettlement, isBettable,
  CYCLE_STATUS, BETTABLE_STATUSES,
} from '../../postgres/cyclePg.js';
import { getPool, pgQuery, connectGuarded, applySchema } from '../../postgres/pgClient.js';
// The engine's settlement questions are answered by joining `cycle_settlements`,
// so the run has to be opened and closed for real rather than faked with an INSERT.
import { openSettlement, completeSettlement } from '../../postgres/settlementPg.js';

let seq = 0;
const nextId = () => `cyc_${Date.now()}_${seq++}`;
/** Distinct start block per cycle, so the (type, start_at) unique index does not collide. */
const nextBlock = () => Date.now() + (seq++ * 60_000);

const make = async (over = {}) => {
  const startTime = over.startTime ?? nextBlock();
  const { cycle } = await ensureCycle({
    cycleId: over.cycleId ?? nextId(),
    type: over.type ?? '30_MIN',
    startTime,
    endTime: over.endTime ?? startTime + 30 * 60_000,
    ...(over.status ? { status: over.status } : {}),
  });
  return cycle;
};

/**
 * Return borrowed connections to the pool with no transaction left open.
 *
 * `client.release()` alone hands a connection back exactly as it is — so a test
 * that fails an assertion mid-transaction returns a client still inside BEGIN,
 * still holding whatever rows it locked. The next test borrows it and either
 * blocks on the leftover lock or reads through the open snapshot, which is how
 * one failing assertion in this file turned into a second, unrelated-looking
 * `TypeError` in the test after it.
 */
async function rollbackQuietly(...clients) {
  for (const c of clients) {
    if (!c) continue;
    try { await c.query('ROLLBACK'); } catch { /* already unwound */ }
    c.release();
  }
}

beforeAll(async () => { await applySchema(); });

describe('creating a cycle', () => {
  it('round-trips its fields, with times as epoch milliseconds', async () => {
    const startTime = nextBlock();
    const endTime = startTime + 60_000;
    const cycleId = nextId();
    const { cycle, inserted } = await ensureCycle({ cycleId, type: '1_MIN', startTime, endTime });

    expect(inserted).toBe(true);
    expect(cycle.cycleId).toBe(cycleId);
    expect(cycle.type).toBe('1_MIN');
    expect(cycle.status).toBe(CYCLE_STATUS.OPEN);
    // The column is TIMESTAMPTZ; callers keep the millisecond numbers they read.
    expect(cycle.startTime).toBe(startTime);
    expect(cycle.endTime).toBe(endTime);
  });

  it('is idempotent per (type, time block), so racing instances make one cycle', async () => {
    // The generator runs on every instance. Two of them starting at once during
    // a rolling restart must not produce two cycles for the same block — and
    // the index decides that, not the caller's read-then-write.
    const startTime = nextBlock();
    const endTime = startTime + 60_000;

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ensureCycle({ cycleId: `race_${startTime}_${i}`, type: '1_MIN', startTime, endTime })),
    );

    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    const { rows } = await pgQuery(
      `SELECT count(*)::int AS n FROM cycles WHERE type = '1_MIN' AND start_at = to_timestamp($1::bigint / 1000.0)`,
      [startTime],
    );
    expect(rows[0].n).toBe(1);
  });

  it('survives the SAME id arriving for a different block', async () => {
    // The row has two ways to already exist and `ON CONFLICT` can name only
    // one. `(type, start_at)` is the declared target because one-cycle-per-block
    // is the correctness rule; the other is the primary key — the same
    // `cycle_id` for a DIFFERENT block, which happens whenever two cycles are
    // minted inside one millisecond, because the id carries `Date.now()`.
    //
    // This threw `23505 cycles_pkey` when it first shipped, and because the
    // generator AWAITS ensureCycle it took cycle creation down with it. Rare on
    // a wall clock, routine under fake timers, certain in a recovery pass
    // walking several blocks in a loop.
    const id = `dup_${Date.now()}_${seq++}`;
    const first = nextBlock();

    const a = await ensureCycle({ cycleId: id, type: '1_MIN', startTime: first, endTime: first + 60_000 });
    expect(a.inserted).toBe(true);

    const second = first + 600_000;
    const b = await ensureCycle({ cycleId: id, type: '1_MIN', startTime: second, endTime: second + 60_000 });
    expect(b.inserted).toBe(false);
    // It returns the row that actually owns the id, not a fabricated one.
    expect(b.cycle.cycleId).toBe(id);
    expect(b.cycle.startTime).toBe(first);
  });

  it('returns the block owner when a DIFFERENT id claims a taken block', async () => {
    const start = nextBlock();
    const a = await ensureCycle({ cycleId: `own_${start}`, type: '1_MIN', startTime: start, endTime: start + 60_000 });
    const b = await ensureCycle({ cycleId: `other_${start}`, type: '1_MIN', startTime: start, endTime: start + 60_000 });

    expect(b.inserted).toBe(false);
    expect(b.cycle.cycleId).toBe(a.cycle.cycleId);
  });

  it('refuses a window that ends before it starts', async () => {
    const startTime = nextBlock();
    await expect(ensureCycle({
      cycleId: nextId(), type: '30_MIN', startTime, endTime: startTime - 1,
    })).rejects.toThrow();
  });

  it('refuses a type the registry does not know', async () => {
    const startTime = nextBlock();
    await expect(ensureCycle({
      cycleId: nextId(), type: '5_MIN', startTime, endTime: startTime + 1000,
    })).rejects.toThrow();
  });
});

describe('pools: real derived from the bets, phantom stored on the cycle', () => {
  // Real pools are NOT columns. Incrementing one from inside a bet's
  // transaction means upgrading this row's SHARED boundary lock to exclusive,
  // and two bets doing that concurrently deadlock — 40P01, demonstrated
  // against PostgreSQL 16. Keeping the column would mean an exclusive bet
  // lock, measured at ~418 bets/sec against ~2,113 shared on one cycle.
  //
  // Deriving is also the stronger guarantee: a total summed from the bets
  // cannot disagree with the bets.

  const stake = async (cycleId, side, paise, status = 'PENDING') => {
    await pgQuery(
      `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [`pool_${cycleId}_${seq++}`, 'pool_user', cycleId, side, paise, status],
    );
  };

  it('sums the real pools from the bets themselves', async () => {
    const cycle = await make();
    await stake(cycle.cycleId, 'DELHI', 5_000);
    await stake(cycle.cycleId, 'DELHI', 2_000);
    await stake(cycle.cycleId, 'BOMBAY', 1_000);

    const pools = await derivePoolsForCycle(cycle.cycleId);
    expect(pools.realDelhiPaise).toBe(7_000);
    expect(pools.realBombayPaise).toBe(1_000);
    expect(pools.realBetCount).toBe(3);
    expect(pools.totalPoolPaise).toBe(8_000);
  });

  it('excludes a REFUNDED stake, which is money given back', async () => {
    const cycle = await make();
    await stake(cycle.cycleId, 'DELHI', 5_000);
    await stake(cycle.cycleId, 'DELHI', 9_000, 'REFUNDED');

    const pools = await derivePoolsForCycle(cycle.cycleId);
    expect(pools.realDelhiPaise).toBe(5_000);
    expect(pools.realBetCount).toBe(1);
  });

  it('counts a settled stake — WON and LOST money was still staked', async () => {
    const cycle = await make();
    await stake(cycle.cycleId, 'DELHI', 1_000, 'WON');
    await stake(cycle.cycleId, 'BOMBAY', 3_000, 'LOST');

    const pools = await derivePoolsForCycle(cycle.cycleId);
    expect(pools.totalPoolPaise).toBe(4_000);
  });

  it('composes the public totals from real plus phantom', async () => {
    const cycle = await make();
    await stake(cycle.cycleId, 'DELHI', 5_000);
    await addPhantomToPool({ cycleId: cycle.cycleId, side: 'BOMBAY', amountPaise: 4_000, betCount: 2 });

    const pools = await derivePoolsForCycle(cycle.cycleId);
    expect(pools.totalDelhiPaise).toBe(5_000);
    expect(pools.totalBombayPaise).toBe(4_000);
    expect(pools.totalPoolPaise).toBe(9_000);
    // The count the public sees includes phantom, so it cannot be compared
    // against the pool to infer the split.
    expect(pools.betCount).toBe(3);
    expect(pools.phantomBetCount).toBe(2);
  });

  it('reports zeroes for a cycle nobody has bet on', async () => {
    const cycle = await make();
    const pools = await derivePoolsForCycle(cycle.cycleId);
    expect(pools.totalPoolPaise).toBe(0);
    expect(pools.betCount).toBe(0);
  });

  it('adds concurrent real stakes without losing any, and without a deadlock', async () => {
    // The property the derived design buys: 40 concurrent stakes touch the
    // bets table only, so nothing contends on the cycle row at all.
    const cycle = await make();
    await Promise.all(Array.from({ length: 40 }, () => stake(cycle.cycleId, 'DELHI', 100)));

    const pools = await derivePoolsForCycle(cycle.cycleId);
    expect(pools.realDelhiPaise).toBe(4_000);
    expect(pools.realBetCount).toBe(40);
  });

  it('refuses a non-integer or negative phantom amount rather than truncating money', async () => {
    const cycle = await make();
    await expect(addPhantomToPool({ cycleId: cycle.cycleId, side: 'DELHI', amountPaise: 12.5 }))
      .rejects.toThrow(TypeError);
    await expect(addPhantomToPool({ cycleId: cycle.cycleId, side: 'DELHI', amountPaise: -100 }))
      .rejects.toThrow(TypeError);
  });
});

describe('status and result transitions', () => {
  it('advances only from the state the caller expected', async () => {
    const cycle = await make();
    expect((await setStatus({ cycleId: cycle.cycleId, to: 'CLOSED', from: BETTABLE_STATUSES })).ok).toBe(true);

    // A second pass expecting OPEN must be refused, not silently re-applied.
    const again = await setStatus({ cycleId: cycle.cycleId, to: 'CLOSED', from: BETTABLE_STATUSES });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('invalid_transition');
    expect(again.status).toBe('CLOSED');
  });

  it('reports not_found rather than pretending, for a cycle that is not there', async () => {
    const missing = await setStatus({ cycleId: 'no_such_cycle', to: 'CLOSED' });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('not_found');
  });

  it('writes a result once and treats a second declare as idempotent', async () => {
    // A cycle whose winner could be overwritten mid-settlement would pay some
    // bets on one outcome and the rest on another.
    const cycle = await make();
    const first = await declareWinner({ cycleId: cycle.cycleId, winner: 'DELHI' });
    expect(first.ok).toBe(true);
    expect(first.idempotent).toBe(false);

    const second = await declareWinner({ cycleId: cycle.cycleId, winner: 'BOMBAY' });
    expect(second.ok).toBe(true);
    expect(second.idempotent).toBe(true);
    expect((await getCycle(cycle.cycleId)).winner).toBe('DELHI');
  });

  it('refuses a winner that is not a side', async () => {
    const cycle = await make();
    await expect(declareWinner({ cycleId: cycle.cycleId, winner: 'PARIS' })).rejects.toThrow();
  });

  it('closes phantom betting when the equalizer runs', async () => {
    const cycle = await make();
    expect(cycle.phantomBetsClosed).toBe(false);
    await closePhantomBetting(cycle.cycleId);
    const after = await getCycle(cycle.cycleId);
    expect(after.phantomBalanced).toBe(true);
    expect(after.phantomBetsClosed).toBe(true);
  });
});

describe('the row lock replaces the advisory lock', () => {
  it('reads the cycle UNDER the lock, so the decision cannot go stale', async () => {
    // The property the advisory lock could not offer: it locked a HASH, then a
    // second query asked cycle_settlements whether the cycle was settling. Here
    // the lock and the answer are one statement.
    const cycle = await make();
    const pool = await getPool();
    const client = await connectGuarded(pool);
    try {
      await client.query('BEGIN');
      const locked = await lockForBet(client, cycle.cycleId);
      expect(locked.cycleId).toBe(cycle.cycleId);
      expect(locked.status).toBe(CYCLE_STATUS.OPEN);
      await client.query('COMMIT');
    } finally { await rollbackQuietly(client); }
  });

  it('does NOT make one bet wait for another on the same cycle', async () => {
    // Bets must exclude the settlement, never each other. FOR SHARE holders do
    // not conflict, so a second bet proceeds while the first is still open.
    const cycle = await make();
    const pool = await getPool();
    const a = await connectGuarded(pool);
    const b = await connectGuarded(pool);
    try {
      await a.query('BEGIN');
      await lockForBet(a, cycle.cycleId);

      const startedAt = Date.now();
      await b.query('BEGIN');
      const second = await lockForBet(b, cycle.cycleId);
      const elapsed = Date.now() - startedAt;
      await b.query('COMMIT');

      expect(second.cycleId).toBe(cycle.cycleId);
      // Generous: this asserts "did not queue behind an open transaction", not
      // a latency budget, so it cannot become a flaky timing test.
      expect(elapsed, 'a bet queued behind another bet on the same cycle').toBeLessThan(2_000);
      await a.query('COMMIT');
    } finally { await rollbackQuietly(a, b); }
  });

  it('makes a settlement WAIT for a bet already in flight', async () => {
    // The decisive test. Everything above passes with no lock at all, because
    // nothing interleaves; this is the one that fails if either side stops
    // taking its lock.
    const cycle = await make();
    const pool = await getPool();
    const better = await connectGuarded(pool);
    const settler = await connectGuarded(pool);
    try {
      await better.query('BEGIN');
      await lockForBet(better, cycle.cycleId);

      const startedAt = Date.now();
      let acquiredAfterMs = null;
      const settling = (async () => {
        await settler.query('BEGIN');
        await lockForSettlement(settler, cycle.cycleId);
        acquiredAfterMs = Date.now() - startedAt;
      })();

      const HOLD_MS = 600;
      await new Promise((r) => setTimeout(r, HOLD_MS));
      // THIS is the proof it blocked: the settlement had a full HOLD_MS to take
      // the lock and did not.
      expect(acquiredAfterMs, 'the settlement locked the cycle while a bet still held it').toBeNull();

      // Measured against the moment the bet actually released, not against the
      // sleep. `setTimeout(600)` is a floor the platform may round DOWN from —
      // CI observed 599 — so asserting the wait was >= HOLD_MS made a real
      // property depend on timer precision. What must hold is that the
      // settlement acquired only AFTER the bet let go.
      const releasedAt = Date.now() - startedAt;
      await better.query('COMMIT');
      await settling;
      expect(acquiredAfterMs).not.toBeNull();
      expect(acquiredAfterMs).toBeGreaterThanOrEqual(releasedAt);
      await settler.query('COMMIT');
    } finally {
      await rollbackQuietly(better, settler);
    }
  }, 15_000);

  it('does not block a DIFFERENT cycle — no hash, so no collision', async () => {
    // The advisory lock keyed on hashtext(cycleId), an int32: two unrelated
    // cycles COULD share a key and serialise against each other. A row lock
    // cannot collide, because the row is the identity.
    const settling = await make();
    const other = await make();
    const pool = await getPool();
    const settler = await connectGuarded(pool);
    const better = await connectGuarded(pool);
    try {
      await settler.query('BEGIN');
      await lockForSettlement(settler, settling.cycleId);

      const startedAt = Date.now();
      await better.query('BEGIN');
      const elsewhere = await lockForBet(better, other.cycleId);
      const elapsed = Date.now() - startedAt;
      await better.query('COMMIT');

      expect(elsewhere.cycleId).toBe(other.cycleId);
      expect(elapsed, 'an unrelated cycle was blocked').toBeLessThan(2_000);
      await settler.query('COMMIT');
    } finally { await rollbackQuietly(settler, better); }
  });

  it('returns null for a cycle that does not exist', async () => {
    const pool = await getPool();
    const client = await connectGuarded(pool);
    try {
      await client.query('BEGIN');
      expect(await lockForBet(client, 'no_such_cycle')).toBeNull();
      await client.query('COMMIT');
    } finally { await rollbackQuietly(client); }
  });
});

describe('whether a stake may be accepted', () => {
  it('needs BOTH an open status and an unexpired clock', async () => {
    const now = Date.now();
    const open = { status: 'OPEN', endTime: now + 10_000 };
    expect(isBettable(open, now)).toBe(true);
    expect(isBettable({ ...open, status: 'MERGED' }, now)).toBe(true);

    // Status open, clock gone — the late-bet defect. The engine's tick has not
    // advanced the status yet, and a stake landing here belongs to nothing.
    expect(isBettable({ status: 'OPEN', endTime: now - 1 }, now)).toBe(false);
    // Clock fine, status gone.
    expect(isBettable({ status: 'CLOSED', endTime: now + 10_000 }, now)).toBe(false);
    expect(isBettable({ status: 'RESULT_DECLARED', endTime: now + 10_000 }, now)).toBe(false);
    expect(isBettable(null, now)).toBe(false);
  });
});

describe('queries the engine and the client need', () => {
  it('finds the open cycle of a type', async () => {
    const cycle = await make({ type: 'FULL_DAY' });
    const found = await findOpenCycleOfType('FULL_DAY');
    expect(found).toBeTruthy();
    expect(found.type).toBe('FULL_DAY');
    // The most recent open one, which is the one just made.
    expect(found.startTime).toBeGreaterThanOrEqual(cycle.startTime - 1);
  });

  it('lists live cycles and excludes long-finished ones', async () => {
    const live = await make({ startTime: Date.now(), endTime: Date.now() + 600_000 });
    const old = await make({ startTime: Date.now() - 7_200_000, endTime: Date.now() - 3_600_000 });

    const found = await findLiveCycles();
    const ids = found.map((c) => c.cycleId);
    expect(ids).toContain(live.cycleId);
    expect(ids).not.toContain(old.cycleId);
  });

  it('returns history per type, so a short interval cannot starve a long one', async () => {
    // One interleaved list is all 1-minute results once that board is live, and
    // the 30-minute tab shows nothing.
    const oneMin = await make({ type: '1_MIN' });
    const thirty = await make({ type: '30_MIN' });
    for (const c of [oneMin, thirty]) {
      await declareWinner({ cycleId: c.cycleId, winner: 'DELHI' });
      await setStatus({ cycleId: c.cycleId, to: 'RESULT_DECLARED' });
    }

    const history = await findCycleHistory('30_MIN', { limit: 50 });
    expect(history.every((c) => c.type === '30_MIN')).toBe(true);
    expect(history.map((c) => c.cycleId)).toContain(thirty.cycleId);
    expect(history.map((c) => c.cycleId)).not.toContain(oneMin.cycleId);
  });
});

// ── THE ENGINE'S THREE QUESTIONS ────────────────────────────────────────────
// gameEngine asked all three of MongoDB. Each assertion below is written
// against MEMBERSHIP rather than an exact result set, because these tests share
// one database with every other file and the queries are deliberately global.

describe("the queries gameEngine used to ask MongoDB", () => {
  /**
   * A start time strictly later than every cycle currently in the table.
   *
   * `findCurrentCycle` answers a GLOBAL question — "which cycle is newest" —
   * and these suites share one persistent database, so a fixture built from
   * `Date.now()` plus a per-run counter is not necessarily newest: a previous
   * run of this same file leaves rows behind, and its counter had climbed
   * higher than this run's has. That is exactly how this test failed on its
   * second run and passed on its first. Anchoring to the table's own maximum
   * makes "newest" true by construction instead of by luck.
   */
  async function afterEverything(offsetMs = 0) {
    const { rows } = await pgQuery(
      `SELECT COALESCE(MAX(start_at), now()) AS m FROM cycles`);
    return new Date(rows[0].m).getTime() + 600_000 + offsetMs;
  }
  const ids = (rows) => rows.map((c) => c.cycleId);

  it('findCurrentCycle returns the newest cycle that has not finished', async () => {
    const live = await make({ startTime: await afterEverything(), status: CYCLE_STATUS.OPEN });
    expect((await findCurrentCycle()).cycleId).toBe(live.cycleId);

    // A LATER cycle that is already finished must not displace it. The status
    // filter is the whole query — without it the engine's idea of "now" would
    // jump to a cycle nobody can bet on the instant one is archived.
    const later = await make({ startTime: await afterEverything() });
    await setStatus({ cycleId: later.cycleId, to: CYCLE_STATUS.COMPLETED });
    expect((await findCurrentCycle()).cycleId).toBe(live.cycleId);
  });

  it('findCyclesAwaitingSettlement offers a declared cycle exactly until someone claims it', async () => {
    const c = await make({ startTime: await afterEverything() });
    await declareWinner({ cycleId: c.cycleId, winner: 'DELHI' });
    await setStatus({ cycleId: c.cycleId, to: CYCLE_STATUS.RESULT_DECLARED });

    expect(ids(await findCyclesAwaitingSettlement({ limit: 100 }))).toContain(c.cycleId);

    // Opening the run is the claim. There is no PENDING flag to write, so there
    // is none to forget: the row's existence is the whole state.
    await openSettlement({ cycleId: c.cycleId, winningSide: 'DELHI' });
    expect(ids(await findCyclesAwaitingSettlement({ limit: 100 }))).not.toContain(c.cycleId);
  });

  it('never offers a cycle whose result never reached this store', async () => {
    // The regression this guards, found by wiring the engine to `cycles` and
    // then looking for what writes the status: NOTHING did. The generator
    // declared the winner on the Mongo document only, so every cycle sat at OPEN
    // here — the settle tick found nothing and the engine silently stopped
    // paying anyone out, with every stake still locked.
    //
    // Half-wired is the more dangerous shape: status moved, winner not. The
    // caller hands `cycle.winner` straight to `beginSettlement`, which refuses a
    // null side — so the tick would throw on the same row every second forever.
    const c = await make({ startTime: await afterEverything() });
    await setStatus({ cycleId: c.cycleId, to: CYCLE_STATUS.RESULT_DECLARED });

    expect(ids(await findCyclesAwaitingSettlement({ limit: 100 })))
      .not.toContain(c.cycleId);

    await declareWinner({ cycleId: c.cycleId, winner: 'DELHI' });
    const offered = await findCyclesAwaitingSettlement({ limit: 100 });
    expect(ids(offered)).toContain(c.cycleId);
    // And it carries the side, because that is what the caller settles against.
    expect(offered.find((o) => o.cycleId === c.cycleId).winner).toBe('DELHI');
  });

  it('findCyclesAwaitingSettlement offers the OLDEST declared cycle first', async () => {
    // The Mongo original had no sort at all. A cycle that failed to settle
    // could therefore be passed over indefinitely while newer ones arrived —
    // and every bet on it stays locked for as long as that goes on.
    const base  = await afterEverything();
    const older = await make({ startTime: base,           endTime: base + 60_000 });
    const newer = await make({ startTime: base + 600_000, endTime: base + 900_000 });
    for (const c of [older, newer]) {
      await declareWinner({ cycleId: c.cycleId, winner: 'DELHI' });
      await setStatus({ cycleId: c.cycleId, to: CYCLE_STATUS.RESULT_DECLARED });
    }

    const mine = ids(await findCyclesAwaitingSettlement({ limit: 100 }))
      .filter((id) => id === older.cycleId || id === newer.cycleId);
    expect(mine).toEqual([older.cycleId, newer.cycleId]);
  });

  it('findResumableSettlements finds a run that started and did not finish', async () => {
    const c = await make({ startTime: await afterEverything() });
    await declareWinner({ cycleId: c.cycleId, winner: 'BOMBAY' });
    await openSettlement({ cycleId: c.cycleId, winningSide: 'BOMBAY' });

    expect(ids(await findResumableSettlements())).toContain(c.cycleId);

    await completeSettlement({ cycleId: c.cycleId });
    expect(ids(await findResumableSettlements())).not.toContain(c.cycleId);
  });

  it('a resumed settlement is offered the side the FIRST pass paid against', async () => {
    // THE reason this query reads winning_side off the run instead of winner
    // off the cycle. `cycle_settlements.winning_side` is written once and never
    // updated, so a result corrected mid-settlement cannot make a resumed pass
    // pay the remaining bets on the other outcome — but that guarantee is only
    // worth anything if the resume actually reads it.
    const c = await make({ startTime: await afterEverything() });
    await declareWinner({ cycleId: c.cycleId, winner: 'DELHI' });
    await openSettlement({ cycleId: c.cycleId, winningSide: 'DELHI' });

    // An admin corrects the result after the payout has begun.
    await pgQuery(`UPDATE cycles SET winner = 'BOMBAY' WHERE cycle_id = $1`, [c.cycleId]);
    expect((await getCycle(c.cycleId)).winner).toBe('BOMBAY');

    const resumable = (await findResumableSettlements()).find((r) => r.cycleId === c.cycleId);
    expect(resumable.winner, 'the resume followed the corrected result and would split the cycle')
      .toBe('DELHI');
  });
});
