// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Continue with Telegram": one button; the delivery is chosen by the device
 * (HANDOFF on Android, MATCH elsewhere); a MATCH shows its number and the QR;
 * a HANDOFF is told where the session went; a refusal is the server's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const signInWithTelegram = vi.fn();
const pollTelegramStep = vi.fn();
vi.mock('../../services/GameContext', () => ({
  useGame: () => ({ signInWithTelegram, pollTelegramStep }),
}));
let stored: string | null = null;
vi.mock('../../services/referralCapture', () => ({ storedReferralCode: () => stored }));
let native = false;
vi.mock('../../services/nativeLifecycle', () => ({ isNativeShell: () => native }));

const { default: ContinueWithTelegram, deliveryHere } = await import('./ContinueWithTelegram');

const STEP = (delivery: 'MATCH' | 'HANDOFF', matchNumber: number | null) => ({
  kind: 'telegram', challengeToken: 'chal-1', delivery, matchNumber,
  telegram: { url: 'https://t.me/bb_bot?startapp=cabc', botUsername: 'bb_bot', expiresAt: '' }, message: '',
});

const ua = navigator.userAgent;
const setUa = (v: string) => Object.defineProperty(window.navigator, 'userAgent', { value: v, configurable: true });

beforeEach(() => {
  signInWithTelegram.mockReset(); pollTelegramStep.mockReset();
  stored = null; native = false; setUa(ua);
});
afterEach(() => { vi.useRealTimers(); setUa(ua); });

describe('Continue with Telegram', () => {
  it('chooses HANDOFF in the Android app or an Android browser, MATCH anywhere else', () => {
    setUa('Mozilla/5.0 (Windows NT 10.0) Chrome/130');
    expect(deliveryHere()).toBe('MATCH');
    setUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari');
    expect(deliveryHere()).toBe('MATCH');
    setUa('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile');
    expect(deliveryHere()).toBe('HANDOFF');
    setUa('Mozilla/5.0 (Windows NT 10.0)');
    native = true;
    expect(deliveryHere()).toBe('HANDOFF');
  });

  it('a laptop shows the number to choose and a QR, sends the stored invite code, and is signed in by the poll', async () => {
    setUa('Mozilla/5.0 (Windows NT 10.0) Chrome/130');
    stored = 'ALICE1';
    signInWithTelegram.mockResolvedValue(STEP('MATCH', 47));
    pollTelegramStep.mockResolvedValue('done');
    const onDone = vi.fn();
    render(<ContinueWithTelegram onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: /continue with telegram/i }));
    expect(signInWithTelegram).toHaveBeenCalledWith({ delivery: 'MATCH', referralCode: 'ALICE1' });
    expect((await screen.findByTestId('match-number')).textContent).toBe('47');
    expect(screen.getByRole('img', { name: /qr code that opens telegram/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /open telegram/i }).getAttribute('href')).toBe('https://t.me/bb_bot?startapp=cabc');
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled(), { timeout: 5000 });
    expect(pollTelegramStep).toHaveBeenCalledWith('chal-1');
  });

  it('a phone that hands off shows no number, and says where the session went', async () => {
    setUa('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile');
    signInWithTelegram.mockResolvedValue(STEP('HANDOFF', null));
    pollTelegramStep.mockResolvedValue('handedOff');
    const onDone = vi.fn();
    render(<ContinueWithTelegram onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: /continue with telegram/i }));
    expect(await screen.findByRole('link', { name: /open telegram/i })).toBeTruthy();
    expect(screen.queryByTestId('match-number')).toBeNull();
    expect(screen.queryByRole('img', { name: /qr code/i })).toBeNull();
    expect(await screen.findByText(/signed in where telegram opened the site/i, undefined, { timeout: 5000 })).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows a refusal as the server words it', async () => {
    signInWithTelegram.mockRejectedValue(new Error('Telegram verification is not available right now. Please try again later.'));
    render(<ContinueWithTelegram onDone={vi.fn()} />);
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: /continue with telegram/i })); });
    expect((await screen.findByRole('alert')).textContent).toMatch(/not available right now/);
  });
});
