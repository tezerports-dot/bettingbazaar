// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The player's dispute window, while their order's tokens are in escrow (2c+,
 * owner 2026-10-02).
 *
 *   a BUY the member rejected as unpaid   "you have until HH:MM to dispute"
 *   a SELL the member marked paid         "your tokens stay held until HH:MM"
 *
 * `order.disputeUntil` is derived by the server (`playerOrderView.js`,
 * `disputeDeadline`) and is the only clock this reads: the dispute route checks
 * the same instant on the database clock, so a press after it is refused there
 * whatever this screen says. The countdown is display only (§11).
 *
 * Two surfaces share one form:
 *   <DisputeWindowPanel>  on the order card in the wallet
 *   <RejectedBuyPopup>    the pop-up the moment a member rejects a buy, mounted
 *                         once in the app shell, fed by the `order_update` push
 */
import React, { useEffect, useState } from 'react';
import { payments } from '../services/api';

export interface DisputeWindowOrder {
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  status: string;
  disputeUntil?: string | null;
  tokenAmount?: number;
}

/** Milliseconds left until `until`, ticking once a second; 0 once it has passed. */
function useTimeLeft(until?: string | null): number {
  const [left, setLeft] = useState(() => (until ? Math.max(0, new Date(until).getTime() - Date.now()) : 0));
  useEffect(() => {
    if (!until) { setLeft(0); return undefined; }
    const tick = () => setLeft(Math.max(0, new Date(until).getTime() - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);
  return left;
}

function formatLeft(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function clockTime(until: string): string {
  return new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** What the window means for this order, in the player's words. */
function explain(order: DisputeWindowOrder, until: string): string {
  return order.type === 'DEPOSIT'
    ? `The team member says your payment did not arrive. If you paid, raise a dispute by ${clockTime(until)}. `
      + 'The tokens stay held until then, and until a dispute is decided.'
    : `The team member says they have paid you. Your tokens stay held until ${clockTime(until)}. `
      + 'If you were not paid, raise a dispute before then.';
}

export function DisputeWindowPanel({ order, onDisputed }: { order: DisputeWindowOrder; onDisputed?: () => void }) {
  const left = useTimeLeft(order.disputeUntil);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  if (!order.disputeUntil) return null;
  if (done) {
    return <div role="status" style={{ fontSize: 12, color: 'var(--green)', fontWeight: 700 }}>Dispute raised. Staff will review it; the tokens stay held until they decide.</div>;
  }
  if (left === 0) {
    return <div role="status" style={{ fontSize: 11, color: 'var(--text3)' }}>The window to dispute this order has closed.</div>;
  }

  const submit = async () => {
    if (reason.trim().length < 5) { setError('Say briefly what happened, so staff can check it.'); return; }
    setBusy(true); setError('');
    try {
      await payments.raiseDispute(order.orderId, reason.trim());
      setDone(true);
      onDisputed?.();
    } catch (err: any) {
      // The server's sentence: a closed window says so and what to do instead.
      setError(err?.message || 'The dispute could not be raised. Try again.');
    } finally { setBusy(false); }
  };

  const fieldId = `dispute-reason-${order.orderId}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 10, background: 'color-mix(in srgb,var(--red) 8%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 30%,transparent)' }}>
      <div style={{ fontSize: 12, color: 'var(--text)' }}>{explain(order, order.disputeUntil)}</div>
      <div className="font-grotesk" aria-live="polite" style={{ fontSize: 13, fontWeight: 800, color: left < 5 * 60 * 1000 ? 'var(--red)' : 'var(--gold-ink)' }}>
        ⏱ {formatLeft(left)} left to dispute
      </div>
      {!open ? (
        <button onClick={() => setOpen(true)} style={{ alignSelf: 'flex-start', fontSize: 11, fontWeight: 800, color: 'var(--red)', background: 'none', border: '1px solid color-mix(in srgb,var(--red) 45%,transparent)', borderRadius: 999, padding: '5px 12px', cursor: 'pointer' }}>
          Raise a dispute
        </button>
      ) : (
        <>
          <label htmlFor={fieldId} style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)' }}>What happened?</label>
          <textarea id={fieldId} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000}
            placeholder={order.type === 'DEPOSIT' ? 'For example: I paid from my bank, UTR as submitted.' : 'For example: nothing has arrived in my account.'}
            style={{ width: '100%', borderRadius: 8, padding: 8, fontSize: 12, background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--line)' }} />
          {error && <div role="alert" style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={submit} disabled={busy} style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: 'var(--red)', border: 'none', borderRadius: 999, padding: '6px 14px', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Sending…' : 'Send dispute'}
            </button>
            <button onClick={() => { setOpen(false); setError(''); }} style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }}>Not now</button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The pop-up the moment a member rejects a buy as unpaid. The push is
 * `order_update` with `status: 'REJECTED'` and `disputeUntil`
 * (`merchant.routes.js`, POST /orders/:id/reject), re-dispatched by
 * GameContext as the `bazaar_order_update` window event.
 */
export function RejectedBuyPopup() {
  const [order, setOrder] = useState<DisputeWindowOrder | null>(null);

  useEffect(() => {
    const onUpdate = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.status === 'REJECTED' && d.disputeUntil && (d.orderId || d._id)) {
        setOrder({ orderId: d.orderId || d._id, type: 'DEPOSIT', status: 'REJECTED', disputeUntil: d.disputeUntil });
      }
    };
    window.addEventListener('bazaar_order_update', onUpdate);
    return () => window.removeEventListener('bazaar_order_update', onUpdate);
  }, []);

  if (!order) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="rejected-buy-title"
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.6)' }}>
      <div style={{ width: '100%', maxWidth: 420, borderRadius: 16, padding: 18, background: 'var(--surface)', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div id="rejected-buy-title" className="font-grotesk" style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>Your payment was rejected</div>
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>Order {order.orderId}</div>
        <DisputeWindowPanel order={order} />
        <button onClick={() => setOrder(null)} style={{ alignSelf: 'flex-end', fontSize: 12, fontWeight: 700, color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }}>
          Close
        </button>
      </div>
    </div>
  );
}
