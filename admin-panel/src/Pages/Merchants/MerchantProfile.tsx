// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// One merchant's page (owner, 2026-10-14): an agent, a supervisor or a
// merchant account, with what they processed, the pool they work from, their
// commission, and every control on the page itself. No pop-ups: a control that
// needs a reason asks for it beside the button.
//
// Controls by area: approval, suspension, assignment pause, payment details
// and "make merchant account" are canManageMerchants (this screen's area);
// the supervisor role and routing priority are canManageTeams. The choices a
// control offers (priority bounds, supervisor rails) come with the profile
// (`choices`), so this page keeps no copy.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import { DisputeRecordBadge } from '../../components/DisputeRecordBadge';
import { Kpis } from '../../components/design';
import { formatters } from '../../utils/formatters';
import { usePermissions } from '../../hooks/usePermission';
import api from '../../services/api';
import type { MerchantProfile as MerchantProfileData, MerchantRow, SupervisorRail } from '../../types';
import { ROLE_LABEL } from './merchantLabels';
import toast from 'react-hot-toast';

interface Choices { routingPriority: { MIN: number; MAX: number; DEFAULT: number }; supervisorRails: SupervisorRail[] }

/** UI names for the server's supervisor rails (teams.js SUPERVISOR_RAILS). §11. */
const RAIL_LABEL: Record<string, string> = { CASH: 'Cash (ATM QR)', UPI_BANK: 'UPI / bank' };

const errorOf = (e: any, fallback: string) => e?.response?.data?.message || fallback;

const Section: React.FC<{ title: string; sub?: string; children: React.ReactNode }> = ({ title, sub, children }) => (
  <section className="card p-4 space-y-3">
    <div>
      <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
    {children}
  </section>
);

export const MerchantProfile: React.FC = () => {
  const { merchantId = '' } = useParams();
  const { can } = usePermissions();
  const canTeams = can('canManageTeams');
  const [merchant, setMerchant] = useState<MerchantProfileData | null>(null);
  const [summary, setSummary] = useState<MerchantRow | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');
  const [actionProblem, setActionProblem] = useState('');

  const [rejectReason, setRejectReason] = useState('');
  const [suspendReason, setSuspendReason] = useState('');
  const [resumeChecked, setResumeChecked] = useState(false);
  const [supervisorRail, setSupervisorRail] = useState<SupervisorRail | ''>('');
  const [priority, setPriority] = useState<number | ''>('');
  const [orders, setOrders] = useState<any[] | null>(null);
  const [volume, setVolume] = useState<any>(null);

  // Where the merchant panel is, from the server: its own host when
  // MERCHANT_HOST is set, else /merchant/ on this origin.
  const [merchantPanelUrl, setMerchantPanelUrl] = useState('');

  const load = useCallback(async () => {
    setProblem('');
    try {
      const res: any = await api.merchants.getProfile(merchantId);
      const data = res?.data || res?.merchant;
      if (!data) { setProblem(res?.message || 'Could not load this merchant.'); return; }
      setMerchant(data);
      setSummary(res.summary ?? null);
      setChoices(res.choices ?? null);
      setMerchantPanelUrl(res.merchantPanelUrl ?? '');
      setPriority(res.summary?.routingPriority ?? '');
      setSupervisorRail((res.summary?.role === 'SUPERVISOR' ? res.summary?.rail : '') ?? '');
    } catch (e: any) { setProblem(errorOf(e, 'Could not load this merchant.')); }
  }, [merchantId]);

  useEffect(() => { void load(); }, [load]);

  const loadActivity = useCallback(async () => {
    try {
      const [o, v] = await Promise.all([api.merchants.getOrders(merchantId), api.merchants.getEarnings(merchantId)]);
      setOrders(o?.success && Array.isArray(o.data) ? o.data : []);
      setVolume(v?.earnings ?? null);
    } catch { setOrders([]); }
  }, [merchantId]);

  useEffect(() => { void loadActivity(); }, [loadActivity]);

  if (problem) {
    return (
      <div className="om-fade space-y-3">
        <Link to="/merchants" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft size={14} /> Merchants</Link>
        <p role="alert" className="text-red-400">{problem}</p>
      </div>
    );
  }
  if (!merchant) return <div className="py-12 text-center text-gray-400" role="status">Loading merchant…</div>;

  const id = merchant._id;
  const role = summary?.role;

  // Every action: the server's own sentence on a refusal, shown where the
  // admin pressed (§32 S14, S44), and the page re-read on success.
  const run = async (key: string, fn: () => Promise<any>, ok: string, fail: string) => {
    setBusy(key); setActionProblem('');
    try {
      const res = await fn();
      toast.success(res?.message || ok);
      await load();
      return true;
    } catch (e: any) {
      const message = errorOf(e, fail);
      setActionProblem(message);
      toast.error(message);
      return false;
    } finally { setBusy(''); }
  };

  const reject = async () => {
    if (!rejectReason.trim()) { setActionProblem('Write why this application is rejected.'); return; }
    if (await run('reject', () => api.merchants.reject(id, rejectReason.trim()), 'Application rejected', 'Failed to reject')) setRejectReason('');
  };
  const suspend = async () => {
    if (!suspendReason.trim()) { setActionProblem('Write why this merchant is suspended.'); return; }
    if (await run('suspend', () => api.merchants.suspend(id, suspendReason.trim()), 'Suspended', 'Failed to suspend')) setSuspendReason('');
  };
  const resume = async () => {
    if (await run('resume', () => api.merchants.resumeAssignment(id), 'Assignment resumed', 'Failed to resume assignment')) setResumeChecked(false);
  };

  return (
    <div className="om-fade space-y-4">
      <Link to="/merchants" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft size={14} /> Merchants</Link>

      <header className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold truncate">{merchant.name}</h1>
          <p className="text-sm text-gray-400">
            {formatters.phone(merchant.mobile)} · {role ? ROLE_LABEL[role] ?? role : 'Merchant'}
            {summary?.team ? ` · ${summary.team.name}${summary.team.memberStatus === 'PENDING' ? ' (waiting for approval)' : ''}` : ''}
            {' · joined '}{formatters.date(merchant.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={merchant.status} type="merchant" />
          <StatusBadge status={merchant.merchantApprovalStatus} type="merchant" />
          {merchant.isOnline && <span className="text-xs" style={{ color: 'var(--success)' }}>● Online</span>}
          <DisputeRecordBadge lostDisputes={merchant.lostDisputes} highRiskAt={merchant.highRiskAt} />
        </div>
      </header>

      {summary && (
        <Kpis min={160} items={[
          { label: 'Volume processed', value: formatters.paise(summary.processedPaise) },
          { label: 'Completed orders', value: summary.completedOrders.toLocaleString('en-IN') },
          { label: 'Success rate', value: `${merchant.statistics?.successRate ?? 0}%` },
          { label: role === 'SUPERVISOR' ? `Pool (${summary.pool.teams} team${summary.pool.teams === 1 ? '' : 's'})` : 'Pool available', value: formatters.paise(summary.pool.availablePaise) },
          { label: 'Pool held for orders', value: formatters.paise(summary.pool.heldPaise), tone: summary.pool.heldPaise > 0 ? 'var(--warning)' : undefined },
          { label: 'Commission today', value: formatters.paise(summary.commission.todayPaise), tone: 'var(--success)' },
          { label: 'Commission this month', value: formatters.paise(summary.commission.monthPaise) },
          { label: 'Commission in all', value: formatters.paise(summary.commission.totalPaise) },
        ]} />
      )}

      {actionProblem && <p role="alert" className="text-sm text-red-400">{actionProblem}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {merchant.merchantApprovalStatus === 'PENDING' && (
          <Section title="Approval" sub="Waiting for approval: they cannot take orders until approved.">
            <button type="button" className="btn-primary" disabled={!!busy}
              onClick={() => void run('approve', () => api.merchants.approve(id), 'Approved', 'Failed to approve')}>
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <div className="flex flex-wrap gap-2">
              <label htmlFor="reject-reason" className="sr-only">Reason for rejecting</label>
              <input id="reject-reason" className="input flex-1 min-w-[12rem]" placeholder="Reason for rejecting (required)"
                value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
              <button type="button" className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                disabled={!!busy} onClick={() => void reject()}>{busy === 'reject' ? 'Rejecting…' : 'Reject'}</button>
            </div>
          </Section>
        )}

        <Section title="Account" sub={merchant.status === 'SUSPENDED' ? `Suspended: ${merchant.suspensionReason || 'no reason recorded'}` : 'A suspended merchant cannot sign in or take orders.'}>
          {merchant.status === 'SUSPENDED' ? (
            <button type="button" className="btn-primary" disabled={!!busy}
              onClick={() => void run('activate', () => api.merchants.activate(id), 'Activated', 'Failed to activate')}>
              {busy === 'activate' ? 'Activating…' : 'Activate'}
            </button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <label htmlFor="suspend-reason" className="sr-only">Reason for suspending</label>
              <input id="suspend-reason" className="input flex-1 min-w-[12rem]" placeholder="Reason for suspending (required)"
                value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} />
              <button type="button" className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                disabled={!!busy} onClick={() => void suspend()}>{busy === 'suspend' ? 'Suspending…' : 'Suspend'}</button>
            </div>
          )}
          {merchantPanelUrl && (
            <a href={merchantPanelUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300">
              <ExternalLink size={14} /> Open the merchant panel
            </a>
          )}
        </Section>

        {/* Paused, not suspended. Three buy orders in a row expired with
            nobody paying, which usually means nobody CAN pay this merchant: a
            wrong or frozen bank account. They keep every order they hold;
            routing stops offering new ones (assignment_paused_at IS NULL)
            until somebody has asked. No timer on purpose. */}
        {merchant.assignmentPausedAt && (
          <Section title="Paused from new orders" sub={`Since ${formatters.datetime(merchant.assignmentPausedAt)}`}>
            <p className="text-sm text-amber-400">{merchant.assignmentPauseReason || 'No reason was recorded.'}</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={resumeChecked} onChange={(e) => setResumeChecked(e.target.checked)} />
              I have checked with them that they can be paid
            </label>
            <button type="button" className="btn-primary disabled:opacity-50" disabled={!resumeChecked || !!busy} onClick={() => void resume()}>
              {busy === 'resume' ? 'Resuming…' : 'Resume assignment'}
            </button>
          </Section>
        )}

        {canTeams && choices && (role === 'SUPERVISOR' || role === 'UNASSIGNED') && (
          <Section title="Supervisor role" sub="A supervisor runs agent teams on one rail and takes no orders themselves. An agent in a team, or a merchant account, cannot be one.">
            <div className="flex flex-wrap gap-2">
              <label htmlFor="supervisor-rail" className="sr-only">Supervisor rail</label>
              <select id="supervisor-rail" className="input flex-1 min-w-[10rem]" value={supervisorRail}
                onChange={(e) => setSupervisorRail(e.target.value as SupervisorRail)}>
                <option value="" disabled>Choose a rail</option>
                {choices.supervisorRails.map((r) => <option key={r} value={r}>{RAIL_LABEL[r] ?? r}</option>)}
              </select>
              <button type="button" className="btn-primary disabled:opacity-50" disabled={!supervisorRail || !!busy || (role === 'SUPERVISOR' && supervisorRail === summary?.rail)}
                onClick={() => void run('supervisor', () => api.teams.setSupervisor(id, supervisorRail as SupervisorRail), 'Supervisor role saved', 'Failed to save the supervisor role')}>
                {role === 'SUPERVISOR' ? 'Change rail' : 'Make supervisor'}
              </button>
              {role === 'SUPERVISOR' && (
                <button type="button" className="btn-secondary" disabled={!!busy}
                  onClick={() => void run('supervisor', () => api.teams.setSupervisor(id, null), 'Supervisor role removed', 'Failed to remove the supervisor role')}>
                  Remove role
                </button>
              )}
            </div>
          </Section>
        )}

        {canTeams && choices && role === 'AGENT' && (
          <Section title="Routing priority" sub={`Orders are offered to the highest priority first (${choices.routingPriority.MIN} lowest, ${choices.routingPriority.MAX} highest).`}>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Routing priority">
              {Array.from({ length: choices.routingPriority.MAX - choices.routingPriority.MIN + 1 }, (_, i) => choices.routingPriority.MIN + i).map((p) => (
                <button key={p} type="button" aria-pressed={priority === p} disabled={!!busy || priority === p}
                  onClick={() => void run('priority', () => api.teams.setPriority(id, p), `Priority ${p}`, 'Failed to set the priority')}
                  className={`w-10 h-10 rounded-lg text-sm font-semibold border ${priority === p ? 'bg-gold-500/15 border-gold-500/60 text-gold-300' : 'bg-dark-800 border-dark-600 text-gray-300'}`}>
                  {p}
                </button>
              ))}
            </div>
          </Section>
        )}

        {(role === 'AGENT' || role === 'UNASSIGNED') && (
          <Section title="Merchant account" sub="Make this an INR merchant that serves orders itself, with its own pool, payment accounts and sub-members. Not for a supervisor or an agent in a team.">
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={!!busy}
              onClick={() => void run('account', () => api.merchants.makeMerchantAccount(id), 'Now a merchant', 'Could not make this a merchant.')}>
              {busy === 'account' ? 'Working…' : 'Make merchant account'}
            </button>
          </Section>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Order volume" sub="Completed orders' tokens (1 token = ₹1).">
          {volume ? (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-gray-400">Total orders</dt><dd>{(volume.totalOrders || 0).toLocaleString('en-IN')}</dd>
              <dt className="text-gray-400">Completed</dt><dd className="text-green-400">{(volume.completedOrders || 0).toLocaleString('en-IN')}</dd>
              <dt className="text-gray-400">In progress</dt><dd>{(volume.pendingOrders || 0).toLocaleString('en-IN')}</dd>
              <dt className="text-gray-400">Completed volume</dt><dd>{(volume.totalVolume || 0).toLocaleString('en-IN')} tokens</dd>
            </dl>
          ) : <p className="text-sm text-gray-500">No order data.</p>}
        </Section>

        <Section title="Recent orders">
          {orders === null ? <p className="text-sm text-gray-400" role="status">Loading orders…</p>
            : orders.length === 0 ? <p className="text-sm text-gray-500">No orders yet.</p> : (
              <ul className="divide-y divide-dark-700 text-sm max-h-96 overflow-y-auto pr-1">
                {orders.map((o: any) => (
                  <li key={o._id || o.orderId} className="flex justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block">{o.type} · {o.userName || 'Player'}</span>
                      <span className="text-xs text-gray-500 font-mono">{o.orderId} · {formatters.datetime(o.createdAt)}</span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block">{formatters.currency(o.fiatAmount)}</span>
                      <span className="text-xs text-gray-500">{o.status}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </Section>
      </div>
    </div>
  );
};
