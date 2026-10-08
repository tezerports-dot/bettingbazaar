// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Operator sign-in and merchant application — design handoff
// "BB Merchant Panel.dc.html". A merchant's settlement rail is assigned by an
// admin after approval, so it is deliberately not asked for here.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { Lock, Smartphone, Mail, User as UserIcon, ShieldCheck, CheckCircle, Send } from 'lucide-react';
import { useAuth, type TelegramChallenge } from '../services/AuthContext';
import { useRetryCountdown } from '../hooks/useRetryCountdown';
import { useTelegramPoll } from '../hooks/useTelegramPoll';
import { api } from '../services/api';
import { APP_CONFIG, ROUTES } from '../constants';
import type { AuthResponse, MiniAppSetup, TelegramLink } from '../types';
import { Banner, Button, Field, Logo, Spinner, inputStyle } from '../components/ui';
import { TelegramStep } from '../components/TelegramStep';
import { PlatformUnreachable } from '../components/PlatformUnreachable';

type Tab = 'login' | 'signup';

const MIN_PASSWORD_LENGTH = 8; // backend: merchant.routes.js POST /auth/signup

/** What the screen is waiting on in Telegram. */
type Wait =
  /** A VERIFY or LOGIN challenge, polled at `/login/2fa` (sign-in or signup). */
  | { kind: 'challenge'; challenge: TelegramChallenge; from: Tab }
  /** "Login with Telegram", polled at `/login/telegram/complete`. */
  | { kind: 'telegram-login'; challengeToken: string; telegram: TelegramLink | null; message: string };

/** The finished-but-not-signed-in screen: an application in, or a verified merchant awaiting approval. */
interface Notice { title: string; body: string; }

/** The body `request()` attaches to a refusal. */
type Refusal = { status?: number; message?: string; data?: { code?: string; verified?: boolean; message?: string } };

const refusalText = (err: unknown, fallback: string): string => {
  const e = err as Refusal;
  return (typeof e?.data?.message === 'string' && e.data.message) || e?.message || fallback;
};

const LoginPage: React.FC = () => {
  const { merchant, loading: authLoading, login, acceptSession, unreachable, refreshProfile } = useAuth();
  const [tab, setTab] = useState<Tab>('login');

  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Sign-in is paced at one attempt per 10 seconds. Without a visible timer a
  // 429 reads as a broken form, and the natural response — retry immediately —
  // extends the window it is trying to escape.
  const { secondsLeft, blocked, startFrom } = useRetryCountdown();

  // Why the panel just signed this merchant out — a suspension, a session
  // ended elsewhere — in the server's words, so the form is not the first and
  // only thing they see (§32 S48). Read once per page load.
  const [signedOutReason] = useState(() => api.signedOutReason());

  const [form, setForm] = useState({ username: '', mobile: '', email: '', password: '', confirmPassword: '' });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // ── Telegram ──────────────────────────────────────────────────────────────
  // Whether the platform's bot is set up, and the "Forgot password" link.
  // Unknown (null) hides both buttons, as `available: false` does.
  const [setup, setSetup] = useState<MiniAppSetup | null>(null);
  useEffect(() => {
    let live = true;
    api.getMiniAppSetup().then((s) => { if (live) setSetup(s); }).catch(() => { /* hidden, as unavailable */ });
    return () => { live = false; };
  }, []);

  const [wait, setWait] = useState<Wait | null>(null);
  const [waitError, setWaitError] = useState<string | null>(null);
  const [startingTelegram, setStartingTelegram] = useState(false);
  /** An approved "Login with Telegram" token the password now completes. */
  const [telegramApproved, setTelegramApproved] = useState<string | null>(null);

  const endWait = useCallback(() => { setWait(null); setWaitError(null); }, []);

  const challengeToken = wait?.kind === 'challenge' ? wait.challenge.challengeToken : null;
  const challengePoll = useMemo(
    () => (challengeToken && !waitError ? () => api.pollLoginChallenge(challengeToken) : null),
    [challengeToken, waitError],
  );
  useTelegramPoll<AuthResponse>(challengePoll, {
    onDone: (session) => { endWait(); acceptSession(session); },
    onError: (err) => {
      const e = err as Refusal;
      // Verified, and the account still waits for an admin: that is the
      // signup finishing, not a failure.
      if (e?.status === 403 && e.data?.code === 'MERCHANT_NOT_ACTIVE' && e.data.verified) {
        endWait();
        setNotice({ title: 'Mobile verified', body: 'Verified. Your account is waiting for approval.' });
        return;
      }
      setWaitError(refusalText(err, 'Telegram approval failed. Please sign in again.'));
    },
  });

  const telegramLoginToken = wait?.kind === 'telegram-login' ? wait.challengeToken : null;
  const telegramLoginPoll = useMemo(
    () => (telegramLoginToken && !waitError ? () => api.pollTelegramLogin(telegramLoginToken) : null),
    [telegramLoginToken, waitError],
  );
  useTelegramPoll<true>(telegramLoginPoll, {
    onDone: () => {
      setTelegramApproved(telegramLoginToken);
      endWait();
      setTab('login');
    },
    onError: (err) => setWaitError(refusalText(err, 'Telegram sign-in failed. Please try again.')),
  });

  if (!authLoading && merchant) return <Navigate to={ROUTES.DASHBOARD} replace />;
  /**
   * `ROUTES.LOGIN` is `/`, and it is the path a merchant lands on — so this
   * screen, not `ProtectedRoute`, is where a held session with no profile
   * behind it is actually seen. Guarding only the protected routes left the
   * sign-in form showing to signed-in merchants, which a green unit test did
   * not notice and a browser did.
   */
  if (!authLoading && !merchant && unreachable) {
    return <PlatformUnreachable onRetry={refreshProfile} />;
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSigningIn(true);
    setLoginError(null);
    try {
      const step = await login({ mobile, password, challengeToken: telegramApproved ?? undefined });
      setTelegramApproved(null);
      if (step) {
        setWaitError(null);
        setWait({ kind: 'challenge', challenge: step, from: 'login' });
      }
    } catch (err) {
      // Shown in the server's words. A pace refusal also starts the
      // countdown, so the button says how long rather than just refusing again.
      startFrom(err);
      setLoginError(refusalText(err, 'Login failed'));
    } finally {
      setSigningIn(false);
    }
  };

  const handleTelegramLogin = async () => {
    setStartingTelegram(true);
    setLoginError(null);
    try {
      const opened = await api.startTelegramLogin();
      setWaitError(null);
      setTelegramApproved(null);
      setWait({ kind: 'telegram-login', challengeToken: opened.challengeToken, telegram: opened.telegram, message: opened.message || '' });
    } catch (err) {
      setLoginError(refusalText(err, 'Telegram sign-in failed. Please try again.'));
    } finally {
      setStartingTelegram(false);
    }
  };

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    setApplyError(null);
    if (form.password !== form.confirmPassword) { setApplyError('Passwords do not match'); return; }
    if (form.password.length < MIN_PASSWORD_LENGTH) { setApplyError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`); return; }
    setApplying(true);
    try {
      const res = await api.merchantSignup({
        username: form.username,
        mobile: form.mobile,
        email: form.email || undefined,
        password: form.password,
        confirmPassword: form.confirmPassword,
      });
      if (!res.success) { setApplyError(res.message || 'Application failed'); return; }
      if (res.challengeToken && res.telegram) {
        setWaitError(null);
        setWait({
          kind: 'challenge', from: 'signup',
          challenge: { challengeToken: res.challengeToken, telegram: res.telegram, message: res.message, verify: true },
        });
      } else {
        // No bot set up yet (`verificationAvailable: false`): the server says
        // what happens next — verification at the first sign-in.
        setNotice({ title: 'Application submitted', body: res.message });
      }
    } catch (error) {
      setApplyError(refusalText(error, 'Application failed'));
    } finally {
      setApplying(false);
    }
  };

  const tabStyle = (value: Tab): React.CSSProperties => ({
    flex: 1, padding: 10, border: 0, borderRadius: 11, cursor: 'pointer', fontSize: 13, fontWeight: 700,
    background: tab === value ? 'var(--surface)' : 'transparent',
    color: tab === value ? 'var(--brand)' : 'var(--muted)',
    boxShadow: tab === value ? 'var(--shadow)' : 'none',
    transition: 'background .15s ease, color .15s ease',
  });

  const iconStyle: React.CSSProperties = { position: 'absolute', left: 13, top: 12, color: 'var(--muted)' };
  const withIcon: React.CSSProperties = { ...inputStyle, padding: '12px 14px 12px 40px', fontSize: 14, borderRadius: 12 };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      padding: '32px 22px', background: 'linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%)',
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 26 }}>
          <Logo size={56} radius={16} />
          <h1 style={{ margin: '18px 0 4px', fontSize: 23, fontWeight: 800, letterSpacing: '-.5px', color: 'var(--text)' }}>
            BB Token
          </h1>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-2)' }}>Merchant Panel</p>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, padding: '6px 12px',
            background: 'var(--dep-bg)', borderRadius: 20,
          }}>
            <ShieldCheck size={13} style={{ color: 'var(--dep)' }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--dep)' }}>Secure operator sign-in</span>
          </div>
        </div>

        {signedOutReason && (
          <div role="alert" style={{
            marginBottom: 16, padding: '12px 14px', borderRadius: 12, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5,
            background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--border)',
          }}>
            You were signed out: {signedOutReason}
          </div>
        )}

        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20,
          boxShadow: 'var(--shadow)', overflow: 'hidden',
        }}>
          {/* The tab strip is hidden while Telegram is awaited: the password
              has already been accepted, and wandering to the other tab would
              silently abandon a challenge that expires in minutes. */}
          {!wait && !notice && (
          <div style={{ display: 'flex', padding: 6, gap: 4, background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
            <button type="button" onClick={() => setTab('login')} style={tabStyle('login')}>Login</button>
            <button type="button" onClick={() => setTab('signup')} style={tabStyle('signup')}>Apply as Merchant</button>
          </div>
          )}

          <div style={{ padding: '22px 22px 24px' }}>
            {wait ? (
              <TelegramStep
                title={wait.kind === 'telegram-login'
                  ? 'Login with Telegram'
                  : wait.challenge.verify ? 'Verify your mobile in Telegram' : 'Approve in Telegram'}
                body={(wait.kind === 'telegram-login' ? wait.message : wait.challenge.message)
                  || 'Open the link on your phone, approve in Telegram, then come back here.'}
                telegram={wait.kind === 'telegram-login' ? wait.telegram : wait.challenge.telegram}
                waiting={!waitError}
                error={waitError}
                onBack={endWait}
                backLabel={wait.kind === 'challenge' && wait.from === 'signup' ? 'Back to login' : 'Back to sign in'}
              />
            ) : notice ? (
              <div style={{ textAlign: 'center', padding: '14px 0' }}>
                <CheckCircle size={44} style={{ color: 'var(--ok)' }} />
                <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', margin: '12px 0 6px' }}>
                  {notice.title}
                </div>
                <p role="status" style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 18px' }}>
                  {notice.body} An admin reviews your application and assigns your settlement rail — INR or USDT.
                  You can sign in once it is approved.
                </p>
                <Button variant="outline" tone="neutral" full onClick={() => { setNotice(null); setTab('login'); }} style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
                  Back to login
                </Button>
              </div>
            ) : tab === 'login' ? (
              <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {telegramApproved && (
                  <Banner tone="ok" title="Telegram confirmed it is you">
                    Enter your mobile number and password to finish.{' '}
                    <button type="button" onClick={() => setTelegramApproved(null)} style={{
                      background: 'none', border: 0, padding: 0, color: 'var(--brand)', fontWeight: 700, cursor: 'pointer',
                    }}>
                      Cancel
                    </button>
                  </Banner>
                )}
                <Field label="Mobile number" htmlFor="login-mobile">
                  <div style={{ position: 'relative' }}>
                    <Smartphone size={17} style={iconStyle} />
                    <input
                      id="login-mobile"
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value)}
                      placeholder="10-digit mobile"
                      inputMode="numeric"
                      autoComplete="username"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Password" htmlFor="login-password">
                  <div style={{ position: 'relative' }}>
                    <Lock size={17} style={iconStyle} />
                    <input
                      id="login-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter password"
                      autoComplete="current-password"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                {loginError && (
                  <div role="alert" style={{
                    padding: '10px 12px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, lineHeight: 1.5,
                    background: 'var(--danger-bg)', color: 'var(--danger)',
                  }}>
                    {loginError}
                  </div>
                )}
                <Button type="submit" full busy={signingIn} disabled={!mobile || !password || blocked} style={{ padding: 13, fontSize: 14, borderRadius: 12 }}>
                  {blocked ? `Try again in ${secondsLeft}s` : signingIn ? 'Signing in…' : 'Sign in securely'}
                </Button>
                {setup?.available && !telegramApproved && (
                  <Button variant="outline" full busy={startingTelegram} onClick={handleTelegramLogin} style={{ padding: 12, fontSize: 13.5, borderRadius: 12 }}>
                    <Send size={15} /> Login with Telegram
                  </Button>
                )}
                {setup?.available && setup.resetUrl && (
                  <a href={setup.resetUrl} target="_blank" rel="noopener noreferrer" style={{
                    textAlign: 'center', fontSize: 12.5, fontWeight: 700, color: 'var(--brand)',
                  }}>
                    Forgot password?
                  </a>
                )}
                <p style={{ margin: 0, textAlign: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
                  Trouble signing in? Contact your operations admin.
                </p>
              </form>
            ) : (
              <form onSubmit={handleApply} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                <div style={{
                  display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 13px',
                  background: 'var(--warn-bg)', border: '1px solid var(--warn)', borderRadius: 12,
                }}>
                  <ShieldCheck size={16} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--warn)', lineHeight: 1.5 }}>
                    Applications are reviewed by an admin before you can sign in. You verify your
                    mobile in Telegram right after applying.
                  </span>
                </div>
                <Field label="Username" htmlFor="apply-username">
                  <div style={{ position: 'relative' }}>
                    <UserIcon size={17} style={iconStyle} />
                    <input
                      id="apply-username"
                      value={form.username}
                      onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                      placeholder="Choose a username"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Mobile number" htmlFor="apply-mobile">
                  <div style={{ position: 'relative' }}>
                    <Smartphone size={17} style={iconStyle} />
                    <input
                      id="apply-mobile"
                      value={form.mobile}
                      onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))}
                      placeholder="10-digit mobile"
                      inputMode="numeric"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Email (optional)" htmlFor="apply-email">
                  <div style={{ position: 'relative' }}>
                    <Mail size={17} style={iconStyle} />
                    <input
                      id="apply-email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                      placeholder="you@example.com"
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Password" htmlFor="apply-password" hint={`Minimum ${MIN_PASSWORD_LENGTH} characters.`}>
                  <div style={{ position: 'relative' }}>
                    <Lock size={17} style={iconStyle} />
                    <input
                      id="apply-password"
                      type="password"
                      value={form.password}
                      onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                      placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`}
                      autoComplete="new-password"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                <Field label="Confirm password" htmlFor="apply-confirm">
                  <div style={{ position: 'relative' }}>
                    <Lock size={17} style={iconStyle} />
                    <input
                      id="apply-confirm"
                      type="password"
                      value={form.confirmPassword}
                      onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                      placeholder="Re-enter password"
                      autoComplete="new-password"
                      required
                      style={withIcon}
                    />
                  </div>
                </Field>
                {applyError && (
                  <div role="alert" style={{
                    padding: '10px 12px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, lineHeight: 1.5,
                    background: 'var(--danger-bg)', color: 'var(--danger)',
                  }}>
                    {applyError}
                  </div>
                )}
                <Button type="submit" tone="brand" full busy={applying} style={{ padding: 13, fontSize: 14, borderRadius: 12 }}>
                  Submit application
                </Button>
              </form>
            )}
          </div>
        </div>

        <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 18, lineHeight: 1.6 }}>
          Authorised payment operators only. All activity is logged and monitored for compliance.
          {/* VITE_APP_VERSION is injected from package.json at build time (L-03);
              a dev build without it falls back to '—', which is worth omitting
              rather than printing as "v—". */}
          {APP_CONFIG.VERSION !== '—' && (
            <>
              <br />
              <span className="bb-mono">v{APP_CONFIG.VERSION}</span>
            </>
          )}
        </p>
      </div>

      {authLoading && (
        <div style={{ marginTop: 20 }}>
          <Spinner />
        </div>
      )}
    </div>
  );
};

export default LoginPage;
