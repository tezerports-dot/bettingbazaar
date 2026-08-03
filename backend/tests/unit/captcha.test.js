// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The captcha gate sits in front of every login on the platform, so the two
 * properties worth proving are the ones that take the whole platform down when
 * wrong: it must be inert when unconfigured, and it must NOT fail closed when
 * Cloudflare is unreachable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requireCaptcha, verifyCaptchaToken, captchaConfigured } from '../../middleware/captcha.js';

const ORIGINAL = process.env.TURNSTILE_SECRET_KEY;

function runGate(mw, req = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null, payload: null,
      status(c) { this.statusCode = c; return this; },
      json(p) { this.payload = p; resolve({ nexted: false, res: this }); return this; },
    };
    mw({ body: {}, headers: {}, ip: '1.2.3.4', ...req }, res, () => resolve({ nexted: true, res }));
  });
}

beforeEach(() => { delete process.env.TURNSTILE_SECRET_KEY; });
afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = ORIGINAL;
});

describe('unconfigured — must be completely inert', () => {
  it('reports not configured', () => {
    expect(captchaConfigured()).toBe(false);
  });

  it('passes the request through without a token', async () => {
    const { nexted } = await runGate(requireCaptcha('login'));
    expect(nexted).toBe(true);
  });

  it('never calls Cloudflare', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await runGate(requireCaptcha('login'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('verifyCaptchaToken resolves ok so callers cannot accidentally block', async () => {
    expect(await verifyCaptchaToken(undefined)).toEqual({ ok: true, reachable: true });
  });
});

describe('configured', () => {
  beforeEach(() => { process.env.TURNSTILE_SECRET_KEY = 'test-secret-value'; });

  it('rejects a request with no token', async () => {
    const { nexted, res } = await runGate(requireCaptcha('login'));
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.payload.code).toBe('CAPTCHA_REQUIRED');
  });

  it('allows a token Cloudflare accepts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ success: true }),
    });
    const { nexted } = await runGate(requireCaptcha('login'), { body: { 'cf-turnstile-response': 'good' } });
    expect(nexted).toBe(true);
  });

  it('rejects a token Cloudflare refuses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    const { nexted, res } = await runGate(requireCaptcha('login'), { body: { 'cf-turnstile-response': 'bad' } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('accepts the header fallback used by native clients', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const { nexted } = await runGate(requireCaptcha('login'), { headers: { 'x-captcha-token': 'good' } });
    expect(nexted).toBe(true);
  });

  // The whole point of the asymmetry: a Cloudflare outage must not become a
  // platform-wide login outage. An attacker cannot induce this path, because
  // they do not control whether Cloudflare answers us.
  it('ALLOWS when Cloudflare is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const { nexted } = await runGate(requireCaptcha('login'), { body: { 'cf-turnstile-response': 'x' } });
    expect(nexted).toBe(true);
  });

  it('ALLOWS when Cloudflare returns 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    const { nexted } = await runGate(requireCaptcha('login'), { body: { 'cf-turnstile-response': 'x' } });
    expect(nexted).toBe(true);
  });

  it('does not send a client-supplied IP — only what Express resolved', async () => {
    let sentBody;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, opts) => {
      sentBody = opts.body.toString();
      return { ok: true, json: async () => ({ success: true }) };
    });
    await runGate(requireCaptcha('login'), {
      body: { 'cf-turnstile-response': 'good' },
      headers: { 'x-forwarded-for': '9.9.9.9' },
      ip: '1.2.3.4',
    });
    expect(sentBody).toContain('remoteip=1.2.3.4');
    expect(sentBody).not.toContain('9.9.9.9');
  });
});
