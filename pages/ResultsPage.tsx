// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import React, { useState } from 'react';
import { useGame } from '../services/GameContext';
import { CycleType, BettingSide } from '../types';

const GAME_TAG = { label: '🎯 Bazaar', color: '#D4AF37', bg: 'rgba(212,175,55,0.1)' };

function gameTag(cycleId: string, cycleType?: string) {
  const id = (cycleId || '').toLowerCase();
  const t  = (cycleType || '').toLowerCase();
  if (t.includes('crash') || id.includes('crash'))  return { label: '✈️ Crash',  color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' };
  if (t.includes('casino') || id.includes('casino')) return { label: '🃏 Casino', color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' };
  if (t.includes('sport') || id.includes('sport'))  return { label: '⚽ Sports', color: '#34d399', bg: 'rgba(52,211,153,0.1)' };
  return GAME_TAG;
}

const ResultsPage: React.FC = () => {
  const { pastCycles } = useGame();
  const [viewCycle, setViewCycle] = useState<CycleType>(CycleType.THIRTY_MIN);
  const filteredCycles = pastCycles.filter(c => c.type === viewCycle);

  return (
    <div className="h-full flex flex-col bg-[#0B0E14] overflow-hidden">
      <div className="flex-shrink-0 p-4 border-b border-[#121826] bg-[#0B0E14] flex justify-between items-center z-10 shadow-md">
        <div>
          <h1 className="text-xl font-bold text-[#EAEAEA]">Results</h1>
          <p className="text-[10px] text-slate-500 mt-0.5">Delhi Bazaar · Official results</p>
        </div>
        <div className="flex bg-[#121826] rounded-lg p-1 border border-white/10">
          <button onClick={() => setViewCycle(CycleType.THIRTY_MIN)}
            className={`px-3 py-1 text-xs rounded font-bold transition-all ${viewCycle === CycleType.THIRTY_MIN ? 'bg-[#D4AF37] text-black' : 'text-[#9AA0A6]'}`}>
            30 Min
          </button>
          <button onClick={() => setViewCycle(CycleType.FULL_DAY)}
            className={`px-3 py-1 text-xs rounded font-bold transition-all ${viewCycle === CycleType.FULL_DAY ? 'bg-[#D4AF37] text-black' : 'text-[#9AA0A6]'}`}>
            Full Day
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {filteredCycles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-[#9AA0A6]">
            <span className="text-4xl mb-2">📊</span>
            <p className="text-sm">No results available yet.</p>
          </div>
        ) : (
          filteredCycles.map((cycle) => {
            const date       = new Date(cycle.endTime);
            const dateStr    = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
            const timeStr    = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const totalPool  = cycle.totalDelhi + cycle.totalBombay;
            const winner     = cycle.winner || cycle.pendingResult;
            const tag        = gameTag(cycle.id, cycle.type);

            return (
              <div key={cycle.id} className="bg-[#1A1F2E] rounded-xl overflow-hidden border border-[#D4AF37]/10 shadow-lg">
                <div className="bg-[#121826] px-4 py-2 flex justify-between items-center border-b border-white/5">
                  <div className="flex items-center gap-2">
                    {/* Game source tag */}
                    <span className="text-[9px] font-black px-2 py-0.5 rounded-full"
                      style={{ color: tag.color, background: tag.bg, border: `1px solid ${tag.color}30` }}>
                      {tag.label}
                    </span>
                    <span className="text-[#9AA0A6] text-[10px] font-mono">#{cycle.id.slice(-6)}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-[#EAEAEA] text-xs font-bold font-mono">{dateStr}</div>
                    <div className="text-[#D4AF37] text-[10px] font-mono">{timeStr}</div>
                  </div>
                </div>

                <div className="p-4 flex items-center justify-between">
                  <div className="flex flex-col items-center justify-center w-1/3 border-r border-white/5 pr-4">
                    <div className={`text-4xl font-black ${winner === BettingSide.DELHI ? 'text-[#E53935]' : 'text-[#1E88E5]'}`}>
                      {winner === BettingSide.DELHI ? 'D' : 'B'}
                    </div>
                    <div className="text-[10px] uppercase text-[#9AA0A6] mt-1 tracking-widest">Winner</div>
                    <div className={`text-[9px] font-bold mt-1 ${winner === BettingSide.DELHI ? 'text-[#E53935]' : 'text-[#1E88E5]'}`}>
                      {winner === BettingSide.DELHI ? 'DELHI' : 'BOMBAY'}
                    </div>
                  </div>
                  <div className="flex-1 pl-4 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-[#E53935] font-bold">Delhi Pool</span>
                      <span className="text-xs text-[#EAEAEA]">₹{(cycle.totalDelhi/1000).toFixed(1)}k</span>
                    </div>
                    <div className="w-full h-1.5 bg-[#121826] rounded-full overflow-hidden">
                      <div className="h-full bg-[#E53935] rounded-full" style={{ width: totalPool > 0 ? `${(cycle.totalDelhi/totalPool)*100}%` : '50%' }} />
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-xs text-[#1E88E5] font-bold">Bombay Pool</span>
                      <span className="text-xs text-[#EAEAEA]">₹{(cycle.totalBombay/1000).toFixed(1)}k</span>
                    </div>
                    <div className="w-full h-1.5 bg-[#121826] rounded-full overflow-hidden">
                      <div className="h-full bg-[#1E88E5] rounded-full" style={{ width: totalPool > 0 ? `${(cycle.totalBombay/totalPool)*100}%` : '50%' }} />
                    </div>
                    <div className="flex justify-between items-center pt-1 border-t border-white/5">
                      <span className="text-[10px] text-slate-500">Total Pool</span>
                      <span className="text-[10px] font-bold text-[#D4AF37]">₹{(totalPool/1000).toFixed(1)}k</span>
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

export default ResultsPage;
