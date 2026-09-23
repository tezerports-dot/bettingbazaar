// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import toast from 'react-hot-toast';
import { MerchantProfile, LoginCredentials } from '../types';
import { api } from './api';

interface AuthContextType {
  merchant: MerchantProfile | null;
  loading: boolean;
  login: (credentials: LoginCredentials) => Promise<void>;
  /**
   * Set when the password was accepted but a second factor is still owed.
   * Held in React state ONLY — never localStorage. It is a five-minute
   * half-authenticated credential, so persisting it would leave it readable
   * long after it expired and restore a login nobody came back to finish.
   */
  pendingChallenge: string | null;
  submitTwoFactor: (code: string) => Promise<void>;
  cancelTwoFactor: () => void;
  logout: () => void;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [merchant, setMerchant] = useState<MerchantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingChallenge, setPendingChallenge] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const initAuth = async () => {
      try {
        const isAuth = api.isAuthenticated();
        if (isAuth) {
          // First, set stale localStorage data so the UI isn't blank
          const cachedData = api.getCurrentMerchant();
          if (cachedData) setMerchant(cachedData);
          // Then immediately refresh from server so tokenBalance and status are live
          try {
            const freshData = await api.getMerchantProfile();
            if (freshData) {
              setMerchant(freshData);
              // Update localStorage with fresh data
              localStorage.setItem('merchantData', JSON.stringify(freshData));
            }
          } catch (refreshErr: any) {
            /**
             * ── A blip is not a logout ──────────────────────────────────────
             * This called `api.logout()` on ANY failure of the profile refresh,
             * under a comment saying "token may be expired". It handled every
             * case EXCEPT that one: a genuine 401 is already cleared inside
             * `request()`, which redirects before this catch ever runs.
             *
             * What actually reached here was the transient failures — a 429
             * from the global limiter (1,000 req / 15 min per IP, which several
             * merchants behind one office NAT share), a 502 while the gateway
             * restarts, a dropped connection — and `logout()` clears the token
             * and hard-navigates to the sign-in form.
             *
             * Measured in a browser, answering the profile call 429 / 502 / 401
             * and reading what the panel left behind:
             *
             *     429  →  token cleared, thrown to /merchant/ sign-in
             *     502  →  token cleared, thrown to /merchant/ sign-in
             *     401  →  token cleared, thrown to /merchant/ sign-in  (correct)
             *
             * The cost is not just the re-login. A merchant serving a PAID
             * deposit has `paidResponseMinutes` (30) before the order goes to
             * DISPUTED and the silence is counted against them as a refusal
             * (§2) — so a two-second gateway bounce can put a mark on an honest
             * merchant's streak while they are standing at the machine.
             *
             * So: the session is only given up when the SERVER says the
             * credential is no good. Anything else keeps the cached profile,
             * and the next call refreshes it. Same fix, same reasoning, as the
             * admin panel's `verifySession` — this is its sibling (§0.15).
             */
            console.warn('Merchant profile refresh failed:', refreshErr);
            const status = refreshErr?.status;
            const credentialRejected = status === 401 || status === 403;
            const isPublicRoute = ['/chat/'].some(p => window.location.pathname.startsWith(p));
            if (isPublicRoute) {
              setMerchant(null);
            } else if (credentialRejected) {
              api.logout();
              setMerchant(null);
            }
            // Otherwise: keep the session and whatever profile was cached. A
            // stale token balance for a few seconds beats being signed out
            // mid-order over a refusal that was never about this merchant.
          }
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
      } finally {
        setLoading(false);
      }
    };
    initAuth();
  }, []);

  const login = async (credentials: LoginCredentials) => {
    try {
      setLoading(true);
      const response = await api.merchantLogin(credentials.mobile, credentials.password);
      // Half-done: password accepted, OTP owed. The form swaps to the code
      // step; deliberately no session and no navigation.
      if (response.twoFactorRequired && response.challengeToken) {
        setPendingChallenge(response.challengeToken);
        return;
      }
      const merchantData = response.user || response.merchant;
      if (merchantData) {
        setMerchant(merchantData);
        setPendingChallenge(null);
        toast.success('Login successful!');
        // A merchant who has not enrolled is sent straight to enrolment: 2FA
        // is mandatory for an account that settles real money, and the
        // backend flags this rather than locking out every existing merchant
        // on deploy day.
        navigate(response.mustEnroll2FA ? '/profile?enroll2fa=1' : '/dashboard');
      }
    } catch (error: any) {
      toast.error(error.message || 'Login failed');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const submitTwoFactor = async (code: string) => {
    if (!pendingChallenge) throw new Error('Login session expired. Please sign in again.');
    try {
      setLoading(true);
      const response = await api.merchantLoginTwoFactor(pendingChallenge, code);
      const merchantData = response.user || response.merchant;
      if (response.success && merchantData) {
        setMerchant(merchantData);
        setPendingChallenge(null);
        toast.success('Login successful!');
        navigate('/dashboard');
        return;
      }
      throw new Error(response.message || 'Invalid authentication code');
    } catch (error: any) {
      // An expired challenge cannot be retried with a fresh code — the
      // password leg has to happen again, so drop it and say so plainly.
      if (/expired/i.test(error?.message || '')) setPendingChallenge(null);
      toast.error(error.message || 'Invalid authentication code');
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const cancelTwoFactor = () => setPendingChallenge(null);

  const logout = () => {
    setMerchant(null);
    setPendingChallenge(null);
    api.logout();
    
    const publicPaths = ['/chat/'];
    const isPublic = publicPaths.some(p => window.location.pathname.startsWith(p));
    if (!isPublic) {
      toast.success('Logged out');
      navigate('/');
    }
  };

  const refreshProfile = async () => {
    try {
      const freshData = await api.getMerchantProfile();
      setMerchant(freshData);
    } catch (error) {
      console.error('Failed to refresh profile:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ merchant, loading, login, pendingChallenge, submitTwoFactor, cancelTwoFactor, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
};
