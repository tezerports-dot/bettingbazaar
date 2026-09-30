// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * What the two merchant-wallet money calls actually put on the wire.
 *
 * ── The defect this exists to stop coming back ─────────────────────────────
 * `POST /merchants/:id/deduct` REQUIRES an Idempotency-Key and answers 400
 * without one — only the caller can tell a redelivery from a second deliberate
 * deduction, so the server refuses to guess. `deductWallet` never sent one. So
 * every press of "Deduct From Wallet" since it shipped came back with
 * "Idempotency-Key is required for this request. Send the SAME key when
 * retrying…" — a protocol message, rendered to an operator as the reason their
 * money action failed, on a screen where nothing else explains it. Confirmed
 * against a running server: the identical call with a key returns 200.
 *
 * `check:ui-coverage` could never see this. The path resolves and the method is
 * right; what was missing was a HEADER. That is the gap between "a button calls
 * a route" and "the call the button makes is one the route accepts" (§28), and
 * the only thing that closes it is asserting the request itself.
 *
 * ── And the settlement figure ──────────────────────────────────────────────
 * Both calls now carry what the platform received or paid for the tokens. The
 * treasury already recorded that the tokens moved; without this nothing records
 * that they were SOLD, and the profit and loss is missing the revenue side of
 * every admin↔merchant trade. The server refuses a request without it, so a
 * panel that forgot to send it would fail loudly rather than book a blank — but
 * failing loudly on a money screen is still a broken button, which is why it is
 * asserted here rather than left to the server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { post, put, get, del, instance } = vi.hoisted(() => {
  const ok = async (..._args: any[]) => ({ data: { success: true } });
  const post = vi.fn(ok);
  const put = vi.fn(ok);
  const get = vi.fn(ok);
  const del = vi.fn(ok);
  const instance: any = {
    post, put, get, delete: del,
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    defaults: { headers: { common: {} } },
  };
  return { post, put, get, del, instance };
});

vi.mock('axios', () => ({
  default: { create: vi.fn(() => instance), isAxiosError: vi.fn(() => false) },
  isAxiosError: vi.fn(() => false),
}));

import { merchants } from './api';

const MERCHANT = 'MCH_TEST_0001';
const bodyOf   = (call: any[]) => call[1];
const headerOf = (call: any[], name: string) => call[2]?.headers?.[name];

describe('the merchant wallet calls', () => {
  beforeEach(() => { post.mockClear(); });

  it('sends an Idempotency-Key when DEDUCTING — the server 400s without one', async () => {
    await (merchants as any).deductWallet(MERCHANT, 500, 'off-boarding', 480);

    expect(post).toHaveBeenCalledTimes(1);
    const call = post.mock.calls[0];
    expect(call[0]).toBe(`/api/admin/merchants/${MERCHANT}/deduct`);
    const key = headerOf(call, 'Idempotency-Key');
    expect(key).toBeTruthy();
    expect(String(key).length).toBeGreaterThan(8);
  });

  it('sends an Idempotency-Key when FUNDING', async () => {
    await (merchants as any).fundWallet(MERCHANT, 1000, { amount: 950, currency: 'INR' });
    expect(headerOf(post.mock.calls[0], 'Idempotency-Key')).toBeTruthy();
  });

  /**
   * One invocation is one intent. A transport-level retry inside axios reuses
   * the same header and cannot double-deduct; a second click is a genuinely
   * different request and must get a different key, or the second deduction is
   * silently swallowed as a duplicate of the first.
   */
  it('mints a DIFFERENT key for a second press, and honours an explicit one for a retry', async () => {
    await (merchants as any).deductWallet(MERCHANT, 500, 'first', 500);
    await (merchants as any).deductWallet(MERCHANT, 500, 'second', 500);
    const [a, b] = post.mock.calls.map((c) => headerOf(c, 'Idempotency-Key'));
    expect(a).not.toBe(b);

    post.mockClear();
    await (merchants as any).deductWallet(MERCHANT, 500, 'retry', 500, 'carried-over-key');
    expect(headerOf(post.mock.calls[0], 'Idempotency-Key')).toBe('carried-over-key');
  });

  it('carries what the platform PAID on a deduction, in rupees', async () => {
    await (merchants as any).deductWallet(MERCHANT, 500, 'buy-back', 480);
    expect(bodyOf(post.mock.calls[0])).toMatchObject({
      tokenAmount: 500, reason: 'buy-back',
      settlementAmount: 480, settlementCurrency: 'INR',
    });
  });

  it('carries what the platform RECEIVED on a top-up, in the currency chosen', async () => {
    await (merchants as any).fundWallet(MERCHANT, 9000, { amount: 100, currency: 'USDT' }, 'chain transfer');
    expect(bodyOf(post.mock.calls[0])).toMatchObject({
      tokenAmount: 9000, note: 'chain transfer',
      settlementAmount: 100, settlementCurrency: 'USDT',
    });
  });

  /**
   * Zero is a real answer — an admin correcting their own mis-keyed top-up
   * moved tokens for no money — and it must reach the server as 0 rather than
   * being dropped by a falsy check on the way out. A request with no figure is
   * refused by the server, so a dropped 0 would read to the operator as "you
   * forgot to fill this in" on a form they had filled in.
   */
  it('sends a settlement of zero rather than omitting it', async () => {
    await (merchants as any).fundWallet(MERCHANT, 100, { amount: 0, currency: 'INR' });
    const body = bodyOf(post.mock.calls[0]);
    expect(body).toHaveProperty('settlementAmount', 0);
    expect(body.settlementAmount).not.toBeUndefined();
  });
});
