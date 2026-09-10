// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A URL that is stored and later rendered to somebody else.
 *
 * Five fields did this with no validation, and two of them are PAYMENT
 * INSTRUCTIONS shown to a player: a merchant's QR image, and the ATM cash
 * link. An upload route existed for the QR, but nothing bound the stored value
 * to it — the merchant sent whatever string they liked to
 * `PUT /api/merchant/profile` and the player's payment screen rendered it.
 *
 * What is asserted here is the refusal, not the acceptance: the interesting
 * cases are the ones that LOOK like our CDN and are not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ORIGINAL_CDN = process.env.CDN_URL;
let assertCdnAssetUrl, assertPaymentIntent, assertExternalHttpsUrl;

beforeAll(async () => {
  process.env.CDN_URL = 'https://cdn.example.com';
  ({ assertCdnAssetUrl, assertPaymentIntent, assertExternalHttpsUrl } =
    await import('../../shared/storedUrl.js'));
});
afterAll(() => {
  if (ORIGINAL_CDN === undefined) delete process.env.CDN_URL;
  else process.env.CDN_URL = ORIGINAL_CDN;
});

describe('assertCdnAssetUrl — an asset WE hold, and nothing else', () => {
  it('accepts an object on the configured CDN', () => {
    const url = 'https://cdn.example.com/merchant-qr/1700000000-abcdef.png';
    expect(assertCdnAssetUrl(url, 'QR code')).toBe(url);
  });

  it('REFUSES a host that merely starts with the CDN origin', () => {
    // The reason this compares parsed origins instead of using startsWith.
    // `https://cdn.example.com.evil.test/x.png` passes a prefix test and is
    // somebody else's server.
    expect(() => assertCdnAssetUrl('https://cdn.example.com.evil.test/x.png', 'QR code'))
      .toThrow(/uploaded here first/);
  });

  it('refuses an unrelated host', () => {
    expect(() => assertCdnAssetUrl('https://evil.test/qr.png', 'QR code')).toThrow(/uploaded here first/);
  });

  it('refuses credentials embedded in the URL', () => {
    // Never legitimate for an asset, and a known way to make a hostile link
    // read as a familiar one.
    expect(() => assertCdnAssetUrl('https://a:b@cdn.example.com/x.png', 'QR code')).toThrow(/not accepted/);
  });

  it('refuses a scheme that is not http(s) on our origin', () => {
    expect(() => assertCdnAssetUrl('javascript:alert(1)', 'QR code')).toThrow();
    expect(() => assertCdnAssetUrl('data:image/png;base64,AAAA', 'QR code')).toThrow();
  });

  it('refuses empty and refuses garbage', () => {
    expect(() => assertCdnAssetUrl('', 'QR code')).toThrow(/required/);
    expect(() => assertCdnAssetUrl('not a url', 'QR code')).toThrow(/not a valid URL/);
  });

  it('carries a 400 and a code, so a route can answer without inventing one', () => {
    try { assertCdnAssetUrl('https://evil.test/x.png', 'QR code'); }
    catch (e) { expect(e.status).toBe(400); expect(e.code).toBe('UNSAFE_URL'); }
  });

  it('FAILS CLOSED when no CDN is configured', async () => {
    // With no CDN there is no such thing as "our own asset", so there is
    // nothing this can honestly accept. Read at call time, not at import, which
    // is what makes this testable at all.
    const saved = process.env.CDN_URL;
    delete process.env.CDN_URL;
    try {
      expect(() => assertCdnAssetUrl('https://cdn.example.com/x.png', 'QR code'))
        .toThrow(/not configured/);
    } finally { process.env.CDN_URL = saved; }
  });
});

describe('assertPaymentIntent — what a player is told to pay', () => {
  it('accepts a UPI intent naming a payee', () => {
    const link = 'upi://pay?pa=merchant@bank&am=10000&cu=INR';
    expect(assertPaymentIntent(link)).toBe(link);
  });

  it('refuses an http link dressed as a payment', () => {
    expect(() => assertPaymentIntent('https://evil.test/pay')).toThrow(/not a UPI payment link/);
  });

  it('refuses a UPI intent with no payee — a player cannot pay it', () => {
    expect(() => assertPaymentIntent('upi://pay?am=10000')).toThrow(/names no payee/);
  });

  it('bounds the length before parsing', () => {
    // This string is fanned out over a socket to every waiting client.
    expect(() => assertPaymentIntent(`upi://pay?pa=a@b&x=${'y'.repeat(3000)}`)).toThrow(/too long/);
  });

  it('refuses empty', () => {
    expect(() => assertPaymentIntent('')).toThrow(/required/);
  });
});

describe('assertExternalHttpsUrl — stored by one party, followed by another', () => {
  it('accepts https', () => {
    expect(assertExternalHttpsUrl('https://merchant.example/panel', 'panel URL'))
      .toBe('https://merchant.example/panel');
  });
  it('refuses http', () => {
    expect(() => assertExternalHttpsUrl('http://merchant.example', 'panel URL')).toThrow(/https:\/\//);
  });
  it('refuses credentials', () => {
    expect(() => assertExternalHttpsUrl('https://a:b@merchant.example', 'panel URL')).toThrow(/not accepted/);
  });
});
