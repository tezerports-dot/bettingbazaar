// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every system setting has an explanation and an example (owner, 2026-10-14),
 * and no explanation outlives its setting: `SYSTEM_CONFIG_HELP` is held equal
 * to the leaves of `SYSTEM_CONFIG_SPEC`.
 */
import { describe, it, expect } from 'vitest';
import { SYSTEM_CONFIG_SPEC } from '../../../database/spec/config.spec.js';
import { SYSTEM_CONFIG_HELP, leafPaths } from '../../../database/spec/configHelp.js';

describe('system setting help', () => {
  const leaves = leafPaths(SYSTEM_CONFIG_SPEC);

  it('covers every declared setting', () => {
    expect(leaves.filter((p) => !SYSTEM_CONFIG_HELP[p])).toEqual([]);
  });

  it('names no setting the spec does not declare', () => {
    expect(Object.keys(SYSTEM_CONFIG_HELP).filter((p) => !leaves.includes(p))).toEqual([]);
  });

  it('gives each one words and an example', () => {
    for (const [path, entry] of Object.entries(SYSTEM_CONFIG_HELP)) {
      expect(entry.what.trim().length, path).toBeGreaterThan(20);
      expect(entry.example.trim().length, path).toBeGreaterThan(0);
    }
  });
});
