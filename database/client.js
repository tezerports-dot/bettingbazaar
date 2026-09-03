// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/pgClient.js — the single touchpoint for the only datastore.
 *
 * `DATABASE_URL` opens the pool and `applySchema()` runs idempotently at boot.
 * It is REQUIRED: there is no second store to fall back to and no degraded mode
 * to run in, so an instance that cannot reach PostgreSQL must refuse to start
 * rather than serve requests it cannot answer. See CLAUDE.md.
 */
import fs from 'fs';
import path from 'path';
import { rupeesToPaise } from '../backend/shared/money.js'; // Integer Money Engine (cap #9)
import { pgQueryDuration, setPoolStatsProvider } from '../backend/services/metrics.service.js';

let pool = null;

export function pgConfigured() { return !!process.env.DATABASE_URL; }

/**
 * Resolve the TLS config for the money database (AQ-3). The money DB is the most
 * sensitive connection in the platform, so the DEFAULT is verified TLS — the
 * previous `{ rejectUnauthorized: false }` accepted ANY certificate, meaning a
 * network attacker who could redirect the connection (a hostile hop, a spoofed
 * managed-DB endpoint) could read and rewrite ledger traffic undetected.
 *
 * Precedence (first match wins):
 *   PG_SSL=false            → no TLS. Only for local/plaintext Postgres.
 *   localhost / 127.0.0.1   → no TLS (implicit local convenience).
 *   PG_SSL=no-verify        → TLS but certificate NOT verified. Escape hatch for
 *                             a provider with a self-signed cert you can't pin;
 *                             loudly warned every boot so it can't hide.
 *   PG_CA_CERT (inline PEM)  → verified TLS pinned to that CA (the right answer
 *                             for managed providers that publish a CA bundle).
 *   default                 → verified TLS against the system trust store.
 */
export function resolvePgSsl(env = process.env) {
  const url = env.DATABASE_URL || '';
  if (env.PG_SSL === 'false') return false;
  if (url.includes('localhost') || url.includes('127.0.0.1')) return false;
  if (env.PG_SSL === 'no-verify') {
    console.warn('⚠️  [pg] PG_SSL=no-verify — money-DB TLS certificate is NOT being verified. ' +
      'Use PG_CA_CERT to pin the provider CA in production.');
    return { rejectUnauthorized: false };
  }
  if (env.PG_CA_CERT && env.PG_CA_CERT.trim()) {
    return { rejectUnauthorized: true, ca: env.PG_CA_CERT };
  }
  return { rejectUnauthorized: true };
}

export async function getPool() {
  if (!pgConfigured()) return null;
  if (pool) return pool;
  const { default: pg } = await import('pg');
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_SIZE || 10),
    ssl: resolvePgSsl(),
  });
  pool.on('error', (e) => console.error('[pg] pool error:', e.message));
  return pool;
}

/**
 * Check out a client with its 'error' event handled.
 *
 * `pool.on('error')` above covers clients sitting IDLE in the pool. It does NOT
 * cover a client you have checked out — and node-postgres emits 'error' on that
 * client asynchronously when the backend goes away mid-statement (a restart, a
 * failover, an admin `pg_terminate_backend`, a network drop). An EventEmitter
 * 'error' with no listener is a hard Node crash, so a checked-out client turned
 * a database blip into the API process exiting.
 *
 * That matters more than it sounds: this is the database every request needs,
 * so an ordinary restart or failover would take down every app instance at
 * once rather than causing the in-flight queries to fail and the next ones to
 * reconnect. Reproduced by stopping Postgres with `pg_ctl -m immediate` during
 * concurrent debits:
 *
 *     Emitted 'error' event on Client instance at:
 *         at Client._handleErrorEvent (pg/lib/client.js:417:10)
 *     …process exits…
 *
 * The handler deliberately only records. The in-flight query still rejects
 * through its own promise, so the caller's catch/ROLLBACK path is unchanged —
 * this exists purely so the asynchronous event has a listener and the process
 * survives to serve the error.
 */
/**
 * Attached ONCE per underlying connection, not once per checkout.
 *
 * A pool hands the same client object back on every checkout, so attaching a
 * fresh listener each time accumulated them on a long-lived connection — an
 * unbounded leak, and one that announced itself as `MaxListenersExceededWarning:
 * 11 error listeners added to [Client]` after only a few hundred transactions
 * in the test suite. The guard has to survive the client being returned to the
 * pool and checked out again, which is exactly what a symbol on the client does
 * and what `once`/`removeListener` on release would not.
 */
const GUARDED = Symbol('bb.pgErrorGuard');

export async function connectGuarded(pool) {
  const client = await pool.connect();
  if (!client[GUARDED]) {
    client[GUARDED] = true;
    client.on('error', (e) => {
      console.error('[pg] checked-out client error (connection lost mid-transaction):', e.message);
    });
  }
  return client;
}

export async function pgQuery(text, params, operation = 'query') {
  const end = pgQueryDuration.startTimer({ operation: String(operation).slice(0, 48) || 'query' });
  try {
    const p = await getPool();
    if (!p) throw new Error('Postgres not configured (DATABASE_URL unset)');
    const result = await p.query(text, params);
    end({ outcome: 'success' });
    return result;
  } catch (error) {
    end({ outcome: 'error' });
    throw error;
  }
}

/**
 * Run a function inside one transaction on one client, and always give the
 * client back.
 *
 * ── The failure this prevents ───────────────────────────────────────────────
 * Every repository that needed a transaction open-coded BEGIN / COMMIT /
 * ROLLBACK / release. That is four things to get right at each site, and the
 * one that gets missed is the release: a client that is never returned is gone
 * from a pool of ten forever, so the tenth transaction to throw takes the whole
 * platform down with requests that hang rather than fail.
 *
 * ── The rule this does NOT relax ────────────────────────────────────────────
 * NEVER ask the pool for a client while holding one. Calling a repository
 * function from inside `fn` asks for a SECOND client, and under load every
 * client in the pool ends up holding one and waiting for another — a deadlock
 * with no error, just a suite that hangs and a platform that stops answering.
 * Everything `fn` needs must go through the `client` it is handed.
 *
 * A throw rolls back and rethrows; the caller sees the original error, not a
 * failure from the rollback.
 */
export async function withTransaction(fn) {
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Best-effort: the connection may already be gone, and reporting a rollback
    // failure would bury the error that actually caused it.
    try { await client.query('ROLLBACK'); } catch { /* connection already lost */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Apply schema.sql idempotently (every statement IF NOT EXISTS / OR REPLACE). */
export async function applySchema() {
  if (!pgConfigured()) return false;
  const sql = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), 'schema.sql'), 'utf8');
  await pgQuery(sql);
  console.log('✅ PostgreSQL schema applied');
  return true;
}

/**
 * Is the money database answering?
 *
 * A real round trip, not a pool-state flag. `pool.totalCount > 0` says a socket
 * exists, which is true of a database that has stopped answering queries — and
 * a readiness probe that reports healthy through an outage is worse than no
 * probe, because it keeps sending traffic to an instance that cannot serve it.
 *
 * Never throws: a probe that raises turns a dependency check into a crash.
 */
export async function isDatabaseReachable() {
  try {
    await pgQuery('SELECT 1', [], 'health_check');
    return true;
  } catch {
    return false;
  }
}

export async function closePg() {
  try { await pool?.end(); } catch { /* closing */ }
  pool = null;
}

/**
 * Current pool saturation, for /metrics (connection-pool monitoring). Returns
 * null when Postgres isn't configured or the pool hasn't opened yet. `waiting`
 * climbing above 0 means requests are queued for a connection — the signal to
 * raise PG_POOL_SIZE or scale the DB.
 */
export function getPoolStats() {
  if (!pool) return null;
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

// Register the pool-stats provider with the metrics module (inversion of control:
// pgClient depends on metrics, never the reverse — this breaks the import cycle
// dependency-cruiser's no-circular rule enforces). The /metrics pgPoolConnections
// gauge samples through this without importing pgClient.
setPoolStatsProvider(getPoolStats);

/** Rupees(float) → integer paise at the Postgres boundary. THE money unit.
 *  Delegates to the Integer Money Engine (shared/money.js) for the canonical
 *  conversion + overflow guard; tolerates null/undefined/NaN as 0 (the PG
 *  boundary is fed by optional fields). */
export function paise(rupees) {
  const n = Number(rupees);
  return rupeesToPaise(Number.isFinite(n) ? n : 0);
}
