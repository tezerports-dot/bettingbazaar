// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The staff door over the wire: the real mapper and the real store over a
 * stubbed HTTP client, which is the seam a dropped field is lost at (F-011 was
 * one line in the mapper). Every staff sign-in is a password, then a code from
 * an authenticator app (owner, 2026-10-13); the first one sets the app up.
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
    admin: null, token: null, isAuthenticated: false, isLoading: false
  });
});

const refused = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

describe('the password leg', () => {
  it('answers the code step on `totpRequired`, holding no session', async () => {
    post.mockResolvedValue({ status: 200, data: { success: false, twoFactorRequired: true, totpRequired: true, challengeToken: 'c-1', message: 'Enter the code' } });
    const answer = await useAuthStore.getState().login('9000000001', 'pw');
    expect(answer).toEqual({ kind: 'totp', challengeToken: 'c-1', message: 'Enter the code' });
    expect(post).toHaveBeenCalledWith('/api/admin/login', { mobile: '9000000001', password: 'pw', loginType: 'admin' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('admin-auth') || '', 'a challenge was persisted').not.toContain('c-1');
  });

  it('answers the setup step on `totpSetupRequired`', async () => {
    post.mockResolvedValue({ status: 200, data: { success: false, twoFactorRequired: true, totpSetupRequired: true, challengeToken: 's-1', message: 'Set up' } });
    const answer = await useAuthStore.getState().login('9000000001', 'pw', 'subadmin');
    expect(answer).toEqual({ kind: 'totpSetup', challengeToken: 's-1', message: 'Set up' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('never adopts a session from the password leg, even if one were sent', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN } });
    await expect(useAuthStore.getState().login('9000000001', 'pw')).rejects.toBeTruthy();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it('throws any other refusal, in the server\'s words (the opposite case)', async () => {
    post.mockRejectedValue(refused(401, { success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }));
    await expect(useAuthStore.getState().login('9000000001', 'bad')).rejects.toMatchObject({ response: { status: 401 } });
    expect(useAuthStore.getState().isLoading).toBe(false);
  });
});

describe('the code legs', () => {
  it('a code answers a session, which is held only once adopted', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN } });
    const session = await api.auth.totp('c-1', '123456');
    expect(post).toHaveBeenCalledWith('/api/admin/login/totp', { challengeToken: 'c-1', code: '123456' });
    expect(session).toEqual({ token: 't', admin: ADMIN });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    useAuthStore.getState().adoptSession(session);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(JSON.parse(localStorage.getItem('admin-auth') || '{}')?.state?.token).toBe('t');
  });

  it('a recovery code carries how many are left', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN, recoveryCodesLeft: 3 } });
    expect((await api.auth.totp('c-1', 'ABCDE-FGHIJ')).recoveryCodesLeft).toBe(3);
  });

  it('a wrong code is thrown with the server\'s words', async () => {
    post.mockRejectedValue(refused(401, { success: false, code: 'TOTP_INVALID', message: 'That code is not right.' }));
    await expect(api.auth.totp('c-1', '000000')).rejects.toMatchObject({ response: { data: { code: 'TOTP_INVALID' } } });
  });

  it('setup answers the key and its QR', async () => {
    post.mockResolvedValue({ status: 200, data: { success: true, secret: 'ABCD', otpauthUri: 'otpauth://totp/x', qrDataUrl: 'data:image/png;base64,AA' } });
    expect(await api.auth.totpSetup('s-1')).toEqual({ secret: 'ABCD', otpauthUri: 'otpauth://totp/x', qrDataUrl: 'data:image/png;base64,AA' });
    expect(post).toHaveBeenCalledWith('/api/admin/login/totp/setup', { challengeToken: 's-1' });
  });

  it('activate answers a session AND the ten recovery codes; without codes it is refused', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBBB`);
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN, recoveryCodes: codes } });
    expect((await api.auth.totpActivate('s-1', '123456')).recoveryCodes).toEqual(codes);
    post.mockResolvedValue({ status: 200, data: { success: true, token: 't', user: ADMIN } });
    await expect(api.auth.totpActivate('s-1', '123456')).rejects.toBeTruthy();
  });

  it('sign-out clears the held session', async () => {
    useAuthStore.getState().adoptSession({ token: 't', admin: ADMIN as any });
    post.mockResolvedValue({ status: 200, data: { success: true } });
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
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
    isLoading: false
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
    isLoading: false
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

describe('a held session without its authenticator code', () => {
  it('is ended on 403 TWO_FACTOR_REQUIRED, with the server\'s words', async () => {
    sessionStorage.clear();
    useAuthStore.setState({ admin: ADMIN as any, token: 'pwd-only', isAuthenticated: true, isLoading: false });
    const err = refused(403, { success: false, code: 'TWO_FACTOR_REQUIRED', message: 'This sign-in is missing its second step. Sign in again.' });
    await expect(interceptor.rejected!(err)).rejects.toBe(err);
    expect(sessionStorage.getItem('adminSignedOutReason')).toBe('This sign-in is missing its second step. Sign in again.');
    expect(localStorage.getItem('admin-auth')).toBeNull();
  });
});
