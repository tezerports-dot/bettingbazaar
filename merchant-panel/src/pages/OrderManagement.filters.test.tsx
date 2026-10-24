// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Orders (owner, 2026-10-24): no count tiles on top; one filter row, All,
 * Deposits, Withdrawals, Processing (still being worked: PROCESSING or PAID)
 * and Disputed, each showing exactly the orders it names.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/AuthContext', () => ({
  useAuth: () => ({ merchant: { id: 'm-1', merchantId: 'm-1', isOnline: true }, refreshProfile: vi.fn() }),
}));
vi.mock('../services/api', () => ({ api: {} }));
vi.mock('../hooks/useMerchantAccount', () => ({ useMerchantAccount: () => ({ overview: null, reload: vi.fn() }) }));
const order = (o: Record<string, unknown>) => ({
  _id: String(o.orderId), tokenAmount: 1_000, fiatAmount: 1_000, amount: 1_000, currency: 'INR', paymentMode: 'P2P_UPI',
  expiresAt: new Date(Date.now() + 600_000).toISOString(), createdAt: new Date().toISOString(), ...o,
});
const ORDERS = [
  order({ orderId: 'BUY-PAID', type: 'DEPOSIT', status: 'PAID', utrNumber: 'UTR123456789' }),
  order({ orderId: 'SELL-OPEN', type: 'WITHDRAWAL', status: 'PROCESSING' }),
  order({ orderId: 'BUY-DONE', type: 'DEPOSIT', status: 'COMPLETED', utrNumber: 'UTR999999999' }),
  order({ orderId: 'IN-DISPUTE', type: 'WITHDRAWAL', status: 'DISPUTED' }),
];
vi.mock('../hooks/useOrders', async (actual) => ({
  ...(await actual<typeof import('../hooks/useOrders')>()),
  useOrders: () => ({ orders: ORDERS, state: 'ready', counts: {}, reload: vi.fn() }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import OrderManagement from './OrderManagement';

const shown = () => screen.getAllByTestId('order-row').map((row) => row.querySelector('button')!.getAttribute('aria-label'));

describe('the Orders filter row', () => {
  it('has no count tiles, and each filter shows the orders it names', () => {
    render(<MemoryRouter><OrderManagement /></MemoryRouter>);
    expect(screen.queryByText('Needs you')).toBeNull();
    expect(shown()).toHaveLength(4);

    fireEvent.click(screen.getByRole('button', { name: 'Deposits' }));
    expect(shown()).toEqual(['Open deposit BUY-PAID', 'Open deposit BUY-DONE']);

    fireEvent.click(screen.getByRole('button', { name: 'Processing' }));
    expect(shown()).toEqual(['Open deposit BUY-PAID', 'Open withdrawal SELL-OPEN']);

    fireEvent.click(screen.getByRole('button', { name: 'Disputed' }));
    expect(shown()).toEqual(['Open withdrawal IN-DISPUTE']);
  });
});
