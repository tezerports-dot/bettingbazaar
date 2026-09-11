// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The 2FA gate is actually MOUNTED, not merely written.
 *
 * ── Why this file exists, and it is not a formality ─────────────────────────
 * `MandatoryTwoFactor.test.tsx` renders that component directly and proves it
 * behaves. It cannot see whether anything renders it. Deleting the wrapper from
 * App's route tree was mutated in during this change and **every other test
 * still passed** — the component worked, the store held the flag, the mapper
 * carried it, and no admin would ever have been asked, because nothing put the
 * gate in the path.
 *
 * That is CLAUDE.md §28 exactly: a component test proves a component works and
 * can never prove anything mounts it. So this renders the REAL App and asks
 * what an unenrolled admin sees.
 *
 * Every page is lazy behind the route table and the store starts on /, so this
 * does not drag the whole panel in; the SSE service and the branding effect are
 * stubbed because they reach for a network and a live document, neither of
 * which this asks about.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { status } = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('./services/sse', () => ({
  default: { on: vi.fn(), off: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('./services/api', () => ({
  default: {
    twoFactor: { status, setup: vi.fn(), activate: vi.fn() },
    // App calls this on mount, and it now REFRESHES the obligation rather than
    // only carrying it from login — so the stub has to answer what the real
    // server answers for an unenrolled admin. Returning no flag cleared the
    // very state this test sets up, and the assertion then raced the refresh:
    // it passed alone and failed in the full suite, which is the flake, not
    // the finding.
    auth: {
      verifySession: vi.fn().mockResolvedValue({
        success: true,
        data: { admin: { userId: 'a-1', username: 'owner', isAdmin: true } },
        mustEnroll2FA: true,
      }),
      logout: vi.fn(),
    },
  },
}));
vi.mock('./components/OtpAuthQr', () => ({ default: () => <div /> }));

import App from './App';
import { useAuthStore } from './services/auth';

describe('App mounts the 2FA obligation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue({ enabled: false, mandatory: true });
  });

  it('shows an unenrolled admin the enrolment screen instead of the panel', async () => {
    useAuthStore.setState({
      isAuthenticated: true, mustEnroll2FA: true,
      admin: { userId: 'a-1', username: 'owner', isAdmin: true } as any,
      token: 't', pendingChallenge: null,
    });
    render(<App />);
    // Waited for explicitly. Asserting before the session check settles lets
    // the test pass on the state it set itself rather than on what the panel
    // does with the server's answer.
    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));
    // By ROLE. The enrolment panel's own start button carries the same words,
    // and it renders now that the gate stays up — a bare text match finds two.
    expect(
      await screen.findByRole('heading', { name: /Set up two-factor authentication/i }),
      'App renders its route table without the gate — an unenrolled admin walks straight in',
    ).toBeInTheDocument();
  });
});
