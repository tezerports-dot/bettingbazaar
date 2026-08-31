// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Every board, not just the fast one.
 *
 * `oneMinuteCycleLifecycle.integration.test.js` proves the 1-minute block in
 * detail, because its phases are seconds apart and that is what was new. It
 * leaves two things unproven, and this file covers both.
 *
 * FIRST: FULL_DAY has no lifecycle coverage anywhere. It is also the ONE
 * creation path the interval refactor did not touch — `ensureIntervalCycle`
 * replaced the two `ensureActive*Cycle` methods for the hour-tiling types,
 * while the calendar-anchored full-day path kept its own code. So the board
 * with the least test coverage is the board whose code most recently stopped
 * having a sibling to be compared against.
 *
 * SECOND: the invariants that must hold for EVERY board were asserted for one.
 * A per-type loop is the point here — a rule proven only on the type someone
 * happened to be working on is a rule that silently stops applying to the next
 * type added, which is exactly how a third type came to inherit the second's
 * stake limits and the second's result label.
 *
 * These drive real Mongo through the real generator and the real bet route.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { signToken } from '../../domains/identity/paseto.util.js';
import { User, Cycle, SystemConfig } from '../../models/index.js';
import betRoutes from '../../domains/markets/bet.routes.js';
import CycleGeneratorService from '../../domains/markets/cycleGenerator.service.js';
import { CYCLE_TYPES, CYCLE_TYPE_VALUES, cycleMeta, phasesFor } from '../../domains/markets/cycleTypes.js';
import { DEFAULT_CYCLE_PHASES } from '../../domains/configuration/systemConfig.model.js';

const app = express();
app.use(express.json());
app.use('/api/bet', betRoutes);
const authFor = (user) => `Bearer ${signToken({ userId: user._id })}`;

const svc = () => {
  const s = new CycleGeneratorService(null);
  s.emitAdmin = () => {}; s.emitPublic = () => {}; s.emitUser = () => {};
  return s;
};

/** How long a block of this type runs, in ms. */
const durationMs = (type) => {
  const fixed = cycleMeta(type).fixedDurationMin;
  if (fixed) return fixed * 60_000;
  return type === CYCLE_TYPES.FULL_DAY ? 24 * 3600_000 : 30 * 60_000;
};

let seq = 0;
/** A cycle of `type` positioned `secondsLeft` from its end, with a real duration. */
const cycleAt = (type, secondsLeft, extra = {}) => {
  const endTime = Date.now() + secondsLeft * 1000;
  return Cycle.create({
    cycleId: `all_${Date.now()}_${seq++}`,
    type,
    startTime: endTime - durationMs(type),
    endTime,
    status: 'OPEN',
    realDelhi: 0, realBombay: 0, phantomDelhi: 0, phantomBombay: 0,
    totalDelhi: 0, totalBombay: 0,
    ...extra,
  });
};

const phases = (type) => phasesFor(type, DEFAULT_CYCLE_PHASES);

let player;
beforeEach(async () => {
  await SystemConfig.create({ key: 'main' });
  player = await User.create({
    username: `p_${seq++}`, depositBalance: 100000, winningsBalance: 0, reserveBalance: 0,
  });
});
afterEach(() => { /* collections are cleared by tests/setup.js */ });

describe('every board — the betting cutoff is on the clock and is its own', () => {
  const bet = (cycle, type) => request(app)
    .post('/api/bet').set('Authorization', authFor(player))
    .send({ cycleId: cycle.cycleId, side: 'DELHI', amount: 100, type });

  for (const type of CYCLE_TYPE_VALUES) {
    const p = () => phases(type);

    it(`${type}: accepts a stake comfortably before its own cutoff`, async () => {
      const c = await cycleAt(type, p().closeBeforeEndSec + 30);
      const res = await bet(c, type);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it(`${type}: REJECTS a stake past the cutoff while the row still reads OPEN`, async () => {
      // The row is left OPEN on purpose: this is the slipped-tick case. Before
      // the clock guard the status flag was the only gate, so this bet landed.
      const c = await cycleAt(type, Math.max(1, p().closeBeforeEndSec - 1));
      expect(c.status).toBe('OPEN');
      const res = await bet(c, type);
      expect(res.status, `${type} accepted a late stake`).toBe(400);
      expect(res.body.code).toBe('BETTING_CLOSED');
    });

    it(`${type}: rejects a stake on a block already past its end`, async () => {
      const c = await cycleAt(type, -5);
      const res = await bet(c, type);
      expect(res.status).toBe(400);
    });
  }

  it('applies each board its OWN cutoff rather than one shared number', async () => {
    // A 1-minute block at 20s left is OPEN for betting; a full-day block at 20s
    // left is long past its 30s cutoff. One shared constant cannot produce both.
    const fast = await cycleAt(CYCLE_TYPES.ONE_MIN, 20);
    const slow = await cycleAt(CYCLE_TYPES.FULL_DAY, 20);
    expect((await bet(fast, CYCLE_TYPES.ONE_MIN)).status).toBe(200);
    expect((await bet(slow, CYCLE_TYPES.FULL_DAY)).status).toBe(400);
  });
});

describe('every board — phases fire in the specified order against its own clock', () => {
  for (const type of CYCLE_TYPE_VALUES) {
    it(`${type}: OPEN → MERGED → CLOSED as its offsets are crossed`, async () => {
      const p = phases(type);
      const s = svc();

      // `updateCycleStatuses`, not `manageCycles`: the latter also CREATES a
      // block for every type on each call, which would race these fixtures on
      // the unique {type,startTime} index and force-expire them as stale.
      // Advancing existing cycles is the subject here.
      const open = await cycleAt(type, p.mergeBeforeEndSec + 60);
      await s.updateCycleStatuses();
      expect((await Cycle.findById(open._id)).status, `${type} before merge`).toBe('OPEN');

      const merging = await cycleAt(type, p.mergeBeforeEndSec - 1);
      await s.updateCycleStatuses();
      expect((await Cycle.findById(merging._id)).status, `${type} at merge`).toBe('MERGED');

      const closing = await cycleAt(type, p.closeBeforeEndSec - 1, { status: 'MERGED' });
      await s.updateCycleStatuses();
      expect(
        ['CLOSED', 'RESULT_DECLARED'],
        `${type} at close`,
      ).toContain((await Cycle.findById(closing._id)).status);
    });
  }
});

describe('the full-day board keeps its own creation path', () => {
  it('creates a calendar-anchored block, not an hour-tiled one', async () => {
    // FULL_DAY is the one type ensureIntervalCycle does NOT serve. Nothing else
    // asserts that path still produces a block at all.
    const s = svc();
    await s.ensureActiveFullDayCycle();
    const c = await Cycle.findOne({ type: CYCLE_TYPES.FULL_DAY }).lean();
    expect(c, 'no full-day cycle was created').toBeTruthy();
    expect(c.status).toBe('OPEN');
    // A day, not an hour-tiled block. Allowing a wide band because the anchor
    // is IST midnight and this asserts the ORDER of magnitude, not the offset.
    const span = c.endTime - c.startTime;
    expect(span).toBeGreaterThan(20 * 3600_000);
    expect(span).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
  });

  it('does not create a second full-day block while one is live', async () => {
    const s = svc();
    await s.ensureActiveFullDayCycle();
    await s.ensureActiveFullDayCycle();
    expect(await Cycle.countDocuments({ type: CYCLE_TYPES.FULL_DAY })).toBe(1);
  });

  it('runs alongside the other boards without either starving the other', async () => {
    // One tick, three live boards. The 1-minute board resolving 60 times an
    // hour must not crowd out the block that resolves once a day.
    const s = svc();
    await s.ensureIntervalCycle(CYCLE_TYPES.ONE_MIN);
    await s.ensureIntervalCycle(CYCLE_TYPES.THIRTY_MIN);
    await s.ensureActiveFullDayCycle();
    for (const type of CYCLE_TYPE_VALUES) {
      expect(
        await Cycle.countDocuments({ type, status: 'OPEN' }),
        `${type} has no live block`,
      ).toBe(1);
    }
  });
});
