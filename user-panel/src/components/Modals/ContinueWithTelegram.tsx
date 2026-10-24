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
 * On a touch screen "Login with Telegram" goes to the Telegram app's own
 * address (`telegram.appUrl`, `tg://resolve`), so Telegram opens at once
 * instead of a browser tab at t.me's "Open in Telegram" page first. If this
 * page is still in front a moment later (no Telegram on the phone), the https
 * link opens instead (`openTelegram`). A laptop follows the https link in a new
 * tab, and the QR stays for a phone to scan. The QR carries the app address
 * too (owner, 2026-10-24): a phone's camera then hands it to Telegram at once,
 * where the https link went through a browser tab first.
 *
 * ── One step: the check, then the button (owner, 2026-10-20) ───────────────
 * The screen shows the captcha box in view (`mountCaptcha`: Cloudflare's own
 * "Verifying…" and tick) and, below it, "Login with Telegram". The tick asks
 * the server for the sign-in straight away, so by the time the button lights
 * up the Telegram link is in hand and the press IS the navigation. Nothing
 * opens Telegram on its own: a link opened by a script after a request, not by
 * the press, is what made the browser put up its own "Continue to Telegram"
 * prompt beside this button (2026-10-17 to 2026-10-20). A sign-in left unused
 * until shortly before it expires is asked for again, captcha first. The bot's
 * name is not shown.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGame } from '../../services/GameContext';
import { useTelegramPoll } from '../../hooks/useTelegramPoll';
import { storedReferralCode } from '../../services/referralCapture';
import { isNativeShell } from '../../services/nativeLifecycle';
import { qrPath } from '../PayLinkQr';
import { captchaOn, mountCaptcha } from '../../services/captcha';
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
export function openTelegram(appUrl: string, url: string): void {
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

/** Open the step's Telegram link from the press itself: the app address on a touch screen, else the https link. */
function openStep(telegram: Waiting['telegram']): boolean {
  if (!telegram?.url) return false;
  if (telegram.appUrl && touchScreen()) { openTelegram(telegram.appUrl, telegram.url); return true; }
  return false; // the link's own https navigation, in a new tab
}

/** How long before the sign-in's own expiry it is asked for again. */
const RENEW_BEFORE_MS = 20_000;
/** The challenge's lifetime when the step carries no expiry (CHALLENGE_TTL_SECONDS, telegramChallenge.service.js). */
const CHALLENGE_LIFE_MS = 5 * 60_000;

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

type Phase = 'check' | 'preparing' | 'ready' | 'opened';

const ContinueWithTelegram: React.FC<Props> = ({ onDone }) => {
  const { signInWithTelegram, pollTelegramStep } = useGame();
  const [phase, setPhase] = useState<Phase>('check');
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [error, setError] = useState('');
  const [handedOff, setHandedOff] = useState('');
  // A new value draws a fresh captcha box and asks for a fresh sign-in.
  const [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);

  const restart = useCallback(() => {
    setWaiting(null); setHandedOff(''); setError(''); setPhase('check'); setAttempt((n) => n + 1);
  }, []);

  const prepare = useCallback(async (captchaToken: string | null) => {
    setPhase('preparing'); setError('');
    try {
      const step = await signInWithTelegram({
        delivery: deliveryHere(), referralCode: storedReferralCode() || undefined, captchaToken,
      });
      if (step.kind === 'telegram') { setWaiting(step); setPhase('ready'); }
      else if (step.kind === 'unavailable') { setError(step.message); setPhase('check'); }
      else onDone();
    } catch (err) {
      setError((err as Error)?.message || 'Telegram sign-in is not available right now.');
      setPhase('check');
    }
  }, [signInWithTelegram, onDone]);

  // The captcha, in view; its tick asks for the sign-in. With captcha off the
  // sign-in is asked for at once. Keyed by `attempt` alone: `prepare` changes
  // with every render of the screen around it, and redrawing the box then
  // would throw away a solved check.
  const latestPrepare = useRef(prepare);
  latestPrepare.current = prepare;
  useEffect(() => {
    if (!captchaOn()) { void latestPrepare.current(null); return undefined; }
    const el = box.current;
    if (!el) return undefined;
    return mountCaptcha(el, {
      onToken: (token) => { void latestPrepare.current(token); },
      onError: (m) => setError(m),
    });
  }, [attempt]);

  // A sign-in nobody used is asked for again before it lapses.
  useEffect(() => {
    if (phase !== 'ready' || !waiting) return undefined;
    const at = Date.parse(waiting.telegram?.expiresAt || '');
    const left = (Number.isFinite(at) ? at - Date.now() : CHALLENGE_LIFE_MS) - RENEW_BEFORE_MS;
    const id = window.setTimeout(restart, Math.max(left, 1000));
    return () => window.clearTimeout(id);
  }, [phase, waiting, restart]);

  const match = waiting?.delivery === 'MATCH';
  const token = waiting?.challengeToken ?? null;
  // Polled once Telegram was opened, or while a number and QR are on screen
  // (a phone may scan the QR without this page being pressed).
  const polling = Boolean(token) && !error && !handedOff && (phase === 'opened' || (phase === 'ready' && match));
  const poll = useMemo(
    () => (polling && token ? () => pollTelegramStep(token) : null),
    [polling, token, pollTelegramStep],
  );
  useTelegramPoll(poll, onDone,
    // A refusal (Deny, an expired step) stays on screen until Try again.
    (m) => { setWaiting(null); setPhase('check'); setError(m); },
    () => setHandedOff('Verified in Telegram. You are signed in where Telegram opened the site; you can close this page.'));

  const ready = (phase === 'ready' || phase === 'opened') && Boolean(waiting?.telegram?.url);
  const status = phase === 'preparing' ? 'Verified. Getting your sign-in ready…'
    : phase === 'check' && captchaOn() && !error ? 'Checking your connection is secure…' : '';

  if (handedOff) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} aria-live="polite">
        <p role="status" style={NOTE}>{handedOff}</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-live="polite">
      {error && (
        <div role="alert" style={{ background: 'color-mix(in srgb,var(--red) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 10, padding: 10, textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--red)', lineHeight: 1.5 }}>
          {error}
          <button type="button" onClick={restart} style={{ display: 'block', margin: '8px auto 0', background: 'transparent', border: '1px solid currentColor', borderRadius: 8, color: 'inherit', fontWeight: 800, fontSize: 11.5, padding: '5px 12px', cursor: 'pointer' }}>
            Try again
          </button>
        </div>
      )}

      {captchaOn() && (
        <div key={attempt} ref={box} data-testid="captcha-box" aria-label="Security check" style={{ minHeight: 65, display: 'flex', justifyContent: 'center' }} />
      )}
      {status && (
        <p role="status" style={{ ...NOTE, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <span aria-hidden className="animate-spin" style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--line2)', borderTopColor: 'var(--gold-ink)', display: 'inline-block' }} />
          {status}
        </p>
      )}

      {ready && match && typeof waiting?.matchNumber === 'number' && (
        <div style={{ textAlign: 'center' }}>
          <p style={NOTE}>In Telegram, choose this number and press Verify:</p>
          <p data-testid="match-number" className="bb-gold-text" style={{ margin: '6px 0 0', fontSize: 44, fontWeight: 900, letterSpacing: '.08em', color: 'var(--gold-ink)' }}>
            {waiting.matchNumber}
          </p>
        </div>
      )}

      {ready && waiting?.telegram?.url ? (
        <a href={waiting.telegram.url} target="_blank" rel="noopener noreferrer" style={BUTTON}
          onClick={(e) => {
            if (openStep(waiting.telegram)) e.preventDefault();
            setPhase('opened');
          }}>
          <TelegramMark /> Login with Telegram
        </a>
      ) : (
        <button type="button" disabled style={{ ...BUTTON, opacity: 0.45, cursor: 'default' }}>
          <TelegramMark /> Login with Telegram
        </button>
      )}

      {ready && match && waiting?.telegram?.url && !touchScreen() && (
        <>
          <p style={NOTE}>Or scan this with your phone&apos;s camera:</p>
          <LinkQr link={waiting.telegram.appUrl || waiting.telegram.url} />
        </>
      )}
      {phase === 'opened' ? (
        <p role="status" style={{ ...NOTE, fontSize: 11, color: 'var(--text3)' }}>
          {match ? 'Waiting for Telegram… this page continues on its own.' : 'Press Verify in Telegram. It brings you back here, signed in.'}
        </p>
      ) : (
        <p style={NOTE}>New here? The same button creates your account. Telegram asks you to share your contact once.</p>
      )}
    </div>
  );
};

/** Telegram's paper plane, drawn in the button's own colour. */
const TelegramMark: React.FC = () => (
  <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <path d="M21.9 4.3 18.6 20c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.2-8.3c.4-.4-.1-.6-.6-.2L6 13.6 1.1 12c-1.1-.3-1.1-1.1.2-1.6L20.5 3c.9-.3 1.7.2 1.4 1.3Z" />
  </svg>
);

export default ContinueWithTelegram;
