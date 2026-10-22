// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * errorLogPg.test.js — the error log keeps one row per distinct error, counts
 * repeats, keeps the worst severity, and reopens an error marked fixed when it
 * comes back (owner, 2026-10-20). Every row here carries this run's tag, and
 * only those are asserted or removed (trap 10).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  recordError, listErrors, setErrorStatus, normaliseMessage, fingerprintOf,
} from '../repositories/errorLog.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = `errlog-${randomUUID().slice(0, 8)}`;

describePg('the error log', () => {
  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => {
    await pgQuery('DELETE FROM error_log WHERE message LIKE $1', [`%${RUN}%`]);
    await closePg();
  });

  const report = (over = {}) => ({
    source: 'SERVER', category: 'API', severity: 'WARNING', message: `${RUN} order ORD1234 failed after 37 ms`,
    location: '/api/orders/ORD1234', ...over,
  });

  it('counts a repeat of the same error on one row, ids and numbers aside', async () => {
    const first = await recordError(report());
    const again = await recordError(report({ message: `${RUN} order ORD9876 failed after 41 ms`, location: '/api/orders/ORD9876', count: 3 }));
    expect(again.id).toBe(first.id);
    expect(again.occurrences).toBe(4);
    const other = await recordError(report({ message: `${RUN} wallet locked` }));
    expect(other.id).not.toBe(first.id);
  });

  it('keeps the worst severity seen', async () => {
    const msg = `${RUN} severity climbs`;
    await recordError(report({ message: msg, severity: 'MINOR' }));
    await recordError(report({ message: msg, severity: 'CRITICAL' }));
    await recordError(report({ message: msg, severity: 'WARNING' }));
    const { rows } = await pgQuery('SELECT severity, occurrences FROM error_log WHERE message = $1', [msg]);
    expect(rows).toEqual([{ severity: 'CRITICAL', occurrences: 3 }]);
  });

  it('marks fixed with the time and who, and reopens when the error comes back', async () => {
    const msg = `${RUN} comes back`;
    const { id } = await recordError(report({ message: msg }));
    const fixed = await setErrorStatus(id, 'FIXED', 'owner');
    expect(fixed.status).toBe('FIXED');
    expect(fixed.fixedBy).toBe('owner');
    expect(Number.isNaN(new Date(fixed.fixedAt).getTime())).toBe(false);
    const back = await recordError(report({ message: msg }));
    expect(back).toMatchObject({ id, status: 'OPEN' });
    const { rows } = await pgQuery('SELECT reopened, fixed_at FROM error_log WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ reopened: 1, fixed_at: null });
  });

  it('lists open errors worst first, with real timestamps, and filters by the vocabulary', async () => {
    await recordError(report({ source: 'PLAYER_APP', category: 'SCREEN_CRASH', severity: 'CRITICAL', message: `${RUN} screen broke` }));
    const { entries, totals } = await listErrors({ source: 'PLAYER_APP', status: 'OPEN' });
    const mine = entries.filter((e) => e.message.includes(RUN));
    expect(mine.map((e) => e.message)).toContain(`${RUN} screen broke`);
    for (const e of mine) {
      expect(e.source).toBe('PLAYER_APP');
      expect(Number.isNaN(new Date(e.lastSeenAt).getTime())).toBe(false);
      expect(Number.isNaN(new Date(e.firstSeenAt).getTime())).toBe(false);
    }
    expect(totals.critical).toBeGreaterThanOrEqual(1);
    await expect(listErrors({ source: 'MOON' })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_FILTER' });
  });

  it('refuses a report outside the vocabulary by name, and an empty message', async () => {
    await expect(recordError(report({ source: 'ELSEWHERE' }))).rejects.toMatchObject({ status: 400 });
    await expect(recordError(report({ severity: 'PURPLE' }))).rejects.toMatchObject({ status: 400 });
    await expect(recordError(report({ message: '' }))).rejects.toMatchObject({ status: 400 });
    await expect(setErrorStatus(1, 'MAYBE')).rejects.toMatchObject({ status: 400 });
  });

  it('the database refuses a fixed row with no fix time', async () => {
    await expect(pgQuery(
      `INSERT INTO error_log (fingerprint, source, category, severity, message, status)
       VALUES ($1, 'SERVER', 'API', 'MINOR', $1, 'FIXED')`, [`${RUN}-bad`],
    )).rejects.toMatchObject({ constraint: 'error_log_fixed_has_time' });
  });
});

describe('what makes two reports the same error', () => {
  it('blanks numbers and ids, keeps the words', () => {
    expect(normaliseMessage('order ORD1234 failed after 37 ms')).toBe(normaliseMessage('order ORD99 failed after 4 ms'));
    expect(normaliseMessage('wallet locked')).not.toBe(normaliseMessage('wallet missing'));
  });
  it('ignores a hashed chunk name and query string in a URL', () => {
    const a = fingerprintOf({ source: 'PLAYER_APP', category: 'UPDATE_LOAD', message: 'Failed to fetch https://x.test/assets/ReferralPage-CRe7z2pa.js', location: 'https://x.test/#/referrals?ref=1' });
    const b = fingerprintOf({ source: 'PLAYER_APP', category: 'UPDATE_LOAD', message: 'Failed to fetch https://x.test/assets/ReferralPage-Ab12Cd34.js', location: 'https://x.test/#/referrals?ref=2' });
    expect(a).toBe(b);
  });
});
