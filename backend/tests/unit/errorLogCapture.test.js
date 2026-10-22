// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * How a server console.error becomes an error-log report (errorLog.service.js):
 * a job's failure is a JOB warning, anything else a minor server log, and the
 * explicit doors do not record the same failure twice.
 */
import { describe, it, expect } from 'vitest';
import { reportFromConsole, withoutCapture, logError } from '../../services/errorLog.service.js';

describe('a console.error, read as an error-log report', () => {
  it('a cron failure is a background job warning, tagged where it happened', () => {
    expect(reportFromConsole(['[team-pool] cron error:', 'relation is locked'])).toMatchObject({
      source: 'SERVER', category: 'JOB', severity: 'WARNING', location: 'team-pool',
      message: '[team-pool] cron error: relation is locked',
    });
  });
  it('anything else is a minor server log, keeping the stack of an Error', () => {
    const err = new Error('boom');
    const r = reportFromConsole(['[alerting] webhook send failed:', err]);
    expect(r).toMatchObject({ category: 'SERVER_LOG', severity: 'MINOR', location: 'alerting' });
    expect(r.detail).toContain('boom');
  });
  it('says nothing for an empty call', () => {
    expect(reportFromConsole([])).toBeNull();
  });
  it('withoutCapture runs the function and returns its value', () => {
    expect(withoutCapture(() => 7)).toBe(7);
  });
  it('logError is a no-op under test and never throws on a bad report', () => {
    expect(() => logError(null)).not.toThrow();
    expect(() => logError({ source: 'SERVER' })).not.toThrow();
  });
});
