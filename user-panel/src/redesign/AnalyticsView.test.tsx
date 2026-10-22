// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The analytics are a full page open to everyone (owner, 2026-10-15). A thin
 * board shows its figures with the count beside them rather than a "not
 * enough history" card; Probability alone stays withheld below MIN_SAMPLE.
 * Runs & Gaps opens first and says the past does not predict the next round.
 * The progression calculator sits under every tab (owner, 2026-10-22).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getSystemConfig: () => Promise.resolve({ payoutMultiplier: 2, winningsFeePercent: 0 }) }),
}));

import AnalyticsView from './AnalyticsView';
import { MIN_SAMPLE, Side } from './analytics';
import { updateLadderSettings } from './ladderSettings';

const few: Side[] = ['DELHI', 'BOMBAY', 'BOMBAY', 'DELHI', 'DELHI'];
const lit = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent);

describe('the analytics page body', () => {
  beforeEach(() => updateLadderSettings('VIP', { start: '10', factor: '3', steps: '5', side: 'DELHI' }));

  it('opens on Runs & Gaps, with the line that the past does not predict', () => {
    render(<AnalyticsView winners={few} />);
    expect(lit()).toEqual(['Runs & Gaps']);
    expect(screen.getAllByText(/Past results do not predict the next round/).length).toBeGreaterThan(0);
    expect(screen.getByText('Progression calculator')).toBeTruthy();
  });

  it('shows the tapped section alone, with the calculator under it on every tab', () => {
    render(<AnalyticsView winners={few} />);
    for (const name of ['Win share', 'Previous results', 'Probability']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(lit()).toEqual([name]);
      expect(screen.getByText('Progression calculator')).toBeTruthy();
    }
    expect(screen.getByRole('tabpanel').id).toBe('bb-an-predict');
  });

  it('offers "Run as auto bets" only where a bet can be placed', () => {
    const { unmount } = render(<AnalyticsView winners={few} />);
    expect(screen.queryByRole('button', { name: 'Run as auto bets' })).toBeNull();
    unmount();
    const onAuto = vi.fn();
    render(<AnalyticsView winners={few} onAuto={onAuto} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run as auto bets' }));
    expect(onAuto).toHaveBeenCalledTimes(1);
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

  it('reads newest first, left to right, with the newest result tagged Latest (owner, 2026-10-17)', () => {
    // `few` is newest first: D, then B B, then D D.
    render(<AnalyticsView winners={few} />);
    const strip = screen.getByTestId('run-strip');
    expect(strip.firstElementChild?.textContent).toBe('LATEST');
    const boxes = [...strip.querySelectorAll('span')].filter((el) => el.textContent === 'D' || el.textContent === 'B');
    expect(boxes.map((el) => el.textContent).join('')).toBe('DBBDD');
    expect(boxes[0].hasAttribute('data-latest')).toBe(true);
    expect(strip.querySelectorAll('[data-latest]')).toHaveLength(1);
    expect(screen.getByText('Run strip · newest first')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Previous results' }));
    const road = screen.getByTestId('big-road');
    expect([...road.children].map((el) => el.textContent).join('')).toBe('DBBDD');
    expect(road.firstElementChild?.hasAttribute('data-latest')).toBe(true);
    expect(screen.getAllByTestId('latest-tag').length).toBeGreaterThanOrEqual(2);
  });
});
