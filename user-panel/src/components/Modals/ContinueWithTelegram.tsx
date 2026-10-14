// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ContinueWithTelegram.tsx — the player's one way in (owner, 2026-10-13).
 *
 * One button. Signing up and signing in are the same action: the Mini App
 * shows a Verify screen, and Telegram's own account decides whose account this
 * is (or makes one, at the first contact share). Nothing is typed here.
 *
 * ── Which way the session comes back ───────────────────────────────────────
 * `deliveryHere()`, decided per device:
 *   HANDOFF  the Android app, or a browser on Android: Telegram is on this
 *            phone, and Verify opens the site on it with a one-time ticket
 *            (`#/tg/<ticket>`, TelegramTicketPage). This screen only waits;
 *            the session lands where Telegram opened the site.
 *   MATCH    a laptop, a tablet that is not Android, an iPhone (whose
 *            installed web app cannot be opened by a link): this screen shows a
 *            two-digit number, the Mini App offers three, and Verify counts
 *            only with the right one. This screen then gets the session by
 *            polling. On a wide screen the Telegram link is also drawn as a QR
 *            for the phone to scan.
 * Either is safe whichever the device claims: a HANDOFF is never spent by a
 * poll, so a page that asked for one cannot collect somebody else's Verify.
 */
import React, { useMemo, useState } from 'react';
import { useGame } from '../../services/GameContext';
import { useTelegramPoll } from '../../hooks/useTelegramPoll';
import { storedReferralCode } from '../../services/referralCapture';
import { isNativeShell } from '../../services/nativeLifecycle';
import { qrPath } from '../PayLinkQr';
import type { SignInStep, TelegramDelivery } from '../../services/backend.interface';

type Waiting = Extract<SignInStep, { kind: 'telegram' }>;

/** HANDOFF where Telegram runs on this same device and can open the site on it; MATCH elsewhere. */
export function deliveryHere(): TelegramDelivery {
  if (isNativeShell()) return 'HANDOFF';
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Android/i.test(ua) ? 'HANDOFF' : 'MATCH';
}

const BUTTON: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
  width: '100%', height: 50, borderRadius: 13, border: 'none', fontWeight: 800,
  fontSize: 14, letterSpacing: '.04em', color: 'var(--on-gold, #1a1200)',
  background: 'linear-gradient(135deg,var(--gold2),var(--gold))',
  boxShadow: '0 8px 22px -8px var(--glow)', textDecoration: 'none', cursor: 'pointer',
};
const NOTE: React.CSSProperties = { margin: 0, fontSize: 12, color: 'var(--text2)', lineHeight: 1.6, textAlign: 'center' };

/** The Telegram link as a QR, for a phone to scan from a laptop. Black on white (§11: a scanner's contrast). */
const LinkQr: React.FC<{ link: string }> = ({ link }) => {
  const qr = useMemo(() => qrPath(link), [link]);
  if (!qr) return null;
  const box = qr.size + 8;
  return (
    <svg role="img" aria-label="QR code that opens Telegram" viewBox={`-4 -4 ${box} ${box}`}
      width={176} height={176} shapeRendering="crispEdges"
      style={{ display: 'block', margin: '0 auto', background: 'white', borderRadius: 8 }}>
      <path d={qr.d} fill="black" />
    </svg>
  );
};

interface Props {
  /** Signed in (MATCH, polled here). */
  onDone: () => void;
}

const ContinueWithTelegram: React.FC<Props> = ({ onDone }) => {
  const { signInWithTelegram, pollTelegramStep } = useGame();
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [handedOff, setHandedOff] = useState('');

  const start = async () => {
    if (busy) return;
    setBusy(true); setError(''); setHandedOff('');
    try {
      const step = await signInWithTelegram({
        delivery: deliveryHere(), referralCode: storedReferralCode() || undefined,
      });
      if (step.kind === 'telegram') setWaiting(step);
      else if (step.kind === 'unavailable') setError(step.message);
      else onDone();
    } catch (err) {
      setError((err as Error)?.message || 'Telegram sign-in is not available right now.');
    } finally { setBusy(false); }
  };

  const token = waiting?.challengeToken ?? null;
  const poll = useMemo(
    () => (token ? () => pollTelegramStep(token) : null),
    [token, pollTelegramStep],
  );
  useTelegramPoll(error || handedOff ? null : poll, onDone,
    (m) => { setWaiting(null); setError(m); },
    () => setHandedOff('Verified in Telegram. You are signed in where Telegram opened the site; you can close this page.'));

  if (!waiting) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && (
          <div role="alert" style={{ background: 'color-mix(in srgb,var(--red) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 10, padding: 10, textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--red)', lineHeight: 1.5 }}>
            {error}
          </div>
        )}
        <button type="button" onClick={start} disabled={busy} style={{ ...BUTTON, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Opening Telegram…' : 'Continue with Telegram'}
        </button>
        <p style={NOTE}>New here? The same button creates your account. Telegram asks you to share your contact once.</p>
      </div>
    );
  }

  const match = waiting.delivery === 'MATCH';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} aria-live="polite">
      {handedOff ? (
        <p role="status" style={NOTE}>{handedOff}</p>
      ) : (
        <>
          {match && typeof waiting.matchNumber === 'number' && (
            <div style={{ textAlign: 'center' }}>
              <p style={NOTE}>In Telegram, choose this number and press Verify:</p>
              <p data-testid="match-number" style={{ margin: '6px 0 0', fontSize: 44, fontWeight: 900, letterSpacing: '.08em', color: 'var(--gold-ink)' }}>
                {waiting.matchNumber}
              </p>
            </div>
          )}
          {!match && <p style={NOTE}>Open Telegram and press Verify. It brings you back here, signed in.</p>}
          {waiting.telegram?.url && (
            <a href={waiting.telegram.url} target="_blank" rel="noopener noreferrer" style={BUTTON}>
              Open Telegram{waiting.telegram.botUsername ? ` (@${waiting.telegram.botUsername.replace(/^@/, '')})` : ''}
            </a>
          )}
          {match && waiting.telegram?.url && (
            <>
              <p style={NOTE}>Or scan this with your phone&apos;s camera:</p>
              <LinkQr link={waiting.telegram.url} />
            </>
          )}
          <p role="status" style={{ ...NOTE, fontSize: 11, color: 'var(--text3)' }}>Waiting for Telegram… this page continues on its own.</p>
        </>
      )}
      <button type="button" onClick={() => { setWaiting(null); setHandedOff(''); }}
        style={{ background: 'transparent', border: 'none', color: 'var(--text3)', fontSize: 11.5, cursor: 'pointer', padding: '6px 0' }}>
        ← Back
      </button>
    </div>
  );
};

export default ContinueWithTelegram;
