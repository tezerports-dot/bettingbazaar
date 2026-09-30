// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The guard that refuses NaN-versus-NaN assertions actually refuses them.
 *
 * `assertionGuards.setup.js` is preventive: once F-026's two vacuous lines were
 * fixed, no assertion in the suites compared two NaNs, so nothing else would
 * notice if the guard stopped working. This suite is that notice (§32 S8 —
 * make the gate fail on purpose).
 */
import { describe, it, expect } from 'vitest';

describe('a comparison of NaN with NaN is refused', () => {
  const unreadable = {}; // a balance read with a key it does not have

  it('toBe', () => {
    expect(() => expect(Number(unreadable.availablePaise))
      .toBe(Number(unreadable.availablePaise) - 100)).toThrow(/proves nothing/);
  });

  it('toEqual and toStrictEqual', () => {
    expect(() => expect(Number.NaN).toEqual(Number.NaN)).toThrow(/proves nothing/);
    expect(() => expect(Number.NaN).toStrictEqual(Number.NaN)).toThrow(/proves nothing/);
  });

  it('leaves real comparisons, negations and toBeNaN alone', () => {
    expect(2).toBe(2);
    expect(1).not.toBe(2);
    expect({ a: 1 }).toEqual({ a: 1 });
    expect(Number(unreadable.x)).toBeNaN();
    expect(() => expect(1).toBe(2)).toThrow();
  });
});
