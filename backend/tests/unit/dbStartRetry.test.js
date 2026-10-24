// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Startup retries a database it cannot REACH, and only that (owner, 2026-10-24):
 * a pooler login refusal stopped every board at 00:00.
 */
import { describe, it, expect } from 'vitest';
import { retryTransientDbStart, isTransientDbStartError } from '../../startup/dbStartRetry.js';

const noSleep = { sleep: async () => {}, log: () => {} };

describe('retryTransientDbStart', () => {
  it('tries again after a pooler login refusal and goes on once the database answers', async () => {
    let tries = 0;
    const out = await retryTransientDbStart(async () => {
      tries += 1;
      if (tries < 3) throw new Error('server login has been failing, try again later (server_login_retry)');
      return 'ready';
    }, noSleep);
    expect(out).toBe('ready');
    expect(tries).toBe(3);
  });

  it('does not retry a schema error: retrying it changes nothing', async () => {
    let tries = 0;
    await expect(retryTransientDbStart(async () => {
      tries += 1;
      throw Object.assign(new Error('syntax error at or near "TABLE"'), { code: '42601' });
    }, noSleep)).rejects.toThrow(/syntax/);
    expect(tries).toBe(1);
  });

  it('gives up after its waits run out and throws the last error', async () => {
    let tries = 0;
    await expect(retryTransientDbStart(async () => {
      tries += 1;
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }, { ...noSleep, waits: [1, 1] })).rejects.toThrow(/ECONNREFUSED/);
    expect(tries).toBe(3);
  });

  it('knows a reach error from any other', () => {
    expect(isTransientDbStartError({ code: '57P03', message: '' })).toBe(true);
    expect(isTransientDbStartError({ code: '53300', message: '' })).toBe(true);
    expect(isTransientDbStartError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientDbStartError({ code: '23505', message: 'duplicate key' })).toBe(false);
    expect(isTransientDbStartError(null)).toBe(false);
  });
});
