// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ResultsPanel.tsx — active-cycle result strip with expandable streak analytics.
 */
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useGame } from '../../services/GameContext';

const DELHI_BG  = 'bg-[#E53935]';
const BOMBAY_BG = 'bg-[#1E88E5]';
const STREAK_LENGTHS = [2, 3, 4, 5, 6, 7, 8];

type Side = 'DELHI' | 'BOMBAY';

const Ball: React.FC<{ winner: string }> = ({ winner }) => (
  <div title={winner === 'DELHI' ? 'Delhi won' : 'Bombay won'} className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0 shadow-md border border-white/10 ${winner === 'DELHI' ? DELHI_BG : BOMBAY_BG}`}>
    {winner === 'DELHI' ? 'D' : 'B'}
  </div>
);

function buildStreakProfile(results: Side[]) {
  const exactRuns: Record<Side, Record<number, number>> = { DELHI: {}, BOMBAY: {} };
  const gaps: Record<Side, Record<number, number[]>> = { DELHI: {}, BOMBAY: {} };
  const lastSeen: Record<Side, Record<number, number | null>> = { DELHI: {}, BOMBAY: {} };
  STREAK_LENGTHS.forEach(len => {
    exactRuns.DELHI[len] = 0; exactRuns.BOMBAY[len] = 0;
    gaps.DELHI[len] = []; gaps.BOMBAY[len] = [];
    lastSeen.DELHI[len] = null; lastSeen.BOMBAY[len] = null;
  });

  let index = 0;
  while (index < results.length) {
    const side = results[index];
    let runLength = 1;
    while (results[index + runLength] === side) runLength++;
    STREAK_LENGTHS.forEach(len => {
      if (runLength >= len) {
        exactRuns[side][len]++;
        const previous = lastSeen[side][len];
        if (previous !== null) gaps[side][len].push(Math.max(0, index - previous - runLength));
        lastSeen[side][len] = index;
      }
    });
    index += runLength;
  }

  return { exactRuns, gaps };
}

const ResultsPanel: React.FC = () => {
  const { pastCycles, cycleType } = useGame();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const isFullDay = (cycleType as string) === 'FULL_DAY';
  const active = pastCycles.filter(c => (c.type as string) === (isFullDay ? 'FULL_DAY' : '30_MIN') && c.winner);
  const targetWindow = isFullDay ? 30 : 1440;

  const stats = useMemo(() => {
    const windowed = active.slice(0, targetWindow);
    const sides = windowed.map(c => c.winner as Side).filter(Boolean);
    const total  = sides.length;
    const delhi  = sides.filter(w => w === 'DELHI').length;
    const bombay = total - delhi;
    const dPct   = total ? Math.round((delhi / total) * 100) : 50;
    let streak = 0;
    const streakSide = sides[0];
    for (const w of sides) { if (w === streakSide) streak++; else break; }
    const profile = buildStreakProfile(sides);
    return { windowed, total, delhi, bombay, dPct, bPct: total ? 100 - dPct : 50, streak, streakSide, profile };
  }, [active, targetWindow]);

  return (
    <div className="flex-none border-y border-white/5 bg-[#1a2c38]/90 backdrop-blur-sm z-20 mb-2 shadow-[0_-8px_28px_rgba(0,0,0,0.20)]">
      <div className="py-2 px-3 flex items-center gap-1.5 min-h-[40px] overflow-x-auto scrollbar-none">
        <span className="text-[8px] font-bold text-[#2de370]/80 uppercase tracking-widest shrink-0 mr-0.5">{isFullDay ? '24H' : '30M'}</span>
        <div className="flex items-center gap-1 flex-1 overflow-hidden">
          {active.slice(0, isFullDay ? 30 : 48).map((c, i) => <Ball key={`active-${c.id || i}`} winner={c.winner as string} />)}
          {active.length === 0 && <span className="text-[9px] text-white/25 italic">no {isFullDay ? 'full-day' : '30-min'} results yet</span>}
        </div>
        <button onClick={() => navigate('/history')} className="text-[#2de370] text-[9px] uppercase font-bold tracking-wider px-2 py-0.5 border border-[#2de370]/50 rounded hover:bg-[#2de370] hover:text-[#07130d] transition-colors shrink-0 ml-1">All</button>
        <button onClick={() => setExpanded(e => !e)} aria-expanded={expanded} aria-label={expanded ? 'Hide results panel' : 'Show results panel'} className={`shrink-0 h-7 rounded-full border px-3 text-[9px] font-black uppercase tracking-wider transition-all active:scale-90 ${expanded ? 'border-[#2de370] text-[#2de370] bg-[#2de370]/10' : 'border-[#2de370]/50 text-[#2de370]/80 hover:border-[#2de370]'}`}>{expanded ? 'Close' : 'Streaks'} <span className={`inline-block transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▼</span></button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-[#2de370]/10">
          <div className="flex items-center justify-between mb-2"><span className="text-[9px] font-black uppercase tracking-widest text-[#2de370]">{isFullDay ? 'Full Day' : '30 Min'} · Last {stats.total}/{targetWindow} cycles</span>{stats.streak > 1 && stats.streakSide && <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full text-white ${stats.streakSide === 'DELHI' ? DELHI_BG : BOMBAY_BG}`}>{stats.streakSide === 'DELHI' ? 'D' : 'B'} live streak ×{stats.streak}</span>}</div>
          {stats.total === 0 ? <p className="text-[10px] text-white/25 italic py-3 text-center">No active cycle results yet</p> : <>
            <div className="flex items-center gap-2 mb-1"><span className="text-[9px] font-bold text-[#E53935] w-14 shrink-0">DELHI {stats.dPct}%</span><div className="flex-1 h-2 rounded-full overflow-hidden flex bg-[#0f212e] border border-white/5"><div className={`${DELHI_BG} h-full transition-all duration-500`} style={{ width: `${stats.dPct}%` }} /><div className={`${BOMBAY_BG} h-full flex-1 transition-all duration-500`} /></div><span className="text-[9px] font-bold text-[#1E88E5] w-16 shrink-0 text-right">{stats.bPct}% BOMBAY</span></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 my-3">{(['DELHI', 'BOMBAY'] as Side[]).map(side => <div key={side} className="rounded-xl bg-[#213743] p-2"><p className={`text-[9px] font-black ${side === 'DELHI' ? 'text-[#E53935]' : 'text-[#1E88E5]'}`}>{side} continuous streaks</p><div className="mt-2 grid grid-cols-7 gap-1">{STREAK_LENGTHS.map(len => <div key={len} className="rounded-lg bg-[#0f212e] p-1 text-center"><div className="text-[8px] text-[#b1b6bb]">×{len}</div><div className="text-xs font-black text-white">{stats.profile.exactRuns[side][len]}</div><div className="text-[7px] text-[#b1b6bb]/70">gap {stats.profile.gaps[side][len][0] ?? '—'}</div></div>)}</div></div>)}</div>
            <div className="flex flex-wrap gap-1 max-h-44 overflow-y-auto custom-scrollbar pr-1">{stats.windowed.map((c, i) => <Ball key={`grid-${c.id || i}`} winner={c.winner as string} />)}</div>
            <p className="text-[7px] text-white/25 mt-2 text-center uppercase tracking-wider">Probability chart summarizes historical streak frequency only — not a prediction.</p>
          </>}
        </div>
      )}
    </div>
  );
};

export default ResultsPanel;
