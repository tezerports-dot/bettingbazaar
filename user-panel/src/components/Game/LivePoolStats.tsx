// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * LivePoolStats.tsx
 *
 * FLICKER FIX:
 *   1. Wrapped in React.memo — GamePage re-renders on SSE events (bet_placed, cycle_phase, etc.)
 *      (for the timer). Without memo, LivePoolStats re-rendered every 100ms
 *      from its parent even though showMerged never changed, causing flash.
 *   2. Removed the separate cycleType-change useEffect that called setStats
 *      synchronously before the subscription fired. The subscription's
 *      immediate callback (fired by subscribeToVolume on register) already
 *      seeds from liveStatsRef, so the extra setStats created a double-update.
 *   3. Throttle at 200ms is still sensible for burst bet_placed events on busy cycles.
 *      At 50ms throttle the setTimeout path fired almost every update, adding
 *      a stale-state micro-blink. At 200ms we still update 5x/sec — smooth
 *      enough for pool numbers, zero visible flicker.
 *
 * FULL DAY = 0 FIX:
 *   When switching to Full Day tab the subscription seeds immediately from
 *   liveStatsRef.current[FULL_DAY]. If that's {0,0} (no bets yet) it's
 *   correct. But if the snapshot hasn't arrived yet we also seed from
 *   currentCycle.totalDelhi/Bombay which comes from GameContext state.
 *   This prevents showing 0 in the window between tab-switch and next broadcast.
 */
import React, { useEffect, useState, useRef, useCallback, memo } from 'react';
import { useGame } from '../../services/GameContext';

interface LivePoolStatsProps {
  showMerged: boolean;
}

const LivePoolStats: React.FC<LivePoolStatsProps> = memo(({ showMerged }) => {
  const { subscribeToVolume, getCurrentVolume, cycleType, cycles } = useGame();

  // Seed initial state from liveStatsRef, falling back to cycles state.
  // cycles state always has the last broadcast values even if liveStatsRef
  // hasn't been primed for this type yet (e.g. right after tab switch).
  const getInitialStats = useCallback(() => {
    const fromRef = getCurrentVolume(cycleType);
    if (fromRef.totalDelhi > 0 || fromRef.totalBombay > 0) return fromRef;
    const fromCycle = cycles[cycleType];
    return {
      totalDelhi:  fromCycle?.totalDelhi  ?? 0,
      totalBombay: fromCycle?.totalBombay ?? 0,
    };
  }, [cycleType, getCurrentVolume, cycles]);

  const [stats, setStats] = useState(getInitialStats);

  // Throttled setter — 200ms is smooth for pool numbers and eliminates flicker
  const lastRun  = useRef(Date.now());
  const lastFunc = useRef<ReturnType<typeof setTimeout> | null>(null);
  const throttledSetStats = useCallback((data: { totalDelhi: number; totalBombay: number }) => {
    const now = Date.now();
    if (now - lastRun.current >= 200) {
      setStats(data);
      lastRun.current = now;
    } else {
      if (lastFunc.current) clearTimeout(lastFunc.current);
      lastFunc.current = setTimeout(() => {
        setStats(data);
        lastRun.current = Date.now();
      }, 200 - (now - lastRun.current));
    }
  }, []);

  useEffect(() => {
    // On tab switch: immediately show best available data (no blank flash)
    setStats(getInitialStats());
    // Then subscribe — callback fires immediately with liveStatsRef value,
    // and then on every cycle_update broadcast going forward.
    const unsubscribe = subscribeToVolume(cycleType, throttledSetStats);
    return () => {
      if (lastFunc.current) clearTimeout(lastFunc.current);
      unsubscribe();
    };
  }, [cycleType, subscribeToVolume, throttledSetStats, getInitialStats]);

  const totalPool = (stats?.totalDelhi ?? 0) + (stats?.totalBombay ?? 0);

  return (
    <div className="w-full flex justify-center items-center h-6 relative mt-1">
      {/* Individual Totals (Fade Out on Merge) */}
      <div
        className={`flex gap-12 transition-all duration-500 ease-in-out absolute w-full justify-center
          ${showMerged ? 'opacity-0 scale-90 blur-sm' : 'opacity-100 scale-100 blur-none'}
        `}
      >
        <div className="text-[#E53935] font-semibold text-sm tabular-nums drop-shadow-sm">
          ₹ {(stats?.totalDelhi ?? 0).toLocaleString()}
        </div>
        <div className="text-[#1E88E5] font-semibold text-sm tabular-nums drop-shadow-sm">
          ₹ {(stats?.totalBombay ?? 0).toLocaleString()}
        </div>
      </div>

      {/* Merged Total (Fade In) */}
      <div
        className={`flex items-center gap-2 transition-all duration-500 ease-in-out absolute
          ${showMerged ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-110 translate-y-4'}
        `}
      >
        <span className="text-[#D4AF37] font-bold text-lg text-gold-glow animate-pulse tabular-nums">
          POOL: ₹ {totalPool.toLocaleString()}
        </span>
      </div>
    </div>
  );
});

LivePoolStats.displayName = 'LivePoolStats';
export default LivePoolStats;
