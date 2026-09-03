// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The sub-admin permission catalogue.
 *
 * Every key here is a capability a full admin can grant to a sub-admin, and the
 * create form renders one row per key from these maps. A key with no label or
 * no description renders as a blank checkbox — a permission an operator grants
 * without being told what it does — so the maps must stay in lockstep with the
 * key list. The default must be all-false: a new sub-admin starts with nothing
 * until it is deliberately granted.
 */
import { describe, it, expect } from 'vitest';
import { PERMISSION_KEYS, DEFAULT_PERMISSIONS, PERMISSION_LABELS, PERMISSION_DESCRIPTIONS } from './permissions';

describe('sub-admin permissions', () => {
  it('gives every key a label and a description', () => {
    for (const key of PERMISSION_KEYS) {
      expect(PERMISSION_LABELS[key], `${key} has no label`).toBeTruthy();
      expect(PERMISSION_DESCRIPTIONS[key], `${key} has no description`).toBeTruthy();
    }
  });

  it('carries no label or description for a key that is not real', () => {
    // The reverse: a stale entry in the maps for a removed key would render a
    // checkbox that grants nothing.
    expect(Object.keys(PERMISSION_LABELS).sort()).toEqual([...PERMISSION_KEYS].sort());
    expect(Object.keys(PERMISSION_DESCRIPTIONS).sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it('defaults every permission to false — a new sub-admin holds nothing', () => {
    for (const key of PERMISSION_KEYS) {
      expect(DEFAULT_PERMISSIONS[key], `${key} defaults to granted`).toBe(false);
    }
    expect(Object.keys(DEFAULT_PERMISSIONS).sort()).toEqual([...PERMISSION_KEYS].sort());
  });
});
