// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant sign-in screen: one "Continue with Telegram" (owner,
 * 2026-10-14), no password and no application form. The server's answers are
 * mocked at the api module; what is asserted is what the merchant sees and
 * which call the screen makes next.
 *
 * ── What this replaced ─────────────────────────────────────────────────────
 * LoginPage.telegram.test.tsx: the password leg's Telegram approval, the
 * application form's verification, "Login with Telegram" finished by the
 * password, and Forgot password. All of that is gone with the password.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { qrPath } from '../utils/qrPath';

const auth = vi.hoisted(() => ({
  merchant: null, loading: false, unreachable: false,
  acceptSession: vi.fn(), refreshProfile: vi.fn(),
}));
vi.mock('../services/AuthContext', () => ({ useAuth: () => auth }));

const api = vi.hoisted(() => ({
  signedOutReason: vi.fn(() => null),
  getMiniAppSetup: vi.fn(),
  startTelegramSignIn: vi.fn(),
  pollTelegramSignIn: vi.fn(),
  redeemTelegramTicket: vi.fn(),
}));
vi.mock('../services/api', () => ({ api, default: api, ...api }));

const ticket = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../services/telegramTicket', () => ({
  takeTelegramTicket: () => { const t = ticket.value; ticket.value = null; return t; },
}));

const { default: LoginPage, deliveryHere } = await import('./LoginPage');

const TELEGRAM = { url: 'https://t.me/bb_bot/app?startapp=c-1', appUrl: 'tg://resolve?domain=bb_bot&appname=app&startapp=c-1', botUsername: 'bb_bot', expiresAt: '2026-10-08T10:00:00Z' };
const refusal = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(String(data.message)), { status, data: { success: false, ...data } });

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const mount = async () => { render(<MemoryRouter><LoginPage /></MemoryRouter>); await flush(); };
const press = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Continue with Telegram/ }));
  await flush();
};

const ua = navigator.userAgent;
const setUa = (v: string) => Object.defineProperty(window.navigator, 'userAgent', { value: v, configurable: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ticket.value = null;
  setUa('Mozilla/5.0 (Windows NT 10.0) Chrome/130');
  api.getMiniAppSetup.mockResolvedValue({ success: true, available: true, botUsername: 'bb_bot' });
  api.startTelegramSignIn.mockResolvedValue({ challengeToken: 'ch-1', telegram: TELEGRAM, delivery: 'MATCH', matchNumber: 47 });
  api.pollTelegramSignIn.mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); setUa(ua); });

describe('the sign-in screen', () => {
  it('offers one button and nothing to type', async () => {
    await mount();
    expect(screen.getByRole('button', { name: /Continue with Telegram/ })).toBeTruthy();
    expect(document.querySelector('input')).toBeNull();
    expect(screen.queryByRole('button', { name: /Apply as Merchant|Sign in securely/ })).toBeNull();
    expect(screen.queryByText(/forgot password/i)).toBeNull();
  });

  it('says an admin creates the account first, and Telegram confirms it', async () => {
    await mount();
    expect(screen.getByText(/share your contact to apply/i)).toBeTruthy();
  });

  it('says plainly that nobody can sign in when no bot is set up', async () => {
    api.getMiniAppSetup.mockResolvedValue({ success: true, available: false, botUsername: '' });
    await mount();
    expect(screen.getByRole('alert').textContent).toMatch(/telegram is not set up on this platform yet/i);
    expect(screen.queryByRole('button', { name: /Continue with Telegram/ })).toBeNull();
  });

  it('chooses HANDOFF in an Android browser, MATCH anywhere else', () => {
    expect(deliveryHere()).toBe('MATCH');
    setUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari');
    expect(deliveryHere()).toBe('MATCH');
    setUa('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile');
    expect(deliveryHere()).toBe('HANDOFF');
  });
});

describe('a MATCH sign-in (a laptop)', () => {
  it('shows the number and a QR, opens Telegram in a new tab, and signs in when the poll answers a session', async () => {
    await mount();
    await press();
    expect(api.startTelegramSignIn).toHaveBeenCalledWith('MATCH');
    expect(screen.getByTestId('match-number').textContent).toBe('47');
    const qr = screen.getByRole('img', { name: /QR code that opens Telegram/i });
    // Telegram's app address, so the phone's camera opens Telegram itself (owner, 2026-10-24).
    expect(qr.querySelector('path')?.getAttribute('d')).toBe(qrPath(TELEGRAM.appUrl)!.d);
    const link = screen.getByRole('link', { name: /Open Telegram/ });
    expect(link.getAttribute('href')).toBe(TELEGRAM.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    await flush(3000);
    expect(api.pollTelegramSignIn).toHaveBeenCalledWith('ch-1');
    expect(auth.acceptSession).not.toHaveBeenCalled();

    const session = { success: true, token: 't', merchant: { merchantId: 'm1' } };
    api.pollTelegramSignIn.mockResolvedValueOnce(session);
    await flush(3000);
    expect(auth.acceptSession).toHaveBeenCalledWith(session);
  });

  it('stops on a denial and shows the server\'s words', async () => {
    await mount();
    await press();
    api.pollTelegramSignIn.mockRejectedValueOnce(refusal(401, { code: 'TWO_FACTOR_DENIED', message: 'This sign-in was refused in Telegram.' }));
    await flush(3000);
    expect(screen.getByRole('alert').textContent).toBe('This sign-in was refused in Telegram.');
    await flush(9000);
    expect(api.pollTelegramSignIn).toHaveBeenCalledTimes(1);
  });

  it('an account not active yet is told so, not shown an error', async () => {
    await mount();
    await press();
    api.pollTelegramSignIn.mockRejectedValueOnce(refusal(403, { code: 'MERCHANT_NOT_ACTIVE', message: 'Your merchant account is waiting for approval.' }));
    await flush(3000);
    expect(screen.getByText('Account not active yet')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/waiting for approval/);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Back stops the poll', async () => {
    await mount();
    await press();
    fireEvent.click(screen.getByRole('button', { name: /Back to sign in/ }));
    await flush(9000);
    expect(api.pollTelegramSignIn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Continue with Telegram/ })).toBeTruthy();
  });
});

describe('a HANDOFF sign-in (an Android phone)', () => {
  it('waits without a number, and says where the session went once handed off', async () => {
    setUa('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile');
    api.startTelegramSignIn.mockResolvedValue({ challengeToken: 'ch-2', telegram: TELEGRAM, delivery: 'HANDOFF', matchNumber: null });
    await mount();
    await press();
    expect(api.startTelegramSignIn).toHaveBeenCalledWith('HANDOFF');
    expect(screen.queryByTestId('match-number')).toBeNull();
    api.pollTelegramSignIn.mockResolvedValueOnce('handedOff');
    await flush(3000);
    expect(screen.getByText(/signed in where Telegram opened the panel/i)).toBeTruthy();
    expect(auth.acceptSession).not.toHaveBeenCalled();
    await flush(9000);
    expect(api.pollTelegramSignIn).toHaveBeenCalledTimes(1);
  });

  it('spends the ticket Verify opened the panel with, once, and signs in', async () => {
    ticket.value = 'T'.repeat(43);
    const session = { success: true, token: 't', merchant: { merchantId: 'm1' } };
    api.redeemTelegramTicket.mockResolvedValue(session);
    await mount();
    expect(api.redeemTelegramTicket).toHaveBeenCalledTimes(1);
    expect(api.redeemTelegramTicket).toHaveBeenCalledWith('T'.repeat(43));
    expect(auth.acceptSession).toHaveBeenCalledWith(session);
  });

  it('says plainly when the ticket was used or expired', async () => {
    ticket.value = 'T'.repeat(43);
    api.redeemTelegramTicket.mockRejectedValue(refusal(401, { code: 'TICKET_INVALID', message: 'This sign-in link has already been used or has expired. Press Continue with Telegram again.' }));
    await mount();
    expect(screen.getByRole('alert').textContent).toMatch(/already been used or has expired/);
    expect(auth.acceptSession).not.toHaveBeenCalled();
  });
});
