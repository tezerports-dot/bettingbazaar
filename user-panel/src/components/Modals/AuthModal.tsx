// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
  /** Which door opens first. Signing up goes to the bot; signing in is a form. */
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

const AuthModal: React.FC<AuthModalProps> = ({ onClose, initialMode }) => {
  const [cfg, setCfg] = useState<BotConfig | null>(null);
  const [error, setError] = useState('');
  const [logoFailed, setLogoFailed] = useState(false);

  const { requestLoginCode, signInWithCode } = useGame();
  // Two doors, named for what they do. "First time here?" as a footnote under a
  // form asked every returning player to read a paragraph to find out they were
  // in the right place, and asked every new one to read the whole form before
  // discovering they could not use it.
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode === 'register' ? 'signup' : 'login');
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

  // Ten digits, and only ten. Every player is Indian, so +91 is fixed and shown
  // rather than typed: a country code in the box is the one way this field can
  // produce a number the lookup will not match, and the failure is silent — the
  // screen says a code was sent and none was.
  const mobileReady = mobile.length === 10;

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

        <div role="tablist" aria-label="Sign in or sign up" style={{ display: 'flex', gap: 6, padding: 4, marginBottom: 16, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 12 }}>
          {(['login', 'signup'] as const).map((m) => (
            <button
              key={m} role="tab" type="button"
              aria-selected={mode === m}
              onClick={() => { setMode(m); setError(''); setNotice(''); }}
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

        <p style={{ margin: '0 0 18px', textAlign: 'center', fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }}>
          {mode === 'login'
            ? 'No password. We send a six-digit code to your Telegram — type it here.'
            : 'Signing up happens in our Telegram bot: it verifies your number and takes your Aadhaar. One minute, once.'}
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

        {mode === 'login' && (step === 'mobile' ? (
          <form onSubmit={sendCode} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label htmlFor="bb-mobile" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text3)' }}>
              Mobile number
            </label>
            <div style={{ display: 'flex' }}>
              <span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', height: 48, padding: '0 12px', borderRadius: '12px 0 0 12px', border: '1px solid var(--line2)', background: 'var(--surface2)', color: 'var(--text3)', fontSize: 15, flex: '0 0 auto' }}>
                +91
              </span>
            <input
              id="bb-mobile" name="mobile" value={mobile}
              onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
              inputMode="numeric" autoComplete="tel-national" autoFocus
              placeholder="98765 43210"
              style={{ ...FIELD, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 'none' }}
            />
            </div>
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

            {/* A code that never arrives was a dead end: the screen said one had
                been sent and offered nothing else. The reason is almost always
                that the Telegram account they signed up with is gone — which is
                what recovery is for, and it needs this same mobile plus the
                Aadhaar behind it. */}
            {cfg?.recoveryBotUsername && (
              <p style={{ margin: '4px 0 0', textAlign: 'center', fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
                Code never arrives? You may have lost the Telegram account you signed up with.{' '}
                <a href={`https://t.me/${cfg.recoveryBotUsername}`} target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--gold-ink)' }}>
                  Recover your account
                </a>
              </p>
            )}
          </form>
        ))}

        {/* ── Signing up ─────────────────────────────────────────────────────
            Still the bot, and it has to be: the contact share is what proves
            the number, which is what the Aadhaar is then verified against, and
            a bot cannot message somebody who has never started a chat with it.

            Its own tab rather than a footnote under the form. As a footnote it
            asked every returning player to read a paragraph to learn they were
            already in the right place, and every new one to read a form they
            could not use. */}
        {mode === 'signup' && (
          <div>
            <ol style={{ margin: '0 0 16px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 9 }}>
              {[
                'Open the bot and tap Start',
                'Send your 12-digit Aadhaar number',
                'Tap “Share my contact” to confirm your mobile',
                'Join our official channel',
              ].map((stepText, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>
                  <span className="font-grotesk" style={{ flex: '0 0 auto', width: 20, height: 20, borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--line2)', color: 'var(--gold-ink)', fontSize: 10, fontWeight: 800, display: 'grid', placeItems: 'center' }}>{i + 1}</span>
                  <span>{stepText}</span>
                </li>
              ))}
            </ol>

            {!cfg && !error && (
              <div aria-busy="true" style={{ height: 50, borderRadius: 13, background: 'var(--surface2)', border: '1px solid var(--line2)', display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--text3)' }}>
                Loading…
              </div>
            )}

            {cfg && (
              <a
                href={botUrl} target="_blank" rel="noopener noreferrer"
                style={{ ...GOLD, textDecoration: 'none' }}
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M21.9 4.3 18.6 20a1.2 1.2 0 0 1-1.9.7l-4.6-3.4-2.2 2.2a.7.7 0 0 1-1.2-.4l-.5-4.1 8.6-7.8c.3-.3-.1-.5-.5-.2L5.7 13.5 1.9 12.3c-.9-.3-.9-1.5.1-1.9l18.4-7.1c.8-.3 1.6.3 1.5 1z" />
                </svg>
                Sign up with @{cfg.botUsername}
              </a>
            )}

            <p style={{ margin: '12px 0 0', textAlign: 'center', fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.6 }}>
              Already signed up? <button type="button" onClick={() => { setMode('login'); setError(''); setNotice(''); }}
                style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--gold-ink)', fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline' }}>
                Log in instead
              </button>
            </p>
          </div>
        )}

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
