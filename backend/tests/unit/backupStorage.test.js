// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * backupStorage — the nightly database dump goes to a PRIVATE bucket of its
 * own, never the public upload bucket CDN_URL serves (backup.service.js).
 */
import { describe, it, expect } from 'vitest';
import { backupStorage } from '../../services/backup.service.js';

const PUBLIC = {
  S3_BUCKET_NAME: 'bb-public',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
};

describe('backupStorage', () => {
  it('refuses when no backup bucket is set (no fallback to the public one)', () => {
    const r = backupStorage({ ...PUBLIC });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BACKUP_S3_BUCKET is not set/);
  });

  it('refuses the public upload bucket by name, whitespace included', () => {
    const r = backupStorage({ ...PUBLIC, BACKUP_S3_BUCKET: ' bb-public ' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/public upload bucket/);
  });

  it('accepts a separate bucket on the same account, reusing the S3 keys', () => {
    const r = backupStorage({ ...PUBLIC, BACKUP_S3_BUCKET: 'bb-backups' });
    expect(r.ok).toBe(true);
    expect(r.bucket).toBe('bb-backups');
  });

  it('accepts the same name on a DIFFERENT endpoint (a different bucket)', () => {
    const r = backupStorage({
      ...PUBLIC, BACKUP_S3_BUCKET: 'bb-public', BACKUP_S3_ENDPOINT: 'https://other.r2.cloudflarestorage.com',
    });
    expect(r.ok).toBe(true);
  });

  it('refuses when there are no keys for the backup bucket at all', () => {
    const r = backupStorage({ BACKUP_S3_BUCKET: 'bb-backups', S3_ENDPOINT: PUBLIC.S3_ENDPOINT });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/credentials missing/);
  });
});
