// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * PgBouncer pool figures for /metrics (bb_pgbouncer_pool), read from its admin
 * console with SHOW POOLS and SHOW STATS. Enabled by PGBOUNCER_STATS_URL (the
 * `pgbouncer` virtual database, a `stats_users` account), set in the
 * production compose; inert without it.
 *
 * One short-lived connection per scrape: the console speaks only the simple
 * query protocol, so it never shares the application's pool. A scrape that
 * cannot reach it emits nothing rather than zeros.
 */
import { setPgBouncerStatsProvider } from '../backend/services/metrics.service.js';

const DB_NAME = () => {
  try { return new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '') || null; } catch { return null; }
};

/** Pure: fold SHOW POOLS + SHOW STATS rows for one database into the gauge's metrics. */
export function foldPgBouncerStats(pools, stats, database) {
  const mine = (rows) => rows.filter((r) => !database || r.database === database);
  const sum = (rows, key) => mine(rows).reduce((a, r) => a + Number(r[key] || 0), 0);
  const maxwait = mine(pools).reduce((a, r) => Math.max(a, Number(r.maxwait || 0) + Number(r.maxwait_us || 0) / 1e6), 0);
  const s = mine(stats)[0] || {};
  return {
    cl_active: sum(pools, 'cl_active'),
    cl_waiting: sum(pools, 'cl_waiting'),
    sv_active: sum(pools, 'sv_active'),
    sv_idle: sum(pools, 'sv_idle'),
    sv_used: sum(pools, 'sv_used'),
    maxwait_seconds: maxwait,
    avg_wait_seconds: Number(s.avg_wait_time || 0) / 1e6,
    avg_query_seconds: Number(s.avg_query_time || 0) / 1e6,
  };
}

export function startPgBouncerStats(url = process.env.PGBOUNCER_STATS_URL) {
  if (!url) return false;
  setPgBouncerStatsProvider(async () => {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      const pools = (await client.query('SHOW POOLS')).rows;
      const stats = (await client.query('SHOW STATS')).rows;
      return foldPgBouncerStats(pools, stats, DB_NAME());
    } finally {
      await client.end().catch(() => {});
    }
  });
  return true;
}
