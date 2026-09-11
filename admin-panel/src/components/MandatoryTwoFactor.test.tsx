// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * An admin who must hold a second factor cannot reach the panel without one.
 *
 * ── The defect these assert against ─────────────────────────────────────────
 * The server has sent `mustEnroll2FA` on the login response since 2026-09-10.
 * The admin panel's API mapper returned a fixed `{token, admin}` shape and
 * DROPPED it, and the auth store never had a field for it — so an admin who
 * never enrolled was never once asked, and held a password-only session over
 * the whole admin surface. `seedAdmin` does not enrol, so the bootstrapped
 * admin was in exactly that state from the first boot. F-011.
 *
 * `check:ui-coverage` could not see any of it: the paths were all correct. The
 * flag was correct on the wire and discarded one function later.
 *
 * ── Why the gate is asserted, not the flag ──────────────────────────────────
 * A test that only checked the store holds a boolean would pass against a gate
 * nothing renders. These render the real component with the real store and ask
 * what an operator would see.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { status } = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('../services/api', () => ({
  default: { twoFactor: { status, setup: vi.fn(), activate: vi.fn() } },
}));
vi.mock('./OtpAuthQr', () => ({ default: () => <div /> }));

import MandatoryTwoFactor from './MandatoryTwoFactor';
import { useAuthStore } from '../services/auth';

const PANEL = <div>THE ADMIN PANEL</div>;

const signedIn = (mustEnroll2FA: boolean) =>
  useAuthStore.setState({
    isAuthenticated: true, mustEnroll2FA,
    admin: { userId: 'a-1', username: 'owner', isAdmin: true } as any,
    token: 't', pendingChallenge: null,
  });

describe('the 2FA obligation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue({ enabled: false, mandatory: true });
    useAuthStore.setState({
      isAuthenticated: false, mustEnroll2FA: false, admin: null,
      token: null, pendingChallenge: null,
    });
  });

  it('hides the panel and asks an unenrolled admin to enrol', async () => {
    signedIn(true);
    render(<MandatoryTwoFactor>{PANEL}</MandatoryTwoFactor>);

    expect(await screen.findByText(/Set up two-factor authentication/i)).toBeInTheDocument();
    // The point of the gate: the panel behind it is NOT rendered. A prompt an
    // operator can scroll past is not a gate.
    expect(screen.queryByText('THE ADMIN PANEL')).not.toBeInTheDocument();
  });

  it('always offers a way out, so the gate is never a lockout', async () => {
    signedIn(true);
    render(<MandatoryTwoFactor>{PANEL}</MandatoryTwoFactor>);
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('lets an enrolled admin straight through', () => {
    signedIn(false);
    render(<MandatoryTwoFactor>{PANEL}</MandatoryTwoFactor>);
    expect(screen.getByText('THE ADMIN PANEL')).toBeInTheDocument();
    expect(screen.queryByText(/Set up two-factor authentication/i)).not.toBeInTheDocument();
  });

  it('does not hold somebody who is not signed in — that is the login guard\'s question', () => {
    useAuthStore.setState({ isAuthenticated: false, mustEnroll2FA: true });
    render(<MandatoryTwoFactor>{PANEL}</MandatoryTwoFactor>);
    expect(screen.getByText('THE ADMIN PANEL')).toBeInTheDocument();
  });

  it('releases an account the server says is ALREADY enrolled', async () => {
    // The stored obligation can go stale: the factor was added from another
    // device since this session logged in. Holding them at a screen that says
    // "enrol" when they already have is a lockout with a friendly face.
    status.mockResolvedValue({ enabled: true, mandatory: true });
    signedIn(true);
    render(<MandatoryTwoFactor>{PANEL}</MandatoryTwoFactor>);
    await waitFor(() => expect(useAuthStore.getState().mustEnroll2FA).toBe(false));
  });
});
