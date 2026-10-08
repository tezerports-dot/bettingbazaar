// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The header's VIP / General switch shows what the server says and switches
 * through the server (owner, 2026-10-08).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: api, apiClient: api }));

const { ProfileSwitch, usePlayProfile } = await import('./ProfileSwitch');

const Harness = () => {
  const { general, choose, error } = usePlayProfile(true, '/');
  return general ? <ProfileSwitch general={general} choose={choose} error={error} /> : <p>loading</p>;
};

let profile = 'VIP';
beforeEach(() => {
  profile = 'VIP';
  api.get.mockReset().mockImplementation(async () => ({
    success: true, profile, promoBalance: 1000, outstandingTurnover: 9000, turnoverMultiplier: 10,
  }));
  api.put.mockReset().mockImplementation(async (_p: string, body: any) => { profile = body.profile; return { success: true, profile }; });
});

describe('the profile switch', () => {
  it('shows the General balance and the turnover still needed', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Profile: VIP ID/ }));
    expect(screen.getByRole('menuitemradio', { name: /General/ }).textContent).toMatch(/₹1,000 bonus · ₹9,000 turnover to unlock/);
  });

  it('switches to General through the server and shows it', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Profile: VIP ID/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /General/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/user/play-profile', { profile: 'GENERAL' }));
    expect(await screen.findByRole('button', { name: /Profile: General/ })).toBeTruthy();
  });

  it('says so when the switch is refused', async () => {
    api.put.mockImplementationOnce(async () => ({ success: false, message: 'Account not found' }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Profile: VIP ID/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /General/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Account not found');
  });
});
