// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// A slide is an image anywhere, a video only as a Pro Tips reel; reel videos
// upload as MP4 or WebM under their own key prefix.
import { describe, it, expect } from 'vitest';
import { promoMediaFor } from '../../domains/cms/promoMedia.js';
import { mimeRulesForCategory, REEL_CATEGORY } from '../../services/cdn.service.js';

describe('promoMediaFor', () => {
  it('takes an image anywhere, read in any case', () => {
    expect(promoMediaFor('image', 'RULES_PAGE')).toBe('IMAGE');
    expect(promoMediaFor(undefined, 'TRICKS_PAGE')).toBe('IMAGE');
  });
  it('takes a video on Pro Tips', () => {
    expect(promoMediaFor('VIDEO', 'tricks_page')).toBe('VIDEO');
  });
  it.each(['RULES_PAGE', 'HOME', undefined])('refuses a video on %s with a 400', (where) => {
    expect(() => promoMediaFor('VIDEO', where)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it('refuses an unknown media type with a 400', () => {
    expect(() => promoMediaFor('GIFV', 'TRICKS_PAGE')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('reel upload types', () => {
  it('allows MP4 and WebM only under the reel prefix', () => {
    expect(Object.keys(mimeRulesForCategory(REEL_CATEGORY)).sort()).toEqual(['video/mp4', 'video/webm']);
  });
  it('keeps the promo prefix to images', () => {
    expect(Object.keys(mimeRulesForCategory('promo')).every((m) => m.startsWith('image/'))).toBe(true);
  });
});
