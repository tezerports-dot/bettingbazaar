// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * AuthModal.tsx — the sign-in door.
 *
 * There is no form here any more, because there is nothing for a player to
 * type. Signup and login both happen inside the Telegram bot: it proves the
 * phone number with a contact share, takes the Aadhaar, checks channel
 * membership, and sends back a one-time link that this app trades for a
 * session (see pages/TelegramAuthPage.tsx). The old username/password/captcha
 * form is gone along with the endpoints behind it.
 *
 * ── Why the bot username is fetched, not hard-coded ─────────────────────────
 * Telegram suspends gambling bots. When that happens an operator activates a
 * replacement from the admin panel and this button has to point at the new one
 * within the minute — not after a rebuild and redeploy of three applications,
 * during an outage where nobody can sign up.
 */
import React, { useEffect, useState } from 'react';
import { apiUrl } from '../../services/apiUrl';
import { storedReferralCode } from '../../services/referralCapture';

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

const AuthModal: React.FC<AuthModalProps> = ({ onClose }) => {
  const [cfg, setCfg] = useState<BotConfig | null>(null);
  const [error, setError] = useState('');
  const [logoFailed, setLogoFailed] = useState(false);

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
          Sign in with Telegram
        </p>
        <p style={{ margin: '0 0 20px', textAlign: 'center', fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }}>
          No password to remember. Our bot verifies you in under a minute and sends
          you a link that opens the app already signed in.
        </p>

        <ol style={{ margin: '0 0 20px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            'Open the bot and tap Start',
            'Send your 12-digit Aadhaar number',
            'Tap “Share my contact” to confirm your mobile',
            'Join our official channel',
          ].map((step, i) => (
            <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>
              <span className="font-grotesk" style={{ flex: '0 0 auto', width: 20, height: 20, borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--line2)', color: 'var(--gold-ink)', fontSize: 10, fontWeight: 800, display: 'grid', placeItems: 'center' }}>{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {error && (
          <div role="alert" style={{ background: 'color-mix(in srgb,var(--red) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 10, padding: 10, textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--red)', marginBottom: 12 }}>
            {error}
          </div>
        )}

        {!cfg && !error && (
          <div aria-busy="true" style={{ height: 52, borderRadius: 13, background: 'var(--surface2)', border: '1px solid var(--line2)', display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--text3)' }}>
            Loading…
          </div>
        )}

        {cfg && (
          <a
            href={botUrl} target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, width: '100%', height: 52, borderRadius: 13, textDecoration: 'none', fontWeight: 800, fontSize: 14, letterSpacing: '.04em', color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', boxShadow: '0 8px 22px -8px var(--glow)' }}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M21.9 4.3 18.6 20a1.2 1.2 0 0 1-1.9.7l-4.6-3.4-2.2 2.2a.7.7 0 0 1-1.2-.4l-.5-4.1 8.6-7.8c.3-.3-.1-.5-.5-.2L5.7 13.5 1.9 12.3c-.9-.3-.9-1.5.1-1.9l18.4-7.1c.8-.3 1.6.3 1.5 1z" />
            </svg>
            OPEN @{cfg.botUsername}
          </a>
        )}

        {ref && (
          <p style={{ margin: '12px 0 0', textAlign: 'center', fontSize: 11, color: 'var(--gold-ink)' }}>
            Invite code <strong className="font-grotesk">{ref}</strong> will be applied.
          </p>
        )}

        <p style={{ margin: '16px 0 0', textAlign: 'center', fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
          Already signed up? Send <strong>/start</strong> to the same bot for a fresh
          sign-in link.
          {cfg?.recoveryBotUsername && (
            <>
              <br />Lost that Telegram account?{' '}
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
