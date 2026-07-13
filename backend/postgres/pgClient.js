// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/pgClient.js — the single Postgres touchpoint (hybrid money DB,
 * plan items 6/10/11, step 1). 2026-07-13.
 *
 * PERMANENT architecture, not a shim (plan directive): this module, the
 * dual-write layer, and the reconciliation script are maintained core systems.
 * Activation is env-gated: DATABASE_URL unset (every current deploy) = the
 * whole Postgres layer is a documented no-op and the app behaves exactly as
 * before; set = pool opens and applySchema() runs idempotently at boot.
 */
import fs from 'fs';
import path from 'path';

let pool = null;

export function pgConfigured() { return !!process.env.DATABASE_URL; }

export async function getPool() {
  if (!pgConfigured()) return null;
  if (pool) return pool;
  const { default: pg } = await import('pg');
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_SIZE || 10),
    // Managed providers commonly require TLS; PG_SSL=false opts out for local.
    ssl: process.env.PG_SSL === 'false' ? false : (process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1') ? false : { rejectUnauthorized: false }),
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

/** Rupees(float) → integer paise at the Postgres boundary. THE money unit. */
export function paise(rupees) { return Math.round((Number(rupees) || 0) * 100); }
