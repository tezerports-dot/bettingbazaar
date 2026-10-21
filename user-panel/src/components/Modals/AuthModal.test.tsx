// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The player's way in: one "Login with Telegram" button behind the captcha (owner, 2026-10-14, 2026-10-20).
 *
 * ── What this replaced ─────────────────────────────────────────────────────
 * Twenty-five tests of a signup form and a login form (mobile, password,
 * confirm, invite, pace countdown, Forgot password). The owner deleted the
 * player password: signing up and signing in are one action in Telegram. A
 * suite pinning a design decision is rewritten by the change that reverses
 * it, keeping what survived:
 *
 *   · the invite a referral link brought is applied, cannot be changed, and
 *     the screen CONFIRMS whose it is, or says plainly that it is dead;
 *   · no Aadhaar, no KYC (owner, 2026-10-02);
 *   · no bot configured is said plainly, never a button that cannot work.
 *
 * ContinueWithTelegram.test.tsx proves the button itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const signInWithTelegram = vi.fn();
const pollTelegramStep = vi.fn();
vi.mock('../../services/GameContext', () => ({
  useGame: () => ({ signInWithTelegram, pollTelegramStep }),
}));

const checkInvite = vi.fn();
const getTelegramSetup = vi.fn();
vi.mock('../../services/backend.service', () => ({
  getBackend: () => ({ checkInvite, getTelegramSetup }),
}));

let stored: string | null = null;
vi.mock('../../services/referralCapture', () => ({
  storedReferralCode: () => stored,
}));

const { default: AuthModal } = await import('./AuthModal');

const onClose = vi.fn();
const open = () => render(<AuthModal onClose={onClose} />);

beforeEach(() => {
  stored = null;
  onClose.mockReset();
  signInWithTelegram.mockReset().mockResolvedValue({
    kind: 'telegram', challengeToken: 'chal-1', delivery: 'MATCH', matchNumber: 47, message: '',
    telegram: { url: 'https://t.me/bb_bot?startapp=cabc', botUsername: 'bb_bot', expiresAt: '' },
  });
  pollTelegramStep.mockReset().mockResolvedValue('pending');
  getTelegramSetup.mockReset().mockResolvedValue({ available: true, botUsername: 'bb_bot' });
  checkInvite.mockReset().mockResolvedValue({ valid: true, invitedBy: 'player3210' });
});

describe('the sign-in screen', () => {
  it('offers one button, and nothing to type', async () => {
    open();
    expect(await screen.findByRole('link', { name: /login with telegram/i })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('input')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('says the same button makes a new account', async () => {
    open();
    expect(await screen.findByText(/same button creates your account/i)).toBeTruthy();
  });

  it('asks for no Aadhaar — KYC was removed (owner, 2026-10-02)', async () => {
    open();
    await screen.findByRole('link', { name: /login with telegram/i });
    expect(screen.queryByText(/aadhaar/i)).toBeNull();
  });

  it('asks for the sign-in once the check passes (ContinueWithTelegram.test.tsx proves the rest)', async () => {
    open();
    expect(await screen.findByRole('link', { name: /login with telegram/i })).toBeTruthy();
    expect(signInWithTelegram).toHaveBeenCalledTimes(1);
  });

  it('says plainly that nobody can sign in when no bot is configured', async () => {
    getTelegramSetup.mockResolvedValue({ available: false, botUsername: '' });
    open();
    expect((await screen.findByRole('alert')).textContent).toMatch(/telegram is not set up on this site yet/i);
    expect(screen.queryByRole('button', { name: /login with telegram/i })).toBeNull();
  });

  it('says the site could not be reached, rather than that Telegram is off, when the setup read fails', async () => {
    getTelegramSetup.mockRejectedValue(new Error('network'));
    open();
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the site/i);
  });
});

describe('the invite code, when the player arrived by a referral link', () => {
  it('confirms whose code it is, and offers no box to change it', async () => {
    stored = 'ALICE123';
    open();
    expect(await screen.findByText(/invited by/i)).toBeTruthy();
    expect(screen.getByText('player3210')).toBeTruthy();
    expect(checkInvite).toHaveBeenCalledWith('ALICE123');
    expect(document.querySelector('input')).toBeNull();
  });

  it('says plainly when the link carried a dead code', async () => {
    checkInvite.mockResolvedValue({ valid: false });
    stored = 'DEADCODE';
    open();
    expect(await screen.findByText(/DEADCODE.*not recognised/i)).toBeTruthy();
    expect(screen.queryByText(/invited by/i)).toBeNull();
  });

  it('checks no code for somebody who arrived on their own', async () => {
    open();
    await screen.findByRole('link', { name: /login with telegram/i });
    expect(checkInvite).not.toHaveBeenCalled();
  });
});
