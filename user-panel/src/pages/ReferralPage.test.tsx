// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Refer & Earn shows the bonus the admin set (the server's `levels[].reward`,
 * never a number of its own), the invite tree level by level, and income by
 * level with a total line.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const referrals = vi.fn();
vi.mock('../services/api', () => ({ player: { referrals: () => referrals() } }));
vi.mock('../services/backend.service', () => ({
  getAssetUrl: (u: string) => u,
  getBackend: () => ({ getTelegramSetup: async () => ({ available: true, botUsername: 'bb_bot' }) }),
}));
vi.mock('../redesign/BonusPlayPrompt', () => ({ default: () => null }));
vi.mock('../redesign/Screen', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, card: {}, capLabel: {},
}));

const { default: ReferralPage } = await import('./ReferralPage');

const SUMMARY = {
  success: true, referralCode: 'ALICE1',
  levels: [
    { level: 1, reward: 100, count: 3, confirmed: 300, disbursed: 200, blocked: 0 },
    { level: 2, reward: 40, count: 1, confirmed: 40, disbursed: 0, blocked: 0 },
    { level: 3, reward: 0, count: 0, confirmed: 0, disbursed: 0, blocked: 0 },
  ],
  totals: { referrals: 4, confirmed: 340, disbursed: 200, nextDisbursal: 140, blocked: 0, clicks: 9 },
  rows: [],
};

describe('Refer & Earn', () => {
  it('says the bonus the admin set, not a number of its own', async () => {
    referrals.mockResolvedValue(SUMMARY);
    render(<ReferralPage />);
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toMatch(/₹100 for every friend/);
    expect(document.body.textContent).not.toMatch(/₹25\b/);
  });

  it('draws each level as a branch of the tree, with its bonus and its people', async () => {
    referrals.mockResolvedValue(SUMMARY);
    render(<ReferralPage />);
    const one = await screen.findByTestId('tree-level-1');
    expect(one.textContent).toMatch(/₹100 each/);
    expect(one.textContent).toMatch(/3 people/);
    expect(screen.getByTestId('tree-level-2').textContent).toMatch(/1 person/);
    expect(screen.getByTestId('tree-level-3').textContent).toMatch(/Off/);
  });

  it('lists income by level and totals it', async () => {
    referrals.mockResolvedValue(SUMMARY);
    render(<ReferralPage />);
    const table = within(await screen.findByRole('region', { name: /referral income by level/i })).getByRole('table');
    const total = within(table).getByRole('rowheader', { name: 'Total' }).closest('tr')!;
    expect(total.textContent).toMatch(/4/);
    expect(total.textContent).toMatch(/₹340/);
    expect(total.textContent).toMatch(/₹200/);
    expect(total.textContent).toMatch(/₹140/);
  });
});
