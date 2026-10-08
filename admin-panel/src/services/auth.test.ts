// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The staff door over the wire: the real mapper and the real store over a
 * stubbed HTTP client, which is the seam a dropped field is lost at (F-011 was
 * one line in the mapper). Step 3: every staff sign-in is approved in
 * Telegram, and the bootstrap (no bot saved yet) is a password-only session
 * the server marks `bootstrap: true`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `services/api.ts` builds its own axios instance, so the seam to stub is
// `axios.create` itself — there is no separate client module in this panel.
// The response interceptor `api.ts` installs is kept, not stubbed away: it is
// the path every route's 401 takes (`a refused session is SAID`, below).
const { post, get, interceptor } = vi.hoisted(() => ({
  post: vi.fn(), get: vi.fn(),
  interceptor: { rejected: null as null | ((error: unknown) => Promise<unknown>) },
}));
vi.mock('axios', () => {
  const instance = {
    post, get, put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: (_ok: unknown, rejected: (error: unknown) => Promise<unknown>) => { interceptor.rejected = rejected; } },
    },
    defaults: { headers: { common: {} } },
  };
  return { default: { create: () => instance, isAxiosError: () => false }, isAxiosError: () => false };
});

import api from './api';
import { useAuthStore } from './auth';

const ADMIN = { userId: 'a-1', username: 'owner', isAdmin: true };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.setState({
    admin: null, token: null, isAuthenticated: false, isLoading: false, bootstrap: false,
  });
});

const refused = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

describe('the password leg', () => {
  it('signs in on a session and carries `bootstrap` to the store, persisted', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN, bootstrap: true } });
    const answer = await useAuthStore.getState().login('9000000001', 'pw');
    expect(answer.kind).toBe('session');
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.bootstrap, 'the mapper dropped the flag the server sent').toBe(true);
    expect(JSON.parse(localStorage.getItem('admin-auth') || '{}')?.state?.bootstrap).toBe(true);
  });

  it('leaves `bootstrap` false when the server does not send it', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN } });
    await useAuthStore.getState().login('9000000001', 'pw');
    expect(useAuthStore.getState().bootstrap).toBe(false);
  });

  it('answers the Telegram step on `twoFactorRequired`, holding no session', async () => {
    const telegram = { url: 'https://t.me/bb_bot/app?startapp=x', botUsername: 'bb_bot', expiresAt: '2026-10-08T10:00:00Z' };
    post.mockResolvedValue({ status: 200, data: { success: false, twoFactorRequired: true, challengeToken: 'c-1', telegram, message: 'Approve' } });
    const answer = await useAuthStore.getState().login('9000000001', 'pw');
    expect(answer).toEqual({ kind: 'telegram', challengeToken: 'c-1', telegram, message: 'Approve' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('admin-auth') || '').not.toContain('c-1');
  });

  it('answers the same step on 403 TELEGRAM_VERIFICATION_REQUIRED', async () => {
    const telegram = { url: 'https://t.me/bb_bot/app?startapp=v', botUsername: 'bb_bot', expiresAt: '2026-10-08T10:00:00Z' };
    post.mockRejectedValue(refused(403, { success: false, code: 'TELEGRAM_VERIFICATION_REQUIRED', challengeToken: 'v-1', telegram, message: 'Verify' }));
    const answer = await useAuthStore.getState().login('9000000001', 'pw');
    expect(answer.kind).toBe('telegram');
    expect(answer.kind === 'telegram' && answer.challengeToken).toBe('v-1');
  });

  it('throws any other refusal, in the server\'s words (the opposite case)', async () => {
    post.mockRejectedValue(refused(401, { success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }));
    await expect(useAuthStore.getState().login('9000000001', 'bad')).rejects.toMatchObject({ response: { status: 401 } });
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it('sends the approved "Login with Telegram" token with the password', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN } });
    await useAuthStore.getState().login('9000000001', 'pw', 'admin', 'tg-1');
    expect(post).toHaveBeenCalledWith('/api/admin/login', expect.objectContaining({ challengeToken: 'tg-1' }));
  });

  it('clears `bootstrap` on sign-out', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN, bootstrap: true } });
    await useAuthStore.getState().login('9000000001', 'pw');
    post.mockResolvedValue({ status: 200, data: { success: true } });
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().bootstrap).toBe(false);
  });
});

describe('waiting on Telegram', () => {
  it('a 202 from /login/2fa is "keep polling"', async () => {
    post.mockResolvedValue({ status: 202, data: { success: false, pending: true, code: 'TWO_FACTOR_PENDING' } });
    expect(await api.auth.loginTwoFactor('c-1')).toEqual({ kind: 'pending' });
    expect(post).toHaveBeenCalledWith('/api/admin/login/2fa', { challengeToken: 'c-1' });
  });

  it('a session from /login/2fa is a session', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN } });
    const answer = await api.auth.loginTwoFactor('c-1');
    expect(answer.kind).toBe('session');
  });

  it('a denial is thrown with the server\'s words', async () => {
    post.mockRejectedValue(refused(401, { success: false, code: 'TWO_FACTOR_DENIED', message: 'This sign-in was refused in Telegram.' }));
    await expect(api.auth.loginTwoFactor('c-1')).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('"Login with Telegram" completes into the password step', async () => {
    post.mockResolvedValue({ status: 202, data: { success: false, pending: true } });
    expect(await api.auth.telegramLoginComplete('tg-1')).toEqual({ kind: 'pending' });
    post.mockResolvedValue({ status: 200, data: { success: false, passwordRequired: true } });
    expect(await api.auth.telegramLoginComplete('tg-1')).toEqual({ kind: 'passwordRequired' });
  });
});

/**
 * A blip is not a logout.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * `verifySession` ended with `catch { set({ isAuthenticated: false }); }`, so
 * ANY failure of `GET /api/v1/auth/me` showed the login form to an admin whose
 * token was perfectly valid — and made them do 2FA again over it, losing
 * whatever they were part-way through.
 *
 * Measured, not theorised: the browser pass made enough requests to trip the
 * platform's own IP limiter (`RATE_LIMIT_TIERS.global`, 1,000 per 15 minutes),
 * `/api/v1/auth/me` answered 429, and every screen in the admin panel rendered
 * as logged out. The same thing happens on a 502 during a deploy or a dropped
 * connection in a lift.
 *
 * A session that is genuinely invalid does not need that branch: the response
 * interceptor in `api.ts` clears storage and redirects on a 401. So only an
 * explicit refusal ends the session here.
 */
describe('verifySession tells a refusal from a blip', () => {
  const signedIn = () => useAuthStore.setState({
    admin: ADMIN as any, token: 'good-token', isAuthenticated: true,
    isLoading: false, bootstrap: false,
  });
  const reject = (status?: number) => {
    const err: any = new Error(status ? `HTTP ${status}` : 'Network Error');
    if (status) err.response = { status, data: {} };
    get.mockRejectedValue(err);
  };

  it('keeps the session when the platform rate-limits the check (429)', async () => {
    signedIn();
    reject(429);
    await useAuthStore.getState().verifySession();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().token).toBe('good-token');
  });

  it('keeps the session through a gateway error during a deploy (502)', async () => {
    signedIn();
    reject(502);
    await useAuthStore.getState().verifySession();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('keeps the session when the connection simply drops', async () => {
    signedIn();
    reject();                      // no response at all
    await useAuthStore.getState().verifySession();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('ENDS the session when the server actually refuses it (401)', async () => {
    signedIn();
    reject(401);
    await useAuthStore.getState().verifySession();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('ENDS the session when the account no longer has the rights (403)', async () => {
    signedIn();
    reject(403);
    await useAuthStore.getState().verifySession();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('still ends it when the server answers 200 with success:false', async () => {
    signedIn();
    get.mockResolvedValue({ data: { success: false } });
    await useAuthStore.getState().verifySession();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
  });
});

/**
 * A refused session is SAID on the sign-in form, not just obeyed (§32 S48).
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * The branch above cleared the store on a 403 and the route guards dropped the
 * operator at a bare sign-in form: a staff account blocked or closed while
 * signed in read "Choose your role to continue", typed its password, and only
 * then learned why. A 401 from any route went to `'/#/login'`, which is the
 * PLAYER app in production (this panel is served under `/admin/`), with no
 * reason either. The merchant panel fixed the same shape in Step 2g; this is
 * its sibling. The reason is asserted where it is KEPT (sessionStorage, across
 * the reload); `Login.signedOut.test.tsx` asserts the form announces it.
 */
describe('a refused session is SAID on the sign-in form', () => {
  const KEY = 'adminSignedOutReason';
  const signedIn = () => useAuthStore.setState({
    admin: ADMIN as any, token: 'good-token', isAuthenticated: true,
    isLoading: false, bootstrap: false,
  });
  const refusal = (status: number, data: unknown) =>
    Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('keeps the server\'s words when the session check is refused 403', async () => {
    signedIn();
    get.mockRejectedValue(refusal(403, { success: false, message: 'Account blocked' }));
    await useAuthStore.getState().verifySession();
    expect(sessionStorage.getItem(KEY)).toBe('Account blocked');
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.token).toBeNull();
    expect(s.admin, 'a refused identity was left in the store').toBeNull();
    expect(localStorage.getItem('admin-auth'), 'the refused session is still stored').toBeNull();
  });

  it('says a closed account is closed, in the server\'s words', async () => {
    signedIn();
    get.mockRejectedValue(refusal(403, {
      success: false, code: 'ACCOUNT_CLOSED', message: 'This account has been closed. Contact support.',
    }));
    await useAuthStore.getState().verifySession();
    expect(sessionStorage.getItem(KEY)).toBe('This account has been closed. Contact support.');
  });

  it('ends the session on a proxy\'s 403 page without repeating its body as a reason', async () => {
    signedIn();
    get.mockRejectedValue(refusal(403, '<html><body>403 Forbidden</body></html>'));
    await useAuthStore.getState().verifySession();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('leaves no reason behind for a blip (the opposite case)', async () => {
    signedIn();
    get.mockRejectedValue(refusal(429, { success: false, message: 'Too many requests' }));
    await useAuthStore.getState().verifySession();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem('admin-auth')).not.toBeNull();
  });

  it('ends a HELD session refused 401 on any route, keeping the server\'s words', async () => {
    signedIn();   // persisted: the request interceptor reads the token from storage
    expect(interceptor.rejected, 'api.ts installed no response interceptor').toBeTypeOf('function');
    const err = refusal(401, { success: false, code: 'SESSION_SUPERSEDED', message: 'Your password was changed. Please sign in again.' });
    await expect(interceptor.rejected!(err)).rejects.toBe(err);
    expect(sessionStorage.getItem(KEY)).toBe('Your password was changed. Please sign in again.');
    expect(localStorage.getItem('admin-auth')).toBeNull();
  });

  it('leaves the sign-in form\'s own 401 alone: no session was held, nothing is ended', async () => {
    // "Invalid credentials" on the password leg, "Invalid authentication code"
    // on the second: reloading over either erased the message unread.
    const err = refusal(401, { success: false, message: 'Invalid credentials' });
    await expect(interceptor.rejected!(err)).rejects.toBe(err);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('a 403 from any other route ends nothing: "not permitted" is not "signed out"', async () => {
    signedIn();
    const err = refusal(403, { success: false, message: 'Administrative privileges required' });
    await expect(interceptor.rejected!(err)).rejects.toBe(err);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem('admin-auth')).not.toBeNull();
  });
});

describe('a held session Telegram never approved', () => {
  it('is ended on 403 TWO_FACTOR_REQUIRED, with the server\'s words', async () => {
    sessionStorage.clear();
    useAuthStore.setState({ admin: ADMIN as any, token: 'pwd-only', isAuthenticated: true, isLoading: false, bootstrap: true });
    const err = refused(403, { success: false, code: 'TWO_FACTOR_REQUIRED', message: 'This sign-in has not been approved in Telegram.' });
    await expect(interceptor.rejected!(err)).rejects.toBe(err);
    expect(sessionStorage.getItem('adminSignedOutReason')).toBe('This sign-in has not been approved in Telegram.');
    expect(localStorage.getItem('admin-auth')).toBeNull();
  });
});
