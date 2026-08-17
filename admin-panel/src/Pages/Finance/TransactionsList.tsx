// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { FileText, Download } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { SearchBar } from '../../components/SearchBar';
import { Kpis, Toolbar, AvatarCell } from '../../components/design';
import { DateRangePicker } from '../../components/DateRangePicker';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import type { Transaction } from '../../types';
import toast from 'react-hot-toast';

export const TransactionsList: React.FC = () => {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  useEffect(() => {
    loadTransactions();
  }, [page, debouncedSearch, typeFilter, statusFilter, startDate, endDate]);

  const loadTransactions = async () => {
    setIsLoading(true);
    try {
      const response = await api.finance.getTransactions(
        page,
        limit,
        typeFilter === 'ALL' ? undefined : typeFilter,
        statusFilter === 'ALL' ? undefined : statusFilter,
        startDate || undefined,
        endDate || undefined
      );
      if (response.success && response.data) {
        setTransactions(response.data);
        setTotal(response.pagination?.total || 0);
      }
    } catch (error) {
      toast.error('Failed to load transactions');
    } finally {
      setIsLoading(false);
    }
  };

  const getTransactionTypeBadge = (type: string) => {
    const colors: Record<string, string> = {
      DEPOSIT: 'bg-green-500/20 text-green-500',
      WITHDRAWAL: 'bg-red-500/20 text-red-500',
      BET_PLACED: 'bg-blue-500/20 text-blue-500',
      BET_WIN: 'bg-gold-500/20 text-gold-500',
      BET_LOSS: 'bg-gray-500/20 text-gray-500',
      BET_REFUND: 'bg-purple-500/20 text-purple-500',
      ADMIN_ADJUSTMENT: 'bg-orange-500/20 text-orange-500',
    };

    return (
      <span className={`px-2 py-1 rounded-sm text-xs font-medium ${colors[type] || colors.DEPOSIT}`}>
        {type.replace(/_/g, ' ')}
      </span>
    );
  };

  const columns = [
    {
      key: 'id',
      label: 'Reference',
      render: (tx: Transaction) => (
        <div>
          <span className="text-xs font-mono text-gold-400">{tx.referenceId || tx._id.slice(-10)}</span>
          <p className="text-xs text-gray-500 font-mono">{tx._id.slice(-8)}</p>
        </div>
      ),
    },
    {
      key: 'user',
      label: 'User',
      render: (tx: Transaction) => (
        <AvatarCell
          name={typeof tx.userId === 'object' ? tx.userId.username : String(tx.userId)}
          sub={typeof tx.userId === 'object' ? tx.userId._id.slice(-8) : String(tx.userId).slice(-8)}
          index={Math.max(0, transactions.indexOf(tx))}
        />
      ),
    },
    {
      key: 'type',
      label: 'Type',
      render: (tx: Transaction) => getTransactionTypeBadge(tx.type),
    },
    {
      key: 'amount',
      label: 'Amount',
      render: (tx: Transaction) => (
        <span
          className={`font-semibold ${
            tx.type === 'DEPOSIT' || tx.type === 'BET_WIN'
              ? 'text-green-500'
              : 'text-red-500'
          }`}
        >
          {tx.type === 'DEPOSIT' || tx.type === 'BET_WIN' ? '+' : '-'}
          {formatters.currency(tx.amount)}
        </span>
      ),
    },
    {
      key: 'balanceType',
      label: 'Balance Type',
      render: (tx: Transaction) => (
        <span className="text-xs">
          {tx.balanceType === 'DEPOSIT' ? '💰 Deposit' : tx.balanceType === 'WINNINGS' ? '🏆 Winnings' : '💰🏆 Both'}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (tx: Transaction) => (
        <StatusBadge
          status={tx.status}
          type="order"
        />
      ),
    },
    {
      key: 'timestamp',
      label: 'Date & Time',
      render: (tx: Transaction) => (
        <span className="text-sm text-gray-400">{formatters.datetime(tx.timestamp)}</span>
      ),
    },
  ];

  const totalDeposits = transactions
    .filter((t) => t.type === 'DEPOSIT' && t.status === 'SUCCESS')
    .reduce((sum, t) => sum + t.amount, 0);

  const totalWithdrawals = transactions
    .filter((t) => t.type === 'WITHDRAWAL' && t.status === 'SUCCESS')
    .reduce((sum, t) => sum + t.amount, 0);

  const totalBets = transactions
    .filter((t) => t.type === 'BET_PLACED')
    .reduce((sum, t) => sum + t.amount, 0);

  return (
    <div className="om-fade">
      <Kpis items={[
        { label: 'Total Transactions', value: total.toLocaleString('en-IN') },
        { label: 'Total Deposits', value: formatters.currency(totalDeposits), tone: 'var(--success)' },
        { label: 'Total Withdrawals', value: formatters.currency(totalWithdrawals), tone: 'var(--danger)' },
        { label: 'Total Bets', value: formatters.currency(totalBets), tone: 'var(--info)' },
      ]} />

      <Toolbar
        tabs={[
          { label: 'All', active: typeFilter === 'ALL', onClick: () => setTypeFilter('ALL') },
          { label: 'Deposits', active: typeFilter === 'DEPOSIT', onClick: () => setTypeFilter('DEPOSIT') },
          { label: 'Withdrawals', active: typeFilter === 'WITHDRAWAL', onClick: () => setTypeFilter('WITHDRAWAL') },
          { label: 'Bets', active: typeFilter === 'BET_PLACED', onClick: () => setTypeFilter('BET_PLACED') },
          { label: 'Adjustments', active: typeFilter === 'ADMIN_ADJUSTMENT', onClick: () => setTypeFilter('ADMIN_ADJUSTMENT') },
        ]}
        search={{ value: search, onChange: setSearch, placeholder: 'Search txn id, player, ref…' }}
      />

      {/* Secondary filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input" style={{ width: 160 }}>
          <option value="ALL">All Status</option>
          <option value="SUCCESS">Success</option>
          <option value="PENDING">Pending</option>
          <option value="FAILED">Failed</option>
        </select>
        <DateRangePicker startDate={startDate} endDate={endDate} onStartDateChange={setStartDate} onEndDateChange={setEndDate} />
      </div>

      {/* Table */}
      <div className="card">
        <DataTable
          data={transactions}
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
