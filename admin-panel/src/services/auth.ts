// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Admin } from '../types';
import api from './api';

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
          // An expired challenge cannot be retried with a fresh code — the
          // password leg has to happen again, so clear it and say so.
          if ((response as any)?.twoFactorExpired) {
            set({ isLoading: false, pendingChallenge: null });
            throw new Error('Login session expired. Please sign in again.');
          }
          set({ isLoading: false });
          throw new Error((response as any)?.message || 'Invalid authentication code');
        } catch (error) {
          set({ isLoading: false });
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
        } catch {
          set({ isAuthenticated: false });
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
