// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Where a tapped promo card may go: an app page or an https link, nothing else.
import { describe, it, expect } from 'vitest';
import { promoLinkUrl } from '../../domains/cms/promoLink.js';

describe('promoLinkUrl', () => {
  it('keeps an app page, and reads #/page as the same page', () => {
    expect(promoLinkUrl('/referrals')).toBe('/referrals');
    expect(promoLinkUrl('#/wallet')).toBe('/wallet');
  });
  it('keeps a full https link', () => {
    expect(promoLinkUrl('https://t.me/bettingbazaar')).toBe('https://t.me/bettingbazaar');
  });
  it('clears on empty', () => {
    expect(promoLinkUrl('')).toBeNull();
    expect(promoLinkUrl(null)).toBeNull();
    expect(promoLinkUrl(undefined)).toBeNull();
  });
  it.each(['javascript:alert(1)', 'http://example.com', '//evil.example', 'data:text/html,x', '/a b', 'referrals'])(
    'refuses %s with a 400 the admin can act on', (v) => {
      let err;
      try { promoLinkUrl(v); } catch (e) { err = e; }
      expect(err?.status).toBe(400);
      expect(err?.message).toMatch(/https:\/\//);
    });
});
