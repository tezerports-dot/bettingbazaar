// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { FileText, Download } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
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
  const [fieldFilter, setFieldFilter] = useState('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  useEffect(() => {
    loadTransactions();
  }, [page, debouncedSearch, typeFilter, fieldFilter, startDate, endDate]);

  const loadTransactions = async () => {
    setIsLoading(true);
    try {
      const response = await api.finance.getTransactions(
        page,
        limit,
        typeFilter === 'ALL' ? undefined : typeFilter,
        fieldFilter === 'ALL' ? undefined : fieldFilter,
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

  /**
   * A ledger row records a MOVEMENT: a direction and a pocket. It has no
   * "transaction type" and no status — it is written inside the same
   * transaction as the balance change, so a row existing IS the money having
   * moved. The badges below were coloured by DEPOSIT / WITHDRAWAL / BET_WIN /
   * BET_LOSS, an enum from the document collection this replaced; none of those
   * values has ever appeared in `tx_type`, so every row rendered the fallback.
   */
  const FIELD_LABEL: Record<Transaction['field'], string> = {
    depositBalance:  '💰 Deposit',
    winningsBalance: '🏆 Winnings',
    tokenBalance:    '🪙 Tokens',
    reserveBalance:  '🛟 Reserve',
    lockedBalance:   '🔒 Locked',
  };

  const directionBadge = (tx: Transaction) => (
    <span className={`px-2 py-1 rounded-sm text-xs font-medium ${
      tx.type === 'CREDIT' ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'
    }`}>
      {tx.type}
    </span>
  );

  const columns = [
    {
      key: 'txId',
      label: 'Reference',
      render: (tx: Transaction) => (
        <div>
          {/* The idempotency key IS the identity of the row, and it is what an
              operator needs to trace one movement across the ledger, the order
              and the wallet. It is shown whole, because a truncated key cannot
              be searched for. */}
          <span className="text-xs font-mono text-gold-400 break-all">{tx.txId}</span>
          {tx.refId ? <p className="text-xs text-gray-500 font-mono">{tx.refId}</p> : null}
        </div>
      ),
    },
    {
      key: 'user',
      label: 'User',
      render: (tx: Transaction) => (
        <AvatarCell
          // LEFT JOINed: the row outlives the account, and a deleted player must
          // not take their money's record off this screen.
          name={tx.user?.username || tx.userId}
          sub={tx.user?.mobile || tx.userId}
          index={Math.max(0, transactions.indexOf(tx))}
        />
      ),
    },
    { key: 'type',  label: 'Direction', render: directionBadge },
    {
      key: 'amount',
      label: 'Amount',
      render: (tx: Transaction) => (
        <span className={`font-semibold ${tx.type === 'CREDIT' ? 'text-green-500' : 'text-red-500'}`}>
          {tx.type === 'CREDIT' ? '+' : '-'}{formatters.currency(tx.amount)}
        </span>
      ),
    },
    {
      key: 'field',
      label: 'Pocket',
      render: (tx: Transaction) => (
        <span className="text-xs">{FIELD_LABEL[tx.field] || tx.field}</span>
      ),
    },
    {
      key: 'balance',
      label: 'Balance after',
      render: (tx: Transaction) => (
        <span className="text-sm text-gray-300">{formatters.currency(tx.balanceAfter)}</span>
      ),
    },
    {
      key: 'reason',
      label: 'Reason',
      render: (tx: Transaction) => (
        <span className="text-xs text-gray-400">{tx.reason}</span>
      ),
    },
    {
      key: 'createdAt',
      label: 'Date & Time',
      render: (tx: Transaction) => (
        <span className="text-sm text-gray-400">{formatters.datetime(tx.createdAt)}</span>
      ),
    },
  ];

  // Summed over the page the operator is looking at, by DIRECTION — the only
  // thing a ledger row says. These used to filter on `type === 'DEPOSIT'` and
  // `status === 'SUCCESS'`, neither of which a row carries, so all three tiles
  // read ₹0 on every page of a busy ledger.
  const sumWhere = (fn: (t: Transaction) => boolean) =>
    transactions.filter(fn).reduce((sum, t) => sum + t.amount, 0);
  const totalCredited = sumWhere((t) => t.type === 'CREDIT');
  const totalDebited  = sumWhere((t) => t.type === 'DEBIT');
  const totalStaked   = sumWhere((t) => t.field === 'lockedBalance' && t.type === 'CREDIT');

  return (
    <div className="om-fade">
      <Kpis items={[
        { label: 'Total Transactions', value: total.toLocaleString('en-IN') },
        { label: 'Credited (this page)', value: formatters.currency(totalCredited), tone: 'var(--success)' },
        { label: 'Debited (this page)', value: formatters.currency(totalDebited), tone: 'var(--danger)' },
        { label: 'Staked (this page)', value: formatters.currency(totalStaked), tone: 'var(--info)' },
      ]} />

      <Toolbar
        tabs={[
          { label: 'All', active: typeFilter === 'ALL', onClick: () => setTypeFilter('ALL') },
          /* CREDIT / DEBIT is what `tx_type` holds. These tabs used to send
             DEPOSIT / WITHDRAWAL / BET_PLACED / ADMIN_ADJUSTMENT — an enum from
             the collection this screen was written against — so choosing any of
             them filtered the ledger down to nothing and the operator was shown
             an empty table rather than an error. */
          { label: 'Credits', active: typeFilter === 'CREDIT', onClick: () => setTypeFilter('CREDIT') },
          { label: 'Debits', active: typeFilter === 'DEBIT', onClick: () => setTypeFilter('DEBIT') },
        ]}
        search={{ value: search, onChange: setSearch, placeholder: 'Search txn id, player, ref…' }}
      />

      {/* Secondary filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* The POCKET, which the route reads as `field`. This was a Status
            dropdown (Success / Pending / Failed) — a ledger row has no status,
            and the route never read the parameter, so it was a filter that
            looked applied and did nothing. */}
        <select aria-label="Filter transactions by wallet pocket" value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)} className="input" style={{ width: 180 }}>
          <option value="ALL">All pockets</option>
          <option value="depositBalance">Deposit</option>
          <option value="winningsBalance">Winnings</option>
          <option value="reserveBalance">Reserve</option>
          <option value="lockedBalance">Locked</option>
          <option value="tokenBalance">Tokens</option>
        </select>
        <DateRangePicker filters="transactions" startDate={startDate} endDate={endDate} onStartDateChange={setStartDate} onEndDateChange={setEndDate} />
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
