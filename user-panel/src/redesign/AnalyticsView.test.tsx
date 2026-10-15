// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The analytics are a full page open to everyone (owner, 2026-10-15). A thin
 * board shows its figures with the count beside them rather than a "not
 * enough history" card; Probability alone stays withheld below MIN_SAMPLE.
 * Runs & Gaps opens first and says the past does not predict the next round.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getSystemConfig: () => Promise.resolve({ payoutMultiplier: 2, winningsFeePercent: 0 }) }),
}));

import AnalyticsView from './AnalyticsView';
import { MIN_SAMPLE, Side } from './analytics';

const few: Side[] = ['DELHI', 'BOMBAY', 'BOMBAY', 'DELHI', 'DELHI'];
const lit = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);

describe('the analytics page body', () => {
  it('opens on Runs & Gaps, with the line that the past does not predict', () => {
    render(<AnalyticsView winners={few} />);
    expect(lit()).toEqual(['Runs & Gaps']);
    expect(screen.getAllByText(/Past results do not predict the next round/).length).toBeGreaterThan(0);
    expect(screen.getByText('Progression calculator')).toBeTruthy();
  });

  it('shows the tapped section alone', () => {
    render(<AnalyticsView winners={few} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Win share' }));
    expect(lit()).toEqual(['Win share']);
    expect(screen.getByRole('tabpanel').id).toBe('bb-an-share');
    expect(screen.queryByText('Progression calculator')).toBeNull();
  });

  it('does not lock the streaks behind a minimum: a thin board shows them with its count', () => {
    render(<AnalyticsView winners={few} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Continuous streaks' }));
    expect(screen.getByText('Streaks that reached each length')).toBeTruthy();
    expect(screen.getByText(/Based on 5 results so far/)).toBeTruthy();
    expect(screen.queryByText('Not enough history yet')).toBeNull();
  });

  it('still withholds Probability below MIN_SAMPLE', () => {
    render(<AnalyticsView winners={few} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Probability' }));
    expect(screen.getByText(`Shown from ${MIN_SAMPLE} results`)).toBeTruthy();
    expect(screen.queryByText('Historical next-winner signal')).toBeNull();
  });

  it('shows the ladder for 10 × 3 and how often it ran out', async () => {
    // Five Bombay wins in a row while backing Delhi: a five-step ladder runs out once.
    const seq: Side[] = ['BOMBAY', 'BOMBAY', 'BOMBAY', 'BOMBAY', 'BOMBAY'];
    render(<AnalyticsView winners={seq} />);
    const ladder = screen.getByLabelText('The ladder');
    expect([...ladder.children].map((c) => c.textContent)).toEqual(['#1₹10', '#2₹30', '#3₹90', '#4₹270', '#5₹810']);
    const stat = (label: string) => screen.getByText(label).parentElement!.children[1].textContent;
    expect(stat('Total at risk')).toBe('₹1,210');
    await screen.findAllByText('₹410');
    expect(stat('Profit if the last step wins')).toBe('₹410');
    expect(stat('Times it ran out')).toBe('1');
  });

  it('refuses a ladder it cannot draw and says why', () => {
    render(<AnalyticsView winners={few} />);
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '40' } });
    expect(screen.getByRole('alert').textContent).toMatch(/between 1 and 12 steps/);
  });
});
