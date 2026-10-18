// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Cricket tab while the game is switched off (owner, 2026-10-18): the
 * admin's full-screen image (Branding.cricketComingSoonImageUrl) with a way
 * back, or a full-screen page in the site's theme when no image is set or it fails.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', async () => ({ ...(await vi.importActual<any>('react-router')), useNavigate: () => navigate }));
vi.mock('../services/GameContext', () => ({
  useCricketSettings: () => ({ enabled: false, comingSoon: true, claimHoldSec: 2, minStake: 10, maxStake: 50000, inPlayDelaySec: 5, claimMarginPercent: 5, winningsFeePercent: 1 }),
  useGame: () => ({ isAuthenticated: false }),
}));
vi.mock('../redesign/RedesignShell', () => ({ useShell: () => ({ openAuth: vi.fn() }) }));
vi.mock('../redesign/Screen', () => ({
  default: ({ title, sub, children }: any) => <main><h1>{title}</h1><p>{sub}</p>{children}</main>,
  card: {}, capLabel: {}, goldButton: {}, inputStyle: {},
}));

const { default: CricketPage } = await import('./CricketPage');

describe('the Cricket tab while the game is off', () => {
  beforeEach(() => { localStorage.clear(); navigate.mockClear(); });

  it('covers the screen with the admin\'s image and offers a way back', () => {
    localStorage.setItem('app_branding', JSON.stringify({ cricketComingSoonImageUrl: 'https://cdn.example/cricket-soon.webp' }));
    render(<CricketPage />);
    const img = screen.getByRole('img', { name: /coming soon/i });
    expect(img.getAttribute('src')).toBe('https://cdn.example/cricket-soon.webp');
    expect(screen.getByRole('dialog', { name: /coming soon/i }).style.position).toBe('fixed');
    fireEvent.click(screen.getByRole('button', { name: /back to the boards/i }));
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('draws a full-screen page in the site\'s theme when no image is set, or the image fails', () => {
    const { unmount } = render(<CricketPage />);
    const page = screen.getByRole('dialog', { name: /coming soon/i });
    expect(page.style.position).toBe('fixed');
    expect(page.style.backgroundColor).toBe('var(--bg)');
    expect(screen.getByRole('heading', { name: 'CRICKET' })).toBeTruthy();
    expect(screen.getByText('Best batsman')).toBeTruthy();
    unmount();
    localStorage.setItem('app_branding', JSON.stringify({ cricketComingSoonImageUrl: 'https://cdn.example/missing.webp' }));
    render(<CricketPage />);
    fireEvent.error(screen.getByRole('img', { name: /coming soon/i }));
    expect(screen.getByRole('heading', { name: 'CRICKET' })).toBeTruthy();
  });
});
