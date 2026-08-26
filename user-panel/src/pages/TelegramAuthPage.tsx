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
 */
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useGame } from '../services/GameContext';

type Phase = 'working' | 'failed';

const TelegramAuthPage: React.FC = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { completeTelegramLogin } = useGame();
  const [phase, setPhase] = useState<Phase>('working');
  const [message, setMessage] = useState('');
  // React 18 StrictMode mounts effects twice in development. A single-use token
  // redeemed twice would burn itself and land every developer on the failure
  // screen, so the exchange is fired at most once per mount.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const token = params.get('token');
    if (!token) {
      setPhase('failed');
      setMessage('This link is missing its sign-in code. Send /start to the bot for a new one.');
      return;
    }

    (async () => {
      try {
        await completeTelegramLogin(token);
        // replace, not push: Back must not return to a spent token.
        navigate('/', { replace: true });
      } catch (err: any) {
        setPhase('failed');
        setMessage(err?.message
          || 'We could not sign you in. Send /start to the bot for a new link.');
      }
    })();
  }, [params, navigate, completeTelegramLogin]);

  const wrap: React.CSSProperties = {
    minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '32px 16px', textAlign: 'center',
  };
  const card: React.CSSProperties = {
    width: '100%', maxWidth: 380, background: 'var(--surface)', border: '1px solid var(--line2)',
    borderRadius: 22, padding: '30px 24px', boxShadow: 'var(--shadow)',
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

  return (
    <div style={wrap}>
      <div style={card} role="alert">
        <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 800, letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--red)' }}>
          Sign-in failed
        </p>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>{message}</p>
        <button
          onClick={() => navigate('/', { replace: true })}
          style={{ width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 13, color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))' }}
        >
          BACK TO THE APP
        </button>
      </div>
    </div>
  );
};

export default TelegramAuthPage;
