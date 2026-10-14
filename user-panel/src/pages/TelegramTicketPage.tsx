// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * TelegramTicketPage.tsx — `#/tg/<ticket>`: where Verify in the Mini App sends
 * a player (owner, 2026-10-13).
 *
 * The Mini App opens `https://<site>/#/tg/<ticket>` on the phone that pressed
 * Verify (`openLink`; in the Android app the App Link lands here through
 * `nativeDeepLink.ts`). The ticket is in the FRAGMENT, which no browser sends
 * to a server or in a Referer, and this page takes it out of the address bar
 * before anything else happens, then exchanges it once for the session.
 *
 * A used or expired ticket is said plainly, with the one thing to do next.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useGame } from '../services/GameContext';
import { useShell } from '../redesign/RedesignShell';
import { card } from '../redesign/Screen';

const TelegramTicketPage: React.FC = () => {
  const { ticket = '' } = useParams();
  const { signInWithTicket } = useGame();
  const { openAuth } = useShell();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  // Once per ticket: StrictMode runs effects twice, and a ticket spends once.
  const spent = useRef<string | null>(null);

  useEffect(() => {
    if (!ticket || spent.current === ticket) return;
    spent.current = ticket;
    // Out of the address bar (and history) before the request: a ticket left
    // in a URL is one a screenshot or a shared tab can carry.
    try { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`); } catch { /* the route below still moves on */ }
    signInWithTicket(ticket)
      .then(() => navigate('/', { replace: true }))
      .catch((e) => setError((e as Error)?.message || 'Could not sign you in. Please try again.'));
  }, [ticket, signInWithTicket, navigate]);

  return (
    <div style={{ maxWidth: 420, margin: '32px auto', padding: '0 16px' }}>
      <div style={{ ...card, textAlign: 'center', padding: 24 }}>
        {error ? (
          <>
            <p role="alert" style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)', margin: '0 0 16px' }}>{error}</p>
            <button type="button" onClick={() => openAuth()}
              style={{ width: '100%', padding: 12, borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 800, color: 'var(--bg)', background: 'var(--gold)' }}>
              Continue with Telegram
            </button>
          </>
        ) : (
          <p role="status" aria-busy="true" style={{ fontSize: 14, color: 'var(--text2)', margin: 0 }}>Signing you in…</p>
        )}
      </div>
    </div>
  );
};

export default TelegramTicketPage;
