// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * "Continue with Telegram": the captcha in view, then one "Login with
 * Telegram" button whose press is the navigation. The delivery is chosen by
 * the device (HANDOFF on Android, MATCH elsewhere); a MATCH shows its number
 * and the QR; nothing opens Telegram before the press; the bot is not named.
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
let captcha = false;
let handlers: { onToken: (t: string) => void; onError: (m: string) => void } | null = null;
const mounted = vi.fn();
vi.mock('../../services/captcha', () => ({
  captchaOn: () => captcha,
  mountCaptcha: (_el: HTMLElement, h: typeof handlers) => { handlers = h; mounted(); return () => {}; },
}));

const { default: ContinueWithTelegram, deliveryHere, openTelegram, APP_LINK_FALLBACK_MS } = await import('./ContinueWithTelegram');

const APP_URL = 'tg://resolve?domain=bb_bot&startapp=cabc';
const STEP = (delivery: 'MATCH' | 'HANDOFF', matchNumber: number | null) => ({
  kind: 'telegram', challengeToken: 'chal-1', delivery, matchNumber,
  telegram: { url: 'https://t.me/bb_bot?startapp=cabc', appUrl: APP_URL, botUsername: 'bb_bot', expiresAt: '' }, message: '',
});

const ua = navigator.userAgent;
const setUa = (v: string) => Object.defineProperty(window.navigator, 'userAgent', { value: v, configurable: true });
const realMatch = window.matchMedia;
const setTouch = (touch: boolean) => {
  window.matchMedia = ((q: string) => ({ matches: touch && q.includes('coarse'), media: q })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  signInWithTelegram.mockReset(); pollTelegramStep.mockReset(); mounted.mockReset();
  stored = null; native = false; captcha = false; handlers = null; setUa(ua); setTouch(false);
});
afterEach(() => { vi.useRealTimers(); setUa(ua); window.matchMedia = realMatch; });

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

  it('the button stays off until the captcha ticks; the tick asks for the sign-in with its token', async () => {
    captcha = true;
    signInWithTelegram.mockResolvedValue(STEP('HANDOFF', null));
    render(<ContinueWithTelegram onDone={vi.fn()} />);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: /login with telegram/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/checking your connection is secure/i)).toBeTruthy();
    expect(signInWithTelegram).not.toHaveBeenCalled();
    await act(async () => { handlers!.onToken('tick-token'); });
    expect(signInWithTelegram).toHaveBeenCalledWith(expect.objectContaining({ captchaToken: 'tick-token' }));
    expect((await screen.findByRole('link', { name: /login with telegram/i })).getAttribute('href')).toBe('https://t.me/bb_bot?startapp=cabc');
  });

  it('a laptop shows the number to choose and a QR, sends the stored invite code, and is signed in by the poll', async () => {
    setUa('Mozilla/5.0 (Windows NT 10.0) Chrome/130');
    stored = 'ALICE1';
    signInWithTelegram.mockResolvedValue(STEP('MATCH', 47));
    pollTelegramStep.mockResolvedValue('done');
    const onDone = vi.fn();
    render(<ContinueWithTelegram onDone={onDone} />);
    expect(signInWithTelegram).toHaveBeenCalledWith({ delivery: 'MATCH', referralCode: 'ALICE1', captchaToken: null });
    expect((await screen.findByTestId('match-number')).textContent).toBe('47');
    expect(screen.getByRole('img', { name: /qr code that opens telegram/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /login with telegram/i }).getAttribute('href')).toBe('https://t.me/bb_bot?startapp=cabc');
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled(), { timeout: 5000 });
    expect(pollTelegramStep).toHaveBeenCalledWith('chal-1');
  });

  it('never names the bot', async () => {
    signInWithTelegram.mockResolvedValue(STEP('MATCH', 47));
    pollTelegramStep.mockResolvedValue('pending');
    const { container } = render(<ContinueWithTelegram onDone={vi.fn()} />);
    await screen.findByRole('link', { name: /login with telegram/i });
    expect(container.textContent).not.toMatch(/bb_bot/);
  });

  it('a phone that hands off: nothing opens before the press, the press opens the Telegram app, then it says where the session went', async () => {
    setUa('Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile');
    setTouch(true);
    const realLocation = window.location;
    let href = '';
    Object.defineProperty(window, 'location', { configurable: true, value: { set href(v: string) { href = v; }, get href() { return href; }, origin: realLocation.origin } });
    vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      signInWithTelegram.mockResolvedValue(STEP('HANDOFF', null));
      pollTelegramStep.mockResolvedValue('handedOff');
      const onDone = vi.fn();
      render(<ContinueWithTelegram onDone={onDone} />);
      const link = await screen.findByRole('link', { name: /login with telegram/i });
      expect(screen.queryByTestId('match-number')).toBeNull();
      expect(screen.queryByRole('img', { name: /qr code/i })).toBeNull();
      await new Promise((r) => setTimeout(r, 50));
      expect(href).toBe('');
      expect(pollTelegramStep).not.toHaveBeenCalled();
      await userEvent.click(link);
      expect(href).toBe(APP_URL);
      expect(await screen.findByText(/signed in where telegram opened the site/i, undefined, { timeout: 5000 })).toBeTruthy();
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
      vi.restoreAllMocks();
    }
  });

  it('shows a refusal as the server words it, and Try again draws a fresh captcha and asks again', async () => {
    captcha = true;
    signInWithTelegram.mockRejectedValue(new Error('Telegram verification is not available right now. Please try again later.'));
    render(<ContinueWithTelegram onDone={vi.fn()} />);
    await act(async () => { handlers!.onToken('t1'); });
    expect((await screen.findByRole('alert')).textContent).toMatch(/not available right now/);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(mounted).toHaveBeenCalledTimes(2);
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

