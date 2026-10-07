// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Admin } from '../types';
import api from './api';
import { endRefusedSession, forgetSignedOutReason, serverRefusal } from './signedOut';

interface AuthState {
  admin: Admin | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * Set when the password was accepted but a second factor is still owed.
   * Never persisted — see the `partialize` note on the persist config: a
   * five-minute challenge surviving a browser restart is a stale credential,
   * not a convenience.
   */
  pendingChallenge: string | null;
  /**
   * This account must hold a second factor and has not enrolled one.
   *
   * The session is REAL — the server issues it either way today — so this is
   * not an authentication state, it is an obligation the panel must not let the
   * operator walk past. It is persisted alongside the session for that reason:
   * dropping it on a page reload would turn "enrol before you do anything" into
   * "enrol unless you refresh".
   *
   * Cleared only by `clearEnrolment2FA()`, which the enrolment panel calls once
   * the server has confirmed the factor is ACTIVE.
   */
  mustEnroll2FA: boolean;
  login: (
    mobile: string,
    password: string,
    loginType?: 'admin' | 'subadmin' | 'queue_manager'
  ) => Promise<void>;
  submitTwoFactor: (code: string) => Promise<void>;
  cancelTwoFactor: () => void;
  clearEnrolment2FA: () => void;
  logout: () => Promise<void>;
  verifySession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      admin: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      pendingChallenge: null,
      mustEnroll2FA: false,

      login: async (mobile, password, loginType = 'admin') => {
        set({ isLoading: true });
        try {
          const response = await api.auth.login(mobile, password, loginType);
          // Half-done login: the password was accepted but this account holds
          // a second factor. Park the challenge and let the UI ask for a code.
          // Deliberately NOT authenticated — the challenge is not a session.
          if ((response as any)?.twoFactorRequired) {
            set({ isLoading: false, pendingChallenge: (response as any).challengeToken });
            return;
          }
          if (response.success && response.data) {
            set({
              admin: response.data.admin,
              token: response.data.token,
              isAuthenticated: true,
              isLoading: false,
              pendingChallenge: null,
              mustEnroll2FA: !!(response as any).mustEnroll2FA,
            });
          }
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      submitTwoFactor: async (code) => {
        const challenge = get().pendingChallenge;
        if (!challenge) throw new Error('Login session expired. Please sign in again.');
        set({ isLoading: true });
        try {
          const response = await api.auth.loginTwoFactor(challenge, code);
          if (response.success && response.data) {
            set({
              admin: response.data.admin,
              token: response.data.token,
              isAuthenticated: true,
              isLoading: false,
              pendingChallenge: null,
              mustEnroll2FA: !!(response as any).mustEnroll2FA,
            });
            return;
          }
          set({ isLoading: false });
          throw new Error((response as any)?.message || 'Invalid authentication code');
        } catch (error: any) {
          // A refused code and an expired challenge both come back 401, and
          // axios throws on a 401, so the server's answer is on the ERROR. The
          // check for `twoFactorExpired` used to read the response above, where
          // it never arrives: an expired challenge was kept, and every code
          // typed into it was refused with no way forward but a reload. An
          // expired one cannot take a fresh code (the password leg has to
          // happen again), so it is dropped and the form goes back to it.
          const expired = !!error?.response?.data?.twoFactorExpired;
          set({ isLoading: false, ...(expired ? { pendingChallenge: null } : {}) });
          throw error;
        }
      },

      cancelTwoFactor: () => set({ pendingChallenge: null, isLoading: false }),

      /** The factor is enrolled and ACTIVE on the server. Lift the obligation. */
      clearEnrolment2FA: () => set({ mustEnroll2FA: false }),

      logout: async () => {
        try {
          await api.auth.logout();
        } catch {}
        finally {
          // A Log out says nothing on the sign-in form, whatever an earlier
          // refusal said there on this page load (`signedOut.ts`).
          forgetSignedOutReason();
          set({ admin: null, token: null, isAuthenticated: false, pendingChallenge: null, mustEnroll2FA: false });
        }
      },

      verifySession: async () => {
        const token = get().token;
        if (!token) {
          set({ isAuthenticated: false });
          return;
        }
        try {
          const response = await api.auth.verifySession();
          if (response.success && response.data) {
            // Refreshed on every load, not just carried from login: an account
            // promoted to staff mid-session owes a factor from the promotion.
            // This also lets the obligation CLEAR itself when the server stops
            // asking — enrolling from another device, or a demotion.
            set({
              admin: response.data.admin, token, isAuthenticated: true,
              mustEnroll2FA: !!(response as any).mustEnroll2FA,
            });
          } else {
            set({ isAuthenticated: false, token: null });
          }
        } catch (err: any) {
          // ── A blip is not a logout ────────────────────────────────────
          // This used to drop `isAuthenticated` on ANY failure, so a 429, a
          // 502 during a deploy, or a dropped connection in a lift showed the
          // login form to an admin whose token was perfectly valid — and made
          // them do 2FA again over it, losing whatever they were part-way
          // through. Measured: the browser pass made enough requests to trip
          // the platform's own IP limiter, `GET /api/v1/auth/me` answered 429,
          // and every screen in the panel rendered as logged out.
          //
          // So only an explicit refusal ends the session here, and everything
          // else leaves it alone: the next request will be refused with a 401
          // if the token really is dead.
          //
          // ── A refusal is said, not just obeyed (§32 S48) ─────────────────
          // This used to clear the store and nothing else, so the route
          // guards dropped the operator at a bare sign-in form: a staff
          // account blocked or closed mid-session typed its password to learn
          // why. Both refusals now end the way the merchant panel's do (2g):
          // the server's words kept for the sign-in form, which announces
          // them. A 401 has already been ended by the response interceptor in
          // `api.ts` (every route, not only this one); a 403 ("Account
          // blocked", ACCOUNT_CLOSED, WRONG_PANEL) is ended here.
          const status = err?.response?.status;
          if (status === 401 || status === 403) {
            set({ admin: null, isAuthenticated: false, token: null, mustEnroll2FA: false });
            if (status === 403) endRefusedSession(serverRefusal(err?.response?.data));
          }
        }
      },
    }),
    {
      name: 'admin-auth',
      // pendingChallenge is deliberately excluded. It is a five-minute
      // half-authenticated credential; persisting it would leave it in
      // localStorage long after it expired, and restore a login-in-progress
      // the user never came back to finish.
      // `mustEnroll2FA` IS persisted, unlike pendingChallenge above, and for the
      // opposite reason: it is not a credential, it is an unmet obligation
      // attached to a session that survives a reload. Leaving it out would make
      // a page refresh the way past the prompt.
      partialize: (s) => ({
        admin: s.admin, token: s.token, isAuthenticated: s.isAuthenticated,
        mustEnroll2FA: s.mustEnroll2FA,
      }),
    }
  )
);
