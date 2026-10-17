// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Where the token supply is — the top of Admin › Token Flow (owner,
 * 2026-10-17: "show the total 20 billion pool, then who holds how much").
 *
 * Totals by kind of holder come from `GET /api/admin/analytics/token-supply`
 * (analytics area). The holder-by-holder table names players and their
 * balances, so it comes from `GET /api/admin/analytics/token-holders`, which
 * asks the players area (canManageUsers), and is offered only to an account
 * that holds it. Both read `tokenHolders` (database/repositories), which keeps
 * no figure of its own; the CSV is the same rows from the server.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Coins, Download } from 'lucide-react';
import { Link } from 'react-router';
import toast from 'react-hot-toast';
import api, { downloadCsv, cleanParams } from '../../services/api';
import { usePermissions } from '../../hooks/usePermission';
import { useDebounce } from '../../hooks/useDebounce';

/** Mirrors HOLDER_KINDS (database/repositories/tokenHolders.js), labels only (§11). */
const KIND_LABEL: Record<string, string> = {
  PLATFORM: 'Platform holding (admin)',
  PLATFORM_ACCOUNT: 'Platform accounts (house reserve, bonus pools)',
  TEAM: 'Agent teams (supervisor + members)',
  MERCHANT_ACCOUNT: 'Merchant accounts',
  PLAYER: 'Players',
  MERCHANT_WALLET: 'Merchant wallets',
  STAFF_WALLET: 'Staff wallets',
};

interface KindTotal { kind: string; holders: number; tokens: number; held: number; sharePercent: number }
interface Holder {
  kind: string; holderId: string; name: string; owner: string | null;
  tokens: number; held: number; members: number | null; sharePercent: number;
}

const tokens = (n: number) => Math.round(n).toLocaleString('en-IN');
const pct = (n: number) => `${n < 0.01 && n > 0 ? '<0.01' : n.toFixed(2)}%`;

export const TokenSupplyPanel: React.FC = () => {
  const canSeeHolders = usePermissions().can('canManageUsers');
  const [supply, setSupply] = useState<{ supply: number; accountedFor: boolean; kinds: KindTotal[] } | null>(null);
  const [holders, setHolders] = useState<Holder[]>([]);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search.trim(), 400);
  const limit = 50;

  useEffect(() => {
    api.get<any>('/api/admin/analytics/token-supply')
      .then((r) => { if (r?.data?.success && Array.isArray(r.data.kinds)) setSupply(r.data); })
      .catch(() => toast.error('Token supply failed to load'));
  }, []);

  const loadHolders = useCallback(async () => {
    if (!canSeeHolders) return;
    try {
      const r = await api.get<any>('/api/admin/analytics/token-holders', {
        params: cleanParams({ kind, search: debounced, page, limit }),
      });
      if (r?.data?.success) { setHolders(r.data.holders); setTotal(r.data.total); }
    } catch {
      toast.error('Token holders failed to load');
    }
  }, [canSeeHolders, kind, debounced, page]);

  useEffect(() => { loadHolders(); }, [loadHolders]);
  useEffect(() => { setPage(1); }, [kind, debounced]);

  const exportCsv = async () => {
    try {
      await downloadCsv('/api/admin/analytics/token-holders.csv', cleanParams({ kind, search: debounced }), 'token-holders.csv');
    } catch {
      toast.error('Export failed');
    }
  };

  if (!supply) return null;
  const pages = Math.max(Math.ceil(total / limit), 1);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2"><Coins size={18} className="text-gold-400" />Token supply</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Every token that exists, and who holds it. A token is always in exactly one place, so the rows add up to the supply.
        </p>
      </div>

      <div className="bg-dark-800 rounded-xl p-4 border border-dark-700 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-xs text-gray-400">Total supply</p>
          <p className="text-3xl font-bold text-gold-400">{tokens(supply.supply)} tokens</p>
        </div>
        <p className={`text-sm ${supply.accountedFor ? 'text-green-400' : 'text-red-400'}`} role="status">
          {supply.accountedFor ? 'Every token accounted for' : 'Holders do not add up to the supply: check the ledger'}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-dark-600">
              <th className="pb-2 font-medium">Held by</th>
              <th className="pb-2 font-medium text-right">Holders</th>
              <th className="pb-2 font-medium text-right">Tokens</th>
              <th className="pb-2 font-medium text-right">In open orders / bets</th>
              <th className="pb-2 font-medium text-right">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-dark-700">
            {supply.kinds.map((k) => (
              <tr key={k.kind}>
                <td className="py-2">
                  {canSeeHolders
                    ? <button type="button" className="text-left hover:underline" onClick={() => setKind(k.kind)}>{KIND_LABEL[k.kind] ?? k.kind}</button>
                    : (KIND_LABEL[k.kind] ?? k.kind)}
                </td>
                <td className="py-2 text-right text-gray-400">{k.holders.toLocaleString('en-IN')}</td>
                <td className="py-2 text-right font-medium">{tokens(k.tokens)}</td>
                <td className="py-2 text-right text-gray-400">{tokens(k.held)}</td>
                <td className="py-2 text-right">{pct(k.sharePercent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canSeeHolders && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label text-xs" htmlFor="holder-kind">Holder</label>
              <select id="holder-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="input text-sm">
                <option value="">Everyone</option>
                {supply.kinds.map((k) => <option key={k.kind} value={k.kind}>{KIND_LABEL[k.kind] ?? k.kind}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="label text-xs" htmlFor="holder-search">Search name or id</label>
              <input id="holder-search" value={search} onChange={(e) => setSearch(e.target.value)} className="input text-sm w-full" />
            </div>
            <button type="button" onClick={exportCsv} className="btn-secondary text-sm flex items-center gap-1.5">
              <Download size={14} />Download CSV
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-dark-600">
                  <th className="pb-2 font-medium">Holder</th>
                  <th className="pb-2 font-medium">Kind</th>
                  <th className="pb-2 font-medium">Supervisor / owner</th>
                  <th className="pb-2 font-medium text-right">Tokens</th>
                  <th className="pb-2 font-medium text-right">In open orders / bets</th>
                  <th className="pb-2 font-medium text-right">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-700">
                {holders.length === 0 && (
                  <tr><td colSpan={6} className="py-4 text-center text-gray-500">No holders match.</td></tr>
                )}
                {holders.map((h) => (
                  <tr key={`${h.kind}:${h.holderId}`}>
                    <td className="py-2">
                      {/* A player opens their own page, as on Players. */}
                      {h.kind === 'PLAYER'
                        ? <Link to={`/users/${encodeURIComponent(h.holderId)}`} className="font-medium hover:underline">{h.name}</Link>
                        : <p className="font-medium">{h.name}</p>}
                      <p className="text-[11px] text-gray-500 font-mono">{h.holderId}</p>
                    </td>
                    <td className="py-2 text-gray-400 text-xs">{KIND_LABEL[h.kind] ?? h.kind}</td>
                    <td className="py-2 text-gray-400 text-xs">
                      {h.owner ?? '—'}{h.members != null ? ` · ${h.members} members` : ''}
                    </td>
                    <td className="py-2 text-right font-medium">{tokens(h.tokens)}</td>
                    <td className="py-2 text-right text-gray-400">{tokens(h.held)}</td>
                    <td className="py-2 text-right">{pct(h.sharePercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>{total.toLocaleString('en-IN')} holders · page {page} of {pages}</span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary text-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <button type="button" className="btn-secondary text-xs" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </div>
          <p className="text-xs text-gray-500">
            Agent team members hold no tokens of their own: their team pool holds them, and each member's commission share is a record of the pool's tokens, not a balance of their own.
          </p>
        </div>
      )}
    </div>
  );
};
