// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ChannelGateModal.tsx — "join the channel to continue".
 *
 * The official Telegram channel is replaceable: if it is deleted, lost or
 * abandoned, an operator activates a new one from the admin panel. That bumps
 * the config generation, which makes every cached membership stale in the same
 * instant, and the next protected request each player makes comes back
 * 403 CHANNEL_MEMBERSHIP_REQUIRED carrying the NEW invite link.
 *
 * This is what the player sees at that moment.
 *
 * ── Why it cannot be dismissed ──────────────────────────────────────────────
 * Every path this prompt guards is already refused by the server. A close
 * button would not restore access, it would only hide the one instruction that
 * does — leaving a player tapping a game that silently fails. So there is no
 * close button, Escape does nothing, and the backdrop does not dismiss.
 *
 * The prompt is not a lockout: it appears when the server refuses an action,
 * and browsing, history and the referral page keep working. Nothing in flight
 * is lost either — the refused request never touched money, and anything
 * already settled is on the server, not in this component.
 *
 * ── Why "I've joined" does not immediately call Telegram ────────────────────
 * Joining a channel emits a `chat_member` update, and our webhook writes the
 * membership cache within about a second — for free, with no Bot API call. On a
 * channel flip this prompt appears for every logged-in player at once, so
 * asking Telegram directly on every tap would aim the whole active user base at
 * the Bot API in the same few seconds. The cached read comes first; a live
 * check is the fallback, once, after the webhook has had its moment.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { onChannelGate, type ChannelGateEvent } from '../../services/apiClient';
import { apiUrl } from '../../services/apiUrl';

type Phase = 'idle' | 'checking' | 'still-out' | 'joined' | 'error';

/** How long the webhook is given to land before a live check is asked for. */
const WEBHOOK_GRACE_MS = 1500;

const ChannelGateModal: React.FC = () => {
  const [gate, setGate] = useState<ChannelGateEvent | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  const timers = useRef<number[]>([]);

  useEffect(() => onChannelGate(e => {
    // First refusal wins. A page that fires several requests at once would
    // otherwise replace the prompt under the player mid-read.
    setGate(prev => prev ?? e);
  }), []);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const check = useCallback(async () => {
    setPhase('checking');
    setNote('');
    try {
      // Cache first — if the webhook already recorded the join, this is the
      // whole answer and Telegram is never contacted.
      const cached = await fetch(apiUrl('/api/telegram/membership'), { credentials: 'include' }).then(r => r.json());
      if (cached?.joined) return void setPhase('joined');

      // Not yet. Give the webhook a moment, then ask Telegram directly.
      await new Promise<void>(resolve => {
        timers.current.push(window.setTimeout(resolve, WEBHOOK_GRACE_MS));
      });
      const live = await fetch(apiUrl('/api/telegram/membership?verify=1'), { credentials: 'include' }).then(r => r.json());

      if (live?.joined) return void setPhase('joined');
      if (live?.throttled) {
        setNote('Still checking — give it a few seconds and try again.');
        return void setPhase('still-out');
      }
      setPhase('still-out');
    } catch {
      setNote('We could not reach the server. Check your connection and try again.');
      setPhase('error');
    }
  }, []);

  if (!gate) return null;

  const tg = gate.telegram || {};
  const inviteLink = tg.inviteLink
    || (tg.channelUsername ? `https://t.me/${String(tg.channelUsername).replace(/^@/, '')}` : '');
  const botLink = tg.botUsername ? `https://t.me/${String(tg.botUsername).replace(/^@/, '')}` : '';
  const notLinked = gate.code === 'TELEGRAM_NOT_LINKED';

  // The one exit: membership is confirmed, so the refused action can be retried.
  // A reload is the honest way to do it — this component cannot know which
  // screens are holding stale "you are blocked" state, and a full reload clears
  // all of them at once.
  if (phase === 'joined') {
    return (
      <Backdrop>
        <Panel>
          <div style={{ fontSize: 34, textAlign: 'center', marginBottom: 10 }}>✅</div>
          <h2 id="channel-gate-title" style={heading}>You're in</h2>
          <p style={body}>Membership confirmed. Reloading so you can carry on where you left off.</p>
          <button style={primaryButton} onClick={() => window.location.reload()} autoFocus>Continue</button>
          <Reloader />
        </Panel>
      </Backdrop>
    );
  }

  return (
    <Backdrop>
      <Panel>
        <div style={{ fontSize: 34, textAlign: 'center', marginBottom: 10 }}>{notLinked ? '🔗' : '📣'}</div>

        <h2 id="channel-gate-title" style={heading}>{notLinked ? 'Link your Telegram' : 'Join our Telegram channel'}</h2>

        <p style={body}>
          {notLinked
            ? 'Your account is not linked to a Telegram account yet. Open the bot to link it — it takes a moment and your account stays exactly as it is.'
            : 'Membership of our official channel is required to bet, play and use your wallet. '
              + 'Join it and you can carry straight on — your balance, KYC status and referral position are unchanged.'}
        </p>

        {gate.message && <p style={{ ...body, color: 'var(--text3)', fontSize: 12 }}>{gate.message}</p>}

        {notLinked ? (
          botLink
            ? <a href={botLink} target="_blank" rel="noopener noreferrer" style={primaryButton}>Open the bot</a>
            : <p style={{ ...body, color: 'var(--red)' }}>Sign-in is being configured. Please try again shortly.</p>
        ) : inviteLink ? (
          <a href={inviteLink} target="_blank" rel="noopener noreferrer" style={primaryButton}>Open the channel</a>
        ) : (
          <p style={{ ...body, color: 'var(--red)' }}>
            The channel link is not available right now. Please contact support.
          </p>
        )}

        <button
          style={{ ...secondaryButton, opacity: phase === 'checking' ? 0.6 : 1 }}
          disabled={phase === 'checking'}
          onClick={check}
        >
          {phase === 'checking' ? 'Checking…' : "I've joined — check again"}
        </button>

        {phase === 'still-out' && !note && (
          <p style={statusLine}>
            We still can't see you in the channel. Make sure you tapped <strong>Join</strong>, then check again.
          </p>
        )}
        {note && <p style={statusLine}>{note}</p>}
        {phase === 'error' && !note && <p style={statusLine}>Something went wrong. Please try again.</p>}
      </Panel>
    </Backdrop>
  );
};

/** Reload shortly after confirmation, so a player who does not tap still moves on. */
const Reloader: React.FC = () => {
  useEffect(() => {
    const t = window.setTimeout(() => window.location.reload(), 2000);
    return () => clearTimeout(t);
  }, []);
  return null;
};

// ── Chrome ───────────────────────────────────────────────────────────────────
// Deliberately no onClick on the backdrop and no Escape handler: see the header.

const Backdrop: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="channel-gate-title"
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

export default ChannelGateModal;
