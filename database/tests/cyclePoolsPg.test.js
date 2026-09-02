// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The real bet pools, derived from the bets.
 *
 * ── Why these moved out of the unit suite ───────────────────────────────────
 * They were unit tests over a stubbed aggregation, and most of them asserted
 * machinery that no longer exists: a feature flag, a freshness memo, an `exact`
 * mode that swapped the read concern, and a write-back onto the cycle document.
 *
 * The write-back was the reason the rest existed. Recomputing was expensive
 * because each recompute was a WRITE, so it had to be memoised — and the memo
 * then needed a bypass for the two moments the number becomes money. None of
 * that survives: a sum over an indexed column writes nothing, and every caller
 * gets the same consistent answer.
 *
 * What is left is the part that was always the point, and it is a property of
 * the DATA rather than of a mock: which bets count toward the pool a winner is
 * paid from.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { realPools, cycleWithPools, ensureCycle, placePhantomBet } from '../repositories/markets.js';

const describePg = pgConfigured() ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
let n = 0;
const nextId = () => `cp-${RUN}-${n += 1}`;

/** A bet row, written directly: these tests are about the SUM, not placement. */
async function bet(cycleId, side, rupees, { status = 'PENDING', phantom = false } = {}) {
  await pgQuery(
    `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status, is_phantom)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [nextId(), `u-${RUN}`, cycleId, side, Math.round(rupees * 100), status, phantom],
  );
}

describePg('real cycle pools', () => {
  let cycleId;

  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    cycleId = nextId();
    const start = new Date(Date.now() - 60_000);
    await ensureCycle({
      cycleId, cycleType: '30_MIN',
      startTime: start, endTime: new Date(start.getTime() + 30 * 60_000),
    });
  });

  it('sums each side independently', async () => {
    await bet(cycleId, 'DELHI', 100);
    await bet(cycleId, 'DELHI', 250);
    await bet(cycleId, 'BOMBAY', 400);

    expect(await realPools(cycleId)).toMatchObject({
      realDelhi: 350, realBombay: 400, delhiBets: 2, bombayBets: 1,
    });
  });

  it('returns zeros for a cycle with no bets, not undefined', async () => {
    // A caller comparing `realDelhi > realBombay` to pick the winning side must
    // not be handed undefined: `undefined > undefined` is false either way, so
    // the comparison silently picks a fixed answer.
    expect(await realPools(cycleId)).toMatchObject({ realDelhi: 0, realBombay: 0 });
  });

  it('excludes PHANTOM bets — that is what the word REAL means here', async () => {
    await bet(cycleId, 'DELHI', 100);
    await bet(cycleId, 'DELHI', 900, { phantom: true });

    // Phantom stakes are house figures that move the displayed total without
    // anybody having staked anything. Counting them would inflate the pool a
    // winner is paid a share of — and the winning side is the MINORITY real
    // side, so it would also pick the winner from numbers nobody bet.
    expect((await realPools(cycleId)).realDelhi).toBe(100);
  });

  it('excludes REFUNDED and VOID stakes — that money went back', async () => {
    await bet(cycleId, 'BOMBAY', 100);
    await bet(cycleId, 'BOMBAY', 500, { status: 'REFUNDED' });
    await bet(cycleId, 'BOMBAY', 700, { status: 'VOID' });

    expect((await realPools(cycleId)).realBombay).toBe(100);
  });

  it('counts settled bets, not only PENDING ones', async () => {
    // A bet that has been decided was still staked into the pool. Counting only
    // PENDING would make the pool shrink as a cycle settles, and `netProfit =
    // realPool − paidOut` is computed at exactly that moment.
    await bet(cycleId, 'DELHI', 100, { status: 'WON' });
    await bet(cycleId, 'DELHI', 200, { status: 'LOST' });
    await bet(cycleId, 'DELHI', 300, { status: 'PENDING' });

    expect((await realPools(cycleId)).realDelhi).toBe(600);
  });

  it('adds the stored phantom figures at READ time', async () => {
    await bet(cycleId, 'DELHI', 100);
    await placePhantomBet({
      betId: nextId(), userId: `agent-${RUN}`, cycleId, side: 'DELHI', amountRupees: 50,
    });

    const view = await cycleWithPools(cycleId);
    // Real and phantom stay separable — an operator has to be able to see how
    // much of a displayed total is real — and the total is computed rather than
    // stored, so a broadcast and a settlement cannot see different figures
    // depending on which refresh last ran.
    expect(view.realDelhi).toBe(100);
    expect(view.phantomDelhi).toBe(50);
    expect(view.totalDelhi).toBe(150);
  });

  it('places a phantom bet and its pool movement together', async () => {
    const betId = nextId();
    const first = await placePhantomBet({
      betId, userId: `agent-${RUN}`, cycleId, side: 'BOMBAY', amountRupees: 75,
    });
    expect(first).toMatchObject({ ok: true, idempotent: false });
    expect(first.cycle.phantomBombay).toBe(75);

    // A replayed request must not move the pool a second time.
    const replay = await placePhantomBet({
      betId, userId: `agent-${RUN}`, cycleId, side: 'BOMBAY', amountRupees: 75,
    });
    expect(replay).toMatchObject({ ok: true, idempotent: true });
    expect((await cycleWithPools(cycleId)).phantomBombay).toBe(75);
  });

  it('refuses a phantom bet on a cycle that has stopped taking them', async () => {
    await pgQuery('UPDATE cycles SET phantom_bets_closed = TRUE WHERE cycle_id = $1', [cycleId]);
    // Checked under the cycle's row lock, so an admin closing phantom betting
    // cannot be raced by an agent's last bet.
    expect(await placePhantomBet({
      betId: nextId(), userId: `agent-${RUN}`, cycleId, side: 'DELHI', amountRupees: 10,
    })).toMatchObject({ ok: false, reason: 'PHANTOM_CLOSED' });

    expect((await cycleWithPools(cycleId)).phantomDelhi).toBe(0);
  });

  it('refuses a phantom bet on a closed cycle', async () => {
    await pgQuery("UPDATE cycles SET status = 'CLOSED' WHERE cycle_id = $1", [cycleId]);
    expect(await placePhantomBet({
      betId: nextId(), userId: `agent-${RUN}`, cycleId, side: 'DELHI', amountRupees: 10,
    })).toMatchObject({ ok: false, reason: 'CYCLE_CLOSED', status: 'CLOSED' });
  });

  it('holds up under concurrent phantom bets', async () => {
    // The counter moves under the cycle's row lock, so ten at once add up
    // rather than losing updates the way a read-modify-write would.
    await Promise.all(Array.from({ length: 10 }, () => placePhantomBet({
      betId: nextId(), userId: `agent-${RUN}`, cycleId, side: 'DELHI', amountRupees: 10,
    })));
    expect((await cycleWithPools(cycleId)).phantomDelhi).toBe(100);
  });
});
