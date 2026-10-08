// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A staff session the server refuses lands on the sign-in form SAYING why.
 *
 * `auth.test.ts` proves the store keeps the reason and `Login.signedOut.test.tsx`
 * that the form announces one. Neither proves the two meet: this renders the
 * REAL route table (as `App.noAccess.test.tsx` does, §28) with the session
 * check refused 403, then boots the panel again as the reload would, and reads
 * what the operator is shown (§32 S48).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const { verifySession } = vi.hoisted(() => ({ verifySession: vi.fn() }));
vi.mock('./services/sse', () => ({
  default: { on: vi.fn(), off: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('./services/api', () => ({
  default: {
    auth: { verifySession, logout: vi.fn(), login: vi.fn(), loginTwoFactor: vi.fn() },
    // The sign-in form asks whether Telegram is set up for staff.
    telegram: { miniApp: vi.fn().mockResolvedValue({ success: true, available: false, botUsername: '', resetUrl: null }) },
  },
}));

const SUB_ADMIN = { userId: 's-1', username: 'staff', isAdmin: false, isSubAdmin: true, permissions: { canManageUsers: true } };

/** One page load of the panel, from whatever the browser has stored. */
const boot = async () => {
  vi.resetModules();
  const { default: App } = await import('./App');
  const { useAuthStore } = await import('./services/auth');
  render(<App />);
  return useAuthStore;
};

describe('a refused staff session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    sessionStorage.clear();
    localStorage.clear();
    // jsdom has no matchMedia; the toaster asks it for reduced motion.
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any;
  });

  it('is told why on the sign-in form, not shown a bare one', async () => {
    // Signed in, as a returning operator is: the store's envelope on disk.
    localStorage.setItem('admin-auth', JSON.stringify({
      state: { token: 't', admin: SUB_ADMIN, isAuthenticated: true, bootstrap: false }, version: 0,
    }));
    window.location.hash = '#/users';
    verifySession.mockRejectedValue(Object.assign(new Error('HTTP 403'), {
      response: { status: 403, data: { success: false, message: 'Account blocked' } },
    }));
    const store = await boot();
    await waitFor(() => expect(store.getState().isAuthenticated).toBe(false));
    expect(localStorage.getItem('admin-auth'), 'the refused session is still stored').toBeNull();

    // The reload `endRefusedSession` asks for: a fresh boot at the panel's root.
    cleanup();
    window.location.hash = '';
    await boot();
    expect(await screen.findByRole('alert')).toHaveTextContent('You were signed out: Account blocked');
    expect(window.location.hash).toBe('#/login');
    expect(verifySession, 'nothing to check: the session is gone').toHaveBeenCalledTimes(1);
  });

  it('keeps an operator whose check merely failed signed in, with no alert (the opposite case)', async () => {
    localStorage.setItem('admin-auth', JSON.stringify({
      state: { token: 't', admin: SUB_ADMIN, isAuthenticated: true, bootstrap: false }, version: 0,
    }));
    window.location.hash = '#/users';
    verifySession.mockRejectedValue(Object.assign(new Error('HTTP 502'), { response: { status: 502, data: {} } }));
    const store = await boot();
    await waitFor(() => expect(verifySession).toHaveBeenCalled());
    expect(store.getState().isAuthenticated).toBe(true);
    expect(sessionStorage.getItem('adminSignedOutReason')).toBeNull();
    expect(screen.queryByText(/You were signed out/)).toBeNull();
  });
});
