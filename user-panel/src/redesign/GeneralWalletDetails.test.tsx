// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { unlockPlan, GeneralWithdrawable, GeneralBonusList, GeneralHowItWorks } from './GeneralWalletDetails';
import type { GeneralSummary } from './ProfileSwitch';

const base = (over: Partial<GeneralSummary>): GeneralSummary => ({
  profile: 'GENERAL', promoBalance: 0, outstandingTurnover: 0, turnoverMultiplier: 10, grants: [], ...over,
});

describe('unlockPlan (mirror of promo.js recordTurnoverWithin)', () => {
  it('one open bonus: finishing it moves the whole General balance', () => {
    const p = unlockPlan(base({
      promoBalance: 180, outstandingTurnover: 600,
      grants: [{ grantId: 'fdb_1', source: 'FIRST_DEPOSIT', amount: 100, requiredTurnover: 1000, turnover: 400, createdAt: '2026-10-15T00:00:00Z' }],
    }));
    expect(p.withdrawableNow).toBe(0);
    expect(p.next).toEqual({ label: 'First deposit bonus', playLeft: 600, unlocks: 180 });
  });

  it('two open bonuses: the OLDEST counts first and moves only its own amount', () => {
    const p = unlockPlan(base({
      promoBalance: 180, outstandingTurnover: 1500,
      grants: [
        { grantId: 'b', source: 'REFERRAL', amount: 50, requiredTurnover: 500, turnover: 0, createdAt: '2026-10-15T02:00:00Z' },
        { grantId: 'a', source: 'FIRST_DEPOSIT', amount: 100, requiredTurnover: 1000, turnover: 0, createdAt: '2026-10-15T01:00:00Z' },
      ],
    }));
    expect(p.next).toEqual({ label: 'First deposit bonus', playLeft: 1000, unlocks: 100 });
    expect(p.playLeftForAll).toBe(1500);
  });

  it('a bonus larger than what General holds moves only what is there', () => {
    const p = unlockPlan(base({
      promoBalance: 30, outstandingTurnover: 1500,
      grants: [
        { grantId: 'a', source: 'REFERRAL', amount: 100, requiredTurnover: 1000, turnover: 0, createdAt: '1' },
        { grantId: 'b', source: 'REFERRAL', amount: 50, requiredTurnover: 500, turnover: 0, createdAt: '2' },
      ],
    }));
    expect(p.next?.unlocks).toBe(30);
  });

  it('nothing open: nothing next; unlocked so far adds every bonus', () => {
    const p = unlockPlan(base({
      grants: [
        { source: 'REFERRAL', amount: 25, requiredTurnover: 250, turnover: 250, completedAt: 'x', unlocked: 25 },
        { source: 'FIRST_DEPOSIT', amount: 100, requiredTurnover: 1000, turnover: 1000, completedAt: 'y', unlocked: 100 },
      ],
    }));
    expect(p.next).toBeNull();
    expect(p.unlockedSoFar).toBe(125);
  });
});

describe('General wallet screen', () => {
  it('says plainly what is withdrawable now and what unlocks next', () => {
    render(<GeneralWithdrawable general={base({
      promoBalance: 100, outstandingTurnover: 1000,
      grants: [{ source: 'FIRST_DEPOSIT', amount: 100, requiredTurnover: 1000, turnover: 0 }],
    })} />);
    expect(screen.getByText('Withdrawable now')).toBeTruthy();
    expect(screen.getByText('₹0')).toBeTruthy();
    expect(screen.getByText(/after ₹1,000 more is bet from General \(first deposit bonus\)/)).toBeTruthy();
  });

  it('names each bonus by where it came from', () => {
    render(<GeneralBonusList general={base({ grants: [
      { grantId: '1', source: 'FIRST_DEPOSIT', amount: 100, requiredTurnover: 1000, turnover: 250 },
      { grantId: '2', source: 'REFERRAL', amount: 25, requiredTurnover: 250, turnover: 250, completedAt: 'x', unlocked: 25 },
    ] })} />);
    expect(screen.getByText(/First deposit bonus · ₹100/)).toBeTruthy();
    expect(screen.getByText(/Referral bonus · ₹25/)).toBeTruthy();
    expect(screen.getByText('Unlocked ₹25')).toBeTruthy();
  });

  it('the worked example uses the admin multiplier', () => {
    render(<GeneralHowItWorks multiplier={10} />);
    fireEvent.click(screen.getByRole('button', { name: /How General works/ }));
    expect(screen.getByText(/Every bonus has the same 10× rule/)).toBeTruthy();
    expect(screen.getByText(/you bet ₹1,000 in total \(10 × ₹100\)/)).toBeTruthy();
  });
});
