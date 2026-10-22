// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Profile (owner, 2026-10-22): a merchant account keeps its payment details on
 * Account › Payment accounts, so Profile offers it no payment-details form;
 * an agent, whose buys are paid into their own bank account or UPI ID, still
 * has it. The figures are the server's, counted from the order rows, with the
 * success rate here rather than on Home.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const auth = vi.hoisted(() => ({ merchant: null as Record<string, unknown> | null }));
vi.mock('../services/AuthContext', () => ({
  useAuth: () => ({ merchant: auth.merchant, refreshProfile: vi.fn(), logout: vi.fn() }),
}));
vi.mock('../services/api', () => ({ api: { updatePreferences: vi.fn(), updateProfile: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import ProfileSettings from './ProfileSettings';

const show = (merchant: Record<string, unknown>) => {
  auth.merchant = {
    id: 'm-1', merchantId: 'm-1', status: 'ACTIVE', isOnline: false, username: 'shop',
    totalOrdersCompleted: 7, totalDepositAmount: 12_000, totalWithdrawalAmount: 3_000,
    successRate: 0.875, avgResponseMinutes: 2.5, ...merchant,
  };
  return render(<MemoryRouter><ProfileSettings /></MemoryRouter>);
};

describe('Profile', () => {
  it('shows a merchant account no payment-details form, and the success rate', () => {
    show({ isMerchantAccount: true });
    expect(screen.queryByText('Payment details')).not.toBeInTheDocument();
    expect(screen.getByText('Success rate')).toBeInTheDocument();
    expect(screen.getByText('87.5%')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('keeps the form for an agent, whose buys are paid into their own account', () => {
    show({});
    expect(screen.getByText('Payment details')).toBeInTheDocument();
  });
});
