// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The one JavaScript reading of a mobile number in text (owner, 2026-10-03:
 * nobody's mobile number is exposed anywhere). The database's copy of the rule
 * is held to the same list by mobileInTextPg.
 */
import { describe, it, expect } from 'vitest';
import { textHasAMobile, hideMobiles, asciiDigits } from '../../domains/identity/mobileInText.js';
import { MOBILE_SPELLINGS, NOT_MOBILES } from '../mobileSpellings.js';

describe('a mobile number in text', () => {
  it.each(MOBILE_SPELLINGS)('reads %j as a mobile', (text) => {
    expect(textHasAMobile(text)).toBe(true);
    expect(hideMobiles(text)).toContain('[number hidden]');
  });

  it.each(NOT_MOBILES)('does not read %j as one', (text) => {
    expect(textHasAMobile(text)).toBe(false);
  });

  it('hides each number and keeps the words around it', () => {
    expect(hideMobiles('call +91 98765-43210, then 8123456789.')).toBe('call [number hidden], then [number hidden].');
    expect(hideMobiles(null)).toBeNull();
    expect(textHasAMobile(null)).toBe(false);
  });

  it('reads the digits of every Indian script as digits', () => {
    expect(asciiDigits('०१२३४५६७८९ ০১২ ௦௧௨ ൦൧൨ ٠١٢ ０１２')).toBe('0123456789 012 012 012 012 012');
  });
});
