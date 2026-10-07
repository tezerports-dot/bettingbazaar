// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The payout account on Profile is a bank account, and only that.
 *
 * Every sell is a bank transfer to the player's account, and no UPI handle is
 * ever a destination or shown (CLAUDE.md §2 "How each rail is paid", §24). The
 * screen still said "Bank / UPI Details", led with a UPI ID field and an
 * "— OR BANK ACCOUNT —" divider. The field was typed into and never sent
 * (§32 S22): a player who filled in only the UPI ID was told "All bank fields
 * are required", and one who filled in both believed the handle was kept.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { updateBankDetails, getSupportLinks } = vi.hoisted(() => ({
  updateBankDetails: vi.fn(), getSupportLinks: vi.fn(),
}));
vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getSupportLinks, updateBankDetails }),
}));
vi.mock('../services/GameContext', () => ({
  useGame: () => ({
    user: { id: 'u1', username: 'player', mobile: '9999900000', bankDetails: null },
    userBets: [], updateProfile: vi.fn(), logout: vi.fn(),
  }),
}));
vi.mock('../redesign/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

import ProfilePage from './ProfilePage';

beforeEach(() => {
  updateBankDetails.mockReset().mockResolvedValue({});
  getSupportLinks.mockReset().mockResolvedValue({});
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

const openAccount = () => fireEvent.click(screen.getByRole('button', { name: /Bank account/i }));

describe('the payout account on Profile', () => {
  it('asks for a bank account and no UPI ID', () => {
    render(<ProfilePage />);
    expect(screen.queryByText(/UPI/i), 'the Profile row still names UPI').toBeNull();
    openAccount();
    expect(screen.queryByText(/UPI/i), 'the form still names UPI').toBeNull();
    expect(screen.queryByText(/OR BANK ACCOUNT/i)).toBeNull();
    for (const label of ['Account holder name', 'Account number', 'IFSC', 'Bank']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('saves the four fields a bank transfer needs (the opposite case)', async () => {
    render(<ProfilePage />);
    openAccount();
    fireEvent.change(screen.getByLabelText('Account holder name'), { target: { value: 'A Player' } });
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '123456789012' } });
    fireEvent.change(screen.getByLabelText('IFSC'), { target: { value: 'hdfc0001234' } });
    fireEvent.change(screen.getByLabelText('Bank'), { target: { value: 'HDFC Bank' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(updateBankDetails).toHaveBeenCalledTimes(1));
    expect(updateBankDetails).toHaveBeenCalledWith('u1', {
      accountHolderName: 'A Player', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank',
    });
  });
});
