// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The captcha is solved before the tap (`warmCaptchaToken`) and each token is
 * still spent once: the next submit takes the warmed one, a retry solves anew.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let solved = 0;
let answer: (token: string | null) => void = () => {};
let hold = false;

function installTurnstile() {
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (_el: HTMLElement, opts: { callback: (t: string) => void; 'error-callback': (c: string) => boolean }) => {
      solved += 1;
      const n = solved;
      answer = (t) => (t ? opts.callback(t) : opts['error-callback']('300030'));
      if (!hold) queueMicrotask(() => opts.callback(`token-${n}`));
      return `w${n}`;
    },
    execute: () => {},
    remove: () => {},
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const { warmCaptchaToken, getCaptchaToken, resetWarmCaptcha, WARM_TOKEN_MAX_AGE_MS } = await import('./captcha');

beforeEach(() => {
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
  solved = 0; hold = false; resetWarmCaptcha();
  installTurnstile();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('captcha warmed before the tap', () => {
  it('the submit takes the warmed token without solving again, and a retry solves a fresh one', async () => {
    warmCaptchaToken();
    await flush();
    expect(solved).toBe(1);
    expect(await getCaptchaToken()).toBe('token-1');
    expect(solved).toBe(1);
    expect(await getCaptchaToken()).toBe('token-2');
    expect(solved).toBe(2);
  });

  it('a submit while the warm-up is still solving waits for that one, not a second', async () => {
    hold = true;
    warmCaptchaToken();
    const pending = getCaptchaToken();
    await flush();
    answer('late-token');
    expect(await pending).toBe('late-token');
    expect(solved).toBe(1);
  });

  it('warming twice solves once', async () => {
    warmCaptchaToken(); warmCaptchaToken();
    await flush();
    expect(solved).toBe(1);
  });

  it('a warmed token past its age is not used', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    warmCaptchaToken();
    await flush();
    vi.setSystemTime(Date.now() + WARM_TOKEN_MAX_AGE_MS + 1);
    expect(await getCaptchaToken()).toBe('token-2');
  });

  it('a warm-up that fails while the player waits says so, without a second full wait', async () => {
    hold = true;
    warmCaptchaToken();
    const pending = getCaptchaToken();
    await flush();
    answer(null);
    expect(await pending).toBeNull();
    expect(solved).toBe(1);
  });

  it('does nothing with captcha off', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '');
    warmCaptchaToken();
    await flush();
    expect(solved).toBe(0);
    expect(await getCaptchaToken()).toBeNull();
  });
});
