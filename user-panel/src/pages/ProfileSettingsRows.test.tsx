// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The Profile settings rows go somewhere, or they are not there.
 *
 * ── Five dead buttons on the player's own screen ────────────────────────────
 * The rows were `<button key={op.t} style={…}>` with NO onClick. Notifications,
 * Language, Security & PIN, Responsible Play, About & Terms — each ending in a
 * `›` that promises a screen, each doing nothing. Found by PRESSING them in a
 * browser: there is no request to fail and no error to catch, so
 * `check:ui-coverage` cannot see it (it finds a call that resolves to no route,
 * not a control that calls nothing) and neither can any route test (§28).
 *
 * Three named features this platform does not have and are gone. The rest name
 * PAGES the admin could already set — `helpCenterUrl`, `termsUrl`,
 * `privacyUrl` in `SUPPORT_LINKS_SPEC` — which NOTHING read: the same hole from
 * the other side (§3, an admin-editable field with no consumer).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { getSupportLinks } = vi.hoisted(() => ({ getSupportLinks: vi.fn() }));
vi.mock('../services/backend.service', () => ({
  getBackend: () => ({ getSupportLinks, updateBankDetails: vi.fn() }),
}));
vi.mock('../services/GameContext', () => ({
  useGame: () => ({
    user: { id: 'u1', username: 'player', mobile: '9999900000', bankDetails: null },
    balances: { depositBalance: 0, winningsBalance: 0, reserveBalance: 0, lockedBalance: 0 },
    bets: [], logout: vi.fn(), refreshProfile: vi.fn(),
  }),
}));
vi.mock('../redesign/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

import ProfilePage from './ProfilePage';

beforeEach(() => { getSupportLinks.mockReset(); });

describe('Profile settings rows', () => {
  it('offers a page only when the operator has published one', async () => {
    getSupportLinks.mockResolvedValue({
      helpCenterUrl: 'https://bb.test/help', termsUrl: 'https://bb.test/terms', privacyUrl: '',
    });
    render(<ProfilePage />);

    const help = await screen.findByRole('link', { name: /Help Centre/i });
    expect(help).toHaveAttribute('href', 'https://bb.test/help');
    expect(await screen.findByRole('link', { name: /Terms & Conditions/i }))
      .toHaveAttribute('href', 'https://bb.test/terms');

    // Blank means unpublished. A player is not offered a row that goes nowhere —
    // which is the entire defect, stated as an assertion.
    expect(screen.queryByRole('link', { name: /Privacy Policy/i })).toBeNull();
  });

  it('shows no rows at all when nothing is published', async () => {
    getSupportLinks.mockResolvedValue({ helpCenterUrl: '', termsUrl: '', privacyUrl: '' });
    render(<ProfilePage />);
    await waitFor(() => expect(getSupportLinks).toHaveBeenCalled());
    for (const name of [/Help Centre/i, /Terms & Conditions/i, /Privacy Policy/i]) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
  });

  it('does not offer features this platform does not have', async () => {
    getSupportLinks.mockResolvedValue({ helpCenterUrl: 'https://bb.test/help' });
    render(<ProfilePage />);
    await screen.findByRole('link', { name: /Help Centre/i });
    // Each of these was a row with a chevron and no handler.
    for (const gone of [/Security & PIN/i, /^Language/i, /^Notifications/i, /Responsible Play/i]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it('survives a support document that cannot be read', async () => {
    getSupportLinks.mockRejectedValue(new Error('503'));
    render(<ProfilePage />);
    // The screen still draws; an unreachable support document is not an outage.
    expect(await screen.findByText(/Appearance/i)).toBeInTheDocument();
  });
});
