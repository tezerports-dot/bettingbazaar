// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An assertion that compares two NaNs is not an assertion. Refuse it.
 *
 * ── The defect this exists for (F-026, §32 S40) ────────────────────────────
 * `depositConfirmReachablePg` asserted
 *
 *     expect(Number(after.availablePaise)).toBe(Number(before.availablePaise) - paise)
 *
 * The balance object's keys are `available` and `reserved`, not
 * `availablePaise`. Both reads were `undefined`, `Number(undefined)` is NaN,
 * NaN minus anything is NaN — and vitest's `toBe` is `Object.is`, under which
 * **NaN IS NaN**. So the assertion passed for every possible balance, while the
 * confirm route was charging every merchant twice for every buy. The two lines
 * that would have caught the platform's most expensive defect were measuring
 * nothing, and reported green for as long as they existed.
 *
 * `toEqual` and `toStrictEqual` have the same property for a scalar NaN.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * When BOTH sides are NaN the comparison proves nothing about the code under
 * test: it only proves that two reads failed the same way. A test that
 * genuinely expects NaN says so with `toBeNaN()`, which reads as intent and is
 * not affected by this guard.
 *
 * Loaded by all three vitest configs (`setupFiles`), so no suite can opt out by
 * forgetting it.
 */
import { chai } from 'vitest';

const bothNaN = (a, b) => typeof a === 'number' && typeof b === 'number'
  && Number.isNaN(a) && Number.isNaN(b);

for (const matcher of ['toBe', 'toEqual', 'toStrictEqual']) {
  chai.util.overwriteMethod(chai.Assertion.prototype, matcher, (_super) => function guarded(expected, ...rest) {
    const actual = chai.util.flag(this, 'object');
    if (bothNaN(actual, expected)) {
      throw new Error(
        `${matcher}(NaN) compared against NaN proves nothing: both sides failed to read a number. `
        + 'Check the key you read (an undefined property becomes NaN through Number()). '
        + 'If NaN is genuinely the expected value, assert it with toBeNaN().',
      );
    }
    return _super.call(this, expected, ...rest);
  });
}
