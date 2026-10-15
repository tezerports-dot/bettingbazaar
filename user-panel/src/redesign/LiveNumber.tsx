// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Live pool figures that count up instead of jumping (owner, 2026-10-15).
 *
 * The pool arrives at most once a second (`bet_placed`, cycleSnapshotPublisher.js).
 * Each new figure is reached by counting from the one on screen over a little
 * under a second, so a pool that grows every second reads as one steady
 * counter. The first figure is shown as it is (nothing to count from), a
 * smaller figure (a new round) is shown at once, and with reduced motion
 * every figure is shown at once.
 *
 * Presentation only (§11): the number counted to is always the server's.
 */
import React, { useEffect, useRef, useState } from 'react';
import { fmt } from './format';

/** How long one step of the counter takes; just under the publish interval. */
export const COUNT_MS = 850;

const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The figure to draw this frame, counting towards `target`. */
export function useCountTo(target: number, ms = COUNT_MS): number {
  const to = Number.isFinite(target) ? target : 0;
  const [shown, setShown] = useState(to);
  const shownRef = useRef(to);
  useEffect(() => {
    const from = shownRef.current;
    if (from === to) return;
    if (to < from || reducedMotion()) {
      shownRef.current = to;
      setShown(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      // Ease out; whole rupees while counting, the exact figure at the end.
      const v = k >= 1 ? to : Math.floor(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      shownRef.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return shown;
}

/** `value`, formatted, counting up to each new figure. */
export const LiveNumber: React.FC<{ value: number }> = ({ value }) => <>{fmt(useCountTo(value))}</>;
