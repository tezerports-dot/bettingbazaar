// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Wallet's VIP / General toggle: both balances shown, the current one
 * checked, and tapping the other makes the profile switch.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WalletProfileToggle from './WalletProfileToggle';

const general = (profile: 'VIP' | 'GENERAL') => ({ profile, promoBalance: 25, outstandingTurnover: 250, turnoverMultiplier: 10 });

describe('Wallet VIP / General toggle', () => {
  it('shows both wallets and marks the one in use', () => {
    render(<WalletProfileToggle general={general('VIP')} choose={vi.fn()} error="" vipTotal={4250} />);
    expect(screen.getByRole('radio', { name: /VIP wallet/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /General wallet/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('₹4,250')).toBeInTheDocument();
    expect(screen.getByText('₹25')).toBeInTheDocument();
  });

  it('switches the play profile when the other wallet is tapped, and not when the same one is', async () => {
    const choose = vi.fn().mockResolvedValue(true);
    render(<WalletProfileToggle general={general('VIP')} choose={choose} error="" vipTotal={0} />);
    fireEvent.click(screen.getByRole('radio', { name: /VIP wallet/ }));
    expect(choose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: /General wallet/ }));
    await waitFor(() => expect(choose).toHaveBeenCalledWith('GENERAL'));
  });

  it('announces a refused switch', () => {
    render(<WalletProfileToggle general={general('GENERAL')} choose={vi.fn()} error="Could not switch profile" vipTotal={0} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not switch profile');
  });
});
