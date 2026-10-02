// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Supervisors and teams — the admin's half (redesign Step 2a, PROJECT_STATUS
 * §3.10). Area: canManageTeams.
 *
 * An admin does three things here:
 *   1. makes an approved merchant a SUPERVISOR on one rail (or removes the
 *      role from a supervisor who runs no teams);
 *   2. approves or rejects the members supervisors propose;
 *   3. removes a member from a team;
 *   4. sells tokens into a team's pool, or buys them back, when a supervisor
 *      asks — recording what was paid (Step 2b). That part is the money area
 *      canFundMerchants, so it is shown only to staff who hold it.
 *
 * Supervisors create their teams and propose members from the merchant panel.
 * Every cap (4 teams, 10 members, one team per merchant) is enforced by the
 * server inside the write; this screen shows the server's refusal verbatim,
 * because it names what to do next (§32 S14).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, UserCheck, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { EmptyState } from '../../components/EmptyState';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { usePermissions } from '../../hooks/usePermission';
import type { SupervisorRail, TeamMemberView, TeamPoolRequest, TeamSupervisor, TeamView } from '../../types';

/** Mirrors SUPERVISOR_RAILS in database/repositories/teams.js (§5). */
const RAILS: Array<{ value: SupervisorRail; label: string }> = [
  { value: 'CASH',     label: 'CASH — ATM cash link' },
  { value: 'UPI_BANK', label: 'UPI_BANK — UPI link or bank account' },
  { value: 'USDT',     label: 'USDT — buy only' },
];

const STRENGTH: Record<TeamView['strength'], { label: string; cls: string }> = {
  WORKING: { label: 'Working', cls: 'bg-green-500/20 text-green-400' },
  GRACE:   { label: 'Short — works until midnight IST', cls: 'bg-yellow-500/20 text-yellow-400' },
  STOPPED: { label: 'Not working — needs 10 members', cls: 'bg-red-500/20 text-red-400' },
};

const messageOf = (err: any, fallback: string) => err?.response?.data?.message || fallback;
const tokens = (paise: number) => (paise / 100).toLocaleString('en-IN');

/**
 * The pool request queue. Declared at module level, never inside the parent
 * (§32 S23). Each row takes what the platform received (a sale) or paid (a
 * buyback) — required, 0 meaning no money changed hands — because the server
 * refuses a fulfilment without it.
 */
const PoolRequests: React.FC<{ onChanged: () => void }> = ({ onChanged }) => {
  const [requests, setRequests] = useState<TeamPoolRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [amount, setAmount] = useState<Record<string, string>>({});
  const [currency, setCurrency] = useState<Record<string, 'INR' | 'USDT'>>({});
  const [reason, setReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRequests((await api.teams.poolRequests('PENDING')).requests || []);
    } catch (err) {
      toast.error(messageOf(err, 'Could not load pool requests'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<{ message?: string } | unknown>, ok: string, fail: string) => {
    setBusy(key);
    try {
      const out = await fn() as { message?: string } | undefined;
      toast.success(out?.message || ok);
      await load();
      onChanged();
    } catch (err) {
      toast.error(messageOf(err, fail));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
      <h2 className="text-base font-semibold mb-1">Team token requests</h2>
      <p className="text-xs text-gray-400 mb-3">
        A supervisor asks to buy tokens for a team's pool, or to sell them back. Fulfil only once
        the money has changed hands, and record how much.
      </p>
      {loading ? <LoadingSpinner /> : requests.length === 0 ? (
        <p className="text-sm text-gray-400">No requests waiting.</p>
      ) : (
        <ul className="space-y-3">
          {requests.map((r) => {
            const isBuy = r.direction === 'BUY';
            const cur = isBuy ? (currency[r.requestId] ?? 'INR') : 'INR';
            const typed = amount[r.requestId] ?? '';
            return (
              <li key={r.requestId} className="border border-dark-600 rounded-lg p-3">
                <div className="flex flex-wrap items-center gap-2 mb-2 text-sm">
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${isBuy ? 'bg-green-500/20 text-green-400' : 'bg-orange-500/20 text-orange-400'}`}>
                    {isBuy ? 'Buy tokens' : 'Sell back'}
                  </span>
                  <span className="font-medium">{tokens(r.tokenAmountPaise)} tokens</span>
                  <span className="text-gray-400">for {r.teamName ?? r.teamId}</span>
                  <span className="text-xs text-gray-500">by {r.supervisorName ?? r.supervisorId}</span>
                  {r.note && <span className="text-xs text-gray-400 italic">“{r.note}”</span>}
                </div>
                <div className="flex flex-wrap gap-2 items-end">
                  <div>
                    <label htmlFor={`pr-amt-${r.requestId}`} className="block text-xs text-gray-400 mb-1">
                      {isBuy ? 'Platform received' : 'Platform paid'}
                    </label>
                    <input id={`pr-amt-${r.requestId}`} inputMode="decimal" value={typed}
                      onChange={(e) => setAmount((a) => ({ ...a, [r.requestId]: e.target.value }))}
                      className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm w-36" />
                  </div>
                  <div>
                    <label htmlFor={`pr-cur-${r.requestId}`} className="block text-xs text-gray-400 mb-1">Currency</label>
                    <select id={`pr-cur-${r.requestId}`} value={cur} disabled={!isBuy}
                      onChange={(e) => setCurrency((c) => ({ ...c, [r.requestId]: e.target.value as 'INR' | 'USDT' }))}
                      className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm">
                      <option value="INR">INR</option>
                      {isBuy && <option value="USDT">USDT</option>}
                    </select>
                  </div>
                  <button disabled={!!busy || typed.trim() === ''}
                    onClick={() => void run(`f-${r.requestId}`,
                      () => api.teams.fulfilPoolRequest(r.requestId, { settlementCurrency: cur, settlementAmount: Number(typed) }),
                      'Fulfilled', 'Could not fulfil')}
                    className="px-3 py-1.5 rounded-lg bg-yellow-500 text-black text-sm font-semibold disabled:opacity-50">
                    {isBuy ? `Sell ${tokens(r.tokenAmountPaise)} tokens to ${r.teamName ?? 'team'}` : `Buy ${tokens(r.tokenAmountPaise)} tokens back from ${r.teamName ?? 'team'}`}
                  </button>
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

export const TeamsManager: React.FC = () => {
  const [supervisors, setSupervisors] = useState<TeamSupervisor[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [members, setMembers] = useState<TeamMemberView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [newId, setNewId] = useState('');
  const [newRail, setNewRail] = useState<SupervisorRail>('UPI_BANK');
  const canFund = usePermissions().can('canFundMerchants');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.teams.list();
      setSupervisors(res.supervisors || []);
      setTeams(res.teams || []);
      setMembers(res.members || []);
    } catch (err) {
      toast.error(messageOf(err, 'Could not load teams'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Run one action, show its outcome, and reload what the server now says. */
  const act = async (key: string, fn: () => Promise<unknown>, ok: string, fail: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      await load();
    } catch (err) {
      toast.error(messageOf(err, fail));
    } finally {
      setBusy('');
    }
  };

  const pending = useMemo(() => members.filter((m) => m.status === 'PENDING'), [members]);
  const teamName = (teamId: string) => teams.find((t) => t.teamId === teamId)?.name ?? teamId;

  return (
    <div className="space-y-5">
      {/* ── Make a supervisor ─────────────────────────────────────────── */}
      <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold">Make a merchant a supervisor</h2>
          <button onClick={() => void load()} className="p-1.5 rounded-lg hover:bg-dark-700" aria-label="Refresh">
            <RefreshCw size={15} className="text-gray-400" />
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          A supervisor runs up to 4 teams of exactly 10 members on ONE rail, and serves no orders
          itself. The merchant must already be approved and must not be in a team.
        </p>
        <form
          className="flex flex-wrap gap-2 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const id = newId.trim();
            if (!id) return;
            void act('make', () => api.teams.setSupervisor(id, newRail), 'Supervisor set', 'Could not set supervisor');
          }}
        >
          <div>
            <label htmlFor="sup-id" className="block text-xs text-gray-400 mb-1">Merchant ID</label>
            <input id="sup-id" value={newId} onChange={(e) => setNewId(e.target.value)}
              className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm w-64" />
          </div>
          <div>
            <label htmlFor="sup-rail" className="block text-xs text-gray-400 mb-1">Rail</label>
            <select id="sup-rail" value={newRail} onChange={(e) => setNewRail(e.target.value as SupervisorRail)}
              className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-sm">
              {RAILS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <button type="submit" disabled={!newId.trim() || busy === 'make'}
            className="px-3 py-1.5 rounded-lg bg-yellow-500 text-black text-sm font-semibold disabled:opacity-50">
            Make supervisor
          </button>
        </form>
      </div>

      {canFund && <PoolRequests onChanged={() => void load()} />}

      {/* ── Waiting for approval ──────────────────────────────────────── */}
      <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
        <h2 className="text-base font-semibold mb-3">Members waiting for approval</h2>
        {loading ? <LoadingSpinner /> : pending.length === 0 ? (
          <p className="text-sm text-gray-400">Nobody is waiting.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b border-dark-600">
                <th className="py-2 pr-3 font-medium">Merchant</th>
                <th className="py-2 pr-3 font-medium">Team</th>
                <th className="py-2 font-medium text-right">Decision</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((m) => (
                <tr key={m.merchantId} className="border-b border-dark-700 last:border-0">
                  <td className="py-2.5 pr-3">{m.name} <span className="text-xs text-gray-500">{m.publicRef}</span></td>
                  <td className="py-2.5 pr-3 text-gray-300">{teamName(m.teamId)}</td>
                  <td className="py-2.5 text-right space-x-2">
                    <button disabled={!!busy}
                      onClick={() => void act(`ap-${m.merchantId}`, () => api.teams.approveMember(m.merchantId), `${m.name} approved`, 'Could not approve')}
                      className="text-xs px-2.5 py-1 rounded-lg bg-green-500/20 text-green-400 disabled:opacity-50">
                      Approve {m.name}
                    </button>
                    <button disabled={!!busy}
                      onClick={() => void act(`rj-${m.merchantId}`, () => api.teams.rejectMember(m.merchantId), `${m.name} rejected`, 'Could not reject')}
                      className="text-xs px-2.5 py-1 rounded-lg bg-red-500/20 text-red-400 disabled:opacity-50">
                      Reject {m.name}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Supervisors and their teams ───────────────────────────────── */}
      {loading ? null : supervisors.length === 0 ? (
        <EmptyState icon={Users} title="No supervisors yet"
          description="Make an approved merchant a supervisor above. They then create their teams from the merchant panel." />
      ) : supervisors.map((s) => {
        const own = teams.filter((t) => t.supervisorId === s.merchantId);
        return (
          <div key={s.merchantId} className="bg-dark-800 border border-dark-600 rounded-xl p-4">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <div className="flex items-center gap-2">
                <UserCheck size={16} className="text-yellow-500" />
                <h2 className="text-base font-semibold">{s.name}</h2>
                <span className="text-xs text-gray-500">{s.publicRef}</span>
                <span className="text-xs px-2 py-0.5 rounded-lg bg-dark-700 text-gray-300">{s.rail}</span>
              </div>
              {own.length === 0 && (
                <button disabled={!!busy}
                  onClick={() => void act(`rm-${s.merchantId}`, () => api.teams.setSupervisor(s.merchantId, null), 'Supervisor role removed', 'Could not remove the role')}
                  className="text-xs px-2.5 py-1 rounded-lg bg-dark-700 text-red-400 disabled:opacity-50">
                  Remove supervisor role
                </button>
              )}
            </div>
            {own.length === 0 ? (
              <p className="text-sm text-gray-400">No teams yet — the supervisor creates them from the merchant panel.</p>
            ) : own.map((t) => (
              <div key={t.teamId} className="border border-dark-600 rounded-lg p-3 mb-2 last:mb-0">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-xs text-gray-400">{t.approvedCount}/{t.size} members{t.pendingCount ? ` · ${t.pendingCount} pending` : ''}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${STRENGTH[t.strength].cls}`}>{STRENGTH[t.strength].label}</span>
                  <span className="text-xs text-gray-400">
                    Pool: {tokens(t.poolAvailablePaise)} tokens{t.poolHeldPaise ? ` · ${tokens(t.poolHeldPaise)} held` : ''}
                  </span>
                </div>
                <ul className="text-sm space-y-1">
                  {members.filter((m) => m.teamId === t.teamId && m.status === 'APPROVED').map((m) => (
                    <li key={m.merchantId} className="flex items-center justify-between">
                      <span>{m.name} <span className="text-xs text-gray-500">{m.publicRef}</span></span>
                      <button disabled={!!busy}
                        onClick={() => void act(`del-${m.merchantId}`, () => api.teams.removeMember(m.merchantId), `${m.name} removed`, 'Could not remove')}
                        className="text-xs px-2 py-0.5 rounded-lg bg-dark-700 text-red-400 disabled:opacity-50">
                        Remove {m.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};
