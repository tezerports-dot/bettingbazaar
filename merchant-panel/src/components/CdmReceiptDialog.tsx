// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The CDM slip for a cash payout — and the last time the merchant sees it.
 *
 * ── Why this screen is shaped the way it is ─────────────────────────────────
 * A CDM slip carries an account number, a branch, a timestamp and a bank
 * reference. It is the strongest evidence in a cash-payout dispute and the
 * least appropriate thing to hand back to either party, so once submitted
 * NOBODY reads it again except an admin or a disputes manager — including the
 * merchant who uploaded it. `toOrder` does not map the columns, so no
 * projection on the platform can carry them; there is no "view my receipt"
 * route to build and there will not be one.
 *
 * Two consequences drive this component:
 *
 *   1. **Replacement is free until submit.** The picker can be re-opened as
 *      many times as they like and the image is shown at full width, because
 *      this is the only moment at which they can check what they are sending.
 *      A one-shot file input would be a merchant unable to correct a photo of
 *      the wrong slip.
 *
 *   2. **The confirmation is a receipt in itself.** The server echoes the
 *      transaction id and the time it recorded, and that echo is the only
 *      record the merchant keeps. So the dialog does NOT close on success — it
 *      switches to showing what was accepted, and they dismiss it themselves.
 *
 * The order completed at the merchant's confirm; this is chased afterwards. So
 * failure here is never destructive: the dialog stays open with everything
 * still in it, and the payout appears in "receipts you owe" either way.
 */
import React, { useRef, useState } from 'react';
import { Banknote, Check, ShieldCheck } from 'lucide-react';

interface Props {
  open: boolean;
  orderRef: string;
  /** In RUPEES — the cash that went into the machine. */
  amount: number | null;
  busy: boolean;
  /** Set once the server has accepted it. Its own echo, and the only one. */
  submitted: { transactionId: string; submittedAt: string } | null;
  onCancel: () => void;
  onSubmit: (transactionId: string, receipt: File) => void;
}

/** The server refuses anything shorter — stated here so they are not told after. */
const MIN_TRANSACTION_ID = 6;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

const labelStyle: React.CSSProperties = {
  display: 'block', marginTop: 16, fontSize: 10, fontWeight: 800,
  letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--muted, #9AA3B2)',
};

export const CdmReceiptDialog: React.FC<Props> = ({
  open, orderRef, amount, busy, submitted, onCancel, onSubmit,
}) => {
  const [transactionId, setTransactionId] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Re-opening the picker and pressing Escape must not clear a good file.
    if (!file) return;
    if (!ALLOWED.includes(file.type)) {
      setError('Use a JPEG, PNG or WebP photo of the slip.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('That photo is over 10 MB.');
      return;
    }
    setError('');
    setReceipt(file);
    // Revoked when replaced, so a merchant who re-photographs the slip four
    // times does not leak four blobs.
    setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
  };

  const short = transactionId.trim().length < MIN_TRANSACTION_ID;
  const ready = !short && !!receipt && !busy;

  const dismiss = () => {
    if (preview) URL.revokeObjectURL(preview);
    onCancel();
  };

  return (
    <div role="dialog" aria-label="CDM receipt"
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.6)', padding: 16 }}>
      <div style={{ width: 'min(94vw, 460px)', maxHeight: '92vh', overflowY: 'auto', background: 'var(--surface, #151A24)', border: '1px solid var(--line, rgba(255,255,255,.12))', borderRadius: 16, padding: 20 }}>

        {submitted ? (
          /* The echo. Not a read of the stored receipt — the server's own
             confirmation of what it accepted, which is all they will get. */
          <>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Check size={18} style={{ color: 'var(--ok, #22C55E)' }} /> Receipt recorded
            </h2>
            <p style={{ margin: '10px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted, #9AA3B2)' }}>
              This is the only confirmation you will see. From now on the slip is
              readable by an admin or a disputes manager and by nobody else — not
              the player, and not you.
            </p>
            <div style={{ marginTop: 14, padding: 14, borderRadius: 12, background: 'var(--surface2, #0F131B)' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: 'var(--muted, #9AA3B2)' }}>Transaction id</div>
              <div className="bb-mono" style={{ fontSize: 15, fontWeight: 700 }}>{submitted.transactionId}</div>
              <div style={{ marginTop: 9, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: 'var(--muted, #9AA3B2)' }}>Recorded</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {new Date(submitted.submittedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
            <button onClick={dismiss}
              style={{ width: '100%', marginTop: 18, padding: 12, borderRadius: 10, border: 0, cursor: 'pointer', background: 'var(--ok, #22C55E)', color: '#fff', fontSize: 13, fontWeight: 800 }}>
              Done
            </button>
          </>
        ) : (
          <>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Banknote size={18} /> CDM receipt
            </h2>
            <p style={{ margin: '8px 0 0', fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted, #9AA3B2)' }}>
              Payout <b>{orderRef}</b>
              {amount !== null && <> · <b>₹{amount.toLocaleString('en-IN')}</b> deposited</>}.
              The slip is what a dispute is decided from, so send the machine&apos;s
              own transaction id and a clear photo.
            </p>

            <label htmlFor="cdm-transaction-id" style={labelStyle}>Bank transaction id (from the slip)</label>
            <input
              id="cdm-transaction-id"
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              placeholder="e.g. 481920356711"
              style={{ width: '100%', marginTop: 6, padding: 10, borderRadius: 10, background: 'var(--surface2, #0F131B)', border: '1px solid var(--line, rgba(255,255,255,.12))', color: 'inherit', fontSize: 13 }}
            />
            {transactionId.length > 0 && short && (
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--danger, #EF4444)' }}>
                {MIN_TRANSACTION_ID - transactionId.trim().length} more characters needed
              </span>
            )}

            <label style={labelStyle}>Photo of the slip</label>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              style={{ width: '100%', marginTop: 6, padding: 12, borderRadius: 10, cursor: 'pointer', textAlign: 'left', background: 'var(--surface2, #0F131B)', border: `1px dashed ${receipt ? 'var(--ok, #22C55E)' : 'var(--line, rgba(255,255,255,.18))'}`, color: 'inherit', fontSize: 12.5 }}
            >
              {receipt ? `📎 ${receipt.name} — tap to replace` : 'Choose a photo of the CDM slip'}
            </button>
            <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={pick} aria-label="CDM receipt photo" />

            {/* Shown full width on purpose: this is the last look they get. */}
            {preview && (
              <img src={preview} alt="The slip you are about to submit"
                style={{ width: '100%', marginTop: 10, borderRadius: 12, border: '1px solid var(--line, rgba(255,255,255,.12))', display: 'block' }} />
            )}

            <p style={{ margin: '12px 0 0', display: 'flex', gap: 8, fontSize: 11.5, lineHeight: 1.5, color: 'var(--muted, #9AA3B2)' }}>
              <ShieldCheck size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                Check it now — once submitted you cannot open it again. Only an
                admin or a disputes manager can.
              </span>
            </p>

            {error && <p style={{ margin: '10px 0 0', fontSize: 11.5, color: 'var(--danger, #EF4444)' }}>{error}</p>}

            <div style={{ display: 'flex', gap: 9, marginTop: 18 }}>
              <button onClick={dismiss} disabled={busy}
                style={{ flex: 1, padding: 11, borderRadius: 10, cursor: 'pointer', background: 'none', border: '1px solid var(--line, rgba(255,255,255,.18))', color: 'inherit', fontSize: 13, fontWeight: 700 }}>
                Later
              </button>
              <button
                onClick={() => receipt && onSubmit(transactionId.trim(), receipt)}
                disabled={!ready}
                style={{ flex: 1, padding: 11, borderRadius: 10, border: 0, cursor: ready ? 'pointer' : 'not-allowed', background: ready ? 'var(--ok, #22C55E)' : 'var(--surface2, #0F131B)', color: ready ? '#fff' : 'var(--muted, #9AA3B2)', fontSize: 13, fontWeight: 800 }}>
                {busy ? 'Sending…' : 'Submit receipt'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default CdmReceiptDialog;
