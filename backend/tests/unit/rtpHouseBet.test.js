// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { describe, it, expect } from 'vitest';
import { planHouseBet } from '../../domains/markets/rtpHouseBet.js';

const base = { rateBp: 8000, feePercent: 0, multiplier: 2 };
const stakes = (d, b) => [{ side: 'DELHI', stakePaise: d * 100 }, { side: 'BOMBAY', stakePaise: b * 100 }];

describe('planHouseBet', () => {
  it('tops the smaller side to one rupee over the bigger when the fund covers the whole round', () => {
    // Pool 2,200: owed 1,760, paid back if flipped 4,000, so the round takes 2,240.
    expect(planHouseBet({ ...base, stakes: stakes(2_000, 200), availablePaise: 2_240_00 }))
      .toEqual({ side: 'BOMBAY', stakePaise: 1_801_00, reservedPaise: 2_240_00, entryPaise: -2_240_00 });
  });
  it('places none when the fund would go below zero', () => {
    expect(planHouseBet({ ...base, stakes: stakes(2_000, 200), availablePaise: 2_239_99 })).toBeNull();
  });
  it('places none on a tie or an empty round', () => {
    expect(planHouseBet({ ...base, stakes: stakes(500, 500), availablePaise: 1e9 })).toBeNull();
    expect(planHouseBet({ ...base, stakes: [], availablePaise: 1e9 })).toBeNull();
  });
  it('counts the winnings fee in what players get back', () => {
    const p = planHouseBet({ ...base, feePercent: 1, stakes: stakes(2_000, 200), availablePaise: 1e9 });
    expect(p.entryPaise).toBe(1_760_00 - 3_960_00);
  });
});
