// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What an installed Android app is told to do — the whole rule, in one place
 * (androidRelease.shared.js updateStatus). The app renders it and carries no
 * copy, so this is the only test of the rule itself.
 */
import { describe, it, expect } from 'vitest';
import { updateStatus } from '../../domains/distribution/androidRelease.shared.js';

const policy = (latestCode, minRequired) => ({
  latest: latestCode ? { versionCode: latestCode } : null,
  minRequiredVersionCode: minRequired,
});

describe('updateStatus', () => {
  it('blocks an install below the newest mandatory release', () => {
    expect(updateStatus(4, policy(9, 7))).toBe('required');
  });

  it('offers, without blocking, an install at or above the mandatory floor but below the newest', () => {
    expect(updateStatus(7, policy(9, 7))).toBe('available');
    expect(updateStatus(8, policy(9, 0))).toBe('available');
  });

  it('leaves a current install alone', () => {
    expect(updateStatus(9, policy(9, 7))).toBe('current');
    expect(updateStatus(10, policy(9, 7))).toBe('current');   // a newer local build
  });

  it('never blocks when nothing is published, or when the app could not say what it is', () => {
    expect(updateStatus(1, policy(0, 0))).toBe('current');
    expect(updateStatus(NaN, policy(9, 9))).toBe('current');
    expect(updateStatus(0, policy(9, 9))).toBe('current');
  });
});
