// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sign-in form says why the panel signed the merchant out.
 *
 * A merchant an admin suspended mid-session had their next profile call
 * refused 403 "Account suspended. Contact support."; the panel cleared the
 * session and reloaded at this form, which said only "Secure operator
 * sign-in". They typed their password and read the reason only then (§32 S48,
 * S17: an admin decision the merchant's own panel did not reflect).
 * `api.logout(reason)` keeps the server's words across that one reload; this
 * screen announces them, once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/AuthContext', () => ({
  useAuth: () => ({
    merchant: null, loading: false, unreachable: false, pendingChallenge: null,
    login: vi.fn(), submitTwoFactor: vi.fn(), cancelTwoFactor: vi.fn(), refreshProfile: vi.fn(),
  }),
}));

const KEY = 'merchantSignedOutReason';

/** A fresh page load: the api module's read-once memory is per load. */
const loadPage = async () => {
  vi.resetModules();
  const { default: LoginPage } = await import('./LoginPage');
  render(<MemoryRouter><LoginPage /></MemoryRouter>);
};

describe('the sign-in form after the panel signed the merchant out', () => {
  beforeEach(() => { sessionStorage.clear(); cleanup(); });

  it('announces the server\'s reason', async () => {
    sessionStorage.setItem(KEY, 'Account suspended. Contact support.');
    await loadPage();
    expect(screen.getByRole('alert').textContent).toContain('Account suspended. Contact support.');
  });

  it('says it once: the next page load is a plain form', async () => {
    sessionStorage.setItem(KEY, 'Account suspended. Contact support.');
    await loadPage();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    cleanup();
    await loadPage();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows no alert when nothing signed them out', async () => {
    await loadPage();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Secure operator sign-in')).toBeTruthy();
  });
});

describe('api.logout keeps the reason across the reload', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('stores the server\'s words, trimmed and bounded', async () => {
    vi.resetModules();
    const { logout } = await import('../services/api');
    logout('  Account suspended. Contact support.  ');
    expect(sessionStorage.getItem(KEY)).toBe('Account suspended. Contact support.');
    logout('x'.repeat(1000));
    expect(sessionStorage.getItem(KEY)?.length).toBe(300);
  });

  it('a sign-out forgets the reason this page load already showed', async () => {
    vi.resetModules();
    sessionStorage.setItem(KEY, 'Account suspended. Contact support.');
    const { logout, signedOutReason } = await import('../services/api');
    expect(signedOutReason()).toBe('Account suspended. Contact support.');
    // Signed in again without a reload, then Log out: the form that flashes
    // before the reload lands must not repeat the old reason.
    logout();
    expect(signedOutReason()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('stores nothing for a plain sign-out', async () => {
    vi.resetModules();
    const { logout } = await import('../services/api');
    logout();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
