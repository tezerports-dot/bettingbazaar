// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Home's orders card (owner, 2026-10-21): open buys, open sells, those in
 * process and the disputed ones, each a tab with its count, approved or
 * rejected in place with the same controls as Orders (`OrderWorkList`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/AuthContext', () => ({
  useAuth: () => ({ merchant: { id: 'm-1', merchantId: 'm-1', isOnline: true }, refreshProfile: vi.fn() }),
}));
vi.mock('../services/api', () => ({
  api: {
    getStats: vi.fn(async () => ({})),
    getEarnings: vi.fn().mockResolvedValue({ earnings: null }),
    getWeeklyEarnings: vi.fn().mockResolvedValue({ weekly: [] }),
    getBusinessLedger: vi.fn().mockRejectedValue(new Error('not in this test')),
    toggleOnlineStatus: vi.fn(),
  },
}));
const order = (o: Record<string, unknown>) => ({
  _id: String(o.orderId), tokenAmount: 1_000, fiatAmount: 1_000, amount: 1_000, currency: 'INR',
  expiresAt: new Date(Date.now() + 600_000).toISOString(), createdAt: new Date().toISOString(), ...o,
});
const ORDERS = [
  order({ orderId: 'BUY-PAID', type: 'DEPOSIT', status: 'PAID', paymentMode: 'P2P_UPI', utrNumber: 'UTR123456789' }),
  order({ orderId: 'SELL-OPEN', type: 'WITHDRAWAL', status: 'PROCESSING', paymentMode: 'P2P_UPI' }),
  order({ orderId: 'BUY-WAITING', type: 'DEPOSIT', status: 'PROCESSING', paymentMode: 'P2P_UPI' }),
  order({ orderId: 'IN-DISPUTE', type: 'WITHDRAWAL', status: 'DISPUTED', paymentMode: 'P2P_UPI', tokenAmount: 5_000 }),
];
vi.mock('../hooks/useOrders', async (actual) => ({
  ...(await actual<typeof import('../hooks/useOrders')>()),
  useOrders: () => ({ orders: ORDERS, state: 'ready', counts: {}, reload: vi.fn() }),
}));
vi.mock('../components/CashReadyCard', () => ({ CashReadyCard: () => null }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import Dashboard from './Dashboard';

describe('the orders on Home', () => {
  it('sorts the orders into four tabs with their counts', async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    for (const label of ['Open buys (1)', 'Open sells (1)', 'In process (1)', 'Disputed (1)']) {
      expect(await screen.findByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('approves or rejects a paid buy in place', async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    // The Open buys tab is shown first and holds this one order.
    expect(await screen.findByRole('button', { name: /Open deposit BUY-PAID/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payment arrived: confirm and release' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payment not received: reject' })).toBeInTheDocument();
  });

  it('a sell to pay, one in process and one in dispute each sit in their own tab', async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open sells (1)' }));
    expect(screen.getByRole('button', { name: /Open withdrawal SELL-OPEN/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payout sent: mark paid' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'In process (1)' }));
    expect(screen.getByRole('button', { name: /Open deposit BUY-WAITING/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disputed (1)' }));
    expect(screen.getByRole('button', { name: /Open withdrawal IN-DISPUTE/ })).toBeInTheDocument();
  });
});
