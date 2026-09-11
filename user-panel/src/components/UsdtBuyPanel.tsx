// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Buying tokens with USDT, from a merchant.
 *
 * ── What this rail is ──────────────────────────────────────────────────────
 * A USDT buy is denominated in what the player RECEIVES — 50,000, 100,000 or
 * 500,000 platform tokens — from a USDT merchant, by sending tokens to that
 * merchant's wallet and submitting the transaction ID. What they SEND is
 * derived from the admin's rate: at 100 tokens per USDT, 500, 1,000 or 5,000
 * USDT.
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
  /** Platform tokens the player receives. */
  tokenAmount: number;
  /**
   * What the player SENDS, in the order's own currency — so on a USDT order,
   * USDT. The same field the INR rails carry rupees in, read according to
   * `currency`, because one value with one name cannot drift from itself.
   *
   * It is the order's OWN quote, fixed at creation from the rate live at that
   * moment. Never recomputed here: the rate is admin-editable, and a screen
   * that re-derived it would show a price the order does not hold.
   */
  fiatAmount?: number | null;
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

const fmtTokens = (n: number) => `${Number(n || 0).toLocaleString('en-IN')} tokens`;

/**
 * What a player sends for a given size.
 *
 * Rounded UP to two decimals, matching the server's `usdtForTokens` — the
 * server's figure is the one the order records, and a panel that rounded down
 * would quote less than the order asks for.
 */
const usdtFor = (tokens: number, rate: number | null) =>
  (rate && rate > 0 ? Math.ceil((tokens / rate) * 100) / 100 : null);

export const UsdtBuyPanel: React.FC<{
  /** The three sizes, in PLATFORM TOKENS, from the server. */
  denominations: number[];
  /**
   * How many tokens one USDT buys, from the server. Null until an admin sets a
   * rate — and then nothing here can be priced, so nothing is offered.
   */
  tokensPerUsdt: number | null;
  /** The networks, from the server. */
  chains: UsdtChainOption[];
  /** An order already in flight, if the player has one. */
  order?: UsdtOrder | null;
  /** Called after an order is created or paid, so the screen above refreshes. */
  onChanged?: () => void;
}> = ({ denominations, tokensPerUsdt, chains, order = null, onChanged }) => {
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

        {/* What leaves their wallet, first — it is the number they type into
            it — and what arrives here, second. The SEND figure is the order's
            own quote, fixed when it was created; recomputing it from a rate
            read now would show a price the order will not honour. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}>
          <span>You send</span>
          <b style={{ color: 'var(--gold-ink)' }}>
            {order.fiatAmount === undefined || order.fiatAmount === null
              ? '—'
              : `${Number(order.fiatAmount).toLocaleString('en-IN')} USDT`}
          </b>
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
  //
  // With no rate there is no price, and offering sizes that cannot be priced is
  // how a player picks one and is refused. Say so instead.
  if (!tokensPerUsdt || tokensPerUsdt <= 0) {
    return (
      <div style={box}>
        <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>USDT is not available right now</div>
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>
          No USDT price has been set. Please try again later or contact support.
        </div>
      </div>
    );
  }

  return (
    <div style={box}>
      <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)', marginBottom: 4 }}>Buy with USDT</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12 }}>
        Buy platform tokens by sending USDT to a merchant. 1 USDT = {tokensPerUsdt.toLocaleString('en-IN')} tokens.
      </div>

      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 8 }}>
        Tokens to buy
      </div>
      {/* The three sizes, from the SERVER. A free field here would let a player
          type a size no merchant serves and be refused after waiting. */}
      <div role="radiogroup" aria-label="Amount to buy" style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
        {denominations.map((value) => {
          const cost = usdtFor(value, tokensPerUsdt);
          return (
            <button
              key={value} type="button" role="radio" aria-checked={amount === value}
              onClick={() => setAmount(value)}
              className="font-grotesk"
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                padding: '14px 14px', borderRadius: 12, cursor: 'pointer', fontWeight: 800, fontSize: 15,
                border: amount === value ? '2px solid var(--gold)' : '1px solid var(--line)',
                background: amount === value ? 'var(--gold-soft, rgba(212,175,55,.12))' : 'transparent',
                color: amount === value ? 'var(--gold-ink)' : 'var(--text)',
              }}
            >
              {/* What they RECEIVE, and what they SEND. Both, together: the
                  denomination is a token count and the price is derived from
                  the admin's rate, so showing one without the other leaves a
                  player guessing at the number that leaves their wallet. */}
              <span>{fmtTokens(value)}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)' }}>
                {cost === null ? '—' : `${cost.toLocaleString('en-IN')} USDT`}
              </span>
            </button>
          );
        })}
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
