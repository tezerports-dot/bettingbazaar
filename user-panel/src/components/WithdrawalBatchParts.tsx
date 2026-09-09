// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The other withdrawals that came from one request.
 *
 * ── Why one request becomes several withdrawals ────────────────────────────
 * On the cash rail a payout is settled by a merchant depositing notes at a
 * machine, and a machine deals in denominations — ₹500, ₹1,000, ₹5,000,
 * ₹10,000, ₹40,000. So ₹100,000 is not one job: it is four merchants at four
 * machines.
 *
 * They are SEPARATE withdrawals, not parts of a container. Each has its own
 * merchant, its own timer, its own escrow and its own state, and each is paid
 * when its own merchant pays it. What ties them together is a label on the row,
 * which is what this reads — so the player is told "1 of 4" instead of finding
 * four unexplained withdrawals at the same second.
 *
 * ── What the player can actually do here ───────────────────────────────────
 * One still waiting for a merchant can be cancelled — those tokens return to
 * their balance. One already with a merchant cannot: they are on their way to a
 * machine. One that is paid is money the player has.
 *
 * That distinction is the SERVER's to make, not this component's. `cancellable`
 * comes off the response rather than being re-derived from the status here: two
 * places deciding the same thing drift, and the direction this one would drift
 * is offering a Cancel button that 409s.
 *
 * ── Loaded on expand, not on render ────────────────────────────────────────
 * An ordinary withdrawal has no siblings and must not pay for a request that
 * always returns an empty list. The server answers with an empty list rather
 * than 404ing, so "not split" and "not found" are never confused — but the call
 * is still only made when somebody asks.
 */
import React, { useCallback, useEffect, useState } from 'react';
import apiClient from '../services/apiClient';

export interface WithdrawalPart {
  orderId: string;
  partIndex: number;
  /** In RUPEES — the cash this withdrawal pays out. */
  amount: number;
  status: string;
  expiresAt?: string;
  cancellable: boolean;
}

const fmtINR = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

const STATUS_COPY: Record<string, string> = {
  PENDING_QUEUE: 'Waiting for a merchant',
  ASSIGNED:      'Merchant assigned',
  PROCESSING:    'Merchant is at a machine',
  PAID:          'Paid — confirming',
  COMPLETED:     'Paid',
  CANCELLED:     'Cancelled — tokens returned',
  FAILED:        'Failed',
  REJECTED:      'Rejected',
  DISPUTED:      'Under review',
};

export const WithdrawalBatchParts: React.FC<{
  orderId: string;
  /** Called after one is cancelled, so the balance and list above refresh. */
  onChanged?: () => void;
}> = ({ orderId, onChanged }) => {
  const [parts, setParts] = useState<WithdrawalPart[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res: any = await apiClient.get(`/api/payment/order/${orderId}/batch`);
      setParts(Array.isArray(res?.parts) ? res.parts : []);
      setError('');
    } catch (e: any) {
      // The other withdrawals still exist; only this read failed. Say so rather
      // than rendering an empty list, which would read as "there are no others"
      // — the empty-state-as-success failure this codebase has shipped.
      setError(e?.message || 'Could not load the other parts of this withdrawal');
    }
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  const cancel = async (partOrderId: string) => {
    setBusy(partOrderId);
    try {
      // That withdrawal's OWN id. It is an ordinary withdrawal, so this is the
      // ordinary cancel — there is no container to tell apart from a part.
      await apiClient.post('/api/payment/order/cancel', { orderId: partOrderId });
      await load();
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || 'Could not cancel that part');
    } finally {
      setBusy(null);
    }
  };

  if (error && !parts) {
    return <p style={{ fontSize: 11, color: 'var(--red)', margin: '8px 0 0' }}>{error}</p>;
  }
  if (!parts) {
    return <p style={{ fontSize: 11, color: 'var(--text3)', margin: '8px 0 0' }}>Loading the parts…</p>;
  }
  if (!parts.length) return null;

  const paid = parts.filter((p) => p.status === 'COMPLETED').length;

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
Paid as {parts.length} separate withdrawals · {paid} done
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {parts.map((leg) => (
          <div
            key={leg.orderId}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 10, background: 'var(--surface3)', borderRadius: 10, padding: '9px 11px',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="font-grotesk" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
Part {leg.partIndex} · {fmtINR(leg.amount)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                {STATUS_COPY[leg.status] ?? leg.status}
              </div>
            </div>
            {/* The server decides this, not the status string above. */}
            {leg.cancellable && (
              <button
                onClick={() => void cancel(leg.orderId)}
                disabled={busy === leg.orderId}
                style={{
                  flexShrink: 0, fontSize: 10, fontWeight: 800, color: 'var(--red)',
                  background: 'none', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)',
                  borderRadius: 999, padding: '4px 11px', cursor: 'pointer',
                }}
              >
                {busy === leg.orderId ? 'Cancelling…' : 'Cancel part'}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <p style={{ fontSize: 11, color: 'var(--red)', margin: '8px 0 0' }}>{error}</p>}
    </div>
  );
};

export default WithdrawalBatchParts;
