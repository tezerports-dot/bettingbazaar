// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A blip must not sign a merchant out.
 *
 * ── What this is protecting ─────────────────────────────────────────────────
 * `AuthProvider` refreshes the merchant's profile on boot, and its catch called
 * `api.logout()` on ANY failure — under a comment saying "token may be
 * expired". It handled every case except that one: a genuine 401 is already
 * cleared inside `request()`, which redirects before this catch runs.
 *
 * What actually reached it were the transient refusals. `RATE_LIMIT_TIERS.global`
 * is 1,000 requests per 15 minutes PER IP, which every merchant behind one
 * office NAT shares, and a gateway restart answers 502 for a second or two.
 * Either one cleared the token and hard-navigated to the sign-in form.
 *
 * Measured in a real browser before the fix, answering the profile call with
 * each status and reading what the panel left in localStorage:
 *
 *     429  ->  token cleared, thrown to /merchant/ sign-in
 *     502  ->  token cleared, thrown to /merchant/ sign-in
 *     401  ->  token cleared, thrown to /merchant/ sign-in   (correct)
 *
 * The cost is not only the re-login, which needs the password again. A merchant
 * serving a PAID deposit has `paidResponseMinutes` (schema default 30) before
 * the order goes to DISPUTED and the silence is counted against them as a
 * refusal (§2) — so a two-second gateway bounce can put a mark on an honest
 * merchant's streak while they are standing at the machine.
 *
 * The rule, and what these assert: the session is given up only when the SERVER
 * says the credential is no good. This is the sibling of the admin panel's
 * `verifySession` fix (§0.15 — fix the shape, not the instance).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  isAuthenticated: vi.fn(() => true),
  getCurrentMerchant: vi.fn((): { merchantId: string; username: string } | null => ({ merchantId: 'm1', username: 'Test Merchant' })),
  getMerchantProfile: vi.fn(),
  logout: vi.fn(),
  merchantLogin: vi.fn(),
  verifyTwoFactor: vi.fn(),
}));
vi.mock('./api', () => ({ api, default: api, ...api }));

const { AuthProvider, useAuth } = await import('./AuthContext');

const Probe = () => {
  const { merchant, unreachable } = useAuth();
  return (
    <>
      <div data-testid="who">{merchant ? merchant.username : 'SIGNED OUT'}</div>
      <div data-testid="unreachable">{unreachable ? 'UNREACHABLE' : '-'}</div>
    </>
  );
};

const boot = async () => {
  render(
    <MemoryRouter>
      <AuthProvider><Probe /></AuthProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(api.getMerchantProfile).toHaveBeenCalled());
};

/** The error shape `request()` throws: the status travels WITH it. */
const refusal = (status: number, message: string) =>
  Object.assign(new Error(message), { status, data: { success: false, message } });

describe('a transient failure does not end a merchant session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.isAuthenticated.mockReturnValue(true);
    api.getCurrentMerchant.mockReturnValue({ merchantId: 'm1', username: 'Test Merchant' });
  });

  // The two that were wrong. Each one is a merchant thrown to the sign-in form
  // over a refusal that was never about their credential.
  for (const [status, what] of [
    [429, 'the platform rate-limiting the shared office IP'],
    [502, 'the gateway restarting mid-deploy'],
    [503, 'the backend briefly unavailable'],
    [500, 'a server error on the profile route alone'],
  ] as [number, string][]) {
    it(`keeps the session through ${status} — ${what}`, async () => {
      api.getMerchantProfile.mockRejectedValue(refusal(status, 'not your fault'));
      await boot();
      expect(api.logout).not.toHaveBeenCalled();
      // And the merchant keeps working from the profile the panel cached.
      await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('Test Merchant'));
    });
  }

  // A network failure has no status at all — `fetch` rejects with a TypeError
  // long before any server answers. That must not read as "credential refused".
  it('keeps the session when the request never reached a server', async () => {
    api.getMerchantProfile.mockRejectedValue(new TypeError('Failed to fetch'));
    await boot();
    expect(api.logout).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('Test Merchant'));
  });

  // The other direction, which matters just as much: a credential the server
  // has actually rejected must NOT be kept alive by this change.
  for (const status of [401, 403]) {
    it(`still signs out on ${status} — the server rejected the credential`, async () => {
      api.getMerchantProfile.mockRejectedValue(refusal(status, 'Session expired'));
      await boot();
      await waitFor(() => expect(api.logout).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('SIGNED OUT'));
    });
  }

  /**
   * ── A new device, and nothing cached to fall back to ────────────────────
   * Keeping the token was only half of it. With no `merchantData` in
   * localStorage the panel still had no profile, so the route guard sent the
   * merchant to the SIGN-IN FORM — and they would type their password at a
   * platform that already knew who they were and was merely busy (S14).
   *
   * Verified in a browser: valid token, no cache, profile call answered 429 →
   * "Secure operator sign-in". The panel must say the platform is unreachable
   * instead, and offer the one action that can help.
   */
  describe('a valid session with nothing cached', () => {
    beforeEach(() => { api.getCurrentMerchant.mockReturnValue(null); });

    for (const status of [429, 502, 503]) {
      it(`reports the platform unreachable on ${status}, not a sign-in`, async () => {
        api.getMerchantProfile.mockRejectedValue(refusal(status, 'busy'));
        await boot();
        expect(api.logout).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.getByTestId('unreachable').textContent).toBe('UNREACHABLE'));
      });
    }

    it('does NOT claim unreachable when the credential was rejected', async () => {
      api.getMerchantProfile.mockRejectedValue(refusal(401, 'Session expired'));
      await boot();
      await waitFor(() => expect(api.logout).toHaveBeenCalled());
      expect(screen.getByTestId('unreachable').textContent).toBe('-');
    });
  });

  it('a successful refresh replaces the cached profile', async () => {
    api.getMerchantProfile.mockResolvedValue({ merchantId: 'm1', username: 'Fresh Name' });
    await boot();
    expect(api.logout).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('Fresh Name'));
  });
});
