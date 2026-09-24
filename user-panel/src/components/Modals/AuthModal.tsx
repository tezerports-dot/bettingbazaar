// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * AuthModal.tsx — the signup form and the login form.
 *
 * ── What this replaced (owner decision, 2026-09-23) ────────────────────────
 * Signing up happened inside a Telegram bot — /start, type your Aadhaar to the
 * bot, share your contact — and signing in was a six-digit code the same bot
 * DMed. Every step depended on a third party that suspends gambling bots, rate
 * limits at roughly thirty messages a second per bot, and cannot message
 * anybody who has not opened a chat with it first.
 *
 * So both are forms this platform owns. Telegram keeps the one job it is good
 * at — proving a phone number belongs to the person holding it, and carrying
 * the channel — and that happens AFTER the account exists, behind the
 * verification gate (`VerificationGateModal`).
 *
 * ── The signup form ────────────────────────────────────────────────────────
 *   1. Aadhaar number          5. captcha (invisible unless Turnstile is set up)
 *   2. Aadhaar-linked mobile   6. invite code
 *   3. password
 *   4. confirm password
 *
 * The invite code is PRE-FILLED and NON-EDITABLE when the player arrived
 * through a referral link. That is the owner's requirement and it has a reason:
 * a code somebody retypes is a code that can be mistyped, and a mistyped code
 * silently costs the referrer their earning. When it is pre-filled the screen
 * also CONFIRMS it — "Invited by player3210" — because a field nobody can
 * change had better be right.
 *
 * ── The login form says nothing about the number ───────────────────────────
 * Registered, unregistered, blocked, or a wrong password all produce the same
 * screen for the two the server answers identically. A login form that says
 * "no such account" is a way to test whether a given person gambles here.
 *
 * ── Every refusal names the FIELD ──────────────────────────────────────────
 * The server's messages do (§32 S14) and this screen shows them verbatim rather
 * than replacing them with one of its own. "Enter the 10-digit mobile number
 * linked to that Aadhaar, without +91" is the difference between a player
 * fixing their entry and a player trying the same thing again.
 */
import React, { useEffect, useRef, useState } from 'react';
import { storedReferralCode } from '../../services/referralCapture';
import { useGame } from '../../services/GameContext';
import { getBackend } from '../../services/backend.service';
import { useRetryCountdown } from '../../hooks/useRetryCountdown';

interface AuthModalProps {
  onClose?: () => void;
  initialMode?: 'login' | 'register';
}

function resolveLogo(): string {
  try {
    const b = JSON.parse(localStorage.getItem('app_branding') || '{}');
    const cdn = (b.cdnBaseUrl || '').replace(/\/+$/, '');
    if (b.logo) return b.logo.startsWith('http') ? b.logo : cdn + '/' + String(b.logo).replace(/^\/+/, '');
  } catch { /* ignore */ }
  return '/app-assets/logo-header.png';
}

const FIELD: React.CSSProperties = {
  width: '100%', height: 48, borderRadius: 12, border: '1px solid var(--line2)',
  background: 'var(--surface2)', color: 'var(--text)', padding: '0 14px',
  fontSize: 15, outline: 'none', boxSizing: 'border-box',
};
const GOLD: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
  width: '100%', height: 50, borderRadius: 13, border: 'none', fontWeight: 800,
  fontSize: 14, letterSpacing: '.04em', color: '#1a1200',
  background: 'linear-gradient(135deg,var(--gold2),var(--gold))',
  boxShadow: '0 8px 22px -8px var(--glow)',
};
const LABEL: React.CSSProperties = {
  display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 700,
  letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)',
};

/**
 * A labelled field.
 *
 * Declared at MODULE level, never inside the component. A component declared
 * inside another is a new component TYPE on every parent render, so React
 * unmounts and remounts it — and typing, which re-renders the parent, takes the
 * caret with it. `FakeWinnersManager` shipped exactly that and typing "Rahul"
 * left the field holding "R" (§32 S23).
 *
 * `htmlFor`/`id` are not decoration either: 124 labels on this platform sat
 * next to the control they named with neither, so the text was on screen and
 * the control was not ADDRESSABLE by it — unusable to a screen reader and
 * untestable by name, which turn out to have one cause (§32 S24).
 */
const Field: React.FC<{
  id: string; label: string; hint?: string;
  value: string; onChange: (v: string) => void;
  type?: string; inputMode?: 'numeric' | 'text'; autoComplete?: string;
  placeholder?: string; maxLength?: number; disabled?: boolean; prefix?: string;
  autoFocus?: boolean;
}> = ({ id, label, hint, value, onChange, type = 'text', inputMode, autoComplete,
        placeholder, maxLength, disabled, prefix, autoFocus }) => (
  <div>
    <label htmlFor={id} style={LABEL}>{label}</label>
    <div style={{ display: 'flex' }}>
      {prefix && (
        <span aria-hidden="true" style={{
          display: 'grid', placeItems: 'center', height: 48, padding: '0 12px',
          borderRadius: '12px 0 0 12px', border: '1px solid var(--line2)',
          background: 'var(--surface2)', color: 'var(--text3)', fontSize: 15, flex: '0 0 auto',
        }}>{prefix}</span>
      )}
      <input
        id={id} name={id} value={value} type={type} inputMode={inputMode}
        autoComplete={autoComplete} placeholder={placeholder} maxLength={maxLength}
        disabled={disabled} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        style={{
          ...FIELD,
          ...(prefix ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 'none' } : {}),
          ...(disabled ? { opacity: 0.75, cursor: 'not-allowed' } : {}),
        }}
      />
    </div>
    {hint && <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>{hint}</p>}
  </div>
);

const digits = (v: string, max: number) => v.replace(/\D/g, '').slice(0, max);

/**
 * The ten digits of an Indian mobile, whatever the player typed around them.
 *
 * ── The defect this exists for, found by typing into the box ──────────────
 * `digits(v, 10)` alone turns `+91 98765 43210` into `9198765432`: ten digits,
 * starting with a 9, indistinguishable from a real number to every check on
 * both sides. The account is created on a number that is not theirs, the
 * Telegram contact share then matches nothing FOREVER, and the player sits at
 * the verification gate with no way to find out why — `users.mobile` is never
 * mutable (§2), so it is not even fixable without support.
 *
 * The `+91` is printed beside the box, so typing it again is an ordinary
 * mistake rather than a careless one. Two consequences: the input's own
 * maxLength has to allow the longer entry (capping at 10 truncates before this
 * function ever sees the 91), and this reduction has to match the server's.
 *
 * §5 MIRROR: the same rule as `normalisePhone` in
 * `backend/domains/identity/signupFields.js`, which is the owner. It is
 * duplicated rather than imported because §15 forbids a panel importing from
 * `backend/`. If that function changes, change this one in the same commit —
 * a client that normalises differently from the server produces exactly the
 * silent mismatch described above.
 */
function indianMobile(raw: string): string {
  // Up to TWELVE, not ten. This runs on every keystroke and the state it
  // returns is what the next keystroke appends to, so a cap at ten throws away
  // the tail before the 91 can ever be recognised: `+91 98765 4321` is already
  // `9198765432` at ten characters, and the final `0` lands on a full box. That
  // is exactly how the box produced a wrong-but-plausible number, and it is why
  // the intermediate lengths below are allowed to stand.
  //
  // The submit button is gated on a length of exactly ten, so an 11- or
  // 12-digit intermediate cannot be submitted.
  const d = raw.replace(/\D/g, '').slice(0, 12);
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  return d;
}

const AuthModal: React.FC<AuthModalProps> = ({ onClose, initialMode }) => {
  const { register, signIn, signInWithSecondFactor } = useGame();

  const [mode, setMode] = useState<'login' | 'signup'>(initialMode === 'register' ? 'signup' : 'login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [logoFailed, setLogoFailed] = useState(false);

  /**
   * The login pace, shown as a live countdown.
   *
   * `/login` is paced at one attempt per ten seconds and it keys on the MOBILE,
   * not the address — which is the right choice, because it paces per account
   * rather than per connection. The consequence for this screen is that a
   * player who mistypes their password and immediately retries WILL hit it, and
   * without a countdown they see a refusal beside a button that still looks
   * pressable. They press it, extend the window, and the form reads as broken
   * rather than throttled.
   *
   * Only on LOGIN. `/register` carries no pace limiter (it submits no secret),
   * and its own ceiling is measured in accounts per hour — a 3,600-second
   * countdown on a signup form would be absurd, so that refusal is shown as the
   * sentence it is.
   */
  const pace = useRetryCountdown();

  // ── Signup ────────────────────────────────────────────────────────────────
  const [aadhaar, setAadhaar] = useState('');
  const [signupMobile, setSignupMobile] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  /**
   * The invite code, and whether the player may edit it.
   *
   * `storedReferralCode()` is what the referral link captured on arrival. Its
   * PRESENCE is what locks the field — not a separate flag — so the two cannot
   * disagree about whether this signup came through a link.
   */
  const linkedCode = storedReferralCode();
  const [invite, setInvite] = useState(linkedCode || '');
  const [inviteBy, setInviteBy] = useState('');
  const [inviteBad, setInviteBad] = useState(false);

  // ── Login ─────────────────────────────────────────────────────────────────
  const [loginMobile, setLoginMobile] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [challenge, setChallenge] = useState('');
  const [otp, setOtp] = useState('');
  const otpRef = useRef<HTMLInputElement>(null);

  /**
   * Confirm the code the link brought, so a field nobody can edit is not also
   * unexplained. Runs once per code; a failure is shown rather than swallowed,
   * because a dead code is the referrer's loss and the player is the only
   * person in a position to notice.
   */
  useEffect(() => {
    if (!invite) return;
    let alive = true;
    getBackend().checkInvite(invite)
      .then((r: { valid: boolean; invitedBy?: string }) => {
        if (!alive) return;
        setInviteBy(r.invitedBy || '');
        setInviteBad(!r.valid);
      })
      .catch(() => { /* the signup itself will refuse it by name */ });
    return () => { alive = false; };
  }, [invite]);

  const signupReady = aadhaar.length === 12 && signupMobile.length === 10
    && password.length >= 8 && confirm.length > 0 && !busy;
  const loginReady = loginMobile.length === 10 && loginPassword.length > 0 && !busy && !pace.blocked;

  const submitSignup = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!signupReady) return;
    setBusy(true); setError('');
    try {
      await register({
        aadhaar, mobile: signupMobile, password, confirmPassword: confirm,
        referralCode: invite || undefined,
      });
      // Seated. The verification gate takes over from here — it is mounted
      // above every screen and reads the session this call just created.
      onClose?.();
    } catch (err) {
      // Verbatim. The server names the field that is wrong, and replacing that
      // with "Sign-up failed" is the difference between a player fixing their
      // entry and a player trying the same thing again.
      setError((err as Error)?.message || 'Could not create your account. Please try again.');
    } finally { setBusy(false); }
  };

  const submitLogin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!loginReady) return;
    setBusy(true); setError('');
    try {
      const res = await signIn(loginMobile, loginPassword);
      if (res.twoFactorRequired && res.challengeToken) {
        setChallenge(res.challengeToken);
        setOtp('');
        setTimeout(() => otpRef.current?.focus(), 0);
        return;
      }
      onClose?.();
    } catch (err) {
      // A pace refusal is not a wrong password. Saying "invalid credentials"
      // would send the player to check a password that was probably right.
      if (!pace.startFrom(err)) {
        setError((err as Error)?.message || 'Could not sign you in. Please try again.');
      } else {
        setError('');
      }
    } finally { setBusy(false); }
  };

  const submitOtp = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (otp.length !== 6 || busy) return;
    setBusy(true); setError('');
    try {
      await signInWithSecondFactor(challenge, otp);
      onClose?.();
    } catch (err) {
      setError((err as Error)?.message || 'That code is not valid.');
      setOtp('');
    } finally { setBusy(false); }
  };

  const switchTo = (m: 'login' | 'signup') => { setMode(m); setError(''); setChallenge(''); };

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 200, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', background: 'var(--app-bg)' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(900px 480px at 50% -6%, var(--glow), transparent 62%)', opacity: .5, pointerEvents: 'none' }} />
      {onClose && (
        <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 16, right: 16, width: 38, height: 38, borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 15, zIndex: 2 }}>✕</button>
      )}

      <div className="bb-rise" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 400, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 22, padding: '26px 22px', boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          {!logoFailed
            ? <img src={resolveLogo()} alt="Betting Bazaar" onError={() => setLogoFailed(true)} style={{ height: 34, width: 'auto', maxWidth: 220, objectFit: 'contain', filter: 'drop-shadow(0 2px 10px var(--glow))' }} />
            : <span className="font-grotesk" style={{ color: 'var(--gold-ink)', fontWeight: 700, fontSize: 20, letterSpacing: '.14em' }}>BETTING BAZAAR</span>}
        </div>

        <div role="tablist" aria-label="Sign in or sign up" style={{ display: 'flex', gap: 6, padding: 4, marginBottom: 16, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 12 }}>
          {(['login', 'signup'] as const).map((m) => (
            <button
              key={m} role="tab" type="button" aria-selected={mode === m}
              onClick={() => switchTo(m)}
              style={{
                flex: 1, height: 38, borderRadius: 9, border: 'none', cursor: 'pointer',
                fontSize: 12.5, fontWeight: 800, letterSpacing: '.06em',
                background: mode === m ? 'var(--surface)' : 'transparent',
                color: mode === m ? 'var(--gold-ink)' : 'var(--text3)',
                boxShadow: mode === m ? 'var(--shadow)' : 'none',
              }}
            >
              {m === 'login' ? 'Log in' : 'Sign up'}
            </button>
          ))}
        </div>

        {error && (
          <div role="alert" style={{ background: 'color-mix(in srgb,var(--red) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 10, padding: 10, textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--red)', marginBottom: 12, lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        {/* ── SIGN UP ───────────────────────────────────────────────────── */}
        {mode === 'signup' && (
          <form onSubmit={submitSignup} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field
              id="bb-aadhaar" label="Aadhaar number" value={aadhaar} autoFocus
              onChange={(v) => setAadhaar(digits(v, 12))}
              inputMode="numeric" placeholder="1234 5678 9012" maxLength={12}
              hint="12 digits. We store it encrypted and verify it in batches — nothing is uploaded."
            />
            <Field
              id="bb-signup-mobile" label="Aadhaar-linked mobile" value={signupMobile}
              onChange={(v) => setSignupMobile(indianMobile(v))}
              inputMode="numeric" autoComplete="tel-national" prefix="+91"
              placeholder="98765 43210" maxLength={14}
              hint="It must be the number linked to that Aadhaar — you will verify it on Telegram from this same number."
            />
            <Field
              id="bb-password" label="Password" value={password}
              onChange={setPassword} type="password" autoComplete="new-password"
              hint="At least 8 characters. A phrase you can remember beats a short one with symbols in it."
            />
            <Field
              id="bb-confirm" label="Confirm password" value={confirm}
              onChange={setConfirm} type="password" autoComplete="new-password"
            />
            <div>
              <Field
                id="bb-invite" label="Invite code (optional)" value={invite}
                onChange={(v) => setInvite(v.toUpperCase())}
                disabled={Boolean(linkedCode)}
                placeholder="Leave blank if you have none"
                maxLength={32}
              />
              {linkedCode && inviteBy && (
                <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--gold-ink)' }}>
                  Invited by <strong>{inviteBy}</strong> — applied automatically.
                </p>
              )}
              {linkedCode && inviteBad && (
                <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--red)' }}>
                  The invite code in your link is not recognised. You can still sign up — clear it below.
                  {' '}
                  <button type="button" onClick={() => setInvite('')}
                    style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--gold-ink)', fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline' }}>
                    Clear it
                  </button>
                </p>
              )}
            </div>

            <button type="submit" disabled={!signupReady}
              style={{ ...GOLD, cursor: signupReady ? 'pointer' : 'not-allowed', opacity: signupReady ? 1 : 0.55 }}>
              {busy ? 'Creating your account…' : 'Create account'}
            </button>

            <p style={{ margin: 0, textAlign: 'center', fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
              One more step after this: open our Telegram bot from this same mobile number and join the channel.
            </p>
          </form>
        )}

        {/* ── LOG IN ────────────────────────────────────────────────────── */}
        {mode === 'login' && !challenge && (
          <form onSubmit={submitLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field
              id="bb-login-mobile" label="Mobile number" value={loginMobile} autoFocus
              onChange={(v) => setLoginMobile(indianMobile(v))}
              inputMode="numeric" autoComplete="tel-national" prefix="+91"
              placeholder="98765 43210" maxLength={14}
            />
            <Field
              id="bb-login-password" label="Password" value={loginPassword}
              onChange={setLoginPassword} type="password" autoComplete="current-password"
            />
            <button type="submit" disabled={!loginReady}
              style={{ ...GOLD, cursor: loginReady ? 'pointer' : 'not-allowed', opacity: loginReady ? 1 : 0.55 }}>
              {pace.blocked ? `Try again in ${pace.secondsLeft}s` : busy ? 'Signing in…' : 'Log in'}
            </button>
            <p style={{ margin: 0, textAlign: 'center', fontSize: 11.5, color: 'var(--text3)' }}>
              New here?{' '}
              <button type="button" onClick={() => switchTo('signup')}
                style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--gold-ink)', fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline' }}>
                Create an account
              </button>
            </p>
          </form>
        )}

        {/* ── SECOND FACTOR ─────────────────────────────────────────────── */}
        {mode === 'login' && challenge && (
          <form onSubmit={submitOtp} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label htmlFor="bb-otp" style={LABEL}>Authenticator code</label>
            <input
              ref={otpRef} id="bb-otp" name="one-time-code" value={otp}
              onChange={(e) => setOtp(digits(e.target.value, 6))}
              inputMode="numeric" autoComplete="one-time-code" placeholder="000000"
              style={{ ...FIELD, textAlign: 'center', fontSize: 22, letterSpacing: '.35em', fontFamily: 'monospace', height: 56 }}
            />
            <button type="submit" disabled={otp.length !== 6 || busy}
              style={{ ...GOLD, cursor: (otp.length === 6 && !busy) ? 'pointer' : 'not-allowed', opacity: (otp.length === 6 && !busy) ? 1 : 0.55 }}>
              {busy ? 'Checking…' : 'Verify'}
            </button>
            <button type="button" onClick={() => { setChallenge(''); setError(''); }}
              style={{ background: 'transparent', border: 'none', color: 'var(--text3)', fontSize: 11.5, cursor: 'pointer', padding: '6px 0' }}>
              ← Back
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default AuthModal;
