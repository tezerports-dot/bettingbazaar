// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** Demo results' switch (owner, 2026-10-15). */
import { describe, it, expect } from 'vitest';
import { demoResultsOnOf, DEFAULT_DEMO_RESULTS_ON } from '../../domains/markets/demoResults.js';
import { SYSTEM_CONFIG_SPEC } from '#db/spec/config.spec.js';
import { systemConfigPayload } from '../../domains/configuration/systemConfigPayload.js';

describe('demo results settings', () => {
  it('the switch is the saved boolean, or the schema default', () => {
    expect(demoResultsOnOf({ demoResultsOn: false })).toBe(false);
    expect(demoResultsOnOf({})).toBe(DEFAULT_DEMO_RESULTS_ON);
    expect(SYSTEM_CONFIG_SPEC.fields.demoResultsOn.default).toBe(DEFAULT_DEMO_RESULTS_ON);
    expect(SYSTEM_CONFIG_SPEC.fields.demoResultsLabel).toBeUndefined();
  });

  it('the player payload carries the switch and no line', () => {
    const p = systemConfigPayload({ demoResultsOn: false });
    expect(p.demoResultsOn).toBe(false);
    expect(p).not.toHaveProperty('demoResultsLabel');
    expect(p).not.toHaveProperty('phantomBetsLabel');
  });
});
