// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * TelegramAuthPage.tsx — where a bot login link lands.
 *
 * The bot sends `…/#/auth/telegram?token=<one-time token>`. This page trades
 * that token for a real session and then gets out of the way. It is the only
 * screen in the app whose whole job is authentication, and it is deliberately
 * dumb: one POST, one outcome, no retry loop.
 *
 * ── Why the token is scrubbed from the URL immediately ──────────────────────
 * It is single-use, so the copy in the address bar is spent the moment the
 * exchange returns — but it would still be sitting in the browser's history,
 * in a screenshot, and in whatever the user pastes when they later say "this
 * link didn't work". Replacing the entry costs nothing and removes all of that.
 *
 * ── Why a failure is not retried ────────────────────────────────────────────
 * Every failure reason — expired, already used, never valid — comes back as one
 * indistinguishable answer, on purpose. There is nothing a retry could learn
 * and nothing it could fix; the fix is always a fresh /start in the bot.
 *
 * ── Why the token is sometimes NOT spent at all ─────────────────────────────
 * A link tapped inside Telegram on Android opens in Telegram's own WebView,
 * which has its own cookie jar and its own localStorage and discards both when
 * the sheet closes. Redeeming there signs the player into a context that is
 * about to cease to exist, and burns the single-use token doing it: they close
 * the sheet, open the app, and are signed out with nothing left to retry.
 *
 * So the context is classified BEFORE the exchange, and an isolated WebView
 * gets the link handed back instead of spent. The detection deliberately fails
 * open (see inAppBrowser.ts) and this screen carries a "continue here anyway"
 * override, because wrongly stopping a sign-in is worse than wrongly allowing
 * one — the override costs a tap, and the alternative costs the account.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useGame } from '../services/GameContext';
import { isIsolatedWebView, safariEscapeUrl } from '../services/inAppBrowser';

type Phase = 'working' | 'failed' | 'handoff';

const TelegramAuthPage: React.FC = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { completeTelegramLogin } = useGame();
  const [phase, setPhase] = useState<Phase>('working');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [showLink, setShowLink] = useState(false);
  // React 18 StrictMode mounts effects twice in development. A single-use token
  // redeemed twice would burn itself and land every developer on the failure
  // screen, so the exchange is fired at most once per mount.
  const fired = useRef(false);

  /**
   * Redeem, for real. Split out because the handoff screen's override calls it
   * too — the one place a token is ever spent, reached by two paths.
   */
  const redeem = useCallback(async (token: string) => {
    setPhase('working');
    try {
      await completeTelegramLogin(token);
      // replace, not push: Back must not return to a spent token.
      navigate('/', { replace: true });
    } catch (err: any) {
      setPhase('failed');
      setMessage(err?.message
        || 'We could not sign you in. Send /start to the bot for a new link.');
    }
  }, [completeTelegramLogin, navigate]);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const token = params.get('token');
    if (!token) {
      setPhase('failed');
      setMessage('This link is missing its sign-in code. Send /start to the bot for a new one.');
      return;
    }

    // Classified BEFORE the exchange: spending the token in a WebView that is
    // about to be discarded is the one failure this page cannot undo.
    if (isIsolatedWebView()) {
      setPhase('handoff');
      return;
    }

    void redeem(token);
  }, [params, redeem]);

  const wrap: React.CSSProperties = {
    minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '32px 16px', textAlign: 'center',
  };
  const card: React.CSSProperties = {
    width: '100%', maxWidth: 380, background: 'var(--surface)', border: '1px solid var(--line2)',
    borderRadius: 22, padding: '30px 24px', boxShadow: 'var(--shadow)',
  };
  // Shared by the handoff actions and the failure screen's button, so the two
  // screens cannot drift apart visually.
  const primaryBtn: React.CSSProperties = {
    width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: 'pointer',
    fontWeight: 800, fontSize: 13, textAlign: 'center', color: '#1a1200',
    background: 'linear-gradient(135deg,var(--gold2),var(--gold))',
  };

  if (phase === 'working') {
    return (
      <div style={wrap}>
        <div style={card} aria-busy="true">
          <div className="bb-spin" style={{ width: 34, height: 34, margin: '0 auto 16px', borderRadius: '50%', border: '3px solid var(--line2)', borderTopColor: 'var(--gold)' }} />
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text2)' }}>Signing you in…</p>
        </div>
      </div>
    );
  }

  if (phase === 'handoff') {
    const href = window.location.href;
    const safari = safariEscapeUrl(href);

    return (
      <div style={wrap}>
        <div style={card}>
          <p style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 800, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--gold)' }}>
            One more step
          </p>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
            You opened this inside Telegram's built-in browser, which forgets you
            the moment it closes. Open the link in your normal browser and you
            will stay signed in.
          </p>

          {/* iOS only: x-safari-https: hands the URL to Safari intact, fragment
              and all. Android has no equivalent that survives a fragment, so
              there it falls through to the copy button and the instruction. */}
          {safari && (
            <a href={safari} style={{ ...primaryBtn, display: 'block', textDecoration: 'none', lineHeight: '46px' }}>
              OPEN IN SAFARI
            </a>
          )}

          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(href);
                setCopied(true);
              } catch {
                // Clipboard is often unavailable in an embedded WebView. Show
                // the link so it can be selected by hand rather than failing.
                setShowLink(true);
              }
            }}
            style={{ ...primaryBtn, marginTop: safari ? 10 : 0 }}
          >
            {copied ? 'LINK COPIED ✓' : 'COPY LINK'}
          </button>

          <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--text2)', lineHeight: 1.6 }}>
            Or tap <strong>⋮</strong> at the top right and choose{' '}
            <strong>Open in browser</strong>.
          </p>

          {showLink && (
            <textarea
              readOnly
              value={href}
              onFocus={(e) => e.currentTarget.select()}
              style={{ width: '100%', marginTop: 12, padding: 8, fontSize: 11, borderRadius: 8, border: '1px solid var(--line2)', background: 'var(--bg)', color: 'var(--text2)', resize: 'none' }}
              rows={3}
            />
          )}

          <p style={{ margin: '18px 0 0', fontSize: 11, color: 'var(--text2)', opacity: 0.75, lineHeight: 1.5 }}>
            The link works once and expires in a few minutes. If it stops
            working, send /start to the bot for a new one.
          </p>

          {/* The detection can be wrong, and being wrong must never cost an
              account — only a tap. */}
          <button
            onClick={() => {
              const token = params.get('token');
              if (token) void redeem(token);
            }}
            style={{ width: '100%', marginTop: 14, height: 40, borderRadius: 10, border: '1px solid var(--line2)', background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'var(--text2)' }}
          >
            Continue here anyway
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={card} role="alert">
        <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 800, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--red)' }}>
          Sign-in failed
        </p>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>{message}</p>
        <button
          onClick={() => navigate('/', { replace: true })}
          style={primaryBtn}
        >
          BACK TO THE APP
        </button>
      </div>
    </div>
  );
};

export default TelegramAuthPage;
