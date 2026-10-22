// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sign-in's captcha is drawn in view (`mountCaptcha`): its token reaches
 * the caller, a refusal is a sentence, removing it stops it answering. Every
 * `getCaptchaToken` solves a fresh one (tokens are single-use).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let solved = 0;
let lastOpts: Record<string, unknown> = {};
let removed: string[] = [];

function installTurnstile() {
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (_el: HTMLElement, opts: Record<string, unknown>) => {
      solved += 1;
      lastOpts = opts;
      const n = solved;
      if (opts.execution === 'execute') queueMicrotask(() => (opts.callback as (t: string) => void)(`token-${n}`));
      return `w${n}`;
    },
    execute: () => {},
    remove: (id: string) => { removed.push(id); },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const { getCaptchaToken, mountCaptcha, captchaOn } = await import('./captcha');

beforeEach(() => {
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'site-key');
  solved = 0; lastOpts = {}; removed = [];
  installTurnstile();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('the captcha box drawn on the sign-in', () => {
  it('is drawn visibly, and its token reaches the caller', async () => {
    const onToken = vi.fn();
    mountCaptcha(document.createElement('div'), { onToken, onError: vi.fn() });
    await flush();
    expect(lastOpts.appearance).toBe('always');
    (lastOpts.callback as (t: string) => void)('tick');
    expect(onToken).toHaveBeenCalledWith('tick');
  });

  it('says why when Cloudflare refuses', async () => {
    const onError = vi.fn();
    mountCaptcha(document.createElement('div'), { onToken: vi.fn(), onError });
    await flush();
    (lastOpts['error-callback'] as (c: string) => boolean)('110200');
    expect(onError.mock.calls[0][0]).toMatch(/110200/);
  });

  it('once removed, it is taken off the page and answers nobody', async () => {
    const onToken = vi.fn();
    const remove = mountCaptcha(document.createElement('div'), { onToken, onError: vi.fn() });
    await flush();
    remove();
    expect(removed).toEqual(['w1']);
    (lastOpts.callback as (t: string) => void)('late');
    expect(onToken).not.toHaveBeenCalled();
  });

  it('draws nothing with captcha off', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '');
    expect(captchaOn()).toBe(false);
    mountCaptcha(document.createElement('div'), { onToken: vi.fn(), onError: vi.fn() });
    await flush();
    expect(solved).toBe(0);
    expect(await getCaptchaToken()).toBeNull();
  });
});

describe('a token per submission', () => {
  it('each call solves a fresh one', async () => {
    expect(await getCaptchaToken()).toBe('token-1');
    expect(await getCaptchaToken()).toBe('token-2');
  });
});
