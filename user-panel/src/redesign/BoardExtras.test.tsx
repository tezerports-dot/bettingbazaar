// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The player screen's extras: the timer's tone, the closing chip, the result
 * celebration showing only this player's own payout, and the unlock bar.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LATE_PAYOUT_MS, PromoCarousel, ResultCelebration, UnlockBar, UrgencyChips, timerTone, unlockProgress } from './BoardExtras';
import { MY_PAYOUT_EVENT } from '../services/GameContext';

describe('timerTone', () => {
  it('is red inside the warning, amber for the span before it, calm otherwise', () => {
    expect(timerTone(10, 10)).toBe('red');
    expect(timerTone(0, 10)).toBe('red');
    expect(timerTone(11, 10)).toBe('amber');
    expect(timerTone(20, 10)).toBe('amber');
    expect(timerTone(21, 10)).toBe('calm');
  });
  it('stays calm when the warning is 0', () => {
    expect(timerTone(0, 0)).toBe('calm');
  });
});

describe('UrgencyChips', () => {
  it('shows LIVE while open and the closing chip only inside the warning', () => {
    const { rerender } = render(<UrgencyChips open secondsToClose={30} warnSeconds={10} />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.queryByText(/Closing/)).toBeNull();
    rerender(<UrgencyChips open secondsToClose={9} warnSeconds={10} />);
    expect(screen.getByRole('status')).toHaveTextContent('Closing 0:09');
  });
  it('shows nothing once bets are closed', () => {
    const { container } = render(<UrgencyChips open={false} secondsToClose={0} warnSeconds={10} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ResultCelebration', () => {
  const pay = (cycleId: string, amount: number, winner = 'DELHI') => act(() => {
    window.dispatchEvent(new CustomEvent(MY_PAYOUT_EVENT, { detail: { cycleId, amount, winner } }));
  });

  it('names the winner, and no payout for a player who was not paid', () => {
    render(<ResultCelebration result={{ cycleId: "30MIN_1", winner: "BOMBAY" }} />);
    expect(screen.getByText(/BOMBAY WINS/)).toBeInTheDocument();
    expect(screen.queryByText('YOU WON')).toBeNull();
  });

  it("shows this player's own payout for THIS cycle only", async () => {
    render(<ResultCelebration result={{ cycleId: "30MIN_2", winner: "DELHI" }} />);
    pay('30MIN_1', 500);
    expect(screen.queryByText('YOU WON')).toBeNull();
    pay('30MIN_2', 540);
    expect(await screen.findByText('YOU WON')).toBeInTheDocument();
    expect(await screen.findByText('₹540', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('shows nothing before a winner is known', () => {
    const { container } = render(<ResultCelebration result={{ cycleId: '30MIN_3', winner: null }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a payout that lands after the round rolled over, with the winner it names, then takes it down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const { container } = render(<ResultCelebration result={null} />);
      expect(container).toBeEmptyDOMElement();
      pay('1MIN_9', 19.8, 'BOMBAY');
      expect(screen.getByText(/BOMBAY WON/)).toBeInTheDocument();
      expect(screen.getByText('YOU WON')).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(LATE_PAYOUT_MS + 100); });
      expect(container).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('unlock progress', () => {
  it('sums the OPEN grants only, each capped at its requirement', () => {
    expect(unlockProgress([
      { requiredTurnover: 250, turnover: 100 },
      { requiredTurnover: 250, turnover: 400 },
      { requiredTurnover: 250, turnover: 250, completedAt: '2026-10-09' },
    ])).toEqual({ done: 350, required: 500, pct: 70 });
  });
  it('is nothing when no grant is open', () => {
    expect(unlockProgress([])).toBeNull();
    expect(unlockProgress(undefined)).toBeNull();
  });
  it('draws the bar with its figures', () => {
    render(<UnlockBar grants={[{ requiredTurnover: 250, turnover: 50 }]} />);
    expect(screen.getByRole('progressbar', { name: 'Bonus unlock' })).toHaveAttribute('aria-valuenow', '20');
    expect(screen.getByText(/₹50 of ₹250 played · 20%/)).toBeInTheDocument();
  });
});

describe('PromoCarousel (phone, under the header)', () => {
  const cards = [
    { promoId: 'a', title: 'Refer & Earn', fileUrl: 'https://cdn.example/a.png', linkUrl: '/referrals' },
    { promoId: 'b', title: 'Channel', fileUrl: 'https://cdn.example/b.png', linkUrl: 'https://t.me/x' },
  ];
  it('shows every card whole, never cropped, each opening its own link', () => {
    render(<PromoCarousel cards={cards} />);
    for (const img of screen.getAllByRole('img')) {
      expect(img.style.objectFit).toBe('');
      expect(img.style.height).toBe('auto');
    }
    expect(screen.getByRole('link', { name: 'Refer & Earn' })).toHaveAttribute('href', '#/referrals');
    expect(screen.getByRole('link', { name: 'Channel' })).toHaveAttribute('target', '_blank');
  });
  it('has a dot per card, the first marked as current', () => {
    render(<PromoCarousel cards={cards} />);
    expect(screen.getByRole('button', { name: 'Promotion 1 of 2' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Promotion 2 of 2' })).not.toHaveAttribute('aria-current');
  });
  it('shows nothing with no cards', () => {
    const { container } = render(<PromoCarousel cards={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
