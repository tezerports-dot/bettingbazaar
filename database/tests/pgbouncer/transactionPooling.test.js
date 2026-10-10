// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Is this application safe behind PgBouncer in TRANSACTION pooling mode?
 * (owner, 2026-10-09: "test prepared statements, transactions, session state,
 * advisory locks, and any connection-specific PostgreSQL behaviour").
 *
 * Each case runs through a real PgBouncer against a real PostgreSQL and
 * asserts the database, not a mock. The static checks at the end pin the
 * codebase to the patterns that are safe here, so a later session-level SET,
 * LISTEN or session advisory lock fails this tier instead of production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const POOLED = process.env.PGBOUNCER_URL;
const ADMIN = process.env.PGBOUNCER_ADMIN_URL;
const DIRECT = process.env.DIRECT_DATABASE_URL;

if (!POOLED || !ADMIN || !DIRECT) {
  throw new Error('PGBOUNCER_URL, PGBOUNCER_ADMIN_URL and DIRECT_DATABASE_URL are required for this tier');
}

const pools = [];
function pool(max, url = POOLED) {
  // The test's own direct connections are named so the backend count excludes them.
  const p = new pg.Pool({ connectionString: url, max, ssl: false, application_name: url === DIRECT ? 'bb_pgb_direct' : 'bb_pgb_pooled' });
  p.on('error', () => {});
  pools.push(p);
  return p;
}

async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN, ssl: false });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}

let directPool;
const direct = () => (directPool ??= pool(3, DIRECT));
let app;
let maxDb;

beforeAll(async () => {
  app = pool(40);
  const cfg = await admin('SHOW CONFIG');
  const get = (k) => cfg.find((r) => r.key === k)?.value;
  expect(get('pool_mode')).toBe('transaction');
  maxDb = Number(get('max_db_connections'));
  await direct().query(`CREATE TABLE IF NOT EXISTS bb_pgb_probe (id text PRIMARY KEY, n bigint NOT NULL DEFAULT 0)`);
});

afterAll(async () => {
  try { await direct().query('DROP TABLE IF EXISTS bb_pgb_probe'); } finally {
    await Promise.allSettled(pools.map((p) => p.end()));
  }
});

async function serverBackends() {
  const { rows } = await direct().query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'
        AND usename = current_user AND application_name <> 'bb_pgb_direct'`);
  return rows[0].n;
}

describe('normal and concurrent queries', () => {
  it('a plain query and a parameterised one (unnamed prepared statement) work', async () => {
    expect((await app.query('SELECT 1 AS one')).rows[0].one).toBe(1);
    expect((await app.query('SELECT $1::bigint + $2::bigint AS s', ['40', '2'])).rows[0].s).toBe('42');
  });

  it('300 concurrent requests all complete, multiplexed onto at most max_db_connections server connections', async () => {
    const wide = pool(300);
    let peak = 0;
    const sampler = setInterval(() => { serverBackends().then((n) => { peak = Math.max(peak, n); }).catch(() => {}); }, 25);
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) =>
      wide.query('SELECT pg_sleep(0.05), $1::int AS i', [i]).then((r) => r.rows[0].i)));
    clearInterval(sampler);
    expect(results).toHaveLength(300);
    expect(new Set(results).size).toBe(300);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(maxDb);
  });
});

describe('transactions', () => {
  it('BEGIN … COMMIT on one client is atomic; ROLLBACK leaves nothing', async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO bb_pgb_probe (id) VALUES ('rolled-back')`);
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query(`INSERT INTO bb_pgb_probe (id) VALUES ('committed') ON CONFLICT DO NOTHING`);
      await c.query('COMMIT');
    } finally { c.release(); }
    const { rows } = await direct().query(`SELECT id FROM bb_pgb_probe WHERE id IN ('rolled-back','committed') ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['committed']);
  });

  it('SELECT … FOR UPDATE serialises concurrent read-modify-write: no lost update', async () => {
    await direct().query(`INSERT INTO bb_pgb_probe (id, n) VALUES ('counter', 0) ON CONFLICT (id) DO UPDATE SET n = 0`);
    const bump = async () => {
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        const { rows } = await c.query(`SELECT n FROM bb_pgb_probe WHERE id = 'counter' FOR UPDATE`);
        await c.query(`UPDATE bb_pgb_probe SET n = $1 WHERE id = 'counter'`, [Number(rows[0].n) + 1]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    };
    await Promise.all(Array.from({ length: 50 }, bump));
    const { rows } = await direct().query(`SELECT n FROM bb_pgb_probe WHERE id = 'counter'`);
    expect(Number(rows[0].n)).toBe(50);
  });
});

describe('advisory locks', () => {
  it('pg_advisory_xact_lock (the only kind the app uses) serialises across pooled connections', async () => {
    await direct().query(`INSERT INTO bb_pgb_probe (id, n) VALUES ('adv', 0) ON CONFLICT (id) DO UPDATE SET n = 0`);
    const critical = async () => {
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('bb_pgb_probe'))`);
        const { rows } = await c.query(`SELECT n FROM bb_pgb_probe WHERE id = 'adv'`);
        await c.query('SELECT pg_sleep(0.01)');
        await c.query(`UPDATE bb_pgb_probe SET n = $1 WHERE id = 'adv'`, [Number(rows[0].n) + 1]);
        await c.query('COMMIT');
      } finally { c.release(); }
    };
    await Promise.all(Array.from({ length: 20 }, critical));
    const { rows } = await direct().query(`SELECT n FROM bb_pgb_probe WHERE id = 'adv'`);
    expect(Number(rows[0].n)).toBe(20);
  });

  it('the schema apply lock (one simple-protocol query = one transaction) is released at its end', async () => {
    const { SCHEMA_APPLY_LOCK } = await import('../../client.js');
    await app.query(`${SCHEMA_APPLY_LOCK} SELECT 1;`);
    const { rows } = await direct().query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('prepared statements and session state', () => {
  it('a NAMED prepared statement works across server connections (max_prepared_statements)', async () => {
    const q = { name: 'bb_pgb_named', text: 'SELECT $1::int * 2 AS d' };
    const out = await Promise.all(Array.from({ length: 100 }, (_, i) => app.query({ ...q, values: [i] }).then((r) => r.rows[0].d)));
    expect(out).toEqual(Array.from({ length: 100 }, (_, i) => i * 2));
  });

  it('SET LOCAL stays inside its transaction (the safe form of session state)', async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL statement_timeout = '1234ms'`);
      expect((await c.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('1234ms');
      await c.query('COMMIT');
    } finally { c.release(); }
    const shown = await Promise.all(Array.from({ length: 20 }, () => app.query('SHOW statement_timeout')));
    expect(shown.every((r) => r.rows[0].statement_timeout !== '1234ms')).toBe(true);
  });
});

describe('connection exhaustion', () => {
  it('more clients than server connections queue in PgBouncer and all finish; PostgreSQL slots are never exhausted', async () => {
    const burst = pool(500);
    const { rows: before } = await direct().query(`SELECT current_setting('max_connections')::int AS m`);
    let waitingSeen = 0;
    const watcher = setInterval(() => {
      admin('SHOW POOLS').then((rows) => {
        const mine = rows.find((r) => r.database === new URL(POOLED).pathname.slice(1));
        waitingSeen = Math.max(waitingSeen, Number(mine?.cl_waiting || 0));
      }).catch(() => {});
    }, 20);
    const done = await Promise.allSettled(Array.from({ length: 500 }, () => burst.query('SELECT pg_sleep(0.1)')));
    clearInterval(watcher);
    expect(done.filter((d) => d.status === 'rejected')).toEqual([]);
    expect(waitingSeen).toBeGreaterThan(0);                 // clients really did queue
    expect(await serverBackends()).toBeLessThan(before[0].m);
  });
});

// ── The codebase only uses what transaction pooling supports ───────────────
const ROOTS = ['backend', 'database'];
function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out); else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const sources = ROOTS.flatMap((r) => files(r)).map((p) => [p, readFileSync(p, 'utf8')]);

describe('static: no connection-scoped PostgreSQL features in application code', () => {
  it.each([
    ['a session advisory lock', /pg_(try_)?advisory_lock(_shared)?\s*\(/],
    ['LISTEN/NOTIFY', /['"`]\s*(LISTEN|UNLISTEN)\s|\.on\(\s*['"]notification['"]/],
    ['a session-level SET', /query\(\s*['"`]\s*SET\s+(?!LOCAL\b)(SESSION\s+)?[a-z_]+\s*(=|TO)\b/i],
    ['a temporary table', /CREATE\s+(TEMP|TEMPORARY)\s+TABLE/i],
    ['a WITH HOLD cursor', /WITH\s+HOLD/i],
  ])('none uses %s', (_what, re) => {
    expect(sources.filter(([, s]) => re.test(s)).map(([p]) => p)).toEqual([]);
  });
});
