// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * VerificationGate.tsx — the blocking step between a merchant signup and trading.
 *
 * ── Why the merchant panel has one at all (owner, 2026-09-24) ──────────────
 * "one bot with its own channel for merchant and one bot with its own channel
 * for admin thus it will be complete separate from user panel whether its
 * signup or login or account recovery." A merchant verifies through the
 * MERCHANT bot and joins the MERCHANT channel; neither is the player's, and a
 * merchant who has done the player half has done nothing here.
 *
 * ── Why it is not an import from the user panel ───────────────────────────
 * §15: no panel imports a TypeScript file from another panel's `src/`. The
 * SERVER half is shared instead, which is the half that can drift dangerously:
 * one `verificationEndpoint`, mounted three times, so all three panels get the
 * same answer to the same question. What is duplicated here is chrome and
 * copy — and the copy genuinely differs, because a merchant is told what a
 * merchant loses by not verifying.
 *
 * ── Why it cannot be dismissed ────────────────────────────────────────────
 * Every path it guards is already refused by the server. A close button would
 * not restore access, it would only hide the one instruction that does. So
 * there is no close control, Escape does nothing, and the backdrop does not
 * dismiss (§33.3).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import type { MerchantVerification } from '../services/api';

type Phase = 'idle' | 'checking' | 'still-out' | 'error';

/** How long the webhook is given to land before a live check is asked for. */
const WEBHOOK_GRACE_MS = 1500;

/**
 * How often the gate re-asks while it is blocking.
 *
 * The read is cache-only, so it costs one indexed row read and never touches
 * Telegram. Thirty seconds is slow enough to be free at scale and fast enough
 * that a merchant who joins on their phone sees the panel unlock without
 * tapping anything — which matters because the join happens in a DIFFERENT
 * app, so there is no event here to react to.
 */
const POLL_MS = 30_000;

/**
 * What a merchant is told, per reason.
 *
 * Keyed by the server's `reason` — one owner for "what is missing", read here
 * rather than re-derived from the booleans beside it. Two of the five are the
 * PLATFORM's state, not the merchant's, and say so: telling somebody to open a
 * bot that does not exist is §32 S14 on the one screen they cannot get past,
 * and a "check again" button there is §32 S22.
 */
const COPY: Record<string, { icon: string; title: string; body: string; blamePlatform?: boolean }> = {
  no_bot: {
    icon: '⏳',
    title: 'Merchant verification is not available yet',
    body: 'The merchant verification bot is being set up. Your account, balance and order '
      + 'history are safe — please check back shortly.',
    blamePlatform: true,
  },
  no_channel: {
    icon: '⏳',
    title: 'Almost ready',
    body: 'The merchant channel is being set up. Your account and balance are safe — '
      + 'please check back shortly.',
    blamePlatform: true,
  },
  share_contact: {
    icon: '📱',
    title: 'Verify your merchant mobile number',
    body: 'Open the MERCHANT bot from the same mobile number you registered with, and tap '
      + '“Share my contact”. This is separate from any player account you hold — the merchant '
      + 'panel has its own bot, and sharing your contact there does not verify this one.',
  },
  contact_changed: {
    icon: '⚠️',
    title: 'Your Telegram number changed',
    body: 'The Telegram account linked to your merchant account now reports a different mobile '
      + 'number, so verification has been paused and our team has been notified. Please contact '
      + 'support — this one cannot be fixed from here.',
    blamePlatform: true,
  },
  join_channel: {
    icon: '📣',
    title: 'Join the merchant channel',
    body: 'Membership of the merchant channel is required to accept orders and move tokens. '
      + 'Your request is approved automatically. Your balance, held tokens and commission '
      + 'position are unchanged.',
  },
};

const VerificationGate: React.FC = () => {
  const [state, setState] = useState<MerchantVerification | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  const timers = useRef<number[]>([]);

  /** Cache-only read. Cheap enough to run on a timer. */
  const refresh = useCallback(async () => {
    try {
      setState(await api.getVerification());
    } catch {
      // A failed read must not BLOCK somebody who is already verified: leaving
      // `state` as it was means a blip does not slam the gate shut on them, and
      // an unverified merchant keeps the prompt they already had.
    }
  }, []);

  useEffect(() => {
    if (!api.isAuthenticated()) { setState(null); return undefined; }
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const check = useCallback(async () => {
    setPhase('checking');
    setNote('');
    try {
      // Cache first — if the webhook already recorded it, this is the whole
      // answer and Telegram is never contacted.
      const cached = await api.getVerification();
      setState(cached);
      if (cached.verified) { setPhase('idle'); return; }

      // Not yet. Give the webhook a moment, then ask Telegram directly.
      await new Promise<void>((resolve) => {
        timers.current.push(window.setTimeout(resolve, WEBHOOK_GRACE_MS));
      });
      const live = await api.getVerification({ verify: true });
      setState(live);
      if (live.verified) { setPhase('idle'); return; }
      if (live.throttled) {
        setNote('Still checking — give it a few seconds and try again.');
        setPhase('still-out');
        return;
      }
      setPhase('still-out');
    } catch {
      setNote('We could not reach the server. Check your connection and try again.');
      setPhase('error');
    }
  }, []);

  // Nothing to block: signed out, not answered yet, or verified.
  if (!state || state.verified) return null;

  const copy = COPY[state.reason || ''] || {
    icon: '🔒',
    title: 'One more step',
    body: 'We need to finish verifying your merchant account before you can carry on.',
  };

  /**
   * Where the button goes, per reason.
   *
   * `botLink` is THIS account's assigned bot out of the merchant fleet — a
   * merchant assigned bot #4 has a conversation with #4 and nothing else, so a
   * generic "open the bot" link would send most of them to a chat that cannot
   * answer (§33.2).
   */
  const action = state.reason === 'join_channel'
    ? { href: state.channel.inviteLink, label: 'Open the merchant channel' }
    : state.reason === 'share_contact'
      ? { href: state.botLink, label: state.bot ? `Open @${state.bot.username}` : 'Open the bot' }
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="merchant-gate-title"
      style={backdrop}
    >
      <div style={panel}>
        <div style={{ fontSize: 34, textAlign: 'center', marginBottom: 10 }} aria-hidden="true">{copy.icon}</div>
        <h2 id="merchant-gate-title" style={heading}>{copy.title}</h2>
        <p style={bodyText}>{copy.body}</p>

        {/* The two steps, so somebody who lands here knows where they are and
            how much is left. A gate that shows one instruction with no context
            reads as a wall. */}
        <ol style={steps}>
          <Step done={state.contactShared} n={1} text="Verify your mobile on the merchant bot" />
          <Step done={state.channelJoined} n={2} text="Join the merchant channel" />
        </ol>

        {action?.href ? (
          <a href={action.href} target="_blank" rel="noopener noreferrer" style={primaryButton}>
            {action.label}
          </a>
        ) : !copy.blamePlatform ? (
          <p style={{ ...bodyText, color: 'var(--danger)' }}>
            That link is not available right now. Please contact support.
          </p>
        ) : null}

        {/* Only where the merchant has something to have DONE. On a
            platform-state reason there is nothing to re-check and the button
            would be a control that changes nothing (§32 S22). */}
        {!copy.blamePlatform && (
          <button
            type="button"
            style={{ ...secondaryButton, opacity: phase === 'checking' ? 0.6 : 1 }}
            disabled={phase === 'checking'}
            onClick={() => { void check(); }}
          >
            {phase === 'checking' ? 'Checking…' : "I've done it — check again"}
          </button>
        )}

        {phase === 'still-out' && !note && (
          <p style={statusLine}>
            We still can&apos;t see it. Make sure you used the mobile number on your merchant
            registration, then check again.
          </p>
        )}
        {note && <p style={statusLine}>{note}</p>}
        {phase === 'error' && !note && <p style={statusLine}>Something went wrong. Please try again.</p>}
      </div>
    </div>
  );
};

/** Declared at MODULE level, never inside the component — §32 S23. */
const Step: React.FC<{ done: boolean; n: number; text: string }> = ({ done, n, text }) => (
  <li style={{
    display: 'flex', alignItems: 'center', gap: 10,
    fontSize: 12.5, lineHeight: 1.5, color: done ? 'var(--muted)' : 'var(--text-2)',
  }}>
    <span aria-hidden="true" style={{
      flex: '0 0 auto', width: 20, height: 20, borderRadius: 6,
      display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 800,
      background: done ? 'var(--brand)' : 'var(--surface-2)',
      border: `1px solid ${done ? 'var(--brand)' : 'var(--border)'}`,
      color: done ? '#fff' : 'var(--muted)',
    }}>{done ? '✓' : n}</span>
    <span style={{ textDecoration: done ? 'line-through' : 'none' }}>{text}</span>
    {/* The tick is a colour and a strikethrough; neither reaches a screen
        reader, so the state is also stated in words. */}
    <span style={srOnly}>{done ? ' — done' : ' — not done yet'}</span>
  </li>
);

// ── Chrome ──────────────────────────────────────────────────────────────────
// Deliberately no onClick on the backdrop and no Escape handler: see the header.

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16,
  background: 'color-mix(in srgb, #000 72%, transparent)',
  backdropFilter: 'blur(6px)',
};

const panel: React.CSSProperties = {
  width: '100%', maxWidth: 400,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 20,
  padding: '26px 22px 22px',
  boxShadow: '0 24px 60px rgba(0,0,0,.5)',
  maxHeight: '90vh', overflowY: 'auto',
};

const heading: React.CSSProperties = {
  margin: '0 0 10px', textAlign: 'center',
  fontSize: 19, fontWeight: 800, color: 'var(--text)',
};

const bodyText: React.CSSProperties = {
  margin: '0 0 14px', textAlign: 'center',
  fontSize: 13, lineHeight: 1.55, color: 'var(--text-2)',
};

const steps: React.CSSProperties = {
  listStyle: 'none', margin: '0 0 16px', padding: 0,
  display: 'flex', flexDirection: 'column', gap: 9,
};

const primaryButton: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box',
  padding: '13px 16px', borderRadius: 13, border: 'none', cursor: 'pointer',
  fontWeight: 800, fontSize: 14, textAlign: 'center', textDecoration: 'none',
  color: '#fff', background: 'var(--brand)',
};

const secondaryButton: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box',
  marginTop: 10, padding: '11px 16px', borderRadius: 13,
  border: '1px solid var(--border)', cursor: 'pointer',
  fontWeight: 700, fontSize: 13, textAlign: 'center',
  color: 'var(--text-2)', background: 'transparent',
};

const statusLine: React.CSSProperties = {
  margin: '12px 0 0', textAlign: 'center',
  fontSize: 12, lineHeight: 1.5, color: 'var(--muted)',
};

const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

export default VerificationGate;
