// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The staff bootstrap banner (CLAUDE.md §33): standing on every screen while
 * the session the server issued says `bootstrap: true` (no Telegram bot saved
 * yet, so a password alone), naming the screen that ends it; gone otherwise.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  default: { analytics: { getDashboard: vi.fn().mockResolvedValue({ success: false }) }, auth: { logout: vi.fn() } },
}));

import { Layout } from './Layout';
import { useAuthStore } from '../services/auth';

const signIn = (bootstrap: boolean) => useAuthStore.setState({
  isAuthenticated: true, token: 't', bootstrap,
  admin: { userId: 'a-1', username: 'owner', isAdmin: true } as any,
});

describe('the bootstrap banner', () => {
  beforeEach(() => { cleanup(); });

  it('stands while the session is a password alone, linking to Telegram setup', () => {
    signIn(true);
    render(<MemoryRouter><Layout><div /></Layout></MemoryRouter>);
    const banner = screen.getByText(/Telegram is not set up\./).closest('[role="status"]');
    expect(banner?.textContent).toBe(
      'Telegram is not set up. Staff sign in with a password alone until a bot is saved in Telegram setup.',
    );
    const link = screen.getByRole('link', { name: 'Telegram setup' });
    expect(link.getAttribute('href')).toBe('/telegram');
  });

  it('is absent once the server stops saying bootstrap (the opposite case)', () => {
    signIn(false);
    render(<MemoryRouter><Layout><div /></Layout></MemoryRouter>);
    expect(screen.queryByText(/Telegram is not set up/)).toBeNull();
  });
});
