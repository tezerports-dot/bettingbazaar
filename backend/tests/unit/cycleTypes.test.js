// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The cycle-type vocabulary, and the 1-minute block's timings.
 *
 * ── Why the timings are asserted here and not just configured ──────────────
 * The 1-minute block's phases are seconds apart (merge 12, equalize 9, close 5,
 * declare 3) where the other blocks' are minutes apart. Every one of those
 * numbers is load-bearing and none of them is self-evidently right, so the
 * schema defaults are pinned: a well-meaning edit that reorders two of them
 * produces a cycle that closes betting AFTER declaring a winner, and nothing
 * else in the system would object.
 *
 * The ordering invariant (merge > equalizer > close > celebrate >= 0) is
 * checked for every type rather than just the new one, because the generator
 * silently falls back to hardcoded defaults for any type whose configured set
 * fails it — a fallback that keeps the platform running and makes a broken
 * config invisible.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import {
  CYCLE_TYPES, CYCLE_TYPE_VALUES, INTERVAL_CYCLE_TYPES,
  isCycleType, cycleMeta, cycleLabel, phasesFor, limitsKeyFor,
} from '../../domains/markets/cycleTypes.js';
import { DEFAULT_CYCLE_PHASES } from '../../domains/configuration/systemConfig.model.js';

describe('cycle type registry', () => {
  it('knows exactly the three types the platform runs', () => {
    expect(CYCLE_TYPE_VALUES).toEqual(['1_MIN', '30_MIN', 'FULL_DAY']);
  });

  it('treats the hour-tiling types as intervals and the day as not', () => {
    // This split is what decides which creation path a type takes. FULL_DAY is
    // anchored to a calendar date; the others are floor(minute/d)*d blocks.
    expect(INTERVAL_CYCLE_TYPES).toEqual(['1_MIN', '30_MIN']);
    expect(cycleMeta(CYCLE_TYPES.FULL_DAY).interval).toBe(false);
  });

  it('gives every type its own label, so no result is announced under another type name', () => {
    // The bug this replaces: `type === '30_MIN' ? '30-MIN' : 'FULL-DAY'`, which
    // announced a 1-minute winner as "FULL-DAY Winner: DELHI!".
    const labels = CYCLE_TYPE_VALUES.map(cycleLabel);
    expect(labels).toEqual(['1-MIN', '30-MIN', 'FULL-DAY']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('gives the 1-minute block its own config keys rather than sharing the 30-minute ones', () => {
    // Sharing would mean an admin retuning the 30-minute block silently
    // retuned a block 30× shorter.
    expect(cycleMeta(CYCLE_TYPES.ONE_MIN).phasesKey).toBe('oneMin');
    expect(limitsKeyFor(CYCLE_TYPES.ONE_MIN)).toBe('oneMin');
    expect(limitsKeyFor(CYCLE_TYPES.THIRTY_MIN)).toBe('thirtyMin');
    expect(limitsKeyFor(CYCLE_TYPES.FULL_DAY)).toBe('fullDay');
  });

  it('fixes the 1-minute duration and leaves the 30-minute one admin-tunable', () => {
    expect(cycleMeta(CYCLE_TYPES.ONE_MIN).fixedDurationMin).toBe(1);
    // null = read SystemConfig.cycleDurationMinutes.
    expect(cycleMeta(CYCLE_TYPES.THIRTY_MIN).fixedDurationMin).toBeNull();
  });

  it('throws on an unknown type instead of defaulting', () => {
    expect(isCycleType('5_MIN')).toBe(false);
    expect(() => cycleMeta('5_MIN')).toThrow(/Unknown cycle type/);
    expect(() => limitsKeyFor(undefined)).toThrow(/Unknown cycle type/);
  });

  it('resolves a type to its phase set', () => {
    const all = { oneMin: { a: 1 }, thirtyMin: { a: 2 }, fullDay: { a: 3 } };
    expect(phasesFor(CYCLE_TYPES.ONE_MIN, all)).toEqual({ a: 1 });
    expect(phasesFor(CYCLE_TYPES.FULL_DAY, all)).toEqual({ a: 3 });
  });
});

describe('cycle phase defaults', () => {
  const defaults = () => new (mongoose.model('SystemConfig'))({ key: 'main' });

  it('gives the 1-minute block the specified 12 / 9 / 5 / 3 second timings', () => {
    const p = defaults().cyclePhases.oneMin;
    expect(p.mergeBeforeEndSec).toBe(12);
    expect(p.equalizerBeforeEndSec).toBe(9);
    expect(p.closeBeforeEndSec).toBe(5);
    expect(p.celebrateBeforeEndSec).toBe(3);
  });

  it('keeps every type strictly ordered: merge > equalizer > close > celebrate >= 0', () => {
    // The generator discards a phase set that fails this and falls back to its
    // hardcoded defaults — quietly. A schema default that failed it would mean
    // admin config for that type never took effect at all.
    const cfg = defaults().cyclePhases;
    for (const key of ['oneMin', 'thirtyMin', 'fullDay']) {
      const { mergeBeforeEndSec: m, equalizerBeforeEndSec: e,
              closeBeforeEndSec: c, celebrateBeforeEndSec: f } = cfg[key];
      expect(m, `${key} merge > equalizer`).toBeGreaterThan(e);
      expect(e, `${key} equalizer > close`).toBeGreaterThan(c);
      expect(c, `${key} close > celebrate`).toBeGreaterThan(f);
      expect(f, `${key} celebrate >= 0`).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps every phase inside the 1-minute block', () => {
    // 60s block: a merge offset of 60+ would fire before the cycle began, and
    // the ordering invariant above cannot catch that — it only compares the
    // phases with each other, never with the duration.
    const p = defaults().cyclePhases.oneMin;
    const durationSec = cycleMeta(CYCLE_TYPES.ONE_MIN).fixedDurationMin * 60;
    expect(p.mergeBeforeEndSec).toBeLessThan(durationSec);
    // And leaves a usable betting window rather than a token one.
    expect(durationSec - p.closeBeforeEndSec).toBeGreaterThanOrEqual(30);
  });

  it('gives the 1-minute block the 30-minute stake bounds', () => {
    // Same game, shorter window — and the chip ladder (₹10·30·90·270·810) is
    // shared with it, so the minimum has to match or the smallest chip is
    // unplayable.
    const cfg = defaults().betLimits;
    expect(cfg.oneMin.min).toBe(cfg.thirtyMin.min);
    expect(cfg.oneMin.max).toBe(cfg.thirtyMin.max);
    expect(cfg.oneMin.min).toBe(10);
  });
});

describe('Cycle model', () => {
  it('accepts every registry type and rejects anything else', () => {
    const Cycle = mongoose.model('Cycle');
    for (const type of CYCLE_TYPE_VALUES) {
      const doc = new Cycle({ cycleId: `t_${type}`, type, startTime: 1, endTime: 2 });
      expect(doc.validateSync()?.errors?.type, `${type} should be valid`).toBeUndefined();
    }
    const bad = new Cycle({ cycleId: 'nope', type: '5_MIN', startTime: 1, endTime: 2 });
    expect(bad.validateSync()?.errors?.type).toBeDefined();
  });
});

describe('phase defaults are declared once', () => {
  // These numbers lived in three files: the schema defaults, the generator's
  // fallback, and the admin phase-timeline route. The copies had already
  // drifted — the admin route said the 30-minute block closed betting 60s
  // before the end while the generator closed it at 30s, so the admin panel
  // drew a boundary the engine did not act on. There is now one declaration
  // and both consumers import it; this asserts the schema still agrees with
  // it, which is the join that a future edit could quietly break.
  it('uses DEFAULT_CYCLE_PHASES as the schema default for every type', () => {
    const cfg = new (mongoose.model('SystemConfig'))({ key: 'main' }).cyclePhases;
    for (const key of Object.keys(DEFAULT_CYCLE_PHASES)) {
      for (const [field, value] of Object.entries(DEFAULT_CYCLE_PHASES[key])) {
        expect(cfg[key][field], `${key}.${field}`).toBe(value);
      }
    }
  });

  it('declares a phase set for every registered type', () => {
    // A type in the registry with no phase set falls through to whatever the
    // consumer's `||` lands on — which for a 60-second block would be full-day
    // offsets, merging five minutes before a cycle that lasts one.
    for (const type of CYCLE_TYPE_VALUES) {
      expect(phasesFor(type, DEFAULT_CYCLE_PHASES), `no defaults for ${type}`).toBeDefined();
    }
  });
});

describe('phantom agent access', () => {
  it('can be scoped to the 1-minute block', () => {
    // Without this an agent could only be given the 1-minute cycle by granting
    // BOTH, which is every cycle including the full-day one.
    const User = mongoose.model('User');
    const doc = new User({ username: 'ghost', phantomAccess: '1_MIN' });
    expect(doc.validateSync()?.errors?.phantomAccess).toBeUndefined();
  });
});
