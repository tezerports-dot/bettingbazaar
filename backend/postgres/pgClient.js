// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/pgClient.js — the single Postgres touchpoint (hybrid money DB,
 * plan items 6/10/11, step 1). 2026-07-13.
 *
 * PERMANENT architecture, not a shim (plan directive): this module, the
 * dual-write layer, and the reconciliation script are maintained core systems.
 * Activation is production-required for the hybrid MongoDB + PostgreSQL money
 * layer: DATABASE_URL opens the pool and applySchema() runs idempotently at boot.
 * Non-production can still omit it for local Mongo-only development/tests.
 */
import fs from 'fs';
import path from 'path';
import { rupeesToPaise } from '../shared/money.js'; // Integer Money Engine (cap #9)

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

export async function pgQuery(text, params) {
  const p = await getPool();
  if (!p) throw new Error('Postgres not configured (DATABASE_URL unset)');
  return p.query(text, params);
}

/** Apply schema.sql idempotently (every statement IF NOT EXISTS / OR REPLACE). */
export async function applySchema() {
  if (!pgConfigured()) return false;
  const sql = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), 'schema.sql'), 'utf8');
  await pgQuery(sql);
  console.log('✅ Postgres money schema applied (hybrid DB active — dual-write ON)');
  return true;
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

/** Rupees(float) → integer paise at the Postgres boundary. THE money unit.
 *  Delegates to the Integer Money Engine (shared/money.js) for the canonical
 *  conversion + overflow guard; tolerates null/undefined/NaN as 0 (the PG
 *  boundary is fed by optional Mongo fields). */
export function paise(rupees) {
  const n = Number(rupees);
  return rupeesToPaise(Number.isFinite(n) ? n : 0);
}
