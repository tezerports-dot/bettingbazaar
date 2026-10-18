// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Buying tokens with USDT, paid to the platform on BNB Smart Chain.
 *
 * ── What this rail is (owner, 2026-10-18) ──────────────────────────────────
 * A USDT buy is chosen in what the player SENDS — a whole number of 100 USDT
 * between the admin's minimum and maximum (Step 2d). The order gets an address
 * of its own on BNB Smart Chain; the player sends the USDT there, and the
 * server credits the tokens by itself once the full amount has arrived. There
 * is no merchant and nothing to submit: no transaction ID, no "I've paid".
 *
 * ── The one mistake this screen exists to prevent ──────────────────────────
 * USDT is one token on several blockchains and they are NOT interchangeable.
 * So the network is named beside the address every time, and the player is
 * told plainly that USDT on any other network cannot be recovered.
 *
 * ── Every rule comes from the server ───────────────────────────────────────
 * The amounts, the network, the address, the deadline and what has arrived.
 * This panel ships inside an Android build, so anything it decides is a
 * suggestion the client is free to decline.
 */
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { payments } from '../services/api';

export interface UsdtChainOption { chain: string; label: string }

/** Where to send, and on which network. Never one without the other. */
export interface UsdtPayTo {
  usdtAddress?: string;
  usdtChain?: string;
  usdtChainLabel?: string;
  expiresAt?: string;
}

export interface UsdtOrder {
  orderId: string;
  status: string;
  /** Platform tokens the player receives. */
  tokenAmount: number;
  /**
   * What the player SENDS, in the order's own currency — on a USDT order, USDT.
   * The order's OWN quote, fixed at creation. Never recomputed here.
   */
  fiatAmount?: number | null;
  usdtChain?: string;
  payTo?: UsdtPayTo | null;
  /** USDT that has arrived at the order's address so far (the server's count). */
  usdtReceived?: number;
  expiresAt?: string;
}

const fmtTokens = (n: number) => `${Number(n || 0).toLocaleString('en-IN')} tokens`;
const fmtUsdt = (n: number) => `${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 6 })} USDT`;

/** The USDT buy bounds, from the server (`SystemConfig.usdtBuy`). */
export interface UsdtBuyBounds { minUsdt: number; maxUsdt: number; stepUsdt: number }

/**
 * What a player receives for `usdt`, in tokens — the server's `tokensForUsdt`:
 * the rate taken to the paisa and multiplied in integer paise. Display only;
 * the server prices the order.
 */
const tokensFor = (usdt: number, rate: number | null) =>
  (rate && rate > 0 ? (usdt * Math.round(rate * 100)) / 100 : null);

/** How often an open order is asked what has arrived. The server reads the chain every 20 seconds. */
const POLL_MS = 5000;

/** mm:ss until `iso`, or null once it has passed. */
function useCountdown(iso?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  if (!iso) return null;
  const left = new Date(iso).getTime() - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Copy `text`, and say so only once the clipboard actually took it. */
const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
        catch { setCopied(false); }
      }}
      style={{
        flexShrink: 0, padding: '6px 10px', borderRadius: 9, border: '1px solid var(--line)',
        background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 11, cursor: 'pointer',
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
};

export const UsdtBuyPanel: React.FC<{
  /** The USDT a buy may be — min, max and step, in whole USDT — from the server. */
  bounds: UsdtBuyBounds;
  /**
   * How many tokens one USDT buys, from the server. Null until an admin sets a
   * rate — and then nothing here can be priced, so nothing is offered.
   */
  tokensPerUsdt: number | null;
  /** The network(s), from the server. One today: BNB Smart Chain. */
  chains: UsdtChainOption[];
  /** An order already in flight, if the player has one. */
  order?: UsdtOrder | null;
  /** Called after an order is created or finishes, so the screen above refreshes. */
  onChanged?: () => void;
}> = ({ bounds, tokensPerUsdt, chains, order = null, onChanged }) => {
  const [usdtText, setUsdtText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What the poll has learned about the open order since the list was read.
  const [live, setLive] = useState<Partial<UsdtOrder>>({});
  const [qr, setQr] = useState<string | null>(null);

  const box: React.CSSProperties = {
    background: 'var(--surface3)', border: '1px solid var(--line)',
    borderRadius: 12, padding: 14, marginBottom: 12,
  };
  const network = chains[0];

  const current = order ? { ...order, ...live, payTo: live.payTo ?? order.payTo } : null;
  const address = current?.payTo?.usdtAddress;
  const countdown = useCountdown(current?.payTo?.expiresAt ?? current?.expiresAt);

  // ── Ask the server what has arrived, while the order is open ──────────────
  useEffect(() => {
    setLive({});
    if (!order?.orderId) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const res: any = await payments.orderStatus(order.orderId);
        if (stopped || !res) return;
        setLive({ status: res.status, payTo: res.payTo ?? undefined, usdtReceived: res.usdtReceived, expiresAt: res.expiresAt });
        if (res.status && res.status !== 'PROCESSING') onChanged?.();
      } catch { /* transient: the next tick asks again */ }
    };
    const t = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.orderId]);

  // ── The address as a QR, for a wallet app's scanner ───────────────────────
  useEffect(() => {
    if (!address) { setQr(null); return; }
    let cancelled = false;
    QRCode.toDataURL(address, { margin: 1, width: 180 })
      .then((url) => { if (!cancelled) setQr(url); })
      .catch(() => { if (!cancelled) setQr(null); });
    return () => { cancelled = true; };
  }, [address]);

  // The amount typed, judged as the server will judge it: whole steps of USDT
  // between the bounds. Said as it is typed, so the button is never a dead end
  // with no reason (§32 S44).
  const usdt = Number(usdtText);
  const amountOk = usdtText !== '' && Number.isInteger(usdt) && usdt % bounds.stepUsdt === 0
    && usdt >= bounds.minUsdt && usdt <= bounds.maxUsdt;
  const amountHint = usdtText === '' ? ''
    : amountOk ? ''
    : `Choose ${bounds.minUsdt.toLocaleString('en-IN')} to ${bounds.maxUsdt.toLocaleString('en-IN')} USDT, in steps of ${bounds.stepUsdt}.`;
  const step = (delta: number) => {
    const base = amountOk ? usdt : bounds.minUsdt - (delta > 0 ? bounds.stepUsdt : -bounds.stepUsdt);
    setUsdtText(String(Math.min(bounds.maxUsdt, Math.max(bounds.minUsdt, base + delta))));
  };

  const create = async () => {
    if (!amountOk || !network) return;
    setBusy(true); setError('');
    try {
      await payments.createUsdtBuy(usdt, network.chain);
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || 'Could not start a USDT purchase');
    } finally { setBusy(false); }
  };

  // ── An order in flight ──────────────────────────────────────────────────
  if (current) {
    const payTo = current.payTo;
    // An order with no address to show (one an agent served before the change,
    // or one that has just closed). An empty address rendered as a destination
    // is how somebody sends USDT into nothing, so nothing is shown to send to.
    if (!payTo?.usdtAddress || !payTo?.usdtChain) {
      return (
        <div style={box}>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>
            USDT purchase in progress
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
            This purchase has no address to send to. Do not send anything for it. Check Payment Orders,
            or contact support if you already sent USDT.
          </div>
        </div>
      );
    }

    const owed = Number(current.fiatAmount ?? 0);
    const received = Number(current.usdtReceived ?? 0);
    const remaining = Math.max(0, owed - received);
    return (
      <div style={box}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)' }}>Send USDT</span>
          <span role="timer" style={{ fontSize: 11, fontWeight: 700, color: countdown ? 'var(--text2)' : 'var(--red)' }}>
            {countdown ? `Time left ${countdown}` : 'Time is up'}
          </span>
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
            Send USDT on this network only. USDT sent on any other network, or any other coin, cannot be recovered.
          </div>
        </div>

        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text2)' }}>
          Address for this purchase only
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 3, marginBottom: 10 }}>
          <div className="font-grotesk" style={{ flex: 1, minWidth: 0, fontSize: 12, wordBreak: 'break-all', color: 'var(--text)' }}>
            {payTo.usdtAddress}
          </div>
          <CopyButton text={payTo.usdtAddress} label="Copy address" />
        </div>
        {qr && (
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
            <img src={qr} alt="QR code of the address" width={160} height={160} style={{ borderRadius: 8, background: '#fff' }} />
          </div>
        )}

        {/* What leaves their wallet, first — it is the number they type into
            it — and what arrives here, second. The order's own quote. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}>
          <span>You send</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b style={{ color: 'var(--gold-ink)' }}>{fmtUsdt(owed)}</b>
            <CopyButton text={String(owed)} label="Copy amount" />
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
          <span>You receive</span>
          <b style={{ color: 'var(--text)' }}>{fmtTokens(current.tokenAmount)}</b>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>
          <span>Received so far</span>
          <b style={{ color: 'var(--text)' }}>{fmtUsdt(received)}</b>
        </div>

        <div role="status" style={{ fontSize: 11, color: 'var(--text3)' }}>
          {received > 0 && remaining > 0
            ? `${fmtUsdt(remaining)} still to send. You can send it in more than one transfer.`
            : 'Your tokens are added by themselves once the full amount arrives, usually within a minute or two. There is nothing to submit.'}
        </div>
        {error && <p style={{ color: 'var(--red)', fontSize: 11, marginTop: 8 }}>{error}</p>}
      </div>
    );
  }

  // ── No order yet: pick an amount ──────────────────────────────────────────
  //
  // With no rate there is no price, and offering sizes that cannot be priced is
  // how a player picks one and is refused. Say so instead.
  if (!tokensPerUsdt || tokensPerUsdt <= 0 || !network) {
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
        Send USDT on {network.label} and your tokens are added by themselves. 1 USDT = {tokensPerUsdt.toLocaleString('en-IN')} tokens.
      </div>

      <label htmlFor="usdt-amount" style={{ display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 8 }}>
        USDT to send
      </label>
      {/* Typed or stepped, in whole steps of USDT between the server's bounds.
          The server refuses anything else regardless (NOT_A_USDT_AMOUNT). */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <button type="button" aria-label={`${bounds.stepUsdt} USDT less`} onClick={() => step(-bounds.stepUsdt)}
          style={{ width: 44, borderRadius: 12, border: '1px solid var(--line)', background: 'transparent', color: 'var(--text)', fontWeight: 800, fontSize: 18, cursor: 'pointer' }}>−</button>
        <input id="usdt-amount" value={usdtText} inputMode="numeric"
          placeholder={String(bounds.minUsdt)}
          onChange={(e) => setUsdtText(e.target.value.replace(/[^0-9]/g, ''))}
          className="font-grotesk"
          style={{ flex: 1, minWidth: 0, padding: '12px 14px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface2)', color: 'var(--text)', fontWeight: 800, fontSize: 15 }} />
        <button type="button" aria-label={`${bounds.stepUsdt} USDT more`} onClick={() => step(bounds.stepUsdt)}
          style={{ width: 44, borderRadius: 12, border: '1px solid var(--line)', background: 'transparent', color: 'var(--text)', fontWeight: 800, fontSize: 18, cursor: 'pointer' }}>+</button>
      </div>
      <div role="status" style={{ fontSize: 11, marginBottom: 14, color: amountHint ? 'var(--red)' : 'var(--text2)' }}>
        {amountHint || (amountOk
          ? <>You receive <b style={{ color: 'var(--gold-ink)' }}>{fmtTokens(tokensFor(usdt, tokensPerUsdt) ?? 0)}</b></>
          : `${bounds.minUsdt.toLocaleString('en-IN')} to ${bounds.maxUsdt.toLocaleString('en-IN')} USDT, in steps of ${bounds.stepUsdt}.`)}
      </div>

      <div style={{ fontSize: 10.5, color: 'var(--text3)', marginBottom: 14 }}>
        Only USDT on {network.label} can be received. USDT sent on another network cannot be recovered.
      </div>

      {error && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10 }}>{error}</p>}
      <button
        onClick={create}
        disabled={busy || !amountOk}
        style={{
          width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer',
          fontWeight: 800, fontSize: 15, color: 'var(--on-gold)',
          background: 'var(--gold-metal)',
          opacity: (busy || !amountOk) ? 0.5 : 1,
        }}
      >
        {busy ? '⏳ Creating order…' : 'Get my payment address'}
      </button>
    </div>
  );
};

export default UsdtBuyPanel;
