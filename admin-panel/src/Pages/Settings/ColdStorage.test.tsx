// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** Cold Storage: lists the server's entries without rows, and opens one on demand. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const cold = vi.hoisted(() => ({ list: vi.fn(), open: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { coldStorage: cold } }));

import ColdStorage from './ColdStorage';

const PAGE = {
  kinds: ['CYCLE', 'CHAT', 'NOTIFICATION'], coldAfterDays: 30,
  totals: { CYCLE: { entries: 1, rows: 2 }, CHAT: { entries: 0, rows: 0 }, NOTIFICATION: { entries: 0, rows: 0 } },
  entries: [{ id: 7, kind: 'CYCLE', ref: '30MIN-VIP-1', firstAt: '2026-09-01T00:00:00Z', lastAt: '2026-09-01T00:30:00Z', rowCount: 2, archivedAt: '2026-10-21T00:00:00Z' }],
};

beforeEach(() => {
  cold.list.mockReset().mockResolvedValue(PAGE);
  cold.open.mockReset().mockResolvedValue({ ...PAGE.entries[0], rows: [{ table: 'cycles', row: { cycle_id: '30MIN-VIP-1', winner: 'DELHI' } }] });
});

describe('Cold Storage', () => {
  it('shows the entries and the server\'s day count, and opens one only when asked', async () => {
    render(<ColdStorage />);
    expect(await screen.findByText('30MIN-VIP-1')).toBeInTheDocument();
    expect(screen.getByText(/older than 30 days/)).toBeInTheDocument();
    expect(cold.open).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Open entry' }));
    expect(await screen.findByText(/"winner": "DELHI"/)).toBeInTheDocument();
    expect(cold.open).toHaveBeenCalledWith(7);
  });

  it('searches by exact id', async () => {
    render(<ColdStorage />);
    await screen.findByText('30MIN-VIP-1');
    await userEvent.type(screen.getByLabelText(/Round, order or player id/), '30MIN-VIP-1');
    await userEvent.click(screen.getByRole('button', { name: /Find/ }));
    expect(cold.list).toHaveBeenLastCalledWith({ kind: undefined, ref: '30MIN-VIP-1', offset: 0 });
  });
});
