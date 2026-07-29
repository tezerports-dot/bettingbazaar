// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
  login: (
    mobile: string,
    password: string,
    loginType?: 'admin' | 'subadmin' | 'queue_manager'
  ) => Promise<void>;
  submitTwoFactor: (code: string) => Promise<void>;
  cancelTwoFactor: () => void;
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

      logout: async () => {
        try {
          await api.auth.logout();
        } catch {}
        finally {
          set({ admin: null, token: null, isAuthenticated: false, pendingChallenge: null });
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
            set({ admin: response.data.admin, token, isAuthenticated: true });
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
      partialize: (s) => ({ admin: s.admin, token: s.token, isAuthenticated: s.isAuthenticated }),
    }
  )
);
