// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Admin } from '../types';
import api, { type LoginAnswer, type StaffSession } from './api';
import { endRefusedSession, forgetSignedOutReason, serverRefusal } from './signedOut';

/**
 * The staff session.
 *
 * A sign-in that owes a Telegram approval is NOT held here: its challenge is a
 * few minutes' half-credential that lives in the sign-in screen's own state and
 * dies with it, so nothing persists it and a reload starts the sign-in again.
 */
interface AuthState {
  admin: Admin | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /**
   * The staff bootstrap (CLAUDE.md §33): no Telegram bot is saved yet, so this
   * session is a password alone. The server says so on every session payload
   * and on every `/me`; the Layout shows a standing banner naming the screen
   * that ends it. Persisted with the session it describes.
   */
  bootstrap: boolean;
  /**
   * The password leg. Signs in when the server answers a session; otherwise
   * returns the Telegram step for the screen to show.
   */
  login: (
    mobile: string,
    password: string,
    loginType?: 'admin' | 'subadmin' | 'queue_manager',
    challengeToken?: string,
  ) => Promise<LoginAnswer>;
  /**
   * Hold a session a Telegram poll answered. The poll itself lives in the
   * sign-in screen, which drops an answer that arrives after "Back"; only a
   * session it still wants reaches here.
   */
  adoptSession: (session: StaffSession) => void;
  logout: () => Promise<void>;
  verifySession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => {
      const adopt = (session: StaffSession) => {
        set({
          admin: session.admin,
          token: session.token,
          isAuthenticated: true,
          isLoading: false,
          bootstrap: session.bootstrap,
        });
      };

      return {
        admin: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
        bootstrap: false,

        login: async (mobile, password, loginType = 'admin', challengeToken) => {
          set({ isLoading: true });
          try {
            const answer = await api.auth.login(mobile, password, loginType, challengeToken);
            if (answer.kind === 'session') adopt(answer.session);
            else set({ isLoading: false });
            return answer;
          } catch (error) {
            set({ isLoading: false });
            throw error;
          }
        },

        adoptSession: adopt,

        logout: async () => {
          try {
            await api.auth.logout();
          } catch {}
          finally {
            // A Log out says nothing on the sign-in form, whatever an earlier
            // refusal said there on this page load (`signedOut.ts`).
            forgetSignedOutReason();
            set({ admin: null, token: null, isAuthenticated: false, bootstrap: false });
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
              set({
                admin: response.data.admin, token, isAuthenticated: true,
                bootstrap: (response as { bootstrap?: boolean }).bootstrap === true,
              });
            } else {
              set({ isAuthenticated: false, token: null });
            }
          } catch (err: any) {
            // ── A blip is not a logout ────────────────────────────────────
            // A 429, a 502 during a deploy, or a dropped connection leaves a
            // valid session alone: the next request is refused with a 401 if
            // the token really is dead. Measured: the browser pass tripped the
            // platform's own IP limiter and every screen rendered as logged out.
            //
            // ── A refusal is said, not just obeyed (§32 S48) ─────────────────
            // A 401 has already been ended by the response interceptor in
            // `api.ts`; a 403 ("Account blocked", ACCOUNT_CLOSED, WRONG_PANEL,
            // TWO_FACTOR_REQUIRED) is ended here, with the server's words kept
            // for the sign-in form.
            const status = err?.response?.status;
            if (status === 401 || status === 403) {
              set({ admin: null, isAuthenticated: false, token: null, bootstrap: false });
              if (status === 403) endRefusedSession(serverRefusal(err?.response?.data));
            }
          }
        },
      };
    },
    {
      name: 'admin-auth',
      partialize: (s) => ({
        admin: s.admin, token: s.token, isAuthenticated: s.isAuthenticated, bootstrap: s.bootstrap,
      }),
    }
  )
);
