// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The wallet's Bonuses tab — `GET /api/bonuses/my`, which was built and called
 * by no screen (route coverage, 2026-10-01; owner: wire it).
 *
 * What a record carries is the SERVER's choice (`toPlayerBonus` in
 * backend/domains/wallet/playerLedgerView.js): a label, an amount, a date —
 * never the admin's note, which the server no longer sends. This file asserts
 * the screen renders what it is given, says so when the load fails rather than
 * showing "no bonuses", and pages.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { get, post: vi.fn() } }));

import WalletPage from './WalletPage';

const record = (n: number) => ({
  bonusId: `adj_${n}`, type: 'ADMIN_CREDIT', label: 'Credited by support',
  amount: 100 + n, createdAt: '2026-10-01T09:00:00.000Z',
});

const routes = (bonuses: (url: string) => Promise<unknown>) => (url: string) => {
  if (url.startsWith('/api/bonuses/my')) return bonuses(url);
  if (url.startsWith('/api/payment/orders')) return Promise.resolve({ orders: [] });
  if (url.startsWith('/api/v1/wallet/ledger')) return Promise.resolve({ entries: [], total: 0 });
  return Promise.resolve({ success: true });
};

beforeEach(() => { get.mockReset(); });

const openBonuses = async () => {
  render(<WalletPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Bonuses' }));
  return screen.findByLabelText('Bonuses');
};

describe('the wallet Bonuses tab', () => {
  it('lists support credits with their label and amount', async () => {
    get.mockImplementation(routes(() => Promise.resolve({ success: true, total: 1, page: 1, records: [record(1)] })));
    const panel = await openBonuses();
    expect(await within(panel).findByText('Credited by support')).toBeInTheDocument();
    expect(within(panel).getByText(/101/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/bonuses/my?page=1&limit=25');
  });

  it('says there are none when there are none', async () => {
    get.mockImplementation(routes(() => Promise.resolve({ success: true, total: 0, page: 1, records: [] })));
    const panel = await openBonuses();
    expect(await within(panel).findByText('No bonuses yet')).toBeInTheDocument();
  });

  it('says the load FAILED rather than that there are none, and can try again', async () => {
    let calls = 0;
    get.mockImplementation(routes(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ success: true, total: 1, records: [record(2)] });
    }));
    const panel = await openBonuses();
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your bonuses.');
    expect(within(panel).queryByText('No bonuses yet')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(panel).findByText('Credited by support')).toBeInTheDocument();
  });

  it('pages: Load more asks for the next page and appends it', async () => {
    const first = Array.from({ length: 25 }, (_, i) => record(i));
    get.mockImplementation(routes((url) => Promise.resolve(
      url.includes('page=1') ? { success: true, total: 26, records: first } : { success: true, total: 26, records: [record(99)] },
    )));
    const panel = await openBonuses();
    fireEvent.click(await within(panel).findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/bonuses/my?page=2&limit=25'));
    expect(await within(panel).findByText(/199/)).toBeInTheDocument();
    expect(within(panel).getAllByText('Credited by support')).toHaveLength(26);
    expect(within(panel).queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
