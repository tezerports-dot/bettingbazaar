// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The phone's live value of a cricket position agrees with the server's claim
 * arithmetic (backend/domains/cricket/cricketPricing.js `quoteClaim`, the same
 * case as backend/tests/unit/cricket.test.js) when the book cap does not bite.
 */
import { describe, it, expect } from 'vitest';
import { positionValuePaise, feeOn } from './cricketValue';

describe('a cricket position value on screen', () => {
  it('matches the server: payout × share without this stake, less margin and fee', () => {
    const v = positionValuePaise(
      [{ key: 'A', poolPaise: 300_000 }, { key: 'B', poolPaise: 100_000 }],
      { optionKey: 'A', stakePaise: 100_000, potentialPaise: 180_000 }, 5, 1,
    );
    expect(v).toBe(112_860);
  });

  it('charges the fee only above the stake', () => {
    expect(feeOn(10_000, 10_000, 1)).toBe(0);
    expect(feeOn(20_000, 10_000, 1)).toBe(200);
  });

  it('is zero for an option it cannot find', () => {
    expect(positionValuePaise([{ key: 'A', poolPaise: 1 }], { optionKey: 'Z', stakePaise: 1, potentialPaise: 2 }, 5, 1)).toBe(0);
  });
});
