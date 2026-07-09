// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the Merchant Performance Bonus calculator (pure, no DB).
import { describe, it, expect } from 'vitest';
import { computeBonusMinor } from '../../domains/merchant/merchantBonus.service.js';

describe('bonus calculator (only NEWLY matched volume, floored)', () => {
  it('5% of fresh 10k matched = 500 rupees', () => {
    const r = computeBonusMinor({ matchedMinor: 1000000, lastBonusedMatchedMinor: 0, bonusPercent: 5, minMatchedVolumeMinor: 10000 });
    expect(r.bonusMinor).toBe(50000);
    expect(r.newMatchedMinor).toBe(1000000);
  });
  it('only newly matched volume above the high-water mark is bonused', () => {
    const r = computeBonusMinor({ matchedMinor: 1500000, lastBonusedMatchedMinor: 1000000, bonusPercent: 5, minMatchedVolumeMinor: 10000 });
    expect(r.bonusMinor).toBe(25000);
    expect(r.newMatchedMinor).toBe(500000);
  });
  it('below threshold issues nothing', () => {
    const r = computeBonusMinor({ matchedMinor: 1005000, lastBonusedMatchedMinor: 1000000, bonusPercent: 5, minMatchedVolumeMinor: 10000 });
    expect(r.bonusMinor).toBe(0);
  });
  it('no new volume issues nothing (idempotent across runs)', () => {
    const r = computeBonusMinor({ matchedMinor: 1000000, lastBonusedMatchedMinor: 1000000, bonusPercent: 5, minMatchedVolumeMinor: 0 });
    expect(r.bonusMinor).toBe(0);
    expect(r.newMatchedMinor).toBe(0);
  });
  it('regressed matched volume issues nothing', () => {
    const r = computeBonusMinor({ matchedMinor: 900000, lastBonusedMatchedMinor: 1000000, bonusPercent: 5, minMatchedVolumeMinor: 0 });
    expect(r.bonusMinor).toBe(0);
  });
  it('floors to integer paise (no over-draw by rounding)', () => {
    const r = computeBonusMinor({ matchedMinor: 3333, lastBonusedMatchedMinor: 0, bonusPercent: 3, minMatchedVolumeMinor: 0 });
    expect(r.bonusMinor).toBe(99);
  });
  it('rejects non-integer volumes', () => {
    expect(() => computeBonusMinor({ matchedMinor: 10.5, lastBonusedMatchedMinor: 0, bonusPercent: 5, minMatchedVolumeMinor: 0 })).toThrow();
  });
});
