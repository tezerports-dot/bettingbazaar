// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * AuthModal.tsx — the sign-in door.
 *
 * ── Signing in happens here; signing UP happens once, in the bot ────────────
 * A returning player types their mobile and the six digits the bot DMs back.
 * No redirect, no app switch, no link to click (owner decision 2026-09-08).
 *
 * The first signup still goes through the bot, and it has to: the contact share
 * is what proves the phone number, and a Telegram bot simply cannot message
 * somebody who has never started a chat with it. So the bot path is still here,
 * below the form, as what it now is — the way in for people who have not been
 * here before.
 *
 * ── The form says nothing about the number ──────────────────────────────────
 * Registered, unregistered, blocked, or a Telegram outage all produce the same
 * screen and the same sentence, because the server answers all four the same
 * way. A sign-in form that says "no such account" is a way to test whether a
 * given person gambles here.
 *
 * ── Why the bot username is fetched, not hard-coded ─────────────────────────
 * Telegram suspends gambling bots. When that happens an operator activates a
 * replacement from the admin panel and this button has to point at the new one
 * within the minute — not after a rebuild and redeploy of three applications,
 * during an outage where nobody can sign up.
 */
import React, { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../../services/apiUrl';
import { storedReferralCode } from '../../services/referralCapture';
import { useGame } from '../../services/GameContext';
import { useRetryCountdown } from '../../hooks/useRetryCountdown';

interface AuthModalProps {
  onClose?: () => void;
  /** Retained for call-site compatibility; both modes open the same bot. */
  initialMode?: 'login' | 'register';
}

interface BotConfig {
  botUsername: string;
  recoveryBotUsername: string;
  channelInviteLink: string;
}

function resolveLogo(): string {
  try {
    const b = JSON.parse(localStorage.getItem('app_branding') || '{}');
    const cdn = (b.cdnBaseUrl || '').replace(/\/+$/, '');
    if (b.logo) return b.logo.startsWith('http') ? b.logo : cdn + '/' + String(b.logo).replace(/^\/+/, '');
  } catch { /* ignore */ }
  return '/app-assets/logo-header.png';
}

const FIELD = { width: '100%', height: 48, borderRadius: 12, border: '1px solid var(--line2)', background: 'var(--surface2)', color: 'var(--text)', padding: '0 14px', fontSize: 15, outline: 'none', boxSizing: 'border-box' as const };
const GOLD = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, width: '100%', height: 50, borderRadius: 13, border: 'none', fontWeight: 800, fontSize: 14, letterSpacing: '.04em', color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', boxShadow: '0 8px 22px -8px var(--glow)' };

const AuthModal: React.FC<AuthModalProps> = ({ onClose }) => {
  const [cfg, setCfg] = useState<BotConfig | null>(null);
  const [error, setError] = useState('');
  const [logoFailed, setLogoFailed] = useState(false);

  const { requestLoginCode, signInWithCode } = useGame();
  const [step, setStep] = useState<'mobile' | 'code'>('mobile');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const codeRef = useRef<HTMLInputElement>(null);
  // Each step is paced separately on the server, so each gets its own timer —
  // one shared countdown would disable the code box because the player had just
  // asked for the code.
  const sendPace = useRetryCountdown();
  const verifyPace = useRetryCountdown();

  // Ten digits: what `normalisePhone` reduces every Indian number to, so the
  // form and the lookup agree about what a complete number is.
  const mobileReady = mobile.replace(/\D/g, '').length === 10;

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!mobileReady || busy || sendPace.blocked) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await requestLoginCode(mobile);
      setStep('code');
      setCode('');
      // The same sentence the server sends, and the same one an unregistered
      // number gets. Promising "we sent it" to a number that has no account
      // would answer the question this endpoint refuses to answer.
      setNotice('If that number is registered, we have sent a sign-in code to your Telegram.');
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch (err) {
      if (!sendPace.startFrom(err)) setError('Could not reach the server. Check your connection and try again.');
    } finally { setBusy(false); }
  };

  const submitCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (code.replace(/\D/g, '').length !== 6 || busy || verifyPace.blocked) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await signInWithCode(mobile, code);
      onClose?.();
    } catch (err) {
      // A pace refusal is not a wrong code. Saying "that code is not valid"
      // would send the player to request another one, which the pace also
      // refuses — and now the screen looks broken rather than throttled.
      if (!verifyPace.startFrom(err)) {
        setError((err as Error)?.message || 'That code is not valid. Request a new one and try again.');
        setCode('');
      }
    } finally { setBusy(false); }
  };

  useEffect(() => {
    let alive = true;
    fetch(apiUrl('/api/telegram/public-config'), { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (!alive) return;
        if (d?.success) setCfg(d);
        else setError(d?.message || 'Sign-in is unavailable right now.'); })
      .catch(() => { if (alive) setError('Could not reach the server. Check your connection and try again.'); });
    return () => { alive = false; };
  }, []);

  const ref = storedReferralCode();
  const botUrl = cfg ? `https://t.me/${cfg.botUsername}${ref ? `?start=${encodeURIComponent(ref)}` : ''}` : '';

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 200, overflowY: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', background: 'var(--app-bg)' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(900px 480px at 50% -6%, var(--glow), transparent 62%)', opacity: .5, pointerEvents: 'none' }} />
      {onClose && <button onClick={onClose} aria-label="Close" style={{ position: 'absolute', top: 16, right: 16, width: 38, height: 38, borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface2)', color: 'var(--text2)', cursor: 'pointer', fontSize: 15, zIndex: 2 }}>✕</button>}

      <div className="bb-rise" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 400, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 22, padding: '26px 22px', boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          {!logoFailed
            ? <img src={resolveLogo()} alt="Betting Bazaar" onError={() => setLogoFailed(true)} style={{ height: 34, width: 'auto', maxWidth: 220, objectFit: 'contain', filter: 'drop-shadow(0 2px 10px var(--glow))' }} />
            : <span className="font-grotesk" style={{ color: 'var(--gold-ink)', fontWeight: 700, fontSize: 20, letterSpacing: '.14em' }}>BETTING BAZAAR</span>}
        </div>

        <p style={{ margin: '0 0 6px', textAlign: 'center', fontSize: 11, fontWeight: 800, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--gold-ink)' }}>
          Sign in
        </p>
        <p style={{ margin: '0 0 18px', textAlign: 'center', fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }}>
          No password. We send a six-digit code to your Telegram — type it here.
        </p>

        {error && (
          <div role="alert" style={{ background: 'color-mix(in srgb,var(--red) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 10, padding: 10, textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--red)', marginBottom: 12 }}>
            {error}
          </div>
        )}
        {notice && !error && (
          <div role="status" style={{ background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 10, padding: 10, textAlign: 'center', fontSize: 11, color: 'var(--text2)', lineHeight: 1.5, marginBottom: 12 }}>
            {notice}
          </div>
        )}

        {step === 'mobile' ? (
          <form onSubmit={sendCode} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label htmlFor="bb-mobile" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)' }}>
              Mobile number
            </label>
            <input
              id="bb-mobile" name="mobile" value={mobile}
              onChange={(e) => setMobile(e.target.value.replace(/[^0-9+ ]/g, '').slice(0, 16))}
              inputMode="tel" autoComplete="tel" autoFocus
              placeholder="98765 43210"
              style={FIELD}
            />
            <button type="submit" disabled={!mobileReady || busy || sendPace.blocked}
              style={{ ...GOLD, cursor: (!mobileReady || busy || sendPace.blocked) ? 'not-allowed' : 'pointer', opacity: (!mobileReady || busy || sendPace.blocked) ? 0.55 : 1 }}>
              {sendPace.blocked ? `Try again in ${sendPace.secondsLeft}s` : busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label htmlFor="bb-code" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)' }}>
              Code from Telegram
            </label>
            <input
              ref={codeRef} id="bb-code" name="one-time-code" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric" autoComplete="one-time-code"
              placeholder="000000"
              style={{ ...FIELD, textAlign: 'center', fontSize: 22, letterSpacing: '.35em', fontFamily: 'monospace', height: 56 }}
            />
            <button type="submit" disabled={code.length !== 6 || busy || verifyPace.blocked}
              style={{ ...GOLD, cursor: (code.length !== 6 || busy || verifyPace.blocked) ? 'not-allowed' : 'pointer', opacity: (code.length !== 6 || busy || verifyPace.blocked) ? 0.55 : 1 }}>
              {verifyPace.blocked ? `Try again in ${verifyPace.secondsLeft}s` : busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <button type="button" onClick={() => { setStep('mobile'); setCode(''); setError(''); setNotice(''); }}
                style={{ background: 'transparent', border: 'none', color: 'var(--text3)', fontSize: 11.5, cursor: 'pointer', padding: '6px 0' }}>
                ← Change number
              </button>
              <button type="button" onClick={() => sendCode()} disabled={busy || sendPace.blocked}
                style={{ background: 'transparent', border: 'none', color: sendPace.blocked ? 'var(--text3)' : 'var(--gold-ink)', fontSize: 11.5, cursor: (busy || sendPace.blocked) ? 'not-allowed' : 'pointer', padding: '6px 0' }}>
                {sendPace.blocked ? `Resend in ${sendPace.secondsLeft}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}

        {/* ── First time here ────────────────────────────────────────────────
            Still the bot, and it has to be: the contact share is what proves
            the number, and a bot cannot message somebody who has never started
            a chat with it. Demoted below the form because it is now the
            minority path — every returning player signs in above. */}
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--line2)' }}>
          <p style={{ margin: '0 0 10px', textAlign: 'center', fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--text2)' }}>First time here?</strong>{' '}
            Sign up in our Telegram bot — it takes a minute, and you will not need
            it again.
          </p>

          {!cfg && !error && (
            <div aria-busy="true" style={{ height: 46, borderRadius: 12, background: 'var(--surface2)', border: '1px solid var(--line2)', display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--text3)' }}>
              Loading…
            </div>
          )}

          {cfg && (
            <a
              href={botUrl} target="_blank" rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, width: '100%', height: 46, borderRadius: 12, textDecoration: 'none', fontWeight: 700, fontSize: 13, color: 'var(--text)', background: 'var(--surface2)', border: '1px solid var(--line2)' }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M21.9 4.3 18.6 20a1.2 1.2 0 0 1-1.9.7l-4.6-3.4-2.2 2.2a.7.7 0 0 1-1.2-.4l-.5-4.1 8.6-7.8c.3-.3-.1-.5-.5-.2L5.7 13.5 1.9 12.3c-.9-.3-.9-1.5.1-1.9l18.4-7.1c.8-.3 1.6.3 1.5 1z" />
              </svg>
              Sign up with @{cfg.botUsername}
            </a>
          )}
        </div>

        {ref && (
          <p style={{ margin: '12px 0 0', textAlign: 'center', fontSize: 11, color: 'var(--gold-ink)' }}>
            Invite code <strong className="font-grotesk">{ref}</strong> will be applied.
          </p>
        )}

        <p style={{ margin: '16px 0 0', textAlign: 'center', fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
          {/* "Send /start for a fresh link" was the whole sign-in route and is
              now wrong — a returning player signs in with the form above and
              never opens Telegram. Only the recovery path still needs the bot,
              because taking an account back from another Telegram account is
              exactly what cannot be done from a form. */}
          Lost access to the Telegram account you signed up with?
          {cfg?.recoveryBotUsername && (
            <>
              {' '}
              <a href={`https://t.me/${cfg.recoveryBotUsername}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text2)' }}>
                Recover with @{cfg.recoveryBotUsername}
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
};

export default AuthModal;
