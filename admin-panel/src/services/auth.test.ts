// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The obligation survives the wire — the link where it was actually lost.
 *
 * ── Why this file is separate from MandatoryTwoFactor.test.tsx ──────────────
 * That file mocks `services/api` wholesale and sets the store by hand, so it
 * proves the GATE renders on a boolean and can say nothing about where the
 * boolean comes from. The F-011 defect was not in the gate — there was no gate.
 * It was one line in the API mapper: `login` returned a fixed
 * `{ token, admin }` shape and discarded `mustEnroll2FA`, which the server had
 * been sending all along.
 *
 * So this drives the real mapper and the real store over a stubbed HTTP client,
 * which is the seam the flag was dropped at. A component test could not have
 * caught it, and neither could `check:ui-coverage` — the path was correct; the
 * field was thrown away one function later.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `services/api.ts` builds its own axios instance, so the seam to stub is
// `axios.create` itself — there is no separate client module in this panel.
const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('axios', () => {
  const instance = {
    post, get, put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
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
  useAuthStore.setState({
    admin: null, token: null, isAuthenticated: false,
    isLoading: false, pendingChallenge: null, mustEnroll2FA: false,
  });
});

describe('mustEnroll2FA from the server to the store', () => {
  it('carries the flag through the login mapper', async () => {
    post.mockResolvedValue({ data: { success: true, token: 't', user: ADMIN, mustEnroll2FA: true } });
    const res: any = await api.auth.login('9000000001', 'pw');
    expect(res.success).toBe(true);
    expect(res.mustEnroll2FA, 'the mapper dropped the flag the server sent').toBe(true);
  });

  it('lands it in the store, where the gate reads it', async () => {
    post.mockResolvedValue({ data: { success: true, token: 't', user: ADMIN, mustEnroll2FA: true } });
    await useAuthStore.getState().login('9000000001', 'pw');
    const s = useAuthStore.getState();
    expect(s.isAuthenticated, 'the session is real — the server issues it either way').toBe(true);
    expect(s.mustEnroll2FA).toBe(true);
  });

  it('leaves it false when the server does not send it', async () => {
    // Absent, not `false` — that is how the server writes it, and a mapper
    // reading it as `undefined` would make the gate fire for nobody.
    post.mockResolvedValue({ data: { success: true, token: 't', user: ADMIN } });
    await useAuthStore.getState().login('9000000001', 'pw');
    expect(useAuthStore.getState().mustEnroll2FA).toBe(false);
  });

  it('survives a page reload, so a refresh is not the way past the prompt', async () => {
    post.mockResolvedValue({ data: { success: true, token: 't', user: ADMIN, mustEnroll2FA: true } });
    await useAuthStore.getState().login('9000000001', 'pw');
    const persisted = JSON.parse(localStorage.getItem('admin-auth') || '{}');
    expect(persisted?.state?.mustEnroll2FA).toBe(true);
  });

  it('does not persist the 2FA CHALLENGE, which is a live credential', async () => {
    // The opposite rule for the opposite reason, asserted alongside it so the
    // two cannot be conflated by a later edit to `partialize`.
    post.mockResolvedValue({ data: { success: false, twoFactorRequired: true, challengeToken: 'c-1' } });
    await useAuthStore.getState().login('9000000001', 'pw');
    expect(useAuthStore.getState().pendingChallenge).toBe('c-1');
    const persisted = JSON.parse(localStorage.getItem('admin-auth') || '{}');
    expect(persisted?.state?.pendingChallenge).toBeUndefined();
  });

  it('clears the obligation on sign-out', async () => {
    post.mockResolvedValue({ data: { success: true, token: 't', user: ADMIN, mustEnroll2FA: true } });
    await useAuthStore.getState().login('9000000001', 'pw');
    post.mockResolvedValue({ data: { success: true } });
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().mustEnroll2FA).toBe(false);
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
    isLoading: false, pendingChallenge: null, mustEnroll2FA: false,
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
