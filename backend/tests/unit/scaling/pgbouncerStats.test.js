// GOVERNANCE: Read CLAUDE.md before editing this file.
import { describe, it, expect } from 'vitest';
import { foldPgBouncerStats } from '../../../services/pgbouncerStats.js';

describe('foldPgBouncerStats', () => {
  it('sums the app database pools and converts microseconds to seconds', () => {
    const pools = [
      { database: 'bettingbazaar', user: 'bb', cl_active: 12, cl_waiting: 3, sv_active: 9, sv_idle: 4, sv_used: 1, maxwait: 1, maxwait_us: 500000 },
      { database: 'pgbouncer', user: 'pgbouncer', cl_active: 1, cl_waiting: 0, sv_active: 0, sv_idle: 0, sv_used: 0, maxwait: 0, maxwait_us: 0 },
    ];
    const stats = [{ database: 'bettingbazaar', avg_wait_time: 2500, avg_query_time: 1200 }];
    expect(foldPgBouncerStats(pools, stats, 'bettingbazaar')).toEqual({
      cl_active: 12, cl_waiting: 3, sv_active: 9, sv_idle: 4, sv_used: 1,
      maxwait_seconds: 1.5, avg_wait_seconds: 0.0025, avg_query_seconds: 0.0012,
    });
  });
});
