// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * VerificationGate.tsx — the blocking step between a staff login and the panel.
 *
 * ── Why the admin panel has one (owner, 2026-09-24) ───────────────────────
 * All three panels gate. Staff get their own bot and their own private channel,
 * completely separate from the user panel, and the admin bot's jobs are the
 * three the owner chose: password reset, verifying the mobile on first login,
 * and carrying security alerts to the admin channel. This component is the
 * second of those — the first login a staff account makes is stopped here until
 * a contact share proves the number.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE BOOTSTRAP EXEMPTION, AND WHY THIS SCREEN IS WHERE IT BECOMES VISIBLE
 * ══════════════════════════════════════════════════════════════════════════
 * Applied literally to a fresh install, "all three panels gate" is a DEADLOCK:
 * the screen where an operator registers the staff bot is on this panel, behind
 * the gate that has nothing to check. Nobody could ever configure it, from any
 * account, including the seeded one.
 *
 * So the server admits staff while — and only while — the staff bot and channel
 * do not exist, and says so with `bootstrap: true`. This component renders that
 * as a standing BANNER rather than letting it pass silently, because an
 * exemption nobody can see is a hole nobody remembers: it names the screen that
 * closes it, and it does not go away until somebody does. §3 in spirit — a
 * field with no consumer is a field that stops being true.
 *
 * The moment a staff bot is registered and a staff channel activated, the
 * banner disappears and staff gate exactly like everybody else — including the
 * admin who just configured it.
 *
 * ── Why it is not an import from another panel ───────────────────────────
 * §15: no panel imports a TypeScript file from another panel's `src/`. The
 * SERVER half is shared instead — one `verificationEndpoint`, three mounts —
 * which is the half where a divergence would be dangerous.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { telegram } from '../services/api';
import type { StaffVerification } from '../services/api';

type Phase = 'idle' | 'checking' | 'still-out' | 'error';

/** How long the webhook is given to land before a live check is asked for. */
const WEBHOOK_GRACE_MS = 1500;

/** Cache-only read, so a poll costs one indexed row and never touches Telegram. */
const POLL_MS = 30_000;

/**
 * What a staff member is told, per reason.
 *
 * Keyed by the server's `reason` — one owner for "what is missing". Note that
 * `no_bot` and `no_channel` do NOT appear: for STAFF the server resolves those
 * to the bootstrap exemption and admits, so this component never has to render
 * a wall that says "ask an admin to fix it" to the only person who could.
 */
const COPY: Record<string, { icon: string; title: string; body: string; blamePlatform?: boolean }> = {
  share_contact: {
    icon: '📱',
    title: 'Verify your mobile number',
    body: 'Open the ADMIN bot from the same mobile number your staff account uses, and tap '
      + '“Share my contact”. This is separate from any player or merchant account you hold — '
      + 'the admin panel has its own bot, and verifying elsewhere does not verify here.',
  },
  contact_changed: {
    icon: '⚠️',
    title: 'Your Telegram number changed',
    body: 'The Telegram account linked to this staff account now reports a different mobile '
      + 'number, so verification has been paused and an alert has been raised. A staff number '
      + 'changing is the shape an account takeover has, so this one is settled by a person: '
      + 'contact another administrator.',
    blamePlatform: true,
  },
  join_channel: {
    icon: '📣',
    title: 'Join the admin channel',
    body: 'Membership of the private admin channel is required to use this panel. It is also '
      + 'where security alerts are posted, so being in it is part of the job rather than a '
      + 'formality. Your request is approved automatically.',
  },
};

const VerificationGate: React.FC = () => {
  const [state, setState] = useState<StaffVerification | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState('');
  const timers = useRef<number[]>([]);

  const refresh = useCallback(async () => {
    try {
      setState(await telegram.getVerification());
    } catch {
      // A failed read must not BLOCK somebody who is already verified, and must
      // not lock an operator out of the panel during an incident — which is
      // exactly when this read is most likely to fail. Leaving `state` as it
      // was means a blip changes nothing in either direction.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const check = useCallback(async () => {
    setPhase('checking');
    setNote('');
    try {
      const cached = await telegram.getVerification();
      setState(cached);
      if (cached.verified) { setPhase('idle'); return; }

      await new Promise<void>((resolve) => {
        timers.current.push(window.setTimeout(resolve, WEBHOOK_GRACE_MS));
      });
      const live = await telegram.getVerification({ verify: true });
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

  // Not answered yet: render nothing rather than a wall. A gate that blocks
  // before it has an answer blocks on every slow first paint.
  if (!state) return null;

  // ── Verified. The only thing that may still be rendered is the bootstrap
  // banner — which is NOT a gate: it does not block, it reminds.
  if (state.verified) {
    if (!state.bootstrap) return null;
    return (
      <div role="status" style={banner}>
        <strong style={{ fontWeight: 800 }}>Admin Telegram verification is not switched on.</strong>{' '}
        Staff are signing in without a contact share or channel membership because no admin bot
        and no admin channel have been set up yet. Register one under{' '}
        <strong>Settings → Telegram → Bot fleet</strong>, choosing the <strong>Admin panel</strong>,
        then activate an admin channel. This notice disappears when both exist — and every staff
        account, including yours, will then be asked to verify.
      </div>
    );
  }

  const copy = COPY[state.reason || ''] || {
    icon: '🔒',
    title: 'One more step',
    body: 'We need to finish verifying this staff account before you can carry on.',
  };

  const action = state.reason === 'join_channel'
    ? { href: state.channel.inviteLink, label: 'Open the admin channel' }
    : state.reason === 'share_contact'
      ? { href: state.botLink, label: state.bot ? `Open @${state.bot.username}` : 'Open the bot' }
      : null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="staff-gate-title" style={backdrop}>
      <div style={panel}>
        <div style={{ fontSize: 34, textAlign: 'center', marginBottom: 10 }} aria-hidden="true">{copy.icon}</div>
        <h2 id="staff-gate-title" style={heading}>{copy.title}</h2>
        <p style={bodyText}>{copy.body}</p>

        <ol style={steps}>
          <Step done={state.contactShared} n={1} text="Verify your mobile on the admin bot" />
          <Step done={state.channelJoined} n={2} text="Join the admin channel" />
        </ol>

        {action?.href ? (
          <a href={action.href} target="_blank" rel="noopener noreferrer" style={primaryButton}>
            {action.label}
          </a>
        ) : !copy.blamePlatform ? (
          <p style={{ ...bodyText, color: 'var(--danger)' }}>
            That link is not available right now. Contact another administrator.
          </p>
        ) : null}

        {/* Only where there is something to have DONE — §32 S22. */}
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
            We still can&apos;t see it. Make sure you used the mobile number on this staff
            account, then check again.
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
      background: done ? 'var(--gold)' : 'var(--surface-2)',
      border: `1px solid ${done ? 'var(--gold)' : 'var(--border)'}`,
      color: done ? 'var(--gold-on)' : 'var(--muted)',
    }}>{done ? '✓' : n}</span>
    <span style={{ textDecoration: done ? 'line-through' : 'none' }}>{text}</span>
    <span style={srOnly}>{done ? ' — done' : ' — not done yet'}</span>
  </li>
);

// ── Chrome ──────────────────────────────────────────────────────────────────

const banner: React.CSSProperties = {
  margin: '0 0 14px', padding: '11px 14px', borderRadius: 10,
  border: '1px solid var(--warning)', background: 'var(--surface-2)',
  color: 'var(--text-2)', fontSize: 12.5, lineHeight: 1.6,
};

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
  color: 'var(--gold-on)', background: 'var(--gold)',
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
