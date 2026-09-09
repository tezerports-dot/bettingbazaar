// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * OperationsOverview.tsx — the Operations Platform console (Phase 012 APIs,
 * UI shipped Phase C 2026-07-10). Orchestration-only: every number is read
 * live from its owning platform; the config catalog is the index of every
 * configurable business value and where to edit it.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Activity, BookOpenCheck, Radio, Megaphone, Trophy } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { Toolbar } from '../../components/design';

const inr = (n: number) =>
  '₹' + (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

type Tab = 'overview' | 'catalog' | 'audit' | 'channels';

export const OperationsOverview: React.FC = () => {
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<any>(null);
  const [catalog, setCatalog] = useState<Array<{ value: string; owner: string; edit: string }>>([]);
  const [auditFeed, setAuditFeed] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Which ways of reaching a human are actually configured, and what admins
  // have been doing. Both endpoints existed with no screen calling them.
  const [channels, setChannels] = useState<Array<{ code: string; label: string; active: boolean }>>([]);
  const [adminActivity, setAdminActivity] = useState<any[]>([]);
  const [rebuilding, setRebuilding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ovRes, catRes, auditRes, chanRes, actRes] = await Promise.all([
        api.get<any>('/api/admin/operations/overview'),
        api.get<any>('/api/admin/operations/config-catalog'),
        api.get<any>('/api/admin/communication/audit-feed', { params: { limit: 50 } }).catch(() => ({ data: null })),
        api.get<any>('/api/admin/communication/channels').catch(() => ({ data: null })),
        api.get<any>('/api/admin/communication/admin-activity', { params: { hours: 24 } }).catch(() => ({ data: null })),
      ]);
      if (ovRes.data?.success) setOverview(ovRes.data.overview);
      if (catRes.data?.success) setCatalog(catRes.data.catalog || []);
      if (auditRes.data?.success) setAuditFeed(auditRes.data.feed || auditRes.data.entries || auditRes.data.logs || []);
      if (chanRes.data?.success) setChannels(chanRes.data.channels || []);
      if (actRes.data?.success) setAdminActivity(actRes.data.activity || []);
    } catch {
      toast.error('Failed to load operations data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Rebuild the leaderboard the player panel reads.
   *
   * A maintenance action, not a routine one: the board is derived, so this only
   * matters after a correction or a backfill. Confirmed before firing because
   * it recomputes every period.
   */
  const rebuildLeaderboard = async () => {
    if (!window.confirm('Recompute every leaderboard period from the underlying rows?')) return;
    setRebuilding(true);
    try {
      const r = await api.post<any>('/api/leaderboard/rebuild', {});
      toast.success(`Leaderboard rebuilt — ${r.data?.periods ?? 0} period(s)`);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Rebuild failed');
    } finally { setRebuilding(false); }
  };

  const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="card">
      <p className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">{title}</p>
      {children}
    </div>
  );

  const KV: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
    <div className="flex justify-between gap-4 py-1 border-b border-dark-800 last:border-0 text-sm">
      <span className="text-gray-400">{k}</span>
      <span className="text-gray-100 font-medium text-right">{v}</span>
    </div>
  );

  return (
    <div className="om-fade space-y-6">
      <Toolbar
        tabs={[
          { label: 'Overview', active: tab === 'overview', onClick: () => setTab('overview') },
          { label: 'Config Catalog', active: tab === 'catalog', onClick: () => setTab('catalog') },
          { label: 'Audit Feed', active: tab === 'audit', onClick: () => setTab('audit') },
          { label: 'Channels & Activity', active: tab === 'channels', onClick: () => setTab('channels') },
        ]}
        actions={[{ label: 'Refresh', icon: RefreshCw, onClick: load }]}
      />

      {tab === 'overview' && overview && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <Section title="Settlement — Revenue & Settlement Platform">
            <KV k="Ledger integrity" v={overview.settlement.ledgerIntegrityOk
              ? <span className="text-green-400">OK — conserves to zero</span>
              : <span className="text-red-400">BROKEN</span>} />
            <KV k="Platform revenue" v={inr(overview.settlement.platformRevenue)} />
            <KV k="Distributable revenue" v={inr(overview.settlement.distributableRevenue)} />
            <KV k="Payout fees collected" v={inr(overview.settlement.payoutFees)} />
          </Section>

          <Section title="Treasury — derived account balances">
            <KV k="External fiat (net in)" v={inr(overview.treasury.externalFiat)} />
            <KV k="User funds liability" v={inr(overview.treasury.userFundsLiability)} />
            <KV k="Platform reserve" v={inr(overview.treasury.platformReserve)} />
            <KV k="Merchant bonus pool" v={inr(overview.treasury.merchantBonusPool)} />
            <KV k="Merchant funds liability" v={inr(overview.treasury.merchantFundsLiability)} />
          </Section>

          <Section title="Funding Platform">
            <KV k="Open orders" v={overview.funding.openOrders} />
            <KV k="Disputed orders" v={overview.funding.disputedOrders} />
            {(overview.funding.providers || []).map((p: any) => (
              <KV key={p.key || p.name} k={p.key || p.name}
                v={<span className={p.active ? 'text-green-400' : 'text-gray-500'}>{p.active ? 'LIVE' : 'declared'}</span>} />
            ))}
          </Section>

          <Section title="Risk Platform — active rules">
            <KV k="Multiples of 10" v={overview.risk.enforceMultiplesOf10 ? 'ON' : 'off'} />
            <KV k="Opposite-side block" v={overview.risk.blockOppositeSideBetting ? 'ON' : 'off'} />
            <KV k="Funding velocity/hour" v={overview.risk.maxFundingOrdersPerHour || 'off'} />
            <KV k="Bet reserve %" v={`${overview.risk.betReservePercent ?? 1}%`} />
            <KV k="Winnings fee %" v={`${overview.risk.winningsFeePercent ?? 1}%`} />
            <KV k="Payout fee %" v={`${overview.risk.payoutFeePercent ?? 0}%`} />
          </Section>

          <Section title="Business Policies">
            <KV k="Deposit policy" v={overview.policies.depositPolicy
              ? `v${overview.policies.depositPolicy.version} — ${overview.policies.depositPolicy.deposit}/${overview.policies.depositPolicy.reserve}`
              : 'not configured (90/10 fallback)'} />
            <KV k="Merchant commission policy" v={overview.policies.merchantCommissionPolicy
              ? `v${overview.policies.merchantCommissionPolicy.version} — ${overview.policies.merchantCommissionPolicy.enabled
                  ? `ON, ${overview.policies.merchantCommissionPolicy.pricedVarieties} variety(ies) priced`
                  : 'disabled'}`
              : 'not configured'} />
          </Section>

          <Section title="Communication & Product Flags">
            {(overview.communication.channels || []).map((c: any) => (
              <KV key={c.key || c.channel} k={c.key || c.channel}
                v={<span className={c.active ? 'text-green-400' : 'text-gray-500'}>{c.active ? 'LIVE' : 'declared'}</span>} />
            ))}
            {Object.entries(overview.productFlags || {}).map(([f, on]) => (
              <KV key={f} k={f} v={on ? <span className="text-green-400">ON</span> : 'off'} />
            ))}
          </Section>
        </div>
      )}

      {tab === 'catalog' && (
        <div className="card">
          <p className="text-xs text-gray-400 mb-3">
            The enforcement index for "no hardcoded business values": if a value isn't in this
            catalog, it isn't configurable and must not exist as a code constant.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-dark-700">
                  <th className="py-2 pr-3">Business value</th>
                  <th className="py-2 pr-3">Owning authority</th>
                  <th className="py-2">Edit via</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((c, i) => (
                  <tr key={i} className="border-b border-dark-800">
                    <td className="py-2 pr-3 text-gray-200">{c.value}</td>
                    <td className="py-2 pr-3 text-gray-400">{c.owner}</td>
                    <td className="py-2 font-mono text-xs text-gold-400/90">{c.edit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="card">
          <p className="text-xs text-gray-400 mb-3">
            Latest audited actions across the platform (read-only projection over the audit log).
          </p>
          <div className="space-y-2">
            {auditFeed.map((a: any, i: number) => (
              <div key={a._id || i} className="border-b border-dark-800 pb-2 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="font-medium text-gray-200">{a.action || a.type}</span>
                  <span className="text-xs text-gray-500 whitespace-nowrap">
                    {new Date(a.createdAt || a.timestamp || Date.now()).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-gray-500">
                  {a.performedByName || a.actor || 'system'}{a.category ? ` · ${a.category}` : ''}
                  {a.targetType ? ` · ${a.targetType} ${a.targetId ?? ''}` : ''}
                </p>
              </div>
            ))}
            {auditFeed.length === 0 && <p className="text-gray-500 text-sm py-4 text-center">No audit entries.</p>}
          </div>
        </div>
      )}

      {tab === 'channels' && (
        <div className="space-y-6">
          <Section title="Ways of reaching a player">
            <p className="text-xs text-gray-400 mb-3">
              Every channel is an adapter behind one interface. A declared channel that is not active
              has no provider configured — sending to it fails, it does not silently do nothing.
            </p>
            <div className="space-y-2">
              {channels.map((c) => (
                <div key={c.code} className="flex items-center justify-between border-b border-dark-800 pb-2 last:border-0">
                  <div className="flex items-center gap-2 text-sm">
                    <Megaphone size={14} className={c.active ? 'text-green-400' : 'text-gray-600'} />
                    <span className="text-gray-200 font-medium">{c.label}</span>
                    <span className="text-xs text-gray-500 font-mono">{c.code}</span>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${c.active ? 'bg-green-500/20 text-green-300' : 'bg-dark-700 text-gray-400'}`}>
                    {c.active ? 'Active' : 'Not configured'}
                  </span>
                </div>
              ))}
              {channels.length === 0 && <p className="text-gray-500 text-sm py-4 text-center">No channels reported.</p>}
            </div>
          </Section>

          <Section title="Admin activity — last 24 hours">
            <div className="space-y-2">
              {adminActivity.map((a: any, i: number) => (
                <div key={a.performedBy ?? i} className="flex justify-between gap-4 border-b border-dark-800 pb-2 last:border-0 text-sm">
                  <span className="text-gray-200">{a.performedByName || a.performedBy || 'unknown'}</span>
                  <span className="text-gray-400">{a.actions ?? a.count ?? 0} action(s)</span>
                </div>
              ))}
              {adminActivity.length === 0 && <p className="text-gray-500 text-sm py-4 text-center">No admin actions in the window.</p>}
            </div>
          </Section>

          <Section title="Maintenance">
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-gray-400">
                The leaderboard is derived from bet rows. Rebuild it after a correction or a backfill —
                it is not part of normal operation.
              </p>
              <button onClick={rebuildLeaderboard} disabled={rebuilding}
                className="btn-secondary text-sm flex items-center gap-1.5 shrink-0 disabled:opacity-50">
                <Trophy size={14} />{rebuilding ? 'Rebuilding…' : 'Rebuild leaderboard'}
              </button>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
};
