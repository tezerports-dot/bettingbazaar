// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sign-in screen's Telegram steps (Step 3): approve a sign-in, verify the
 * mobile after applying, and "Login with Telegram" finished by the password.
 * The server's answers are mocked at the api module; what is asserted is what
 * the merchant sees and which call the screen makes next.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const auth = vi.hoisted(() => ({
  merchant: null, loading: false, unreachable: false,
  login: vi.fn(), acceptSession: vi.fn(), refreshProfile: vi.fn(),
}));
vi.mock('../services/AuthContext', () => ({ useAuth: () => auth }));

const api = vi.hoisted(() => ({
  signedOutReason: vi.fn(() => null),
  getMiniAppSetup: vi.fn(),
  pollLoginChallenge: vi.fn(),
  startTelegramLogin: vi.fn(),
  pollTelegramLogin: vi.fn(),
  merchantSignup: vi.fn(),
}));
vi.mock('../services/api', () => ({ api, default: api, ...api }));

const { default: LoginPage } = await import('./LoginPage');

const TELEGRAM = { url: 'https://t.me/bb_bot/app?startapp=c-1', botUsername: 'bb_bot', expiresAt: '2026-10-08T10:00:00Z' };
const refusal = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(String(data.message)), { status, data: { success: false, ...data } });

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

const mount = async () => {
  render(<MemoryRouter><LoginPage /></MemoryRouter>);
  await flush();
};

const signIn = async () => {
  fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9876543210' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
  fireEvent.click(screen.getByRole('button', { name: /Sign in securely/ }));
  await flush();
};

describe('sign-in owes a Telegram approval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.getMiniAppSetup.mockResolvedValue({ success: true, available: true, botUsername: 'bb_bot', resetUrl: 'https://t.me/bb_bot/app?startapp=reset-MERCHANT' });
    auth.login.mockResolvedValue({ challengeToken: 'ch-1', telegram: TELEGRAM, message: 'Approve this sign-in in Telegram.', verify: false });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('opens the link in a new tab and signs in when the poll answers a session', async () => {
    await mount();
    await signIn();
    expect(screen.getByText('Approve in Telegram')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open Telegram/ });
    expect(link.getAttribute('href')).toBe(TELEGRAM.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    api.pollLoginChallenge.mockResolvedValueOnce(null);
    await flush(3000);
    expect(api.pollLoginChallenge).toHaveBeenCalledWith('ch-1');
    expect(auth.acceptSession).not.toHaveBeenCalled();

    const session = { success: true, token: 't', merchant: { merchantId: 'm1' } };
    api.pollLoginChallenge.mockResolvedValueOnce(session);
    await flush(3000);
    expect(auth.acceptSession).toHaveBeenCalledWith(session);
  });

  it('stops on a denial and shows the server\'s words', async () => {
    await mount();
    await signIn();
    api.pollLoginChallenge.mockRejectedValueOnce(refusal(401, { code: 'TWO_FACTOR_DENIED', message: 'This sign-in was refused in Telegram.' }));
    await flush(3000);
    expect(screen.getByRole('alert').textContent).toContain('This sign-in was refused in Telegram.');
    await flush(9000);
    expect(api.pollLoginChallenge).toHaveBeenCalledTimes(1);
  });

  it('a verified merchant awaiting approval is told so, not shown an error', async () => {
    auth.login.mockResolvedValue({ challengeToken: 'ch-2', telegram: TELEGRAM, message: '', verify: true });
    await mount();
    await signIn();
    expect(screen.getByText('Verify your mobile in Telegram')).toBeTruthy();
    api.pollLoginChallenge.mockRejectedValueOnce(refusal(403, { code: 'MERCHANT_NOT_ACTIVE', verified: true, message: 'Your account is pending approval.' }));
    await flush(3000);
    expect(screen.getByText(/Verified\. Your account is waiting for approval\./)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Back stops the poll', async () => {
    await mount();
    await signIn();
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    await flush(9000);
    expect(api.pollLoginChallenge).not.toHaveBeenCalled();
  });
});

describe('Login with Telegram and Forgot password', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('are hidden when the platform has no bot', async () => {
    api.getMiniAppSetup.mockResolvedValue({ success: true, available: false, botUsername: '', resetUrl: null });
    await mount();
    expect(screen.queryByRole('button', { name: /Login with Telegram/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Forgot password/ })).toBeNull();
  });

  it('Forgot password opens the reset link', async () => {
    api.getMiniAppSetup.mockResolvedValue({ success: true, available: true, botUsername: 'bb_bot', resetUrl: 'https://t.me/bb_bot/app?startapp=reset-MERCHANT' });
    await mount();
    const link = screen.getByRole('link', { name: /Forgot password/ });
    expect(link.getAttribute('href')).toBe('https://t.me/bb_bot/app?startapp=reset-MERCHANT');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('an approved Telegram login is finished by the password, with its token', async () => {
    api.getMiniAppSetup.mockResolvedValue({ success: true, available: true, botUsername: 'bb_bot', resetUrl: null });
    api.startTelegramLogin.mockResolvedValue({ challengeToken: 'tg-1', telegram: TELEGRAM, message: 'Open Telegram to sign in.' });
    api.pollTelegramLogin.mockResolvedValueOnce(null).mockResolvedValueOnce(true);
    auth.login.mockResolvedValue(null);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /Login with Telegram/ }));
    await flush();
    expect(screen.getByRole('link', { name: /Open Telegram/ }).getAttribute('href')).toBe(TELEGRAM.url);
    await flush(3000);
    await flush(3000);
    expect(api.pollTelegramLogin).toHaveBeenCalledWith('tg-1');
    expect(screen.getByText('Telegram confirmed it is you')).toBeTruthy();
    await signIn();
    expect(auth.login).toHaveBeenCalledWith({ mobile: '9876543210', password: 'correct horse', challengeToken: 'tg-1' });
  });
});

describe('applying ends on the Telegram verification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.getMiniAppSetup.mockResolvedValue({ success: true, available: true, botUsername: 'bb_bot', resetUrl: null });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  const apply = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Apply as Merchant' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newmerchant' } });
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9876543210' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long enough pw' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'long enough pw' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit application/ }));
    await flush();
  };

  it('polls /login/2fa and shows pending approval once verified', async () => {
    api.merchantSignup.mockResolvedValue({
      success: true, verificationRequired: true, verificationAvailable: true,
      challengeToken: 'v-1', telegram: TELEGRAM, message: 'Application submitted. Verify your mobile number in Telegram now.',
    });
    await mount();
    await apply();
    expect(screen.getByText('Verify your mobile in Telegram')).toBeTruthy();
    api.pollLoginChallenge.mockRejectedValueOnce(refusal(403, { code: 'MERCHANT_NOT_ACTIVE', verified: true, message: 'Pending approval.' }));
    await flush(3000);
    expect(api.pollLoginChallenge).toHaveBeenCalledWith('v-1');
    expect(screen.getByText(/Verified\. Your account is waiting for approval\./)).toBeTruthy();
  });

  it('with no bot set up, shows the server\'s message', async () => {
    api.merchantSignup.mockResolvedValue({
      success: true, verificationRequired: true, verificationAvailable: false,
      challengeToken: null, telegram: null, message: 'Application submitted. You verify at your first sign-in.',
    });
    await mount();
    await apply();
    expect(screen.getByText(/You verify at your first sign-in\./)).toBeTruthy();
    await flush(9000);
    expect(api.pollLoginChallenge).not.toHaveBeenCalled();
  });

  it('a refusal is announced in the server\'s words', async () => {
    api.merchantSignup.mockRejectedValue(refusal(409, { code: 'MOBILE_TAKEN', message: 'Mobile number already registered' }));
    await mount();
    await apply();
    expect(screen.getByRole('alert').textContent).toContain('Mobile number already registered');
  });
});
