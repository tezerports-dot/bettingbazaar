// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The mirror is held equal to the SERVER's list by `npm run check:staff-permissions`
 * (a panel test cannot import from backend/, §15). What is asserted here is the
 * panel's own half: every key appears once, and a new sub-admin starts with
 * nothing granted.
 */
import { describe, it, expect } from 'vitest';
import { PERMISSION_KEYS, DEFAULT_PERMISSIONS } from './permissions';

describe('permission keys', () => {
  it('names each key once', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('starts a new sub-admin with nothing granted', () => {
    for (const key of PERMISSION_KEYS) {
      expect(DEFAULT_PERMISSIONS[key], `${key} defaults to granted`).toBe(false);
    }
    expect(Object.keys(DEFAULT_PERMISSIONS).sort()).toEqual([...PERMISSION_KEYS].sort());
  });
});
