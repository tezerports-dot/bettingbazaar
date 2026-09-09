// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Buying tokens with USDT, from a merchant.
 *
 * ── What this rail is ──────────────────────────────────────────────────────
 * ₹10,000 is the ceiling on any INR buy — the largest a cash machine dispenses
 * and the largest a merchant is approved to serve. Above it a player buys with
 * USDT: exactly ₹50,000 or ₹100,000, from a USDT merchant, by sending tokens to
 * that merchant's wallet and submitting the transaction ID.
 *
 * There is no payment processor. The counterparty is a person.
 *
 * ── The one mistake this screen exists to prevent ──────────────────────────
 * USDT is one token on several blockchains and they are NOT interchangeable.
 * Tokens sent to a Tron address from a BNB Smart Chain wallet are gone — no
 * support desk recovers them. So:
 *
 *   • the player picks the network FIRST, before an order exists;
 *   • they are shown the address for that network and no other;
 *   • the network is named next to the address every single time, never once
 *     at the top of a screen the address is scrolled away from;
 *   • the transaction ID is checked against that network's shape before it is
 *     submitted, because a hash from the wrong chain is proof of a payment the
 *     merchant is not watching for.
 *
 * ── Every rule comes from the server ───────────────────────────────────────
 * The amounts, the networks, the address, the acceptable hash. This panel ships
 * inside an Android build, so anything it decides is a suggestion the client is
 * free to decline — and a second place stating a money rule is a place it can
 * drift.
 */
import React, { useState } from 'react';
import apiClient from '../services/apiClient';

export interface UsdtChainOption { chain: string; label: string }

/** Where to send, and on which network. Never one without the other. */
export interface UsdtPayTo {
  usdtAddress?: string;
  usdtChain?: string;
  usdtChainLabel?: string;
  merchantRef?: string;
  expiresAt?: string;
}

export interface UsdtOrder {
  orderId: string;
  status: string;
  tokenAmount: number;
  usdtChain?: string;
  payTo?: UsdtPayTo | null;
}

/**
 * The transaction-id shapes, mirrored from the server
 * (backend/domains/merchant/merchantCurrency.js) for immediate feedback only.
 * The server refuses anything malformed regardless of what this allows.
 */
const TX_SHAPE: Record<string, { pattern: RegExp; hint: string }> = {
  TRC20: { pattern: /^[0-9a-fA-F]{64}$/, hint: '64 hexadecimal characters' },
  BEP20: { pattern: /^0x[0-9a-fA-F]{64}$/i, hint: '“0x” followed by 64 hexadecimal characters' },
};

const fmtINR = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export const UsdtBuyPanel: React.FC<{
  /** The two amounts, from the server. */
  denominations: number[];
  /** The networks, from the server. */
  chains: UsdtChainOption[];
  /** An order already in flight, if the player has one. */
  order?: UsdtOrder | null;
  /** Called after an order is created or paid, so the screen above refreshes. */
  onChanged?: () => void;
}> = ({ denominations, chains, order = null, onChanged }) => {
  const [amount, setAmount] = useState<number | null>(null);
  const [chain, setChain] = useState<string | null>(null);
  const [txId, setTxId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const box: React.CSSProperties = {
    background: 'var(--surface3)', border: '1px solid var(--line)',
    borderRadius: 12, padding: 14, marginBottom: 12,
  };
  const chosenChain = order?.payTo?.usdtChain ?? order?.usdtChain ?? chain;
  const shape = chosenChain ? TX_SHAPE[chosenChain] : undefined;
  const txError = txId.trim() && shape && !shape.pattern.test(txId.trim())
    ? `That is not a ${order?.payTo?.usdtChainLabel ?? 'valid'} transaction ID — ${shape.hint}.`
    : '';

  const create = async () => {
    if (!amount || !chain) return;
    setBusy(true); setError('');
    try {
      await apiClient.post('/api/payment/usdt/deposit/create', { tokenAmount: amount, usdtChain: chain });
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || 'Could not start a USDT purchase');
    } finally { setBusy(false); }
  };

  const submitHash = async () => {
    if (!order || !txId.trim() || txError) return;
    setBusy(true); setError('');
    try {
      await apiClient.post(`/api/payment/order/${order.orderId}/mark-paid`, { utrNumber: txId.trim() });
      onChanged?.();
    } catch (e: any) {
      // Said in full. "This transaction ID has already been used for another
      // order" is the whole answer — a player retyping it will never succeed,
      // and a vague error has them do exactly that.
      setError(e?.message || 'Could not submit that transaction ID');
    } finally { setBusy(false); }
  };

  // ── An order in flight ──────────────────────────────────────────────────
  if (order) {
    const payTo = order.payTo;
    // Two states that must not look alike: waiting for a merchant, and having
    // an address to send to. An empty address rendered as a destination is how
    // somebody sends tokens into nothing.
    if (!payTo?.usdtAddress || !payTo?.usdtChain) {
      return (
        <div style={box}>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>
            Finding a merchant
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            We are matching you with a merchant who accepts USDT on your chosen network.
            You will be shown their address here — do not send anything until then.
          </div>
        </div>
      );
    }

    return (
      <div style={box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)' }}>Send USDT</span>
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>{payTo.merchantRef}</span>
        </div>

        {/* The NETWORK, first and loudest. Sending on the wrong one is the
            single unrecoverable mistake available on this platform. */}
        <div
          role="note"
          style={{
            background: 'var(--surface2)', border: '1px solid var(--gold)', borderRadius: 10,
            padding: '10px 12px', marginBottom: 10,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--gold-ink)' }}>
            Network
          </div>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>
            {payTo.usdtChainLabel ?? payTo.usdtChain}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 4 }}>
            Send on this network only. USDT sent on a different network cannot be recovered.
          </div>
        </div>

        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text2)' }}>
          Address
        </div>
        <div
          className="font-grotesk"
          style={{ fontSize: 12, wordBreak: 'break-all', color: 'var(--text)', marginTop: 3, marginBottom: 10 }}
        >
          {payTo.usdtAddress}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>
          <span>You receive</span>
          <b style={{ color: 'var(--text)' }}>{Number(order.tokenAmount).toLocaleString('en-IN')} tokens</b>
        </div>

        {order.status === 'PAID' ? (
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gold-ink)' }}>
            Transaction ID submitted — the merchant is confirming it.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 6 }}>
              Transaction ID
            </div>
            <input
              value={txId}
              onChange={(e) => setTxId(e.target.value)}
              placeholder={shape?.hint ?? 'Transaction ID'}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="font-grotesk"
              style={{
                width: '100%', padding: '11px 12px', borderRadius: 10, fontSize: 12,
                border: `1px solid ${txError ? 'var(--red)' : 'var(--line)'}`,
                background: 'var(--surface2)', color: 'var(--text)', marginBottom: 6,
              }}
            />
            {txError && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 8 }}>{txError}</p>}
            {error && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 8 }}>{error}</p>}
            <button
              onClick={submitHash}
              disabled={busy || !txId.trim() || Boolean(txError)}
              style={{
                width: '100%', padding: 13, borderRadius: 12, border: 'none', cursor: 'pointer',
                fontWeight: 800, fontSize: 14, color: '#1a1200',
                background: 'linear-gradient(135deg,var(--gold2),var(--gold))',
                opacity: (busy || !txId.trim() || txError) ? 0.5 : 1,
              }}
            >
              {busy ? '⏳ Submitting…' : "I've sent it"}
            </button>
          </>
        )}
      </div>
    );
  }

  // ── No order yet: pick an amount and a network ──────────────────────────
  return (
    <div style={box}>
      <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)', marginBottom: 4 }}>Buy with USDT</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12 }}>
        Above the UPI limit, purchases are paid in USDT to a merchant.
      </div>

      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 8 }}>
        Amount
      </div>
      {/* The two amounts, from the SERVER. A free field here would let a player
          type ₹30,000 and be refused after waiting. */}
      <div role="radiogroup" aria-label="Amount to buy" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 14 }}>
        {denominations.map((value) => (
          <button
            key={value} type="button" role="radio" aria-checked={amount === value}
            onClick={() => setAmount(value)}
            className="font-grotesk"
            style={{
              padding: '14px 10px', borderRadius: 12, cursor: 'pointer', fontWeight: 800, fontSize: 15,
              border: amount === value ? '2px solid var(--gold)' : '1px solid var(--line)',
              background: amount === value ? 'var(--gold-soft, rgba(212,175,55,.12))' : 'transparent',
              color: amount === value ? 'var(--gold-ink)' : 'var(--text)',
            }}
          >
            {fmtINR(value)}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 8 }}>
        Network you will send from
      </div>
      {/* Chosen BEFORE the order exists, because it decides which merchants can
          serve it. Asking afterwards would mean reassigning the order. */}
      <div role="radiogroup" aria-label="Network" style={{ display: 'grid', gap: 8, marginBottom: 8 }}>
        {chains.map((option) => (
          <button
            key={option.chain} type="button" role="radio" aria-checked={chain === option.chain}
            onClick={() => setChain(option.chain)}
            style={{
              padding: '12px 14px', borderRadius: 12, cursor: 'pointer', fontWeight: 700, fontSize: 13,
              textAlign: 'left',
              border: chain === option.chain ? '2px solid var(--gold)' : '1px solid var(--line)',
              background: chain === option.chain ? 'var(--gold-soft, rgba(212,175,55,.12))' : 'transparent',
              color: chain === option.chain ? 'var(--gold-ink)' : 'var(--text)',
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text3)', marginBottom: 14 }}>
        Choose the network your wallet actually holds USDT on. Tokens sent on the wrong network cannot be recovered.
      </div>

      {error && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10 }}>{error}</p>}
      <button
        onClick={create}
        disabled={busy || !amount || !chain}
        style={{
          width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer',
          fontWeight: 800, fontSize: 15, color: '#1a1200',
          background: 'linear-gradient(135deg,var(--gold2),var(--gold))',
          opacity: (busy || !amount || !chain) ? 0.5 : 1,
        }}
      >
        {busy ? '⏳ Creating order…' : 'Continue'}
      </button>
    </div>
  );
};

export default UsdtBuyPanel;
