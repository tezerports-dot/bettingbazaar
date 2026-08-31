// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ResultsPanel.tsx — the past-results strip below the betting card, now expandable.
 *
 * Collapsed: a horizontal strip of coloured balls, one row per cycle type
 * (1M + 30M + 24H).
 * Expanded (chevron): a live-casino-style mini results box for the ACTIVE cycle
 * type only (30_MIN tab → 30-min results, FULL_DAY tab → full-day results):
 *   - bead grid of past winners (same ball size as the strip),
 *   - win-distribution bar + percentages (Delhi vs Bombay),
 *   - current streak + last-10 breakdown.
 * All stats are derived client-side from the server-pushed cycle_history
 * (GameContext.pastCycles — zero extra requests, updates live after each result).
 * The grid size (50) matches the server's cycle_history limit — a display
 * constant, not a business rule (BUSINESS_CONFIG_AUDIT.md §4).
 */
import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useGame } from '../../services/GameContext';

const DELHI_BG  = 'bg-[#E53935]';
const BOMBAY_BG = 'bg-[#1E88E5]';

const Ball: React.FC<{ winner: string }> = ({ winner }) => (
  <div
    title={winner === 'DELHI' ? 'Delhi won' : 'Bombay won'}
    className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0 shadow-md border border-white/10 ${winner === 'DELHI' ? DELHI_BG : BOMBAY_BG}`}
  >
    {winner === 'DELHI' ? 'D' : 'B'}
  </div>
);

const ResultsPanel: React.FC = () => {
  const { pastCycles, cycleType } = useGame();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  // Results for the tab being viewed. Was a 30-min list, a full-day list and a
  // boolean choosing between them — which silently showed 30-minute results on
  // any third tab. Filtering by the active type directly cannot do that.
  const isFullDay = (cycleType as string) === 'FULL_DAY';
  const active    = pastCycles.filter(c => (c.type as string) === (cycleType as string) && c.winner);

  // The collapsed strip: one row per cycle type. `show` differs because a
  // full-day cycle produces one result a day, so five of them is already a
  // week of history, while the short blocks produce enough to fill the row.
  const STRIP_ROWS: Array<{ type: string; label: string; show: number }> = [
    { type: '1_MIN',    label: '1M',  show: 30 },
    { type: '30_MIN',   label: '30M', show: 30 },
    { type: 'FULL_DAY', label: '24H', show: 5  },
  ];

  // Descriptive stats over the visible window (last ≤50 results) — the same
  // "probability" readout live-casino roadmaps show. Not a prediction.
  const stats = useMemo(() => {
    const window50 = active.slice(0, 50);
    const total  = window50.length;
    const delhi  = window50.filter(c => c.winner === 'DELHI').length;
    const bombay = total - delhi;
    const dPct   = total ? Math.round((delhi / total) * 100) : 50;
    let streak = 0;
    const streakSide = window50[0]?.winner as string | undefined;
    for (const c of window50) { if (c.winner === streakSide) streak++; else break; }
    const last10 = window50.slice(0, 10);
    const d10    = last10.filter(c => c.winner === 'DELHI').length;
    return { window50, total, delhi, bombay, dPct, bPct: total ? 100 - dPct : 50, streak, streakSide, d10, b10: last10.length - d10 };
  }, [active]);

  return (
    <div className="flex-none border-y border-[#121826] bg-black/20 backdrop-blur-sm z-20 mb-2">
      {/* ── Collapsed strip — unchanged visuals ── */}
      <div className="py-2 px-3 flex items-center gap-1.5 min-h-[40px] overflow-x-auto scrollbar-none">
        {STRIP_ROWS.map(({ type, label, show }, rowIdx) => {
          const rowResults = pastCycles.filter(c => (c.type as string) === type && c.winner);
          return (
            <React.Fragment key={type}>
              {rowIdx > 0 && <div className="w-px h-4 bg-[#D4AF37]/30 shrink-0 mx-0.5" />}
              <span className="text-[8px] font-bold text-[#D4AF37]/60 uppercase tracking-widest shrink-0 mr-0.5">{label}</span>
              <div className="flex items-center gap-1 overflow-hidden">
                {rowResults.slice(0, show).map((c, i) => <Ball key={`${type}-${c.id || i}`} winner={c.winner as string} />)}
                {rowResults.length === 0 && <span className="text-[9px] text-white/20 italic">--</span>}
              </div>
            </React.Fragment>
          );
        })}

        <button
          onClick={() => navigate('/history')}
          className="text-[#D4AF37] text-[9px] uppercase font-bold tracking-wider px-2 py-0.5 border border-[#D4AF37]/50 rounded hover:bg-[#D4AF37] hover:text-black transition-colors shrink-0 ml-1"
        >
          All
        </button>

        {/* Expand toggle — opens the vertical mini results box */}
        <button
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide results panel' : 'Show results panel'}
          className={`shrink-0 w-6 h-6 rounded-full border flex items-center justify-center transition-all active:scale-90
            ${expanded ? 'border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10' : 'border-[#D4AF37]/50 text-[#D4AF37]/70 hover:border-[#D4AF37]'}`}
        >
          <span className={`text-[10px] leading-none transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▼</span>
        </button>
      </div>

      {/* ── Expanded mini results box — ACTIVE cycle type only ── */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-[#D4AF37]/10">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[9px] font-black uppercase tracking-widest text-[#D4AF37]">
              {isFullDay ? 'Full Day' : '30 Min'} · Last {stats.total} results
            </span>
            {stats.streak > 1 && stats.streakSide && (
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full text-white ${stats.streakSide === 'DELHI' ? DELHI_BG : BOMBAY_BG}`}>
                {stats.streakSide === 'DELHI' ? 'D' : 'B'} streak ×{stats.streak}
              </span>
            )}
          </div>

          {stats.total === 0 ? (
            <p className="text-[10px] text-white/25 italic py-3 text-center">No {isFullDay ? 'full-day' : '30-min'} results yet</p>
          ) : (
            <>
              {/* Win distribution bar (the "chart") */}
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] font-bold text-[#E53935] w-14 shrink-0">DELHI {stats.dPct}%</span>
                <div className="flex-1 h-2 rounded-full overflow-hidden flex bg-black/40 border border-white/5">
                  <div className={`${DELHI_BG} h-full transition-all duration-500`} style={{ width: `${stats.dPct}%` }} />
                  <div className={`${BOMBAY_BG} h-full flex-1 transition-all duration-500`} />
                </div>
                <span className="text-[9px] font-bold text-[#1E88E5] w-16 shrink-0 text-right">{stats.bPct}% BOMBAY</span>
              </div>
              <div className="flex items-center justify-between text-[8px] text-white/35 mb-2">
                <span>{stats.delhi} wins</span>
                <span>last 10 → D {stats.d10} · B {stats.b10}</span>
                <span>{stats.bombay} wins</span>
              </div>

              {/* Bead grid — same ball size, newest first, wraps vertically */}
              <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto custom-scrollbar pr-1">
                {stats.window50.map((c, i) => <Ball key={`grid-${c.id || i}`} winner={c.winner as string} />)}
              </div>

              <p className="text-[7px] text-white/20 mt-2 text-center uppercase tracking-wider">
                Past results only — every round is independent
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ResultsPanel;
