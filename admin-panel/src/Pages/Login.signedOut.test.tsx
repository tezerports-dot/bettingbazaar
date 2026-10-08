// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sign-in form says why the panel signed the operator out.
 *
 * A staff account blocked or closed mid-session had its next session check
 * refused 403 ("Account blocked", "This account has been closed. Contact
 * support."); the panel cleared the session and the route guards showed this
 * form, which said only "Choose your role to continue". The operator typed
 * their password and read the reason only then (§32 S48, S14). The merchant
 * panel fixed the same shape in Step 2g (`LoginPage.signedOut.test.tsx`); this
 * is the admin panel's half. `signedOut.ts` keeps the server's words across
 * the one reload; this screen announces them (`role="alert"`, S44), once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const { logout } = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('../services/sse', () => ({
  default: { on: vi.fn(), off: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('../services/api', () => ({
  default: {
    auth: { login: vi.fn(), loginTwoFactor: vi.fn(), telegramLogin: vi.fn(), telegramLoginComplete: vi.fn(), logout, verifySession: vi.fn() },
    telegram: { miniApp: vi.fn().mockResolvedValue({ success: true, available: false, botUsername: '', resetUrl: null }) },
  },
}));

const KEY = 'adminSignedOutReason';

/** A fresh page load: `signedOut.ts` reads the reason once per load. */
const loadPage = async () => {
  vi.resetModules();
  const { Login } = await import('./Login');
  render(<MemoryRouter><Login /></MemoryRouter>);
};

describe('the sign-in form after the panel signed the operator out', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); cleanup(); });

  it('announces the server\'s reason', async () => {
    sessionStorage.setItem(KEY, 'Account blocked');
    await loadPage();
    expect(screen.getByRole('alert').textContent).toBe('You were signed out: Account blocked');
    // The form is still there to sign in with once they have read it.
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('says it once: the next page load is a plain form', async () => {
    sessionStorage.setItem(KEY, 'This account has been closed. Contact support.');
    await loadPage();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    cleanup();
    await loadPage();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows no alert when nothing signed them out', async () => {
    await loadPage();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Choose your role to continue')).toBeInTheDocument();
  });

  it('a Log out after signing in again does not repeat the earlier reason', async () => {
    sessionStorage.setItem(KEY, 'Your password was changed. Please sign in again.');
    await loadPage();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    cleanup();
    // Same page load: signed in again, then Log out. The form it lands on is
    // a plain one; the refusal it already said is over.
    const { useAuthStore } = await import('../services/auth');
    useAuthStore.setState({ isAuthenticated: true, token: 't', admin: { userId: 'a-1', username: 'owner', isAdmin: true } as any });
    await useAuthStore.getState().logout();
    const { Login } = await import('./Login');
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('endRefusedSession keeps the reason across the reload', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('stores the server\'s words, trimmed and bounded, and forgets the session', async () => {
    vi.resetModules();
    localStorage.setItem('admin-auth', JSON.stringify({ state: { token: 't' }, version: 0 }));
    const { endRefusedSession } = await import('../services/signedOut');
    endRefusedSession('  Account blocked  ');
    expect(sessionStorage.getItem(KEY)).toBe('Account blocked');
    expect(localStorage.getItem('admin-auth')).toBeNull();
    endRefusedSession('x'.repeat(1000));
    expect(sessionStorage.getItem(KEY)?.length).toBe(300);
  });

  it('reloads at this panel\'s own root, not at `/` (the player app)', async () => {
    // The redirect it replaces was `'/#/login'`: production serves the PLAYER
    // app at `/` (Caddyfile) and this panel under vite's `base`. The test
    // config has no `base`, so the build's is read and given to the module
    // (by a computed specifier: `vite.config.ts` belongs to the node tsconfig).
    const buildConfig = '../../vite.config';
    const { default: built } = await import(/* @vite-ignore */ buildConfig);
    const base = (built as { base?: string }).base;
    expect(base).toBe('/admin/');
    vi.resetModules();
    vi.stubEnv('BASE_URL', base!);
    let went: string | null = null;
    vi.stubGlobal('location', { ...window.location, set href(to: string) { went = to; }, get href() { return went ?? ''; } });
    try {
      const { endRefusedSession } = await import('../services/signedOut');
      endRefusedSession('Account blocked');
      expect(went).toBe('/admin/');
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it('stores nothing when the server gave no words of its own', async () => {
    vi.resetModules();
    const { endRefusedSession, serverRefusal } = await import('../services/signedOut');
    endRefusedSession(serverRefusal('<html>403 Forbidden</html>'));
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(serverRefusal({ success: true, message: 'ok' })).toBeNull();
    expect(serverRefusal({ success: false, message: 'Account blocked' })).toBe('Account blocked');
  });
});

/**
 * The Telegram step (Step 3): the password is accepted, the sign-in is
 * approved in Telegram, and the screen polls `/login/2fa`. A refusal there is
 * said in the server's words (`role="alert"`, S44) and the polling stops.
 */
describe('the Approve in Telegram step', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); cleanup(); });

  const TELEGRAM = { url: 'https://t.me/bb_bot/app?startapp=c1', botUsername: 'bb_bot', expiresAt: '2026-10-08T10:00:00Z' };

  const toTelegramStep = async () => {
    vi.resetModules();
    const { default: api } = await import('../services/api');
    (api.auth.login as any).mockResolvedValue({ kind: 'telegram', challengeToken: 'c-1', telegram: TELEGRAM, message: 'Approve this sign-in in Telegram.' });
    const { Login } = await import('./Login');
    const { fireEvent } = await import('@testing-library/react');
    render(<MemoryRouter><Login /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9000000001' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    return api;
  };

  it('opens the Mini App link in a new tab and stops on a denial, in the server\'s words', async () => {
    const api = await toTelegramStep();
    (api.auth.loginTwoFactor as any).mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), {
      response: { status: 401, data: { success: false, code: 'TWO_FACTOR_DENIED', message: 'This sign-in was refused in Telegram.' } },
    }));
    const link = await screen.findByRole('link', { name: /Open Telegram/ });
    expect(link.getAttribute('href')).toBe(TELEGRAM.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    const { waitFor } = await import('@testing-library/react');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This sign-in was refused in Telegram.'), { timeout: 5000 });
    expect(api.auth.loginTwoFactor).toHaveBeenCalledWith('c-1');
    expect(api.auth.loginTwoFactor).toHaveBeenCalledTimes(1);
  }, 10000);

  it('keeps polling on 202 and signs in on approval (the opposite case)', async () => {
    const api = await toTelegramStep();
    (api.auth.loginTwoFactor as any)
      .mockResolvedValueOnce({ kind: 'pending' })
      .mockResolvedValue({ kind: 'session', session: { token: 't', admin: { userId: 'a-1', username: 'owner', isAdmin: true }, bootstrap: false } });
    await screen.findByRole('link', { name: /Open Telegram/ });
    const { useAuthStore } = await import('../services/auth');
    const { waitFor } = await import('@testing-library/react');
    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true), { timeout: 8000 });
    expect(api.auth.loginTwoFactor).toHaveBeenCalledTimes(2);
  }, 12000);

  it('stops asking once the operator goes back', async () => {
    const api = await toTelegramStep();
    (api.auth.loginTwoFactor as any).mockResolvedValue({ kind: 'pending' });
    await screen.findByRole('link', { name: /Open Telegram/ });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    await new Promise((r) => setTimeout(r, 3500));
    expect(api.auth.loginTwoFactor).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  }, 10000);
});
