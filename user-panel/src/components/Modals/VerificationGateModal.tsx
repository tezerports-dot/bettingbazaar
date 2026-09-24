// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * VerificationGateModal.tsx — the blocking step between signing up and playing.
 *
 * ── What changed, and why it is now PROACTIVE (owner decision, 2026-09-23) ──
 * This was `ChannelGateModal` and it was REACTIVE: it appeared only after the
 * server refused something, carrying that refusal's payload. That was correct
 * while Telegram was also the signup, because nobody could have an account
 * without having already been through the bot.
 *
 * The form changed that. An account now exists the moment somebody submits a
 * form, and at that instant they have shared no contact and joined no channel.
 * A reactive gate would let them wander the app until they tapped something
 * that failed — which is what "if not joined they can't see any other window"
 * (owner) forbids.
 *
 * So it ASKS, on mount and on a timer, and blocks everything until the answer
 * is yes. The server-side refusals are unchanged and still authoritative; this
 * is what a player sees instead of discovering them one tap at a time.
 *
 * ── ONE question, not two ──────────────────────────────────────────────────
 * `GET /api/v1/auth/verification` answers the contact share and the channel
 * membership together, and hands back a single `reason` naming the ONE thing to
 * do next. Asking two endpoints and deciding between them is §5: they disagree
 * the first time a contact is stood down while the cached channel status still
 * reads `member`, and the screen then says "all set" over a gate that is
 * refusing every action.
 *
 * ── Why "I've done it" does not immediately call Telegram ───────────────────
 * Joining a channel emits a `chat_member` update and our webhook writes the
 * cache within about a second, for free. On a CHANNEL REPLACEMENT this prompt
 * appears for every logged-in player at once — that is the design, not a
 * failure — so asking Telegram on every tap would aim the whole active user
 * base at the Bot API in the same few seconds, through the very fleet they are
 * all trying to verify with. Cache first; a live check is the fallback, once,
 * after the webhook has had its moment, and the server floors it per user.
 *
 * ── Why it cannot be dismissed ─────────────────────────────────────────────
 * Every path it guards is already refused by the server. A close button would
 * not restore access, it would only hide the one instruction that does. So
 * there is no close button, Escape does nothing, and the backdrop does not
 * dismiss.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { onChannelGate } from '../../services/apiClient';
import { useGame } from '../../services/GameContext';
import { getBackend } from '../../services/backend.service';
import type { VerificationState } from '../../services/backend.interface';

type Phase = 'idle' | 'checking' | 'still-out' | 'error';

/** How long the webhook is given to land before a live check is asked for. */
const WEBHOOK_GRACE_MS = 1500;

/**
 * How often the gate re-asks while it is blocking.
 *
 * The read is cache-only, so it costs one indexed row read and never touches
 * Telegram. Thirty seconds is slow enough to be free at scale and fast enough
 * that somebody who joins on their phone sees the app unlock without tapping
 * anything — which matters because the join happens in a DIFFERENT app, so
 * there is no event here to react to.
 */
const POLL_MS = 30_000;

/**
 * What the player is told, per reason.
 *
 * Keyed by the server's `reason` — one owner for "what is missing", read here
 * rather than re-derived from the booleans beside it. Two of the five are the
 * PLATFORM's state, not the player's, and say so: telling somebody to open a
 * bot that does not exist is §32 S14 on the one screen they cannot get past.
 */
const COPY: Record<string, { icon: string; title: string; body: string; blamePlatform?: boolean }> = {
  no_bot: {
    icon: '⏳',
    title: 'Verification is not available yet',
    body: 'Our verification bot is being set up. Your account is safe and nothing is lost — '
      + 'please check back shortly.',
    blamePlatform: true,
  },
  no_channel: {
    icon: '⏳',
    title: 'Almost ready',
    body: 'Our official channel is being set up. Your account is safe — please check back shortly.',
    blamePlatform: true,
  },
  share_contact: {
    icon: '📱',
    title: 'Verify your mobile number',
    body: 'Open our Telegram bot from the SAME mobile number you signed up with, and tap '
      + '“Share my contact”. That is how we confirm the number is yours — there is no SMS code.',
  },
  contact_changed: {
    icon: '⚠️',
    title: 'Your Telegram number changed',
    body: 'The Telegram account linked to your Betting Bazaar account now reports a different '
      + 'mobile number, so verification has been paused and our team has been notified. '
      + 'Please contact support — this one cannot be fixed from here.',
    blamePlatform: true,
  },
  join_channel: {
    icon: '📣',
    title: 'Join our Telegram channel',
    body: 'Membership of our official channel is required to bet, play and use your wallet. '
      + 'Your request is approved automatically. Your balance, KYC status and referral '
      + 'position are unchanged.',
  },
};

const VerificationGateModal: React.FC = () => {
  const { isAuthenticated } = useGame();
  const [state, setState] = useState<VerificationState | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  const timers = useRef<number[]>([]);

  /** Cache-only read. Cheap enough to run on a timer. */
  const refresh = useCallback(async () => {
    try {
      setState(await getBackend().getVerification());
    } catch {
      // A failed read must not BLOCK somebody who is already verified: leaving
      // `state` as it was means a blip does not slam the gate shut on them, and
      // an unverified player keeps the prompt they already had.
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) { setState(null); return; }
    refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [isAuthenticated, refresh]);

  /**
   * A server refusal re-reads immediately, instead of waiting for the poll.
   *
   * The poll is the PROACTIVE half — it catches somebody who has verified
   * nothing yet, before they tap anything. This is the INSTANT half: a player
   * who leaves the channel while sitting on a screen is refused on their next
   * action, and without this they would keep seeing an un-gated app for up to
   * thirty seconds while every tap silently failed.
   *
   * It triggers a READ; it never sets the state itself. The verification
   * endpoint stays the one owner of "is this player blocked" (§2) — two writers
   * would disagree the first time a refusal arrived for a reason the gate had
   * already resolved.
   */
  useEffect(() => onChannelGate(() => { void refresh(); }), [refresh]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const check = useCallback(async () => {
    setPhase('checking');
    setNote('');
    try {
      // Cache first — if the webhook already recorded it, this is the whole
      // answer and Telegram is never contacted.
      const cached = await getBackend().getVerification();
      setState(cached);
      if (cached.verified) return void setPhase('idle');

      // Not yet. Give the webhook a moment, then ask Telegram directly.
      await new Promise<void>((resolve) => {
        timers.current.push(window.setTimeout(resolve, WEBHOOK_GRACE_MS));
      });
      const live = await getBackend().getVerification({ verify: true });
      setState(live);
      if (live.verified) return void setPhase('idle');
      if (live.throttled) {
        setNote('Still checking — give it a few seconds and try again.');
        return void setPhase('still-out');
      }
      setPhase('still-out');
    } catch {
      setNote('We could not reach the server. Check your connection and try again.');
      setPhase('error');
    }
  }, []);

  // Nothing to block: signed out, not answered yet, or verified.
  if (!isAuthenticated || !state || state.verified) return null;

  const copy = COPY[state.reason || ''] || {
    icon: '🔒',
    title: 'One more step',
    body: 'We need to finish verifying your account before you can carry on.',
  };

  /**
   * Where the button goes, per reason.
   *
   * `botLink` is THIS account's assigned bot, which is the whole point of the
   * fleet: a player assigned bot #47 has a conversation with #47 and with
   * nothing else, so a generic "open the bot" link would send most players to a
   * chat that cannot answer them.
   */
  const action = state.reason === 'join_channel'
    ? { href: state.channel.inviteLink, label: 'Open the channel' }
    : state.reason === 'share_contact'
      ? { href: state.botLink, label: state.bot ? `Open @${state.bot.username}` : 'Open the bot' }
      : null;

  return (
    <Backdrop>
      <Panel>
        <div style={{ fontSize: 34, textAlign: 'center', marginBottom: 10 }}>{copy.icon}</div>
        <h2 id="verification-gate-title" style={heading}>{copy.title}</h2>
        <p style={body}>{copy.body}</p>

        {/* The two steps, so somebody who lands here knows where they are and
            how much is left. A gate that shows one instruction with no context
            reads as a wall. */}
        <ol style={steps}>
          <Step done={state.contactShared} n={1} text="Verify your mobile on Telegram" />
          <Step done={state.channelJoined} n={2} text="Join our official channel" />
        </ol>

        {action?.href ? (
          <a href={action.href} target="_blank" rel="noopener noreferrer" style={primaryButton}>
            {action.label}
          </a>
        ) : !copy.blamePlatform ? (
          <p style={{ ...body, color: 'var(--red)' }}>
            That link is not available right now. Please contact support.
          </p>
        ) : null}

        {/* Only where the player has something to have DONE. On a platform-state
            reason there is nothing to re-check and the button would be a control
            that changes nothing (§32 S22). */}
        {!copy.blamePlatform && (
          <button
            style={{ ...secondaryButton, opacity: phase === 'checking' ? 0.6 : 1 }}
            disabled={phase === 'checking'}
            onClick={check}
          >
            {phase === 'checking' ? 'Checking…' : "I've done it — check again"}
          </button>
        )}

        {phase === 'still-out' && !note && (
          <p style={statusLine}>
            We still can&apos;t see it. Make sure you used the mobile number you signed up with,
            then check again.
          </p>
        )}
        {note && <p style={statusLine}>{note}</p>}
        {phase === 'error' && !note && <p style={statusLine}>Something went wrong. Please try again.</p>}
      </Panel>
    </Backdrop>
  );
};

/** Declared at module level — see the note on `Field` in AuthModal (§32 S23). */
const Step: React.FC<{ done: boolean; n: number; text: string }> = ({ done, n, text }) => (
  <li style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, lineHeight: 1.5, color: done ? 'var(--text3)' : 'var(--text2)' }}>
    <span aria-hidden="true" style={{
      flex: '0 0 auto', width: 20, height: 20, borderRadius: 6,
      display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 800,
      background: done ? 'var(--gold)' : 'var(--surface2)',
      border: `1px solid ${done ? 'var(--gold)' : 'var(--line2)'}`,
      color: done ? '#1a1200' : 'var(--gold-ink)',
    }}>{done ? '✓' : n}</span>
    <span style={{ textDecoration: done ? 'line-through' : 'none' }}>{text}</span>
    {/* The tick is a colour and a strikethrough; neither reaches a screen
        reader, so the state is also stated in words (§32 S24's cousin). */}
    <span className="sr-only">{done ? ' — done' : ' — not done yet'}</span>
  </li>
);

// ── Chrome ───────────────────────────────────────────────────────────────────
// Deliberately no onClick on the backdrop and no Escape handler: see the header.

const Backdrop: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="verification-gate-title"
    style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16,
      background: 'color-mix(in srgb, #000 72%, transparent)',
      backdropFilter: 'blur(6px)',
    }}
  >
    {children}
  </div>
);

const Panel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    width: '100%', maxWidth: 400,
    background: 'var(--card)',
    border: '1px solid var(--line2)',
    borderRadius: 20,
    padding: '26px 22px 22px',
    boxShadow: '0 24px 60px rgba(0,0,0,.5)',
    maxHeight: '90vh', overflowY: 'auto',
  }}>
    {children}
  </div>
);

const heading: React.CSSProperties = {
  margin: '0 0 10px', textAlign: 'center',
  fontSize: 19, fontWeight: 800, color: 'var(--text)',
};

const body: React.CSSProperties = {
  margin: '0 0 14px', textAlign: 'center',
  fontSize: 13, lineHeight: 1.55, color: 'var(--text2)',
};

const steps: React.CSSProperties = {
  listStyle: 'none', margin: '0 0 16px', padding: 0,
  display: 'flex', flexDirection: 'column', gap: 9,
};

const primaryButton: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box',
  padding: '13px 16px', borderRadius: 13, border: 'none', cursor: 'pointer',
  fontWeight: 800, fontSize: 14, textAlign: 'center', textDecoration: 'none',
  color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))',
};

const secondaryButton: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box',
  marginTop: 10, padding: '11px 16px', borderRadius: 13,
  border: '1px solid var(--line2)', cursor: 'pointer',
  fontWeight: 700, fontSize: 13, textAlign: 'center',
  color: 'var(--text2)', background: 'transparent',
};

const statusLine: React.CSSProperties = {
  margin: '12px 0 0', textAlign: 'center',
  fontSize: 12, lineHeight: 1.5, color: 'var(--text3)',
};

export default VerificationGateModal;
