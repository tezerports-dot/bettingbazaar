// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Token Flow — where tokens entered the platform, where they left, and what
 * the operator put in to make that possible.
 *
 * ── Why these are three views and not one ───────────────────────────────────
 * The backend keeps them deliberately apart, and the separation is the point:
 *
 *   deposit-dashboard     ONLY real player INR -> token purchases
 *   withdrawal-dashboard  ONLY real player token -> INR sells
 *   merchant-funding      ONLY merchant topup / reserve / liquidity
 *
 * Adding merchant funding into a "total deposits" figure would inflate player
 * volume with the operator's own float — a number that flatters the platform
 * and answers no question anyone actually has. They are rendered side by side
 * and never summed.
 *
 * All four endpoints here were built, tested, merged and unreachable: no screen
 * called any of them. A backend feature with no UI is not shipped.
 */
import React, { useEffect, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Landmark, RefreshCw, TrendingUp } from 'lucide-react';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import toast from 'react-hot-toast';

interface DailyPoint { date: string; tokens: number; count: number; }

interface DepositData {
  totalINRDeposited: number; totalTokensPurchased: number;
  numberOfBuyers: number; transactionCount: number; dailyBreakdown: DailyPoint[];
}
interface WithdrawalData {
  totalTokensSold: number; totalINRWithdrawn: number;
  numberOfSellers: number; transactionCount: number; dailyBreakdown: DailyPoint[];
}
interface FundingData {
  merchantTopup: number; merchantReserve: number;
  merchantLiquidity: number; activeMerchants: number;
}
interface Trends {
  growth?: { signups: { day: string; count: number }[]; firstTimeDepositors: { day: string; count: number }[] };
  business?: Record<string, { day: string; [k: string]: any }[]>;
  revenue?: Record<string, unknown>;
  risk?: Record<string, unknown>;
}

const Tile: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({ label, value, tone = 'text-gray-100' }) => (
  <div className="bg-dark-800 rounded-xl p-4 border border-dark-700">
    <p className="text-xs text-gray-400">{label}</p>
    <p className={`text-2xl font-bold mt-1 ${tone}`}>{value}</p>
  </div>
);

/**
 * A day-bucketed series as proportional bars.
 *
 * Deliberately not a chart library: the question this answers is "was there a
 * day that looks wrong", which a bar per day answers without 40 kB of runtime.
 * The scale is the series maximum, and it is stated, because a bar chart with
 * no axis is decoration.
 */
const DailyBars: React.FC<{ points: DailyPoint[]; tone: string }> = ({ points, tone }) => {
  if (!points?.length) return <p className="text-sm text-gray-500 py-4">No activity in this window.</p>;
  const peak = Math.max(...points.map(p => p.tokens), 0);
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-gray-500">Peak day: {formatters.currency(peak)} — bars are relative to it</p>
      <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
        {points.map(p => (
          <div key={p.date} className="flex items-center gap-3 text-xs">
            <span className="w-24 shrink-0 text-gray-400 font-mono">{p.date}</span>
            <div className="flex-1 bg-dark-700 rounded-full h-2.5 overflow-hidden">
              <div className={`h-full rounded-full ${tone}`} style={{ width: peak > 0 ? `${Math.max((p.tokens / peak) * 100, 1)}%` : '0%' }} />
            </div>
            <span className="w-28 shrink-0 text-right font-medium">{formatters.currency(p.tokens)}</span>
            <span className="w-16 shrink-0 text-right text-gray-500">{p.count} ord</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const Section: React.FC<{ icon: React.ReactNode; title: string; note: string; children: React.ReactNode }> =
  ({ icon, title, note, children }) => (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">{icon}{title}</h2>
        <p className="text-xs text-gray-500 mt-0.5">{note}</p>
      </div>
      {children}
    </div>
  );

export const TokenFlow: React.FC = () => {
  const [deposits, setDeposits] = useState<DepositData | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalData | null>(null);
  const [funding, setFunding] = useState<FundingData | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [days, setDays] = useState(30);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    // The window is a query param the handler validates: an unparseable date is
    // rejected there rather than silently matching nothing.
    const params = { startDate: startDate || undefined, endDate: endDate || undefined };
    const [d, w, f, t] = await Promise.allSettled([
      api.get<any>('/api/admin/analytics/deposit-dashboard', { params }),
      api.get<any>('/api/admin/analytics/withdrawal-dashboard', { params }),
      api.get<any>('/api/admin/analytics/merchant-funding'),
      api.get<any>('/api/admin/analytics/trends', { params: { days } }),
    ]);
    if (d.status === 'fulfilled') setDeposits(d.value.data?.data ?? null); else toast.error('Deposit flow failed to load');
    if (w.status === 'fulfilled') setWithdrawals(w.value.data?.data ?? null); else toast.error('Withdrawal flow failed to load');
    if (f.status === 'fulfilled') setFunding(f.value.data?.data ?? null); else toast.error('Merchant funding failed to load');
    if (t.status === 'fulfilled') setTrends(t.value.data?.trends ?? null);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [days]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Token Flow</h1>
          <p className="text-gray-400 text-sm mt-1">
            Player purchases, player sells and merchant funding — kept apart on purpose, and never added together
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label text-xs">From</label>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input text-sm" />
          </div>
          <div>
            <label className="label text-xs">To</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="input text-sm" />
          </div>
          <div>
            <label className="label text-xs">Trend window</label>
            <select value={days} onChange={e => setDays(Number(e.target.value))} className="input text-sm">
              {[7, 30, 90, 365].map(n => <option key={n} value={n}>{n} days</option>)}
            </select>
          </div>
          <button onClick={load} disabled={loading} className="btn-secondary text-sm flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Apply
          </button>
        </div>
      </div>

      <Section
        icon={<ArrowDownCircle size={18} className="text-green-400" />}
        title="Player purchases"
        note="Real INR → token buys only. Merchant funding is excluded and shown separately below."
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Tile label="INR received" value={formatters.currency(deposits?.totalINRDeposited ?? 0)} tone="text-green-400" />
          <Tile label="Tokens issued" value={formatters.currency(deposits?.totalTokensPurchased ?? 0)} />
          <Tile label="Buyers" value={deposits?.numberOfBuyers ?? 0} />
          <Tile label="Orders" value={deposits?.transactionCount ?? 0} />
        </div>
        <DailyBars points={deposits?.dailyBreakdown ?? []} tone="bg-green-500" />
      </Section>

      <Section
        icon={<ArrowUpCircle size={18} className="text-orange-400" />}
        title="Player sells"
        note="Real token → INR redemptions only. Merchant reserve and liquidity movements are excluded."
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Tile label="INR paid out" value={formatters.currency(withdrawals?.totalINRWithdrawn ?? 0)} tone="text-orange-400" />
          <Tile label="Tokens redeemed" value={formatters.currency(withdrawals?.totalTokensSold ?? 0)} />
          <Tile label="Sellers" value={withdrawals?.numberOfSellers ?? 0} />
          <Tile label="Orders" value={withdrawals?.transactionCount ?? 0} />
        </div>
        <DailyBars points={withdrawals?.dailyBreakdown ?? []} tone="bg-orange-500" />
      </Section>

      <Section
        icon={<Landmark size={18} className="text-blue-400" />}
        title="Merchant funding"
        note="The operator's own float: topup, reserve and liquidity. Never part of player volume."
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Tile label="Topup" value={formatters.currency(funding?.merchantTopup ?? 0)} tone="text-blue-400" />
          <Tile label="Reserve" value={formatters.currency(funding?.merchantReserve ?? 0)} tone="text-blue-400" />
          <Tile label="Liquidity" value={formatters.currency(funding?.merchantLiquidity ?? 0)} tone="text-blue-400" />
          <Tile label="Active merchants" value={funding?.activeMerchants ?? 0} />
        </div>
      </Section>

      {trends?.growth && (
        <Section
          icon={<TrendingUp size={18} className="text-gold-400" />}
          title={`Growth — last ${days} days`}
          note="Signups against first-time depositors: the gap between them is the funnel."
        >
          <div className="grid md:grid-cols-2 gap-6">
            {([
              ['Signups', trends.growth.signups, 'bg-gold-500'],
              ['First-time depositors', trends.growth.firstTimeDepositors, 'bg-green-500'],
            ] as [string, { day: string; count: number }[], string][]).map(([label, series, tone]) => {
              const peak = Math.max(...(series ?? []).map(p => p.count), 0);
              return (
                <div key={label} className="space-y-2">
                  <p className="text-sm font-medium">{label} <span className="text-xs text-gray-500">· peak {peak}/day</span></p>
                  {!series?.length ? <p className="text-sm text-gray-500">No data.</p> : (
                    <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                      {series.map(p => (
                        <div key={p.day} className="flex items-center gap-3 text-xs">
                          <span className="w-24 shrink-0 text-gray-400 font-mono">{p.day}</span>
                          <div className="flex-1 bg-dark-700 rounded-full h-2 overflow-hidden">
                            <div className={`h-full rounded-full ${tone}`} style={{ width: peak > 0 ? `${Math.max((p.count / peak) * 100, 1)}%` : '0%' }} />
                          </div>
                          <span className="w-10 shrink-0 text-right">{p.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
};
