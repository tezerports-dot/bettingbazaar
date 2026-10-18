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
 * The server grants a HANDOFF only when this app opens at the site's own
 * address (`returnOriginHere`, sent by `loginWithTelegram`), and answers MATCH
 * otherwise: an APK or installed web app left on a retired address after a
 * domain was blocked gets the number, which reaches it wherever it runs.
 * This screen renders whichever the server answered (`waiting.delivery`).
 *
 * ── Opening Telegram ───────────────────────────────────────────────────────
 * On a touch screen "Open Telegram" goes to the Telegram app's own address
 * (`telegram.appUrl`, `tg://resolve`), so Telegram opens at once instead of a
 * browser tab at t.me's "Open in Telegram" page first. If this page is still
 * in front a moment later (no Telegram on the phone), the https link opens
 * instead (`openTelegram`). A laptop also goes to `tg://` first, which opens
 * Telegram Desktop where it is installed, instead of a t.me tab whose page
 * then asks to open it; the window losing focus to Telegram counts as taken
 * over, and with nothing installed a pressed button opens the https link. The
 * QR stays.
 *
 * ── One tap, not two ───────────────────────────────────────────────────────
 * The captcha is solved while the button is on screen (`warmCaptchaToken`),
 * so the tap waits only for the server. When the step comes back Telegram is
 * opened straight away (`opensAtOnce`): on a HANDOFF, and on a laptop, where
 * the number stays in view beside Telegram. A MATCH on a phone or tablet keeps
 * its "Open Telegram" button: Telegram would cover the number to choose. The
 * request is bounded (TELEGRAM_START_TIMEOUT_MS, realBackend.ts), so the
 * button never spins for minutes.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useGame } from '../../services/GameContext';
import { useTelegramPoll } from '../../hooks/useTelegramPoll';
import { storedReferralCode } from '../../services/referralCapture';
import { isNativeShell } from '../../services/nativeLifecycle';
import { qrPath } from '../PayLinkQr';
import { warmCaptchaToken } from '../../services/captcha';
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
  background: 'var(--gold-metal)',
  boxShadow: '0 8px 22px -8px var(--glow)', textDecoration: 'none', cursor: 'pointer',
};
/** How long Telegram gets to take over before the https link is tried instead. */
export const APP_LINK_FALLBACK_MS = 1500;

/** Whether this is a touch screen, where a `tg://` link reaches the Telegram app on the device. */
function touchScreen(): boolean {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

/**
 * Open Telegram at `appUrl`, falling back to `url` when nothing took over:
 * the page is still visible and focused after APP_LINK_FALLBACK_MS. Leaving
 * for Telegram hides the page (a phone) or takes the window's focus (a laptop,
 * where Telegram Desktop or the browser's "Open Telegram?" prompt comes to the
 * front), which cancels the fallback.
 */
export function openTelegram(appUrl: string, url: string, { fallback = true } = {}): void {
  if (!fallback) { window.location.href = appUrl; return; }
  let left = false;
  const onHide = () => { if (document.visibilityState === 'hidden') left = true; };
  const onBlur = () => { left = true; };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('blur', onBlur);
  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('blur', onBlur);
    if (!left && document.visibilityState === 'visible') window.open(url, '_blank', 'noopener,noreferrer');
  }, APP_LINK_FALLBACK_MS);
  window.location.href = appUrl;
}

/**
 * Whether Telegram is opened as soon as the step arrives, without a second tap:
 * a HANDOFF (no number to read), or a MATCH on a laptop, where Telegram opens
 * beside the page and the number stays in view. A MATCH on a touch screen waits
 * for "Open Telegram", so the number is read first.
 */
export function opensAtOnce(delivery: TelegramDelivery | undefined, touch = touchScreen()): boolean {
  return delivery === 'HANDOFF' || (delivery === 'MATCH' && !touch);
}

/**
 * Open the step's Telegram link the fastest way this device allows. Opened on
 * its own (`auto`) on a laptop, only the app address is tried: a laptop with no
 * Telegram Desktop scans the QR, and a t.me tab would take it out of view.
 */
function openStep(telegram: Waiting['telegram'], { auto = false } = {}): void {
  if (!telegram?.url) return;
  if (telegram.appUrl) openTelegram(telegram.appUrl, telegram.url, { fallback: !auto || touchScreen() });
  else if (!auto) window.open(telegram.url, '_blank', 'noopener,noreferrer');
}

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

  // Solve the captcha while the button is on screen, and again after a failed
  // try (its token was spent), so the tap waits only for the server.
  useEffect(() => { if (!waiting) warmCaptchaToken(); }, [waiting, error]);

  const start = async () => {
    if (busy) return;
    setBusy(true); setError(''); setHandedOff('');
    try {
      const step = await signInWithTelegram({
        delivery: deliveryHere(), referralCode: storedReferralCode() || undefined,
      });
      if (step.kind === 'telegram') {
        setWaiting(step);
        if (opensAtOnce(step.delivery)) openStep(step.telegram, { auto: true });
      }
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
              <p data-testid="match-number" className="bb-gold-text" style={{ margin: '6px 0 0', fontSize: 44, fontWeight: 900, letterSpacing: '.08em', color: 'var(--gold-ink)' }}>
                {waiting.matchNumber}
              </p>
            </div>
          )}
          {!match && <p style={NOTE}>Open Telegram and press Verify. It brings you back here, signed in.</p>}
          {waiting.telegram?.url && (
            <a href={waiting.telegram.url} target="_blank" rel="noopener noreferrer" style={BUTTON}
              onClick={(e) => {
                if (!waiting.telegram?.appUrl) return; // no app address: the https link as it is
                e.preventDefault();
                openStep(waiting.telegram);
              }}>
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
