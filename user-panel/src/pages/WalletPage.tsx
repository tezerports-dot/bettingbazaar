// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * WalletPage.tsx — 2026 "Bazaar" redesign.
 *
 * P2P token exchange (fixed 1:1, 1 BB token = ₹1). The data layer is UNCHANGED —
 * every apiClient endpoint, the order state machine, polling, the UPI link and UTR flow
 * and dispute handling are preserved exactly. Only the presentation is rebuilt on
 * the redesign theme tokens (dark/light) to match the handoff prototype.
 *
 * GOVERNANCE §1: no USDT sell rail exists for users — the "pay with" rail is UPI
 * (INR) only. Token conversion is the fixed 1:1 constant (Phase 006).
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import apiClient from '../services/apiClient';
import { PAYMENT_STATE_LABELS, PAYMENT_STATE_COLOR, isActive, type PaymentOrderState } from '../services/paymentStateMachine';
// M-05: WalletTransactionDTO normalizer — GOVERNANCE §4: this module must have consumers.
import { normalizeTransaction } from '../services/walletTransactionDTO';
import ScreenShell, { card, capLabel } from '../redesign/Screen';
// A cash withdrawal too large for one denomination becomes several separate
// withdrawals. This shows a player which ones came from the same request.
import WithdrawalBatchParts from '../components/WithdrawalBatchParts';
// Above the INR ceiling there is no merchant who could serve the order, so the
// purchase is paid to the platform in USDT instead.
import UsdtBuyPanel from '../components/UsdtBuyPanel';

// ── Types ──────────────────────────────────────────────────────────────────────
interface Balances { depositBalance: number; winningsBalance: number; lockedBalance: number; reserveBalance: number; }

/**
 * What the server says this wallet can actually stake right now.
 *
 * Fetched rather than computed here on purpose. The reserve is not freely
 * spendable — only `reservePercent` of a stake may come from it — so the
 * ceiling is a money rule, and a second copy of it in the panel would drift
 * from the one bet.routes enforces. GET /api/user/bet-limits runs the same
 * function the bet route does.
 */
interface BetLimits {
  maxStake: number;
  reservePercent: number;
  reserveLocked: number;
  total: number;
}
interface LedgerEntry { _id: string; type: string; field: string; amount: number; balanceBefore: number; balanceAfter: number; reason: string; createdAt: string; }
interface PaymentOrder {
  _id: string; orderId: string; type: 'DEPOSIT' | 'WITHDRAWAL'; status: string;
  tokenAmount: number; fiatAmount: number; rateUsed: number; createdAt: string;
  expiresAt?: string; paidAt?: string;
  /**
   * Where to pay, and nothing about who is being paid.
   *
   * This was `merchantSnapshot`, which carried the merchant's UPI handle, their
   * QR, and their bank account number, IFSC and account-holder name. A field the
   * panel's type names is a field somebody will render — and this one was
   * rendered, with a Copy button. The server sends `payTo` now:
   * backend/domains/payment/playerOrderView.js is the only shape a player gets.
   */
  payTo?: { paymentLink?: string; merchantRef?: string; expiresAt?: string } | null;
  utrNumber?: string; proofScreenshot?: string;
  // The rail this order was created on. Snapshotted server-side and immutable,
  // so an admin switching rails mid-flight cannot change what this screen is
  // supposed to be showing.
  paymentMode?: 'P2P_UPI' | 'CASH_ATM';
  cashLinkId?: string | null;
  // The label grouping the separate withdrawals that came from one request.
  // Null on an ordinary withdrawal, so the expander only appears where there is
  // something to expand. It is a LABEL: nothing here decides anything by it.
  withdrawalBatchRef?: string | null;
  userBankDetails?: { accountNumber?: string; ifscCode?: string; bankName?: string; accountHolderName?: string; };
  upiId?: string;
}
interface UserProfile {
  id: string; username: string;
  bankDetails?: { upiId?: string; accountNumber?: string; ifscCode?: string; bankName?: string; accountHolderName?: string; };
}
type TabKey = 'exchange' | 'ledger' | 'payments';
type BuyStep = 'amount' | 'pay_now' | 'waiting';
type SellStep = 'amount' | 'waiting';

// ── Helpers ────────────────────────────────────────────────────────────────────
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const fmtINR = (n: number) => `₹${r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtT = (n: number) => `${r2(n).toLocaleString('en-IN')} T`;
const fmtDate = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const STATE_HEX: Record<string, string> = { yellow: 'var(--gold-ink)', blue: 'var(--bombay)', green: 'var(--green)', red: 'var(--red)', orange: '#FB8C00' };
function statusChip(status: string): React.CSSProperties {
  const col = STATE_HEX[PAYMENT_STATE_COLOR[status as PaymentOrderState] ?? 'yellow'] ?? 'var(--gold-ink)';
  return { fontSize: 9, fontWeight: 800, letterSpacing: '.06em', padding: '4px 10px', borderRadius: 999, color: col, background: `color-mix(in srgb, ${col} 16%, transparent)` };
}

const inputBox: React.CSSProperties = { width: '100%', height: 48, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 12, padding: '0 15px', color: 'var(--text)', fontSize: 15, fontWeight: 700, outline: 'none' };

// ── CountdownTimer ──────────────────────────────────────────────────────────────
function CountdownTimer({ expiresAt, onExpire }: { expiresAt?: string; onExpire?: () => void }) {
  const [timeLeft, setTimeLeft] = useState(0);
  const firedRef = useRef(false);
  useEffect(() => {
    if (!expiresAt) return;
    const update = () => {
      const left = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      setTimeLeft(left);
      if (left === 0 && !firedRef.current) { firedRef.current = true; onExpire?.(); }
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpire]);
  if (!expiresAt) return null;
  const m = Math.floor(timeLeft / 60000);
  const s = Math.floor((timeLeft % 60000) / 1000);
  const urgent = timeLeft < 5 * 60 * 1000 && timeLeft > 0;
  return (
    <span className="font-grotesk" style={{ color: urgent ? 'var(--red)' : 'var(--gold-ink)', fontWeight: 800, fontSize: 12 }}>
      {timeLeft === 0 ? '⏰ Expired' : `⏱ ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`}
    </span>
  );
}

// ── Buy Payment UI (restyled; logic unchanged) ──────────────────────────────────
/**
 * Exported for its own test. The buy flow is where a player's money leaves the
 * platform's sight, and it had no coverage while it collected a screenshot no
 * decision read and rendered a QR through a third-party service.
 */
export function BuyPaymentUI({ order, onPaid, onExpire, onExpiryExtended, cashLink = null }: {
  order: PaymentOrder;
  onPaid: () => void;
  onExpire: () => void;
  /**
   * The server granted the player extra time to submit their UTR, and the
   * deadline moved. The screen above owns the order, so it is the one that has
   * to hear about it — a countdown still running on the old deadline would
   * expire the order on screen while the server considers it live.
   */
  onExpiryExtended?: (expiresAt: string) => void;
  /**
   * The ATM link serving this order, on the CASH_ATM rail.
   *
   * Resolved by the server for the order's OWNER only. `null` means either
   * that this is the UPI rail, or that no merchant has supplied a link yet —
   * two states the screen must render differently, because "we are finding you
   * a machine" and "here is where to go" are not the same message and a player
   * shown the wrong one either waits forever or walks out for nothing.
   */
  cashLink?: { paymentLink: string; expiresAt: string } | null;
}) {
  // Where to pay, and nothing about who is being paid. `payTo` carries a
  // per-order payment link, an opaque reference and the deadline — see
  // backend/domains/payment/playerOrderView.js.
  const payTo = order.payTo;
  const onCashRail = order.paymentMode === 'CASH_ATM';
  const [utr, setUtr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [disputeVisible, setDisputeVisible] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  /**
   * The link this player pays. Handed over by the server, never assembled here.
   *
   * ── Why this stopped being built on the client ────────────────────────────
   * It used to be constructed from `merchantSnapshot.upiId` and
   * `merchantSnapshot.merchantName`, which meant the panel had to be GIVEN the
   * merchant's UPI handle — and the response that carried it also carried their
   * QR, their bank account number, their IFSC and the name on the account. A
   * player could read and keep all of it from one deposit, and the row below
   * used to put the handle on screen with a Copy button.
   *
   * Now the server builds the intent (backend/domains/payment/paymentLink.js)
   * and sends only the link, so the panel has nothing to build it from. That is
   * what makes "a player never sees the merchant's details" true rather than a
   * thing the screen politely refrains from rendering.
   *
   * The amount formatting moved with it, which is the other half: `am` must be
   * two decimals or a UPI app rejects it, and `fiatAmount` arithmetic produces
   * floats like 100.10000000000001. That belongs on the side an attacker
   * holding the handset cannot edit.
   *
   * On the CASH_ATM rail this is the link the ATM produced and the merchant
   * supplied, used verbatim — constructing anything from it would change what
   * the machine agreed to dispense.
   */
  const intentString = onCashRail
    ? (cashLink?.paymentLink ?? '')
    : (payTo?.paymentLink ?? '');

  useEffect(() => {
    if (order.status === 'PAID' && order.paidAt) {
      const elapsed = Date.now() - new Date(order.paidAt).getTime();
      if (elapsed >= 10 * 60 * 1000) setDisputeVisible(true);
    }
  }, [order.status, order.paidAt]);

  const handleSubmitPayment = async () => {
    if (utr.trim().length < 12) { setError('UTR must be at least 12 characters'); return; }
    setSubmitting(true); setError('');
    try {
      // The UTR alone. A screenshot proved nothing — trivially forged, read by
      // no approval, and the merchant matches this reference against their own
      // bank statement.
      await apiClient.post(`/api/payment/order/${order.orderId}/mark-paid`, { utrNumber: utr.trim() });
      onPaid();
    } catch (err: any) { setError(err?.message || 'Failed to submit. Try again.'); }
    finally { setSubmitting(false); }
  };

  /**
   * Ask for the minute, once.
   *
   * `asked` is a local guard against re-firing on every focus, not the rule —
   * the rule is the server's, decided in one statement, because a client-side
   * flag is not something a merchant's held capacity should depend on.
   *
   * A failure is SILENT on purpose. The player has not lost anything they had:
   * the deadline is whatever it already was, the countdown on screen is still
   * driven by the order, and an error toast here would be alarming noise at the
   * exact moment they are trying to type a reference.
   */
  const askedForGrace = useRef(false);
  const [graceNote, setGraceNote] = useState('');
  const claimGrace = async () => {
    if (askedForGrace.current) return;
    askedForGrace.current = true;
    try {
      const res: any = await apiClient.post(`/api/payment/order/${order.orderId}/utr-grace`, {});
      if (res?.expiresAt && new Date(res.expiresAt).getTime() > new Date(order.expiresAt || 0).getTime()) {
        setGraceNote('Extra time added to submit your UTR.');
        onExpiryExtended?.(res.expiresAt);
      }
    } catch { /* the deadline is unchanged; the countdown already shows it */ }
  };

  const handleDispute = async () => {
    if (!disputeReason.trim()) { setError('Please enter a dispute reason'); return; }
    try {
      await apiClient.post(`/api/payment/order/${order.orderId}/dispute`, { reason: disputeReason.trim() });
      alert('Dispute raised. Admin will review shortly.');
    } catch (err: any) { setError(err?.message || 'Failed to raise dispute'); }
  };

  // ── Waiting for a machine ────────────────────────────────────────────────
  // On the cash rail an order exists before any merchant has supplied a link.
  // Rendering the payment screen with an empty link would show a player a
  // "pay now" button that does nothing — the empty-state-as-success failure
  // this codebase has shipped before. Say what is actually happening.
  if (onCashRail && !cashLink && order.status !== 'PAID') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ textAlign: 'center', padding: '12px 8px' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🏧</div>
          <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: 'var(--text)' }}>
            Finding you a machine
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.5, margin: '6px 0 0' }}>
            A merchant is going to an ATM to set up your {fmtINR(order.fiatAmount)} withdrawal.
            You will get a link to pay the moment one is ready.
          </div>
          {order.expiresAt && (
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
              <CountdownTimer expiresAt={order.expiresAt} onExpire={onExpire} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (order.status === 'PAID') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ textAlign: 'center', padding: '12px 8px' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⏳</div>
          <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: 'var(--text)' }}>Payment submitted</div>
          <div style={{ fontSize: 12, color: 'var(--text3)', margin: '6px 0 4px' }}>UTR <b style={{ color: 'var(--text)' }}>{order.utrNumber}</b></div>
          <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.5 }}>Waiting for the merchant to confirm.<br />Tokens are credited on confirmation.</div>
        </div>
        {disputeVisible && (
          <div style={{ background: 'color-mix(in srgb,#FB8C00 10%,transparent)', border: '1px solid color-mix(in srgb,#FB8C00 30%,transparent)', borderRadius: 12, padding: 12 }}>
            <p style={{ fontSize: 11, color: '#FB8C00', margin: '0 0 8px' }}>Merchant not responding?</p>
            <input value={disputeReason} onChange={e => setDisputeReason(e.target.value)} placeholder="Describe the issue" style={{ ...inputBox, height: 42, fontSize: 13, fontWeight: 400, marginBottom: 8 }} />
            <button onClick={handleDispute} style={{ width: '100%', background: '#FB8C00', color: '#1a1200', fontWeight: 800, padding: 10, borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 13 }}>Raise Dispute</button>
          </div>
        )}
        {error && <p style={{ color: 'var(--red)', fontSize: 11, textAlign: 'center' }}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: 'color-mix(in srgb,var(--gold) 10%,var(--surface2))', border: '1px solid var(--line2)', borderRadius: 12, padding: 12, textAlign: 'center' }}>
        <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700 }}>Pay exactly</div>
        <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 26, color: 'var(--gold-ink)' }}>{fmtINR(order.fiatAmount)}</div>
        <div style={{ fontSize: 10, color: 'var(--text3)' }}>to receive {fmtT(order.tokenAmount)} · <CountdownTimer expiresAt={order.expiresAt} onExpire={onExpire} /></div>
      </div>

      {intentString ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <a href={intentString} style={{ width: '100%', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', color: '#1a1200', fontWeight: 800, padding: '15px 12px', borderRadius: 13, fontSize: 15, textAlign: 'center', display: 'block', textDecoration: 'none' }}>
            Pay {fmtINR(order.fiatAmount)} in your UPI app
          </a>
          <p style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
            Opens with the amount already filled in. Come back with the UTR.
          </p>
          {/* ── The merchant's UPI row is GONE, and this is why ────────────
              It rendered `Merchant UPI · <name>` with the handle underneath and
              a Copy button. The comment that used to be here argued it was
              needed on the UPI rail as a fallback and for support — and it is
              the exact thing the privacy rule forbids in the other direction: a
              player is not to learn who they are paying.

              The response it read from carried more than the handle. It carried
              the merchant's QR, their bank account number, their IFSC and the
              name on the account, on every deposit, and the player could read
              and keep all of it. That is now stripped server-side by
              `playerOrderView.js`, so there is nothing left here to render even
              if somebody added the markup back.

              What honestly remains: tapping the link opens the player's own UPI
              app, which shows them the payee it is about to pay. That is the UPI
              protocol, not this screen — and it is a very different thing from
              handing them an account number to keep. */}
        </div>
      ) : (
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 12, padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>⏳ Waiting for merchant details…</div>
      )}

      <div>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 6 }}>UTR / UPI Ref No. <span style={{ color: 'var(--text3)', fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>(min 12 chars)</span></label>
        <input
          value={utr}
          onChange={e => setUtr(e.target.value)}
          /* ── Claiming the minute to fetch the reference ──────────────────
             The order's own timer IS the UTR deadline, so a player who starts
             entering the reference with seconds left would watch the order
             expire while they go and read it off their bank app — cancelling a
             payment they have already made.

             Touching this field is the "I am entering it now" moment, so it is
             what claims the window. Safe to fire on every focus: the server
             grants it ONCE and only ever moves the deadline outward, so a
             re-focus is a refusal that changes nothing. */
          onFocus={() => { void claimGrace(); }}
          placeholder="Enter after paying"
          className="font-grotesk"
          style={{ ...inputBox, height: 44, fontSize: 13 }}
        />
        {utr.length > 0 && utr.length < 12 && <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 700 }}>{12 - utr.length} more characters needed</span>}
        {graceNote && <span style={{ fontSize: 10.5, color: 'var(--green)', fontWeight: 700 }}>{graceNote}</span>}
      </div>

      {error && <p style={{ color: 'var(--red)', fontSize: 11, textAlign: 'center' }}>{error}</p>}

      <button onClick={handleSubmitPayment} disabled={utr.trim().length < 12 || submitting}
        style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 15, color: utr.trim().length >= 12 ? '#1a1200' : 'var(--text3)', background: utr.trim().length >= 12 ? 'linear-gradient(135deg,var(--gold2),var(--gold))' : 'var(--surface3)' }}>
        {submitting ? '⏳ Submitting…' : "✅ I've Paid"}
      </button>
    </div>
  );
}

// ── Main WalletPage ───────────────────────────────────────────────────────────
const WalletPage: React.FC = () => {
  const [balances, setBalances]         = useState<Balances>({ depositBalance: 0, winningsBalance: 0, lockedBalance: 0, reserveBalance: 0 });
  const [limits, setLimits]             = useState<BetLimits | null>(null);
  const [userProfile, setUserProfile]   = useState<UserProfile | null>(null);
  const [ledger, setLedger]             = useState<LedgerEntry[]>([]);
  const [paymentOrders, setPaymentOrders] = useState<PaymentOrder[]>([]);
  // Which split withdrawal, if any, has its parts open. One at a time — a
  // player is looking at one withdrawal, and every list open at once is noise.
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [tab, setTab]                   = useState<TabKey>('exchange');
  const [side, setSide]                 = useState<'buy' | 'sell'>('buy');
  const [loading, setLoading]           = useState(true);
  const [ledgerPage, setLedgerPage]     = useState(1);
  const [hasMore, setHasMore]           = useState(true);

  const [buyStep, setBuyStep]           = useState<BuyStep>('amount');
  const [buyTokens, setBuyTokens]       = useState('');
  // What the SERVER says is buyable. Never a list written here: the app ships
  // as an APK containing this bundle, so a client-side list is one an attacker
  // can edit — and one that drifts from the gate is a player offered an amount
  // that will be refused.
  // The ATM link for the buy order in flight, if one has been claimed. Fetched
  // from the order's own read rather than the status poll, because the link is
  // resolved for the owner and the poll is a lightweight status shape.
  const [buyCashLink, setBuyCashLink]   = useState<{ paymentLink: string; expiresAt: string } | null>(null);
  const [rail, setRail]                 = useState<{
    paymentMode: string | null; buyDenominations: number[]; maxInrBuy: number | null;
  }>({ paymentMode: null, buyDenominations: [], maxInrBuy: null });
  const [activeBuyOrder, setActiveBuyOrder] = useState<PaymentOrder | null>(null);
  const [buyLoading, setBuyLoading]     = useState(false);
  const [buyError, setBuyError]         = useState('');

  const [sellStep, setSellStep]         = useState<SellStep>('amount');
  const [sellTokens, setSellTokens]     = useState('');
  const [activeSellOrder, setActiveSellOrder] = useState<PaymentOrder | null>(null);
  const [sellLoading, setSellLoading]   = useState(false);
  const [sellError, setSellError]       = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadMeta = useCallback(async () => {
    try {
      const prof: any = await apiClient.get('/api/v1/user/profile');
      const u = prof?.user;
      if (u) {
        setUserProfile({ id: u._id || u.id, username: u.username || u.mobile || 'User', bankDetails: u.bankDetails });
      }

      // Balances come from the LIMITS endpoint, not the profile: it reads all
      // four pockets straight from the wallet and returns the stake ceiling
      // computed by the same rule the bet route enforces. Taking the numbers
      // and the ceiling from one response also means they cannot disagree with
      // each other on screen.
      // The settlement rail and the amounts it allows, from the one payload
      // that owns them (domains/configuration/systemConfigPayload.js).
      const sys: any = await apiClient.get('/api/v1/system/config');
      if (sys?.config) {
        setRail({
          paymentMode: sys.config.paymentMode ?? null,
          buyDenominations: sys.config.buyDenominations ?? [],
          maxInrBuy: sys.config.maxInrBuy ?? null,
        });
      }

      const lim: any = await apiClient.get('/api/user/bet-limits');
      if (lim?.success) {
        setBalances({
          depositBalance: lim.deposit ?? 0, winningsBalance: lim.winnings ?? 0,
          lockedBalance: lim.locked ?? 0, reserveBalance: lim.reserve ?? 0,
        });
        setLimits({
          maxStake: lim.maxStake ?? 0,
          reservePercent: lim.reservePercent ?? 0,
          reserveLocked: lim.reserveLocked ?? 0,
          total: lim.total ?? 0,
        });
      }
    } catch (err: unknown) { console.error('[WalletPage/loadMeta]', err instanceof Error ? err.message : err); }
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const res: any = await apiClient.get('/api/payment/orders?limit=20');
      const orders = Array.isArray(res?.orders) ? res.orders : [];
      setPaymentOrders(orders);
      const activeDeposit = orders.find((o: PaymentOrder) => o.type === 'DEPOSIT' && ['ASSIGNED', 'PROCESSING', 'PAID'].includes(o.status));
      const activeWithdrawal = orders.find((o: PaymentOrder) => o.type === 'WITHDRAWAL' && ['ASSIGNED', 'PROCESSING', 'PAID'].includes(o.status));
      if (activeDeposit && buyStep === 'amount') { setActiveBuyOrder(activeDeposit); setBuyStep('pay_now'); setSide('buy'); }
      if (activeWithdrawal && sellStep === 'amount') { setActiveSellOrder(activeWithdrawal); setSellStep('waiting'); setSide('sell'); }
    } catch (err: unknown) { console.error('[WalletPage/loadOrders]', err instanceof Error ? err.message : err); }
  }, [buyStep, sellStep]);

  const loadLedger = useCallback(async (pg: number, reset = false) => {
    setLoading(true);
    try {
      const res: any = await apiClient.get(`/api/v1/wallet/ledger?page=${pg}&limit=25`);
      // M-05: DTO normalizer is the canonical shape; we validate each row through
      // it (single consumer) but render the raw CREDIT/DEBIT ledger fields, which
      // carry the +/− sign the DTO flattens away.
      const items: LedgerEntry[] = Array.isArray(res?.entries)
        ? res.entries.filter((e: any) => { normalizeTransaction(e); return true; })
        : [];
      setLedger(prev => reset ? items : [...prev, ...items]);
      setHasMore(items.length === 25);
    } catch (err: unknown) { console.error('[WalletPage/loadLedger]', err instanceof Error ? err.message : err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadMeta(); loadOrders(); }, [loadMeta, loadOrders]);
  useEffect(() => { if (tab === 'ledger') { setLedgerPage(1); loadLedger(1, true); } }, [tab, loadLedger]);

  useEffect(() => {
    const activeOrderId = activeBuyOrder?.orderId || activeSellOrder?.orderId;
    if (!activeOrderId) { if (pollRef.current) clearInterval(pollRef.current); return; }
    pollRef.current = setInterval(async () => {
      try {
        const res: any = await apiClient.get(`/api/payment/order/${activeOrderId}/status`);
        if (activeBuyOrder) {
          setActiveBuyOrder(prev => prev ? { ...prev, ...res } : prev);
          if (res.status === 'COMPLETED') { resetBuy(); loadMeta(); loadOrders(); }
          if (res.status === 'CANCELLED' || res.status === 'FAILED') { resetBuy(); loadOrders(); }

          // On the cash rail an order waits with no link until a merchant
          // reaches a machine, so the link arrives LATER than the order. The
          // status poll is a lightweight shape and does not carry it; the
          // order's own read resolves it for the owner. Asked for only while
          // the link is still missing, so a served player is not re-reading it
          // every three seconds.
          if (activeBuyOrder.paymentMode === 'CASH_ATM' && !buyCashLink
              && res.status !== 'COMPLETED' && res.status !== 'CANCELLED' && res.status !== 'FAILED') {
            const full: any = await apiClient.get(`/api/payment/order/${activeOrderId}`);
            if (full?.cashLink) setBuyCashLink(full.cashLink);
          }
        }
        if (activeSellOrder) {
          setActiveSellOrder(prev => prev ? { ...prev, ...res } : prev);
          if (res.status === 'COMPLETED') { resetSell(); loadMeta(); loadOrders(); }
          if (res.status === 'CANCELLED' || res.status === 'FAILED') { resetSell(); loadOrders(); }
        }
      } catch (_) { /* transient */ }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBuyOrder?.orderId, activeSellOrder?.orderId]);

  const cancelOrder = async (orderId: string) => {
    try { await apiClient.post('/api/payment/order/cancel', { orderId }); loadOrders(); }
    catch (e: any) { alert(e?.message || 'Failed to cancel'); }
  };

  /**
   * Try an order that nobody served, again.
   *
   * The new order goes to the FRONT of the queue. Everything else about it is
   * ordinary — the server runs the same creation path, so the same KYC, limit,
   * denomination and escrow rules apply as to a first attempt.
   *
   * The order id is remembered locally so the button disappears immediately
   * rather than waiting for a reload. That is presentation only: the server
   * allows one retry per order and is what actually enforces it.
   */
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retriedAway, setRetriedAway] = useState<string[]>([]);
  const retryOrder = async (orderId: string) => {
    setRetrying(orderId);
    try {
      await apiClient.post(`/api/payment/order/${orderId}/retry`, {});
      setRetriedAway(prev => [...prev, orderId]);
      await loadOrders();
      await loadMeta();
    } catch (e: any) {
      alert(e?.message || 'Could not try that order again');
    } finally {
      setRetrying(null);
    }
  };

  const resetBuy = () => { setBuyStep('amount'); setBuyTokens(''); setActiveBuyOrder(null); setBuyError(''); setBuyCashLink(null); };
  const handleBuySubmit = async () => {
    const amt = parseInt(buyTokens);
    if (!amt || amt < 1) { setBuyError('Enter a valid token amount'); return; }
    setBuyLoading(true); setBuyError('');
    try {
      const res: any = await apiClient.post('/api/payment/deposit/create', { tokenAmount: amt });
      const order = res?.order;
      if (!order) throw new Error('No order returned');
      setActiveBuyOrder(order); setBuyStep('pay_now'); loadMeta();
    } catch (err: any) { setBuyError(err?.message || 'Failed to create order'); }
    finally { setBuyLoading(false); }
  };

  const resetSell = () => { setSellStep('amount'); setSellTokens(''); setActiveSellOrder(null); setSellError(''); };
  const handleSellSubmit = async () => {
    const amt = parseInt(sellTokens);
    if (!amt || amt < 1) { setSellError('Enter a valid token amount'); return; }
    if (amt > balances.winningsBalance) { setSellError(`Insufficient winnings balance (${fmtT(balances.winningsBalance)} available)`); return; }
    setSellLoading(true); setSellError('');
    try {
      const res: any = await apiClient.post('/api/payment/withdrawal/create', { tokenAmount: amt });
      const order = res?.order;
      if (!order) throw new Error('No order returned');
      setActiveSellOrder({ ...order, userBankDetails: res.order.userBankDetails });
      setSellStep('waiting'); loadMeta();
    } catch (err: any) { setSellError(err?.message || 'Failed to create order'); }
    finally { setSellLoading(false); }
  };

  // What the player OWNS, all four pockets. Distinct from what they can stake
  // right now, which is `limits.maxStake` — conflating the two is the bug this
  // screen exists to stop repeating.
  const total = r2(balances.depositBalance + balances.winningsBalance + balances.reserveBalance);

  // Which rail serves this amount. The threshold is the SERVER's `maxInrBuy`,
  // never a number written here: `assertBuyIsLegal` refuses an INR buy above it
  // whatever the panel thinks, so a local constant would only ever produce a
  // screen that offers a flow the server rejects.
  //
  // Until the config has loaded `maxInrBuy` is null, and this stays false — the
  // INR button is what shows. That is the right default: it is the flow that
  // works for almost every purchase, and the server refuses the rest with a
  // sentence naming USDT.
  const aboveInrCeiling = rail.maxInrBuy !== null
    && rail.paymentMode !== 'CASH_ATM'
    && (parseInt(buyTokens) || 0) > rail.maxInrBuy;
  const maxStake = limits?.maxStake ?? 0;
  const reserveLocked = limits?.reserveLocked ?? 0;

  const tabBtn = (k: TabKey, label: string) => (
    <button onClick={() => setTab(k)} style={{ flex: 'none', padding: '9px 16px', borderRadius: 11, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800, background: tab === k ? 'var(--gold)' : 'var(--surface3)', color: tab === k ? '#1a1200' : 'var(--text2)' }}>{label}</button>
  );

  return (
    <ScreenShell icon="💳" title="Wallet" sub="Buy & sell tokens · P2P exchange">
      {/* Balance hero */}
      <div style={{ borderRadius: 18, padding: 18, background: 'linear-gradient(135deg,#1a1205,#0c0a06 60%),radial-gradient(120% 140% at 100% 0,rgba(212,175,55,.25),transparent 55%)', border: '1px solid var(--line2)', boxShadow: 'var(--shadow)', position: 'relative', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.16em', textTransform: 'uppercase', color: '#C9A94A' }}>Token balance</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: '#9c9484', background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 999, padding: '3px 9px' }}>1 T = ₹1</span>
        </div>
        <div className="font-grotesk" style={{ fontWeight: 700, fontSize: 38, color: '#F5E6BD', textShadow: '0 2px 20px rgba(212,175,55,.3)', margin: '2px 0 2px' }}>{r2(total).toLocaleString('en-IN')} <span style={{ fontSize: 20, color: '#C9A94A' }}>T</span></div>

        {/* ── What you can actually stake, stated separately ─────────────────
            The headline above is what the player OWNS. It is not what they can
            bet: only `reservePercent` of a stake may come from the reserve, so
            a wallet holding 1,000 with most of it in reserve may have a
            two-figure ceiling. Showing only the total is what sent players into
            a refused bet and a support ticket. */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: '#9c9484' }}>Available to bet</span>
          <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 17, color: maxStake > 0 ? '#8ff0b6' : '#e08a8a' }}>
            {limits ? `${fmtT(maxStake)} T` : '—'}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
          <div style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 11, padding: '9px 11px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#9c9484' }}>DEPOSIT</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: '#EAE3CE' }}>{fmtT(balances.depositBalance)}</div></div>
          <div style={{ background: 'rgba(49,196,110,.1)', border: '1px solid rgba(49,196,110,.25)', borderRadius: 11, padding: '9px 11px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#4bd486' }}>WINNINGS</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: '#8ff0b6' }}>{fmtT(balances.winningsBalance)}</div></div>
          {/* Its own tile, never folded into DEPOSIT — they spend differently. */}
          <div style={{ background: 'rgba(120,150,255,.09)', border: '1px solid rgba(120,150,255,.25)', borderRadius: 11, padding: '9px 11px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#93a8f0' }}>RESERVE</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: '#b9c8ff' }}>{fmtT(balances.reserveBalance)}</div></div>
          <div style={{ background: 'rgba(212,175,55,.1)', border: '1px solid rgba(212,175,55,.25)', borderRadius: 11, padding: '9px 11px' }}><div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.08em', color: '#e0c060' }}>IN PLAY</div><div className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: '#f0d488' }}>{fmtT(balances.lockedBalance)}</div></div>
        </div>

        {/* Only when it actually bites. A player whose reserve is fully usable
            does not need a paragraph explaining a limit they will never hit. */}
        {reserveLocked > 0 && (
          <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 11, background: 'rgba(120,150,255,.07)', border: '1px solid rgba(120,150,255,.18)', fontSize: 11, lineHeight: 1.55, color: '#a9b6e0' }}>
            <strong style={{ color: '#c3cdf5' }}>{fmtT(reserveLocked)} T</strong> of your reserve is not available for betting yet.
            Each bet may draw only {limits?.reservePercent}% from reserve — the rest comes from deposit and winnings, so
            adding to your deposit raises this limit.
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="bb-noscroll" style={{ display: 'flex', gap: 8, margin: '14px 0', overflowX: 'auto' }}>
        {tabBtn('exchange', 'Exchange')}
        {tabBtn('ledger', 'History')}
        {tabBtn('payments', 'Payment Orders')}
      </div>

      {/* EXCHANGE */}
      {tab === 'exchange' && (
        <>
          <div style={card}>
            <div style={{ display: 'flex', background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 12, padding: 4, gap: 4, marginBottom: 16 }}>
              <button onClick={() => { setSide('buy'); }} style={{ flex: 1, padding: 11, borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800, background: side === 'buy' ? 'linear-gradient(180deg,var(--gold2),var(--gold))' : 'transparent', color: side === 'buy' ? '#1a1200' : 'var(--text2)' }}>⬇️ BUY TOKENS</button>
              <button onClick={() => { setSide('sell'); }} style={{ flex: 1, padding: 11, borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 800, background: side === 'sell' ? 'linear-gradient(180deg,#8ff0b6,var(--green))' : 'transparent', color: side === 'sell' ? '#052018' : 'var(--text2)' }}>⬆️ SELL TOKENS</button>
            </div>

            {side === 'buy' ? (
              buyStep === 'amount' ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--surface3)', border: '1px solid var(--line)', borderRadius: 11, padding: 11, marginBottom: 14 }}>
                    <span style={{ fontSize: 18, color: 'var(--gold-ink)' }}>📲</span>
                    <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>UPI (INR)</span><span style={{ fontSize: 9, color: 'var(--text3)' }}>Instant · scan & pay a verified merchant</span></span>
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 9 }}>Tokens to buy</div>
                  {/* On the ATM cash rail the amount is not typed. A cash
                      machine dispenses one of a fixed set, so anything between
                      them is an order no merchant could serve — and the server
                      refuses it. Offering a free field here would let a player
                      type an amount, wait, and be rejected for a reason the
                      screen never showed them.

                      The tiles are rendered from the SERVER's list. If it is
                      empty the field falls back to typing, because an empty
                      picker offers nothing at all. */}
                  {rail.paymentMode === 'CASH_ATM' && rail.buyDenominations.length > 0 ? (
                    <div role="radiogroup" aria-label="Amount to buy" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 8 }}>
                      {rail.buyDenominations.map((amount) => {
                        const on = buyTokens === String(amount);
                        return (
                          <button
                            key={amount} type="button" role="radio" aria-checked={on}
                            onClick={() => setBuyTokens(String(amount))}
                            className="font-grotesk"
                            style={{
                              padding: '14px 10px', borderRadius: 12, cursor: 'pointer', fontWeight: 800, fontSize: 15,
                              border: on ? '2px solid var(--gold)' : '1px solid var(--line)',
                              background: on ? 'var(--gold-soft, rgba(212,175,55,.12))' : 'transparent',
                              color: on ? 'var(--gold-ink)' : 'var(--text)',
                            }}
                          >
                            ₹{amount.toLocaleString()}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ position: 'relative', marginBottom: 6 }}>
                      <input value={buyTokens} onChange={e => setBuyTokens(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="e.g. 500" className="font-grotesk" style={{ ...inputBox, padding: '0 44px 0 15px' }} />
                      <span style={{ position: 'absolute', right: 15, top: '50%', transform: 'translateY(-50%)', color: 'var(--gold-ink)', fontWeight: 800, fontSize: 13 }}>T</span>
                    </div>
                  )}
                  {rail.maxInrBuy !== null && rail.paymentMode !== 'CASH_ATM' && (
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
                      Up to ₹{rail.maxInrBuy.toLocaleString()} in one purchase. Buy with USDT for more.
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 14 }}>You pay <b style={{ color: 'var(--gold-ink)' }}>{fmtINR(parseInt(buyTokens) || 0)}</b> · 1 token = ₹1</div>
                  {buyError && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10 }}>{buyError}</p>}
                  {/* Above the INR ceiling there is no merchant who could serve
                      the order, so the button that leads to one is not offered.
                      The threshold comes from the SERVER (`maxInrBuy`); a
                      number written here would be a second owner of a money
                      rule, and the day they disagreed a player would be shown a
                      merchant flow the server refuses.

                      The panel does not decide the price or the floor — the
                      USDT panel asks for both. All this decides is which of the
                      two affordances to render. */}
                  {aboveInrCeiling ? (
                    <UsdtBuyPanel
                      tokenAmount={parseInt(buyTokens) || 0}
                      onSettled={() => { loadMeta(); loadOrders(); }}
                      onCancel={() => setBuyTokens('')}
                    />
                  ) : (
                    <button onClick={handleBuySubmit} disabled={!buyTokens || buyLoading} style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 15, color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', boxShadow: '0 8px 22px -8px var(--glow)', opacity: (!buyTokens || buyLoading) ? .5 : 1 }}>{buyLoading ? '⏳ Creating order…' : 'Continue to payment'}</button>
                  )}
                </>
              ) : activeBuyOrder ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}><span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>Complete payment</span><button onClick={resetBuy} style={{ fontSize: 11, color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer' }}>✕ Cancel</button></div>
                  <BuyPaymentUI
                    order={activeBuyOrder}
                    cashLink={buyCashLink}
                    onPaid={() => setActiveBuyOrder(prev => prev ? { ...prev, status: 'PAID' } : prev)}
                    onExpire={() => { resetBuy(); loadOrders(); }}
                    /* The countdown reads `order.expiresAt`. Without this the
                       screen would keep counting down to the OLD deadline and
                       expire an order the server has just extended. */
                    onExpiryExtended={(expiresAt) => setActiveBuyOrder(prev => prev ? { ...prev, expiresAt } : prev)}
                  />
                </>
              ) : null
            ) : (
              sellStep === 'amount' ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(49,196,110,.09)', border: '1px solid rgba(49,196,110,.22)', borderRadius: 11, padding: '11px 13px', marginBottom: 14 }}><span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)' }}>Sellable (winnings only)</span><span className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--green)' }}>{fmtT(balances.winningsBalance)}</span></div>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text2)', marginBottom: 9 }}>Tokens to sell</div>
                  <div style={{ position: 'relative', marginBottom: 6 }}>
                    <input value={sellTokens} onChange={e => setSellTokens(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="e.g. 500" className="font-grotesk" style={{ ...inputBox, padding: '0 44px 0 15px' }} />
                    <span style={{ position: 'absolute', right: 15, top: '50%', transform: 'translateY(-50%)', color: 'var(--green)', fontWeight: 800, fontSize: 13 }}>T</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 14 }}>You receive <b style={{ color: 'var(--green)' }}>{fmtINR(parseInt(sellTokens) || 0)}</b></div>
                  {sellError && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10 }}>{sellError}</p>}
                  <button onClick={handleSellSubmit} disabled={!sellTokens || sellLoading} style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 15, color: '#052018', background: 'linear-gradient(135deg,#8ff0b6,var(--green))', opacity: (!sellTokens || sellLoading) ? .5 : 1 }}>{sellLoading ? '⏳ Creating order…' : 'Sell tokens'}</button>
                  <p style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.5, margin: '11px 2px 0' }}>Payout goes to your saved bank/UPI from Profile. A merchant is auto-assigned and sends your money within the 15-min window.</p>
                </>
              ) : activeSellOrder ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>Sell order in progress</span><CountdownTimer expiresAt={activeSellOrder.expiresAt} onExpire={() => { resetSell(); loadOrders(); }} /></div>
                  <div style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 11, padding: '11px 13px', fontSize: 12, color: 'var(--text2)' }}>
                    Merchant will send <b style={{ color: 'var(--green)' }}>{fmtINR(activeSellOrder.fiatAmount)}</b> to your saved account.
                    {activeSellOrder.userBankDetails?.accountNumber && <div style={{ marginTop: 6, color: 'var(--text3)' }}>{activeSellOrder.userBankDetails.bankName} ••••{activeSellOrder.userBankDetails.accountNumber.slice(-4)}</div>}
                  </div>
                  <div style={{ background: 'color-mix(in srgb,var(--bombay) 12%,transparent)', border: '1px solid color-mix(in srgb,var(--bombay) 30%,transparent)', borderRadius: 11, padding: 11, textAlign: 'center', fontSize: 11, color: 'var(--bombay)' }}>{['ASSIGNED', 'PROCESSING'].includes(activeSellOrder.status) ? '⏳ Merchant processing your payout…' : '✅ Payment sent. Waiting for final confirmation…'}</div>
                  <button onClick={resetSell} style={{ width: '100%', padding: 11, borderRadius: 11, border: 'none', background: 'var(--surface3)', color: 'var(--text2)', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>Back to overview</button>
                </div>
              ) : null
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, background: 'color-mix(in srgb,var(--gold) 7%,var(--surface))', border: '1px solid var(--line)', borderRadius: 13, padding: 13, marginTop: 12 }}>
            <span style={{ fontSize: 16 }}>🛡️</span><span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text2)' }}>P2P exchange: a verified merchant is auto-assigned per order. Buy = pay the merchant from the pre-filled link, submit the UTR, tokens credit on confirm. Sell = merchant pays your bank/UPI. Raise a dispute from Payment Orders if something goes wrong.</span>
          </div>
        </>
      )}

      {/* HISTORY (ledger) */}
      {tab === 'ledger' && (
        <div style={{ ...card, padding: '6px 16px' }}>
          {loading && ledger.length === 0 ? (
            Array.from({ length: 5 }).map((_, i) => <div key={i} className="bb-skel" style={{ height: 48, borderRadius: 10, background: 'var(--skel)', margin: '10px 0' }} />)
          ) : ledger.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text3)' }}><div style={{ fontSize: 30, marginBottom: 6 }}>📭</div>No transactions yet</div>
          ) : (
            <>
              {ledger.map(entry => {
                const isCredit = entry.type === 'CREDIT';
                return (
                  <div key={entry._id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{entry.reason || entry.type}</span><span style={{ fontSize: 10, color: 'var(--text3)' }}>{fmtDate(entry.createdAt)} · {entry.field === 'depositBalance' ? 'Deposit' : 'Winnings'} wallet</span></span>
                    <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 13, color: isCredit ? 'var(--green)' : 'var(--red)' }}>{isCredit ? '+' : '−'}{fmtT(entry.amount)}</span>
                  </div>
                );
              })}
              {hasMore && !loading && <button onClick={() => { const n = ledgerPage + 1; setLedgerPage(n); loadLedger(n); }} style={{ width: '100%', padding: 12, margin: '10px 0', background: 'var(--surface3)', borderRadius: 11, border: 'none', color: 'var(--text2)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Load more</button>}
            </>
          )}
        </div>
      )}

      {/* PAYMENT ORDERS */}
      {tab === 'payments' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={loadOrders} style={{ fontSize: 11, color: 'var(--gold-ink)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>↻ Refresh</button>
          {paymentOrders.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text3)' }}><div style={{ fontSize: 30, marginBottom: 6 }}>📋</div>No payment orders yet</div>
          ) : paymentOrders.map(order => {
            const canCancel = order.status === 'PENDING_QUEUE';
            // An order that ended without ever being served can be tried again,
            // at the FRONT of the queue. Nothing happened on it — no assignment
            // means no transaction and nobody is liable — but the player still
            // wants their tokens, and going to the back of the queue that just
            // failed them is how somebody waits twice and gets nothing twice.
            //
            // `retriedAway` hides the button once they have used it: the server
            // allows one retry per order and a button that 409s is worse than
            // no button.
            const canRetry = ['CANCELLED', 'FAILED', 'REJECTED'].includes(order.status)
              && !retriedAway.includes(order.orderId || order._id);
            return (
              <div key={order._id} style={{ ...card, padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <span style={statusChip(order.status)}>{PAYMENT_STATE_LABELS[order.status as PaymentOrderState] ?? order.status}</span>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>{fmtDate(order.createdAt)}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div><div style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 700 }}>Type</div><div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{order.type === 'DEPOSIT' ? '⬇️ Buy' : '⬆️ Sell'}</div></div>
                  <div><div style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 700 }}>Tokens</div><div className="font-grotesk" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{fmtT(order.tokenAmount)}</div></div>
                  <div><div style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 700 }}>{order.type === 'DEPOSIT' ? 'You pay' : 'You receive'}</div><div className="font-grotesk" style={{ fontSize: 13, fontWeight: 700, color: 'var(--gold-ink)' }}>{fmtINR(order.fiatAmount)}</div></div>
                </div>
                {order.utrNumber && <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>UTR: <span className="font-grotesk" style={{ color: 'var(--text2)' }}>{order.utrNumber}</span></div>}
                {order.expiresAt && ['ASSIGNED', 'PROCESSING'].includes(order.status) && <div style={{ marginBottom: 8 }}><CountdownTimer expiresAt={order.expiresAt} /></div>}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 9 }}>
                  <span style={{ fontSize: 9, color: 'var(--text3)' }}>Order {order.orderId || order._id}</span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    {/* Only where there is something to expand. An expander on
                        every withdrawal would promise siblings that do not exist. */}
                    {order.withdrawalBatchRef && (
                      <button
                        onClick={() => setExpandedOrderId(expandedOrderId === (order.orderId || order._id) ? null : (order.orderId || order._id))}
                        style={{ fontSize: 10, fontWeight: 800, color: 'var(--gold-ink)', background: 'none', border: '1px solid color-mix(in srgb,var(--gold-ink) 40%,transparent)', borderRadius: 999, padding: '4px 11px', cursor: 'pointer' }}
                      >
                        {expandedOrderId === (order.orderId || order._id) ? 'Hide parts' : 'Show parts'}
                      </button>
                    )}
                    {canCancel && <button onClick={() => cancelOrder(order.orderId || order._id)} style={{ fontSize: 10, fontWeight: 800, color: 'var(--red)', background: 'none', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 999, padding: '4px 11px', cursor: 'pointer' }}>Cancel</button>}
                    {canRetry && (
                      <button
                        onClick={() => retryOrder(order.orderId || order._id)}
                        disabled={retrying === (order.orderId || order._id)}
                        style={{ fontSize: 10, fontWeight: 800, color: 'var(--gold-ink)', background: 'none', border: '1px solid color-mix(in srgb,var(--gold-ink) 45%,transparent)', borderRadius: 999, padding: '4px 11px', cursor: 'pointer' }}
                      >
                        {retrying === (order.orderId || order._id) ? 'Retrying…' : 'Try again'}
                      </button>
                    )}
                  </span>
                </div>
                {order.withdrawalBatchRef && expandedOrderId === (order.orderId || order._id) && (
                  <WithdrawalBatchParts
                    orderId={order.orderId || order._id}
                    onChanged={() => { void loadOrders(); void loadMeta(); }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </ScreenShell>
  );
};

export default WalletPage;
