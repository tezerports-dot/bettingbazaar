// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState, useEffect, useCallback } from 'react';
// M-05 note: HistoryPage shows GAME cycle history (bets placed, wins) — not wallet ledger.

// If a bet-history row rendering is added here, import normalizeTransaction from walletTransactionDTO.
import { useGame } from '../services/GameContext';
import { CycleType, BettingSide, GameCycle } from '../types';
import { getBackend } from '../services/backend.service';

const backend = getBackend();

function gameTag(cycleId: string, cycleType?: string) {
  const id = (cycleId || '').toLowerCase();
  const t  = (cycleType || '').toLowerCase();
  if (t.includes('crash') || id.includes('crash'))   return { label: '✈️ Crash',  color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' };
  if (t.includes('casino') || id.includes('casino')) return { label: '🃏 Casino', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' };
  if (t.includes('sport') || id.includes('sport'))   return { label: '⚽ Sports', color: '#34d399', bg: 'rgba(52,211,153,0.1)' };
  return { label: '🎯 Bazaar', color: '#D4AF37', bg: 'rgba(212,175,55,0.1)' };
}


const HistoryPage: React.FC = () => {
  const { pastCycles } = useGame();
  const [viewCycle, setViewCycle]       = useState<CycleType>(CycleType.THIRTY_MIN);
  const [fetchedCycles, setFetchedCycles] = useState<GameCycle[] | null>(null);
  const [isLoading, setIsLoading]       = useState(false);

  // Fetch directly from API per tab so type filter and limit are correct.
  // Context cache is unfiltered and capped at 50 — this fetches 100 of the right type.
  const fetchHistory = useCallback(async (type: CycleType) => {
    setIsLoading(true);
    setFetchedCycles(null);
    try {
      const typeParam = type === CycleType.THIRTY_MIN ? '30_MIN' : 'FULL_DAY';
      const res: any = await (backend as any).request(`/v1/game/cycles/history?type=${typeParam}&limit=100`);
      const list: GameCycle[] = (res?.cycles || []).filter((c: any) => c && c.endTime);
      setFetchedCycles(list);
    } catch {
      // Fallback: filter context cache
      setFetchedCycles(pastCycles.filter(c => c.type === type));
    } finally {
      setIsLoading(false);
    }
  }, [pastCycles]);

  useEffect(() => { fetchHistory(viewCycle); }, [viewCycle]); // eslint-disable-line

  const filteredCycles = fetchedCycles ?? pastCycles.filter(c => c.type === viewCycle);

  return (
    <div className="h-full flex flex-col bg-[#0B0E14] overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-[#121826] bg-[#0B0E14] flex justify-between items-center z-10 shadow-md">
        <h1 className="text-xl font-bold text-[#EAEAEA]">Game History</h1>
        
        {/* Toggle */}
        <div className="flex bg-[#121826] rounded-lg p-1 border border-white/10">
           <button 
             onClick={() => setViewCycle(CycleType.THIRTY_MIN)}
             className={`px-3 py-1 text-xs rounded font-bold transition-all ${viewCycle === CycleType.THIRTY_MIN ? 'bg-[#D4AF37] text-black' : 'text-[#9AA0A6]'}`}
           >
             30 Min
           </button>
           <button 
             onClick={() => setViewCycle(CycleType.FULL_DAY)}
             className={`px-3 py-1 text-xs rounded font-bold transition-all ${viewCycle === CycleType.FULL_DAY ? 'bg-[#D4AF37] text-black' : 'text-[#9AA0A6]'}`}
           >
             Full Day
           </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-64 text-[#9AA0A6]">
            <div className="w-8 h-8 border-2 border-[#D4AF37] border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-sm">Loading history…</p>
          </div>
        ) : filteredCycles.length === 0 ? (
           <div className="flex flex-col items-center justify-center h-64 text-[#9AA0A6]">
              <span className="text-4xl mb-2">⏳</span>
              <p className="text-sm">No {viewCycle === CycleType.FULL_DAY ? 'Full Day' : '30 Min'} games completed yet.</p>
           </div>
        ) : (
           filteredCycles.map((cycle) => {
             // Safety checks for cycle data
             if (!cycle || !cycle.endTime) return null;
             
             const date = new Date(cycle.endTime);
             const dateString = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
             const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
             const totalPool = (cycle.totalDelhi ?? 0) + (cycle.totalBombay ?? 0);
             const winner = cycle.winner || cycle.pendingResult;

             return (
              <div key={cycle.id} className="bg-[#1A1F2E] rounded-xl overflow-hidden border border-[#D4AF37]/10 flex flex-col shadow-lg">
                 {/* Header of Card */}
                 <div className="bg-[#121826] px-4 py-2 flex justify-between items-center border-b border-white/5">
                    <div className="flex items-center gap-2">
                      {(() => { const tag = gameTag(cycle.id, cycle.type as string); return (
                        <span className="text-[9px] font-black px-2 py-0.5 rounded-full"
                          style={{ color: tag.color, background: tag.bg, border: `1px solid ${tag.color}30` }}>
                          {tag.label}
                        </span>
                      ); })()}
                      <span className="text-[#9AA0A6] text-[10px] font-mono">#{cycle.id.slice(-6)}</span>
                    </div>
                    <span className="text-[#EAEAEA] text-xs font-bold font-mono">
                      {dateString} <span className="text-[#D4AF37] mx-1">•</span> {timeString}
                    </span>
                 </div>
                 
                 {/* Body */}
                 <div className="p-4 flex items-center justify-between">
                    {/* Winner Big Display */}
                    <div className="flex flex-col items-center justify-center w-1/3 border-r border-white/5 pr-4">
                       <div className={`text-4xl font-black ${winner === BettingSide.DELHI ? 'text-[#E53935]' : 'text-[#1E88E5]'}`}>
                         {winner === BettingSide.DELHI ? 'D' : 'B'}
                       </div>
                       <div className="text-[10px] uppercase text-[#9AA0A6] mt-1 tracking-widest">Winner</div>
                    </div>
                    
                    {/* Pools */}
                    <div className="flex-1 pl-4 space-y-2">
                       <div className="flex justify-between items-center">
                          <span className="text-xs text-[#E53935] font-bold">Delhi Pool</span>
                          <span className="text-xs text-[#EAEAEA]">₹ {((cycle.totalDelhi ?? 0)/1000).toFixed(1)}k</span>
                       </div>
                       <div className="w-full h-1 bg-[#121826] rounded-full overflow-hidden">
                          <div className="h-full bg-[#E53935]" style={{ width: totalPool > 0 ? `${((cycle.totalDelhi ?? 0) / totalPool)*100}%` : '50%' }}></div>
                       </div>
                       
                       <div className="flex justify-between items-center mt-2">
                          <span className="text-xs text-[#1E88E5] font-bold">Bombay Pool</span>
                          <span className="text-xs text-[#EAEAEA]">₹ {((cycle.totalBombay ?? 0)/1000).toFixed(1)}k</span>
                       </div>
                       <div className="w-full h-1 bg-[#121826] rounded-full overflow-hidden">
                          <div className="h-full bg-[#1E88E5]" style={{ width: totalPool > 0 ? `${((cycle.totalBombay ?? 0) / totalPool)*100}%` : '50%' }}></div>
                       </div>
                    </div>
                 </div>
              </div>
             );
           })
        )}
      </div>

    </div>
  );
};

export default HistoryPage;
