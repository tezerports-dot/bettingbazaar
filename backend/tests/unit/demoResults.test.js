// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** Demo results' switch and line (owner, 2026-10-15): the line is never blank. */
import { describe, it, expect } from 'vitest';
import {
  demoResultsLabelOf, demoResultsOnOf, DEFAULT_DEMO_RESULTS_LABEL, DEFAULT_DEMO_RESULTS_ON,
} from '../../domains/markets/demoResults.js';
import { SYSTEM_CONFIG_SPEC } from '../../../database/spec/config.spec.js';
import { systemConfigPayload } from '../../domains/configuration/systemConfigPayload.js';

describe('demo results settings', () => {
  it('the line is the saved wording, or the default when blank or too short', () => {
    expect(demoResultsLabelOf({ demoResultsLabel: '  Includes demo results.  ' })).toBe('Includes demo results.');
    for (const cfg of [null, {}, { demoResultsLabel: '' }, { demoResultsLabel: '   ' }, { demoResultsLabel: 'demo' }]) {
      expect(demoResultsLabelOf(cfg)).toBe(DEFAULT_DEMO_RESULTS_LABEL);
    }
  });

  it('the switch is the saved boolean, or the schema default', () => {
    expect(demoResultsOnOf({ demoResultsOn: false })).toBe(false);
    expect(demoResultsOnOf({})).toBe(DEFAULT_DEMO_RESULTS_ON);
    expect(SYSTEM_CONFIG_SPEC.fields.demoResultsOn.default).toBe(DEFAULT_DEMO_RESULTS_ON);
    expect(SYSTEM_CONFIG_SPEC.fields.demoResultsLabel.default).toBe(DEFAULT_DEMO_RESULTS_LABEL);
  });

  it('the player payload carries both, the line never blank', () => {
    const p = systemConfigPayload({ demoResultsOn: false, demoResultsLabel: '' });
    expect(p.demoResultsOn).toBe(false);
    expect(p.demoResultsLabel).toBe(DEFAULT_DEMO_RESULTS_LABEL);
  });
});
