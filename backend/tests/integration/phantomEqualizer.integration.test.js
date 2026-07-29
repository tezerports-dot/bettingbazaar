// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): the phantom equalizer must not clobber real bets.
//
// Phase 2 of the cycle ticker (cycleGenerator.manageCycles) fires the equalizer
// while real betting is STILL OPEN — the call site guards on
// `now >= equalizerTime && now < betsClosedTime`. The equalizer's only job is
// to raise the lower phantom pool to match the higher one; it must never
// change realDelhi/realBombay, and it must not lose a concurrent real bet's
// $inc on totalDelhi.
//
// The schema invariant these tests defend (cycle.model.js):
//     totalDelhi  === realDelhi  + phantomDelhi
//     totalBombay === realBombay + phantomBombay
//
// The old implementation wrote `totalDelhi: (cycle.realDelhi || 0) + equalized`
// as an ABSOLUTE value derived from a snapshot the ticker read earlier in the
// loop, so a bet landing in between was silently overwritten.
import { describe, it, expect } from 'vitest';
import { Cycle } from '../../models/index.js';
import CycleGeneratorService from '../../domains/markets/cycleGenerator.service.js';

const svc = () => {
  const s = new CycleGeneratorService(null);
  // Isolate the unit under test from the socket layer.
  s.emitAdmin = () => {};
  s.emitPublic = () => {};
  return s;
};

let n = 0;
async function makeCycle(pools) {
  return Cycle.create({
    cycleId: `eq_cycle_${Date.now()}_${n++}`,
    type: '30_MIN',
    startTime: Date.now() - 1500000,
    endTime: Date.now() + 300000,
    status: 'OPEN',
    realDelhi: 0, realBombay: 0,
    phantomDelhi: 0, phantomBombay: 0,
    totalDelhi: 0, totalBombay: 0,
    ...pools,
  });
}

const invariantHolds = (c) => {
  expect(c.totalDelhi).toBe(c.realDelhi + c.phantomDelhi);
  expect(c.totalBombay).toBe(c.realBombay + c.phantomBombay);
};

describe('phantom equalizer — balances phantom pools without touching real bets', () => {
  it("raises the lower phantom side to the higher one (owner's worked example)", async () => {
    // Delhi:  real 1,000  phantom 12,000
    // Bombay: real 2,000  phantom 20,000
    // 12,000 < 20,000  →  both phantom sides become 20,000. Real is untouched.
    const cycle = await makeCycle({
      realDelhi: 1000, phantomDelhi: 12000, totalDelhi: 13000,
      realBombay: 2000, phantomBombay: 20000, totalBombay: 22000,
    });

    await svc().runPhantomEqualizer(cycle);

    const after = await Cycle.findById(cycle._id).lean();
    expect(after.phantomDelhi).toBe(20000);
    expect(after.phantomBombay).toBe(20000);
    // Real bets are the equalizer's business only insofar as it must not move them.
    expect(after.realDelhi).toBe(1000);
    expect(after.realBombay).toBe(2000);
    expect(after.totalDelhi).toBe(21000);  // 1,000 + 20,000
    expect(after.totalBombay).toBe(22000); // 2,000 + 20,000
    expect(after.phantomBetsClosed).toBe(true);
    expect(after.phantomBalanced).toBe(true);
    invariantHolds(after);
  });

  it('does not lose a real bet that lands between the ticker read and the write', async () => {
    // THE REGRESSION. `cycle` is the stale snapshot the ticker holds.
    const cycle = await makeCycle({
      realDelhi: 50000, phantomDelhi: 20000, totalDelhi: 70000,
      realBombay: 30000, phantomBombay: 12000, totalBombay: 42000,
    });

    // A user bets ₹5,000 on Delhi AFTER the ticker's read but BEFORE the
    // equalizer writes — exactly what bet.routes.js does on the hot path.
    await Cycle.updateOne(
      { cycleId: cycle.cycleId, status: { $in: ['OPEN', 'MERGED'] } },
      { $inc: { realDelhi: 5000, totalDelhi: 5000 } },
    );

    // Equalizer runs holding the pre-bet snapshot.
    await svc().runPhantomEqualizer(cycle);

    const after = await Cycle.findById(cycle._id).lean();
    // The bet survives in both fields. Old code wrote totalDelhi = 50,000 +
    // 20,000 = 70,000, silently destroying the ₹5,000.
    expect(after.realDelhi).toBe(55000);
    expect(after.totalDelhi).toBe(75000);
    expect(after.phantomDelhi).toBe(20000);
    expect(after.phantomBombay).toBe(20000);
    invariantHolds(after);
  });

  it('survives many concurrent real bets racing the equalizer', async () => {
    const cycle = await makeCycle({
      realDelhi: 0, phantomDelhi: 8000, totalDelhi: 8000,
      realBombay: 0, phantomBombay: 3000, totalBombay: 3000,
    });

    // 40 × ₹100 on Delhi fired concurrently with the equalizer. Whatever the
    // interleaving, every rupee must be present and the invariant must hold.
    const bets = Array.from({ length: 40 }, () =>
      Cycle.updateOne({ cycleId: cycle.cycleId }, { $inc: { realDelhi: 100, totalDelhi: 100 } }));
    await Promise.all([...bets, svc().runPhantomEqualizer(cycle)]);

    const after = await Cycle.findById(cycle._id).lean();
    expect(after.realDelhi).toBe(4000);
    expect(after.phantomDelhi).toBe(8000);
    expect(after.phantomBombay).toBe(8000);
    invariantHolds(after);
  });

  it('closes phantom betting when the pools are already equal, without broadcasting', async () => {
    const cycle = await makeCycle({
      realDelhi: 700, phantomDelhi: 5000, totalDelhi: 5700,
      realBombay: 400, phantomBombay: 5000, totalBombay: 5400,
    });

    const s = svc();
    let broadcasts = 0;
    s.emitAdmin = () => { broadcasts++; };
    await s.runPhantomEqualizer(cycle);

    // Preserved from the original implementation: nothing was equalized, so
    // admins get a log line and no phantom_equalized event.
    expect(broadcasts).toBe(0);
    const after = await Cycle.findById(cycle._id).lean();
    expect(after.phantomDelhi).toBe(5000);
    expect(after.phantomBombay).toBe(5000);
    expect(after.phantomBetsClosed).toBe(true);
    expect(after.phantomBalanced).toBe(true);
    invariantHolds(after);
  });

  it('still equalizes when a phantom bet arrives after the snapshot said "balanced"', async () => {
    // Second staleness bug: the old code decided between "equalize" and
    // "already balanced" from the snapshot. A phantom bet landing mid-tick
    // took the else branch and left the pools permanently unequal.
    const cycle = await makeCycle({
      realDelhi: 100, phantomDelhi: 5000, totalDelhi: 5100,
      realBombay: 100, phantomBombay: 5000, totalBombay: 5100,
    });

    await Cycle.updateOne(
      { cycleId: cycle.cycleId },
      { $inc: { phantomDelhi: 2500, totalDelhi: 2500 } },
    );

    await svc().runPhantomEqualizer(cycle);

    const after = await Cycle.findById(cycle._id).lean();
    expect(after.phantomDelhi).toBe(7500);
    expect(after.phantomBombay).toBe(7500); // was left at 5000 before the fix
    invariantHolds(after);
  });

  it('is idempotent — a second tick neither double-counts nor re-broadcasts', async () => {
    const cycle = await makeCycle({
      realDelhi: 1000, phantomDelhi: 12000, totalDelhi: 13000,
      realBombay: 2000, phantomBombay: 20000, totalBombay: 22000,
    });

    const s = svc();
    let broadcasts = 0;
    s.emitAdmin = () => { broadcasts++; };

    await s.runPhantomEqualizer(cycle);
    await s.runPhantomEqualizer(cycle); // overlapping tick, same stale snapshot

    const after = await Cycle.findById(cycle._id).lean();
    expect(after.phantomDelhi).toBe(20000);
    expect(after.totalDelhi).toBe(21000);
    expect(broadcasts).toBe(1);
    invariantHolds(after);
  });
});
