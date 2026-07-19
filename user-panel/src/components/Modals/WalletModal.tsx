// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import React, { useState, useEffect, useCallback, useRef } from 'react';
import apiClient from '../../services/apiClient';
import { PAYMENT_STATE_LABELS, type PaymentOrderState } from '../../services/paymentStateMachine';

// ── Props ──────────────────────────────────────────────────────────────────────
interface WalletModalProps {
  isOpen:          boolean;
  onClose:         () => void;
  onOpenChat?:     (orderId: string) => void;  
  onNavigateToHistory?: () => void;
  initialTab?:     'buy' | 'sell';
}

// ── Sub-types ──────────────────────────────────────────────────────────────────
type ModalTab = 'buy' | 'sell';

interface Balances {
  depositBalance:  number;
  winningsBalance: number;
}
// Token conversion is fixed 1:1 (1 BB token = ₹1) — Phase 006 flattening,
// 2026-07-08. The old TokenRates fetch/display was removed with it.
interface BankDetails { upiId?: string; accountNumber?: string; ifsc?: string; accountName?: string; }

// ── Component ──────────────────────────────────────────────────────────────────
const WalletModal: React.FC<WalletModalProps> = ({ isOpen, onClose, onOpenChat, onNavigateToHistory, initialTab = 'buy' }) => {
  const [tab,          setTab]          = useState<ModalTab>('buy');
  const [balances,     setBalances]     = useState<Balances>({ depositBalance: 0, winningsBalance: 0 });
  const [bankDetails,  setBankDetails]  = useState<BankDetails | null>(null);
  const [hasBankDetails, setHasBankDetails] = useState(false);
  const [amount,       setAmount]       = useState('');
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [step,         setStep]         = useState<'form' | 'waiting' | 'done'>('form');
  const [activeOrder,  setActiveOrder]  = useState<{ id: string; status: PaymentOrderState } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load balances + bank details on open ────────────────────────────────────
  const loadMeta = useCallback(async () => {
    if (!isOpen) return;
    try {
      const profileResp: any = await apiClient.get('/api/v1/user/profile');
      setBalances({
        depositBalance:  profileResp?.user?.depositBalance  ?? 0,
        winningsBalance: profileResp?.user?.winningsBalance ?? 0,
      });
      const bd = profileResp?.user?.bankDetails;
      if (bd && (bd.upiId || bd.accountNumber)) {
        setBankDetails(bd);
        setHasBankDetails(true);
      } else {
        setHasBankDetails(false);
      }
    } catch (err: unknown) {
      console.error('[WalletModal/loadMeta]', err instanceof Error ? err.message : err); // MED-03
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) { loadMeta(); setTab(initialTab); setStep('form'); setAmount(''); setError(''); }
    else { pollRef.current && clearInterval(pollRef.current); }
  }, [isOpen, loadMeta, initialTab]);

  
  const pollOrder = useCallback((orderId: string) => {
    pollRef.current && clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const resp: any = await apiClient.get(`/api/payment/order/${orderId}`);
        const status: PaymentOrderState = resp?.order?.status ?? 'PENDING_QUEUE';
        setActiveOrder({ id: orderId, status });

        if (false) { 
          clearInterval(pollRef.current!);
          onOpenChat?.(orderId);  
          onClose();
        }
        if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(status)) {
          clearInterval(pollRef.current!);
          setStep('done');
        }
      } catch (err: unknown) { console.error('[WalletModal] error:', err instanceof Error ? err.message : err); }
    }, 3000);
  }, [onClose, onOpenChat]);

  useEffect(() => () => { pollRef.current && clearInterval(pollRef.current); }, []);

  // ── Deposit (buy) ────────────────────────────────────────────────────────────
  const handleDeposit = async () => {
    setError('');
    const tokens = parseFloat(amount);
    if (!tokens || tokens < 1) { setError('Enter a valid token amount.'); return; }
    setLoading(true);
    try {
      const resp: any = await apiClient.post('/api/payment/deposit/create', { tokenAmount: tokens });
      const orderId: string = resp?.order?._id ?? resp?.orderId ?? '';
      if (!orderId) throw new Error('Order creation failed.');
      setStep('waiting');
      setActiveOrder({ id: orderId, status: 'PENDING_QUEUE' });
      pollOrder(orderId);
    } catch (err: any) {
      setError(err?.data?.message ?? err?.message ?? 'Failed to create deposit order.');
    } finally {
      setLoading(false);
    }
  };

  // ── Withdrawal (sell) ────────────────────────────────────────────────────────
  // Uses stored bank details — NO re-entry of UPI/account here.
  const handleWithdraw = async () => {
    setError('');
    if (!hasBankDetails) {
      setError('No bank details saved. Please add them in your Profile page first.');
      return;
    }
    const tokens = parseFloat(amount);
    if (!tokens || tokens < 1) { setError('Enter a valid token amount.'); return; }
    if (tokens > balances.winningsBalance) { setError('Insufficient winnings balance.'); return; }
    setLoading(true);
    try {
      // Bank details come from profile — server reads them. User never re-enters here.
      const resp: any = await apiClient.post('/api/payment/withdrawal/create', { tokenAmount: tokens });
      const orderId: string = resp?.order?._id ?? resp?.orderId ?? '';
      if (!orderId) throw new Error('Withdrawal order creation failed.');
      setStep('waiting');
      setActiveOrder({ id: orderId, status: 'PENDING_QUEUE' });
      pollOrder(orderId);
    } catch (err: any) {
      setError(err?.data?.message ?? err?.message ?? 'Failed to create withdrawal order.');
    } finally {
      setLoading(false);
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const fmtAmount = (n: number) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

  // Fixed 1:1 conversion — fiat amount always equals token amount.
  const fiatPreview = amount ? parseFloat(amount).toFixed(0) : '0';

  // ── Render ───────────────────────────────────────────────────────────────────
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-gray-900 border border-white/10 rounded-t-3xl sm:rounded-2xl w-full max-w-md max-h-[92vh] overflow-y-auto p-5">

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">Wallet</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
        </div>

        {/* Balance strip */}
        <div className="flex gap-3 mb-5">
          <div className="flex-1 bg-white/5 rounded-xl p-3">
            <p className="text-xs text-gray-400 mb-0.5">Deposit</p>
            <p className="font-semibold">{fmtAmount(balances.depositBalance)}</p>
          </div>
          <div className="flex-1 bg-white/5 rounded-xl p-3">
            <p className="text-xs text-gray-400 mb-0.5">Winnings</p>
            <p className="font-semibold text-green-400">{fmtAmount(balances.winningsBalance)}</p>
          </div>
        </div>

        {/* ── STEP: form ─────────────────────────────────────────────────────── */}
        {step === 'form' && (
          <>
            {/* Tab switcher */}
            <div className="flex bg-white/5 rounded-xl p-1 mb-5">
              {(['buy', 'sell'] as const).map(t => (
                <button key={t} onClick={() => { setTab(t); setError(''); setAmount(''); }}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all
                    ${tab === t ? 'bg-yellow-500 text-black' : 'text-gray-400 hover:text-white'}`}>
                  {t === 'buy' ? '⬇️ Add Funds' : '⬆️ Withdraw'}
                </button>
              ))}
            </div>

            {/* Amount input */}
            <div className="mb-4">
              <label className="text-xs text-gray-400 mb-1.5 block">
                Token amount {tab === 'sell' ? `(max: ${balances.winningsBalance.toFixed(0)})` : ''}
              </label>
              <div className="relative">
                <input
                  type="number" min="1" placeholder="0"
                  value={amount} onChange={e => { setAmount(e.target.value); setError(''); }}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-lg font-semibold
                             focus:outline-none focus:border-yellow-500/50 transition-all"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm">tokens</span>
              </div>
              {amount && (
                <p className="text-xs text-gray-400 mt-1.5">
                  = ₹{fiatPreview} (fixed 1:1 — 1 token = ₹1)
                </p>
              )}
            </div>

            {/* Sell: show saved bank details info */}
            {tab === 'sell' && (
              <div className={`rounded-xl p-3 mb-4 text-sm ${hasBankDetails
                ? 'bg-green-500/10 border border-green-500/30 text-green-300'
                : 'bg-red-500/10 border border-red-500/30 text-red-300'}`}>
                {hasBankDetails ? (
                  <>✅ Payout to saved bank details — {bankDetails?.upiId ?? bankDetails?.accountNumber}</>
                ) : (
                  <>⚠️ No bank details saved.{' '}
                    <span className="underline cursor-pointer" onClick={() => { onClose(); window.location.href = '/profile'; }}>
                      Add in Profile
                    </span>
                  </>
                )}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-xl p-3 mb-4">
                {error}
              </div>
            )}

            {/* CTA */}
            <button
              onClick={tab === 'buy' ? handleDeposit : handleWithdraw}
              disabled={loading || !amount || (tab === 'sell' && !hasBankDetails)}
              className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:bg-gray-600 disabled:cursor-not-allowed
                         text-black font-bold py-3.5 rounded-xl transition-all">
              {loading ? 'Creating order…' : tab === 'buy' ? 'Add Funds' : 'Withdraw'}
            </button>

            <button onClick={onNavigateToHistory}
              className="w-full mt-3 text-sm text-gray-400 hover:text-white transition-colors">
              View transaction history →
            </button>
          </>
        )}

        {/* ── STEP: waiting for merchant ──────────────────────────────────────── */}
        {step === 'waiting' && activeOrder && (
          <div className="text-center py-8">
            <div className="text-4xl mb-4 animate-spin inline-block">⏳</div>
            <p className="font-semibold text-lg mb-2">Order in queue</p>
            <p className="text-gray-400 text-sm mb-4">
              {PAYMENT_STATE_LABELS[activeOrder.status] ?? activeOrder.status}
            </p>
            <p className="text-xs text-gray-500 mb-6">
              A merchant will be assigned automatically.<br />
              Chat will open as soon as they accept.
            </p>
            <p className="text-xs text-gray-600">Order ID: {activeOrder.id.slice(-10)}</p>
            <button onClick={onClose}
              className="mt-6 text-sm text-gray-400 hover:text-white transition-colors">
              Close (order continues in background)
            </button>
          </div>
        )}

        {/* ── STEP: done ─────────────────────────────────────────────────────── */}
        {step === 'done' && activeOrder && (
          <div className="text-center py-8">
            <div className="text-5xl mb-4">
              {activeOrder.status === 'COMPLETED' ? '✅' : '❌'}
            </div>
            <p className="font-semibold text-lg mb-2">
              {activeOrder.status === 'COMPLETED' ? 'Completed!' : PAYMENT_STATE_LABELS[activeOrder.status]}
            </p>
            <button onClick={onClose}
              className="mt-6 bg-yellow-500 text-black font-bold px-8 py-2.5 rounded-xl">
              Close
            </button>
          </div>
        )}

      </div>
    </div>
  );
};

export default WalletModal;
