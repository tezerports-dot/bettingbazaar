// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Merchant token purchases — the treasury queue.
 *
 * A merchant funds player deposits out of their own token balance and buys that
 * balance from the platform with USDT. This is the screen where an admin
 * decides one. Three endpoints served it and nothing called any of them: by
 * CLAUDE.md §28 the feature was built, merged and unreachable.
 *
 * ── What approving actually does ───────────────────────────────────────────
 * It MINTS platform supply and credits the merchant's wallet. That is the whole
 * reason this sits behind AdminOnly rather than a sub-admin permission: the
 * routes are `isAdmin`, and admin 2FA is mandatory, so reaching here means a
 * second factor was proved.
 *
 * The server does the money first and the status second, both keyed on the
 * order, so a retry cannot credit twice and a second admin approving the same
 * request is TOLD (404) rather than believing they made the decision. This
 * screen does not try to prevent that race in the browser — it reloads after
 * every decision and shows what the server says.
 *
 * ── What an admin is actually checking ─────────────────────────────────────
 * That the USDT arrived. The row names the transaction — required at creation,
 * claimed in `utr_registry`, so one payment funds exactly one purchase (§27) —
 * and the whole hash is shown, unabbreviated, because an admin pastes it into a
 * block explorer. The merchant's current balance is shown beside it for the
 * ordinary sanity question: is this float they can plausibly be asking for.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Coins, Check, X, RefreshCw, Inbox } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { Modal } from '../../components/Modal';
import { EmptyState } from '../../components/EmptyState';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { formatters } from '../../utils/formatters';

/**
 * Mirrors `toOrder` in database/repositories/paymentConfig.js plus the
 * `merchant` block the admin route joins on (CLAUDE.md §5). `tokenAmount` is
 * whole tokens; the row stores paise.
 */
interface TokenOrder {
  orderId: string;
  merchantId: string;
  tokenAmount: number;
  usdtRate: number | null;
  usdtAmount: number | null;
  usdtTxHash: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requestedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  merchant: {
    merchantId: string;
    name?: string;
    username?: string;
    mobile?: string;
    tokenBalance: number;
  } | null;
}

const FILTERS = ['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const;

const STATUS_CLASS: Record<TokenOrder['status'], string> = {
  PENDING:   'bg-yellow-500/20 text-yellow-500',
  APPROVED:  'bg-green-500/20 text-green-500',
  REJECTED:  'bg-red-500/20 text-red-500',
  CANCELLED: 'bg-gray-500/20 text-gray-400',
};

const when = (ts: string | null) => {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch { return String(ts); }
};

export const MerchantTokenOrders: React.FC = () => {
  const [orders, setOrders] = useState<TokenOrder[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('PENDING');
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [rejecting, setRejecting] = useState<TokenOrder | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.merchantTokenOrders.list(filter);
      setOrders(res?.orders || []);
    } catch {
      toast.error('Failed to load merchant token purchases');
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  // What is waiting, and what it would cost the platform to issue. Derived from
  // the rows on screen — never accumulated across loads (trap 6).
  const pending = useMemo(() => orders.filter((o) => o.status === 'PENDING'), [orders]);
  const pendingTokens = pending.reduce((sum, o) => sum + Number(o.tokenAmount || 0), 0);

  const approve = async (order: TokenOrder) => {
    setBusyId(order.orderId);
    try {
      const res = await api.merchantTokenOrders.approve(order.orderId);
      toast.success(
        `Issued ${formatters.number(order.tokenAmount)} tokens — balance now ${formatters.number(res?.merchant?.tokenBalance ?? 0)}`,
      );
      await load();
    } catch (err: any) {
      // A 404 here is the second admin being told, not a failure to find the
      // order: the guard is `WHERE status = 'PENDING'`. Say which it was rather
      // than a generic error, because "already decided" needs no retry.
      const status = err?.response?.status;
      toast.error(
        status === 404
          ? 'Already decided — someone reviewed this request first.'
          : err?.response?.data?.message || 'Could not approve that purchase.',
      );
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const reject = async () => {
    if (!rejecting || !rejectReason.trim()) return;
    setBusyId(rejecting.orderId);
    try {
      await api.merchantTokenOrders.reject(rejecting.orderId, rejectReason.trim());
      toast.success('Request rejected — the merchant can see the reason.');
      setRejecting(null);
      setRejectReason('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Could not reject that purchase.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
          <div className="flex items-center gap-2">
            <Coins size={17} className="text-yellow-500" />
            <h2 className="text-base font-semibold">Merchant token purchases</h2>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as (typeof FILTERS)[number])}
              aria-label="Filter by decision"
              className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-xs"
            >
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {f === 'ALL' ? 'Every request' : f.charAt(0) + f.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
            <button onClick={() => void load()} className="p-1.5 rounded-lg hover:bg-dark-700" aria-label="Refresh">
              <RefreshCw size={15} className="text-gray-400" />
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          A merchant pays the platform in USDT for the float they trade with.
          Approving one <strong>mints supply and credits their wallet</strong> —
          check the transaction landed before you do. One request per merchant
          per day; a rejection needs a reason the merchant can act on.
        </p>

        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            <span className="text-xs px-2.5 py-1 rounded-lg bg-dark-700 text-yellow-400">
              {pending.length} awaiting a decision
            </span>
            <span className="text-xs px-2.5 py-1 rounded-lg bg-dark-700 text-gray-300">
              {formatters.number(pendingTokens)} tokens would be issued
            </span>
          </div>
        )}

        {isLoading ? (
          <LoadingSpinner />
        ) : orders.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="Nothing here"
            description={
              filter === 'PENDING'
                ? 'No merchant is waiting on a token purchase.'
                : 'No requests match this filter.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-dark-600">
                  <th className="py-2 pr-3 font-medium">Filed</th>
                  <th className="py-2 pr-3 font-medium">Merchant</th>
                  <th className="py-2 pr-3 font-medium">Tokens</th>
                  <th className="py-2 pr-3 font-medium">USDT sent</th>
                  <th className="py-2 pr-3 font-medium">Transaction</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium text-right">Decision</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.orderId} className="border-b border-dark-700 last:border-0 align-top">
                    <td className="py-2.5 pr-3 text-xs text-gray-400">{when(o.requestedAt)}</td>
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">
                        {o.merchant?.name || o.merchant?.username || o.merchantId}
                      </div>
                      {/* The balance they hold NOW, from the wallet — the
                          merchant record carries none. Context for whether the
                          float being asked for is plausible. */}
                      <div className="text-xs text-gray-500">
                        holds {formatters.number(o.merchant?.tokenBalance ?? 0)} tokens
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 font-medium">{formatters.number(o.tokenAmount)}</td>
                    <td className="py-2.5 pr-3">
                      {o.usdtAmount ?? '—'}
                      {o.usdtRate != null && (
                        <div className="text-xs text-gray-500">at ₹{o.usdtRate}/USDT</div>
                      )}
                    </td>
                    {/* Whole, never abbreviated: an admin pastes this into an
                        explorer, and a truncated hash cannot be checked. */}
                    <td className="py-2.5 pr-3 font-mono text-[11px] text-gray-400 break-all max-w-[220px]">
                      {o.usdtTxHash || '—'}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_CLASS[o.status]}`}>
                        {o.status.charAt(0) + o.status.slice(1).toLowerCase()}
                      </span>
                      {o.reviewNote && (
                        <div className="text-xs text-gray-500 mt-1 max-w-[220px]">{o.reviewNote}</div>
                      )}
                      {o.reviewedAt && (
                        <div className="text-xs text-gray-600 mt-0.5">{when(o.reviewedAt)}</div>
                      )}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      {o.status === 'PENDING' ? (
                        <div className="inline-flex gap-1.5">
                          <button
                            onClick={() => void approve(o)}
                            disabled={busyId === o.orderId}
                            className="p-1.5 rounded-lg bg-green-600/20 text-green-400 hover:bg-green-600/30 disabled:opacity-40"
                            title="Approve — mints tokens and credits the merchant"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={() => { setRejecting(o); setRejectReason(''); }}
                            disabled={busyId === o.orderId}
                            className="p-1.5 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-40"
                            title="Reject — needs a reason"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-600">decided</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rejecting && (
        <Modal isOpen onClose={() => setRejecting(null)} title="Reject this token purchase">
          <div className="space-y-4">
            <div className="bg-dark-700 rounded-lg p-3 text-sm">
              <p className="font-semibold">
                {rejecting.merchant?.name || rejecting.merchant?.username || rejecting.merchantId}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {formatters.number(rejecting.tokenAmount)} tokens for {rejecting.usdtAmount ?? '—'} USDT
              </p>
              <p className="text-xs text-gray-500 font-mono mt-1 break-all">{rejecting.usdtTxHash || '—'}</p>
            </div>
            <div>
              <label className="label">Reason</label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={3}
                className="input"
                placeholder="e.g. no transaction found at that hash"
              />
              {/* The row requires it. A merchant told only "rejected" cannot
                  correct anything, and they have spent their one request. */}
              <p className="text-xs text-gray-500 mt-1">
                The merchant sees this. It is the only thing telling them what to fix.
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setRejecting(null)} className="flex-1 btn-secondary">Cancel</button>
              <button
                onClick={() => void reject()}
                disabled={!rejectReason.trim() || busyId === rejecting.orderId}
                className="flex-1 btn-primary disabled:opacity-50"
              >
                Reject request
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default MerchantTokenOrders;
