// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { History, Download } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { SearchBar } from '../../components/SearchBar';
import { DateRangePicker } from '../../components/DateRangePicker';
import { Kpis, Toolbar } from '../../components/design';
import { Modal } from '../../components/Modal';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import type { Cycle } from '../../types';
import toast from 'react-hot-toast';

export const CycleHistory: React.FC = () => {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedCycle, setSelectedCycle] = useState<Cycle | null>(null);

  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  useEffect(() => { loadCycles(); }, [page, debouncedSearch, typeFilter, startDate, endDate]);

  const loadCycles = async () => {
    setIsLoading(true);
    try {
      const response = await api.cycles.getHistory(page, limit, typeFilter === 'ALL' ? undefined : typeFilter);
      if (response.success && response.data) {
        setCycles(response.data);
        setTotal(response.pagination?.total || 0);
      }
    } catch (error) {
      toast.error('Failed to load cycle history');
    } finally {
      setIsLoading(false);
    }
  };

  // Net Revenue = losing side stake − winning side stake + retained winnings fee
  // = realPool - netPaidOut = netProfit stored in DB; netPaidOut is after fee
  // We also show the loser/winner split visually
  const getNetRevenue = (cycle: Cycle) => cycle.netProfit || 0;

  const getLoserWinnerSplit = (cycle: Cycle) => {
    if (!cycle.winner) return { loserBets: 0, winnerBets: 0 };
    const loserBets  = cycle.winner === 'DELHI'  ? (cycle.realBombay || 0) : (cycle.realDelhi || 0);
    const winnerBets = cycle.winner === 'DELHI'  ? (cycle.realDelhi  || 0) : (cycle.realBombay || 0);
    return { loserBets, winnerBets };
  };

  const getCycleTypeBadge = (type: string) =>
    type === '30_MIN' ? (
      <span className="px-2 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-500">30 MIN</span>
    ) : (
      <span className="px-2 py-1 rounded text-xs font-medium bg-purple-500/20 text-purple-500">FULL DAY</span>
    );

  const columns = [
    {
      key: 'cycleId', label: 'Cycle ID',
      render: (cycle: Cycle) => (
        <div>
          <p className="font-mono font-semibold text-xs text-gold-400">{cycle.cycleId}</p>
          {getCycleTypeBadge(cycle.type)}
        </div>
      ),
    },
    {
      key: 'period', label: 'Period',
      render: (cycle: Cycle) => (
        <div className="text-xs">
          <p className="text-gray-300">▶ {formatters.datetime(new Date(cycle.startTime))}</p>
          <p className="text-gray-500">⏹ {formatters.datetime(new Date(cycle.endTime))}</p>
        </div>
      ),
    },
    {
      key: 'pools', label: 'Real Pools',
      render: (cycle: Cycle) => (
        <div className="text-sm">
          <p><span className="text-gray-400">Delhi:</span> <span className="text-red-400">{formatters.currency(cycle.realDelhi || 0)}</span></p>
          <p><span className="text-gray-400">Bombay:</span> <span className="text-blue-400">{formatters.currency(cycle.realBombay || 0)}</span></p>
        </div>
      ),
    },
    {
      key: 'winner', label: 'Winner',
      render: (cycle: Cycle) => (
        cycle.winner ? (
          <span className={`font-bold text-sm ${cycle.winner === 'DELHI' ? 'text-red-400' : 'text-blue-400'}`}>
            {cycle.winner}
          </span>
        ) : <span className="text-gray-500">-</span>
      ),
    },
    {
      key: 'revenue', label: 'Net Revenue',
      render: (cycle: Cycle) => {
        const rev = getNetRevenue(cycle);
        return (
          <span className={`font-semibold text-sm ${rev > 0 ? 'text-green-400' : rev < 0 ? 'text-red-400' : 'text-gray-500'}`}>
            {cycle.winner ? formatters.currency(rev) : '-'}
          </span>
        );
      },
    },
    {
      key: 'payout', label: 'Paid Out',
      render: (cycle: Cycle) => (
        <span className="text-orange-400 font-medium text-sm">
          {cycle.totalPaidOut ? formatters.currency(cycle.totalPaidOut) : '-'}
        </span>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: (cycle: Cycle) => <StatusBadge status={cycle.status} type="cycle" />,
    },
    {
      key: 'actions', label: '',
      render: (cycle: Cycle) => (
        <button onClick={() => setSelectedCycle(cycle)} className="text-xs text-gold-400 hover:underline">
          Detail
        </button>
      ),
    },
  ];

  const totalNetRevenue = cycles.reduce((sum, c) => sum + getNetRevenue(c), 0);
  const totalPaidOut    = cycles.reduce((sum, c) => sum + (c.totalPaidOut || 0), 0);

  return (
    <div className="om-fade space-y-6">
      <Kpis items={[
        { label: 'Total Cycles', value: total },
        { label: '30-Min', value: cycles.filter((c) => c.type === '30_MIN').length, tone: 'var(--info)' },
        { label: 'Total Paid Out', value: formatters.currency(totalPaidOut), tone: 'var(--warning)' },
        { label: 'Net Revenue', value: formatters.currency(totalNetRevenue), tone: totalNetRevenue >= 0 ? 'var(--success)' : 'var(--danger)' },
      ]} />

      <Toolbar
        tabs={[
          { label: 'All', active: typeFilter === 'ALL', onClick: () => setTypeFilter('ALL') },
          { label: '30-Min', active: typeFilter === '30_MIN', onClick: () => setTypeFilter('30_MIN') },
          { label: 'Full Day', active: typeFilter === 'FULL_DAY', onClick: () => setTypeFilter('FULL_DAY') },
        ]}
        search={{ value: search, onChange: setSearch, placeholder: 'Search cycle id…' }}
      />
      <DateRangePicker startDate={startDate} endDate={endDate} onStartDateChange={setStartDate} onEndDateChange={setEndDate} />

      {/* Revenue formula explanation */}
      <div className="bg-dark-800 border border-dark-600 rounded-lg p-4 text-sm">
        <p className="font-semibold text-gray-300 mb-1">How Net Revenue is calculated per cycle:</p>
        <p className="text-gray-400">
          Net Revenue = <span className="text-red-400">Loser Side Real Bets</span> − <span className="text-blue-400">Winner Side Real Bets</span> + retained winnings fee.
          It is stored as Real Pool Total − Net Paid Out, where Net Paid Out is gross payout minus the winnings fee.
        </p>
        <p className="text-gray-500 text-xs mt-1">Phantom bets, merchant wallet top-ups/security deposits, and user token buy/sell cash flow are not platform revenue.</p>
      </div>

      <div className="card">
        <DataTable data={cycles} columns={columns} currentPage={page} totalPages={Math.ceil(total / limit)} onPageChange={setPage} isLoading={isLoading} />
      </div>

      {/* Cycle Detail Modal */}
      {selectedCycle && (
        <Modal isOpen={!!selectedCycle} onClose={() => setSelectedCycle(null)} title="Cycle Detail" size="lg">
          <div className="space-y-5">
            {/* Identity */}
            <div className="bg-dark-700 rounded-lg p-4">
              <p className="text-xs text-gray-400 mb-1">Unique Cycle ID</p>
              <p className="font-mono font-bold text-gold-400 text-lg">{selectedCycle.cycleId}</p>
              <div className="flex gap-2 mt-2">{getCycleTypeBadge(selectedCycle.type)} <StatusBadge status={selectedCycle.status} type="cycle" /></div>
            </div>

            {/* Timestamps */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-dark-700 rounded-lg p-3">
                <p className="text-xs text-gray-400 mb-1">▶ Started</p>
                <p className="text-sm font-medium">{formatters.datetime(new Date(selectedCycle.startTime))}</p>
              </div>
              <div className="bg-dark-700 rounded-lg p-3">
                <p className="text-xs text-gray-400 mb-1">⏹ Ended</p>
                <p className="text-sm font-medium">{formatters.datetime(new Date(selectedCycle.endTime))}</p>
              </div>
            </div>

            {/* Real pools breakdown */}
            <div>
              <p className="text-sm font-semibold text-gray-300 mb-2">Real User Bets (no phantom)</p>
              <div className="grid grid-cols-2 gap-4">
                <div className={`p-4 rounded-lg border ${selectedCycle.winner === 'DELHI' ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
                  <p className="text-xs text-gray-400 mb-1">DELHI {selectedCycle.winner === 'DELHI' ? '🏆 Winner' : '❌ Loser'}</p>
                  <p className="text-2xl font-bold text-red-400">{formatters.currency(selectedCycle.realDelhi || 0)}</p>
                </div>
                <div className={`p-4 rounded-lg border ${selectedCycle.winner === 'BOMBAY' ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
                  <p className="text-xs text-gray-400 mb-1">BOMBAY {selectedCycle.winner === 'BOMBAY' ? '🏆 Winner' : '❌ Loser'}</p>
                  <p className="text-2xl font-bold text-blue-400">{formatters.currency(selectedCycle.realBombay || 0)}</p>
                </div>
              </div>
            </div>

            {/* Phantom pools (info only) */}
            <div>
              <p className="text-sm font-semibold text-gray-400 mb-2">Phantom Bets (always lose, not counted in revenue)</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-dark-800 rounded-lg">
                  <p className="text-xs text-gray-500">Delhi Phantom</p>
                  <p className="font-medium text-gray-500">{formatters.currency(selectedCycle.phantomDelhi || 0)}</p>
                </div>
                <div className="p-3 bg-dark-800 rounded-lg">
                  <p className="text-xs text-gray-500">Bombay Phantom</p>
                  <p className="font-medium text-gray-500">{formatters.currency(selectedCycle.phantomBombay || 0)}</p>
                </div>
              </div>
            </div>

            {/* Net Revenue calculation */}
            {selectedCycle.winner && (
              <div className="bg-gold-500/10 border border-gold-500/30 rounded-lg p-4">
                <p className="text-sm font-semibold text-gold-400 mb-3">Net Revenue Breakdown</p>
                {(() => {
                  const { loserBets, winnerBets } = getLoserWinnerSplit(selectedCycle);
                  const netRev = getNetRevenue(selectedCycle);
                  return (
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Loser Side Bets ({selectedCycle.winner === 'DELHI' ? 'BOMBAY' : 'DELHI'}):</span>
                        <span className="text-green-400 font-medium">{formatters.currency(loserBets)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Winner Side Stake ({selectedCycle.winner}):</span>
                        <span className="text-green-400 font-medium">{formatters.currency(winnerBets)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Net Paid Out to Winners ({selectedCycle.winner}):</span>
                        <span className="text-red-400 font-medium">− {formatters.currency(selectedCycle.totalPaidOut || 0)}</span>
                      </div>
                      <div className="flex justify-between pt-2 border-t border-dark-600">
                        <span className="font-semibold text-gray-200">Net Revenue:</span>
                        <span className={`font-bold text-lg ${netRev >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatters.currency(netRev)}
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};
