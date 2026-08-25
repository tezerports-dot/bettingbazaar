// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * WalletPage.tsx — 2026 "Bazaar" redesign.
 *
 * P2P token exchange (fixed 1:1, 1 BB token = ₹1). The data layer is UNCHANGED —
 * every apiClient endpoint, the order state machine, polling, QR/UTR/proof flow
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
interface MerchantSnapshot {
  merchantId?: string; merchantName?: string; upiId?: string; qrCodeUrl?: string;
  bankName?: string; accountNo?: string; ifsc?: string; accountHolder?: string; snapshotAt?: string; expiresAt?: string;
}
interface PaymentOrder {
  _id: string; orderId: string; type: 'DEPOSIT' | 'WITHDRAWAL'; status: string;
  tokenAmount: number; fiatAmount: number; rateUsed: number; createdAt: string;
  expiresAt?: string; paidAt?: string; merchantSnapshot?: MerchantSnapshot;
  utrNumber?: string; proofScreenshot?: string;
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

// ── UPI QR Generator ───────────────────────────────────────────────────────────
function UpiQrCode({ intentString }: { intentString: string }) {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const QRCode = (await import('qrcode' as any)).default || (await import('qrcode' as any));
        const url = await QRCode.toDataURL(intentString, { width: 220, margin: 2 });
        if (!cancelled) setQrDataUrl(url);
      } catch {
        if (!cancelled) setQrDataUrl(`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(intentString)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [intentString]);
  if (!qrDataUrl) return <div style={{ width: 200, height: 200, background: 'var(--surface3)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>Generating QR…</div>;
  return <img src={qrDataUrl} alt="UPI QR Code" style={{ width: 200, height: 200, borderRadius: 12, border: '4px solid #fff' }} />;
}

// ── Buy Payment UI (restyled; logic unchanged) ──────────────────────────────────
function BuyPaymentUI({ order, onPaid, onExpire }: { order: PaymentOrder; onPaid: () => void; onExpire: () => void; }) {
  const snap = order.merchantSnapshot;
  const [utr, setUtr] = useState('');
  const [screenshot, setScreenshot] = useState<{ cdnUrl: string; fileKey: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [disputeVisible, setDisputeVisible] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  const intentString = snap?.upiId
    ? `upi://pay?pa=${snap.upiId}&pn=${encodeURIComponent(snap.merchantName || 'Merchant')}&am=${order.fiatAmount}&cu=INR&tn=${encodeURIComponent(`BettingBazaar-${order.orderId}`)}`
    : '';

  useEffect(() => {
    if (order.status === 'PAID' && order.paidAt) {
      const elapsed = Date.now() - new Date(order.paidAt).getTime();
      if (elapsed >= 10 * 60 * 1000) setDisputeVisible(true);
    }
  }, [order.status, order.paidAt]);

  const handleScreenshotUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setError('');
    try {
      // `/api/user/...`, NOT `/api/upload/user/...` — upload.routes.js is mounted
      // at `/api`, so its paths already start `/user/`. The extra segment 404'd
      // every payment-proof upload, which blocks the manual deposit flow at the
      // point where the player proves they paid.
      const urlRes: any = await apiClient.post(`/api/user/payment-proof/${order.orderId}/upload-url`, { fileName: file.name, contentType: file.type, fileSize: file.size });
      await fetch(urlRes.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      if (!urlRes.fileKey || !urlRes.cdnUrl) throw new Error('Upload response missing file key');
      setScreenshot({ cdnUrl: urlRes.cdnUrl, fileKey: urlRes.fileKey });
    } catch (err: any) { setError(err?.message || 'Upload failed. Try again.'); }
    finally { setUploading(false); }
  };

  const handleSubmitPayment = async () => {
    if (utr.trim().length < 12) { setError('UTR must be at least 12 characters'); return; }
    if (!screenshot) { setError('Please upload payment screenshot'); return; }
    setSubmitting(true); setError('');
    try {
      await apiClient.post(`/api/payment/order/${order.orderId}/mark-paid`, { utrNumber: utr.trim(), proofFileKey: screenshot.fileKey, proofCdnUrl: screenshot.cdnUrl });
      onPaid();
    } catch (err: any) { setError(err?.message || 'Failed to submit. Try again.'); }
    finally { setSubmitting(false); }
  };

  const handleDispute = async () => {
    if (!disputeReason.trim()) { setError('Please enter a dispute reason'); return; }
    try {
      await apiClient.post(`/api/payment/order/${order.orderId}/dispute`, { reason: disputeReason.trim() });
      alert('Dispute raised. Admin will review shortly.');
    } catch (err: any) { setError(err?.message || 'Failed to raise dispute'); }
  };

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

      {snap?.upiId && intentString ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <UpiQrCode intentString={intentString} />
          <a href={intentString} style={{ width: '100%', background: 'var(--bombay)', color: '#fff', fontWeight: 800, padding: 12, borderRadius: 12, fontSize: 13, textAlign: 'center', display: 'block' }}>📱 Open UPI App</a>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 11, padding: '11px 13px', width: '100%' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 9, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)' }}>Merchant UPI · {snap.merchantName}</span>
              <span className="font-grotesk" style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{snap.upiId}</span>
            </span>
          </div>
        </div>
      ) : (
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--line)', borderRadius: 12, padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>⏳ Waiting for merchant details…</div>
      )}

      <div>
        <label style={{ display: 'block', fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text3)', marginBottom: 6 }}>UTR / UPI Ref No. <span style={{ color: 'var(--text3)', fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>(min 12 chars)</span></label>
        <input value={utr} onChange={e => setUtr(e.target.value)} placeholder="Enter after paying" className="font-grotesk" style={{ ...inputBox, height: 44, fontSize: 13 }} />
        {utr.length > 0 && utr.length < 12 && <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 700 }}>{12 - utr.length} more characters needed</span>}
      </div>

      <label style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: 13, borderRadius: 11, cursor: 'pointer', border: `2px dashed ${screenshot ? 'var(--green)' : 'var(--line2)'}`, background: screenshot ? 'color-mix(in srgb,var(--green) 12%,transparent)' : 'var(--surface2)' }}>
        <span style={{ fontSize: 18 }}>{screenshot ? '✅' : '📸'}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: screenshot ? 'var(--green)' : 'var(--text2)' }}>{uploading ? 'Uploading…' : screenshot ? 'Screenshot attached' : 'Upload payment screenshot'}</span>
        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleScreenshotUpload} disabled={uploading} />
      </label>

      {error && <p style={{ color: 'var(--red)', fontSize: 11, textAlign: 'center' }}>{error}</p>}

      <button onClick={handleSubmitPayment} disabled={utr.trim().length < 12 || !screenshot || submitting}
        style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 15, color: (utr.trim().length >= 12 && screenshot) ? '#1a1200' : 'var(--text3)', background: (utr.trim().length >= 12 && screenshot) ? 'linear-gradient(135deg,var(--gold2),var(--gold))' : 'var(--surface3)' }}>
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
  const [tab, setTab]                   = useState<TabKey>('exchange');
  const [side, setSide]                 = useState<'buy' | 'sell'>('buy');
  const [loading, setLoading]           = useState(true);
  const [ledgerPage, setLedgerPage]     = useState(1);
  const [hasMore, setHasMore]           = useState(true);

  const [buyStep, setBuyStep]           = useState<BuyStep>('amount');
  const [buyTokens, setBuyTokens]       = useState('');
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

  const resetBuy = () => { setBuyStep('amount'); setBuyTokens(''); setActiveBuyOrder(null); setBuyError(''); };
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
                  <div style={{ position: 'relative', marginBottom: 6 }}>
                    <input value={buyTokens} onChange={e => setBuyTokens(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="e.g. 500" className="font-grotesk" style={{ ...inputBox, padding: '0 44px 0 15px' }} />
                    <span style={{ position: 'absolute', right: 15, top: '50%', transform: 'translateY(-50%)', color: 'var(--gold-ink)', fontWeight: 800, fontSize: 13 }}>T</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 14 }}>You pay <b style={{ color: 'var(--gold-ink)' }}>{fmtINR(parseInt(buyTokens) || 0)}</b> · 1 token = ₹1</div>
                  {buyError && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 10 }}>{buyError}</p>}
                  <button onClick={handleBuySubmit} disabled={!buyTokens || buyLoading} style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 15, color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', boxShadow: '0 8px 22px -8px var(--glow)', opacity: (!buyTokens || buyLoading) ? .5 : 1 }}>{buyLoading ? '⏳ Creating order…' : 'Continue to payment'}</button>
                </>
              ) : activeBuyOrder ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}><span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>Complete payment</span><button onClick={resetBuy} style={{ fontSize: 11, color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer' }}>✕ Cancel</button></div>
                  <BuyPaymentUI order={activeBuyOrder} onPaid={() => setActiveBuyOrder(prev => prev ? { ...prev, status: 'PAID' } : prev)} onExpire={() => { resetBuy(); loadOrders(); }} />
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
            <span style={{ fontSize: 16 }}>🛡️</span><span style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text2)' }}>P2P exchange: a verified merchant is auto-assigned per order. Buy = pay merchant, submit UTR + screenshot, tokens credit on confirm. Sell = merchant pays your bank/UPI. Raise a dispute from Payment Orders if something goes wrong.</span>
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
                  {canCancel && <button onClick={() => cancelOrder(order.orderId || order._id)} style={{ fontSize: 10, fontWeight: 800, color: 'var(--red)', background: 'none', border: '1px solid color-mix(in srgb,var(--red) 40%,transparent)', borderRadius: 999, padding: '4px 11px', cursor: 'pointer' }}>Cancel</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ScreenShell>
  );
};

export default WalletPage;
