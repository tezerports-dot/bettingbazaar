// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The staff table (owner, 2026-10-14): every staff account — full admins,
// sub-admins, queue managers, mediators — one row each, from
// `GET /api/admin/staff` (adminDirectory.listStaff). The role tabs and sort
// keys are the server's. A row opens the account's own page (StaffProfile),
// where its areas, queue-manager access and authenticator are changed on the
// page itself. Support staff are sub-admins holding the chat and support
// areas; the Areas column names them. Full admin only, as every route here.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowDownUp, UserPlus, Download } from 'lucide-react';
import { DataTable, type Column, type TableSort } from '../../components/DataTable';
import { Kpis, Toolbar } from '../../components/design';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import { formatters } from '../../utils/formatters';
import { DEFAULT_PERMISSIONS, type StaffPermissionCatalog } from '../../utils/permissions';
import api, { downloadFile, cleanParams } from '../../services/api';
import type { StaffRole, StaffRow } from '../../types';
import { PermissionPicker } from './PermissionPicker';
import { STAFF_ROLE_LABEL } from './staffLabels';
import toast from 'react-hot-toast';

/** UI names for the server's sort keys (§11); a key without one shows as itself. */
const SORT_LABEL: Record<string, string> = { joined: 'Date added', lastLogin: 'Last sign-in', areas: 'Areas granted', name: 'Name' };

const emptyForm = () => ({ username: '', mobile: '', password: '', permissions: { ...DEFAULT_PERMISSIONS } as Record<string, boolean> });

export const StaffList: React.FC = () => {
  const navigate = useNavigate();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [sorts, setSorts] = useState<string[]>(['joined']);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<string>('ALL');
  const [sort, setSort] = useState<TableSort>({ key: 'joined', dir: 'desc' });
  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  const [catalog, setCatalog] = useState<StaffPermissionCatalog | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [createProblem, setCreateProblem] = useState('');
  const [saving, setSaving] = useState(false);

  // Every staff account the filters match (`GET /api/admin/staff.xlsx`).
  const exportExcel = async () => {
    try {
      await downloadFile('/api/admin/staff.xlsx', cleanParams({
        search: debouncedSearch, role: role === 'ALL' ? undefined : role, sort: sort.key, dir: sort.dir,
      }), 'staff.xlsx');
    } catch { toast.error('Export failed'); }
  };

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.subAdmins.listStaff({
        page, limit, search: debouncedSearch || undefined,
        role: role === 'ALL' ? undefined : role, sort: sort.key, dir: sort.dir,
      });
      setStaff(res.staff || []);
      setTotal(res.pagination?.total || 0);
      if (Array.isArray(res.sorts) && res.sorts.length) setSorts(res.sorts);
      if (Array.isArray(res.roles)) setRoles(res.roles);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to load staff'); }
    finally { setIsLoading(false); }
  }, [page, limit, debouncedSearch, role, sort]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api.subAdmins.permissionCatalog().then(setCatalog).catch(() => setCatalog(null));
  }, []);

  const changeSort = (next: TableSort) => { setSort(next); setPage(1); };
  const open = (s: StaffRow) => navigate(`/staff/${encodeURIComponent(s.userId)}`);
  const areaLabel = (key: string) => catalog?.permissions.find((p) => p.key === key)?.label ?? key;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setCreateProblem('');
    try {
      const res: any = await api.subAdmins.create(form);
      toast.success('Sub-admin created');
      setForm(emptyForm()); setCreating(false);
      const id = res?.subAdmin?.userId;
      if (id) navigate(`/staff/${encodeURIComponent(id)}`); else void load();
    } catch (err: any) {
      setCreateProblem(err?.response?.data?.message || 'Failed to create the sub-admin');
    } finally { setSaving(false); }
  };

  const columns: Column<StaffRow>[] = [
    {
      key: 'name', label: 'Name', sortKey: 'name',
      render: (s) => (
        <button type="button" onClick={() => open(s)} className="text-left">
          <p className="font-medium">{s.username || 'Unnamed'}</p>
          <p className="text-xs text-gray-400">{formatters.phone(s.mobile)}</p>
        </button>
      ),
    },
    {
      key: 'roles', label: 'Role',
      render: (s) => (
        <div className="flex flex-wrap gap-1">
          {s.roles.map((r) => <span key={r} className="px-1.5 py-0.5 rounded-sm text-xs bg-purple-500/20 text-purple-300">{STAFF_ROLE_LABEL[r] ?? r}</span>)}
        </div>
      ),
    },
    {
      key: 'areas', label: 'Areas', sortKey: 'areas',
      render: (s) => s.roles.includes('ADMIN') ? <span className="text-xs text-gray-400">Everything</span> : (
        <span className="text-xs text-gray-300" title={s.areas.map(areaLabel).join(', ')}>
          {s.areas.length === 0 ? 'None' : `${s.areas.length}: ${s.areas.slice(0, 3).map(areaLabel).join(', ')}${s.areas.length > 3 ? '…' : ''}`}
        </span>
      ),
    },
    {
      key: 'authenticator', label: 'Authenticator',
      render: (s) => (
        <span className={`px-2 py-0.5 rounded text-xs ${s.authenticatorEnrolled ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'}`}>
          {s.authenticatorEnrolled ? 'Set up' : 'Not set up'}
        </span>
      ),
    },
    { key: 'lastLogin', label: 'Last sign-in', sortKey: 'lastLogin', render: (s) => <span className="text-xs text-gray-400">{s.lastLogin ? formatters.datetime(s.lastLogin) : '—'}</span> },
    { key: 'joined', label: 'Added', sortKey: 'joined', render: (s) => <span className="text-xs text-gray-400">{formatters.date(s.joinedAt)}</span> },
  ];

  return (
    <div className="om-fade space-y-4">
      <Kpis items={[
        { label: role === 'ALL' ? 'Staff' : (STAFF_ROLE_LABEL[role] ?? role), value: total.toLocaleString('en-IN') },
        { label: 'Sorted by', value: SORT_LABEL[sort.key] ?? sort.key },
      ]} />

      <Toolbar
        tabs={['ALL', ...roles].map((r) => ({
          label: r === 'ALL' ? 'All' : (STAFF_ROLE_LABEL[r] ?? r),
          active: role === r,
          onClick: () => { setRole(r); setPage(1); },
        }))}
        search={{ value: search, onChange: (v) => { setSearch(v); setPage(1); }, placeholder: 'Search name, mobile, ID…' }}
        actions={[
          { label: 'Download Excel', icon: Download, onClick: () => void exportExcel() },
          { label: creating ? 'Close' : 'Create Sub-Admin', icon: UserPlus, primary: !creating, onClick: () => setCreating((c) => !c) },
        ]}
      />

      {creating && (
        <form onSubmit={create} className="card p-4 space-y-4" aria-label="Create a sub-admin">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="staff-username">Username</label>
              <input id="staff-username" className="input" required value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="staff-mobile">Mobile</label>
              <input id="staff-mobile" type="tel" className="input" required value={form.mobile}
                onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="staff-password">Password</label>
              <input id="staff-password" type="password" className="input" required value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
          </div>
          <div>
            <p className="label mb-2">Areas this sub-admin can work in</p>
            <PermissionPicker idPrefix="create-perm" catalog={catalog}
              value={form.permissions} onChange={(permissions) => setForm({ ...form, permissions })} />
          </div>
          {createProblem && <p role="alert" className="text-sm text-red-400">{createProblem}</p>}
          <button type="submit" className="btn-primary disabled:opacity-50" disabled={!catalog || saving}>
            {saving ? 'Creating…' : 'Create Sub-Admin'}
          </button>
        </form>
      )}

      {/* The same sort as the column headers, for a phone where the header
          you want has scrolled off screen. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="staff-sort" className="text-gray-400">Sort by</label>
        <select id="staff-sort" className="input w-auto" value={sort.key}
          onChange={(e) => changeSort({ key: e.target.value, dir: sort.dir })}>
          {sorts.map((k) => <option key={k} value={k}>{SORT_LABEL[k] ?? k}</option>)}
        </select>
        <button type="button" className="btn-secondary inline-flex items-center gap-1"
          onClick={() => changeSort({ key: sort.key, dir: sort.dir === 'desc' ? 'asc' : 'desc' })}>
          <ArrowDownUp size={14} aria-hidden="true" /> {sort.dir === 'desc' ? 'newest / most first' : 'oldest / fewest first'}
        </button>
      </div>

      <div className="card">
        <DataTable data={staff} columns={columns} currentPage={page} totalPages={Math.ceil(total / limit)}
          onPageChange={setPage} isLoading={isLoading} sort={sort} onSort={changeSort} onRowClick={open} />
      </div>
    </div>
  );
};
