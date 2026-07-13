// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/backup.service.js — Automated Backups (plan item 45). 2026-07-13.
 *
 * Daily mongodump of the whole database, gzip-archived, streamed to the
 * configured S3-compatible bucket under backups/ (same storage the app already
 * uses — no new provider). Retention: the newest KEEP_BACKUPS archives are
 * kept, older ones pruned. Failures page the admin webhook (item 38) — a
 * backup that silently stops running is the worst kind of backup.
 *
 * Requirements (graceful when absent, loud in logs + alert):
 *   - `mongodump` binary on PATH — installed in the Dockerfile
 *     (mongodb-database-tools). Absent → skipped with an alert.
 *   - S3 configured (S3_* env) — absent → skipped with a warning (local disk
 *     is not a real backup target for an ephemeral container).
 *
 * RESTORE (test this on staging before you ever need it — an untested backup
 * is not a backup; see DISASTER_RECOVERY.md):
 *   1. Download the archive from S3: backups/bb-<timestamp>.archive.gz
 *   2. mongorestore --uri "$MONGODB_URI" --gzip --archive=bb-<ts>.archive.gz --drop
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isS3Configured, uploadStreamToS3, listFiles, deleteFile } from './cdn.service.js';

const KEEP_BACKUPS = Number(process.env.BACKUP_KEEP || 14);
const PREFIX = 'backups/';

function mongodumpAvailable() {
  return new Promise((resolve) => {
    const p = spawn('mongodump', ['--version']);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

export async function runBackup() {
  if (!process.env.MONGODB_URI) return { ok: false, skipped: 'MONGODB_URI not set' };
  if (!isS3Configured()) {
    console.warn('[backup] skipped — S3 not configured (backups need durable off-box storage)');
    return { ok: false, skipped: 'S3 not configured' };
  }
  if (!(await mongodumpAvailable())) {
    console.error('[backup] mongodump binary not found — install mongodb-database-tools (see Dockerfile)');
    const { sendAlert } = await import('./alerting.service.js');
    sendAlert('backup-tooling', 'Database backup skipped: mongodump binary missing on this host', {});
    return { ok: false, skipped: 'mongodump missing' };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(os.tmpdir(), `bb-${stamp}.archive.gz`);
  try {
    // 1. Dump to a temp file (bounded disk, not memory).
    await new Promise((resolve, reject) => {
      const p = spawn('mongodump', ['--uri', process.env.MONGODB_URI, '--gzip', `--archive=${tmp}`]);
      let stderr = '';
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('error', reject);
      p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`mongodump exit ${code}: ${stderr.slice(-400)}`)));
    });

    // 2. Stream to S3.
    const size = fs.statSync(tmp).size;
    const key = `${PREFIX}bb-${stamp}.archive.gz`;
    await uploadStreamToS3(key, fs.createReadStream(tmp), 'application/gzip');
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
