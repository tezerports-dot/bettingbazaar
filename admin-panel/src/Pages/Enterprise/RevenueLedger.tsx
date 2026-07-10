// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * RevenueLedger.tsx — admin console for the Revenue & Settlement Platform
 * (Phase 007 APIs, UI shipped Phase C 2026-07-10).
 * Trial balance + distributable revenue + append-only journal + bonus-pool
 * funding (admin-only; capped at distributable revenue by the backend).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, ShieldAlert, PiggyBank } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { usePermissions } from '../../hooks/usePermission';

interface LedgerAccount {
  account: string;
  description: string;
  normalBalance: 'DEBIT' | 'CREDIT';
  reportedRupees: number;
  postings: number;
}

interface LedgerEntry {
  _id: string;
  eventType: string;
  description?: string;
  refModel?: string;
  refId?: string;
  occurredAt?: string;
  createdAt: string;
  postings: Array<{ account: string; amountMinor: number }>;
}

const EVENT_TYPES = [
  'DEPOSIT_COMPLETED', 'WITHDRAWAL_COMPLETED', 'BET_CYCLE_SETTLED',
  'PAYOUT_FEE_CHARGED', 'MERCHANT_BONUS_FUNDED', 'MERCHANT_BONUS_ISSUED', 'ADJUSTMENT',
];

const inr = (n: number) =>
  '₹' + (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export const RevenueLedger: React.FC = () => {
  const { isAdmin } = usePermissions();
  const [summary, setSummary] = useState<{
    accounts: LedgerAccount[]; integrityOk: boolean;
    distributableRevenue: number; merchantBonusPool: number;
  } | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [eventType, setEventType] = useState('');
  const [loading, setLoading] = useState(true);
  const [fundAmount, setFundAmount] = useState('');
  const [fundJustification, setFundJustification] = useState('');
  const [funding, setFunding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sumRes, ledRes] = await Promise.all([
        api.get<any>('/api/admin/revenue/summary'),
        api.get<any>('/api/admin/revenue/ledger', { params: { page, limit: 25, eventType: eventType || undefined } }),
      ]);
      if (sumRes.data?.success) setSummary(sumRes.data.summary);
      if (ledRes.data?.success) {
        setEntries(ledRes.data.entries || []);
        setPages(ledRes.data.pages || 1);
      }
    } catch {
      toast.error('Failed to load revenue data');
    } finally {
      setLoading(false);
    }
  }, [page, eventType]);

  useEffect(() => { load(); }, [load]);

  const fundPool = async () => {
    const amount = Number(fundAmount);
    if (!(amount > 0)) return toast.error('Enter a positive amount (₹)');
    if (!fundJustification.trim()) return toast.error('A business justification is required');
    setFunding(true);
    try {
      const res = await api.post<any>('/api/admin/revenue/bonus-pool/fund', {
        amount, justification: fundJustification.trim(),
      });
      if (res.data?.success) {
        toast.success(res.data.message);
        setFundAmount(''); setFundJustification('');
        load();
      } else {
        toast.error(res.data?.message || 'Funding failed');
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Funding failed');
    } finally {
      setFunding(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-1">Revenue &amp; Settlement Ledger</h1>
          <p className="text-gray-400 text-sm">
            Append-only double-entry ledger — every balance below is derived from postings, never stored.
          </p>
        </div>
        <button onClick={load} className="btn-primary flex items-center" disabled={loading}>
          <RefreshCw size={16} className={`mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {summary && (
        <>
          <div className={`card border-2 ${summary.integrityOk ? 'border-green-500/40' : 'border-red-500/60'}`}>
            <div className="flex items-center gap-3">
              {summary.integrityOk
                ? <ShieldCheck className="text-green-500" size={22} />
                : <ShieldAlert className="text-red-500" size={22} />}
              <div>
                <p className="font-semibold">
                  Ledger integrity: {summary.integrityOk ? 'OK — all postings sum to zero' : 'BROKEN — postings do not conserve!'}
                </p>
                <p className="text-xs text-gray-400">
                  Distributable platform revenue: <span className="text-gold-400 font-semibold">{inr(summary.distributableRevenue)}</span>
                  {' · '}Merchant bonus pool: <span className="text-gold-400 font-semibold">{inr(summary.merchantBonusPool)}</span>
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {summary.accounts.map(a => (
              <div key={a.account} className="card">
                <p className="text-[11px] uppercase tracking-wider text-gray-500">{a.account.replace(/_/g, ' ')}</p>
                <p className="text-lg font-bold text-gray-100">{inr(a.reportedRupees)}</p>
                <p className="text-[11px] text-gray-500 mt-1">{a.postings} postings · {a.normalBalance}-normal</p>
              </div>
            ))}
          </div>
        </>
      )}

      {isAdmin && (
        <div className="card border border-gold-500/30">
          <h3 className="text-lg font-semibold mb-1 flex items-center gap-2">
            <PiggyBank size={18} className="text-gold-500" /> Fund Merchant Bonus Pool
          </h3>
          <p className="text-xs text-gray-400 mb-3">
            Moves distributable platform revenue into the pool that pays Merchant Performance
            Bonuses. Hard rule: never funded from user money — the backend refuses anything
            beyond distributable revenue.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input type="number" min={1} className="input" placeholder="Amount (₹)"
              value={fundAmount} onChange={e => setFundAmount(e.target.value)} />
            <input type="text" className="input md:col-span-2" placeholder="Business justification (required, audit-logged)"
              value={fundJustification} onChange={e => setFundJustification(e.target.value)} />
          </div>
          <button onClick={fundPool} disabled={funding} className="btn-primary mt-3 disabled:opacity-50">
            {funding ? 'Funding…' : 'Fund Pool'}
          </button>
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">Journal</h3>
          <select className="input max-w-xs" value={eventType}
            onChange={e => { setEventType(e.target.value); setPage(1); }}>
            <option value="">All event types</option>
            {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-dark-700">
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">Event</th>
                <th className="py-2 pr-3">Postings</th>
                <th className="py-2">Ref</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e._id} className="border-b border-dark-800 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap text-gray-400">
                    {new Date(e.occurredAt || e.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3">
                    <p className="font-medium text-gray-200">{e.eventType}</p>
                    {e.description && <p className="text-xs text-gray-500 max-w-md">{e.description}</p>}
                  </td>
                  <td className="py-2 pr-3">
                    {e.postings.map((p, i) => (
                      <div key={i} className="flex justify-between gap-4 font-mono text-xs">
                        <span className="text-gray-400">{p.account}</span>
                        <span className={p.amountMinor >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {inr(p.amountMinor / 100)}
                        </span>
                      </div>
                    ))}
                  </td>
                  <td className="py-2 text-xs text-gray-500">{e.refModel} {e.refId}</td>
                </tr>
              ))}
              {!loading && entries.length === 0 && (
                <tr><td colSpan={4} className="py-6 text-center text-gray-500">No ledger entries yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-end gap-2 mt-3 text-sm">
          <button className="btn-primary px-3 py-1 disabled:opacity-40" disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}>Prev</button>
          <span className="text-gray-400">Page {page} / {pages}</span>
          <button className="btn-primary px-3 py-1 disabled:opacity-40" disabled={page >= pages}
            onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
};
