// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Command Center sign-in. Mobile + password, then the sign-in is approved in
// Telegram (Step 3: one Mini App bot; docs/PROJECT_STATUS.md, "API contract").
// "Login with Telegram" runs the other way round: Telegram first, then the
// password. Role-based landing is unchanged.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowRight, Send } from 'lucide-react';
import { useAuthStore } from '../services/auth';
import api, { type MiniAppInfo, type TelegramBlock } from '../services/api';
import { signedOutReason as readSignedOutReason } from '../services/signedOut';
import { useRetryCountdown } from '../hooks/useRetryCountdown';
import { useTelegramPoll, isRefusal, refusalText, type PollStep } from '../hooks/useTelegramPoll';
import { LogoMark, getBrand } from '../components/Logo';
import toast from 'react-hot-toast';

import { firstPermittedPath } from '../components/Layout';
type LoginType = 'admin' | 'subadmin' | 'queue_manager';

const ROLES: { id: LoginType; label: string }[] = [
  { id: 'admin', label: 'Super Admin' },
  { id: 'subadmin', label: 'Sub-Admin' },
  { id: 'queue_manager', label: 'Queue Manager' },
];

/**
 * Where the sign-in is.
 *   form        mobile + password (with `challengeToken` once a "Login with
 *               Telegram" has been approved and the password finishes it)
 *   approve     password accepted; approve (or verify) in Telegram, poll /login/2fa
 *   tgLogin     "Login with Telegram" opened; poll /login/telegram/complete
 */
type Step =
  | { kind: 'form'; challengeToken?: string; note?: string }
  | { kind: 'approve'; challengeToken: string; telegram: TelegramBlock | null; message: string }
  | { kind: 'tgLogin'; challengeToken: string; telegram: TelegramBlock | null; message: string };

const inputStyle: React.CSSProperties = {
  width: '100%', height: 42, borderRadius: 10, border: '1px solid var(--input-border)',
  background: 'var(--input)', color: 'var(--text)', padding: '0 13px', fontSize: 13, outline: 'none',
};

const alertStyle: React.CSSProperties = {
  marginBottom: 14, padding: '12px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600, lineHeight: 1.5,
  background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--border)',
};

const linkButton: React.CSSProperties = {
  width: '100%', height: 38, marginTop: 8, background: 'transparent', border: 'none',
  color: 'var(--muted)', fontSize: 12, cursor: 'pointer',
};

const expiresAtText = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/**
 * The "waiting on Telegram" card, for both directions. Module level (§32 S23).
 * The link is an anchor the operator presses, not a `window.open` after the
 * server answered: a browser blocks a window that no click opened.
 */
const TelegramStepCard: React.FC<{
  title: string;
  message: string;
  telegram: TelegramBlock | null;
  error: string | null;
  onBack: () => void;
}> = ({ title, message, telegram, error, onBack }) => (
  <div className="card" style={{ padding: 24 }}>
    <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>{title}</div>
    {message && (
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>{message}</div>
    )}
    {error && <div role="alert" style={alertStyle}>{error}</div>}
    {telegram?.url && !error && (
      <a
        href={telegram.url}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-primary"
        style={{ width: '100%', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none' }}
      >
        <Send size={16} /> Open Telegram{telegram.botUsername ? ` (@${telegram.botUsername})` : ''}
      </a>
    )}
    {!error && (
      <div role="status" aria-live="polite" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14, lineHeight: 1.5 }}>
        Waiting for your approval in Telegram…
        {telegram?.expiresAt && expiresAtText(telegram.expiresAt) ? ` This link works until ${expiresAtText(telegram.expiresAt)}.` : ''}
      </div>
    )}
    <button type="button" onClick={onBack} style={linkButton}>Back to sign in</button>
  </div>
);

export const Login: React.FC = () => {
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [loginType, setLoginType] = useState<LoginType>('admin');
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [formError, setFormError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [miniApp, setMiniApp] = useState<MiniAppInfo | null>(null);
  const navigate = useNavigate();
  const { login, adoptSession } = useAuthStore();
  const brand = getBrand();
  // Sign-in is paced at one attempt per 10 seconds. Without a visible timer a
  // 429 reads as a broken form, and the natural response — retry immediately —
  // extends the window it is trying to escape.
  const { secondsLeft, blocked, startFrom } = useRetryCountdown();
  // Why the panel just signed this operator out (an account blocked or closed,
  // a password changed elsewhere), in the server's words, so the form is not
  // the first and only thing they see (§32 S48). Read once per page load.
  const [signedOutReason] = useState(() => readSignedOutReason());

  // Whether Telegram is set up for staff at all: "Login with Telegram" and
  // "Forgot password" are offered only when it is. A failed read hides both.
  useEffect(() => {
    let alive = true;
    api.telegram.miniApp()
      .then((info) => { if (alive) setMiniApp(info ?? null); })
      .catch(() => { if (alive) setMiniApp(null); });
    return () => { alive = false; };
  }, []);

  /**
   * Landing route by role. Shared by every way of signing in so a Telegram
   * sign-in cannot land somewhere different from a password one.
   */
  const routeAfterLogin = useCallback(() => {
    const { admin } = useAuthStore.getState();
    if (!admin) throw new Error('Login failed');

    if (admin.isAdmin) {
      navigate('/');
    } else if (admin.isQueueManager) {
      navigate('/queue-manager');
    } else {
      // The first area they were given, in sidebar order — the same list the
      // sidebar is drawn from, so a new area needs no line here.
      const perms = (admin.permissions || {}) as Record<string, boolean>;
      const first = perms.canViewAnalytics ? '/' : firstPermittedPath((keys) => keys.some((k) => perms[k] === true));
      if (!first) {
        toast.error('Your account has not been given any area yet. Ask an admin to grant permissions on the Sub-admins screen.');
        return;
      }
      navigate(first);
    }
    toast.success('Login successful!');
  }, [navigate]);

  const backToForm = () => { setStep({ kind: 'form' }); setStepError(null); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setFormError(null);
    try {
      const answer = await login(mobile, password, loginType, step.kind === 'form' ? step.challengeToken : undefined);
      if (answer.kind === 'session') { routeAfterLogin(); return; }
      // Password accepted; Telegram is next. The password is not kept on
      // screen: re-submitting it would only open a second challenge.
      setPassword('');
      setStepError(answer.telegram ? null : (answer.message || 'Telegram is not available right now. Try again shortly.'));
      setStep({ kind: 'approve', challengeToken: answer.challengeToken, telegram: answer.telegram, message: answer.message });
    } catch (error: any) {
      // A pace refusal is not a credential failure and must not be reported as
      // one — "check your credentials" sends an admin to reset a password that
      // was never wrong.
      if (!startFrom(error)) setFormError(refusalText(error, 'Login failed. Check your credentials.'));
    } finally {
      setIsLoading(false);
    }
  };

  const startTelegramLogin = async () => {
    setIsLoading(true);
    setFormError(null);
    try {
      const opened = await api.auth.telegramLogin();
      setStepError(null);
      setStep({ kind: 'tgLogin', ...opened });
    } catch (error: any) {
      if (!startFrom(error)) setFormError(refusalText(error, 'Telegram sign-in is not available right now.'));
    } finally {
      setIsLoading(false);
    }
  };

  // ── Waiting on Telegram (one loop, `useTelegramPoll`) ─────────────────────
  const waiting = (step.kind === 'approve' || step.kind === 'tgLogin') && !stepError;
  const ask = useCallback(async (live: () => boolean): Promise<PollStep> => {
    try {
      if (step.kind === 'approve') {
        const answer = await api.auth.loginTwoFactor(step.challengeToken);
        if (!live()) return 'stop';
        if (answer.kind === 'pending') return 'again';
        adoptSession(answer.session);
        routeAfterLogin();
        return 'stop';
      }
      if (step.kind === 'tgLogin') {
        const answer = await api.auth.telegramLoginComplete(step.challengeToken);
        if (!live()) return 'stop';
        if (answer.kind === 'pending') return 'again';
        setStep({
          kind: 'form', challengeToken: step.challengeToken,
          note: 'Telegram confirmed it is you. Enter your mobile number and password to finish.',
        });
        return 'stop';
      }
      return 'stop';
    } catch (error) {
      if (!isRefusal(error)) throw error;          // a blip: ask again
      if (live()) setStepError(refusalText(error, 'This sign-in was not approved. Please sign in again.'));
      return 'stop';
    }
  }, [step, adoptSession, routeAfterLogin]);
  useTelegramPoll(ask, waiting);

  const telegramReady = miniApp?.available === true;
  const finishingTelegram = step.kind === 'form' && !!step.challengeToken;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', color: 'var(--text)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} className="om-fade">
      <div style={{ width: 410, maxWidth: '94vw' }}>
        {/* Brand */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 22 }}>
          <LogoMark size={52} radius={14} />
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.01em', marginTop: 13 }}>{brand.appName}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', marginTop: 3 }}>{brand.adminPanelName}</div>
        </div>

        {signedOutReason && (
          <div role="alert" style={alertStyle}>
            You were signed out: {signedOutReason}
          </div>
        )}

        {step.kind === 'approve' && (
          <TelegramStepCard
            title="Approve in Telegram"
            message={step.message || 'Open the link on your phone and approve this sign-in, then come back here.'}
            telegram={step.telegram}
            error={stepError}
            onBack={backToForm}
          />
        )}

        {step.kind === 'tgLogin' && (
          <TelegramStepCard
            title="Login with Telegram"
            message={step.message || 'Open Telegram to sign in, then come back here.'}
            telegram={step.telegram}
            error={stepError}
            onBack={backToForm}
          />
        )}

        {step.kind === 'form' && (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Sign in</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 18 }}>
            {step.note || 'Choose your role to continue'}
          </div>

          {formError && <div role="alert" style={alertStyle}>{formError}</div>}

          <form onSubmit={handleSubmit}>
            {/* Role picker */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              {ROLES.map((r) => {
                const active = loginType === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setLoginType(r.id)}
                    aria-pressed={loginType === r.id}
                    style={{
                      flex: 1, textAlign: 'center', padding: '11px 6px', borderRadius: 9, fontSize: 12,
                      fontWeight: 700, cursor: 'pointer', transition: 'all .15s',
                      border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                      color: active ? 'var(--gold-ink)' : 'var(--text-2)',
                      background: active ? 'var(--warning-bg)' : 'transparent',
                    }}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>

            {/* Mobile */}
            <label htmlFor="mobile" style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 7 }}>Mobile number</label>
            <div style={{ display: 'flex', alignItems: 'center', height: 42, borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input)', marginBottom: 14, overflow: 'hidden' }}>
              <span style={{ padding: '0 12px', fontSize: 13, fontWeight: 700, color: 'var(--muted)', borderRight: '1px solid var(--border)', height: '100%', display: 'flex', alignItems: 'center', fontFamily: "'JetBrains Mono',monospace" }}>+91</span>
              <input
                id="mobile"
                type="tel"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="98000 12345"
                required
                style={{ flex: 1, height: '100%', border: 'none', background: 'transparent', color: 'var(--text)', padding: '0 12px', fontSize: 13, outline: 'none', fontFamily: "'JetBrains Mono',monospace" }}
              />
            </div>

            {/* Password */}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 7 }} htmlFor="password">Password</label>
            <input id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              style={{ ...inputStyle, marginBottom: 20 }}
            />

            <button
              type="submit"
              disabled={isLoading || blocked}
              style={{
                width: '100%', height: 44, borderRadius: 10, background: 'var(--gold)', color: 'var(--gold-on)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 800,
                cursor: isLoading || blocked ? 'not-allowed' : 'pointer', opacity: isLoading || blocked ? 0.6 : 1, border: 'none',
              }}
            >
              {blocked
                ? `Try again in ${secondsLeft}s`
                : <>{isLoading ? 'Signing in…' : 'Sign in'} {!isLoading && <ArrowRight size={16} />}</>}
            </button>
          </form>

          {finishingTelegram && (
            <button type="button" onClick={backToForm} style={linkButton}>Start again</button>
          )}

          {telegramReady && !finishingTelegram && (
            <button
              type="button"
              onClick={startTelegramLogin}
              disabled={isLoading || blocked}
              className="btn"
              style={{
                width: '100%', height: 42, marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)',
                fontSize: 13, fontWeight: 700, cursor: isLoading || blocked ? 'not-allowed' : 'pointer',
              }}
            >
              <Send size={15} /> Login with Telegram
            </button>
          )}

          {telegramReady && miniApp?.resetUrl && (
            <a
              href={miniApp.resetUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'block', textAlign: 'center', marginTop: 12, fontSize: 12, color: 'var(--muted)' }}
            >
              Forgot password?
            </a>
          )}
        </div>
        )}

        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 16 }}>
          Sessions and privileged actions are logged to Audit Logs
        </div>
      </div>
    </div>
  );
};
