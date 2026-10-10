// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Play with your bonus": shown on VIP with a General balance, and its button
 * makes the same profile switch as the header pill.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { get, put } }));

import BonusPlayPrompt from './BonusPlayPrompt';

const summary = (profile: 'VIP' | 'GENERAL', promoBalance: number) => ({
  success: true, profile, promoBalance, outstandingTurnover: 250, turnoverMultiplier: 10,
});

beforeEach(() => { get.mockReset(); put.mockReset(); window.location.hash = '#/wallet'; });

describe('Play with your bonus', () => {
  it('offers the bonus on VIP and switches to General, then opens the board', async () => {
    get.mockResolvedValue(summary('VIP', 25));
    put.mockResolvedValue({ success: true, profile: 'GENERAL' });
    render(<BonusPlayPrompt />);
    expect(await screen.findByText(/₹25 referral bonus ready to play/)).toBeInTheDocument();
    expect(screen.getByText(/₹250 more/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play with your bonus' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/user/play-profile', { profile: 'GENERAL' }));
    await waitFor(() => expect(window.location.hash).toBe('#/'));
  });

  it('stays away with no bonus, or when already on General', async () => {
    get.mockResolvedValueOnce(summary('VIP', 0));
    const { unmount } = render(<BonusPlayPrompt />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Play with your bonus' })).toBeNull();
    unmount();

    get.mockResolvedValueOnce(summary('GENERAL', 25));
    render(<BonusPlayPrompt />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Play with your bonus' })).toBeNull();
  });

  it('says so when the switch is refused, and stays put', async () => {
    get.mockResolvedValue(summary('VIP', 25));
    put.mockResolvedValue({ success: false, message: 'Could not switch profile' });
    render(<BonusPlayPrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'Play with your bonus' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not switch profile');
  });
});
