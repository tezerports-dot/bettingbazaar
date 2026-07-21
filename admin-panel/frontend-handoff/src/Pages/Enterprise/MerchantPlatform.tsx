// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * MerchantPlatform.tsx — Merchant Platform console (Phase 008 APIs, UI
 * shipped Phase C 2026-07-10). Bonus policy (Business Policy Platform),
 * leaderboard, per-merchant wallet ledger, on-demand bonus engine run.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Play, Trophy, ScrollText } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { usePermissions } from '../../hooks/usePermission';

const inr = (n: number) =>
  '₹' + (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export const MerchantPlatform: React.FC = () => {
  const { isAdmin } = usePermissions();
  const [policy, setPolicy] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ledgerMerchant, setLedgerMerchant] = useState<any>(null);
  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);

  const [form, setForm] = useState({
    enabled: false, bonusPercent: 1, minMatchedVolume: 0, justification: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [polRes, histRes, lbRes] = await Promise.all([
        api.get<any>('/api/admin/merchant-bonus-policy'),
        api.get<any>('/api/admin/merchant-bonus-policy/history'),
        api.get<any>('/api/admin/merchant-platform/leaderboard', { params: { days, limit: 25 } }),
      ]);
      if (polRes.data?.success) {
        setPolicy(polRes.data.policy);
        if (polRes.data.policy) {
          setForm(f => ({
            ...f,
            enabled: !!polRes.data.policy.enabled,
            bonusPercent: polRes.data.policy.bonusPercent ?? 1,
            minMatchedVolume: polRes.data.policy.minMatchedVolume ?? 0,
          }));
        }
      }
      if (histRes.data?.success) setHistory(histRes.data.history || []);
      if (lbRes.data?.success) setLeaderboard(lbRes.data.leaderboard || []);
    } catch {
      toast.error('Failed to load merchant platform data');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const savePolicy = async () => {
    if (!form.justification.trim()) return toast.error('Business justification required');
    setSaving(true);
    try {
      const res = await api.put<any>('/api/admin/merchant-bonus-policy', {
        enabled: form.enabled,
        bonusPercent: Number(form.bonusPercent),
        minMatchedVolume: Number(form.minMatchedVolume),
        justification: form.justification.trim(),
      });
      if (res.data?.success) {
        toast.success(res.data.message);
        setForm(f => ({ ...f, justification: '' }));
        load();
      } else toast.error(res.data?.message || 'Save failed');
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const runEngine = async () => {
    setRunning(true);
    try {
      const res = await api.post<any>('/api/admin/merchant-platform/bonus-engine/run');
      if (res.data?.success) {
        if (res.data.ran === false) {
          toast(res.data.reason || 'Engine idle — no enabled policy.');
        } else {
          toast.success(`Engine ran (policy v${res.data.policyVersion}): ${(res.data.results || []).length} merchant(s) evaluated`);
        }
        load();
      } else toast.error(res.data?.message || 'Engine run failed');
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Engine run failed');
    } finally {
      setRunning(false);
    }
  };

  const openLedger = async (m: any) => {
    setLedgerMerchant(m);
    try {
      const res = await api.get<any>(`/api/admin/merchant-platform/${m.merchantId}/wallet-ledger`, { params: { limit: 50 } });
      if (res.data?.success) setLedgerEntries(res.data.entries || res.data.ledger || []);
    } catch {
      toast.error('Failed to load wallet ledger');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-1">Merchant Platform</h1>
          <p className="text-gray-400 text-sm">
            Performance bonuses (platform-funded, never from users), leaderboard, wallet ledgers.
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <button onClick={runEngine} disabled={running} className="btn-primary flex items-center">
              <Play size={16} className="mr-2" /> {running ? 'Running…' : 'Run Bonus Engine'}
            </button>
          )}
          <button onClick={load} className="btn-primary flex items-center" disabled={loading}>
            <RefreshCw size={16} className={`mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {isAdmin && (
        <div className="card border border-gold-500/30">
          <h3 className="text-lg font-semibold mb-1">Merchant Performance Bonus Policy</h3>
          <p className="text-xs text-gray-400 mb-3">
            Pays merchants a % of NEWLY matched buy→sell cycle volume, from the platform-funded
            bonus pool only. {policy ? `Active: v${policy.version} — ${policy.enabled ? `ON @ ${policy.bonusPercent}%` : 'disabled'}.` : 'Not configured yet — the engine is idle.'}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div className="flex items-center justify-between md:flex-col md:items-start gap-2">
              <p className="font-medium text-sm">Enabled</p>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" checked={form.enabled}
                  onChange={e => setForm({ ...form, enabled: e.target.checked })} className="sr-only peer" />
                <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
              </label>
            </div>
            <div>
              <label className="label">Bonus % of matched volume</label>
              <input type="number" min={0} max={100} step={0.01} className="input"
                value={form.bonusPercent} onChange={e => setForm({ ...form, bonusPercent: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label">Min matched volume (₹)</label>
              <input type="number" min={0} className="input"
                value={form.minMatchedVolume} onChange={e => setForm({ ...form, minMatchedVolume: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label">Justification (required)</label>
              <input type="text" className="input" placeholder="Why this change?"
                value={form.justification} onChange={e => setForm({ ...form, justification: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-gold-400/80 mt-2">
            Example with {form.bonusPercent || 0}%: a merchant who completes ₹1,00,000 of matched
            buy+sell volume earns {inr((100000 * (Number(form.bonusPercent) || 0)) / 100)} — paid from the
            bonus pool, skipped (never partial) if the pool can't cover it.
          </p>
          <button onClick={savePolicy} disabled={saving} className="btn-primary mt-3 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save New Policy Version'}
          </button>
          {history.length > 0 && (
            <details className="mt-3">
              <summary className="text-xs text-gray-400 cursor-pointer">Version history ({history.length})</summary>
              <div className="mt-2 space-y-1 text-xs text-gray-500">
                {history.map((h: any) => (
                  <p key={h._id}>
                    v{h.version} · {h.enabled ? `ON @ ${h.bonusPercent}%` : 'disabled'} · min {inr(h.minMatchedVolume || 0)} ·{' '}
                    {h.status} · {new Date(h.createdAt).toLocaleString()}
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Trophy size={18} className="text-gold-500" /> Leaderboard
          </h3>
          <select className="input max-w-[140px]" value={days} onChange={e => setDays(Number(e.target.value))}>
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
                <th className="py-2 pr-3 text-right">Wallet</th>
                <th className="py-2 pr-3 text-right">Orders</th>
                <th className="py-2 pr-3 text-right">Completed volume</th>
                <th className="py-2 pr-3 text-center">Online</th>
                <th className="py-2 text-right">Ledger</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((m: any) => (
                <tr key={m.merchantId} className="border-b border-dark-800">
                  <td className="py-2 pr-3 text-gray-200">{m.username}</td>
                  <td className="py-2 pr-3 text-right font-mono">{inr(m.tokenBalance)}</td>
                  <td className="py-2 pr-3 text-right">{m.completedOrders}/{m.totalOrders}</td>
                  <td className="py-2 pr-3 text-right font-mono text-gold-400/90">{inr(m.completedVolume)}</td>
                  <td className="py-2 pr-3 text-center">{m.isOnline ? '🟢' : '⚫'}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => openLedger(m)} className="text-gold-400 hover:underline text-xs flex items-center gap-1 ml-auto">
                      <ScrollText size={13} /> view
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && leaderboard.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-gray-500">No merchant activity in this window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {ledgerMerchant && (
        <div className="card border border-dark-600">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold">Wallet ledger — {ledgerMerchant.username}</h3>
            <button className="text-gray-400 text-sm hover:text-gray-200" onClick={() => setLedgerMerchant(null)}>close</button>
          </div>
          <div className="space-y-1 text-sm max-h-80 overflow-y-auto">
            {ledgerEntries.map((e: any, i: number) => (
              <div key={e._id || i} className="flex justify-between gap-3 border-b border-dark-800 py-1">
                <span className="text-gray-400 text-xs whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</span>
                <span className="flex-1 text-xs text-gray-500 truncate" title={e.reason}>{e.reason}</span>
                <span className={`font-mono text-xs ${e.type === 'CREDIT' ? 'text-green-400' : 'text-red-400'}`}>
                  {e.type === 'CREDIT' ? '+' : '−'}{inr(e.amount)}
                </span>
                <span className="font-mono text-xs text-gray-400">→ {inr(e.balanceAfter)}</span>
              </div>
            ))}
            {ledgerEntries.length === 0 && <p className="text-gray-500 text-sm py-3 text-center">No ledger entries.</p>}
          </div>
        </div>
      )}
    </div>
  );
};
