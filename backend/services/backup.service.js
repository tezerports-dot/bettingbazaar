// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/backup.service.js — Automated Backups (plan item 45). 2026-07-13.
 *
 * Daily `pg_dump` of the whole database, compressed, streamed to the configured
 * S3-compatible bucket under backups/ (the same storage the app already uses —
 * no new provider). Retention: the newest KEEP_BACKUPS archives are kept, older
 * ones pruned. Failures page the admin webhook — a backup that silently stops
 * running is the worst kind of backup.
 *
 * Requirements (graceful when absent, loud in logs AND an alert):
 *   - `pg_dump` on PATH — installed in the Dockerfile (postgresql-client).
 *     Absent → skipped with an alert.
 *   - S3 configured (S3_* env) — absent → skipped with a warning. Local disk is
 *     not a real backup target for an ephemeral container.
 *
 * ── The format is `custom`, not plain SQL ──────────────────────────────────
 * `-Fc` compresses, and more importantly it lets `pg_restore` do a SELECTIVE
 * restore: a single table back, or a schema-only pass before the data. A plain
 * SQL dump is all-or-nothing at exactly the moment somebody needs one table
 * back and cannot afford to drop the rest.
 *
 * RESTORE — test this on staging before you ever need it. An untested backup is
 * not a backup; see docs/governance/DISASTER_RECOVERY.md:
 *   1. Download the archive from S3: backups/bb-<timestamp>.dump
 *   2. pg_restore --dbname "$DATABASE_URL" --clean --if-exists bb-<ts>.dump
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isS3Configured, uploadStreamToS3, listFiles, deleteFile } from './cdn.service.js';

const KEEP_BACKUPS = Number(process.env.BACKUP_KEEP || 14);
const PREFIX = 'backups/';

/**
 * A connection URL, decomposed into the variables libpq reads.
 *
 * So the password never reaches `argv`. Every field is optional — libpq falls
 * back to its own defaults for anything absent, which is what makes a socket
 * connection with no host or password work unchanged.
 */
function libpqEnv(url) {
  try {
    const u = new URL(url);
    const env = {};
    if (u.hostname) env.PGHOST = u.hostname;
    if (u.port) env.PGPORT = u.port;
    if (u.username) env.PGUSER = decodeURIComponent(u.username);
    if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
    const database = u.pathname.replace(/^\//, '');
    if (database) env.PGDATABASE = database;
    // sslmode and friends travel in the query string; pass them through.
    for (const [key, value] of u.searchParams) {
      if (/^[a-z_]+$/.test(key)) env[`PG${key.toUpperCase()}`] = value;
    }
    return env;
  } catch {
    // An unparseable URL is a configuration error, and `pg_dump` reports it far
    // better than this function could. Let it try and fail loudly.
    return {};
  }
}

function pgDumpAvailable() {
  return new Promise((resolve) => {
    const p = spawn('pg_dump', ['--version']);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

export async function runBackup() {
  if (!process.env.DATABASE_URL) return { ok: false, skipped: 'DATABASE_URL not set' };
  if (!isS3Configured()) {
    console.warn('[backup] skipped — S3 not configured (backups need durable off-box storage)');
    return { ok: false, skipped: 'S3 not configured' };
  }
  if (!(await pgDumpAvailable())) {
    console.error('[backup] pg_dump not found — install postgresql-client (see Dockerfile)');
    const { sendAlert } = await import('./alerting.service.js');
    sendAlert('backup-tooling', 'Database backup skipped: pg_dump missing on this host', {});
    return { ok: false, skipped: 'pg_dump missing' };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(os.tmpdir(), `bb-${stamp}.dump`);
  try {
    // 1. Dump to a temp file — bounded disk, not memory. A whole database held
    //    in a buffer is an out-of-memory kill at exactly the size where the
    //    backup starts to matter.
    await new Promise((resolve, reject) => {
      // ── THE PASSWORD DOES NOT GO IN argv ─────────────────────────────────
      // `--dbname=postgres://user:pass@host/db` works, and puts the money
      // database's password in the process arguments — world-readable through
      // /proc on most hosts, and captured by anything that logs a process list.
      // libpq reads PGHOST/PGUSER/PGPASSWORD from the environment instead, so
      // the URL is decomposed into those.
      //
      // `PGDATABASE` will NOT take a URI: libpq treats it as a bare database
      // NAME, so passing the connection string there connects to a database
      // literally called "postgres://…" as the OS user and fails. Verified,
      // because it looks like it should work.
      const p = spawn('pg_dump', ['--format=custom', '--compress=6', `--file=${tmp}`], {
        env: { ...process.env, ...libpqEnv(process.env.DATABASE_URL), PGCONNECT_TIMEOUT: '30' },
      });
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('error', reject);
      p.on('exit', (code) => (code === 0
        ? resolve()
        : reject(new Error(`pg_dump exit ${code}: ${stderr.slice(-400)}`))));
    });

    // 2. Stream to S3.
    const size = fs.statSync(tmp).size;
    const key = `${PREFIX}bb-${stamp}.dump`;
    await uploadStreamToS3(key, fs.createReadStream(tmp), 'application/octet-stream');
    console.log(`[backup] uploaded ${key} (${(size / 1024 / 1024).toFixed(1)} MB)`);

    // 3. Retention: keep newest KEEP_BACKUPS.
    const all = (await listFiles(PREFIX)).sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    for (const old of all.slice(KEEP_BACKUPS)) {
      try { await deleteFile(old.key); console.log(`[backup] pruned ${old.key}`); }
      catch (e) { console.warn(`[backup] prune failed ${old.key}:`, e.message); }
    }
    return { ok: true, key, sizeBytes: size, kept: Math.min(all.length, KEEP_BACKUPS) };
  } catch (e) {
    console.error('[backup] FAILED:', e.message);
    const { sendAlert } = await import('./alerting.service.js');
    sendAlert('backup-failure', 'Database backup FAILED', { error: e.message });
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}
