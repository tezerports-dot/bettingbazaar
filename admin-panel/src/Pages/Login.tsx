// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Command Center sign-in: mobile + password, then a 6-digit code from an
// authenticator app (owner, 2026-10-13; staff have no Telegram). The first
// sign-in sets the app up: scan the QR (or type the key), give the first code,
// keep the ten recovery codes. Server: backend/routes.js (`loginHandler`,
// `totpLoginHandler`, `totpSetupHandler`, `totpActivateHandler`).
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowRight, KeyRound } from 'lucide-react';
import { useAuthStore } from '../services/auth';
import api, { type StaffSession, type TotpSetup } from '../services/api';
import { signedOutReason as readSignedOutReason } from '../services/signedOut';
import { useRetryCountdown } from '../hooks/useRetryCountdown';
import { refusalText } from '../utils/refusal';
import { LogoMark, getBrand } from '../components/Logo';
import { RecoveryCodes } from '../components/RecoveryCodes';
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
 *   form       mobile + password
 *   code       password accepted; the app's code (or a recovery code)
 *   setup      password accepted, no app yet: scan, then the first code
 *   recovery   the app is set up; the ten recovery codes, shown once, and the
 *              session that is held only after "I saved them"
 * The challenge lives here and nowhere else: a reload starts again (auth.ts).
 */
type Step =
  | { kind: 'form' }
  | { kind: 'code'; challengeToken: string; message: string }
  | { kind: 'setup'; challengeToken: string; message: string; setup: TotpSetup | null }
  | { kind: 'recovery'; session: StaffSession };

const inputStyle: React.CSSProperties = {
  width: '100%', height: 42, borderRadius: 10, border: '1px solid var(--input-border)',
  background: 'var(--input)', color: 'var(--text)', padding: '0 13px', fontSize: 13, outline: 'none',
};

const codeInputStyle: React.CSSProperties = {
  ...inputStyle, fontSize: 18, letterSpacing: '.2em', textAlign: 'center',
  fontFamily: "'JetBrains Mono',monospace",
};

const alertStyle: React.CSSProperties = {
  marginBottom: 14, padding: '12px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600, lineHeight: 1.5,
  background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--border)',
};

const linkButton: React.CSSProperties = {
  width: '100%', height: 38, marginTop: 8, background: 'transparent', border: 'none',
  color: 'var(--muted)', fontSize: 12, cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 7,
};

const primaryButton = (off: boolean): React.CSSProperties => ({
  width: '100%', height: 44, borderRadius: 10, background: 'var(--gold)', color: 'var(--gold-on)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 800,
  cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.6 : 1, border: 'none',
});

/** The key in groups of four, as authenticator apps print it. */
const groupedSecret = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

/**
 * One code box and its submit, for both the sign-in code and the first code of
 * a new app. Module level (§32 S23).
 */
const CodeForm: React.FC<{
  id: string;
  label: string;
  hint: string;
  allowRecovery: boolean;
  busy: boolean;
  blocked: boolean;
  secondsLeft: number;
  onSubmit: (code: string) => void;
}> = ({ id, label, hint, allowRecovery, busy, blocked, secondsLeft, onSubmit }) => {
  const [code, setCode] = useState('');
  const off = busy || blocked || !code.trim();
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!off) onSubmit(code.trim()); }}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <input
        id={id}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        inputMode={allowRecovery ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoFocus
        maxLength={allowRecovery ? 16 : 6}
        placeholder="123456"
        style={{ ...codeInputStyle, marginBottom: 8 }}
      />
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>{hint}</div>
      <button type="submit" disabled={off} style={primaryButton(off)}>
        {blocked
          ? `Try again in ${secondsLeft}s`
          : <>{busy ? 'Checking…' : 'Continue'} {!busy && <ArrowRight size={16} />}</>}
      </button>
    </form>
  );
};

export const Login: React.FC = () => {
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [loginType, setLoginType] = useState<LoginType>('admin');
  const [isLoading, setIsLoading] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [formError, setFormError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const navigate = useNavigate();
  const { login, adoptSession } = useAuthStore();
  const brand = getBrand();
  // Sign-in is paced. Without a visible timer a 429 reads as a broken form,
  // and the natural response — retry immediately — extends the window it is
  // trying to escape.
  const { secondsLeft, blocked, startFrom } = useRetryCountdown();
  // Why the panel just signed this operator out (an account blocked or closed,
  // a password changed elsewhere), in the server's words, so the form is not
  // the first and only thing they see (§32 S48). Read once per page load.
  const [signedOutReason] = useState(() => readSignedOutReason());

  /** Landing route by role. */
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
        toast.error('Your account has not been given any area yet. Ask an admin to grant permissions on the Staff screen.');
        return;
      }
      navigate(first);
    }
    toast.success('Login successful!');
  }, [navigate]);

  const signIn = useCallback((session: StaffSession) => {
    adoptSession(session);
    if (typeof session.recoveryCodesLeft === 'number') {
      const left = session.recoveryCodesLeft;
      toast(left === 0
        ? 'You used your last recovery code. Make new ones under My Authenticator now.'
        : `Recovery code used. ${left} left; make new ones under My Authenticator.`, { duration: 8000 });
    }
    routeAfterLogin();
  }, [adoptSession, routeAfterLogin]);

  const backToForm = () => { setStep({ kind: 'form' }); setStepError(null); setSaved(false); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setFormError(null);
    try {
      const answer = await login(mobile, password, loginType);
      // The password is not kept on screen once it has been accepted.
      setPassword('');
      setStepError(null);
      setStep(answer.kind === 'totpSetup'
        ? { kind: 'setup', challengeToken: answer.challengeToken, message: answer.message, setup: null }
        : { kind: 'code', challengeToken: answer.challengeToken, message: answer.message });
    } catch (error: any) {
      // A pace refusal is not a credential failure and must not be reported as
      // one — "check your credentials" sends an admin to reset a password that
      // was never wrong.
      if (!startFrom(error)) setFormError(refusalText(error, 'Login failed. Check your credentials.'));
    } finally {
      setIsLoading(false);
    }
  };

  // ── First sign-in: fetch the key and its QR once the setup step opens ──────
  const setupToken = step.kind === 'setup' && !step.setup ? step.challengeToken : null;
  useEffect(() => {
    if (!setupToken) return;
    let alive = true;
    api.auth.totpSetup(setupToken)
      .then((setup) => {
        if (alive) setStep((s) => (s.kind === 'setup' && s.challengeToken === setupToken ? { ...s, setup } : s));
      })
      .catch((error) => {
        if (alive && !startFrom(error)) setStepError(refusalText(error, 'Could not set up the authenticator. Sign in again.'));
      });
    return () => { alive = false; };
  }, [setupToken, startFrom]);

  const submitCode = async (code: string) => {
    if (step.kind !== 'code' && step.kind !== 'setup') return;
    setIsLoading(true);
    setStepError(null);
    try {
      if (step.kind === 'code') {
        signIn(await api.auth.totp(step.challengeToken, code));
      } else {
        setSaved(false);
        setStep({ kind: 'recovery', session: await api.auth.totpActivate(step.challengeToken, code) });
      }
    } catch (error: any) {
      if (!startFrom(error)) setStepError(refusalText(error, 'That code was not accepted. Try the newest one.'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', color: 'var(--text)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, overflowY: 'auto' }} className="om-fade">
      <div style={{ width: 410, maxWidth: '94vw' }}>
        {/* Brand */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 22 }}>
          <LogoMark size={52} radius={14} />
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.01em', marginTop: 13 }}>{brand.appName}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', marginTop: 3 }}>{brand.adminPanelName}</div>
        </div>

        {signedOutReason && step.kind === 'form' && (
          <div role="alert" style={alertStyle}>
            You were signed out: {signedOutReason}
          </div>
        )}

        {step.kind === 'code' && (
          <div className="card" style={{ padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Authenticator code</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>
              {step.message || 'Enter the 6-digit code from your authenticator app.'}
            </div>
            {stepError && <div role="alert" style={alertStyle}>{stepError}</div>}
            <CodeForm
              id="totp-code"
              label="Code"
              hint="Lost your phone? Type one of your recovery codes (XXXXX-XXXXX) instead."
              allowRecovery
              busy={isLoading}
              blocked={blocked}
              secondsLeft={secondsLeft}
              onSubmit={submitCode}
            />
            <button type="button" onClick={backToForm} style={linkButton}>Back to sign in</button>
          </div>
        )}

        {step.kind === 'setup' && (
          <div className="card" style={{ padding: 24 }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Set up your authenticator app</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>
              {step.message || 'Staff sign in with a code from an authenticator app.'} Scan the code below
              with Google Authenticator, Microsoft Authenticator, 1Password or any TOTP app, then enter the
              6-digit code it shows.
            </div>
            {stepError && <div role="alert" style={alertStyle}>{stepError}</div>}
            {!step.setup && !stepError && (
              <div role="status" style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>Preparing…</div>
            )}
            {step.setup && (
              <>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                  <img
                    src={step.setup.qrDataUrl}
                    alt="QR code to add this account to your authenticator app"
                    width={196}
                    height={196}
                    style={{ borderRadius: 10 }}
                  />
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>Can't scan? Type this key into the app:</div>
                <div
                  data-testid="totp-secret"
                  style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, fontWeight: 700, padding: '9px 12px', borderRadius: 9, border: '1px solid var(--border)', marginBottom: 16, wordBreak: 'break-all', userSelect: 'all' }}
                >
                  {groupedSecret(step.setup.secret)}
                </div>
                <CodeForm
                  id="totp-first-code"
                  label="Code from the app"
                  hint="The code changes every 30 seconds. Use the one showing now."
                  allowRecovery={false}
                  busy={isLoading}
                  blocked={blocked}
                  secondsLeft={secondsLeft}
                  onSubmit={submitCode}
                />
              </>
            )}
            <button type="button" onClick={backToForm} style={linkButton}>Back to sign in</button>
          </div>
        )}

        {step.kind === 'recovery' && (
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, marginBottom: 4 }}>
              <KeyRound size={17} /> Save your recovery codes
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.5 }}>
              Your authenticator app is set up. If you lose your phone, each of these codes signs you in
              once in place of an app code. They are shown only now: keep them somewhere safe, away from
              your phone.
            </div>
            <RecoveryCodes codes={step.session.recoveryCodes || []} appName={brand.appName} mobile={mobile} />
            <label htmlFor="codes-saved" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, marginBottom: 14, cursor: 'pointer' }}>
              <input id="codes-saved" type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              I saved them
            </label>
            <button
              type="button"
              disabled={!saved}
              onClick={() => signIn(step.session)}
              style={primaryButton(!saved)}
            >
              Continue <ArrowRight size={16} />
            </button>
          </div>
        )}

        {step.kind === 'form' && (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>Sign in</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 18 }}>
            Choose your role to continue
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
            <label htmlFor="mobile" style={labelStyle}>Mobile number</label>
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
            <label style={labelStyle} htmlFor="password">Password</label>
            <input id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              style={{ ...inputStyle, marginBottom: 20 }}
            />

            <button type="submit" disabled={isLoading || blocked} style={primaryButton(isLoading || blocked)}>
              {blocked
                ? `Try again in ${secondsLeft}s`
                : <>{isLoading ? 'Signing in…' : 'Sign in'} {!isLoading && <ArrowRight size={16} />}</>}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Lost your phone and your recovery codes? An admin can reset your authenticator.
            Forgot your password? Ask whoever runs the server.
          </div>
        </div>
        )}

        <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 16 }}>
          Sessions and privileged actions are logged to Audit Logs
        </div>
      </div>
    </div>
  );
};
