// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * BetCardShare.tsx — each betting card shows its own side's share of the pool
 * (owner, 2026-10-10: the separate VS bar went; "show the same information
 * using just the betting cards").
 *
 *   • share  — the card fills from the bottom in its side's colour up to its
 *              share, and prints "62%" with that side's ₹ pool beneath.
 *   • blind  — from the merge until the result the server sends the total
 *              alone (`publicCyclePools`, CLAUDE.md §2 "Which pool figures a
 *              player is sent"): no side's share or figure exists to show, so
 *              both cards are lit evenly (no level line, never an invented
 *              50/50) and `BlindBand` reads BLIND BETTING with the total.
 *   • empty  — no stake on either side yet: "—", no fill.
 *   • none   — sides unknown (hidden at the result) : nothing at all.
 *   • loading — the round has not arrived: a placeholder.
 *
 * Presentation only (§11). Colours are the theme's `--delhi`, `--bombay`,
 * `--blind` tokens (theme.css); the motion is CSS in theme.css (`bb-share-*`).
 */
import React from 'react';
import { fmt } from './format';

export type ShareMode = 'share' | 'blind' | 'empty' | 'none' | 'loading';
type CardSide = 'DELHI' | 'BOMBAY';

/** Which treatment the cards get. `poolsHidden` alone is enough to withhold every side figure. */
export function shareModeFor(o: { loading: boolean; blind: boolean; poolsHidden: boolean; delhi: number; bombay: number }): ShareMode {
  if (o.loading) return 'loading';
  if (o.blind) return 'blind';
  if (o.poolsHidden) return 'none';
  return o.delhi + o.bombay > 0 ? 'share' : 'empty';
}

/** Delhi's share, whole percent; Bombay's is the rest, so the two always add to 100. */
export function sharesOf(delhi: number, bombay: number): { DELHI: number; BOMBAY: number } {
  const t = delhi + bombay;
  const d = t > 0 ? Math.max(0, Math.min(100, Math.round((delhi / t) * 100))) : 0;
  return { DELHI: d, BOMBAY: t > 0 ? 100 - d : 0 };
}

const tone = (side: CardSide) => (side === 'DELHI' ? 'var(--delhi)' : 'var(--bombay)');

/** The liquid behind the card's text, above its background image. */
export const BetCardFill: React.FC<{ side: CardSide; mode: ShareMode; pct: number }> = ({ side, mode, pct }) => {
  if (mode !== 'share' && mode !== 'blind') return null;
  const c = tone(side);
  const style = {
    '--share-c': c,
    height: mode === 'blind' ? '100%' : `${Math.max(0, Math.min(100, pct))}%`,
  } as React.CSSProperties;
  return <div className={`bb-share-fill${mode === 'blind' ? ' bb-share-fill--blind' : ''}`} style={style} aria-hidden="true" data-testid={`share-fill-${side}`} />;
};

/** The card's share figure, under the side's name. */
export const BetCardFigure: React.FC<{ side: CardSide; mode: ShareMode; pct: number; pool: number; big?: boolean }> = ({ side, mode, pct, pool, big }) => {
  const name = side === 'DELHI' ? 'Delhi' : 'Bombay';
  const size = big ? 34 : 26;
  if (mode === 'loading') {
    return <span className="bb-skel" style={{ position: 'relative', zIndex: 2, display: 'inline-block', width: big ? 64 : 50, height: size, borderRadius: 7, background: 'var(--surface3)' }} />;
  }
  if (mode === 'blind' || mode === 'none') return <span aria-hidden="true" />;
  const empty = mode === 'empty';
  return (
    <span
      className="bb-share-figure"
      role="img"
      aria-label={empty ? `${name}: no bets yet` : `${name} ${pct}% of the pool, ₹${fmt(pool)}`}
      data-testid={`share-${side}`}
    >
      <span className="bb-share-figure__pct font-grotesk" style={{ fontSize: size }}>{empty ? '—' : `${pct}%`}</span>
      {!empty && <span className="bb-share-figure__pool font-grotesk" style={{ fontSize: big ? 13 : 11 }}>₹{fmt(pool)}</span>}
    </span>
  );
};

/**
 * Merged: one band across both cards, the only figure being the total. It sits
 * where the share figures sit (just below the middle, under the side names and
 * above the "You ₹x" badges); compact, it is a single line.
 */
export const BlindBand: React.FC<{ total: number; compact?: boolean }> = ({ total, compact }) => (
  <div
    className={`bb-share-blind${compact ? ' bb-share-blind--compact' : ''}`}
    role="img"
    aria-label={`Blind betting: sides hidden until the result. Pool ₹${fmt(total)}`}
    data-testid="blind-band"
  >
    <span className="bb-share-blind__text font-grotesk" style={{ fontSize: compact ? 12 : 15 }}>BLIND BETTING</span>
    <span className="bb-share-blind__pool font-grotesk" style={{ fontSize: compact ? 11 : 12 }}>POOL ₹{fmt(total)}</span>
  </div>
);
