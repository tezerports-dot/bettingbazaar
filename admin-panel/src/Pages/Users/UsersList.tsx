// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The players table (owner, 2026-10-14): every player as one row with the
// figures an operator sorts by, from `GET /api/admin/users`
// (adminDirectory.listPlayers). A row opens the player's own page
// (UserProfile), where every control sits on the page itself, no pop-ups.
// Staff and merchant logins are not players and are not listed here.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowDownUp, Download } from 'lucide-react';
import { DataTable, type Column, type TableSort } from '../../components/DataTable';
import { DisputeRecordBadge } from '../../components/DisputeRecordBadge';
import { StatusBadge } from '../../components/StatusBadge';
import { Kpis, Toolbar, AvatarCell, Money } from '../../components/design';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import { formatters } from '../../utils/formatters';
import api, { downloadCsv, cleanParams } from '../../services/api';
import type { PlayerRow } from '../../types';
import toast from 'react-hot-toast';

/**
 * What each server sort key is called on screen (§11: a UI-only label; the
 * KEYS are the server's `sorts`, and a key without a label shows as itself).
 */
const SORT_LABEL: Record<string, string> = {
  joined: 'Joining date', deposits: 'Total deposits', withdrawals: 'Total sold', net: 'Net win / loss',
  vip: 'VIP wallet', general: 'General wallet', locked: 'Locked in bets', name: 'Name',
};
const DIR_LABEL = (key: string, dir: 'asc' | 'desc') => {
  if (key === 'net') return dir === 'desc' ? 'biggest winners first' : 'biggest losers first';
  if (key === 'joined') return dir === 'desc' ? 'newest first' : 'oldest first';
  if (key === 'name') return dir === 'asc' ? 'A to Z' : 'Z to A';
  return dir === 'desc' ? 'highest first' : 'lowest first';
};

const STATUS_TABS = ['ALL', 'ACTIVE', 'BLOCKED', 'SUSPENDED'] as const;

export const UsersList: React.FC = () => {
  const navigate = useNavigate();
  const [users, setUsers] = useState<PlayerRow[]>([]);
  const [sorts, setSorts] = useState<string[]>(['joined']);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [sort, setSort] = useState<TableSort>({ key: 'joined', dir: 'desc' });
  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.users.getAll({
        page, limit, search: debouncedSearch || undefined,
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        sort: sort.key, dir: sort.dir,
      });
      if (res.success && res.data) {
        setUsers(res.data);
        setTotal(res.pagination?.total || 0);
        if (Array.isArray(res.sorts) && res.sorts.length) setSorts(res.sorts);
      }
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to load players'); }
    finally { setIsLoading(false); }
  }, [page, limit, debouncedSearch, statusFilter, sort]);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

  const changeSort = (next: TableSort) => { setSort(next); setPage(1); };

  // Every player the filters match, not the page (`GET /api/admin/users.csv`).
  const exportCsv = async () => {
    try {
      await downloadCsv('/api/admin/users.csv', cleanParams({
        search: debouncedSearch, status: statusFilter === 'ALL' ? undefined : statusFilter, sort: sort.key, dir: sort.dir,
      }), 'players.csv');
    } catch { toast.error('Export failed'); }
  };
  const open = (u: PlayerRow) => navigate(`/users/${encodeURIComponent(u.userId)}`);

  const columns: Column<PlayerRow>[] = [
    {
      key: 'user', label: 'Player', sortKey: 'name',
      render: (u) => (
        <button type="button" onClick={() => open(u)} className="text-left">
          <AvatarCell name={u.username} sub={formatters.phone(u.mobile)} index={Math.max(0, users.indexOf(u))} />
        </button>
      ),
    },
    { key: 'joined', label: 'Joined', sortKey: 'joined', render: (u) => <span className="text-xs text-gray-400">{formatters.date(u.joinedAt)}</span> },
    { key: 'deposits', label: 'Total deposits', sortKey: 'deposits', numeric: true, render: (u) => <Money value={formatters.paise(u.totals.depositsPaise)} /> },
    { key: 'withdrawals', label: 'Total sold', sortKey: 'withdrawals', numeric: true, render: (u) => <Money value={formatters.paise(u.totals.withdrawalsPaise)} tone="muted" /> },
    {
      key: 'net', label: 'Net win / loss', sortKey: 'net', numeric: true,
      render: (u) => <Money value={formatters.signedPaise(u.totals.netPaise)} tone={u.totals.netPaise > 0 ? 'success' : u.totals.netPaise < 0 ? 'danger' : 'muted'} />,
    },
    { key: 'vip', label: 'VIP wallet', sortKey: 'vip', numeric: true, render: (u) => <Money value={formatters.paise(u.wallet.vipPaise)} /> },
    { key: 'general', label: 'General wallet', sortKey: 'general', numeric: true, render: (u) => <Money value={formatters.paise(u.wallet.generalPaise)} /> },
    {
      key: 'locked', label: 'Locked', sortKey: 'locked', numeric: true,
      render: (u) => <Money value={formatters.paise(u.wallet.lockedPaise)} tone={u.wallet.lockedPaise > 0 ? 'warning' : 'muted'} />,
    },
    {
      key: 'status', label: 'Status',
      render: (u) => (
        <div className="space-y-1">
          <StatusBadge status={u.status} type="user" />
          <DisputeRecordBadge lostDisputes={u.lostDisputes} highRiskAt={u.highRiskAt} />
        </div>
      ),
    },
  ];

  return (
    <div className="om-fade">
      <Kpis items={[
        { label: 'Players', value: total.toLocaleString('en-IN') },
        { label: 'Sorted by', value: `${SORT_LABEL[sort.key] ?? sort.key}` },
      ]} />

      <Toolbar
        tabs={STATUS_TABS.map((s) => ({
          label: s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase(),
          active: statusFilter === s,
          onClick: () => { setStatusFilter(s); setPage(1); },
        }))}
        search={{ value: search, onChange: (v) => { setSearch(v); setPage(1); }, placeholder: 'Search name, mobile, ID…' }}
        actions={[{ label: 'Download CSV', icon: Download, onClick: () => void exportCsv() }]}
      />

      {/* The same sort as the column headers, for a phone where the table
          scrolls sideways and the header you want is off screen. */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <label htmlFor="players-sort" className="text-gray-400">Sort by</label>
        <select id="players-sort" className="input w-auto" value={sort.key}
          onChange={(e) => changeSort({ key: e.target.value, dir: sort.dir })}>
          {sorts.map((k) => <option key={k} value={k}>{SORT_LABEL[k] ?? k}</option>)}
        </select>
        <button type="button" className="btn-secondary inline-flex items-center gap-1"
          onClick={() => changeSort({ key: sort.key, dir: sort.dir === 'desc' ? 'asc' : 'desc' })}>
          <ArrowDownUp size={14} aria-hidden="true" /> {DIR_LABEL(sort.key, sort.dir)}
        </button>
      </div>

      <div className="card">
        <DataTable data={users} columns={columns} currentPage={page} totalPages={Math.ceil(total / limit)}
          onPageChange={setPage} isLoading={isLoading} sort={sort} onSort={changeSort} onRowClick={open} />
      </div>
    </div>
  );
};
