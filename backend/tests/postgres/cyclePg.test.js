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
  ensureCycle, getCycle, setStatus, declareWinner, addToPool,
  closePhantomBetting, findLiveCycles, findCycleHistory, findOpenCycleOfType,
  lockForBet, lockForSettlement, isBettable,
  CYCLE_STATUS, BETTABLE_STATUSES,
} from '../../postgres/cyclePg.js';
import { getPool, pgQuery, connectGuarded, applySchema } from '../../postgres/pgClient.js';

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

describe('pools cannot drift', () => {
  it('derives the total from real + phantom rather than trusting a caller', async () => {
    // The Mongo document carried six independently-$inc'd rupee floats and
    // relied on every writer to keep total = real + phantom by hand. Here the
    // totals are GENERATED, so a writer that updates one field cannot leave the
    // other two disagreeing.
    const cycle = await make();

    await addToPool({ cycleId: cycle.cycleId, side: 'DELHI', amountPaise: 5_000 });
    await addToPool({ cycleId: cycle.cycleId, side: 'DELHI', amountPaise: 2_500, phantom: true });
    await addToPool({ cycleId: cycle.cycleId, side: 'BOMBAY', amountPaise: 1_000 });

    const after = await getCycle(cycle.cycleId);
    expect(after.realDelhiPaise).toBe(5_000);
    expect(after.phantomDelhiPaise).toBe(2_500);
    expect(after.totalDelhiPaise).toBe(7_500);
    expect(after.totalBombayPaise).toBe(1_000);
  });

  it('cannot have the generated total written directly', async () => {
    const cycle = await make();
    await expect(pgQuery(
      `UPDATE cycles SET total_delhi_paise = 999999 WHERE cycle_id = $1`, [cycle.cycleId],
    )).rejects.toThrow();
  });

  it('adds concurrent stakes without losing any', async () => {
    const cycle = await make();
    await Promise.all(Array.from({ length: 40 }, () =>
      addToPool({ cycleId: cycle.cycleId, side: 'DELHI', amountPaise: 100 })));

    expect((await getCycle(cycle.cycleId)).realDelhiPaise).toBe(4_000);
  });

  it('refuses a non-integer or negative amount rather than truncating money', async () => {
    const cycle = await make();
    await expect(addToPool({ cycleId: cycle.cycleId, side: 'DELHI', amountPaise: 12.5 }))
      .rejects.toThrow(TypeError);
    await expect(addToPool({ cycleId: cycle.cycleId, side: 'DELHI', amountPaise: -100 }))
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
    } finally { client.release(); }
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
    } finally { a.release(); b.release(); }
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
      expect(acquiredAfterMs, 'the settlement locked the cycle while a bet still held it').toBeNull();

      await better.query('COMMIT');
      await settling;
      expect(acquiredAfterMs).toBeGreaterThanOrEqual(HOLD_MS);
      await settler.query('COMMIT');
    } finally { better.release(); settler.release(); }
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
    } finally { settler.release(); better.release(); }
  });

  it('returns null for a cycle that does not exist', async () => {
    const pool = await getPool();
    const client = await connectGuarded(pool);
    try {
      await client.query('BEGIN');
      expect(await lockForBet(client, 'no_such_cycle')).toBeNull();
      await client.query('COMMIT');
    } finally { client.release(); }
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
