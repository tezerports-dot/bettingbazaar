// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Cricket tab while the game is switched off (owner, 2026-10-18): the
 * admin's image (Branding.cricketComingSoonImageUrl), or a page in the site's
 * theme when no image is set or it fails, drawn INSIDE the app's content area
 * (owner, 2026-10-19), never a layer over the header and tabs.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', async () => ({ ...(await vi.importActual<any>('react-router')), useNavigate: () => navigate }));
vi.mock('../services/GameContext', () => ({
  useCricketSettings: () => ({ enabled: false, comingSoon: true, claimHoldSec: 2, minStake: 10, maxStake: 50000, inPlayDelaySec: 5, winningsFeePercent: 1 }),
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

  it('shows the admin\'s image inside the page, not over the app', () => {
    localStorage.setItem('app_branding', JSON.stringify({ cricketComingSoonImageUrl: 'https://cdn.example/cricket-soon.webp' }));
    render(<CricketPage />);
    const img = screen.getByRole('img', { name: /coming soon/i });
    expect(img.getAttribute('src')).toBe('https://cdn.example/cricket-soon.webp');
    const region = screen.getByRole('region', { name: /coming soon/i });
    expect(region.style.position).not.toBe('fixed');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('draws a page in the site\'s theme when no image is set, or the image fails', () => {
    const { unmount } = render(<CricketPage />);
    const page = screen.getByRole('region', { name: /coming soon/i });
    expect(page.style.position).not.toBe('fixed');
    expect(page.style.backgroundColor).toBe('var(--bg)');
    expect(screen.getByRole('heading', { name: 'CRICKET' })).toBeTruthy();
    expect(screen.getByText('Best batsman')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /play delhi bazaar/i }));
    expect(navigate).toHaveBeenCalledWith('/');
    unmount();
    localStorage.setItem('app_branding', JSON.stringify({ cricketComingSoonImageUrl: 'https://cdn.example/missing.webp' }));
    render(<CricketPage />);
    fireEvent.error(screen.getByRole('img', { name: /coming soon/i }));
    expect(screen.getByRole('heading', { name: 'CRICKET' })).toBeTruthy();
  });
});
