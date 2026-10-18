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
const warmCaptchaToken = vi.fn();
vi.mock('../../services/captcha', () => ({ warmCaptchaToken: () => warmCaptchaToken() }));

const { default: ContinueWithTelegram, deliveryHere, openTelegram, opensAtOnce, APP_LINK_FALLBACK_MS } = await import('./ContinueWithTelegram');

const STEP = (delivery: 'MATCH' | 'HANDOFF', matchNumber: number | null) => ({
  kind: 'telegram', challengeToken: 'chal-1', delivery, matchNumber,
  telegram: { url: 'https://t.me/bb_bot?startapp=cabc', botUsername: 'bb_bot', expiresAt: '' }, message: '',
});

const ua = navigator.userAgent;
const setUa = (v: string) => Object.defineProperty(window.navigator, 'userAgent', { value: v, configurable: true });

beforeEach(() => {
  signInWithTelegram.mockReset(); pollTelegramStep.mockReset(); warmCaptchaToken.mockReset();
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

  it('solves the captcha while the button is on screen, and again after a failed try', async () => {
    signInWithTelegram.mockRejectedValue(new Error('Please complete the verification challenge and try again.'));
    render(<ContinueWithTelegram onDone={vi.fn()} />);
    expect(warmCaptchaToken).toHaveBeenCalledTimes(1);
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: /continue with telegram/i })); });
    await screen.findByRole('alert');
    expect(warmCaptchaToken).toHaveBeenCalledTimes(2);
  });

  it('shows a refusal as the server words it', async () => {
    signInWithTelegram.mockRejectedValue(new Error('Telegram verification is not available right now. Please try again later.'));
    render(<ContinueWithTelegram onDone={vi.fn()} />);
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: /continue with telegram/i })); });
    expect((await screen.findByRole('alert')).textContent).toMatch(/not available right now/);
  });
});

describe('opening the Telegram app', () => {
  const APP = 'tg://resolve?domain=bb_bot&startapp=cabc';
  const WEB = 'https://t.me/bb_bot?startapp=cabc';
  let href: string;
  let visibility: DocumentVisibilityState;
  const realLocation = window.location;

  beforeEach(() => {
    vi.useFakeTimers();
    href = '';
    visibility = 'visible';
    Object.defineProperty(window, 'location', { configurable: true, value: { set href(v: string) { href = v; }, get href() { return href; } } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    vi.restoreAllMocks();
  });

  it('a laptop: the window losing focus to Telegram Desktop cancels the https fallback', () => {
    openTelegram(APP, WEB);
    expect(href).toBe(APP);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(APP_LINK_FALLBACK_MS);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('without a fallback goes to the app address only', () => {
    openTelegram(APP, WEB, { fallback: false });
    expect(href).toBe(APP);
    vi.advanceTimersByTime(APP_LINK_FALLBACK_MS * 2);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('goes to the app address, and opens nothing else once Telegram has taken over', () => {
    openTelegram(APP, WEB);
    expect(href).toBe(APP);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(APP_LINK_FALLBACK_MS);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('falls back to the https link when the page is still in front (no Telegram on the phone)', () => {
    openTelegram(APP, WEB);
    vi.advanceTimersByTime(APP_LINK_FALLBACK_MS - 1);
    expect(window.open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(window.open).toHaveBeenCalledWith(WEB, '_blank', 'noopener,noreferrer');
  });
});

describe('one tap opens Telegram', () => {
  it('opens at once on a HANDOFF and on a laptop, but waits on a phone that must read its number first', () => {
    expect(opensAtOnce('HANDOFF', true)).toBe(true);
    expect(opensAtOnce('HANDOFF', false)).toBe(true);
    expect(opensAtOnce('MATCH', false)).toBe(true);
    expect(opensAtOnce('MATCH', true)).toBe(false);
    expect(opensAtOnce(undefined, false)).toBe(false);
  });

  const APP = 'tg://resolve?domain=bb_bot&startapp=cabc';
  const realLocation = window.location;
  let href = '';
  beforeEach(() => {
    href = '';
    Object.defineProperty(window, 'location', { configurable: true, value: { set href(v: string) { href = v; }, get href() { return href; }, origin: realLocation.origin } });
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    vi.restoreAllMocks();
  });

  it('a laptop: the one press opens the Telegram app, with no t.me tab and the number and QR still shown', async () => {
    setUa('Mozilla/5.0 (Windows NT 10.0) Chrome/130');
    const step = STEP('MATCH', 47);
    signInWithTelegram.mockResolvedValue({ ...step, telegram: { ...step.telegram, appUrl: APP } });
    pollTelegramStep.mockResolvedValue('pending');
    render(<ContinueWithTelegram onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /continue with telegram/i }));
    expect((await screen.findByTestId('match-number')).textContent).toBe('47');
    expect(href).toBe(APP);
    expect(screen.getByRole('img', { name: /qr code that opens telegram/i })).toBeTruthy();
    await new Promise((r) => setTimeout(r, APP_LINK_FALLBACK_MS + 100));
    expect(window.open).not.toHaveBeenCalled();
  });

  it('an iPhone: the number is shown first, and Telegram waits for the Open Telegram press', async () => {
    setUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari');
    const realMatch = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('coarse'), media: q })) as unknown as typeof window.matchMedia;
    try {
      const step = STEP('MATCH', 12);
      signInWithTelegram.mockResolvedValue({ ...step, telegram: { ...step.telegram, appUrl: APP } });
      pollTelegramStep.mockResolvedValue('pending');
      render(<ContinueWithTelegram onDone={vi.fn()} />);
      await userEvent.click(screen.getByRole('button', { name: /continue with telegram/i }));
      expect((await screen.findByTestId('match-number')).textContent).toBe('12');
      expect(href).toBe('');
      await userEvent.click(screen.getByRole('link', { name: /open telegram/i }));
      expect(href).toBe(APP);
    } finally { window.matchMedia = realMatch; }
  });
});
