// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Admin › USDT Deposits: the list is the server's (its filters, its figures),
 * and the two things an admin does (mark money handled, record a sweep) call
 * their routes and say so when they are refused.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { usdtDeposits } = vi.hoisted(() => ({
  usdtDeposits: {
    list: vi.fn(), transfers: vi.fn(), markHandled: vi.fn(), recordSweep: vi.fn(),
    recordSweeps: vi.fn(), downloadSweepFile: vi.fn(),
  },
}));
vi.mock('../../services/api', () => ({ default: { usdtDeposits } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { UsdtDeposits } from './UsdtDeposits';

const LATE = {
  orderId: 'ORD-LATE', userId: 'u1', username: 'asha', address: `0x${'a'.repeat(40)}`, derivationIndex: 4, keyId: 'ab'.repeat(8),
  state: 'CANCELLED', createdAt: '2026-10-18T05:00:00Z', expiresAt: '2026-10-18T06:00:00Z', creditedAt: null,
  usdtRequired: 100, usdtReceived: 100, tokens: 9000, transfers: 1, lastSeenAt: '2026-10-18T07:00:00Z',
  attention: 'LATE', sweptAt: null, sweptTxHash: null, sweptBy: null,
};
const page = (over: Record<string, unknown> = {}) => ({
  success: true, filters: ['ALL', 'WAITING', 'ATTENTION', 'UNSWEPT'], filter: 'ATTENTION', total: 1, page: 1, pages: 1,
  deposits: [LATE],
  totals: { waiting: 2, credited: 5, creditedTokens: 45000, usdtReceived: 600, usdtUnswept: 100 },
  watcher: { configured: true, activeKeyId: '7b2f9c1d0e4a5b68', nextBlock: 101, headBlock: 120, lastOkAt: '2026-10-18T07:00:00Z', lastError: null, lastErrorAt: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  usdtDeposits.list.mockResolvedValue(page());
  usdtDeposits.transfers.mockResolvedValue({ success: true, transfers: [{
    txHash: `0x${'1'.repeat(64)}`, logIndex: 0, from: `0x${'2'.repeat(40)}`, usdt: 100, blockNumber: 99,
    orderStateAtArrival: 'CANCELLED', seenAt: '2026-10-18T07:00:00Z', handledAt: null, handledBy: null, handledNote: null,
  }] });
});

describe('USDT Deposits', () => {
  it('opens on what needs a person, with the server’s totals and the watcher', async () => {
    render(<UsdtDeposits />);
    expect(await screen.findByText('ORD-LATE')).toBeInTheDocument();
    expect(usdtDeposits.list).toHaveBeenCalledWith('ATTENTION', 1, 50);
    expect(screen.getByText('Arrived after the order closed')).toBeInTheDocument();
    expect(screen.getByText('USDT not swept').parentElement).toHaveTextContent('100 USDT');
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(/up to block 101 of 120/);
    // Which key new addresses come from, so a key change can be seen to have taken.
    expect(screen.getByText('7b2f9c1d0e4a5b68')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not swept' }));
    await waitFor(() => expect(usdtDeposits.list).toHaveBeenLastCalledWith('UNSWEPT', 1, 50));
  });

  it('says plainly when the server is not set up for USDT', async () => {
    usdtDeposits.list.mockResolvedValue(page({ watcher: { configured: false, activeKeyId: null, nextBlock: null, headBlock: null, lastOkAt: null, lastError: null, lastErrorAt: null } }));
    render(<UsdtDeposits />);
    expect(await screen.findByText(/no USDT_BEP20_XPUB or BSC_RPC_URL/)).toBeInTheDocument();
  });

  it('marks late money handled with the note typed, and shows a refusal', async () => {
    usdtDeposits.markHandled.mockRejectedValueOnce({ response: { data: { message: 'Nothing to mark on this order.' } } });
    render(<UsdtDeposits />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    fireEvent.change(await screen.findByLabelText(/What was done with this money/), { target: { value: 'Refunded to sender' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing to mark on this order.');
    expect(usdtDeposits.markHandled).toHaveBeenCalledWith('ORD-LATE', 'Refunded to sender');
  });

  it('records one sweep, and the sweep tool’s results file', async () => {
    usdtDeposits.recordSweep.mockResolvedValue({ success: true });
    usdtDeposits.recordSweeps.mockResolvedValue({ success: true, recorded: 1, results: [{ orderId: 'ORD-LATE', recorded: true, reason: null }] });
    render(<UsdtDeposits />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const hash = `0x${'3'.repeat(64)}`;
    fireEvent.change(await screen.findByLabelText('Sweep transaction hash'), { target: { value: hash } });
    fireEvent.click(screen.getByRole('button', { name: 'Record sweep' }));
    await waitFor(() => expect(usdtDeposits.recordSweep).toHaveBeenCalledWith('ORD-LATE', hash));

    fireEvent.change(screen.getByLabelText(/Sweep results/), { target: { value: `orderId,txHash\nORD-LATE,${hash}` } });
    fireEvent.click(screen.getByRole('button', { name: 'Record results' }));
    expect(await screen.findByText('1 recorded.')).toBeInTheDocument();
  });
});
