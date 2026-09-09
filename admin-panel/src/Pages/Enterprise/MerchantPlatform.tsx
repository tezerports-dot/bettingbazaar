// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * MerchantPlatform.tsx — Merchant Platform console (Phase 008 APIs, UI
 * shipped Phase C 2026-07-10). Commission policy (Business Policy Platform),
 * leaderboard, per-merchant wallet ledger, on-demand commission engine run.
 *
 * The rate is per VARIETY of work — (rail, payment mode, denomination) — so the
 * editor is a list of varieties rather than one percentage box. The varieties
 * come from the server (`varieties` on the policy GET), which derives them from
 * the modules that own the ladders: a copy here would offer sizes the rail does
 * not deal in and the refusal would arrive from a CHECK constraint at save time
 * instead of from this form.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Play, Trophy, ScrollText, RotateCcw, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { usePermissions } from '../../hooks/usePermission';
import { Toolbar, type ToolbarAction } from '../../components/design';

const inr = (n: number) =>
  '₹' + (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** One priceable variety, as the server describes it. */
interface Variety {
  currency: string;
  paymentMode: string;
  denominationPaise: number | null;
  label: string;
}

/** A variety with a price on it. The two legs of one matched volume. */
interface Rate {
  currency: string;
  paymentMode: string;
  denominationPaise: number | null;
  buyPercent: number;
  sellPercent: number;
}

/**
 * The variety's identity, in the one spelling everything here compares on.
 *
 * The server builds the same string for the money key it writes; this copy only
 * ever addresses rows in this form, never a payment.
 */
const varietyId = (v: { currency: string; paymentMode: string; denominationPaise: number | null }) =>
  `${v.currency}:${v.paymentMode}:${v.denominationPaise ?? 'none'}`;

export const MerchantPlatform: React.FC = () => {
  const { isAdmin } = usePermissions();
  const [policy, setPolicy] = useState<any>(null);
  const [varieties, setVarieties] = useState<Variety[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ledgerMerchant, setLedgerMerchant] = useState<any>(null);
  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);

  const [form, setForm] = useState<{
    enabled: boolean; minMatchedVolume: number; justification: string; rates: Rate[];
  }>({
    // Saved DISABLED with nothing priced until an admin says otherwise: an
    // unpriced variety earns nothing, so a default here would be this panel
    // deciding what merchants are paid.
    enabled: false, minMatchedVolume: 0, justification: '', rates: [],
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [polRes, histRes, lbRes] = await Promise.all([
        api.get<any>('/api/admin/merchant-commission-policy'),
        api.get<any>('/api/admin/merchant-commission-policy/history'),
        api.get<any>('/api/admin/merchant-platform/leaderboard', { params: { days, limit: 25 } }),
      ]);
      if (polRes.data?.success) {
        setPolicy(polRes.data.policy);
        setVarieties(polRes.data.varieties || []);
        if (polRes.data.policy) {
          setForm(f => ({
            ...f,
            enabled: !!polRes.data.policy.enabled,
            minMatchedVolume: polRes.data.policy.minMatchedVolume ?? 0,
            rates: (polRes.data.policy.rates || []).map((r: Rate) => ({ ...r })),
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
  /**
   * Restore a previous commission-policy version.
   *
   * The history has been listed here since the page shipped and there was no
   * way to act on it: the endpoint existed, nothing called it, so undoing a bad
   * policy meant re-typing the old numbers from the list and hoping they were
   * read correctly. This restores the version as a NEW one — the trail is
   * append-only, so a rollback is another entry rather than an erasure.
   *
   * Confirmed first: the policy decides what merchants are paid.
   */
  const rollback = async (h: any) => {
    if (!window.confirm(`Restore v${h.version} as the live merchant commission policy?\n\nThis is recorded as a new version, not an edit.`)) return;
    setRollingBack(h._id);
    try {
      await api.post(`/api/admin/merchant-commission-policy/version/${h._id}/rollback`, {});
      toast.success(`Restored v${h.version}`);
      load();
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Rollback failed');
    } finally { setRollingBack(null); }
  };

  /** Price a variety that is not priced yet. */
  const addRate = (v: Variety) => setForm(f => ({
    ...f,
    rates: [...f.rates, {
      currency: v.currency, paymentMode: v.paymentMode,
      denominationPaise: v.denominationPaise, buyPercent: 0, sellPercent: 0,
    }],
  }));

  /** Stop pricing a variety. Absence is how a variety goes unpriced — it then
   *  earns nothing and the engine reports it as unpriced, which is different
   *  from a rate of zero. */
  const removeRate = (id: string) => setForm(f => ({
    ...f, rates: f.rates.filter(r => varietyId(r) !== id),
  }));

  const setLeg = (id: string, leg: 'buyPercent' | 'sellPercent', value: number) => setForm(f => ({
    ...f,
    rates: f.rates.map(r => (varietyId(r) === id ? { ...r, [leg]: value } : r)),
  }));

  const savePolicy = async () => {
    if (!form.justification.trim()) return toast.error('Business justification required');
    setSaving(true);
    try {
      const res = await api.put<any>('/api/admin/merchant-commission-policy', {
        enabled: form.enabled,
        minMatchedVolume: Number(form.minMatchedVolume),
        rates: form.rates.map(r => ({
          currency: r.currency,
          paymentMode: r.paymentMode,
          denominationPaise: r.denominationPaise,
          buyPercent: Number(r.buyPercent),
          sellPercent: Number(r.sellPercent),
        })),
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
      const res = await api.post<any>('/api/admin/merchant-platform/commission-engine/run');
      if (res.data?.success) {
        if (res.data.ran === false) {
          toast(res.data.reason || 'Engine idle — no enabled policy.');
        } else {
          const results = res.data.results || [];
          const issued = results.filter((r: any) => r.issued).length;
          // A skipped variety is the answer to "why was nobody paid?", so it is
          // surfaced rather than folded into a count of what was evaluated.
          const unpriced = results.filter((r: any) => !r.issued && /No rate is set/i.test(r.reason || '')).length;
          toast.success(
            `Engine ran (policy v${res.data.policyVersion}): ${issued} paid, ${results.length} variety-merchant pair(s) evaluated`
            + (unpriced ? ` — ${unpriced} unpriced` : ''),
          );
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
    <div className="om-fade space-y-6">
      <Toolbar actions={[
        ...(isAdmin ? [{ label: running ? 'Running…' : 'Run Commission Engine', icon: Play, primary: true, onClick: runEngine } as ToolbarAction] : []),
        { label: 'Refresh', icon: RefreshCw, onClick: load },
      ]} />

      {isAdmin && (
        <div className="card border border-gold-500/30">
          <h3 className="text-lg font-semibold mb-1">Merchant Commission Policy</h3>
          <p className="text-xs text-gray-400 mb-3">
            Pays merchants a % of NEWLY matched buy→sell cycle volume, from the platform-funded
            pool only, at a rate that depends on the KIND of work. {policy
              ? `Active: v${policy.version} — ${policy.enabled ? `ON, ${policy.rates?.length ?? 0} variety(ies) priced` : 'disabled'}.`
              : 'Not configured yet — the engine is idle.'}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="flex items-center justify-between md:flex-col md:items-start gap-2">
              <p className="font-medium text-sm">Enabled</p>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" checked={form.enabled}
                  onChange={e => setForm({ ...form, enabled: e.target.checked })} className="sr-only peer" />
                <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
              </label>
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

          {/* ── The rates, per variety ───────────────────────────────────────
              Buy and sell are the two LEGS of the same matched volume — the
              merchant took it in and paid it out — so the engine adds them.
              Both legs are shown because a rail can be harder to serve in one
              direction than the other, which is the ordinary case on the cash
              rail where a payout means standing at a machine. */}
          <div className="mt-4">
            <p className="font-medium text-sm mb-1">Rates by variety</p>
            <p className="text-xs text-gray-500 mb-2">
              Buy % + sell % are added and applied to newly matched volume in that variety.
              A variety with no row here earns <span className="text-gold-400/90">nothing</span> and is
              reported as unpriced — that is not the same as a rate of 0%.
            </p>
            {form.rates.length === 0 && (
              <p className="text-xs text-gray-500 py-2">Nothing priced yet — merchants earn nothing until a variety is added below.</p>
            )}
            <div className="space-y-1">
              {form.rates.map(r => {
                const id = varietyId(r);
                const label = varieties.find(v => varietyId(v) === id)?.label ?? id;
                const total = (Number(r.buyPercent) || 0) + (Number(r.sellPercent) || 0);
                return (
                  <div key={id} className="flex flex-wrap items-center gap-2 bg-dark-800/60 rounded-md px-2 py-1.5">
                    <span className="text-xs text-gray-300 flex-1 min-w-[180px]">{label}</span>
                    <label className="text-[11px] text-gray-500">buy
                      <input type="number" min={0} max={100} step={0.01}
                        className="input ml-1 w-20 py-1 text-xs"
                        value={r.buyPercent}
                        onChange={e => setLeg(id, 'buyPercent', Number(e.target.value))} />
                    </label>
                    <label className="text-[11px] text-gray-500">sell
                      <input type="number" min={0} max={100} step={0.01}
                        className="input ml-1 w-20 py-1 text-xs"
                        value={r.sellPercent}
                        onChange={e => setLeg(id, 'sellPercent', Number(e.target.value))} />
                    </label>
                    <span className="text-[11px] font-mono text-gold-400/90 w-28 text-right">
                      {total}% → {inr((100000 * total) / 100)} per ₹1,00,000
                    </span>
                    <button onClick={() => removeRate(id)} title="Stop pricing this variety"
                      className="text-gray-500 hover:text-red-400 shrink-0">
                      <X size={14} />
                    </button>
                  </div>
                );
              })}
            </div>

            {varieties.filter(v => !form.rates.some(r => varietyId(r) === varietyId(v))).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {varieties
                  .filter(v => !form.rates.some(r => varietyId(r) === varietyId(v)))
                  .map(v => (
                    <button key={varietyId(v)} onClick={() => addRate(v)}
                      className="px-2 py-1 bg-dark-700 hover:bg-dark-600 rounded-md text-[11px] flex items-center gap-1">
                      <Plus size={11} />{v.label}
                    </button>
                  ))}
              </div>
            )}
          </div>

          <button onClick={savePolicy} disabled={saving} className="btn-primary mt-3 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save New Policy Version'}
          </button>
          {history.length > 0 && (
            <details className="mt-3">
              <summary className="text-xs text-gray-400 cursor-pointer">Version history ({history.length})</summary>
              <div className="mt-2 space-y-1 text-xs text-gray-500">
                {history.map((h: any) => (
                  <div key={h._id} className="flex items-center justify-between gap-3 py-1">
                    <p className="min-w-0">
                      v{h.version} · {h.enabled ? `ON, ${h.rates?.length ?? 0} priced` : 'disabled'} · min {inr(h.minMatchedVolume || 0)} ·{' '}
                      {h.status} · {new Date(h.createdAt).toLocaleString()}
                    </p>
                    {/* The live version is not offered as a rollback target —
                        restoring what is already active would add a version
                        that changes nothing and muddies the trail. */}
                    {h.status !== 'ACTIVE' && (
                      <button
                        onClick={() => rollback(h)}
                        disabled={rollingBack !== null}
                        className="shrink-0 px-2.5 py-1 bg-dark-700 hover:bg-dark-600 rounded-md text-[11px] font-semibold disabled:opacity-50 flex items-center gap-1"
                      >
                        <RotateCcw size={11} />{rollingBack === h._id ? 'Restoring…' : 'Restore'}
                      </button>
                    )}
                  </div>
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
