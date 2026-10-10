// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * VsStrip.tsx — the Delhi-vs-Bombay bar between the pool sizes and the cards
 * (owner, 2026-10-10). Red fills from the left with Delhi's share of the
 * pool, blue from the right with Bombay's, and the point where they meet is a
 * glowing strike with sparks that moves with the live ratio.
 *
 * From the merge until the result the server sends the total alone
 * (`publicCyclePools`, §2: no side under any name), so the strip has no ratio
 * to draw: it turns violet and reads BLIND BETTING instead. It never invents a
 * split — a 50/50 strike there would be a number the platform withholds.
 *
 * Presentation only (§11). Colours are the theme's `--delhi`, `--bombay` and
 * `--blind` tokens (theme.css); the motion lives in theme.css as `bb-vs-*`.
 */
import React from 'react';

interface Props {
  /** Delhi's share of the pool, 0–100. Ignored while blind. */
  delhiPct: number;
  /** Merged: the sides are hidden by the server until the result. */
  blind: boolean;
  /** No stake on either side yet. */
  empty: boolean;
  compact?: boolean;
}

// Twelve sparks around the strike, each on its own angle and beat.
const SPARKS = Array.from({ length: 12 }, (_, i) => ({ a: i * 30 + (i % 2 ? 9 : -6), d: (i * 0.13) % 1.1, r: 14 + (i % 3) * 6 }));

const VsStrip: React.FC<Props> = ({ delhiPct, blind, empty, compact }) => {
  const d = Math.max(0, Math.min(100, Math.round(delhiPct)));
  const b = 100 - d;
  // Where the strike sits: the ratio itself, held inside 16–84% so a 95/5
  // pool still shows its spark and the small side's figure beside it rather
  // than under it. The figures always print the exact share.
  const strike = blind ? 50 : Math.max(16, Math.min(84, d));
  // A side's name only where its share leaves room for it.
  const roomD = empty || d >= 25;
  const roomB = empty || b >= 25;
  const h = compact ? 38 : 44;
  const label = blind
    ? 'Blind betting: pools merged, sides hidden until the result'
    : empty ? 'No bets yet on either side' : `Delhi ${d}% of the pool, Bombay ${b}%`;

  return (
    <div className={`bb-vs${blind ? ' bb-vs--blind' : ''}`} role="img" aria-label={label} style={{ height: h }}>
      <div className="bb-vs__track">
        {blind ? (
          <div className="bb-vs__blind">
            <span className="bb-vs__blindtext font-grotesk" style={{ fontSize: compact ? 13 : 15 }}>BLIND BETTING</span>
          </div>
        ) : (
          <>
            <div className="bb-vs__side bb-vs__side--d" style={{ width: `${strike}%` }} />
            <div className="bb-vs__side bb-vs__side--b" style={{ left: `${strike}%` }} />
            <span className="bb-vs__pct bb-vs__pct--d font-grotesk" style={{ fontSize: compact ? 13 : 15 }}>
              {roomD && <small>DELHI</small>}{empty ? '—' : `${d}%`}
            </span>
            <span className="bb-vs__pct bb-vs__pct--b font-grotesk" style={{ fontSize: compact ? 13 : 15 }}>
              {empty ? '—' : `${b}%`}{roomB && <small>BOMBAY</small>}
            </span>
          </>
        )}
        <div className="bb-vs__gloss" />
      </div>
      <div className="bb-vs__strike" style={{ left: `${strike}%` }} aria-hidden="true">
        <span className="bb-vs__burst" />
        <span className="bb-vs__core" />
        {SPARKS.map((s, i) => (
          <span
            key={i}
            className="bb-vs__spark"
            style={{ '--a': `${s.a}deg`, '--r': `${s.r}px`, animationDelay: `${s.d}s` } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  );
};

export default VsStrip;
