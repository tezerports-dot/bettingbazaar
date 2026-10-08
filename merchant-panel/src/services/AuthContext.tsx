// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import toast from 'react-hot-toast';
import { MerchantProfile, LoginCredentials, AuthResponse, TelegramLink } from '../types';
import { api } from './api';

interface AuthContextType {
  merchant: MerchantProfile | null;
  loading: boolean;
  /**
   * The password leg. Resolves `null` once signed in (and navigates), or the
   * Telegram step still owed: approve this sign-in, or verify the mobile.
   * The step is held by the sign-in screen in React state ONLY, never
   * localStorage: it is a five-minute half-authenticated credential.
   */
  login: (credentials: LoginCredentials) => Promise<TelegramChallenge | null>;
  /** A session a Telegram poll answered with (`/login/2fa`): sign in with it. */
  acceptSession: (response: AuthResponse) => void;
  logout: () => void;
  refreshProfile: () => Promise<void>;
  /**
   * A session token is held, but the profile behind it could not be fetched
   * and the server never said the credential was bad — a 429, a 502, a dropped
   * connection.
   *
   * This exists because "no profile" and "not signed in" are different facts
   * and the route guard was treating them as one. A merchant on a new device
   * whose first profile call is rate-limited holds a perfectly valid session
   * and was shown the SIGN-IN FORM, so the obvious thing to do was type their
   * password — at a platform that already knew who they were and was merely
   * busy. That is S14: a screen blaming the person for the platform's state.
   */
  unreachable: boolean;
}

/**
 * The server's own refusal, and only that: a JSON body saying `success: false`.
 * A 403 page from a proxy or CDN arrives as text and would otherwise be shown
 * as "You were signed out: <html>…".
 */
const serverRefusal = (err: any): string | null =>
  err?.data && typeof err.data === 'object' && err.data.success === false && typeof err.data.message === 'string'
    ? err.data.message : null;

/** What the sign-in screen waits on in Telegram. */
export interface TelegramChallenge {
  challengeToken: string;
  telegram: TelegramLink | null;
  message: string;
  /** True: the mobile is being verified (403 TELEGRAM_VERIFICATION_REQUIRED); false: this sign-in is being approved. */
  verify: boolean;
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
  const [unreachable, setUnreachable] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const initAuth = async () => {
      try {
        const isAuth = api.isAuthenticated();
        if (isAuth) {
          // First, set stale localStorage data so the UI isn't blank
          const cachedData = api.getCurrentMerchant();
          if (cachedData) setMerchant(cachedData);
          // Then immediately refresh from server so status, pause and Ready are live
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
              // The server's own words ("Account suspended. Contact support.")
              // go with the sign-out, so the sign-in form can say why.
              api.logout(serverRefusal(refreshErr));
              setMerchant(null);
            } else if (!cachedData) {
              // The session is fine and there is nothing cached to show. Say
              // that, rather than presenting a login form to somebody who is
              // already signed in.
              setUnreachable(true);
            }
            // Otherwise: keep the session and whatever profile was cached. A
            // stale online or Ready flag for a few seconds beats being signed
            // out mid-order over a refusal that was never about this merchant.
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

  const acceptSession = (response: AuthResponse) => {
    const merchantData = response.user || response.merchant;
    if (!merchantData) return;
    setMerchant(merchantData);
    setUnreachable(false);
    toast.success('Login successful!');
    navigate('/dashboard');
  };

  const login = async (credentials: LoginCredentials): Promise<TelegramChallenge | null> => {
    try {
      setLoading(true);
      const response = await api.merchantLogin(credentials.mobile, credentials.password, credentials.challengeToken);
      // Half-done: the password was accepted and Telegram is owed. No
      // session and no navigation; the screen shows the Telegram step.
      if ((response.twoFactorRequired || response.verificationRequired) && response.challengeToken) {
        return {
          challengeToken: response.challengeToken,
          telegram: response.telegram ?? null,
          message: response.message || '',
          verify: Boolean(response.verificationRequired),
        };
      }
      acceptSession(response);
      return null;
    } finally {
      // A refusal is thrown to the sign-in screen, which shows it in the
      // server's words (role="alert").
      setLoading(false);
    }
  };

  const logout = () => {
    setMerchant(null);
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
      // Whatever was in the way has cleared. This is also the Try again button
      // on the unreachable screen, so it has to be able to take it back down.
      setUnreachable(false);
    } catch (error: any) {
      console.error('Failed to refresh profile:', error);
      const status = error?.status;
      if (status === 401 || status === 403) { api.logout(serverRefusal(error)); setMerchant(null); return; }
      if (!merchant) setUnreachable(true);
    }
  };

  return (
    <AuthContext.Provider value={{ merchant, loading, login, acceptSession, logout, refreshProfile, unreachable }}>
      {children}
    </AuthContext.Provider>
  );
};
