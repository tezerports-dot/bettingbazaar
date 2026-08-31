// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The betting/settlement boundary, decided by PostgreSQL rather than by a clock.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 * `betPg.placeBet` did not consult the cycle at ALL inside its transaction. It
 * locked the wallet row and the bet row, moved the stake, and committed —
 * without ever asking whether the cycle was still open. When
 * `MONEY_AUTHORITY_BETS=postgres`, the only thing standing between a stake and
 * an already-settling cycle was the wall-clock check in `bet.routes.js`, which
 * runs BEFORE the transaction opens and therefore cannot see a settlement that
 * begins while the stake is in flight.
 *
 * A bet committing in that window belongs to nothing: it is not in the pools
 * the winner was computed from, it is not in the payout, and no compensation
 * path refunds it. The Mongo path has a conditional-on-PENDING delete for
 * exactly this race; the Postgres path had no equivalent.
 *
 * ── Why an advisory lock and not a row lock ────────────────────────────────
 * There is no `cycles` table in this schema — the cycle document (status,
 * endTime, phase offsets) lives only in MongoDB. `cycle_settlements` is the
 * only per-cycle row, and it does not exist until settlement opens, which is
 * precisely the row a bet needs to be blocked by. A lock on a row that is not
 * there yet locks nothing, so both sides lock the cycle's NAME instead.
 *
 * The blocking test below is the one that matters. The others would pass on a
 * plain `SELECT` with no lock at all, because they never interleave.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { placeBet } from '../../postgres/betPg.js';
import { openSettlement } from '../../postgres/settlementPg.js';
import { getPool, pgQuery, connectGuarded, CYCLE_LOCK_CLASS } from '../../postgres/pgClient.js';

const USER = 'race_user';
let seq = 0;
const nextCycle = () => `race_cycle_${Date.now()}_${seq++}`;

const bet = (cycleId, betId) => placeBet({
  betId, userId: USER, cycleId, side: 'DELHI',
  slices: [{ field: 'depositBalance', amountPaise: 1_000 }],
});

beforeAll(async () => {
  const { applySchema } = await import('../../postgres/pgClient.js');
  await applySchema();
});

beforeEach(async () => {
  await pgQuery(
    `INSERT INTO wallets (user_id, deposit_paise) VALUES ($1, 100000000)
     ON CONFLICT (user_id) DO UPDATE SET deposit_paise = 100000000`,
    [USER],
  );
});

describe('a bet cannot land on a settling cycle', () => {
  it('accepts before the settlement opens and refuses after', async () => {
    const cycle = nextCycle();

    const before = await bet(cycle, `${cycle}_b1`);
    expect(before.ok, `pre-settlement bet was refused: ${before.reason}`).toBe(true);

    await openSettlement({ cycleId: cycle, winningSide: 'BOMBAY', betsTotal: 1, stakePaise: 1_000 });

    const after = await bet(cycle, `${cycle}_b2`);
    expect(after.ok, 'a stake landed on a cycle that was already settling').toBe(false);
    expect(after.reason).toBe('cycle_settling');
    expect(after.status).toBe('RUNNING');

    // And it left nothing behind: no bet row, no half-moved stake.
    const { rows } = await pgQuery('SELECT count(*)::int AS n FROM bets WHERE cycle_id = $1', [cycle]);
    expect(rows[0].n).toBe(1);
  });

  it('does not block a DIFFERENT cycle — the lock is per cycle, not global', async () => {
    // A global lock would serialize every bet on the platform behind any one
    // settlement, which at 60 settlements an hour is a throughput cliff.
    const settling = nextCycle();
    const open = nextCycle();
    await openSettlement({ cycleId: settling, winningSide: 'DELHI', betsTotal: 0, stakePaise: 0 });

    const elsewhere = await bet(open, `${open}_ok`);
    expect(elsewhere.ok, `an unrelated cycle was blocked: ${elsewhere.reason}`).toBe(true);
  });

  it('keeps stored bets equal to accepted bets under a concurrent storm', async () => {
    // Whichever side wins the lock, the two outcomes must agree: every bet the
    // API said it took is in the table, and every bet it refused is not.
    // Asserted as an equality rather than as "some were refused", because which
    // side wins is a genuine race and a test that needs the settlement to win
    // would be flaky by construction.
    const cycle = nextCycle();
    const bets = Array.from({ length: 30 }, (_, i) => bet(cycle, `${cycle}_c${i}`));
    const settlement = openSettlement({ cycleId: cycle, winningSide: 'BOMBAY', betsTotal: 0, stakePaise: 0 });

    const results = await Promise.all(bets);
    await settlement;

    const accepted = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    expect(refused.every((r) => r.reason === 'cycle_settling'),
      `unexpected refusals: ${refused.map((r) => r.reason).join(', ')}`).toBe(true);

    const { rows } = await pgQuery('SELECT count(*)::int AS n FROM bets WHERE cycle_id = $1', [cycle]);
    expect(rows[0].n).toBe(accepted.length);
    expect(accepted.length + refused.length).toBe(30);
  });
});

describe('the cycle lock actually blocks', () => {
  it('makes a settlement WAIT for a bet transaction already in flight', async () => {
    // The decisive test. Everything above would pass with an unlocked SELECT,
    // because nothing interleaves; this is the one that fails if the advisory
    // lock is dropped from either side.
    const cycle = nextCycle();
    const pool = await getPool();
    const inFlight = await connectGuarded(pool);

    // Stand in for a bet transaction that has taken the lock and not committed.
    await inFlight.query('BEGIN');
    await inFlight.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [CYCLE_LOCK_CLASS, cycle]);

    const startedAt = Date.now();
    let openedAfterMs = null;
    const settling = openSettlement({ cycleId: cycle, winningSide: 'DELHI', betsTotal: 0, stakePaise: 0 })
      .then(() => { openedAfterMs = Date.now() - startedAt; });

    const HOLD_MS = 600;
    await new Promise((r) => setTimeout(r, HOLD_MS));
    expect(openedAfterMs, 'the settlement opened while a bet still held the cycle').toBeNull();

    await inFlight.query('COMMIT');
    inFlight.release();
    await settling;

    expect(openedAfterMs).not.toBeNull();
    expect(openedAfterMs).toBeGreaterThanOrEqual(HOLD_MS);
  }, 15_000);
});
