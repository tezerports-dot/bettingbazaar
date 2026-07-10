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

      {/* UX-1 fix (Phase D, 2026-07-10): dense single-row results — a screen
          now shows 12-15 results instead of 3-4. Each row: winner chip,
          cycle ref, date/time, pool split bar, total. */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {filteredCycles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-[#9AA0A6]">
            <span className="text-4xl mb-2">📊</span>
            <p className="text-sm">No results available yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/5 rounded-xl overflow-hidden border border-[#D4AF37]/10 bg-[#1A1F2E]">
            {filteredCycles.map((cycle) => {
              const date       = new Date(cycle.endTime);
              const dateStr    = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
              const timeStr    = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const totalPool  = cycle.totalDelhi + cycle.totalBombay;
              const winner     = cycle.winner || cycle.pendingResult;
              const isDelhi    = winner === BettingSide.DELHI;
              const tag        = gameTag(cycle.id, cycle.type);

              return (
                <div key={cycle.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.03] transition-colors">
                  {/* Winner chip */}
                  <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center font-black text-base ${
                    isDelhi ? 'bg-[#E53935]/15 text-[#E53935]' : 'bg-[#1E88E5]/15 text-[#1E88E5]'}`}>
                    {isDelhi ? 'D' : 'B'}
                  </div>

                  {/* Ref + time */}
                  <div className="flex-shrink-0 w-24">
                    <div className="flex items-center gap-1">
                      <span className="text-[9px]" style={{ color: tag.color }}>{tag.label.split(' ')[0]}</span>
                      <span className="text-[10px] text-[#9AA0A6] font-mono">#{cycle.id.slice(-6)}</span>
                    </div>
                    <div className="text-[9px] text-slate-500 font-mono">{dateStr} · <span className="text-[#D4AF37]">{timeStr}</span></div>
                  </div>

                  {/* Pool split bar */}
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between text-[9px] font-mono mb-0.5">
                      <span className="text-[#E53935]">₹{(cycle.totalDelhi/1000).toFixed(1)}k</span>
                      <span className="text-[#1E88E5]">₹{(cycle.totalBombay/1000).toFixed(1)}k</span>
                    </div>
                    <div className="w-full h-1 bg-[#121826] rounded-full overflow-hidden flex">
                      <div className="h-full bg-[#E53935]" style={{ width: totalPool > 0 ? `${(cycle.totalDelhi/totalPool)*100}%` : '50%' }} />
                      <div className="h-full bg-[#1E88E5]" style={{ width: totalPool > 0 ? `${(cycle.totalBombay/totalPool)*100}%` : '50%' }} />
                    </div>
                  </div>

                  {/* Total */}
                  <div className="flex-shrink-0 text-right w-14">
                    <div className="text-[10px] font-bold text-[#D4AF37] font-mono">₹{(totalPool/1000).toFixed(1)}k</div>
                    <div className="text-[8px] uppercase text-slate-600">pool</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default ResultsPage;
