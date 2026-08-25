// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The maximum we SHOW is the maximum the engine ACCEPTS.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 * The wallet showed one total and the bet route pre-checked against
 * deposit+winnings+reserve. The reserve is not freely spendable — only
 * `reservePercent` of a stake may come from it — so a player with ₹100 deposit,
 * ₹100 winnings and ₹800 reserve was told "₹1,000 available", tried ₹500, and
 * was refused with "Insufficient balance. Available: ₹1000". Told they had the
 * money, while being refused it.
 *
 * ── Why this is a property test ─────────────────────────────────────────────
 * A handful of examples would pass against an off-by-one at the boundary, and
 * the boundary IS the number shown to the player. So the relationship is
 * asserted directly, over hundreds of generated balance/percent combinations:
 *
 *     computeBetFundingPlan SUCCEEDS at exactly computeMaxStake()
 *     computeBetFundingPlan THROWS   at exactly one paise more
 *
 * That is the only property that matters, and it cannot hold by accident.
 */
import { describe, it, expect } from 'vitest';
import { computeBetFundingPlan, computeMaxStake } from '../../domains/risk/riskValidation.service.js';

/** Deterministic PRNG — a failure must be reproducible, not "sometimes red". */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const plans = (amount, bal, pct) => computeBetFundingPlan({
  amount,
  reservePercent: pct,
  availableDeposit: bal.dep,
  availableWinnings: bal.win,
  availableReserve: bal.res,
});

const maxOf = (bal, pct) => computeMaxStake({
  reservePercent: pct,
  availableDeposit: bal.dep,
  availableWinnings: bal.win,
  availableReserve: bal.res,
});

describe('the reported maximum is exactly the fundable maximum', () => {
  it('holds across 600 random balance and percent combinations', () => {
    const rand = rng(20260825);
    let checked = 0;
    let nonTrivial = 0;

    for (let i = 0; i < 600; i += 1) {
      const bal = {
        dep: Math.round(rand() * 50000) / 100,
        win: Math.round(rand() * 50000) / 100,
        res: Math.round(rand() * 200000) / 100,
      };
      const pct = Math.round(rand() * 10000) / 100; // 0.00 – 100.00

      const { maxStake, maxStakeMinor } = maxOf(bal, pct);
      expect(Number.isFinite(maxStake)).toBe(true);
      expect(maxStakeMinor).toBeGreaterThanOrEqual(0);

      // The maximum must be fundable...
      if (maxStakeMinor > 0) {
        nonTrivial += 1;
        expect(() => plans(maxStake, bal, pct), `max ${maxStake} @ ${pct}% of ${JSON.stringify(bal)}`).not.toThrow();

        const plan = plans(maxStake, bal, pct);
        const paid = plan.fromDepositMinor + plan.fromWinningsMinor + plan.fromReserveMinor;
        expect(paid, 'the split must conserve the stake exactly').toBe(maxStakeMinor);
      }

      // ...and one paise more must not be.
      const overMinor = maxStakeMinor + 1;
      const totalMinor = Math.round(bal.dep * 100) + Math.round(bal.win * 100) + Math.round(bal.res * 100);
      if (overMinor <= totalMinor) {
        expect(() => plans(overMinor / 100, bal, pct),
          `${overMinor / 100} should exceed the max ${maxStake} @ ${pct}%`).toThrow();
      }
      checked += 1;
    }

    expect(checked).toBe(600);
    // Guard against the suite silently degenerating into "everything was zero".
    expect(nonTrivial).toBeGreaterThan(500);
  });
});

describe('the case from the report', () => {
  const bal = { dep: 100, win: 100, res: 800 };

  it('is ₹202.02 at the 1% default, not the ₹1,000 the wallet showed', () => {
    // 0.99 × 202.02 = 200.00 exactly — the deposit and winnings pockets, drained.
    // The remaining ₹800 of reserve is unreachable without more deposit.
    expect(maxOf(bal, 1).maxStake).toBe(202.02);
  });

  it('splits a ₹200 stake 100/98/2 — the owner rule, exactly', () => {
    // "if a bet is placed of 200 then 198 will be from deposit and winnings and
    // 2 will be from reserve." Deposit is drained first, winnings covers the
    // overflow, and the reserve contributes its 1%.
    const p = plans(200, bal, 1);
    expect(p.fromDeposit).toBe(100);
    expect(p.fromWinnings).toBe(98);
    expect(p.fromReserve).toBe(2);
  });

  it('refuses the ₹500 bet the old total implied was affordable', () => {
    expect(() => plans(500, bal, 1)).toThrow(/Insufficient/);
  });

  it('rises when the reserve share rises, because reserve becomes more usable', () => {
    // Sanity on the direction: a bigger reserve percentage lets a bigger stake
    // lean on the reserve, so the ceiling goes UP, not down.
    expect(maxOf(bal, 10).maxStake).toBeGreaterThan(maxOf(bal, 1).maxStake);
    expect(maxOf(bal, 50).maxStake).toBeGreaterThan(maxOf(bal, 10).maxStake);
  });
});

describe('the edges', () => {
  it('is the main balance when the reserve share is zero', () => {
    // At 0% nothing may come from reserve, so a ₹800 reserve is worth nothing
    // to a bettor.
    expect(maxOf({ dep: 100, win: 100, res: 800 }, 0).maxStake).toBe(200);
  });

  it('is zero when deposit and winnings are empty', () => {
    // Reserve alone cannot fund a bet at any percent below 100 — the main leg
    // has nothing to draw on.
    expect(maxOf({ dep: 0, win: 0, res: 800 }, 3).maxStake).toBe(0);
  });

  it('is the whole balance when the reserve share is 100%', () => {
    expect(maxOf({ dep: 100, win: 100, res: 800 }, 100).maxStake).toBe(1000);
  });

  it('is zero on an empty wallet', () => {
    expect(maxOf({ dep: 0, win: 0, res: 0 }, 3).maxStake).toBe(0);
  });

  it('treats negative balances as zero rather than as credit', () => {
    expect(maxOf({ dep: -50, win: 100, res: 0 }, 3).maxStake).toBe(100);
  });

  it('refuses a percent outside 0–100', () => {
    for (const bad of [-1, 101, NaN, Infinity, '3']) {
      expect(() => computeMaxStake({
        reservePercent: bad, availableDeposit: 1, availableWinnings: 1, availableReserve: 1,
      })).toThrow();
    }
  });
});
