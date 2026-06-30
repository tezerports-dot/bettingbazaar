// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Admin } from '../types';
import api from './api';

interface AuthState {
  admin: Admin | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (
    mobile: string,
    password: string,
    loginType?: 'admin' | 'subadmin' | 'queue_manager'
  ) => Promise<void>;
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

      login: async (mobile, password, loginType = 'admin') => {
        set({ isLoading: true });
        try {
          const response = await api.auth.login(mobile, password, loginType);
          if (response.success && response.data) {
            set({
              admin: response.data.admin,
              token: response.data.token,
              isAuthenticated: true,
              isLoading: false,
            });
          }
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await api.auth.logout();
        } catch {}
        finally {
          set({ admin: null, token: null, isAuthenticated: false });
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
    { name: 'admin-auth' }
  )
);
