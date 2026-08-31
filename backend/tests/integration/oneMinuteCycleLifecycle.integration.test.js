// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Integration test (real DB): a 1-minute block, driven through every phase.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * Every other integration test in this suite creates a `30_MIN` cycle. The
 * settlement machinery they prove is genuinely type-agnostic, so that coverage
 * is real — but it is all exercised at THIRTY-MINUTE timings, where the phase
 * offsets are minutes apart and the 1-second status tick has minutes of slack.
 *
 * The 1-minute block is the same machinery with the offsets collapsed to
 * 12 / 9 / 5 / 3 SECONDS. That is the only thing about it that is new, and it
 * is the thing nothing tested. The betting cutoff defect this file's second
 * block regresses lived exactly there: betting was gated on `cycle.status`
 * alone, so a slipped tick let stakes land between the T−5s close and the T−3s
 * declaration — inside the window whose pools decide the winner, and after the
 * phantom equalizer at T−9s had finished balancing. On a 30-minute board the
 * same gap is ~20 seconds wide and never mattered; nothing in the suite could
 * have caught it, because nothing ran a board where it was two seconds.
 *
 * ── How the clock is driven ────────────────────────────────────────────────
 * Not with fake timers. Each test creates a cycle whose `endTime` places
 * "now" at the phase under test and then calls the REAL `updateCycleStatuses`
 * tick, so the arithmetic under test is the arithmetic that runs in
 * production, reading the same `SystemConfig.cyclePhases` defaults. A cycle
 * ending in 8 seconds IS a cycle at T−8s.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { signToken } from '../../domains/identity/paseto.util.js';
import { User, Cycle, Bet } from '../../models/index.js';
import betRoutes from '../../domains/markets/bet.routes.js';
import GameEngine from '../../domains/markets/gameEngine.js';
import CycleGeneratorService from '../../domains/markets/cycleGenerator.service.js';
import { CYCLE_TYPES } from '../../domains/markets/cycleTypes.js';

const app = express();
app.use(express.json());
app.use('/api/bet', betRoutes);
const authFor = (user) => `Bearer ${signToken({ userId: user._id })}`;

/** A generator with the socket layer stubbed out — the phase logic is the subject. */
const svc = () => {
  const s = new CycleGeneratorService(null);
  s.emitAdmin = () => {};
  s.emitPublic = () => {};
  s.emitUser = () => {};
  return s;
};

let seq = 0;
/**
 * A 1-minute cycle positioned `secondsLeft` from its end.
 * startTime is a real 60 seconds before endTime, so duration-relative logic
 * sees a genuine 1-minute block rather than a doctored one.
 */
const cycleAt = (secondsLeft, extra = {}) => {
  const endTime = Date.now() + secondsLeft * 1000;
  return Cycle.create({
    cycleId: `om_${Date.now()}_${seq++}`,
    type: CYCLE_TYPES.ONE_MIN,
    startTime: endTime - 60_000,
    endTime,
    status: 'OPEN',
    realDelhi: 0, realBombay: 0,
    phantomDelhi: 0, phantomBombay: 0,
    totalDelhi: 0, totalBombay: 0,
    ...extra,
  });
};

const reread = (c) => Cycle.findById(c._id).lean();

/**
 * Stake `realDelhi`/`realBombay` on a cycle as REAL BETS as well as stored
 * pool totals.
 *
 * Both are needed because the winner is read two different ways depending on
 * a flag: `completeCycle` calls `refreshRealPools(…, {exact:true})`, which
 * recomputes the pools by summing the Bet documents when
 * `FLAGS.DERIVED_CYCLE_POOLS` is on and returns null when it is off, in which
 * case the stored `cycle.realDelhi` is used instead.
 *
 * A fixture that set only the stored totals would therefore pass with the flag
 * off and, with it on, recompute both pools to zero — a tie, which
 * `completeCycle` breaks with `Math.random()`. That is a test asserting a
 * specific winner against a coin flip: green today, intermittently red later,
 * and blaming the cycle logic rather than the fixture. Backing the pools with
 * real bets makes both paths agree on the same winner.
 */
async function stake(cycle, { delhi = 0, bombay = 0 }) {
  const bettor = await User.create({
    username: `om_stk${seq++}`, mobile: `92000${String(seq).padStart(5, '0')}`,
    kycStatus: 'APPROVED', depositBalance: 0, winningsBalance: 0, reserveBalance: 0,
  });
  const rows = [];
  if (delhi)  rows.push({ userId: bettor._id, cycleId: cycle.cycleId, amount: delhi,  side: 'DELHI',  isPhantom: false, status: 'PENDING' });
  if (bombay) rows.push({ userId: bettor._id, cycleId: cycle.cycleId, amount: bombay, side: 'BOMBAY', isPhantom: false, status: 'PENDING' });
  if (rows.length) await Bet.insertMany(rows);
  await Cycle.updateOne({ _id: cycle._id }, {
    realDelhi: delhi, realBombay: bombay,
    totalDelhi: delhi + (cycle.phantomDelhi || 0),
    totalBombay: bombay + (cycle.phantomBombay || 0),
  });
  return Cycle.findById(cycle._id);
}

describe('1-minute cycle — phases fire at the specified 12 / 9 / 5 / 3 second offsets', () => {
  it('stays OPEN before the merge offset', async () => {
    const c = await cycleAt(20);
    await svc().updateCycleStatuses();
    expect((await reread(c)).status).toBe('OPEN');
  });

  it('merges at T-12s', async () => {
    const c = await cycleAt(11);
    await svc().updateCycleStatuses();
    expect((await reread(c)).status).toBe('MERGED');
  });

  it('runs the phantom equalizer at T-9s, while betting is still open', async () => {
    // The equalizer must fire in the T−9s → T−5s window and leave real pools
    // untouched. On this board that window is FOUR SECONDS wide; on the
    // 30-minute board it is 90.
    const c = await cycleAt(8, {
      status: 'MERGED',
      phantomDelhi: 400, phantomBombay: 900,
    });
    await stake(c, { delhi: 100, bombay: 200 });
    await svc().updateCycleStatuses();

    const after = await reread(c);
    expect(after.phantomBetsClosed).toBe(true);
    expect(after.phantomDelhi).toBe(900);       // raised to the higher side
    expect(after.phantomBombay).toBe(900);
    expect(after.realDelhi).toBe(100);          // real pools are never touched
    expect(after.realBombay).toBe(200);
    expect(after.totalDelhi).toBe(after.realDelhi + after.phantomDelhi);
    expect(after.totalBombay).toBe(after.realBombay + after.phantomBombay);
    // Still open for betting — the equalizer runs BEFORE the close.
    expect(['OPEN', 'MERGED']).toContain(after.status);
  });

  it('closes betting at T-5s', async () => {
    const c = await cycleAt(4, { status: 'MERGED', phantomBetsClosed: true });
    await svc().updateCycleStatuses();
    expect((await reread(c)).status).toBe('CLOSED');
  });

  it('declares the winner at T-3s', async () => {
    const c = await cycleAt(2, { status: 'CLOSED', phantomBetsClosed: true });
    await stake(c, { delhi: 500, bombay: 100 });
    await svc().updateCycleStatuses();

    const after = await reread(c);
    expect(after.status).toBe('RESULT_DECLARED');
    // Winner is the MINORITY real side — Bombay staked less.
    expect(after.winner).toBe('BOMBAY');
    expect(after.isSettled).toBe('PENDING');
  });

  it('completes a still-OPEN cycle rather than stalling when earlier ticks were missed', async () => {
    // The tolerance the 2-second close→declare window depends on. A cycle that
    // never saw MERGED or CLOSED must still declare at T−3s; the alternative is
    // a board that hangs past its own end because one tick ran late.
    const c = await cycleAt(2);
    await stake(c, { delhi: 10, bombay: 90 });
    await svc().updateCycleStatuses();

    const after = await reread(c);
    expect(after.status).toBe('RESULT_DECLARED');
    expect(after.winner).toBe('DELHI');
  });

  it('walks one cycle OPEN → MERGED → CLOSED → RESULT_DECLARED across consecutive ticks', async () => {
    // The phases in sequence on ONE document, each tick reading the clock the
    // way the live ticker does, rather than four independent fixtures.
    const s = svc();
    const c = await cycleAt(13);
    await stake(c, { delhi: 300, bombay: 50 });
    const seen = [];

    for (let i = 0; i < 12; i++) {
      await s.updateCycleStatuses();
      const now = await reread(c);
      if (seen[seen.length - 1] !== now.status) seen.push(now.status);
      if (now.status === 'RESULT_DECLARED') break;
      await new Promise(r => setTimeout(r, 1000));  // the real 1s tick interval
    }

    expect(seen[0]).toBe('OPEN');
    expect(seen).toContain('RESULT_DECLARED');
    // Monotonic: a board must never move backwards through its own phases.
    const order = ['OPEN', 'MERGED', 'CLOSED', 'RESULT_DECLARED'];
    const idx = seen.map(st => order.indexOf(st));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));

    const final = await reread(c);
    expect(final.winner).toBe('BOMBAY');  // minority real side
  }, 25000);
});

describe('1-minute cycle — betting closes on the clock, not on the status flag', () => {
  const better = () => User.create({
    username: `om_u${seq++}`, mobile: `91000${String(seq).padStart(5, '0')}`,
    kycStatus: 'APPROVED', depositBalance: 500, winningsBalance: 0, reserveBalance: 50,
  });

  const bet = (user, cycle, key) => request(app).post('/api/bet/place')
    .set('Authorization', authFor(user))
    .set('Idempotency-Key', key)
    .send({ cycleId: cycle.cycleId, side: 'DELHI', amount: 10, type: CYCLE_TYPES.ONE_MIN });

  it('accepts a stake at T-6s, before the T-5s cutoff', async () => {
    const u = await better();
    const c = await cycleAt(6);
    expect((await bet(u, c, `om-ok-${seq}`)).status).toBe(200);
  });

  it('REJECTS a stake at T-4s even though the cycle still reads OPEN', async () => {
    // The regression. `status` is left deliberately OPEN — this is precisely
    // the state a slipped tick leaves behind, and the state the route used to
    // accept. The stake would otherwise land in the pools read at T−3s and
    // move the minority side, i.e. change who wins, after the equalizer.
    const u = await better();
    const c = await cycleAt(4);
    expect(c.status).toBe('OPEN');

    const res = await bet(u, c, `om-late-${seq}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BETTING_CLOSED');

    // And nothing was taken from the player or added to the pool.
    expect(await Bet.countDocuments({ cycleId: c.cycleId })).toBe(0);
    expect((await User.findById(u._id).lean()).depositBalance).toBe(500);
  });

  it('rejects a stake on a cycle already past its end but still flagged OPEN', async () => {
    // Generator down, cycle never advanced. Before the clock check this was an
    // open board with no end.
    const u = await better();
    const c = await cycleAt(-30);
    const res = await bet(u, c, `om-stale-${seq}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BETTING_CLOSED');
  });

  it('applies each board its OWN cutoff, not a shared one', async () => {
    // T−40s: past nothing on a 1-minute board (which does not live that long),
    // but the 30-minute board closes at T−30s, so this is still open there.
    // A single shared cutoff would get one of these two wrong.
    const u = await better();
    const thirty = await Cycle.create({
      cycleId: `om_30_${seq++}`, type: CYCLE_TYPES.THIRTY_MIN,
      startTime: Date.now() - 1_760_000, endTime: Date.now() + 40_000, status: 'OPEN',
    });
    const res = await request(app).post('/api/bet/place')
      .set('Authorization', authFor(u))
      .set('Idempotency-Key', `om-30-${seq}`)
      .send({ cycleId: thirty.cycleId, side: 'DELHI', amount: 10, type: CYCLE_TYPES.THIRTY_MIN });
    expect(res.status).toBe(200);
  });
});

describe('1-minute cycle — the next block opens once one ends', () => {
  it('creates a 60-second block aligned to the minute', async () => {
    await svc().ensureIntervalCycle(CYCLE_TYPES.ONE_MIN);

    const c = await Cycle.findOne({ type: CYCLE_TYPES.ONE_MIN }).lean();
    expect(c).toBeTruthy();
    expect(c.status).toBe('OPEN');
    expect(new Date(c.endTime).getTime() - new Date(c.startTime).getTime()).toBe(60_000);
    // Live: the block contains the present moment.
    expect(new Date(c.endTime).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not create a second block while one is live', async () => {
    const s = svc();
    await s.ensureIntervalCycle(CYCLE_TYPES.ONE_MIN);
    await s.ensureIntervalCycle(CYCLE_TYPES.ONE_MIN);
    expect(await Cycle.countDocuments({ type: CYCLE_TYPES.ONE_MIN })).toBe(1);
  });

  it('holds the next block for the celebration, then releases it', async () => {
    // The lock was hardcoded at 10s/10.5s and now derives from each type's own
    // celebrate offset. Ten seconds on a 60-second block would swallow a sixth
    // of the next cycle before betting opened.
    const s = svc();
    const c = await cycleAt(2, { status: 'CLOSED' });
    await stake(c, { delhi: 40, bombay: 10 });
    await s.completeCycle(await Cycle.findById(c._id));

    const lockMs = s.celebrationLockUntil[CYCLE_TYPES.ONE_MIN] - Date.now();
    expect(lockMs).toBeGreaterThan(0);
    // Bounded by this board's own 3s celebration, not the 30-minute board's 10s.
    expect(lockMs).toBeLessThanOrEqual(4_000);

    // While held, no replacement block appears.
    await s.ensureIntervalCycle(CYCLE_TYPES.ONE_MIN);
    expect(await Cycle.countDocuments({ type: CYCLE_TYPES.ONE_MIN, status: 'OPEN' })).toBe(0);

    // Released, the next block opens.
    s.celebrationLockUntil[CYCLE_TYPES.ONE_MIN] = 0;
    await s.ensureIntervalCycle(CYCLE_TYPES.ONE_MIN);
    expect(await Cycle.countDocuments({ type: CYCLE_TYPES.ONE_MIN, status: 'OPEN' })).toBe(1);
  });

  it('does not let the 1-minute board starve the other types of their own blocks', async () => {
    // One tick creates every interval type's block. A 1-minute board that
    // returned early — or threw — would leave the 30-minute one uncreated.
    const s = svc();
    await s.ensureIntervalCycle(CYCLE_TYPES.ONE_MIN);
    await s.ensureIntervalCycle(CYCLE_TYPES.THIRTY_MIN);
    expect(await Cycle.countDocuments({ type: CYCLE_TYPES.ONE_MIN, status: 'OPEN' })).toBe(1);
    expect(await Cycle.countDocuments({ type: CYCLE_TYPES.THIRTY_MIN, status: 'OPEN' })).toBe(1);
  });
});

describe('1-minute cycle — settlement pays the same way as every other board', () => {
  let engine;
  beforeEach(() => { engine = new GameEngine(null); });
  afterEach(() => { engine.stop(); });

  it('pays the minority side 2x minus the winnings fee and consumes the loser stake', async () => {
    // The money rules are platform-wide and take no per-type case (GOVERNANCE
    // §22.1). This asserts that holds when the board is a 1-minute one — the
    // settlement runs inside a 3-second celebration window here rather than a
    // 10-second one.
    const winner = await User.create({
      username: 'om_win', mobile: '9110000001', kycStatus: 'APPROVED',
      depositBalance: 100, winningsBalance: 0, reserveBalance: 10,
    });
    const loser = await User.create({
      username: 'om_lose', mobile: '9110000002', kycStatus: 'APPROVED',
      depositBalance: 100, winningsBalance: 0, reserveBalance: 10,
    });

    const c = await cycleAt(30);
    const place = (u, side, key) => request(app).post('/api/bet/place')
      .set('Authorization', authFor(u))
      .set('Idempotency-Key', key)
      .send({ cycleId: c.cycleId, side, amount: 10, type: CYCLE_TYPES.ONE_MIN });

    expect((await place(winner, 'BOMBAY', 'om-settle-w')).status).toBe(200);
    expect((await place(loser, 'DELHI', 'om-settle-l1')).status).toBe(200);
    expect((await place(loser, 'DELHI', 'om-settle-l2')).status).toBe(200);

    // Delhi carries more real stake, so Bombay is the minority and wins.
    const toSettle = await Cycle.findOneAndUpdate(
      { _id: c._id },
      { $set: { status: 'RESULT_DECLARED', winner: 'BOMBAY', isSettled: 'PENDING', completedAt: new Date() } },
      { new: true },
    );
    await engine.processPayoutsOptimized(toSettle);

    const bets = await Bet.find({ cycleId: c.cycleId }).lean();
    const won = bets.filter(b => b.status === 'WON');
    const lost = bets.filter(b => b.status === 'LOST');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);

    // ₹10 staked → gross ₹20 → minus the 1% winnings fee → ₹19.80 net, the
    // same arithmetic betFlow pins on the 30-minute board. The fee is
    // platform-wide (GOVERNANCE §22.1) and takes no per-type case; this is the
    // assertion that would fail if one were ever added.
    expect(won[0].payout).toBe(19.8);

    const after = await User.findById(winner._id).lean();
    expect(after.winningsBalance).toBe(19.8);
    expect(after.lockedBalance).toBe(0);

    const settled = await Cycle.findById(c._id).lean();
    expect(settled.isSettled).toBe('COMPLETED');
  });
});
