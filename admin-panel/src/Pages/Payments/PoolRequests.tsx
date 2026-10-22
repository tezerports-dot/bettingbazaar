// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Pool token requests, for one kind of team (AGENT: a supervisor's team;
 * DIRECT: a merchant's own pool). Fulfilling or rejecting is the money area
 * `canFundMerchants` (team.admin.routes.js POOL_AREA); Payments shows this only
 * to staff who hold it. Moved here from Supervisors & Teams (owner, 2026-10-14:
 * every payment in one place).
 */
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import type { TeamPoolRequest } from '../../types';

const messageOf = (err: any, fallback: string) => err?.response?.data?.message || fallback;
const tokens = (paise: number) => (paise / 100).toLocaleString('en-IN');

/**
 * The pool request queue. Declared at module level, never inside the parent
 * (§32 S23). Each row takes what the platform received (a sale) or paid (a
 * buyback) — required, 0 meaning no money changed hands — because the server
 * refuses a fulfilment without it.
 */
export const PoolRequests: React.FC<{ kind: TeamPoolRequest['teamKind']; onChanged?: () => void }> = ({ kind, onChanged }) => {
  const [requests, setRequests] = useState<TeamPoolRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [amount, setAmount] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState<Record<string, 'INR' | 'USDT'>>({});
  const [reason, setReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // One queue on the server; each side of the Payments switch shows its own
      // kind of team, by the kind the server stamps on the request.
      const all: TeamPoolRequest[] = (await api.teams.poolRequests('PENDING')).requests || [];
      setRequests(all.filter((r) => r.teamKind === kind));
    } catch (err) {
      toast.error(messageOf(err, 'Could not load pool requests'));
    } finally {
      setLoading(false);
    }
  }, [kind]);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<{ message?: string } | unknown>, ok: string, fail: string) => {
    setBusy(key);
    try {
      const out = await fn() as { message?: string } | undefined;
      toast.success(out?.message || ok);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(messageOf(err, fail));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
      <h2 className="text-base font-semibold mb-1">Pool token requests</h2>
      <p className="text-xs text-gray-400 mb-3">
        {kind === 'DIRECT'
          ? 'A merchant asks to buy tokens for its own pool.'
          : 'A supervisor asks to buy tokens for an agents\' team pool.'}
        {' '}Tokens are never bought back from a pool.
        {' '}Fulfil only once the money has changed hands, and record how much.
      </p>
      {loading ? <LoadingSpinner /> : requests.length === 0 ? (
        <p className="text-sm text-gray-400">No requests waiting.</p>
      ) : (
        <ul className="space-y-3">
          {requests.map((r) => {
            // A buyback asked before they were removed (owner, 2026-10-21) can
            // only be rejected: the server never fulfils one.
            const isBuy = r.direction === 'BUY';
            const cur = currency[r.requestId] ?? 'INR';
            const typed = amount[r.requestId] ?? '';
            return (
              <li key={r.requestId} className="border border-dark-600 rounded-lg p-3">
                <div className="flex flex-wrap items-center gap-2 mb-2 text-sm">
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${isBuy ? 'bg-green-500/20 text-green-400' : 'bg-orange-500/20 text-orange-400'}`}>
                    {isBuy ? 'Buy tokens' : 'Sell back (no longer allowed: reject it)'}
                  </span>
                  <span className="font-medium">{tokens(r.tokenAmountPaise)} tokens</span>
                  <span className="text-gray-400">for {r.teamName ?? r.teamId}</span>
                  <span className="text-xs text-gray-500">by {r.supervisorName ?? r.supervisorId}</span>
                  {r.note && <span className="text-xs text-gray-400 italic">“{r.note}”</span>}
                </div>
                <div className="flex flex-wrap gap-2 items-end">
                  {isBuy && (<>
                  <div>
                    <label htmlFor={`pr-amt-${r.requestId}`} className="block text-xs text-gray-400 mb-1">
                      Platform received
                    </label>
                    <input id={`pr-amt-${r.requestId}`} inputMode="decimal" value={typed}
                      onChange={(e) => setAmount((a) => ({ ...a, [r.requestId]: e.target.value }))}
                      className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm w-36" />
                  </div>
                  <div>
                    <label htmlFor={`pr-cur-${r.requestId}`} className="block text-xs text-gray-400 mb-1">Currency</label>
                    <select id={`pr-cur-${r.requestId}`} value={cur}
                      onChange={(e) => setCurrency((c) => ({ ...c, [r.requestId]: e.target.value as 'INR' | 'USDT' }))}
                      className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm">
                      <option value="INR">INR</option>
                      <option value="USDT">USDT</option>
                    </select>
                  </div>
                  <button disabled={!!busy || typed.trim() === ''}
                    onClick={() => void run(`f-${r.requestId}`,
                      () => api.teams.fulfilPoolRequest(r.requestId, { settlementCurrency: cur, settlementAmount: Number(typed) }),
                      'Fulfilled', 'Could not fulfil')}
                    className="px-3 py-1.5 rounded-lg bg-yellow-500 text-black text-sm font-semibold disabled:opacity-50">
                    {`Sell ${tokens(r.tokenAmountPaise)} tokens to ${r.teamName ?? 'team'}`}
                  </button>
                  </>)}
                  <div>
                    <label htmlFor={`pr-why-${r.requestId}`} className="block text-xs text-gray-400 mb-1">Reason (if rejecting)</label>
                    <input id={`pr-why-${r.requestId}`} value={reason[r.requestId] ?? ''}
                      onChange={(e) => setReason((a) => ({ ...a, [r.requestId]: e.target.value }))}
                      className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm w-48" />
                  </div>
                  <button disabled={!!busy}
                    onClick={() => void run(`r-${r.requestId}`,
                      () => api.teams.rejectPoolRequest(r.requestId, reason[r.requestId] ?? ''),
                      'Request rejected', 'Could not reject')}
                    className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-400 text-sm disabled:opacity-50">
                    Reject request from {r.teamName ?? r.teamId}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
