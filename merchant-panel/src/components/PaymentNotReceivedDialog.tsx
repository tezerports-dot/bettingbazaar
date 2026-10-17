// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "The player says they paid and the money never arrived."
 *
 * ── Why this is not the ordinary Decline ────────────────────────────────────
 * Declining an order before anybody can have paid simply returns it to the
 * queue; nobody is accused of anything. This one rejects a buy the player has
 * tapped Paid on (only then: owner, 2026-10-07), adds a warning to their
 * account and flags them for an admin. The buy waits in REJECTED, the team's
 * tokens held, while the player may dispute it. It never blocks them: that is
 * an admin's decision (owner, 2026-09-07).
 *
 * So it asks for a reason the player will be shown, of at least ten
 * characters, which the backend also requires. No proof image (owner,
 * 2026-10-17: "reason only"); the dispute that may follow is where evidence
 * is weighed.
 */
import React, { useState } from 'react';

interface Props {
  open: boolean;
  orderRef: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}

const MIN_REASON = 10;

export const PaymentNotReceivedDialog: React.FC<Props> = ({ open, orderRef, busy, onCancel, onSubmit }) => {
  const [reason, setReason] = useState('');

  if (!open) return null;

  const short = reason.trim().length < MIN_REASON;
  const ready = !short && !busy;

  return (
    <div role="dialog" aria-label="Payment not received"
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.6)', padding: 16 }}>
      <div style={{ width: 'min(94vw, 460px)', background: 'var(--surface, #151A24)', border: '1px solid var(--line, rgba(255,255,255,.12))', borderRadius: 16, padding: 20 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Payment not received</h2>
        <p style={{ margin: '8px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted, #9AA3B2)' }}>
          The player says they paid order <b>{orderRef}</b>. Rejecting it puts a warning on their
          account and flags them for an admin; they can dispute it until the window closes, and the
          team&apos;s tokens stay held until then.
        </p>

        <label style={{ display: 'block', marginTop: 16, fontSize: 10, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted, #9AA3B2)' }} htmlFor="what-happened-the-player-sees-this">
          What happened (the player sees this)
        </label>
        <textarea id="what-happened-the-player-sees-this"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. No credit of ₹5,000 against UTR 123456789012 in my account statement for 7 Sep."
          style={{ width: '100%', marginTop: 6, padding: 10, borderRadius: 10, resize: 'none', background: 'var(--surface2, #0F131B)', border: '1px solid var(--line, rgba(255,255,255,.12))', color: 'inherit', fontSize: 13 }}
        />
        {reason.length > 0 && short && (
          <span role="status" style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--danger, #EF4444)' }}>
            {MIN_REASON - reason.trim().length} more characters needed
          </span>
        )}

        <div style={{ display: 'flex', gap: 9, marginTop: 18 }}>
          <button onClick={onCancel} disabled={busy}
            style={{ flex: 1, padding: 11, borderRadius: 10, cursor: 'pointer', background: 'none', border: '1px solid var(--line, rgba(255,255,255,.18))', color: 'inherit', fontSize: 13, fontWeight: 700 }}>
            Cancel
          </button>
          <button
            onClick={() => onSubmit(reason.trim())}
            disabled={!ready}
            style={{ flex: 1, padding: 11, borderRadius: 10, border: 0, cursor: ready ? 'pointer' : 'not-allowed', background: ready ? 'var(--danger, #EF4444)' : 'var(--surface2, #0F131B)', color: ready ? '#fff' : 'var(--muted, #9AA3B2)', fontSize: 13, fontWeight: 800 }}>
            {busy ? 'Sending…' : 'Reject order'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PaymentNotReceivedDialog;
