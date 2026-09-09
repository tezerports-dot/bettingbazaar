// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "The player says they paid and the money never arrived."
 *
 * ── Why this is not the ordinary Reject ─────────────────────────────────────
 * Rejecting an order BEFORE payment simply returns it to the queue; nobody is
 * accused of anything. This one cancels an order the player has already claimed
 * to pay, adds a warning to their account, and can auto-block them once they
 * cross the admin's threshold — without an admin looking at it first.
 *
 * So it asks for what an accusation needs: a reason the player will be shown,
 * and a picture of the evidence. The backend refuses without both, and verifies
 * the image belongs to this merchant and this order before storing it. The
 * fields here are not politeness — they are the same requirement, stated early
 * enough that the merchant is not told "rejected" and then refused.
 */
import React, { useRef, useState } from 'react';

interface Props {
  open: boolean;
  orderRef: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string, proof: File) => void;
}

const MIN_REASON = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];

export const PaymentNotReceivedDialog: React.FC<Props> = ({ open, orderRef, busy, onCancel, onSubmit }) => {
  const [reason, setReason] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Checked here as well as server-side: a merchant who picks a 40MB photo
    // should be told before the upload, not after it fails.
    if (!ALLOWED.includes(file.type)) {
      setError('Use a JPEG, PNG, WebP or GIF image.'); setProof(null); return;
    }
    if (file.size > MAX_BYTES) {
      setError('That image is over 10 MB.'); setProof(null); return;
    }
    setError(''); setProof(file);
  };

  const short = reason.trim().length < MIN_REASON;
  const ready = !short && !!proof && !busy;

  return (
    <div role="dialog" aria-label="Payment not received"
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.6)', padding: 16 }}>
      <div style={{ width: 'min(94vw, 460px)', background: 'var(--surface, #151A24)', border: '1px solid var(--line, rgba(255,255,255,.12))', borderRadius: 16, padding: 20 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Payment not received</h2>
        <p style={{ margin: '8px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted, #9AA3B2)' }}>
          Order <b>{orderRef}</b> will be cancelled and the player will get a warning on their
          account. Repeated warnings can block them, so this needs evidence.
        </p>

        <label style={{ display: 'block', marginTop: 16, fontSize: 10, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted, #9AA3B2)' }}>
          What happened (the player sees this)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. No credit of ₹5,000 against UTR 123456789012 in my account statement for 7 Sep."
          style={{ width: '100%', marginTop: 6, padding: 10, borderRadius: 10, resize: 'none', background: 'var(--surface2, #0F131B)', border: '1px solid var(--line, rgba(255,255,255,.12))', color: 'inherit', fontSize: 13 }}
        />
        {reason.length > 0 && short && (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--danger, #EF4444)' }}>
            {MIN_REASON - reason.trim().length} more characters needed
          </span>
        )}

        <label style={{ display: 'block', marginTop: 14, fontSize: 10, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted, #9AA3B2)' }}>
          Proof (screenshot or photo)
        </label>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          style={{ width: '100%', marginTop: 6, padding: 12, borderRadius: 10, cursor: 'pointer', textAlign: 'left', background: 'var(--surface2, #0F131B)', border: `1px dashed ${proof ? 'var(--ok, #22C55E)' : 'var(--line, rgba(255,255,255,.18))'}`, color: 'inherit', fontSize: 12.5 }}
        >
          {proof ? `📎 ${proof.name}` : 'Choose a bank statement screenshot or photo'}
        </button>
        <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={pick} aria-label="Proof image" />

        {error && <p style={{ margin: '10px 0 0', fontSize: 11.5, color: 'var(--danger, #EF4444)' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 9, marginTop: 18 }}>
          <button onClick={onCancel} disabled={busy}
            style={{ flex: 1, padding: 11, borderRadius: 10, cursor: 'pointer', background: 'none', border: '1px solid var(--line, rgba(255,255,255,.18))', color: 'inherit', fontSize: 13, fontWeight: 700 }}>
            Cancel
          </button>
          <button
            onClick={() => proof && onSubmit(reason.trim(), proof)}
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
