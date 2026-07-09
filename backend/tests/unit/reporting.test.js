// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the Reporting Platform CSV serializer (pure, no DB).
import { describe, it, expect } from 'vitest';
import { toCsv } from '../../domains/reporting/reporting.service.js';
import { MARKET_SIDES, oppositeSide } from '../../domains/trading/tradingModels.js';

describe('regulatory CSV export quoting', () => {
  it('quotes commas and escapes quotes', () => {
    const csv = toCsv([{ a: 'plain', b: 'has,comma', c: 'has"quote' }]);
    expect(csv).toBe('a,b,c\nplain,"has,comma","has""quote"');
  });
  it('empty input yields empty string', () => expect(toCsv([])).toBe(''));
});

describe('shared trading vocabulary', () => {
  it('opposite side flips correctly', () => {
    expect(oppositeSide('DELHI')).toBe('BOMBAY');
    expect(oppositeSide('BOMBAY')).toBe('DELHI');
  });
  it('rejects unknown sides', () => expect(() => oppositeSide('X')).toThrow());
  it('exactly two market sides', () => expect(MARKET_SIDES).toEqual(['DELHI', 'BOMBAY']));
});
