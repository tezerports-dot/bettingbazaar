// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/backup.service.js — Automated Backups (plan item 45). 2026-07-13.
 *
 * Daily `pg_dump` of the whole database, compressed, streamed to a PRIVATE
 * S3-compatible bucket of its own (BACKUP_S3_BUCKET) under backups/.
 *
 * ── Never the upload bucket (2026-10-21) ──────────────────────────────────
 * Dumps used to go to S3_BUCKET_NAME, the bucket CDN_URL serves to the
 * public, under a timestamp name. A dump is every account, every hash and every
 * balance; in a publicly readable bucket its only protection was guessing the
 * name. `backupStorage` refuses that bucket by name, and after each good backup
 * the old `backups/` objects are deleted from the public one. Retention: the newest KEEP_BACKUPS archives are kept, older
 * ones pruned. Failures page the admin webhook — a backup that silently stops
 * running is the worst kind of backup.
 *
 * Requirements (graceful when absent, loud in logs AND an alert):
 *   - `pg_dump` on PATH — installed in the Dockerfile (postgresql-client).
 *     Absent → skipped with an alert.
 *   - BACKUP_S3_BUCKET set, and NOT the public S3_BUCKET_NAME — otherwise
 *     skipped with an alert. Endpoint, region and keys default to the S3_* ones
 *     (same R2 account); BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY give it a
 *     token of its own. Local disk is not a real backup target for an
 *     ephemeral container.
 *
 * ── The format is `custom`, not plain SQL ──────────────────────────────────
 * `-Fc` compresses, and more importantly it lets `pg_restore` do a SELECTIVE
 * restore: a single table back, or a schema-only pass before the data. A plain
 * SQL dump is all-or-nothing at exactly the moment somebody needs one table
 * back and cannot afford to drop the rest.
 *
 * ── RESTORE IS TESTED, NOT DOCUMENTED ──────────────────────────────────────
 * "An untested backup is not a backup" was a sentence in this header telling
 * somebody else to go and try it. `dumpToFile` and `restoreFromFile` are
 * exported so the round trip is exercised by `backupRestorePg.test.js` against
 * a real database on every CI run: dump a populated database, restore it into
 * an empty one, and assert the money survives — balances, the ledger, the trial
 * balance, AND the constraints and triggers, because a restore that brings back
 * rows without the rules that guard them hands you a database that looks right
 * and accepts impossible rows.
 *
 * The operator procedure, unchanged (docs/governance/DISASTER_RECOVERY.md):
 *   1. Download the archive from the backup bucket: backups/bb-<timestamp>.dump
 *   2. pg_restore --dbname "$DATABASE_URL" --clean --if-exists bb-<ts>.dump
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client, isS3Configured, listFiles, deleteFile } from './cdn.service.js';

const KEEP_BACKUPS = Number(process.env.BACKUP_KEEP || 14);
const PREFIX = 'backups/';

/**
 * Where backups go, or why they cannot go anywhere. A same-named bucket on
 * another endpoint is a different bucket, so the refusal compares both.
 * @returns {{ ok: true, bucket: string, client: object } | { ok: false, reason: string }}
 */
export function backupStorage(env = process.env) {
  const bucket = (env.BACKUP_S3_BUCKET || '').trim();
  const endpoint = env.BACKUP_S3_ENDPOINT || env.S3_ENDPOINT;
  const accessKeyId = env.BACKUP_S3_ACCESS_KEY || env.S3_ACCESS_KEY;
  const secretAccessKey = env.BACKUP_S3_SECRET_KEY || env.S3_SECRET_KEY;
  if (!bucket) return { ok: false, reason: 'BACKUP_S3_BUCKET is not set (a private bucket for database backups)' };
  if (bucket === (env.S3_BUCKET_NAME || '').trim() && endpoint === env.S3_ENDPOINT) {
    return { ok: false, reason: 'BACKUP_S3_BUCKET is the public upload bucket (S3_BUCKET_NAME); backups need a private bucket of their own' };
  }
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return { ok: false, reason: 'backup bucket credentials missing (BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY, or the S3_* ones)' };
  }
  const client = createS3Client({ endpoint, region: env.BACKUP_S3_REGION || env.S3_REGION, accessKeyId, secretAccessKey });
  return { ok: true, bucket, client };
}

/** Backups left in the public bucket by the old code: deleted once a private copy exists. */
async function sweepPublicBucket() {
  if (!isS3Configured()) return 0;
  let removed = 0;
  for (const old of await listFiles(PREFIX)) {
    try { await deleteFile(old.key); removed += 1; }
    catch (e) { console.warn(`[backup] could not remove ${old.key} from the public bucket:`, e.message); }
  }
  if (removed) console.log(`[backup] removed ${removed} old backup(s) from the public bucket`);
  return removed;
}

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

/** Is `tool` on PATH and runnable? */
function toolAvailable(tool) {
  return new Promise((resolve) => {
    const p = spawn(tool, ['--version']);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

const pgDumpAvailable = () => toolAvailable('pg_dump');
export const pgRestoreAvailable = () => toolAvailable('pg_restore');

/**
 * Run a libpq tool against `url`, with the password kept out of argv.
 *
 * ── THE PASSWORD DOES NOT GO IN argv ───────────────────────────────────────
 * `--dbname=postgres://user:pass@host/db` works, and puts the money database's
 * password in the process arguments — world-readable through /proc on most
 * hosts, and captured by anything that logs a process list. libpq reads
 * PGHOST/PGUSER/PGPASSWORD from the environment instead, so the URL is
 * decomposed into those.
 *
 * `PGDATABASE` will NOT take a URI: libpq treats it as a bare database NAME, so
 * passing the connection string there connects to a database literally called
 * "postgres://…" as the OS user and fails. Verified, because it looks like it
 * should work.
 */
function runPgTool(tool, args, url, { allowExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(tool, args, {
      env: { ...process.env, ...libpqEnv(url), PGCONNECT_TIMEOUT: '30' },
    });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('exit', (code) => (allowExitCodes.includes(code)
      ? resolve({ code, stderr })
      : reject(new Error(`${tool} exit ${code}: ${stderr.slice(-400)}`))));
  });
}

/**
 * Dump `url` to `destPath` in the custom format.
 *
 * Written to a FILE, not held in a buffer: a whole database in memory is an
 * out-of-memory kill at exactly the size where the backup starts to matter.
 */
/**
 * The database a dump or restore talks to: PostgreSQL itself, never the
 * pooler. Behind PgBouncer in transaction mode (the production compose),
 * DATABASE_URL reaches a pool whose server connection changes between
 * transactions, and pg_dump's session settings and long snapshot are exactly
 * what that breaks. DIRECT_DATABASE_URL names the server; without it (a deploy
 * with no pooler) DATABASE_URL already is the server.
 */
export function dumpDatabaseUrl() {
  return process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
}

export async function dumpToFile(destPath, url = dumpDatabaseUrl()) {
  await runPgTool('pg_dump', ['--format=custom', '--compress=6', `--file=${destPath}`], url);
  return { path: destPath, sizeBytes: fs.statSync(destPath).size };
}

/**
 * Restore an archive into `url`.
 *
 * `--clean --if-exists` so the target is replaced rather than merged into —
 * restoring on top of existing rows is how a "successful" restore leaves a
 * database holding two eras of the same account.
 *
 * pg_restore exits NON-ZERO on warnings that are not failures (dropping an
 * object that was never there, an owner role the target does not have), so exit
 * 1 is accepted and its stderr returned for the caller to judge. Treating those
 * as failure is how a restore drill gets abandoned as "broken" when it worked.
 */
export async function restoreFromFile(srcPath, url) {
  if (!fs.existsSync(srcPath)) throw new Error(`restoreFromFile: no archive at ${srcPath}`);
  const { code, stderr } = await runPgTool(
    'pg_restore',
    ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', libpqEnv(url).PGDATABASE ?? '', srcPath],
    url,
    { allowExitCodes: [0, 1] },
  );
  return { ok: true, hadWarnings: code === 1, stderr };
}

export async function runBackup() {
  if (!dumpDatabaseUrl()) return { ok: false, skipped: 'DATABASE_URL not set' };
  const store = backupStorage();
  if (!store.ok) {
    console.error(`[backup] skipped — ${store.reason}`);
    const { sendAlert } = await import('./alerting.service.js');
    sendAlert('backup-storage', 'Database backup skipped: no private backup bucket', { reason: store.reason });
    return { ok: false, skipped: store.reason };
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
    const { sizeBytes: size } = await dumpToFile(tmp, dumpDatabaseUrl());

    // 2. Stream to the private bucket.
    const key = `${PREFIX}bb-${stamp}.dump`;
    const { Upload } = await import('@aws-sdk/lib-storage');
    await new Upload({
      client: store.client,
      params: { Bucket: store.bucket, Key: key, Body: fs.createReadStream(tmp), ContentType: 'application/octet-stream' },
    }).done();
    console.log(`[backup] uploaded ${key} (${(size / 1024 / 1024).toFixed(1)} MB)`);

    // 3. Retention: keep newest KEEP_BACKUPS.
    const listed = await store.client.send(new ListObjectsV2Command({ Bucket: store.bucket, Prefix: PREFIX, MaxKeys: 1000 }));
    const all = (listed.Contents || []).sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
    for (const old of all.slice(KEEP_BACKUPS)) {
      try { await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: old.Key })); console.log(`[backup] pruned ${old.Key}`); }
      catch (e) { console.warn(`[backup] prune failed ${old.Key}:`, e.message); }
    }

    // 4. Only now, with a private copy made, clear the public bucket's old ones.
    const sweptFromPublic = await sweepPublicBucket();
    return { ok: true, key, sizeBytes: size, kept: Math.min(all.length, KEEP_BACKUPS), sweptFromPublic };
  } catch (e) {
    console.error('[backup] FAILED:', e.message);
    const { sendAlert } = await import('./alerting.service.js');
    sendAlert('backup-failure', 'Database backup FAILED', { error: e.message });
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}
