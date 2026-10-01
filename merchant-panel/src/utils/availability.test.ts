// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** The one answer to "is this merchant taking orders", in each of its four states. */
import { describe, it, expect } from 'vitest';
import { availabilityOf } from './availability';

describe('availabilityOf', () => {
  it('online and not paused: accepting', () => {
    expect(availabilityOf({ isOnline: true, assignmentPausedAt: null })).toMatchObject({ short: 'Available for orders', long: 'Online · Accepting orders' });
  });
  it('online and PAUSED by the platform: says new orders are paused, everywhere', () => {
    const a = availabilityOf({ isOnline: true, assignmentPausedAt: '2026-10-01T08:00:00Z' });
    expect(a.short).toBe('New orders paused');
    expect(a.long).toBe('Online · New orders paused');
  });
  it('offline, paused or not: not accepting', () => {
    for (const assignmentPausedAt of [null, '2026-10-01T08:00:00Z']) {
      expect(availabilityOf({ isOnline: false, assignmentPausedAt })).toMatchObject({ short: 'Not accepting', long: 'Offline · Not accepting' });
    }
  });
  it('no merchant loaded yet: not accepting, rather than throwing', () => {
    expect(availabilityOf(null).short).toBe('Not accepting');
  });
});
