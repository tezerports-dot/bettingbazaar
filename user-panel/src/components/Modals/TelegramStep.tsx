// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * TelegramStep.tsx — "Open Telegram, then come back here" (Step 3).
 *
 * One screen for every Telegram step the player can owe: verifying the mobile
 * after signup, verifying it at a sign-in that never finished signup, approving
 * a sign-in when Telegram approval is on, and "Login with Telegram". Each is a
 * link to the Mini App and a poll; what differs is which route answers the
 * poll, and the caller passes that in.
 *
 * ── Why a poll, not a callback ─────────────────────────────────────────────
 * The approval happens in another app, often on another device. Nothing can
 * call this page back, so it asks every few seconds, and the server spends the
 * challenge once, to whichever poll comes first after the approval.
 *
 * ── The poll stops itself ──────────────────────────────────────────────────
 * On a refusal (denied, expired), on unmount and on Back. A poll that outlived
 * its screen would keep asking a server about a sign-in nobody is waiting for.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { TelegramBlock } from '../../services/backend.interface';

/** Every three seconds: the contract's "every 2-3 s", and the poll limiter's budget. */
export const TELEGRAM_POLL_MS = 3000;

/**
 * Ask `poll` every TELEGRAM_POLL_MS until it answers `done` or throws.
 *
 * Module-level so a second screen (Profile's relink) reuses it
 * rather than writing a second loop that forgets to stop (§5). One request in
 * flight at a time: a slow answer must not stack a second poll behind it.
 */
export function useTelegramPoll(
  poll: (() => Promise<'pending' | 'done'>) | null,
  onDone: () => void,
  onError: (message: string) => void,
) {
  const busy = useRef(false);
  const latest = useRef({ onDone, onError });
  latest.current = { onDone, onError };

  useEffect(() => {
    if (!poll) return undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped || busy.current) return;
      busy.current = true;
      try {
        const r = await poll();
        if (!stopped && r === 'done') { stopped = true; latest.current.onDone(); }
      } catch (err) {
        if (!stopped) {
          stopped = true;
          latest.current.onError((err as Error)?.message || 'This Telegram step did not finish. Please start again.');
        }
      } finally { busy.current = false; }
    };
    const id = window.setInterval(tick, TELEGRAM_POLL_MS);
    return () => { stopped = true; window.clearInterval(id); };
  }, [poll]);
}

const BUTTON: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
  width: '100%', height: 50, borderRadius: 13, border: 'none', fontWeight: 800,
  fontSize: 14, letterSpacing: '.04em', color: 'var(--on-gold, #1a1200)',
  background: 'linear-gradient(135deg,var(--gold2),var(--gold))',
  boxShadow: '0 8px 22px -8px var(--glow)', textDecoration: 'none',
};

interface Props {
  title: string;
  message: string;
  telegram: TelegramBlock | null;
  poll: () => Promise<'pending' | 'done'>;
  onDone: () => void;
  onBack: () => void;
}

const TelegramStep: React.FC<Props> = ({ title, message, telegram, poll, onDone, onBack }) => {
  const [error, setError] = useState('');
  // Polling begins at once: on a phone the player may approve in Telegram and
  // return before they ever tap anything here.
  useTelegramPoll(error ? null : poll, onDone, setError);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} aria-live="polite">
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text)', textAlign: 'center' }}>{title}</h2>
      {error ? (
        <div role="alert" style={{ background: 'color-mix(in srgb,var(--red) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 10, padding: 10, textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'var(--red)', lineHeight: 1.5 }}>
          {error}
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.6, textAlign: 'center' }}>{message}</p>
      )}
      {telegram?.url && !error && (
        <a href={telegram.url} target="_blank" rel="noopener noreferrer" style={BUTTON}>
          Open Telegram{telegram.botUsername ? ` (@${telegram.botUsername.replace(/^@/, '')})` : ''}
        </a>
      )}
      {!error && (
        <p role="status" style={{ margin: 0, fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>
          Waiting for Telegram… this page continues on its own.
        </p>
      )}
      <button type="button" onClick={onBack}
        style={{ background: 'transparent', border: 'none', color: 'var(--text3)', fontSize: 11.5, cursor: 'pointer', padding: '6px 0' }}>
        ← Back
      </button>
    </div>
  );
};

export default TelegramStep;
