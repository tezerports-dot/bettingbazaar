// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// One staff account's page (owner, 2026-10-14): its roles, its areas as
// toggles, queue-manager access as a switch, and the authenticator reset and
// sub-admin removal, each on the page itself, no pop-ups. A step that cannot
// be undone from here asks for a second press beside the first.
//
// Every route is a full admin's (staffPermissions.js ADMIN_ONLY_AREAS). The
// areas and their labels are the server's catalogue (`GET /staff-permissions`),
// so this page keeps no list of its own (§32 S25). A full admin holds every
// area, so their page has no toggles; nobody resets their own authenticator
// (the server refuses it, `NOT_YOUR_OWN`), so their own page does not offer it.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { Kpis } from '../../components/design';
import { formatters } from '../../utils/formatters';
import { DEFAULT_PERMISSIONS, type StaffPermissionCatalog } from '../../utils/permissions';
import api from '../../services/api';
import type { StaffRow } from '../../types';
import { PermissionPicker } from './PermissionPicker';
import { STAFF_ROLE_LABEL } from './staffLabels';
import toast from 'react-hot-toast';

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

const grantOf = (areas: string[]): Record<string, boolean> => {
  const grant: Record<string, boolean> = { ...DEFAULT_PERMISSIONS };
  for (const k of areas) grant[k] = true;
  return grant;
};

export const StaffProfile: React.FC = () => {
  const { userId = '' } = useParams();
  const navigate = useNavigate();
  const [staff, setStaff] = useState<StaffRow | null>(null);
  const [isSelf, setIsSelf] = useState(false);
  const [problem, setProblem] = useState('');
  const [actionProblem, setActionProblem] = useState('');
  const [busy, setBusy] = useState('');
  const [catalog, setCatalog] = useState<StaffPermissionCatalog | null>(null);
  const [grant, setGrant] = useState<Record<string, boolean>>({ ...DEFAULT_PERMISSIONS });
  const [confirm, setConfirm] = useState<'' | 'reset' | 'remove'>('');

  const load = useCallback(async () => {
    setProblem('');
    try {
      const res = await api.subAdmins.getStaff(userId);
      setStaff(res.staff);
      setIsSelf(Boolean(res.isSelf));
      setGrant(grantOf(res.staff.areas));
    } catch (e: any) { setProblem(errorOf(e, 'Could not load this staff account.')); }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api.subAdmins.permissionCatalog().then(setCatalog).catch(() => setCatalog(null));
  }, []);

  if (problem) {
    return (
      <div className="om-fade space-y-3">
        <Link to="/staff" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft size={14} /> Staff</Link>
        <p role="alert" className="text-red-400">{problem}</p>
      </div>
    );
  }
  if (!staff) return <div className="py-12 text-center text-gray-400" role="status">Loading staff account…</div>;

  const isAdmin = staff.roles.includes('ADMIN');
  const isSub = staff.roles.includes('SUB_ADMIN');
  const isQueueManager = staff.roles.includes('QUEUE_MANAGER');
  const saved = grantOf(staff.areas);
  const changed = Object.keys({ ...saved, ...grant }).some((k) => Boolean(saved[k]) !== Boolean(grant[k]));

  // Every action: the server's own sentence on a refusal, shown where the
  // admin pressed (§32 S14, S44), and the page re-read on success.
  const run = async (key: string, fn: () => Promise<any>, ok: string, fail: string) => {
    setBusy(key); setActionProblem('');
    try {
      const res = await fn();
      toast.success(res?.message || ok);
      setConfirm('');
      await load();
      return true;
    } catch (e: any) {
      const message = errorOf(e, fail);
      setActionProblem(message);
      toast.error(message);
      return false;
    } finally { setBusy(''); }
  };

  return (
    <div className="om-fade space-y-4">
      <Link to="/staff" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft size={14} /> Staff</Link>

      <div>
        <h1 className="text-xl font-semibold">{staff.username || 'Unnamed'}</h1>
        <p className="text-sm text-gray-400">
          {formatters.phone(staff.mobile)} · {staff.roles.map((r) => STAFF_ROLE_LABEL[r] ?? r).join(', ') || 'No role'}
          {isSelf && ' · you'}
        </p>
      </div>

      <Kpis items={[
        { label: 'Areas granted', value: isAdmin ? 'Everything' : String(staff.areas.length) },
        { label: 'Authenticator', value: staff.authenticatorEnrolled ? 'Set up' : 'Not set up' },
        { label: 'Last sign-in', value: staff.lastLogin ? formatters.datetime(staff.lastLogin) : '—' },
        { label: 'Added', value: formatters.date(staff.joinedAt) },
      ]} />

      {actionProblem && <p role="alert" className="text-sm text-red-400">{actionProblem}</p>}

      {isAdmin ? (
        <Section title="Areas" sub="A full admin holds every area; there is nothing to switch.">
          <p className="text-sm text-gray-400">Full admin.</p>
        </Section>
      ) : isSub ? (
        <Section title="Areas" sub="Switch the areas this sub-admin can work in, then save. Their live feeds close and reopen under the new areas.">
          <PermissionPicker idPrefix="staff-perm" catalog={catalog} value={grant} onChange={setGrant} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary disabled:opacity-50" disabled={!changed || !catalog || busy !== ''}
              onClick={() => void run('areas', () => api.subAdmins.updatePermissions(staff.userId, grant), 'Areas saved', 'Failed to save the areas')}>
              {busy === 'areas' ? 'Saving…' : 'Save areas'}
            </button>
            {changed && (
              <button type="button" className="btn-secondary" onClick={() => setGrant(saved)}>Undo changes</button>
            )}
          </div>
        </Section>
      ) : (
        <Section title="Areas" sub="Areas are given to sub-admins. This account is not one.">
          <p className="text-sm text-gray-400">No areas.</p>
        </Section>
      )}

      {!isAdmin && (
        <Section title="Queue manager" sub="A queue manager assigns payment orders to agents and merchants: they decide where a player's money goes.">
          <label className="inline-flex items-center gap-3 text-sm">
            <input type="checkbox" role="switch" aria-checked={isQueueManager} checked={isQueueManager} disabled={busy !== ''}
              onChange={(e) => void run('queue', () => api.subAdmins.setQueueManager(staff.userId, e.target.checked),
                e.target.checked ? 'Queue-manager access granted' : 'Queue-manager access removed',
                'Failed to change queue-manager access')} />
            Queue-manager access
          </label>
        </Section>
      )}

      {!isSelf && (
        <Section title="Authenticator" sub="Resetting forgets their app and recovery codes and signs them out everywhere. At their next sign-in they set up a new app.">
          {confirm === 'reset' ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-yellow-300">Reset the authenticator for {staff.username || 'this account'}?</span>
              <button type="button" className="btn-danger disabled:opacity-50" disabled={busy !== ''}
                onClick={() => void run('reset', () => api.subAdmins.resetAuthenticator(staff.userId), 'Authenticator reset', 'Failed to reset the authenticator')}>
                Yes, reset it
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirm('')}>Keep it</button>
            </div>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => setConfirm('reset')}>Reset authenticator</button>
          )}
        </Section>
      )}

      {isSub && (
        <Section title="Remove sub-admin" sub="Takes every area away. The account and its audit trail stay.">
          {confirm === 'remove' ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-yellow-300">Remove {staff.username || 'this account'} as a sub-admin?</span>
              <button type="button" className="btn-danger disabled:opacity-50" disabled={busy !== ''}
                onClick={() => void (async () => {
                  if (await run('remove', () => api.subAdmins.delete(staff.userId), 'Sub-admin removed', 'Failed to remove the sub-admin')) navigate('/staff');
                })()}>
                Yes, remove
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirm('')}>Keep them</button>
            </div>
          ) : (
            <button type="button" className="btn-secondary text-red-400" onClick={() => setConfirm('remove')}>Remove sub-admin</button>
          )}
        </Section>
      )}
    </div>
  );
};
