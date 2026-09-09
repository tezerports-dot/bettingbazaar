// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Buying tokens with USDT, above the INR ceiling.
 *
 * ── Why this screen exists at all ──────────────────────────────────────────
 * ₹10,000 is the largest amount a cash machine dispenses and the largest a
 * merchant is approved to serve, so it is the ceiling on any INR purchase.
 * Above it there is no merchant who could take the order — the player pays the
 * platform directly, in USDT, through BTCPay Server.
 *
 * ── Every number here comes from the server ────────────────────────────────
 * The floor, the rate, the USDT amount, whether the rail is open at all. None
 * of it is computed here. The panel ships inside an Android build, so anything
 * it decides is a suggestion the client is free to decline — and a second place
 * computing a price is a place the price can drift.
 *
 * ── The three states that must not look alike ──────────────────────────────
 * "Waiting for you to pay", "we can see your payment, waiting for
 * confirmations", and "credited" are different facts. A screen that showed the
 * same "waiting" for the first two would leave a player who has already sent
 * money believing nothing arrived — this codebase has shipped the empty-state-
 * as-success failure repeatedly, and a crypto transfer is exactly where it
 * hurts, because the money is already gone.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../services/apiClient';

export interface UsdtDeposit {
  depositId: string;
  status: 'AWAITING_PAYMENT' | 'PROCESSING' | 'SETTLED' | 'EXPIRED' | 'INVALID' | string;
  tokenAmount: number;
  usdtAmount: number;
  usdtRateInr: number;
  checkoutLink?: string | null;
  expiresAt?: string | null;
  settledAt?: string | null;
  createdAt?: string;
}

const STATUS_COPY: Record<string, string> = {
  AWAITING_PAYMENT: 'Waiting for your payment',
  PROCESSING:       'Payment seen — waiting for confirmations',
  SETTLED:          'Paid — tokens added to your wallet',
  EXPIRED:          'This invoice expired. Nothing was charged.',
  INVALID:          'This invoice could not be completed. Nothing was charged.',
};

const OPEN = ['AWAITING_PAYMENT', 'PROCESSING'];

const fmtINR = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const fmtUSDT = (n: number) => `${Number(n || 0).toFixed(6).replace(/\.?0+$/, '')} USDT`;

export const UsdtBuyPanel: React.FC<{
  /** Tokens the player asked for, in rupees. */
  tokenAmount: number;
  /** Called once the tokens land, so the balance above refreshes. */
  onSettled?: () => void;
  onCancel?: () => void;
}> = ({ tokenAmount, onSettled, onCancel }) => {
  const [availability, setAvailability] = useState<{ available: boolean; minTokenAmount: number } | null>(null);
  const [deposit, setDeposit] = useState<UsdtDeposit | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const settledOnce = useRef(false);

  // Is the rail open, and from what amount? Both are the server's answers.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res: any = await apiClient.get('/api/payment/usdt/availability');
        if (!cancelled) setAvailability({ available: !!res?.available, minTokenAmount: Number(res?.minTokenAmount ?? 0) });
      } catch {
        // A failed read is NOT "unavailable". Saying the rail is closed when we
        // simply could not ask sends a player away from a purchase they could
        // have made.
        if (!cancelled) setError('Could not check whether USDT is available right now.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Resume an invoice already open. Without this a reload strands the player:
  // the server allows only one open invoice, so a fresh attempt 409s and the
  // screen would show an error for a payment that is fine.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res: any = await apiClient.get('/api/payment/usdt/deposits?limit=5');
        const open = (res?.deposits ?? []).find((d: UsdtDeposit) => OPEN.includes(d.status));
        if (open && !cancelled) setDeposit(open);
      } catch { /* nothing open, or the read failed — the create path still works */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const create = async () => {
    setBusy(true); setError('');
    try {
      const res: any = await apiClient.post('/api/payment/usdt/deposit/create', { tokenAmount });
      if (!res?.deposit) throw new Error('No invoice returned');
      setDeposit(res.deposit);
    } catch (e: any) {
      setError(e?.message || 'Could not start a USDT purchase');
    } finally {
      setBusy(false);
    }
  };

  // Poll while it is open. The settle arrives by webhook from BTCPay to the
  // server, so this screen learns about it by asking — there is no push it
  // could subscribe to that would be faster than the chain.
  const refresh = useCallback(async () => {
    if (!deposit) return;
    try {
      const res: any = await apiClient.get(`/api/payment/usdt/deposit/${deposit.depositId}`);
      if (res?.deposit) setDeposit(res.deposit);
    } catch { /* a failed poll is not a state change */ }
  }, [deposit]);

  useEffect(() => {
    if (!deposit || !OPEN.includes(deposit.status)) return;
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [deposit, refresh]);

  useEffect(() => {
    if (deposit?.status === 'SETTLED' && !settledOnce.current) {
      settledOnce.current = true;
      onSettled?.();
    }
  }, [deposit?.status, onSettled]);

  const box: React.CSSProperties = {
    background: 'var(--surface3)', border: '1px solid var(--line)',
    borderRadius: 12, padding: 14, marginBottom: 12,
  };

  if (availability && !availability.available) {
    return (
      <div style={box}>
        <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>USDT is not available right now</div>
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>
          Purchases above {fmtINR(availability.minTokenAmount - 0.01)} need USDT, and that option is temporarily off.
          Please try a smaller amount or contact support.
        </div>
      </div>
    );
  }

  if (!deposit) {
    return (
      <div style={box}>
        <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>Pay with USDT</div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12 }}>
          {fmtINR(tokenAmount)} is above the UPI limit, so this purchase is paid in USDT.
          You will be shown the exact amount and a payment page.
        </div>
        {error && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10 }}>{error}</p>}
        <button
          onClick={create}
          disabled={busy}
          style={{
            width: '100%', padding: 13, borderRadius: 12, border: 'none', cursor: 'pointer',
            fontWeight: 800, fontSize: 14, color: '#1a1200',
            background: 'linear-gradient(135deg,var(--gold2),var(--gold))', opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? '⏳ Creating invoice…' : 'Get a USDT payment page'}
        </button>
        {onCancel && (
          <button onClick={onCancel} style={{ marginTop: 8, width: '100%', padding: 10, borderRadius: 10, border: '1px solid var(--line)', background: 'transparent', color: 'var(--text3)', fontSize: 11, cursor: 'pointer' }}>
            Choose a different amount
          </button>
        )}
      </div>
    );
  }

  const open = OPEN.includes(deposit.status);
  return (
    <div style={box}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)' }}>Pay with USDT</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>{deposit.depositId.slice(-8)}</span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
        <span>You send</span>
        <b style={{ color: 'var(--gold-ink)' }}>{fmtUSDT(deposit.usdtAmount)}</b>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
        <span>You receive</span>
        <b style={{ color: 'var(--text)' }}>{Number(deposit.tokenAmount).toLocaleString('en-IN')} tokens</b>
      </div>
      {/* The rate this invoice was priced at, not the rate now. It is fixed for
          the life of the invoice, which is what the player is agreeing to. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)', marginBottom: 12 }}>
        <span>Rate</span>
        <span>1 USDT = {fmtINR(deposit.usdtRateInr)}</span>
      </div>

      <div
        role="status"
        style={{
          fontSize: 11, fontWeight: 700, marginBottom: 12,
          color: deposit.status === 'SETTLED' ? 'var(--green)'
            : deposit.status === 'PROCESSING' ? 'var(--gold-ink)' : 'var(--text2)',
        }}
      >
        {STATUS_COPY[deposit.status] ?? deposit.status}
      </div>

      {/* Only while it can still be paid, and only when the server sent one. A
          "pay now" button that goes nowhere is worse than no button — it reads
          as working. */}
      {open && deposit.checkoutLink && (
        <a
          href={deposit.checkoutLink}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'block', textAlign: 'center', width: '100%', padding: 13,
            borderRadius: 12, fontWeight: 800, fontSize: 14, color: '#1a1200',
            textDecoration: 'none', background: 'linear-gradient(135deg,var(--gold2),var(--gold))',
          }}
        >
          Open the payment page
        </a>
      )}
      {open && !deposit.checkoutLink && (
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>Waiting for the payment page…</div>
      )}

      {open && deposit.expiresAt && (
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8 }}>
          Pay before {new Date(deposit.expiresAt).toLocaleTimeString()}. Nothing is charged if you do not.
        </div>
      )}
    </div>
  );
};

export default UsdtBuyPanel;
