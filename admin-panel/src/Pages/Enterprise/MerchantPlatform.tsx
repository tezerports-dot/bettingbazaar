// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * MerchantPlatform.tsx — Merchant Platform console: the leaderboard, and for
 * one merchant their funding figures and daily completed-order history.
 *
 * Routes (backend/domains/merchant/merchantPlatform.admin.routes.js):
 *   GET /api/admin/merchant-platform/leaderboard
 *   GET /api/admin/merchant-platform/:id/funding-stats
 *   GET /api/admin/merchant-platform/:id/performance-history
 *
 * A merchant holds no tokens (PROJECT_STATUS §3.10, 2c): their team's pool
 * does. So there is no wallet column, no wallet ledger and no admin top-up
 * here. The old commission policy, its per-variety rate editor and the engine
 * run went with the routes behind them; team commission (2e) is paid into team
 * pools and shown in Teams, not here.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trophy, ScrollText } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { Toolbar } from '../../components/design';

const inr = (n: number) =>
  '₹' + (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** A token figure. */
const bb = (n: number) => `${(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })} BB`;

/**
 * A volume in the MERCHANT's currency. Order volumes are summed in the order's
 * currency, and the server names which (`stats.currency`). A USDT merchant's
 * 555.56 rendered as "₹555.56" is the same lie trap 15 records for an order.
 */
const inMerchantCurrency = (n: number, currency?: string) =>
  currency === 'USDT'
    ? `${(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })} USDT`
    : inr(n);

/**
 * One merchant's funding picture, as `GET /merchant-platform/:id/funding-stats`
 * sends it (merchantAnalytics.service.js over stats.merchantFundingStats).
 */
interface FundingStats {
  currency: 'INR' | 'USDT';
  depositsCompleted: number; depositVolume: number;
  withdrawalsCompleted: number; withdrawalVolume: number;
  /** min(deposit volume, withdrawal volume): what went round a buy→sell cycle. */
  matchedCycleVolume: number;
  successRate: number;        // 0..1, off the merchant row
  avgResponseMinutes: number;
}

/** One day of `GET /merchant-platform/:id/performance-history`. */
interface DayRow { day: string; totalOrders: number; totalVolume: number }

// Out here, not inside the screen (§32 S23).
const Figure: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="bg-dark-800 rounded-lg p-3">
    <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
    <p className="text-sm text-gray-100 font-medium mt-0.5">{value}</p>
  </div>
);

export const MerchantPlatform: React.FC = () => {
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  // The merchant opened from the leaderboard, and its two reads — each kept
  // apart, so one failing does not blank the other.
  const [opened, setOpened] = useState<any>(null);
  const [stats, setStats] = useState<FundingStats | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [daysRows, setDaysRows] = useState<DayRow[]>([]);
  const [daysFailed, setDaysFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const lbRes = await api.get<any>('/api/admin/merchant-platform/leaderboard', { params: { days, limit: 25 } });
      if (lbRes.data?.success) setLeaderboard(lbRes.data.leaderboard || []);
    } catch {
      toast.error('Failed to load merchant platform data');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  /**
   * Open one merchant: funding figures and the daily history for the period
   * the leaderboard is showing.
   */
  const openMerchant = async (m: any) => {
    setOpened(m);
    setStats(null); setStatsFailed(false);
    setDaysRows([]); setDaysFailed(false);
    // Each path written out whole, so every call names its route (check:ui-coverage).
    await Promise.all([
      api.get<any>(`/api/admin/merchant-platform/${m.merchantId}/funding-stats`)
        .then((res) => { if (res.data?.success) setStats(res.data.stats); else setStatsFailed(true); })
        .catch(() => setStatsFailed(true)),
      api.get<any>(`/api/admin/merchant-platform/${m.merchantId}/performance-history`, { params: { days } })
        .then((res) => { if (res.data?.success) setDaysRows(res.data.history || []); else setDaysFailed(true); })
        .catch(() => setDaysFailed(true)),
    ]);
  };

  const activeDays = daysRows.filter((d) => d.totalOrders > 0);

  return (
    <div className="om-fade space-y-6">
      <Toolbar actions={[
        { label: 'Refresh', icon: RefreshCw, onClick: load },
      ]} />

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Trophy size={18} className="text-gold-500" /> Leaderboard
          </h3>
          <select aria-label="Leaderboard period" className="input max-w-[140px]" value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-dark-700">
                <th className="py-2 pr-3">Merchant</th>
                <th className="py-2 pr-3 text-right">Orders</th>
                <th className="py-2 pr-3 text-right">Completed volume</th>
                <th className="py-2 pr-3 text-center">Online</th>
                <th className="py-2 text-right">Details</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((m: any) => (
                <tr key={m.merchantId} className="border-b border-dark-800">
                  <td className="py-2 pr-3 text-gray-200">{m.username}</td>
                  <td className="py-2 pr-3 text-right">{m.completedOrders}/{m.totalOrders}</td>
                  {/* Tokens: the query sums `token_amount_paise` so merchants on
                      different rails rank on one scale (trap 15). */}
                  <td className="py-2 pr-3 text-right font-mono text-gold-400/90">{bb(m.completedVolume)}</td>
                  <td className="py-2 pr-3 text-center">{m.isOnline ? '🟢' : '⚫'}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => void openMerchant(m)} aria-label={`Open ${m.username}`} className="text-gold-400 hover:underline text-xs flex items-center gap-1 ml-auto">
                      <ScrollText size={13} /> view
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && leaderboard.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-gray-500">No merchant activity in this window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {opened && (
        <div className="card border border-dark-600 space-y-4" aria-label={`Merchant ${opened.username}`}>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{opened.username}</h3>
            <button className="text-gray-400 text-sm hover:text-gray-200" onClick={() => setOpened(null)}>close</button>
          </div>

          <section aria-label="Funding">
            {statsFailed ? (
              <p role="alert" className="text-sm text-red-400">Could not load this merchant's figures.</p>
            ) : !stats ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <Figure label="Buys completed" value={`${stats.depositsCompleted} · ${inMerchantCurrency(stats.depositVolume, stats.currency)}`} />
                <Figure label="Sells completed" value={`${stats.withdrawalsCompleted} · ${inMerchantCurrency(stats.withdrawalVolume, stats.currency)}`} />
                <Figure label="Matched volume" value={inMerchantCurrency(stats.matchedCycleVolume, stats.currency)} />
                <Figure label="Success rate" value={`${Math.round((stats.successRate ?? 0) * 100)}%`} />
                <Figure label="Avg response" value={`${(stats.avgResponseMinutes ?? 0).toFixed(1)} min`} />
                <Figure label="Rail" value={stats.currency} />
              </div>
            )}
          </section>

          <section aria-label="Daily completed orders">
            <p className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Completed orders, last {days} days</p>
            {daysFailed ? (
              <p role="alert" className="text-sm text-red-400">Could not load the daily history.</p>
            ) : activeDays.length === 0 ? (
              <p className="text-sm text-gray-500">No completed orders in the last {days} days.</p>
            ) : (
              <div className="space-y-1 text-sm">
                {activeDays.map((d) => (
                  <div key={d.day} className="flex justify-between gap-3 border-b border-dark-800 py-1">
                    <span className="text-gray-400 text-xs">{d.day}</span>
                    <span className="text-xs text-gray-300">{d.totalOrders} order{d.totalOrders === 1 ? '' : 's'}</span>
                    <span className="font-mono text-xs text-gold-400/90">{inMerchantCurrency(d.totalVolume, stats?.currency)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
