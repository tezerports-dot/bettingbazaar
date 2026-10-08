// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A signed-in sub-admin on a screen they were not given is TOLD so — not shown
 * a sign-in form.
 *
 * Measured by opening the panel as a sub-admin (`BB_PROFILE=subadmin-analytics`
 * on the browser inventory): every screen outside the grant redirected to
 * `/login`, so a person already signed in was asked to sign in, with nothing
 * saying why. This renders the REAL route table, as `App.mount.test.tsx` does,
 * because a guard proven in isolation says nothing about the guard the table
 * actually mounts (§28).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// The session check answers with whoever the test signed in, as the server would.
const { current } = vi.hoisted(() => ({ current: { admin: null as Record<string, unknown> | null } }));
vi.mock('./services/sse', () => ({
  default: { on: vi.fn(), off: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('./services/api', () => ({
  default: {
    auth: {
      verifySession: vi.fn(async () => (current.admin
        ? { success: true, data: { admin: current.admin }, bootstrap: false }
        : { success: false })),
      logout: vi.fn(),
    },
    telegram: { miniApp: vi.fn().mockResolvedValue({ success: true, available: false, botUsername: '', resetUrl: null }) },
  },
}));
// The shell itself is not the question here, and it fetches notifications and
// the live feed on mount. The real `firstPermittedPath` is kept: it is what
// decides where the "go to a screen you can use" link points.
vi.mock('./components/Layout', async (orig) => ({
  ...(await orig<typeof import('./components/Layout')>()),
  Layout: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

import App from './App';
import { useAuthStore } from './services/auth';

const signInAs = (admin: Record<string, unknown>) => {
  current.admin = { userId: 's-1', username: 'staff', ...admin };
  useAuthStore.setState({
    isAuthenticated: true, bootstrap: false, token: 't', admin: current.admin as any,
  });
};

describe('a screen outside the grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom has no matchMedia; the toaster asks it for reduced motion.
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any;
  });

  it('tells a signed-in sub-admin they lack the area, and offers one they have', async () => {
    window.location.hash = '#/users';
    signInAs({ isAdmin: false, isSubAdmin: true, permissions: { canViewAnalytics: true } });
    render(<App />);
    expect(await screen.findByRole('heading', { name: /don.t have access to this screen/i })).toBeInTheDocument();
    expect(screen.getByText(/Ask an admin to grant it on the Sub-admins screen/i)).toBeInTheDocument();
    // The analytics area's first screen, from the same table the nav uses.
    expect(screen.getByRole('link', { name: /Go to a screen you can use/i })).toHaveAttribute('href', '#/live-cycles');
    expect(screen.queryByText(/Choose your role/i)).not.toBeInTheDocument();
  });

  it('says the Sub-admins screen is a full admin\'s, to a sub-admin holding every area', async () => {
    window.location.hash = '#/sub-admins';
    signInAs({ isAdmin: false, isSubAdmin: true, permissions: { canManageUsers: true } });
    render(<App />);
    expect(await screen.findByText(/Only a full admin can use this screen/i)).toBeInTheDocument();
  });

  it('still opens the screen for a sub-admin who HOLDS the area (the opposite case)', async () => {
    window.location.hash = '#/users';
    signInAs({ isAdmin: false, isSubAdmin: true, permissions: { canManageUsers: true } });
    render(<App />);
    // The screen is lazy; what matters is that the refusal never renders.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('heading', { name: /don.t have access/i })).not.toBeInTheDocument();
  });

  it('tells a sub-admin with NO area at all, on the root, rather than showing a failing dashboard', async () => {
    window.location.hash = '#/';
    signInAs({ isAdmin: false, isSubAdmin: true, permissions: {} });
    render(<App />);
    expect(await screen.findByText(/has not been given any area yet/i)).toBeInTheDocument();
  });

  it('still sends a person who is NOT signed in to the sign-in screen', async () => {
    window.location.hash = '#/users';
    current.admin = null;
    useAuthStore.setState({ isAuthenticated: false, admin: null, token: null, bootstrap: false } as any);
    render(<App />);
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.hash).toBe('#/login');
    expect(screen.queryByRole('heading', { name: /don.t have access/i })).not.toBeInTheDocument();
  });
});
