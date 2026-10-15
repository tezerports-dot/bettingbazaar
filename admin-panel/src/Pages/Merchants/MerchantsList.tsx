// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The merchants table (owner, 2026-10-14): agents, supervisors and merchant
// accounts, one row each, with what they processed, their completed orders,
// the pool they work from and their commission today and this month, from
// `GET /api/admin/merchants` (adminDirectory.listMerchants). Sorting is the
// server's. A row opens the merchant's own page (MerchantProfile), where every
// control sits on the page itself. A merchant holds NO tokens of their own:
// the pool shown is their team's (or their merchant account's).
import sseService from '../../services/sse';
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, RefreshCw, ArrowDownUp } from 'lucide-react';
import { DataTable, type Column, type TableSort } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { DisputeRecordBadge } from '../../components/DisputeRecordBadge';
import { Kpis, Toolbar, AvatarCell, Money } from '../../components/design';
import { Modal } from '../../components/Modal';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import type { MerchantRow } from '../../types';
import { ROLE_LABEL } from './merchantLabels';
import toast from 'react-hot-toast';

const ROLE_TAB: Record<string, string> = {
  MERCHANT: 'Merchants', SUPERVISOR: 'Supervisors', AGENT: 'Agents', UNASSIGNED: 'No team',
};
/** UI names for the server's sort keys (adminDirectory.js MERCHANT_SORTS). §11. */
const SORT_LABEL: Record<string, string> = {
  joined: 'Joining date', processed: 'Volume processed', orders: 'Completed orders', pool: 'Pool size',
  commissionToday: 'Commission today', commissionMonth: 'Commission this month', commissionTotal: 'Commission in all', name: 'Name',
};

export const MerchantsList: React.FC = () => {
  const navigate = useNavigate();
  const [merchants, setMerchants] = useState<MerchantRow[]>([]);
  const [sorts, setSorts] = useState<string[]>(['joined']);
  const [roles, setRoles] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [sort, setSort] = useState<TableSort>({ key: 'joined', dir: 'desc' });

  // Create merchant
  const [showCreateModal, setShowCreateModal] = useState(false);
  // kind: 'AGENT' works in a team under a supervisor; 'DIRECT' is a merchant
  // (merchant account) serving INR itself (owner, 2026-10-11).
  const emptyCreate = { username: '', mobile: '', email: '', kind: 'AGENT' as 'AGENT' | 'DIRECT' };
  const [createForm, setCreateForm] = useState(emptyCreate);
  const [isCreating, setIsCreating] = useState(false);

  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  // Real-time: update the online dot when a merchant toggles their status.
  useEffect(() => {
    const handleStatusChange = (data: any) => {
      setMerchants((prev) => prev.map((m) =>
        m.merchantId === String(data.merchantId) ? { ...m, isOnline: Boolean(data.isOnline) } : m));
    };
    sseService.on('merchant_status_changed', handleStatusChange);
    return () => { sseService.off('merchant_status_changed', handleStatusChange); };
  }, []);

  const loadMerchants = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.merchants.getAll({
        page, limit, search: debouncedSearch || undefined,
        role: roleFilter === 'ALL' ? undefined : roleFilter,
        status: pendingOnly ? 'PENDING' : undefined,
        sort: sort.key, dir: sort.dir,
      });
      if (res.success && res.data) {
        setMerchants(res.data);
        setTotal(res.pagination?.total || 0);
        if (Array.isArray(res.sorts) && res.sorts.length) setSorts(res.sorts);
        if (Array.isArray(res.roles)) setRoles(res.roles);
      }
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to load merchants'); }
    finally { setIsLoading(false); }
  }, [page, limit, debouncedSearch, roleFilter, pendingOnly, sort]);

  useEffect(() => { void loadMerchants(); }, [loadMerchants]);

  const changeSort = (next: TableSort) => { setSort(next); setPage(1); };
  const open = (m: MerchantRow) => navigate(`/merchants/${encodeURIComponent(m.merchantId)}`);

  const handleCreateMerchant = async () => {
    if (!createForm.username || !createForm.mobile) { toast.error('Fill required fields'); return; }
    setIsCreating(true);
    try {
      await api.merchants.create(createForm);
      toast.success(createForm.kind === 'DIRECT' ? 'Merchant created' : 'Agent created');
      setShowCreateModal(false);
      setCreateForm(emptyCreate);
      void loadMerchants();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to create merchant'); }
    finally { setIsCreating(false); }
  };

  const columns: Column<MerchantRow>[] = [
    {
      key: 'merchant', label: 'Name', sortKey: 'name',
      render: (m) => (
        <button type="button" onClick={() => open(m)} className="text-left">
          <AvatarCell name={m.name} sub={formatters.phone(m.mobile)} index={Math.max(0, merchants.indexOf(m))} />
          <span className="flex items-center gap-2 text-xs mt-1">
            <span className="px-1.5 py-0.5 rounded-sm bg-dark-700 text-gray-300">{ROLE_LABEL[m.role] ?? m.role}</span>
            {m.isOnline && <span className="inline-flex items-center" style={{ color: 'var(--success)' }}><span className="w-1.5 h-1.5 rounded-full mr-1" style={{ background: 'var(--success)' }} />Online</span>}
          </span>
        </button>
      ),
    },
    { key: 'team', label: 'Team', render: (m) => <span className="text-sm">{m.team?.name ?? (m.role === 'SUPERVISOR' ? `${m.pool.teams} team${m.pool.teams === 1 ? '' : 's'}` : '—')}</span> },
    {
      key: 'status', label: 'Status',
      render: (m) => (
        <div className="space-y-1">
          <StatusBadge status={m.status} type="merchant" />
          {m.merchantApprovalStatus !== 'APPROVED' && <StatusBadge status={m.merchantApprovalStatus} type="merchant" />}
          <DisputeRecordBadge lostDisputes={m.lostDisputes} highRiskAt={m.highRiskAt} />
        </div>
      ),
    },
    { key: 'processed', label: 'Processed', sortKey: 'processed', numeric: true, render: (m) => <Money value={formatters.paise(m.processedPaise)} /> },
    { key: 'orders', label: 'Orders', sortKey: 'orders', numeric: true, render: (m) => <Money value={m.completedOrders.toLocaleString('en-IN')} /> },
    {
      key: 'pool', label: 'Pool', sortKey: 'pool', numeric: true,
      render: (m) => (
        <div>
          <Money value={formatters.paise(m.pool.availablePaise)} />
          {m.pool.heldPaise > 0 && <p className="text-xs text-gray-500">{formatters.paise(m.pool.heldPaise)} held</p>}
        </div>
      ),
    },
    { key: 'today', label: 'Commission today', sortKey: 'commissionToday', numeric: true, render: (m) => <Money value={formatters.paise(m.commission.todayPaise)} tone={m.commission.todayPaise > 0 ? 'success' : 'muted'} /> },
    { key: 'month', label: 'This month', sortKey: 'commissionMonth', numeric: true, render: (m) => <Money value={formatters.paise(m.commission.monthPaise)} /> },
    { key: 'joined', label: 'Joined', sortKey: 'joined', render: (m) => <span className="text-xs text-gray-400">{formatters.date(m.createdAt)}</span> },
  ];

  return (
    <div className="om-fade">
      <Kpis items={[
        { label: roleFilter === 'ALL' ? 'All merchants' : ROLE_TAB[roleFilter] ?? roleFilter, value: total.toLocaleString('en-IN') },
        { label: 'Online on this page', value: merchants.filter((m) => m.isOnline).length, tone: 'var(--success)' },
        { label: 'Sorted by', value: SORT_LABEL[sort.key] ?? sort.key },
      ]} />

      <Toolbar
        tabs={[
          { label: 'All', active: roleFilter === 'ALL', onClick: () => { setRoleFilter('ALL'); setPage(1); } },
          ...roles.map((r) => ({ label: ROLE_TAB[r] ?? r, active: roleFilter === r, onClick: () => { setRoleFilter(r); setPage(1); } })),
        ]}
        search={{ value: search, onChange: (v) => { setSearch(v); setPage(1); }, placeholder: 'Search name, mobile, ID…' }}
        actions={[
          { label: 'Refresh', icon: RefreshCw, onClick: () => void loadMerchants() },
          { label: 'Create Merchant', icon: Plus, primary: true, onClick: () => setShowCreateModal(true) },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <label htmlFor="merchants-sort" className="text-gray-400">Sort by</label>
        <select id="merchants-sort" className="input w-auto" value={sort.key}
          onChange={(e) => changeSort({ key: e.target.value, dir: sort.dir })}>
          {sorts.map((k) => <option key={k} value={k}>{SORT_LABEL[k] ?? k}</option>)}
        </select>
        <button type="button" className="btn-secondary inline-flex items-center gap-1"
          onClick={() => changeSort({ key: sort.key, dir: sort.dir === 'desc' ? 'asc' : 'desc' })}>
          <ArrowDownUp size={14} aria-hidden="true" /> {sort.dir === 'desc' ? 'highest first' : 'lowest first'}
        </button>
        <label className="inline-flex items-center gap-2 ml-auto">
          <input type="checkbox" checked={pendingOnly} onChange={(e) => { setPendingOnly(e.target.checked); setPage(1); }} />
          Waiting for approval only
        </label>
      </div>

      <div className="card">
        <DataTable data={merchants} columns={columns} currentPage={page} totalPages={Math.ceil(total / limit)}
          onPageChange={setPage} isLoading={isLoading} sort={sort} onSort={changeSort} onRowClick={open} />
      </div>

      {/* A merchant's pool, payment accounts and sub-members are on Payments
          (Merchants side), beside every other pool. */}

      {/* Create Merchant Modal */}
      {showCreateModal && (
        <Modal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} title="Create an Agent or Merchant">
          <div className="space-y-4">
            <p className="text-sm text-gray-400">Create a login for the merchant panel. It must be approved before it can take orders.</p>
            <fieldset>
              <legend className="label">Kind</legend>
              <div className="flex gap-4 mt-1 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="create-kind" value="AGENT" checked={createForm.kind === 'AGENT'}
                    onChange={() => setCreateForm((f) => ({ ...f, kind: 'AGENT' }))} />
                  Agent
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="create-kind" value="DIRECT" checked={createForm.kind === 'DIRECT'}
                    onChange={() => setCreateForm((f) => ({ ...f, kind: 'DIRECT' }))} />
                  Merchant
                </label>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {createForm.kind === 'DIRECT'
                  ? 'A merchant serves INR orders itself, with its own pool, payment accounts and sub-members.'
                  : 'An agent works in a team under a supervisor.'}
              </p>
            </fieldset>
            <div>
              <label htmlFor="create-username" className="label">Username *</label>
              <input id="create-username" name="username" type="text" value={createForm.username} onChange={(e) => setCreateForm(f => ({ ...f, username: e.target.value }))} className="input" placeholder="Merchant display name" />
            </div>
            <div>
              <label htmlFor="create-mobile" className="label">Mobile Number *</label>
              <input id="create-mobile" name="mobile" type="tel" value={createForm.mobile} onChange={(e) => setCreateForm(f => ({ ...f, mobile: e.target.value }))} className="input" placeholder="10-digit mobile" />
            </div>
            <div>
              <label htmlFor="create-email" className="label">Email</label>
              <input id="create-email" name="email" type="email" value={createForm.email} onChange={(e) => setCreateForm(f => ({ ...f, email: e.target.value }))} className="input" placeholder="Optional" />
            </div>
            <p className="text-xs text-gray-400">
              No password: they sign in with Continue with Telegram, on the Telegram of this mobile.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowCreateModal(false)} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={handleCreateMerchant} disabled={isCreating} className="flex-1 btn-primary disabled:opacity-50">{isCreating ? 'Creating...' : 'Create Merchant'}</button>
            </div>
          </div>
        </Modal>
      )}

    </div>
  );
};
