// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Activity, RefreshCw, Play, Pause, XCircle } from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import sseService from '../../services/sse';
import type { Cycle } from '../../types';
import toast from 'react-hot-toast';

export const LiveCycles: React.FC = () => {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<{ type: string; cycle: Cycle } | null>(null);

  useEffect(() => {
    loadCycles(); // one HTTP seed on mount

    // cycle_update carries all pool data — update state directly, no HTTP
    const handleCycleUpdate = (update: any) => {
      setCycles(prev => prev.map(c =>
        c.cycleId === update.cycleId
          ? {
              ...c,
              status:        update.status        || c.status,
              totalDelhi:    update.totalDelhi  ?? c.totalDelhi,
              totalBombay:   update.totalBombay ?? c.totalBombay,
              realDelhi:     update.realDelhi   ?? c.realDelhi,
              realBombay:    update.realBombay  ?? c.realBombay,
              phantomDelhi:  update.phantomDelhi  ?? c.phantomDelhi,
              phantomBombay: update.phantomBombay ?? c.phantomBombay,
            }
          : c
      ));
    };

    // Only do HTTP on structural changes (new cycle, result, cancel)
    const handleNewCycle    = () => { loadCycles(); };
    const handleCycleResult = () => { loadCycles(); };

    
    sseService.on('admin_new_cycle',    handleCycleUpdate); // §11: backend emits admin_new_cycle via private admin SSE
    sseService.on('cycle_update',       handleCycleUpdate); // fallback if WS also carries it

    // new_cycle / cycle_result are public events — now arrive via SSE
    sseService.on('new_cycle',    handleNewCycle);
    sseService.on('cycle_result', handleCycleResult);

    return () => {
      sseService.off('admin_new_cycle',    handleCycleUpdate);
      sseService.off('cycle_update',       handleCycleUpdate);
      sseService.off('new_cycle',    handleNewCycle);
      sseService.off('cycle_result', handleCycleResult);
    };
  }, []);

  const loadCycles = async () => {
    try {
      // Admin-only endpoint — returns realDelhi, realBombay, phantomDelhi, phantomBombay.
      // Public /cycles/active strips all real/phantom fields (sanitiseCycleForUser).
      const response = await api.get<any>('/api/admin/cycles/phases');
      if (response.data?.success && response.data?.cycles) {
        setCycles(response.data.cycles.map((c: any) => ({
          cycleId:       c.cycleId,
          type:          c.type,
          status:        c.status,
          startTime:     c.startTime,
          endTime:       c.endTime,
          totalDelhi:    c.pools?.totalDelhi    || 0,
          totalBombay:   c.pools?.totalBombay   || 0,
          realDelhi:     c.pools?.realDelhi     || 0,
          realBombay:    c.pools?.realBombay    || 0,
          phantomDelhi:  c.pools?.phantomDelhi  || 0,
          phantomBombay: c.pools?.phantomBombay || 0,
          phantomBalanced: c.phantomBalanced    || false,
          currentPhase:  c.currentPhase,
        })));
      }
    } catch (error) {
      toast.error('Failed to load cycles');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTriggerEqualizer = async (cycleId: string) => {
    try {
      await api.cycles.triggerEqualizer(cycleId);
      toast.success('Phantom equalizer triggered');
      loadCycles();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to trigger equalizer');
    }
  };

  const handlePauseCycle = async (cycleId: string) => {
    try {
      await api.cycles.pauseCycle(cycleId);
      toast.success('Cycle paused');
      loadCycles();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to pause cycle');
    }
  };

  const handleResumeCycle = async (cycleId: string) => {
    try {
      await api.cycles.resumeCycle(cycleId);
      toast.success('Cycle resumed');
      loadCycles();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to resume cycle');
    }
  };

  const handleCancelCycle = async (cycleId: string) => {
    try {
      await api.cycles.cancelCycle(cycleId, 'Cancelled by admin');
      toast.success('Cycle cancelled - all bets refunded');
      loadCycles();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to cancel cycle');
    }
  };

  const getTimeRemaining = (endTime: number): string => {
    const now = Date.now();
    const diff = endTime - now;

    if (diff <= 0) return '00:00';

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  const getCycleTypeBadge = (type: string) => {
    return type === '30_MIN' ? (
      <span className="px-2 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-500">
        30 MIN
      </span>
    ) : (
      <span className="px-2 py-1 rounded text-xs font-medium bg-purple-500/20 text-purple-500">
        FULL DAY
      </span>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">Live Cycles</h1>
          <p className="text-gray-400">
            ✅ Only 2 cycle types (FIX #1) | ✅ Full day starts 6:00 PM IST (FIX #3)
          </p>
        </div>
        <button onClick={loadCycles} className="btn-secondary flex items-center">
          <RefreshCw size={16} className="mr-2" />
          Refresh
        </button>
      </div>

      {/* Info Banner */}
      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
        <div className="text-sm space-y-1">
          <p className="font-semibold text-blue-400">Cycle System (ALL FIXES APPLIED)</p>
          <ul className="space-y-1 text-gray-300">
            <li>• <strong>30-MIN:</strong> Runs every 30 minutes at :00 and :30</li>
            <li>• <strong>FULL DAY:</strong> Starts 6:00 PM IST (18:00), ends 6:00 PM next day</li>
            <li>• <strong>Real Pool:</strong> Actual user bets (shown separately)</li>
            <li>• <strong>Phantom Pool:</strong> Phantom manager bets (balances pools)</li>
            <li>• <strong>Phantom Equalizer:</strong> Runs at 28th min (30-min) / 17:58 IST (full-day)</li>
            <li>• <strong>Winner:</strong> Based ONLY on real bets (phantom bets always lose)</li>
          </ul>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <p className="text-sm text-gray-400 mb-1">Active Cycles</p>
          <p className="text-2xl font-bold">{cycles.length}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-400 mb-1">30-Min Cycles</p>
          <p className="text-2xl font-bold text-blue-500">
            {cycles.filter((c) => c.type === '30_MIN').length}
          </p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-400 mb-1">Full Day Cycles</p>
          <p className="text-2xl font-bold text-purple-500">
            {cycles.filter((c) => c.type === 'FULL_DAY').length}
          </p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-400 mb-1">Total Real Bets</p>
          <p className="text-2xl font-bold text-gold-500">
            {cycles.reduce((sum, c) => sum + (c.realDelhi || 0) + (c.realBombay || 0), 0).toLocaleString()}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">Phantom excluded</p>
        </div>
      </div>

      {/* Cycles Grid */}
      {cycles.length === 0 ? (
        <div className="card text-center py-12">
          <Activity size={48} className="mx-auto mb-4 text-gray-600" />
          <p className="text-gray-400">No active cycles</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {cycles.map((cycle) => (
            <div key={cycle._id} className="card">
              {/* Header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-2">
                  {getCycleTypeBadge(cycle.type)}
                  <StatusBadge status={cycle.status} type="cycle" />
                </div>
                <p className="text-sm text-gray-400">{cycle.cycleId}</p>
              </div>

              {/* Timer */}
              <div className="text-center mb-4">
                <p className="text-sm text-gray-400 mb-1">Time Remaining</p>
                <p className="text-3xl font-mono font-bold text-gold-500">
                  {getTimeRemaining(cycle.endTime)}
                </p>
                {cycle.type === 'FULL_DAY' && (
                  <p className="text-xs text-gray-500 mt-1">Result at 6:00 PM IST</p>
                )}
              </div>

              {/* Pool Display (FIX #2, #6) */}
              <div className="space-y-3 mb-4">
                <div className="grid grid-cols-2 gap-3">
                  {/* Delhi Pools */}
                  <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                    <p className="text-xs text-gray-400 mb-1">DELHI</p>
                    <p className="text-xl font-bold text-red-500">
                      {formatters.currency(cycle.totalDelhi)}
                    </p>
                    <div className="text-xs text-gray-500 mt-2 space-y-1">
                      <p>Real: {formatters.currency(cycle.realDelhi)}</p>
                      <p>Phantom: {formatters.currency(cycle.phantomDelhi)}</p>
                    </div>
                  </div>

                  {/* Bombay Pools */}
                  <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                    <p className="text-xs text-gray-400 mb-1">BOMBAY</p>
                    <p className="text-xl font-bold text-blue-500">
                      {formatters.currency(cycle.totalBombay)}
                    </p>
                    <div className="text-xs text-gray-500 mt-2 space-y-1">
                      <p>Real: {formatters.currency(cycle.realBombay)}</p>
                      <p>Phantom: {formatters.currency(cycle.phantomBombay)}</p>
                    </div>
                  </div>
                </div>

                {/* Phantom Status (FIX #6) */}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-400">Phantom Equalizer:</span>
                  {cycle.phantomBalanced ? (
                    <span className="text-green-500 font-medium">✓ Balanced</span>
                  ) : (
                    <span className="text-yellow-500 font-medium">Pending</span>
                  )}
                </div>
                {cycle.phantomBetsClosed && (
                  <div className="bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1">
                    <p className="text-xs text-orange-400">🔒 Phantom bets closed</p>
                  </div>
                )}
              </div>

              {/* Winner Display */}
              {cycle.winner && (
                <div className="bg-gold-500/10 border border-gold-500/30 rounded-lg p-3 mb-4">
                  <p className="text-sm text-gray-400 mb-1">Winner</p>
                  <p className="text-xl font-bold text-gold-500">{cycle.winner}</p>
                  {cycle.totalPaidOut && (
                    <p className="text-xs text-gray-500 mt-1">
                      Paid out: {formatters.currency(cycle.totalPaidOut)}
                    </p>
                  )}
                </div>
              )}

              {/* Admin Actions */}
              <div className="flex flex-wrap gap-2">
                {!cycle.phantomBalanced && cycle.status === 'OPEN' && (
                  <button
                    onClick={() => setConfirmAction({ type: 'equalizer', cycle })}
                    className="btn-secondary text-sm"
                  >
                    Trigger Equalizer
                  </button>
                )}
                {cycle.status === 'OPEN' && (
                  <>
                    <button
                      onClick={() => setConfirmAction({ type: 'pause', cycle })}
                      className="btn-secondary text-sm"
                    >
                      <Pause size={14} className="mr-1" />
                      Pause
                    </button>
                    <button
                      onClick={() => setConfirmAction({ type: 'cancel', cycle })}
                      className="bg-red-600 hover:bg-red-700 px-3 py-1 rounded-lg text-sm font-medium transition-colors"
                    >
                      <XCircle size={14} className="mr-1 inline" />
                      Cancel
                    </button>
                  </>
                )}
                {cycle.status === 'PAUSED' && (
                  <button
                    onClick={() => setConfirmAction({ type: 'resume', cycle })}
                    className="btn-primary text-sm"
                  >
                    <Play size={14} className="mr-1" />
                    Resume
                  </button>
                )}
              </div>

              {/* Timestamps */}
              <div className="mt-4 pt-4 border-t border-dark-700 text-xs text-gray-500">
                <p>Start: {formatters.datetime(new Date(cycle.startTime))}</p>
                <p>End: {formatters.datetime(new Date(cycle.endTime))}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirm Dialog */}
      {confirmAction && (
        <ConfirmDialog
          isOpen={!!confirmAction}
          onClose={() => setConfirmAction(null)}
          onConfirm={() => {
            switch (confirmAction.type) {
              case 'equalizer':
                handleTriggerEqualizer(confirmAction.cycle.cycleId);
                break;
              case 'pause':
                handlePauseCycle(confirmAction.cycle.cycleId);
                break;
              case 'resume':
                handleResumeCycle(confirmAction.cycle.cycleId);
                break;
              case 'cancel':
                handleCancelCycle(confirmAction.cycle.cycleId);
                break;
            }
          }}
          title={
            confirmAction.type === 'equalizer'
              ? 'Trigger Phantom Equalizer'
              : confirmAction.type === 'cancel'
              ? 'Cancel Cycle'
              : `${confirmAction.type.charAt(0).toUpperCase() + confirmAction.type.slice(1)} Cycle`
          }
          message={
            confirmAction.type === 'equalizer'
              ? 'This will balance phantom pools. Continue?'
              : confirmAction.type === 'cancel'
              ? 'All bets will be refunded. This cannot be undone!'
              : `Are you sure you want to ${confirmAction.type} this cycle?`
          }
          type={confirmAction.type === 'cancel' ? 'danger' : 'warning'}
          confirmText={confirmAction.type.charAt(0).toUpperCase() + confirmAction.type.slice(1)}
        />
      )}
    </div>
  );
};
