// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import React, { useState, useEffect, useCallback, useRef } from 'react';
import apiClient from '../services/apiClient';
import { PAYMENT_STATE_LABELS, PAYMENT_STATE_COLOR, isActive, type PaymentOrderState } from '../services/paymentStateMachine';
// M-05: WalletTransactionDTO normalizer — GOVERNANCE §4: this module must have consumers.
import { normalizeTransaction } from '../services/walletTransactionDTO';

// ── Types ──────────────────────────────────────────────────────────────────────
interface Balances { depositBalance: number; winningsBalance: number; lockedBalance: number; }
// Token conversion is fixed 1:1 (1 BB token = ₹1) — Phase 006 flattening,
// 2026-07-08. The old TokenRates fetch/display was removed with it.
interface LedgerEntry { _id: string; type: string; field: string; amount: number; balanceBefore: number; balanceAfter: number; reason: string; createdAt: string; }
interface MerchantSnapshot {
  merchantId?: string;
  merchantName?: string;
  upiId?: string;
  qrCodeUrl?: string;
  bankName?: string;
  accountNo?: string;
  ifsc?: string;
  accountHolder?: string;
  snapshotAt?: string;
  expiresAt?: string;
}
interface PaymentOrder {
  _id: string;
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  status: string;
  tokenAmount: number;
  fiatAmount: number;
  rateUsed: number;
  createdAt: string;
  expiresAt?: string;
  paidAt?: string;
  merchantSnapshot?: MerchantSnapshot;
  utrNumber?: string;
  proofScreenshot?: string;
  // For WITHDRAWAL: user's own bank details
  userBankDetails?: { accountNumber?: string; ifscCode?: string; bankName?: string; accountHolderName?: string; };
  upiId?: string;
}
interface UserProfile {
  id: string;
  username: string;
  bankDetails?: { upiId?: string; accountNumber?: string; ifscCode?: string; bankName?: string; accountHolderName?: string; };
}
type TabKey = 'overview' | 'ledger' | 'payments';
type BuyStep = 'amount' | 'pay_now' | 'waiting';
type SellStep = 'amount' | 'waiting';

// ── Helpers ────────────────────────────────────────────────────────────────────
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const fmtINR = (n: number) => `₹${r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtT = (n: number) => `${r2(n).toLocaleString('en-IN')} T`;
const fmtDate = (s: string) => new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function statusBadge(status: string) {
  const col = PAYMENT_STATE_COLOR[status as PaymentOrderState] ?? 'yellow';
  const cls: Record<string, string> = {
    yellow: 'bg-yellow-500/20 text-yellow-300',
    blue: 'bg-blue-500/20 text-blue-300',
    green: 'bg-green-500/20 text-green-300',
    red: 'bg-red-500/20 text-red-300',
    orange: 'bg-orange-500/20 text-orange-300',
  };
  return `text-xs px-2 py-0.5 rounded-full font-medium ${cls[col] ?? cls.yellow}`;
}

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
    <span className={urgent ? 'text-red-400 font-bold animate-pulse' : 'text-yellow-400 font-mono font-bold'}>
      {timeLeft === 0 ? '⏰ Expired' : `⏱ ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`}
      {urgent && timeLeft > 0 && ' ⚠️ Expiring soon!'}
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
        // Dynamically import qrcode to avoid bundle issues
        const QRCode = (await import('qrcode' as any)).default || (await import('qrcode' as any));
        const url = await QRCode.toDataURL(intentString, { width: 220, margin: 2 });
        if (!cancelled) setQrDataUrl(url);
      } catch {
        // qrcode library not installed — fallback to Google Charts API (no copyright issue)
        if (!cancelled) setQrDataUrl(`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(intentString)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [intentString]);

  if (!qrDataUrl) return <div className="w-[220px] h-[220px] bg-white/10 rounded-xl flex items-center justify-center"><span className="text-gray-400 text-sm">Generating QR…</span></div>;
  return <img src={qrDataUrl} alt="UPI QR Code" className="w-[220px] h-[220px] rounded-xl border-4 border-white/20" />;
}

// ── Buy Payment UI ─────────────────────────────────────────────────────────────
function BuyPaymentUI({
  order, onPaid, onExpire,
}: {
  order: PaymentOrder;
  onPaid: () => void;
  onExpire: () => void;
}) {
  const snap = order.merchantSnapshot;
  const [utr, setUtr] = useState('');
  const [screenshot, setScreenshot] = useState<{ cdnUrl: string; fileKey: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [disputeVisible, setDisputeVisible] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  // Build UPI intent string from merchantSnapshot
  const intentString = snap?.upiId
    ? `upi://pay?pa=${snap.upiId}&pn=${encodeURIComponent(snap.merchantName || 'Merchant')}&am=${order.fiatAmount}&cu=INR&tn=${encodeURIComponent(`BettingBazaar-${order.orderId}`)}`
    : '';

  // Show dispute link only if status is PAID and 10+ minutes have passed
  useEffect(() => {
    if (order.status === 'PAID' && order.paidAt) {
      const elapsed = Date.now() - new Date(order.paidAt).getTime();
      if (elapsed >= 10 * 60 * 1000) setDisputeVisible(true);
    }
  }, [order.status, order.paidAt]);

  const handleScreenshotUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const urlRes: any = await apiClient.post(`/api/upload/user/payment-proof/${order.orderId}/upload-url`, {
        fileName: file.name, contentType: file.type, fileSize: file.size,
      });
      await fetch(urlRes.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      if (!urlRes.fileKey || !urlRes.cdnUrl) throw new Error('Upload response missing file key');
      setScreenshot({ cdnUrl: urlRes.cdnUrl, fileKey: urlRes.fileKey });
    } catch (err: any) {
      setError(err?.message || 'Upload failed. Try again.');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmitPayment = async () => {
    if (utr.trim().length < 12) { setError('UTR must be at least 12 characters'); return; }
    if (!screenshot) { setError('Please upload payment screenshot'); return; }
    setSubmitting(true);
    setError('');
    try {
      await apiClient.post(`/api/payment/order/${order.orderId}/mark-paid`, {
        utrNumber: utr.trim(), proofFileKey: screenshot.fileKey, proofCdnUrl: screenshot.cdnUrl,
      });
      onPaid();
    } catch (err: any) {
      setError(err?.message || 'Failed to submit. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDispute = async () => {
    if (!disputeReason.trim()) { setError('Please enter a dispute reason'); return; }
    try {
      await apiClient.post(`/api/payment/order/${order.orderId}/dispute`, { reason: disputeReason.trim() });
      alert('Dispute raised. Admin will review shortly.');
    } catch (err: any) {
      setError(err?.message || 'Failed to raise dispute');
    }
  };

  if (order.status === 'PAID') {
    return (
      <div className="space-y-4">
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 text-center">
          <p className="text-2xl mb-2">⏳</p>
          <p className="text-blue-300 font-semibold">Payment submitted!</p>
          <p className="text-xs text-gray-400 mt-1">UTR: <strong className="text-white">{order.utrNumber}</strong></p>
          <p className="text-xs text-gray-400 mt-1">Waiting for merchant to confirm…</p>
        </div>
        {disputeVisible && (
          <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-3">
            <p className="text-xs text-orange-300 mb-2">Merchant not responding?</p>
            <input value={disputeReason} onChange={e => setDisputeReason(e.target.value)} placeholder="Describe the issue" className="w-full bg-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 border border-white/10 mb-2" />
            <button onClick={handleDispute} className="w-full bg-orange-500 hover:bg-orange-400 text-white font-bold py-2 rounded-lg text-sm">Raise Dispute</button>
          </div>
        )}
        {error && <p className="text-red-400 text-xs text-center">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Amount banner */}
      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-center">
        <p className="text-xs text-gray-400 mb-1">Pay exactly</p>
        <p className="text-3xl font-bold text-yellow-400">{fmtINR(order.fiatAmount)}</p>
        <p className="text-xs text-gray-400 mt-1">to receive {fmtT(order.tokenAmount)}</p>
      </div>

      {/* Countdown */}
      <div className="text-center">
        <CountdownTimer expiresAt={order.expiresAt} onExpire={onExpire} />
      </div>

      {/* QR + UPI button */}
      {snap?.upiId && intentString ? (
        <div className="flex flex-col items-center gap-3">
          <UpiQrCode intentString={intentString} />
          <p className="text-xs text-gray-400 text-center">Scan with any UPI app</p>
          <a href={intentString} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl text-sm text-center block">
            📱 Open UPI App
          </a>
          <div className="bg-white/5 rounded-lg p-2 w-full text-center">
            <p className="text-xs text-gray-400">UPI ID</p>
            <p className="text-sm font-mono text-white font-semibold">{snap.upiId}</p>
            <p className="text-xs text-gray-500">{snap.merchantName}</p>
          </div>
        </div>
      ) : (
        <div className="bg-white/5 rounded-xl p-4 text-center">
          <p className="text-xs text-gray-400">⏳ Waiting for merchant details…</p>
        </div>
      )}

      {/* UTR input */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">UTR / Transaction ID (min 12 chars)</label>
        <input
          value={utr}
          onChange={e => setUtr(e.target.value)}
          placeholder="e.g. 425312687954"
          className="w-full bg-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 border border-white/10 focus:border-yellow-500/50 outline-none"
        />
        {utr.length > 0 && utr.length < 12 && <p className="text-red-400 text-xs mt-1">{12 - utr.length} more characters needed</p>}
      </div>

      {/* Screenshot upload */}
      <div>
        <label className="text-xs text-gray-400 block mb-1">Payment Screenshot</label>
        {screenshot ? (
          <div className="flex items-center gap-2 bg-green-500/10 rounded-xl p-3 border border-green-500/30">
            <img src={screenshot.cdnUrl} alt="proof" className="w-12 h-12 object-cover rounded" />
            <div className="flex-1">
              <p className="text-xs text-green-300">✅ Uploaded</p>
              <button onClick={() => setScreenshot(null)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
            </div>
          </div>
        ) : (
          <label className="block w-full border-2 border-dashed border-white/20 rounded-xl p-4 text-center cursor-pointer hover:border-yellow-500/40">
            <p className="text-gray-400 text-sm">{uploading ? '⏳ Uploading…' : '📸 Upload screenshot'}</p>
            <input type="file" accept="image/*" className="hidden" onChange={handleScreenshotUpload} disabled={uploading} />
          </label>
        )}
      </div>

      {error && <p className="text-red-400 text-xs text-center">{error}</p>}

      <button
        onClick={handleSubmitPayment}
        disabled={utr.trim().length < 12 || !screenshot || submitting}
        className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-40 disabled:cursor-not-allowed text-black font-bold py-4 rounded-xl text-base transition-all"
      >
        {submitting ? '⏳ Submitting…' : "✅ I've Paid"}
      </button>
    </div>
  );
}

// ── Main WalletPage ───────────────────────────────────────────────────────────
const WalletPage: React.FC = () => {
  const [balances, setBalances]         = useState<Balances>({ depositBalance: 0, winningsBalance: 0, lockedBalance: 0 });
  const [userProfile, setUserProfile]   = useState<UserProfile | null>(null);
  // M-05: ledger entries are raw shapes; use normalizeTransaction() when rendering.
  const [ledger, setLedger]             = useState<LedgerEntry[]>([]);
  const [paymentOrders, setPaymentOrders] = useState<PaymentOrder[]>([]);
  const [tab, setTab]                   = useState<TabKey>('overview');
  const [loading, setLoading]           = useState(true);
  const [ledgerPage, setLedgerPage]     = useState(1);
  const [hasMore, setHasMore]           = useState(true);

  // Buy flow
  const [buyStep, setBuyStep]           = useState<BuyStep>('amount');
  const [buyTokens, setBuyTokens]       = useState('');
  const [activeBuyOrder, setActiveBuyOrder] = useState<PaymentOrder | null>(null);
  const [buyLoading, setBuyLoading]     = useState(false);
  const [buyError, setBuyError]         = useState('');

  // Sell flow
  const [sellStep, setSellStep]         = useState<SellStep>('amount');
  const [sellTokens, setSellTokens]     = useState('');
  const [activeSellOrder, setActiveSellOrder] = useState<PaymentOrder | null>(null);
  const [sellLoading, setSellLoading]   = useState(false);
  const [sellError, setSellError]       = useState('');

  // Polling ref for active orders
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // ── Load profile ──────────────────────────────────────────────────────────
  const loadMeta = useCallback(async () => {
    try {
      const prof: any = await apiClient.get('/api/v1/user/profile');
      const u = prof?.user;
      if (u) {
        setUserProfile({ id: u._id || u.id, username: u.username || u.mobile || 'User', bankDetails: u.bankDetails });
        setBalances({ depositBalance: u.depositBalance ?? 0, winningsBalance: u.winningsBalance ?? 0, lockedBalance: u.lockedBalance ?? 0 });
      }
    } catch (err: unknown) {
      console.error('[WalletPage/loadMeta]', err instanceof Error ? err.message : err);
    }
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const res: any = await apiClient.get('/api/payment/orders?limit=20');
      const orders = Array.isArray(res?.orders) ? res.orders : [];
      setPaymentOrders(orders);

      // Restore active order state from persisted orders
      const activeDeposit = orders.find((o: PaymentOrder) => o.type === 'DEPOSIT' && ['ASSIGNED','PROCESSING','PAID'].includes(o.status));
      const activeWithdrawal = orders.find((o: PaymentOrder) => o.type === 'WITHDRAWAL' && ['ASSIGNED','PROCESSING','PAID'].includes(o.status));

      if (activeDeposit && buyStep === 'amount') {
        setActiveBuyOrder(activeDeposit);
        setBuyStep('pay_now');
      }
      if (activeWithdrawal && sellStep === 'amount') {
        setActiveSellOrder(activeWithdrawal);
        setSellStep('waiting');
      }
    } catch (err: unknown) {
      console.error('[WalletPage/loadOrders]', err instanceof Error ? err.message : err);
    }
  }, [buyStep, sellStep]);

  const loadLedger = useCallback(async (pg: number, reset = false) => {
    setLoading(true);
    try {
      const res: any = await apiClient.get(`/api/v1/wallet/ledger?page=${pg}&limit=25`);
      const items: LedgerEntry[] = Array.isArray(res?.entries) ? res.entries : [];
      setLedger(prev => reset ? items : [...prev, ...items]);
      setHasMore(items.length === 25);
    } catch (err: unknown) {
      console.error('[WalletPage/loadLedger]', err instanceof Error ? err.message : err);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadMeta(); loadOrders(); }, [loadMeta, loadOrders]);
  useEffect(() => { if (tab === 'ledger') { setLedgerPage(1); loadLedger(1, true); } }, [tab, loadLedger]);

  // Poll active order status every 3 seconds
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
      } catch (_) {}
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeBuyOrder?.orderId, activeSellOrder?.orderId]);

  const cancelOrder = async (orderId: string) => {
    try {
      await apiClient.post('/api/payment/order/cancel', { orderId });
      loadOrders();
    } catch (e: any) { alert(e?.message || 'Failed to cancel'); }
  };

  // ── Buy flow ──────────────────────────────────────────────────────────────
  const resetBuy = () => { setBuyStep('amount'); setBuyTokens(''); setActiveBuyOrder(null); setBuyError(''); };

  const handleBuySubmit = async () => {
    const amt = parseInt(buyTokens);
    if (!amt || amt < 1) { setBuyError('Enter a valid token amount'); return; }
    setBuyLoading(true);
    setBuyError('');
    try {
      const res: any = await apiClient.post('/api/payment/deposit/create', { tokenAmount: amt });
      const order = res?.order;
      if (!order) throw new Error('No order returned');
      setActiveBuyOrder(order);
      setBuyStep('pay_now');
      loadMeta();
    } catch (err: any) {
      setBuyError(err?.message || 'Failed to create order');
    } finally {
      setBuyLoading(false);
    }
  };

  // ── Sell flow ─────────────────────────────────────────────────────────────
  const resetSell = () => { setSellStep('amount'); setSellTokens(''); setActiveSellOrder(null); setSellError(''); };

  const handleSellSubmit = async () => {
    const amt = parseInt(sellTokens);
    if (!amt || amt < 1) { setSellError('Enter a valid token amount'); return; }
    if (amt > balances.winningsBalance) { setSellError(`Insufficient winnings balance (${fmtT(balances.winningsBalance)} available)`); return; }
    setSellLoading(true);
    setSellError('');
    try {
      const res: any = await apiClient.post('/api/payment/withdrawal/create', { tokenAmount: amt });
      const order = res?.order;
      if (!order) throw new Error('No order returned');
      setActiveSellOrder({ ...order, userBankDetails: res.order.userBankDetails });
      setSellStep('waiting');
      loadMeta();
    } catch (err: any) {
      setSellError(err?.message || 'Failed to create order');
    } finally {
      setSellLoading(false);
    }
  };

  const total = r2(balances.depositBalance + balances.winningsBalance);
  const activeOrders = paymentOrders.filter(o => isActive(o.status as PaymentOrderState));

  // ── BUY panel ─────────────────────────────────────────────────────────────
  const renderBuyPanel = () => {
    if (buyStep === 'amount') return (
      <div className="space-y-4">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Token amount to buy</label>
          <input value={buyTokens} onChange={e => setBuyTokens(e.target.value)} type="number" min="1"
            placeholder="e.g. 100" className="w-full bg-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 border border-white/10 focus:border-yellow-500/50 outline-none" />
          {buyTokens && !isNaN(parseInt(buyTokens)) && (
            <p className="text-xs text-yellow-400 mt-1">You pay: {fmtINR(parseInt(buyTokens))}</p>
          )}
        </div>
        {buyError && <p className="text-red-400 text-xs">{buyError}</p>}
        <button onClick={handleBuySubmit} disabled={!buyTokens || buyLoading}
          className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-40 text-black font-bold py-4 rounded-xl text-base">
          {buyLoading ? '⏳ Creating order…' : '⬇️ BUY TOKENS'}
        </button>
      </div>
    );

    if (buyStep === 'pay_now' && activeBuyOrder) return (
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-white">Complete Payment</h3>
          <button onClick={resetBuy} className="text-xs text-gray-500 hover:text-gray-400">✕ Cancel</button>
        </div>
        <BuyPaymentUI order={activeBuyOrder} onPaid={() => {
          setActiveBuyOrder(prev => prev ? { ...prev, status: 'PAID' } : prev);
        }} onExpire={() => { resetBuy(); loadOrders(); }} />
      </div>
    );

    return null;
  };

  // ── SELL panel ────────────────────────────────────────────────────────────
  const renderSellPanel = () => {
    if (sellStep === 'amount') return (
      <div className="space-y-4">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Token amount to sell</label>
          <input value={sellTokens} onChange={e => setSellTokens(e.target.value)} type="number" min="1"
            placeholder="e.g. 100" className="w-full bg-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 border border-white/10 focus:border-green-500/50 outline-none" />
          {sellTokens && !isNaN(parseInt(sellTokens)) && (
            <p className="text-xs text-green-400 mt-1">You receive: {fmtINR(parseInt(sellTokens))}</p>
          )}
          <p className="text-xs text-gray-500 mt-1">Available winnings: {fmtT(balances.winningsBalance)}</p>
        </div>
        {sellError && <p className="text-red-400 text-xs">{sellError}</p>}
        <button onClick={handleSellSubmit} disabled={!sellTokens || sellLoading}
          className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white font-bold py-4 rounded-xl text-base">
          {sellLoading ? '⏳ Creating order…' : '⬆️ SELL TOKENS'}
        </button>
      </div>
    );

    if (sellStep === 'waiting' && activeSellOrder) {
      const bank = activeSellOrder.userBankDetails;
      // Build UPI intent for user's own UPI ID so merchant can scan
      const userUpiId = userProfile?.bankDetails?.upiId || activeSellOrder.upiId || '';
      const userIntent = userUpiId
        ? `upi://pay?pa=${userUpiId}&pn=${encodeURIComponent(userProfile?.username || 'User')}&am=${activeSellOrder.fiatAmount}&cu=INR&tn=${encodeURIComponent(`BettingBazaar-${activeSellOrder.orderId}`)}`
        : '';
      const isAssigned = ['ASSIGNED','PROCESSING'].includes(activeSellOrder.status);

      return (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Sell Order In Progress</h3>
            <CountdownTimer expiresAt={activeSellOrder.expiresAt} onExpire={() => { resetSell(); loadOrders(); }} />
          </div>

          <div className="bg-white/5 rounded-xl p-3 border border-white/10">
            <p className="text-xs text-gray-400 mb-2">Merchant will send {fmtINR(activeSellOrder.fiatAmount)} to your account:</p>
            {bank?.accountNumber && (
              <div className="space-y-1 text-sm">
                <p className="text-white font-medium">{bank.accountHolderName || userProfile?.username}</p>
                <p className="text-gray-300">AC: <strong>{bank.accountNumber}</strong></p>
                <p className="text-gray-300">IFSC: {bank.ifscCode} · {bank.bankName}</p>
                {userUpiId && <p className="text-gray-300">UPI: <strong>{userUpiId}</strong></p>}
              </div>
            )}
          </div>

          {/* Show user's UPI QR so merchant can scan */}
          {userIntent && (
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs text-gray-400">Your UPI QR (merchant scans to pay you)</p>
              <UpiQrCode intentString={userIntent} />
            </div>
          )}

          <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-3 text-center">
            <p className="text-xs text-blue-300">
              {isAssigned ? '⏳ Merchant processing your payout…' : '✅ Merchant has sent payment. Waiting for final confirmation…'}
            </p>
            <p className="text-xs text-gray-500 mt-1">Tokens will be debited when merchant confirms.</p>
          </div>

          {/* Dispute option */}
          {activeSellOrder.status === 'PROCESSING' && activeSellOrder.expiresAt && (
            <p className="text-xs text-center text-gray-600">
              Didn't receive money?{' '}
              <button className="text-orange-400 hover:text-orange-300 underline" onClick={async () => {
                const reason = prompt("Describe the issue:");
                if (!reason) return;
                try {
                  await apiClient.post(`/api/payment/order/${activeSellOrder.orderId}/dispute`, { reason });
                  alert('Dispute raised. Admin will review.');
                } catch (e: any) { alert(e?.message || 'Failed to raise dispute'); }
              }}>Raise a dispute</button>
            </p>
          )}

          <button onClick={resetSell} className="w-full bg-white/5 hover:bg-white/10 text-gray-400 py-2 rounded-xl text-xs">
            ← Back to overview
          </button>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white pb-8">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-b from-gray-900 to-gray-950 px-4 pt-6 pb-4">
        <p className="text-xs text-yellow-400/60 uppercase tracking-widest mb-1">Total Balance</p>
        <p className="text-4xl font-bold text-yellow-400 mb-1">{fmtINR(total)}</p>
        <div className="flex gap-4 text-sm mt-2">
          <span className="text-gray-400">Deposit: <strong className="text-white">{fmtT(balances.depositBalance)}</strong></span>
          <span className="text-gray-400">Winnings: <strong className="text-green-400">{fmtT(balances.winningsBalance)}</strong></span>
          {balances.lockedBalance > 0 && <span className="text-gray-400">Locked: <strong className="text-orange-400">{fmtT(balances.lockedBalance)}</strong></span>}
        </div>
      </div>

      {/* ── Rate cards — fixed 1:1 conversion ─────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 px-4 mb-4">
        <div className="bg-white/5 rounded-xl p-3 border border-white/10">
          <p className="text-xs text-gray-400 mb-0.5">Buy Rate</p>
          <p className="text-xl font-bold text-yellow-400">₹1<span className="text-xs text-gray-500 font-normal">/token</span></p>
          <p className="text-xs text-gray-500">You pay ₹1 → get 1 token</p>
        </div>
        <div className="bg-white/5 rounded-xl p-3 border border-white/10">
          <p className="text-xs text-gray-400 mb-0.5">Sell Rate</p>
          <p className="text-xl font-bold text-green-400">₹1<span className="text-xs text-gray-500 font-normal">/token</span></p>
          <p className="text-xs text-gray-500">1 token → you get ₹1</p>
        </div>
      </div>

      {/* ── Buy / Sell panels ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 px-4 mb-4">
        <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-yellow-400 mb-3 uppercase tracking-wider">⬇️ Buy Tokens</h3>
          {renderBuyPanel()}
        </div>
        <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-green-400 mb-3 uppercase tracking-wider">⬆️ Sell Tokens</h3>
          {renderSellPanel()}
        </div>
      </div>

      {/* ── Active orders banner ──────────────────────────────────────────── */}
      {activeOrders.length > 0 && (
        <div className="mx-4 mb-4 bg-blue-500/10 border border-blue-500/30 rounded-xl p-3">
          <p className="text-xs text-blue-300 font-medium mb-2">⏳ Active Payment Orders ({activeOrders.length})</p>
          {activeOrders.map(o => (
            <div key={o._id} className="flex items-center justify-between py-1.5">
              <div>
                <span className={statusBadge(o.status)}>{PAYMENT_STATE_LABELS[o.status as PaymentOrderState] ?? o.status}</span>
                <span className="text-xs text-gray-400 ml-2">{o.type === 'DEPOSIT' ? '⬇️' : '⬆️'} {fmtT(o.tokenAmount)} · {fmtINR(o.fiatAmount)}</span>
              </div>
              {o.expiresAt && <CountdownTimer expiresAt={o.expiresAt} />}
            </div>
          ))}
        </div>
      )}

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="flex gap-2 px-4 mb-4 overflow-x-auto">
        {([['overview','Overview'],['ledger','History'],['payments','Payment Orders']] as const).map(([k,l]) => (
          <button key={k} onClick={() => setTab(k as TabKey)} className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${tab===k?'bg-yellow-500 text-black':'bg-white/5 text-gray-400 hover:bg-white/10'}`}>{l}</button>
        ))}
      </div>

      <div className="px-4">
        {/* ── Overview tab ──────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div className="space-y-3">
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <h3 className="text-sm font-semibold mb-3 text-gray-300">How token exchange works</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p>📥 <strong className="text-white">Buy tokens:</strong> Enter amount → merchant auto-assigned → scan dynamic UPI QR → submit UTR → merchant confirms → tokens credited</p>
                <p>📤 <strong className="text-white">Sell tokens:</strong> Enter amount → merchant auto-assigned → merchant sends INR to your bank → auto-completes → tokens debited</p>
                <p>⏱ <strong className="text-white">15-minute window:</strong> Each order has a 15-min payment window. Orders expire automatically if not completed.</p>
                <div className="bg-yellow-500/10 rounded-lg p-3 mt-3 border border-yellow-500/20">
                  <p className="text-yellow-300 text-xs font-medium">Fixed 1:1 conversion:</p>
                  <p className="text-xs text-gray-300 mt-1">100 tokens → pay {fmtINR(100)}</p>
                  <p className="text-xs text-gray-300">100 tokens → receive {fmtINR(100)}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Ledger tab ────────────────────────────────────────────────── */}
        {tab === 'ledger' && (
          <div className="space-y-2">
            {loading && ledger.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-14 bg-white/5 rounded-xl animate-pulse" />)
            ) : ledger.length === 0 ? (
              <div className="text-center py-12 text-gray-500"><p className="text-3xl mb-2">📭</p><p>No transactions yet</p></div>
            ) : (
              <>
                {ledger.map(entry => {
                  const isCredit = entry.type === 'CREDIT';
                  return (
                    <div key={entry._id} className="bg-white/5 rounded-xl p-3 flex items-center justify-between border border-white/5">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{entry.reason || entry.type}</p>
                        <p className="text-xs text-gray-500">{fmtDate(entry.createdAt)} · {entry.field === 'depositBalance' ? 'Deposit' : 'Winnings'} wallet</p>
                      </div>
                      <div className={`text-sm font-bold ml-3 shrink-0 ${isCredit ? 'text-green-400' : 'text-red-400'}`}>
                        {isCredit ? '+' : '-'}{fmtT(entry.amount)}
                      </div>
                    </div>
                  );
                })}
                {hasMore && !loading && (
                  <button onClick={() => { const n = ledgerPage + 1; setLedgerPage(n); loadLedger(n); }} className="w-full py-3 bg-white/5 hover:bg-white/10 rounded-xl text-sm text-gray-400">Load more</button>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Payment Orders tab ────────────────────────────────────────────── */}
        {tab === 'payments' && (
          <div className="space-y-3">
            <button onClick={loadOrders} className="text-xs text-yellow-400 hover:text-yellow-300">↻ Refresh</button>
            {paymentOrders.length === 0 ? (
              <div className="text-center py-12 text-gray-500"><p className="text-3xl mb-2">📋</p><p>No payment orders yet</p><p className="text-xs mt-1">Use BUY or SELL buttons above</p></div>
            ) : (
              paymentOrders.map(order => {
                const canCancel = order.status === 'PENDING_QUEUE';
                return (
                  <div key={order._id} className="bg-white/5 rounded-xl p-4 border border-white/10">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <span className={statusBadge(order.status)}>{PAYMENT_STATE_LABELS[order.status as PaymentOrderState] ?? order.status}</span>
                        <span className="ml-2 text-xs text-gray-500">{order.type === 'DEPOSIT' ? '⬇️ Buy' : '⬆️ Sell'}</span>
                      </div>
                      <span className="text-xs text-gray-600">{fmtDate(order.createdAt)}</span>
                    </div>

                    <div className="bg-white/5 rounded-lg p-2.5 mb-3 text-xs space-y-1">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Tokens</span>
                        <span className="text-white font-medium">{fmtT(order.tokenAmount)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Rate used</span>
                        <span className="text-gray-300">₹{order.rateUsed}/token</span>
                      </div>
                      <div className="flex justify-between border-t border-white/10 pt-1 mt-1">
                        <span className="text-gray-400">{order.type === 'DEPOSIT' ? 'You pay' : 'You receive'}</span>
                        <span className={`font-bold ${order.type === 'DEPOSIT' ? 'text-yellow-400' : 'text-green-400'}`}>{fmtINR(order.fiatAmount)}</span>
                      </div>
                    </div>

                    {/* UTR + proof for PAID/COMPLETED */}
                    {order.utrNumber && (
                      <p className="text-xs text-gray-400 mb-1">UTR: <span className="text-white font-mono">{order.utrNumber}</span></p>
                    )}
                    {order.proofScreenshot && (
                      <div className="mb-2">
                        <a href={order.proofScreenshot} target="_blank" rel="noreferrer">
                          <img src={order.proofScreenshot} alt="proof" className="w-16 h-16 object-cover rounded border border-white/20 hover:opacity-80" />
                        </a>
                      </div>
                    )}

                    {/* Countdown for active orders */}
                    {order.expiresAt && ['ASSIGNED','PROCESSING'].includes(order.status) && (
                      <div className="mb-2">
                        <CountdownTimer expiresAt={order.expiresAt} />
                      </div>
                    )}

                    <p className="text-xs text-gray-600 mb-3">Order ID: {order.orderId || order._id}</p>

                    <div className="flex gap-2">
                      {canCancel && (
                        <button onClick={() => cancelOrder(order.orderId || order._id)} className="flex-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 font-medium py-2 rounded-lg text-sm transition-all border border-red-500/30">
                          Cancel Order
                        </button>
                      )}
                      {!canCancel && (
                        <div className="flex-1 text-center py-2 text-xs text-gray-500">
                          {['COMPLETED'].includes(order.status) ? '✅ Completed' : ['CANCELLED','FAILED'].includes(order.status) ? '❌ ' + order.status : '⏳ Waiting…'}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default WalletPage;
