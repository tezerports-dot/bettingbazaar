// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, DollarSign, Download, Calendar } from 'lucide-react';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
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

export const ProfitLoss: React.FC = () => {
  const [stats, setStats]     = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const [preset, setPreset]   = useState<Preset>('month');
  const [startDate, setStart] = useState('');
  const [endDate, setEnd]     = useState('');

  const getQueryDates = () => {
    if (preset === 'custom') return { start: startDate, end: endDate };
    return presetDates(preset);
  };

  const load = async () => {
    setLoading(true);
    const { start, end } = getQueryDates();
    try {
      const r = await api.analytics.getFinancials(start || undefined, end || undefined);
      if (r.success && r.data) { setStats(r.data); setError(false); }
      else setError(true);
    } catch { setError(true); toast.error('Failed to load P&L data'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [preset, startDate, endDate]);

  const changePreset = (p: Preset) => { setPreset(p); if (p !== 'custom') { setStart(''); setEnd(''); } };

  if (error && !stats) return (
    <div className="flex flex-col items-center justify-center py-12 gap-4">
      <p className="text-red-400 font-semibold">Failed to load P&L data</p>
      <p className="text-gray-500 text-sm">Requires admin access.</p>
      <button onClick={load} className="btn-primary text-sm">Retry</button>
    </div>
  );

  const profitMargin = stats?.totalRevenue > 0 ? (stats.netProfit / stats.totalRevenue) * 100 : 0;
  const netPos = (stats?.netProfit || 0) >= 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-1">Profit & Loss</h1>
          <p className="text-gray-400 text-sm">Financial performance overview</p>
        </div>
        <button className="btn-secondary flex items-center gap-2"><Download size={16}/>Export</button>
      </div>

      {/* Date Preset Tabs */}
      <div className="card space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Calendar size={14} className="text-gray-500"/>
          <span className="text-xs text-gray-500 mr-1">Range:</span>
          {PRESETS.map(p => (
            <button key={p.key} onClick={() => changePreset(p.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                preset === p.key ? 'border-yellow-500 bg-yellow-500/10 text-yellow-400' : 'border-dark-600 text-gray-400 hover:border-dark-500'
              }`}>{p.label}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-3 pt-1">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">From</label>
              <input type="date" value={startDate} onChange={e => setStart(e.target.value)}
                className="bg-dark-800 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-yellow-500/50"/>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">To</label>
              <input type="date" value={endDate} onChange={e => setEnd(e.target.value)}
                className="bg-dark-800 border border-dark-600 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-yellow-500/50"/>
            </div>
            <button onClick={load} className="btn-primary text-xs mt-5">Apply</button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin"/>
        </div>
      ) : stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="card"><div className="flex items-center justify-between mb-2"><p className="text-xs text-gray-400">Total Revenue</p><TrendingUp className="text-green-500" size={18}/></div><p className="text-2xl font-bold text-green-500">{fmt(stats.totalRevenue)}</p></div>
            <div className="card"><div className="flex items-center justify-between mb-2"><p className="text-xs text-gray-400">Total Expenses</p><TrendingDown className="text-red-500" size={18}/></div><p className="text-2xl font-bold text-red-500">{fmt(stats.totalExpenses)}</p></div>
            <div className="card"><div className="flex items-center justify-between mb-2"><p className="text-xs text-gray-400">Net Profit</p><DollarSign className={netPos ? 'text-gold-500' : 'text-red-400'} size={18}/></div><p className={`text-2xl font-bold ${netPos ? 'text-gold-500' : 'text-red-400'}`}>{fmt(stats.netProfit)}</p></div>
            <div className="card"><p className="text-xs text-gray-400 mb-2">Profit Margin</p><p className={`text-2xl font-bold ${profitMargin >= 0 ? 'text-white' : 'text-red-400'}`}>{profitMargin >= 0 ? '+' : ''}{profitMargin.toFixed(1)}%</p></div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="card">
              <h3 className="text-base font-semibold mb-3">Revenue</h3>
              <div className="space-y-2">
                {[{ label: 'Deposits', val: stats.deposits?.amount||0, count: stats.deposits?.count, color: 'text-green-500' },
                  { label: 'Bets Placed', val: stats.bets?.amount||0, count: stats.bets?.count, color: 'text-blue-500' }].map(r => (
                  <div key={r.label} className="flex justify-between items-center p-3 bg-dark-700 rounded-lg">
                    <span className="text-sm text-gray-400">{r.label}</span>
                    <div className="text-right"><p className={`font-semibold ${r.color}`}>{fmt(r.val)}</p><p className="text-xs text-gray-500">{(r.count||0).toLocaleString()} txns</p></div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <h3 className="text-base font-semibold mb-3">Expenses</h3>
              <div className="space-y-2">
                {[{ label: 'Withdrawals', val: stats.withdrawals?.amount||0, count: stats.withdrawals?.count, color: 'text-red-500' },
                  { label: 'Bet Payouts', val: stats.payouts?.amount||0, count: stats.payouts?.count, color: 'text-orange-500' }].map(r => (
                  <div key={r.label} className="flex justify-between items-center p-3 bg-dark-700 rounded-lg">
                    <span className="text-sm text-gray-400">{r.label}</span>
                    <div className="text-right"><p className={`font-semibold ${r.color}`}>{fmt(r.val)}</p><p className="text-xs text-gray-500">{(r.count||0).toLocaleString()} txns</p></div>
                  </div>
                ))}
              </div>
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
                    {stats.byProvider.map((p: any) => (
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

          <div className="card bg-gradient-to-r from-gold-500/10 to-gold-600/10 border-gold-500/30">
            <div className="grid grid-cols-3 gap-6 text-center">
              <div><p className="text-xs text-gray-400 mb-1">Total In</p><p className="text-xl font-bold text-green-500">{fmt((stats.deposits?.amount||0)+(stats.bets?.amount||0))}</p></div>
              <div><p className="text-xs text-gray-400 mb-1">Total Out</p><p className="text-xl font-bold text-red-500">{fmt((stats.withdrawals?.amount||0)+(stats.payouts?.amount||0))}</p></div>
              <div><p className="text-xs text-gray-400 mb-1">Net Profit</p><p className={`text-2xl font-bold ${netPos ? 'text-gold-500' : 'text-red-400'}`}>{fmt(stats.netProfit)}</p></div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
