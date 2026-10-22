// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Auto bets sheet (owner, 2026-10-22): it edits the calculator's own
 * ladder inputs, backtests the plan with its stops on the board's past
 * results, starts it with what was typed, and shows a running plan's
 * standing with a Stop that calls the server.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const autoBets = vi.fn();
const startAutoBets = vi.fn();
const stopAutoBets = vi.fn();
vi.mock('../services/api', () => ({
  player: {
    autoBets: (...a: any[]) => autoBets(...a),
    startAutoBets: (...a: any[]) => startAutoBets(...a),
    stopAutoBets: (...a: any[]) => stopAutoBets(...a),
  },
}));
vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getSystemConfig: () => Promise.resolve({ payoutMultiplier: 2, generalPayoutMultiplier: 1.8, winningsFeePercent: 0, betMultipleOf: 10, demoResultsOn: false }) }),
}));

import AutoBetsSheet, { AutoPlan } from './AutoBets';
import ProgressionCalculator from './ProgressionCalculator';
import { updateLadderSettings } from './ladderSettings';
import { Side } from './analytics';

const board: any = { key: '30_MIN', name: '30 Min', minBet: 10, maxBet: 10_000, analyticsWindow: 1440 };
// Newest first; oldest first that is B B D: backing Delhi on 10, 30, 90 wins at step 3.
const winners: Side[] = ['DELHI', 'BOMBAY', 'BOMBAY'];

const running: AutoPlan = {
  planId: 'ap_1', boardKey: '30_MIN', audience: 'VIP', side: 'DELHI', factor: 3, stakes: [10, 30, 90],
  budget: 1000, stopLoss: 200, takeProfit: 0, startedAt: '', stoppedAt: null, running: true,
  stopReason: null, stopText: null, played: 2, won: 0, pending: 0, net: -40, staked: 40,
  step: 2, nextStake: 90, lastBetAt: null,
};

describe('the Auto bets sheet', () => {
  beforeEach(() => {
    autoBets.mockReset(); startAutoBets.mockReset(); stopAutoBets.mockReset();
    updateLadderSettings('VIP', { start: '10', factor: '3', steps: '3', side: 'DELHI', budget: '', stopLoss: '', takeProfit: '' });
  });

  it('asks for a budget, then backtests the plan with its stops and starts it with what was typed', async () => {
    autoBets.mockResolvedValue({ success: true, plans: [] });
    startAutoBets.mockResolvedValue({ success: true });
    render(<AutoBetsSheet board={board} audience="VIP" winners={winners} onClose={() => {}} />);
    await screen.findByLabelText('Total budget (₹)');
    expect(screen.getByRole('alert').textContent).toMatch(/budget/);

    fireEvent.change(screen.getByLabelText('Total budget (₹)'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Stop when down (₹)'), { target: { value: '300' } });
    const stat = (label: string) => screen.getByText(label).parentElement!.children[1].textContent;
    await waitFor(() => expect(stat('Net')).toBe('+₹50'));   // −10 −30 +180 −90
    expect(stat('Lowest point')).toBe('−₹130');
    expect(stat('Stopped')).toBe('No');

    fireEvent.click(screen.getByRole('button', { name: 'Start auto bets on Delhi' }));
    await waitFor(() => expect(startAutoBets).toHaveBeenCalledTimes(1));
    expect(startAutoBets.mock.calls[0][0]).toEqual({
      boardKey: '30_MIN', audience: 'VIP', side: 'DELHI', start: 10, factor: 3, steps: 3, budget: 1000, stopLoss: 300, takeProfit: 0,
    });
  });

  it('shows the stop a past run would have reached', async () => {
    autoBets.mockResolvedValue({ success: true, plans: [] });
    render(<AutoBetsSheet board={board} audience="VIP" winners={winners} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Total budget (₹)'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Stop when down (₹)'), { target: { value: '40' } });
    const stat = (label: string) => screen.getByText(label).parentElement!.children[1].textContent;
    await waitFor(() => expect(stat('Stopped')).toBe('Yes'));
    expect(screen.getByText('stop-loss reached')).toBeTruthy();
  });

  it('refuses a ladder past the board\'s largest bet before asking the server', async () => {
    autoBets.mockResolvedValue({ success: true, plans: [] });
    render(<AutoBetsSheet board={{ ...board, maxBet: 50 }} audience="VIP" winners={winners} onClose={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Total budget (₹)'), { target: { value: '1000' } });
    expect(screen.getByRole('alert').textContent).toMatch(/Step 3 would be ₹90/);
    expect((screen.getByRole('button', { name: 'Start auto bets on Delhi' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shares its inputs with the progression calculator', async () => {
    autoBets.mockResolvedValue({ success: true, plans: [] });
    render(<>
      <ProgressionCalculator board={board} winners={winners} audience="VIP" />
      <AutoBetsSheet board={board} audience="VIP" winners={winners} onClose={() => {}} />
    </>);
    await screen.findByLabelText('Total budget (₹)');
    const steps = screen.getAllByLabelText('Steps') as HTMLInputElement[];
    expect(steps).toHaveLength(2);
    fireEvent.change(steps[0], { target: { value: '4' } });
    expect(steps[1].value).toBe('4');
  });

  it('shows a running plan\'s standing and stops it', async () => {
    autoBets.mockResolvedValue({ success: true, plans: [running] });
    stopAutoBets.mockResolvedValue({ success: true, plan: { ...running, running: false, stopReason: 'PLAYER', stopText: 'You stopped it.' } });
    render(<AutoBetsSheet board={board} audience="VIP" winners={winners} onClose={() => {}} />);
    await screen.findByText(/Running · backing Delhi/);
    const stat = (label: string) => screen.getByText(label).parentElement!.children[1].textContent;
    expect(stat('Net so far')).toBe('−₹40');
    expect(stat('Next bet')).toBe('₹90');
    expect(stat('Budget left')).toBe('₹960');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopAutoBets).toHaveBeenCalledWith('ap_1'));
    await screen.findByText(/You stopped it\./);
  });

  it('keeps a General plan apart from the VIP one', async () => {
    autoBets.mockResolvedValue({ success: true, plans: [running] });
    render(<AutoBetsSheet board={board} audience="GENERAL" winners={winners} onClose={() => {}} />);
    expect(await screen.findByLabelText('Total budget (₹)')).toBeTruthy();
    expect(screen.queryByText(/Running · backing/)).toBeNull();
  });
});
