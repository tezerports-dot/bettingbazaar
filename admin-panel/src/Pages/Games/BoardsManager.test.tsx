// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Boards page calls the routes it shows (§28): create sends the timer kind,
 * edit never sends the key or kind, the arrows send the WHOLE order, the switch
 * sends `enabled`, and a refusal shows the server's sentence as an alert (S44).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), setOrder: vi.fn(),
}));
vi.mock('../../services/api', () => ({ boards: api }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import BoardsManager from './BoardsManager';

const phases = { mergeBeforeEndSec: 180, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 };
const BOARDS = [
  { key: 'FULL_DAY', name: 'Full day', kind: 'DAILY', durationMin: 1440, anchorHourIst: 18, phases, minBet: 100, maxBet: 500000, idPrefix: 'FULLDAY', enabled: true, homeOrder: 0 },
  { key: '30_MIN', name: '30 min', kind: 'INTERVAL', durationMin: 30, anchorHourIst: null, phases, minBet: 10, maxBet: 100000, idPrefix: '30MIN', enabled: true, homeOrder: 1 },
];

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.list.mockResolvedValue({ success: true, boards: BOARDS, intervalMinutes: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60] });
  api.update.mockResolvedValue({ success: true });
  api.setOrder.mockResolvedValue({ success: true, boards: [BOARDS[1], BOARDS[0]] });
});

describe('BoardsManager', () => {
  it('creates a repeating board with the length chosen from the server\'s list', async () => {
    api.create.mockResolvedValue({ success: true });
    render(<BoardsManager />);
    await screen.findByText('Full day');
    await userEvent.click(screen.getByRole('button', { name: /New board/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'Quick five');
    await userEvent.selectOptions(screen.getByLabelText('Round length'), '15');
    await userEvent.click(screen.getByRole('button', { name: /Create board/ }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0][0]).toMatchObject({ name: 'Quick five', kind: 'INTERVAL', durationMin: 15, minBet: 10 });
  });

  it('shows the server\'s refusal as an alert, and keeps the form open', async () => {
    api.create.mockRejectedValue({ response: { data: { message: 'The minimum bet cannot be above the maximum bet.' } } });
    render(<BoardsManager />);
    await screen.findByText('Full day');
    await userEvent.click(screen.getByRole('button', { name: /New board/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'Bad');
    await userEvent.click(screen.getByRole('button', { name: /Create board/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/minimum bet cannot be above/);
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('edits a board without sending its key or timer kind', async () => {
    api.update.mockResolvedValue({ success: true });
    render(<BoardsManager />);
    await screen.findByText('30 min');
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
    const min = screen.getByLabelText('Minimum bet (₹)');
    await userEvent.clear(min);
    await userEvent.type(min, '20');
    await userEvent.click(screen.getByRole('button', { name: /Save board/ }));
    await waitFor(() => expect(api.update).toHaveBeenCalled());
    const [key, body] = api.update.mock.calls[0];
    expect(key).toBe('30_MIN');
    expect(body).toMatchObject({ minBet: 20 });
    expect(body).not.toHaveProperty('kind');
    expect(body).not.toHaveProperty('key');
  });

  it('sends the whole order when a board moves, and switches a board off', async () => {
    render(<BoardsManager />);
    await screen.findByText('Full day');
    await userEvent.click(screen.getByRole('button', { name: 'Move Full day down' }));
    await waitFor(() => expect(api.setOrder).toHaveBeenCalledWith(['30_MIN', 'FULL_DAY']));

    await userEvent.click(screen.getByRole('button', { name: 'Switch 30 min off' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('30_MIN', { enabled: false }));
  });
});
