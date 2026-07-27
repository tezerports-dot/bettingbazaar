// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * AuditLogs.tsx -- FIX A4: Field mapping corrected to match EnhancedAuditLog schema.
 *
 * Before: Interface used { adminId, adminName, ipAddress } -- none of these
 *   fields exist on EnhancedAuditLog. All columns rendered blank strings.
 *
 * After: Interface uses actual schema fields:
 *   performedBy  -> populated User object { username, mobile }
 *   performedByName -> string fallback (denormalised)
 *   ip           -> string (was 'ipAddress')
 *   category     -> added; used as a filter + column
 *   details      -> Mixed (was string; now JSON.stringified for display)
 *   timestamp    -> kept (correct field name)
 */

import { DataTable } from '../../components/DataTable';
import { DateRangePicker } from '../../components/DateRangePicker';
import { SearchBar } from '../../components/SearchBar';
import { Kpis, Toolbar } from '../../components/design';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import toast from 'react-hot-toast';

import React, { useEffect, useState } from 'react';
import { Shield, Download } from 'lucide-react';

interface AuditLog {
  _id: string;
  // FIX A4: performedBy is a populated User object (username, mobile)
  performedBy: { _id: string; username?: string; mobile?: string } | null;
  // Denormalised name written at log time -- use as fallback
  performedByName?: string;
  performedByRole?: string;
  action: string;
  category: string;
  details: any;          // Mixed -- stringify for display
  ip?: string;           // FIX A4: was 'ipAddress', schema uses 'ip'
  targetName?: string;
  success?: boolean;
  timestamp: string;
}

export const AuditLogs: React.FC = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  useEffect(() => {
    loadLogs();
  }, [page, debouncedSearch, startDate, endDate]);

  const loadLogs = async () => {
    setIsLoading(true);
    try {
      const response = await api.system.getAuditLogs(page, limit);
      if (response.success && response.data) {
        setLogs(response.data);
        setTotal(response.pagination?.total || 0);
      }
    } catch (error) {
      toast.error('Failed to load audit logs');
    } finally {
      setIsLoading(false);
    }
  };

  const getActionColor = (action: string) => {
    if (action.includes('DELETE') || action.includes('BLOCK')) return 'text-red-500';
    if (action.includes('CREATE') || action.includes('APPROVE')) return 'text-green-500';
    if (action.includes('UPDATE') || action.includes('EDIT')) return 'text-blue-500';
    return 'text-gray-400';
  };

  const columns = [
    {
      key: 'admin',
      label: 'Admin',
      render: (log: AuditLog) => (
        <div>
          <p className="font-medium">
            {log.performedBy?.username || log.performedByName || '--'}
          </p>
          <p className="text-xs text-gray-500">
            {log.performedByRole || ''}{log.performedBy?._id ? ` . ${log.performedBy._id.slice(-6)}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      render: (log: AuditLog) => (
        <span className={`font-medium ${getActionColor(log.action)}`}>{log.action}</span>
      ),
    },
    {
      key: 'category',
      label: 'Category',
      render: (log: AuditLog) => (
        <span className="text-xs bg-dark-700 text-gray-300 px-2 py-0.5 rounded font-mono">
          {log.category || '--'}
        </span>
      ),
    },
    {
      key: 'details',
      label: 'Details',
      render: (log: AuditLog) => (
        <span className="text-sm text-gray-400">
          {log.targetName
            ? `${log.targetName}`
            : typeof log.details === 'string'
              ? log.details
              : log.details
                ? JSON.stringify(log.details).slice(0, 80)
                : '--'}
        </span>
      ),
    },
    {
      key: 'ip',
      label: 'IP Address',
      render: (log: AuditLog) => (
        <span className="text-xs font-mono text-gray-500">{log.ip || '--'}</span>
      ),
    },
    {
      key: 'timestamp',
      label: 'Timestamp',
      render: (log: AuditLog) => (
        <span className="text-sm text-gray-400">{formatters.datetime(log.timestamp)}</span>
      ),
    },
  ];

  return (
    <div className="om-fade space-y-6">
      <Kpis min={200} items={[
        { label: 'Total Logs', value: total.toLocaleString('en-IN') },
        { label: 'Today', value: logs.filter((l) => new Date(l.timestamp).toDateString() === new Date().toDateString()).length, tone: 'var(--info)' },
        { label: 'This Week', value: logs.filter((l) => { const w = new Date(); w.setDate(w.getDate() - 7); return new Date(l.timestamp) > w; }).length, tone: 'var(--success)' },
      ]} />

      <Toolbar search={{ value: search, onChange: setSearch, placeholder: 'Search actor, action…' }} />
      <DateRangePicker startDate={startDate} endDate={endDate} onStartDateChange={setStartDate} onEndDateChange={setEndDate} />

      {/* Table */}
      <div className="card">
        <DataTable
          data={logs}
          columns={columns}
          currentPage={page}
          totalPages={Math.ceil(total / limit)}
          onPageChange={setPage}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
};
