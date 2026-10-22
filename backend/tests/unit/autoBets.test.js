// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The rules of a player's auto bets (autoBets.js, owner 2026-10-22): the
 * ladder rounds to the bet step without compounding, the step comes from
 * losses in a row, each stop is reached before the bet that would cross it,
 * and a plan the board could not take is refused whole, naming why.
 */
import { describe, it, expect } from 'vitest';
import {
  ladderStakes, stepOf, stopBefore, stopForRefusal, normalisePlan, autoBetId, AUTO_STOP_REASONS, AUTO_STOP_TEXT,
} from '../../domains/markets/autoBets.js';

const board = { minBet: 10, maxBet: 10_000 };

describe('ladderStakes', () => {
  it('multiplies from the first stake, rounded to the bet step', () => {
    expect(ladderStakes(10, 300, 5, 10)).toEqual([10, 30, 90, 270, 810]);
    // 1.5×: 10, 15→20, 22.5→20, 33.75→30 — each from the first, not the last rounded one.
    expect(ladderStakes(10, 150, 4, 10)).toEqual([10, 20, 20, 30]);
    expect(ladderStakes(10, 150, 4, 1)).toEqual([10, 15, 23, 34]);
    expect(ladderStakes(10, 100, 3, 10)).toEqual([10, 10, 10]);
  });
});

describe('stepOf', () => {
  it('is the losses in a row since the last win, starting again after the last step', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => stepOf(n, 3))).toEqual([0, 1, 2, 0, 1, 2]);
  });
});

describe('stopBefore', () => {
  const base = { stakePaise: 1000, stopLossPaise: 0, takeProfitPaise: 0, budgetPaise: 10_000 };
  it('says nothing while no stop is reached', () => {
    expect(stopBefore({ ...base, netPaise: 0 })).toBeNull();
    expect(stopBefore({ ...base, netPaise: -9_000 })).toBeNull(); // 1,000 left covers the 1,000 stake
  });
  it('stops at the take-profit, the stop-loss and the budget, in that order', () => {
    expect(stopBefore({ ...base, takeProfitPaise: 500, netPaise: 500 })).toBe('TAKE_PROFIT');
    expect(stopBefore({ ...base, stopLossPaise: 2_000, netPaise: -2_000 })).toBe('STOP_LOSS');
    expect(stopBefore({ ...base, stopLossPaise: 2_000, netPaise: -1_990 })).toBeNull();
    expect(stopBefore({ ...base, netPaise: -9_001 })).toBe('BUDGET_USED');
  });
});

describe('stopForRefusal', () => {
  it('stops for what the player must fix, and skips a round for what passes', () => {
    expect(stopForRefusal('STAKE_EXCEEDS_FUNDABLE')).toBe('BALANCE_SHORT');
    expect(stopForRefusal('INSUFFICIENT_BALANCE')).toBe('BALANCE_SHORT');
    expect(stopForRefusal('BOARD_SWITCHED_OFF')).toBe('BOARD_OFF');
    expect(stopForRefusal('WRONG_PROFILE_FOR_CYCLE')).toBe('PROFILE_SWITCHED');
    expect(stopForRefusal('BOARD_RULES_NOT_ACCEPTED')).toBe('RULES_NOT_ACCEPTED');
    expect(stopForRefusal('RISK_VALIDATION')).toBe('STAKE_OUT_OF_RANGE');
    for (const c of ['BETTING_CLOSED', 'OPPOSITE_SIDE_BLOCKED', 'CYCLE_NOT_FOUND', undefined]) expect(stopForRefusal(c)).toBeNull();
  });
  it('every reason has the words a player is shown', () => {
    for (const r of AUTO_STOP_REASONS) expect(AUTO_STOP_TEXT[r]).toBeTruthy();
  });
});

describe('normalisePlan', () => {
  const ok = { side: 'DELHI', start: 10, factor: 2, steps: 3, budget: 1000, stopLoss: '', takeProfit: 200 };
  it('answers the plan in paise with its stakes', () => {
    expect(normalisePlan(ok, board, 10)).toEqual({
      side: 'DELHI', steps: 3, factorX100: 200, startPaise: 1000, stakesPaise: [1000, 2000, 4000],
      budgetPaise: 100_000, stopLossPaise: 0, takeProfitPaise: 20_000,
    });
  });
  it('refuses, naming the first thing wrong', () => {
    const bad = (patch, re) => expect(() => normalisePlan({ ...ok, ...patch }, board, 10)).toThrow(re);
    bad({ side: 'BOTH' }, /Delhi or Bombay/);
    bad({ steps: 13 }, /1 to 12/);
    bad({ steps: 2.5 }, /1 to 12/);
    bad({ factor: 0.5 }, /1 to 10/);
    bad({ factor: 11 }, /1 to 10/);
    bad({ start: 15 }, /multiple of ₹10/);
    bad({ start: 0 }, /smallest bet/);
    bad({ factor: 10, steps: 6 }, /Step 5 would be ₹1,00,000/);
    bad({ budget: undefined }, /Enter a budget/);
    bad({ budget: 5 }, /cover at least the first bet/);
    bad({ stopLoss: -1 }, /stop-loss/);
    bad({ takeProfit: 1.5 }, /take-profit/);
    try { normalisePlan({ ...ok, steps: 0 }, board, 10); } catch (e) { expect(e.status).toBe(400); }
  });
});

describe('autoBetId', () => {
  it('names one bet per plan and round', () => {
    expect(autoBetId('ap_1', 'C9')).toBe('auto_ap_1_C9');
  });
});
