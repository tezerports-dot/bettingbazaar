// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The payout details on Profile: a bank account and a UPI ID (owner,
 * 2026-10-21). The member paying a sell is shown the bank details and a UPI
 * link built for the order's amount, so both are asked for and sent; the
 * server refuses a UPI ID that is a mobile and holds the details fixed for 48
 * hours after a save and while an order is open (schema.sql "PAYOUT DETAILS
 * LOCK"). The screen shows the server's lock and its refusals as worded.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { updateBankDetails, getSupportLinks, refreshUserWallet, game } = vi.hoisted(() => ({
  updateBankDetails: vi.fn(), getSupportLinks: vi.fn(), refreshUserWallet: vi.fn(),
  game: { user: null as any },
}));
vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getSupportLinks, updateBankDetails }),
}));
vi.mock('../services/GameContext', () => ({
  useGame: () => ({
    user: game.user, userBets: [], updateProfile: vi.fn(), logout: vi.fn(), refreshUserWallet,
  }),
}));
vi.mock('../redesign/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

import ProfilePage from './ProfilePage';

beforeEach(() => {
  game.user = { id: 'u1', username: 'player', mobile: '9999900000', bankDetails: null, payoutDetailsLockedUntil: null };
  updateBankDetails.mockReset().mockResolvedValue({});
  refreshUserWallet.mockReset().mockResolvedValue(undefined);
  getSupportLinks.mockReset().mockResolvedValue({});
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

const openAccount = () => fireEvent.click(screen.getByRole('button', { name: /Bank account/i }));
const fill = () => {
  fireEvent.change(screen.getByLabelText('Account holder name'), { target: { value: 'A Player' } });
  fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '123456789012' } });
  fireEvent.change(screen.getByLabelText('IFSC'), { target: { value: 'hdfc0001234' } });
  fireEvent.change(screen.getByLabelText('Bank'), { target: { value: 'HDFC Bank' } });
};

describe('the payout details on Profile', () => {
  it('asks for the bank account and a UPI ID, and says they lock for 48 hours', () => {
    render(<ProfilePage />);
    openAccount();
    for (const label of ['Account holder name', 'Account number', 'IFSC', 'Bank', 'UPI ID']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByText(/cannot be changed for 48 hours, or while an order is in progress/)).toBeInTheDocument();
  });

  it('will not send without the UPI ID, and says so', () => {
    render(<ProfilePage />);
    openAccount();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    expect(updateBankDetails).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/your UPI ID/);
  });

  it('saves the five fields, then reloads the profile for the lock', async () => {
    render(<ProfilePage />);
    openAccount();
    fill();
    fireEvent.change(screen.getByLabelText('UPI ID'), { target: { value: ' a.player@okaxis ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(updateBankDetails).toHaveBeenCalledTimes(1));
    expect(updateBankDetails).toHaveBeenCalledWith('u1', {
      accountHolderName: 'A Player', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank',
      upiId: 'a.player@okaxis',
    });
    await waitFor(() => expect(refreshUserWallet).toHaveBeenCalled());
  });

  it('shows the server refusal as worded, announced', async () => {
    updateBankDetails.mockRejectedValue(new Error('That UPI ID is your mobile number.'));
    render(<ProfilePage />);
    openAccount();
    fill();
    fireEvent.change(screen.getByLabelText('UPI ID'), { target: { value: '9876543210@ybl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That UPI ID is your mobile number.');
  });

  it('while locked, says until when and offers no save', () => {
    game.user = { ...game.user, payoutDetailsLockedUntil: new Date(Date.now() + 3_600_000).toISOString() };
    render(<ProfilePage />);
    openAccount();
    expect(screen.getByRole('status').textContent).toMatch(/Locked until/);
    expect(screen.getByRole('button', { name: 'Locked for now' })).toBeDisabled();
  });
});
