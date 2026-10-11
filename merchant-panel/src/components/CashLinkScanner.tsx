// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Scan the cash machine's QR for a cash buy (Step 2d).
 *
 * The member stands at a machine offering UPI cash withdrawal, enters the
 * order amount, and points this at the QR it shows. The decoded link is shown
 * back (payee and amount) and, once they send it, the player gets one "Pay"
 * button for exactly that QR; the machine hands the member the cash.
 *
 * The camera, the photo fallback and the two decoders are `QrCamera`'s,
 * shared with the merchant account's UPI QR (owner, 2026-10-11). Typing a link
 * is not offered: a typed link is not a machine's QR, and the owner ruled it out.
 */
import React, { useEffect, useState } from 'react';
import { QrCode, RotateCcw, Send, X } from 'lucide-react';
import { Banner, Button } from './ui';
import QrCamera, { type QrRead } from './QrCamera';
import { readCashLink, type CashLinkReading } from '../utils/cashLink';
import type { PaymentOrder } from '../types';

interface Props {
  order: PaymentOrder | null;
  busy: boolean;
  onClose: () => void;
  /** Send the scanned link; resolves true when the server took it. */
  onSend: (order: PaymentOrder, link: string) => Promise<boolean>;
}

export const CashLinkScanner: React.FC<Props> = ({ order, busy, onClose, onSend }) => {
  const [reading, setReading] = useState<CashLinkReading | null>(null);
  const amount = Number(order?.fiatAmount ?? order?.amount ?? 0);

  const onRead = (read: QrRead) => setReading('raw' in read
    ? readCashLink(read.raw, amount)
    : { ok: false, message: read.error });

  // Escape closes, like every other dialog in the panel.
  useEffect(() => {
    if (!order) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, onClose]);

  // A fresh order starts with nothing read.
  useEffect(() => { setReading(null); }, [order?.orderId]);

  if (!order) return null;

  const send = async () => {
    if (!reading?.ok) return;
    const sent = await onSend(order, reading.link);
    if (sent) onClose();
  };

  const rupees = `₹${amount.toLocaleString('en-IN')}`;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cash-link-title"
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.6)', padding: 16 }}>
      <div style={{ width: 'min(94vw, 460px)', maxHeight: '94vh', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <h2 id="cash-link-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
            <QrCode size={18} /> Scan the cash machine
          </h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 0, color: 'var(--muted)', cursor: 'pointer', padding: 4 }}>
            <X size={18} />
          </button>
        </div>
        <p style={{ margin: '8px 0 12px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}>
          On the machine, choose UPI cash withdrawal and enter <b>{rupees}</b>. Then scan the QR it shows.
          The player pays that QR and the machine gives you the cash.
        </p>

        {!reading && <QrCamera onRead={onRead} photoLabel="Photo of the machine's QR" />}

        {reading && !reading.ok && (
          <div role="alert">
            <Banner tone="danger" title="Not this QR">{reading.message}</Banner>
          </div>
        )}

        {reading?.ok && (
          <div role="status" style={{ padding: '12px 14px', background: 'var(--dep-bg)', borderRadius: 12 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>The player will pay</div>
            <div className="bb-mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>
              ₹{reading.amountRupees.toLocaleString('en-IN')}
            </div>
            <div className="bb-mono" style={{ fontSize: 12, color: 'var(--text-2)', wordBreak: 'break-all' }}>to {reading.payee}</div>
          </div>
        )}

        {reading && (
          <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
            <Button variant="outline" onClick={() => setReading(null)} disabled={busy}>
              <RotateCcw size={15} /> Scan again
            </Button>
            {reading.ok && (
              <Button tone="ok" onClick={() => { void send(); }} busy={busy} style={{ flex: 1 }}>
                <Send size={15} /> Send to the player
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default CashLinkScanner;
