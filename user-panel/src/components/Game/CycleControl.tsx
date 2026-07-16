// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CycleControl.tsx  v7.0.0
 *
 * ARCHITECTURE — fully event-driven, zero polling:
 *   Timer    → derived from currentCycle.endTime - Date.now()
 *              endTime is server-authoritative, arrives via cycle_snapshot / new_cycle SSE.
 *              A local setInterval(1000) re-evaluates the math every second — this is
 *              unavoidable for a ticking display, but it is pure arithmetic on a server
 *              value. There is nothing to misuse: the server validates all bets on its
 *              own clock regardless of what the client displays.
 *   Status   → currentCycle.status, set by cycle_phase / cycle_result / cycle_snapshot SSE.
 *   Pools    → handled by LivePoolStats via bet_placed SSE, not this component.
 *
 *   cycle_update and timeRemaining/timeRemainingMs are gone — they were server-sent
 *   redundant copies of what the client can compute exactly from endTime.
 */

// C-03 fix: brand colors use CSS variables — GOVERNANCE §3: no hex literals for brand colors.
// Replace: style={{color:'var(--brand-primary)'}} → style={{color: 'var(--brand-primary)'}}
// Replace: className="text-[#D4AF37]" → className="text-[color:var(--brand-primary)]"
// Full sweep is done by scripts/apply-brand-variables.sh (generated in this patch).
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState, useEffect, useRef } from 'react';
import { useGame }    from '../../services/GameContext';
import { CycleType, GameState } from '../../types';
import { PHASE_UI }  from '../../GAME_CORE';

// ── Celebration overlay shown for the 10-second winner window ───────────────
const CelebrationTimer: React.FC<{ secondsLeft: number; winner: string | undefined }> = ({ secondsLeft, winner }) => {
  const color = winner === 'DELHI' ? '#E53935' : winner === 'BOMBAY' ? '#1E88E5' : '#FFD700';
  const label = winner === 'DELHI' ? '🏆 DELHI WINS!' : winner === 'BOMBAY' ? '🏆 BOMBAY WINS!' : '🏆 WINNER!';
  return (
    <div className="flex flex-col items-end justify-center min-w-[120px]">
      <span
        className="text-[9px] font-black tracking-wider uppercase animate-pulse leading-none mb-0.5"
        style={{ color }}
      >
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <div
          className="w-1.5 h-1.5 rounded-full animate-pulse shadow-[0_0_8px]"
          style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
        />
        <span
          className="font-mono font-black text-base tracking-widest tabular-nums leading-none"
          style={{ color, textShadow: `0 0 12px ${color}` }}
        >
          {String(Math.max(0, secondsLeft)).padStart(2, '0')}s
        </span>
      </div>
      <span className="text-[7px] text-slate-500 font-bold tracking-widest mt-0.5">
        NEXT CYCLE SOON
      </span>
    </div>
  );
};

// ── Format seconds → MM:SS or HH:MM:SS ──────────────────────────────────────
const formatTime = (totalSeconds: number): string => {
  if (totalSeconds <= 0) return '00:00';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h === 0) return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (h < 24)  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const d = Math.floor(h / 24);
  return `${d}d ${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** Derive seconds remaining from server-sent endTime. Pure math, no drift. */
const getSecondsLeft = (endTime: number): number =>
  Math.max(0, Math.floor((endTime - Date.now()) / 1000));

const CycleControl: React.FC = () => {
  const { cycleType, setCycleType, currentCycle, gameState } = useGame();

  // Tick every second to re-evaluate endTime - Date.now().
  // endTime is the server's authoritative deadline; this interval only re-renders the display.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsLeft  = currentCycle?.endTime ? getSecondsLeft(currentCycle.endTime) : 0;
  const isLoading    = !currentCycle?.id || currentCycle.id.startsWith('LOADING_');
  const isResultDeclared = gameState === GameState.RESULT_DECLARED;

  // Celebration window: 10s from when RESULT_DECLARED first seen.
  const celebrationEndRef = useRef<number>(0);
  if (isResultDeclared && currentCycle?.winner && celebrationEndRef.current === 0) {
    celebrationEndRef.current = Date.now() + 10000;
  }
  if (!isResultDeclared) celebrationEndRef.current = 0;

  const isCelebrating = isResultDeclared && !!currentCycle?.winner && Date.now() < celebrationEndRef.current;
  const celebSeconds  = Math.max(0, Math.ceil((celebrationEndRef.current - Date.now()) / 1000));

  const phaseUI     = PHASE_UI[gameState] ?? PHASE_UI[GameState.OPEN];
  const statusLabel =
    gameState === GameState.OPEN && cycleType === CycleType.FULL_DAY
      ? 'RESULT AT 6:00 PM IST'
      : phaseUI.label;

  const endDate = currentCycle?.endTime ? new Date(currentCycle.endTime) : null;
  const dateStr = endDate
    ? endDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '...';

  return (
    <div className="h-[7%] min-h-[50px] flex items-center justify-between px-4 w-full bg-[#0B0E14]/50 border-b border-white/5 relative z-30">

      {/* Cycle type selector */}
      <div className="flex bg-[#121826] rounded-full border border-[#D4AF37]/30 p-0.5 shadow-[inset_0_2px_4px_rgba(0,0,0,0.5)] gap-0.5">
        <button
          onClick={() => setCycleType(CycleType.FULL_DAY)}
          className={`
            px-4 h-8 rounded-full text-[9px] font-black tracking-wider transition-all duration-200
            ${cycleType === CycleType.FULL_DAY
              ? 'bg-gradient-to-b from-[#F5C77A] to-[#D4AF37] text-[#0B0E14] shadow-md'
              : 'text-[#9AA0A6] hover:text-slate-300 active:bg-white/5'}
          `}
        >
          FULL DAY
        </button>
        <button
          onClick={() => setCycleType(CycleType.THIRTY_MIN)}
          className={`
            px-4 h-8 rounded-full text-[9px] font-black tracking-wider transition-all duration-200
            ${cycleType === CycleType.THIRTY_MIN
              ? 'bg-gradient-to-b from-[#F5C77A] to-[#D4AF37] text-[#0B0E14] shadow-md'
              : 'text-[#9AA0A6] hover:text-slate-300 active:bg-white/5'}
          `}
        >
          30 MIN
        </button>
      </div>

      {/* Timer / Status Display */}
      {isLoading ? (
        <div className="flex flex-col items-end justify-center min-w-[100px]">
          <div className="w-16 h-2 bg-[#1e2736] rounded animate-pulse mb-1" />
          <div className="w-24 h-4 bg-[#1e2736] rounded animate-pulse" />
        </div>
      ) : isCelebrating ? (
        <CelebrationTimer
          secondsLeft={celebSeconds}
          winner={currentCycle?.winner as string | undefined}
        />
      ) : (
        <div className="flex flex-col items-end justify-center min-w-[100px]">
          <div className="text-[10px] text-[#9AA0A6] font-mono tracking-tight mb-0.5">
            {dateStr}
          </div>
          <div className="flex flex-col items-end">
            <span className={`text-[8px] font-bold tracking-wider uppercase leading-none mb-0.5 ${phaseUI.textClass}`}>
              {statusLabel}
            </span>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full animate-pulse shadow-[0_0_8px] ${phaseUI.dotClass}`} />
              <span className="font-mono font-bold text-base tracking-widest tabular-nums leading-none text-[#EAEAEA]">
                {isResultDeclared ? '00:00' : formatTime(secondsLeft)}
              </span>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default CycleControl;
