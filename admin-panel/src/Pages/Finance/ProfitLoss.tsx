// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { useCallback, useEffect, useState } from 'react';
import { formatters } from '../../utils/formatters';
import { Kpis, Toolbar } from '../../components/design';
import api, { downloadCsv, cleanParams } from '../../services/api';
import { Download } from 'lucide-react';
import type { FinancialStats } from '../../types';
import toast from 'react-hot-toast';

const fmt = (n: number) => formatters.currency(n);
type Preset = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';

function presetDates(p: Preset): { start: string; end: string } {
  const now  = new Date();
  const iso  = (d: Date) => d.toISOString().slice(0, 10);
  const today = iso(now);
  if (p === 'today') return { start: today, end: today };
  if (p === 'week')  { const d = new Date(now); d.setDate(now.getDate() - 6); return { start: iso(d), end: today }; }
  if (p === 'month') { const d = new Date(now); d.setDate(1); return { start: iso(d), end: today }; }
  if (p === 'year')  return { start: `${now.getFullYear()}-01-01`, end: today };
  return { start: '', end: '' };
}

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week',  label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'year',  label: 'This Year' },
  { key: 'all',   label: 'All Time' },
  { key: 'custom',label: 'Custom' },
];

const Line: React.FC<{ label: string; val: number; note?: string; tone: string }> = ({ label, val, note, tone }) => (
  <div className="flex justify-between items-center p-3 bg-dark-700 rounded-lg">
    <span className="text-sm text-gray-400">{label}</span>
    <div className="text-right"><p className={`font-semibold ${tone}`}>{fmt(val)}</p>{note && <p className="text-xs text-gray-500">{note}</p>}</div>
  </div>
);

export const ProfitLoss: React.FC = () => {
  const [stats, setStats]     = useState<FinancialStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const [preset, setPreset]   = useState<Preset>('month');
  const [startDate, setStart] = useState('');
  const [endDate, setEnd]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const { start, end } = preset === 'custom' ? { start: startDate, end: endDate } : presetDates(preset);
    try {
      const r = await api.analytics.getFinancials(start || undefined, end || undefined);
      if (r.success && r.data) { setStats(r.data); setError(false); }
      else setError(true);
    } catch { setError(true); toast.error('Failed to load P&L data'); }
    finally { setLoading(false); }
  }, [preset, startDate, endDate]);

  useEffect(() => { load(); }, [load]);

  const changePreset = (p: Preset) => { setPreset(p); if (p !== 'custom') { setStart(''); setEnd(''); } };

  if (error && !stats) return (
    <div className="flex flex-col items-center justify-center py-12 gap-4">
      <p className="text-red-400 font-semibold">Failed to load P&L data</p>
      <p className="text-gray-500 text-sm">Requires admin access.</p>
      <button onClick={load} className="btn-primary text-sm">Retry</button>
    </div>
  );

  // Margin on what the house kept, never on deposits: a deposit is the
  // player's money, not revenue (`stats.profitAndLoss`).
  const revenue = stats?.revenue?.total || 0;
  const profitMargin = revenue > 0 ? ((stats?.netProfit ?? 0) / revenue) * 100 : 0;
  const netPos = (stats?.netProfit || 0) >= 0;
  const range = () => (preset === 'custom' ? { start: startDate, end: endDate } : presetDates(preset));
  const exportCsv = async () => {
    const { start, end } = range();
    try {
      await downloadCsv('/api/admin/analytics/financials.csv', cleanParams({ startDate: start, endDate: end }), 'profit-loss.csv');
    } catch { toast.error('Export failed'); }
  };
  return (
    <div className="om-fade space-y-6">
      <Toolbar
        tabs={PRESETS.map((p) => ({ label: p.label, active: preset === p.key, onClick: () => changePreset(p.key) }))}
        actions={[{ label: 'Download CSV', icon: Download, onClick: exportCsv }]}
      />
      {preset === 'custom' && (
        <div className="flex items-end gap-3">
          <div><label className="text-xs text-gray-400 mb-1 block" htmlFor="from">From</label><input id="from" type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="input" style={{ width: 175 }} /></div>
          <div><label className="text-xs text-gray-400 mb-1 block" htmlFor="to">To</label><input id="to" type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="input" style={{ width: 175 }} /></div>
          <button onClick={load} className="btn-primary text-xs">Apply</button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin"/>
        </div>
      ) : stats && (
        <>
          <Kpis items={[
            { label: 'Revenue (kept)', value: fmt(revenue), tone: 'var(--success)' },
            { label: 'Costs', value: fmt(stats.costs?.total || 0), tone: 'var(--danger)' },
            { label: 'Net Profit', value: fmt(stats.netProfit), tone: netPos ? 'var(--gold-ink)' : 'var(--danger)' },
            { label: 'Profit Margin', value: `${profitMargin >= 0 ? '+' : ''}${profitMargin.toFixed(1)}%`, tone: profitMargin >= 0 ? 'var(--text)' : 'var(--danger)' },
          ]} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card">
              <h3 className="text-base font-semibold mb-1">Revenue</h3>
              <p className="text-xs text-gray-500 mb-3">What the house kept from settled games. Phantom bets are never counted.</p>
              <div className="space-y-2">
                <Line label="Board games: settled stakes" val={stats.revenue.boardGames.settledStakes} note={`${stats.revenue.boardGames.bets.toLocaleString()} bets`} tone="text-blue-500" />
                <Line label="Board games: paid to winners" val={-stats.revenue.boardGames.payouts} note={`${stats.revenue.boardGames.wins.toLocaleString()} wins`} tone="text-orange-500" />
                <Line label="Board games: kept" val={stats.revenue.boardGames.amount} note={`includes ${fmt(stats.revenue.winningsFees)} winnings fee`} tone="text-green-500" />
                <Line label="Casino games: kept" val={stats.revenue.casino} tone="text-green-500" />
              </div>
            </div>
            <div className="card">
              <h3 className="text-base font-semibold mb-1">Costs</h3>
              <p className="text-xs text-gray-500 mb-3">Paid out of the platform's own tokens.</p>
              <div className="space-y-2">
                <Line label="Referral bonuses" val={stats.costs.referralBonuses.amount} note={`${stats.costs.referralBonuses.count} paid`} tone="text-red-500" />
                <Line label="First deposit bonuses" val={stats.costs.firstDepositBonuses.amount} note={`${stats.costs.firstDepositBonuses.count} paid`} tone="text-red-500" />
                <Line label="Team commission" val={stats.costs.teamCommission.amount} note={`${stats.costs.teamCommission.count} payments`} tone="text-red-500" />
              </div>
            </div>
          </div>
          <div className="card">
            <h3 className="text-base font-semibold mb-1">Money flow (not revenue)</h3>
            <p className="text-xs text-gray-500 mb-3">Players' own money moving in and out, and stakes on rounds not yet settled.</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <Line label="Deposits" val={stats.moneyFlow.deposits.amount} note={`${stats.moneyFlow.deposits.count} orders`} tone="text-gray-200" />
              <Line label="Withdrawals" val={stats.moneyFlow.withdrawals.amount} note={`${stats.moneyFlow.withdrawals.count} orders`} tone="text-gray-200" />
              <Line label="Stakes still riding" val={stats.openStakes} tone="text-gray-200" />
            </div>
          </div>
          {stats.byProvider?.length > 0 && (
            <div className="card">
              <h3 className="text-base font-semibold mb-3">Revenue by Game Provider</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-gray-500 border-b border-dark-600">
                    <th className="pb-2 font-medium">Provider</th>
                    <th className="pb-2 font-medium text-right">Bets In</th>
                    <th className="pb-2 font-medium text-right">Wins Out</th>
                    <th className="pb-2 font-medium text-right">GGR</th>
                    <th className="pb-2 font-medium text-right">Rounds</th>
                  </tr></thead>
                  <tbody className="divide-y divide-dark-700">
                    {stats.byProvider.map((p) => (
                      <tr key={p.key} className="hover:bg-dark-700/50">
                        <td className="py-2.5 font-medium capitalize">{p.key}</td>
                        <td className="py-2.5 text-right text-blue-400">{fmt(p.bets)}</td>
                        <td className="py-2.5 text-right text-orange-400">{fmt(p.wins)}</td>
                        <td className={`py-2.5 text-right font-semibold ${p.ggr >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(p.ggr)}</td>
                        <td className="py-2.5 text-right text-gray-500">{p.betCount?.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card bg-linear-to-r from-gold-500/10 to-gold-600/10 border-gold-500/30">
            <div className="grid grid-cols-3 gap-6 text-center">
              <div><p className="text-xs text-gray-400 mb-1">Revenue</p><p className="text-xl font-bold text-green-500">{fmt(revenue)}</p></div>
              <div><p className="text-xs text-gray-400 mb-1">Costs</p><p className="text-xl font-bold text-red-500">{fmt(stats.costs.total)}</p></div>
              <div><p className="text-xs text-gray-400 mb-1">Net Profit</p><p className={`text-2xl font-bold ${netPos ? 'text-gold-500' : 'text-red-400'}`}>{fmt(stats.netProfit)}</p></div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
