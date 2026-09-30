// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * repositories/androidReleases.js — the APKs an admin has uploaded, and which
 * of them the installed app is told about.
 *
 * The one owner of "what version of the Android app exists, where its file is,
 * and which versions may no longer be run" (§2). The identity columns come
 * from the file (apkInspector.js), so nothing here accepts them from a form.
 *
 * ── Publishing is serialised ───────────────────────────────────────────────
 * A release may only be published above every release already published —
 * Android refuses a downgrade, so offering a lower version code would put
 * every phone in an update loop. "Is this the highest?" read in one statement
 * and acted on in another is §32 S6: two publishes at once both pass. So the
 * guard is in the UPDATE's own WHERE, under a transaction-scoped advisory lock
 * that every publish takes first; the second waits, then finds the first.
 *
 * The SIGNING KEY is guarded the same way, and for the same reason. The upload
 * route checks a new APK's key against the published release, but that is a
 * read at upload time: two drafts signed with different keys can both be
 * uploaded while nothing is published yet, and publishing them in turn would
 * send phones an update Android refuses. So the publish itself refuses a key
 * that differs from any release already published.
 */
import { pgQuery, withTransaction } from '../client.js';
import { randomBytes } from 'node:crypto';

const newId = () => randomBytes(12).toString('hex');
const PUBLISH_LOCK = 0x41504b31; // 'APK1' — the advisory lock every publish takes

function toRelease(row) {
  if (!row) return null;
  return {
    releaseId: row.release_id,
    packageName: row.package_name,
    versionCode: Number(row.version_code),
    versionName: row.version_name,
    minSdk: row.min_sdk == null ? null : Number(row.min_sdk),
    signerSha256: row.signer_sha256,
    fileSha256: row.file_sha256,
    sizeBytes: Number(row.size_bytes),       // BIGINT arrives as a string (trap 5)
    fileUrl: row.file_url,
    storage: row.storage,
    fileKey: row.file_key,
    releaseNotes: row.release_notes,
    mandatory: row.mandatory === true,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    published: row.published_at != null,
  };
}

export async function createRelease({
  packageName, versionCode, versionName, minSdk = null, signerSha256, fileSha256,
  sizeBytes, fileUrl, storage, fileKey, releaseNotes = '', uploadedBy = null,
}) {
  const { rows } = await pgQuery(
    `INSERT INTO android_releases
       (release_id, package_name, version_code, version_name, min_sdk, signer_sha256,
        file_sha256, size_bytes, file_url, storage, file_key, release_notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [newId(), packageName, versionCode, versionName, minSdk, signerSha256, fileSha256,
      sizeBytes, fileUrl, storage, fileKey, releaseNotes, uploadedBy],
    'android_release_create',
  );
  return toRelease(rows[0]);
}

export async function getRelease(releaseId) {
  const { rows } = await pgQuery(
    'SELECT * FROM android_releases WHERE release_id = $1', [String(releaseId)], 'android_release_get');
  return toRelease(rows[0]);
}

/** Every read that DECIDES something is scoped to one package, and requires it. */
function pkg(packageName) {
  if (!packageName) throw new Error('androidReleases: a packageName is required');
  return String(packageName);
}

export async function getReleaseByVersionCode(packageName, versionCode) {
  const { rows } = await pgQuery(
    'SELECT * FROM android_releases WHERE package_name = $1 AND version_code = $2',
    [pkg(packageName), Number(versionCode)], 'android_release_by_code');
  return toRelease(rows[0]);
}

export async function listReleases(packageName, { limit = 50 } = {}) {
  const { rows } = await pgQuery(
    'SELECT * FROM android_releases WHERE package_name = $1 ORDER BY version_code DESC LIMIT $2',
    [pkg(packageName), Math.min(Math.max(Number(limit) || 50, 1), 200)], 'android_release_list');
  return rows.map(toRelease);
}

/**
 * What an installed app is told: the newest published release, and the
 * highest mandatory published version code (0 when nothing is mandatory).
 */
export async function getUpdatePolicy(packageName) {
  const { rows } = await pgQuery(
    `SELECT
       (SELECT row_to_json(r) FROM (
          SELECT * FROM android_releases WHERE package_name = $1 AND published_at IS NOT NULL
           ORDER BY version_code DESC LIMIT 1) r)                          AS latest,
       COALESCE((SELECT max(version_code) FROM android_releases
                  WHERE package_name = $1 AND published_at IS NOT NULL AND mandatory), 0) AS min_code`,
    [pkg(packageName)], 'android_release_policy',
  );
  return { latest: toRelease(rows[0].latest), minRequiredVersionCode: Number(rows[0].min_code) };
}

/** Notes and the mandatory flag are the only things that may change on a row. */
export async function updateRelease(releaseId, { releaseNotes, mandatory }) {
  const { rows } = await pgQuery(
    `UPDATE android_releases
        SET release_notes = COALESCE($2, release_notes),
            mandatory     = COALESCE($3, mandatory)
      WHERE release_id = $1
      RETURNING *`,
    [String(releaseId), releaseNotes ?? null, mandatory ?? null],
    'android_release_update',
  );
  return toRelease(rows[0]);
}

/**
 * Publish a draft. Returns { release } on success, or { refused } naming why:
 * 'not_found' | 'already_published' | 'different_key' | 'not_newest'.
 */
export async function publishRelease(releaseId, publishedBy) {
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [PUBLISH_LOCK]);
    const { rows } = await client.query(
      `UPDATE android_releases r
          SET published_at = now(), published_by = $2
        WHERE r.release_id = $1
          AND r.published_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM android_releases p
                           WHERE p.package_name = r.package_name
                             AND p.published_at IS NOT NULL AND p.version_code >= r.version_code)
          AND NOT EXISTS (SELECT 1 FROM android_releases k
                           WHERE k.package_name = r.package_name
                             AND k.published_at IS NOT NULL AND k.signer_sha256 <> r.signer_sha256)
        RETURNING *`,
      [String(releaseId), publishedBy ?? null],
    );
    if (rows[0]) return { release: toRelease(rows[0]) };

    // Nothing moved — say which of the three reasons it was.
    const { rows: cur } = await client.query(
      'SELECT * FROM android_releases WHERE release_id = $1', [String(releaseId)]);
    if (!cur[0]) return { refused: 'not_found' };
    if (cur[0].published_at) return { refused: 'already_published' };
    const { rows: key } = await client.query(
      `SELECT version_name FROM android_releases
        WHERE package_name = $1 AND published_at IS NOT NULL AND signer_sha256 <> $2
        ORDER BY version_code DESC LIMIT 1`, [cur[0].package_name, cur[0].signer_sha256]);
    if (key[0]) return { refused: 'different_key', publishedVersionName: key[0].version_name };
    const { rows: top } = await client.query(
      'SELECT max(version_code) AS code FROM android_releases WHERE package_name = $1 AND published_at IS NOT NULL',
      [cur[0].package_name]);
    return { refused: 'not_newest', publishedVersionCode: Number(top[0].code) };
  });
}

/** Drafts only: a published release is history and stays. */
export async function deleteDraft(releaseId) {
  const { rows } = await pgQuery(
    'DELETE FROM android_releases WHERE release_id = $1 AND published_at IS NULL RETURNING *',
    [String(releaseId)], 'android_release_delete_draft');
  return toRelease(rows[0]);
}
