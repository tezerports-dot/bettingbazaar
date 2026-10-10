// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The betting cards carry each side's share of the pool (owner, 2026-10-10),
 * and while the pools are hidden they carry NO side figure at all
 * (CLAUDE.md §2 "Which pool figures a player is sent").
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BetCardFigure, BetCardFill, BlindBand, ShareMode, shareModeFor, sharesOf } from './BetCardShare';

// The two cards as GameScreen composes them.
const Cards: React.FC<{ mode: ShareMode; delhi: number; bombay: number; total: number }> = ({ mode, delhi, bombay, total }) => {
  const s = sharesOf(delhi, bombay);
  return (
    <div data-testid="stage">
      <button>
        <BetCardFill side="DELHI" mode={mode} pct={s.DELHI} />
        <span>Delhi</span>
        <BetCardFigure side="DELHI" mode={mode} pct={s.DELHI} pool={delhi} />
      </button>
      <button>
        <BetCardFill side="BOMBAY" mode={mode} pct={s.BOMBAY} />
        <span>Bombay</span>
        <BetCardFigure side="BOMBAY" mode={mode} pct={s.BOMBAY} pool={bombay} />
      </button>
      {mode === 'blind' && <BlindBand total={total} />}
    </div>
  );
};

describe('shareModeFor', () => {
  const base = { loading: false, blind: false, poolsHidden: false, delhi: 0, bombay: 0 };
  it('loading first, then blind, then hidden, then share or empty', () => {
    expect(shareModeFor({ ...base, loading: true, blind: true })).toBe('loading');
    expect(shareModeFor({ ...base, blind: true, delhi: 5, bombay: 5 })).toBe('blind');
    expect(shareModeFor({ ...base, poolsHidden: true, delhi: 5 })).toBe('none');
    expect(shareModeFor({ ...base, delhi: 620, bombay: 380 })).toBe('share');
    expect(shareModeFor(base)).toBe('empty');
  });
});

describe('sharesOf', () => {
  it('adds to 100 and is 0/0 with no stakes', () => {
    expect(sharesOf(620, 380)).toEqual({ DELHI: 62, BOMBAY: 38 });
    expect(sharesOf(1, 2)).toEqual({ DELHI: 33, BOMBAY: 67 });
    expect(sharesOf(0, 0)).toEqual({ DELHI: 0, BOMBAY: 0 });
  });
});

describe('betting cards: share of the pool', () => {
  it('open with bets: each card shows its share, its pool and fills to it', () => {
    render(<Cards mode="share" delhi={620} bombay={380} total={1000} />);
    expect(screen.getByTestId('share-DELHI').textContent).toContain('62%');
    expect(screen.getByTestId('share-DELHI').textContent).toContain('₹620');
    expect(screen.getByTestId('share-BOMBAY').textContent).toContain('38%');
    expect(screen.getByTestId('share-BOMBAY').textContent).toContain('₹380');
    expect(screen.getByTestId('share-fill-DELHI').style.height).toBe('62%');
    expect(screen.getByTestId('share-fill-BOMBAY').style.height).toBe('38%');
    expect(screen.queryByTestId('blind-band')).toBeNull();
  });

  it('merged (blind): no per-side % or ₹ anywhere; one band with the total', () => {
    // Even if a stale side figure lingered client-side, blind renders none of it.
    render(<Cards mode="blind" delhi={620} bombay={380} total={1000} />);
    const stage = screen.getByTestId('stage');
    expect(stage.textContent).not.toMatch(/%/);
    expect(stage.textContent).not.toContain('620');
    expect(stage.textContent).not.toContain('380');
    expect(screen.queryByTestId('share-DELHI')).toBeNull();
    expect(screen.queryByTestId('share-BOMBAY')).toBeNull();
    const band = screen.getByTestId('blind-band');
    expect(band.textContent).toContain('BLIND BETTING');
    expect(band.textContent).toContain('₹1,000');
    // Evenly lit: both cards the same full height, never a split.
    expect(screen.getByTestId('share-fill-DELHI').style.height).toBe('100%');
    expect(screen.getByTestId('share-fill-BOMBAY').style.height).toBe('100%');
    expect(stage.querySelector('[aria-label*="%"]')).toBeNull();
  });

  it('hidden at the result: nothing per side', () => {
    render(<Cards mode="none" delhi={0} bombay={0} total={1000} />);
    const stage = screen.getByTestId('stage');
    expect(stage.textContent).not.toMatch(/%|₹/);
    expect(screen.queryByTestId('share-fill-DELHI')).toBeNull();
  });

  it('no bets yet: a dash on each card and no fill', () => {
    render(<Cards mode="empty" delhi={0} bombay={0} total={0} />);
    expect(screen.getByTestId('share-DELHI').textContent).toBe('—');
    expect(screen.getByTestId('share-BOMBAY').textContent).toBe('—');
    expect(screen.getByTestId('stage').textContent).not.toMatch(/%|₹/);
    expect(screen.queryByTestId('share-fill-DELHI')).toBeNull();
    expect(screen.queryByTestId('share-fill-BOMBAY')).toBeNull();
  });

  it('loading: a placeholder, no figure', () => {
    render(<Cards mode="loading" delhi={0} bombay={0} total={0} />);
    expect(screen.getByTestId('stage').textContent).not.toMatch(/%|₹|—/);
    expect(screen.getByTestId('stage').querySelectorAll('.bb-skel')).toHaveLength(2);
  });
});
