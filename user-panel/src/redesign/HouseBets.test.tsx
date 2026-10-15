// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * House bets on the board screen (owner, 2026-10-15): the line beside the
 * totals is the server's, and a phantom agent's auto plan is saved as typed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: api, apiClient: api }));
vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getSystemConfig: () => Promise.resolve({ houseBetsLabel: 'Totals include house bets.' }) }),
}));

const { HouseBetsNote, useHouseBetsLabel, AutoHouseBetsPanel } = await import('./HouseBets');

const Note = () => <HouseBetsNote label={useHouseBetsLabel()} />;

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({
    success: true,
    plans: [
      { boardKey: 'b1', audience: 'VIP', side: 'DELHI', amounts: [100, 200], enabled: true },
      { boardKey: 'b1', audience: 'GENERAL', side: 'BOMBAY', amounts: [9], enabled: true },
    ],
    limits: { maxSteps: 1000, minRupees: 1, maxRupees: 10000000 },
  });
  api.put.mockReset().mockImplementation(async (_p: string, body: any) => ({ success: true, plan: body }));
});

describe('house bets', () => {
  it('shows the server\'s line beside the totals', async () => {
    render(<Note />);
    const chip = await screen.findByTestId('house-bets-note');
    expect(chip).toHaveTextContent('incl. house');
    expect(within(chip).getByRole('button')).toHaveAttribute('title', 'Totals include house bets.');
    fireEvent.click(within(chip).getByRole('button'));
    expect(within(chip).getByRole('note')).toHaveTextContent('Totals include house bets.');
  });

  it('loads a plan, and saves the sizes as typed with the side, board and audience', async () => {
    render(<AutoHouseBetsPanel boardKey="b1" boardName="Board One" audience="VIP" />);
    const delhi = await screen.findByLabelText(/Delhi · ON/);
    expect((delhi as HTMLTextAreaElement).value).toBe('100, 200');

    const bombay = screen.getByLabelText(/Bombay · OFF/);
    fireEvent.change(bombay, { target: { value: '50 75,  25' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Start' })[0]);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/bet/phantom/auto',
      { boardKey: 'b1', audience: 'VIP', side: 'BOMBAY', amounts: [50, 75, 25], enabled: true }));
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('shows only the plans of the profile being played', async () => {
    render(<AutoHouseBetsPanel boardKey="b1" boardName="Board One" audience="GENERAL" />);
    expect(await screen.findByText(/General rounds/)).toBeTruthy();
    expect(((await screen.findByLabelText(/Bombay · ON/)) as HTMLTextAreaElement).value).toBe('9');
    expect(((screen.getByLabelText(/Delhi · OFF/)) as HTMLTextAreaElement).value).toBe('');
  });

  it('refuses a size that is not whole rupees before asking the server', async () => {
    render(<AutoHouseBetsPanel boardKey="b1" boardName="Board One" audience="VIP" />);
    const bombay = await screen.findByLabelText(/Bombay · OFF/);
    fireEvent.change(bombay, { target: { value: '50, 2.5' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Start' })[0]);
    expect((await screen.findByRole('alert')).textContent).toMatch(/whole rupees/);
    expect(api.put).not.toHaveBeenCalled();
  });
});
