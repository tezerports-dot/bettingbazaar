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
 *
 * ── Halting (R9) ──────────────────────────────────────────────────────────
 * A published release can be HALTED: it stops being offered, downloaded or
 * required, and phones are pointed back at the newest release that is not
 * halted. It stays PUBLISHED, deliberately — phones may already run it, so the
 * publish guards above keep counting it and the next release must still be
 * above it. Halting cannot uninstall anything; it stops the damage spreading.
 *
 * ── Which phones a release is for ─────────────────────────────────────────
 * A release that needs a newer Android than a phone has can never be
 * installed on it. So the policy is asked FOR a phone's API level: such a
 * release is neither offered to that phone nor allowed to set its floor —
 * a floor it cannot reach would be an update screen it can never leave.
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
    haltedAt: row.halted_at ?? null,
    haltedBy: row.halted_by ?? null,
    haltReason: row.halt_reason ?? null,
    halted: row.halted_at != null,
    signatureSchemes: (row.signature_schemes ?? []).map(Number),
    // Present only on the admin list, which joins the people's names.
    uploadedByName: row.uploaded_by_name ?? null,
    publishedByName: row.published_by_name ?? null,
    haltedByName: row.halted_by_name ?? null,
  };
}

export async function createRelease({
  packageName, versionCode, versionName, minSdk = null, signerSha256, fileSha256,
  sizeBytes, fileUrl, storage, fileKey, releaseNotes = '', uploadedBy = null, signatureSchemes = [],
}) {
  const { rows } = await pgQuery(
    `INSERT INTO android_releases
       (release_id, package_name, version_code, version_name, min_sdk, signer_sha256,
        file_sha256, size_bytes, file_url, storage, file_key, release_notes, uploaded_by,
        signature_schemes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [newId(), packageName, versionCode, versionName, minSdk, signerSha256, fileSha256,
      sizeBytes, fileUrl, storage, fileKey, releaseNotes, uploadedBy, signatureSchemes.map(Number)],
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
    `SELECT r.*,
            (SELECT username FROM users WHERE user_id = r.uploaded_by)  AS uploaded_by_name,
            (SELECT username FROM users WHERE user_id = r.published_by) AS published_by_name,
            (SELECT username FROM users WHERE user_id = r.halted_by)    AS halted_by_name
       FROM android_releases r WHERE r.package_name = $1 ORDER BY r.version_code DESC LIMIT $2`,
    [pkg(packageName), Math.min(Math.max(Number(limit) || 50, 1), 200)], 'android_release_list');
  return rows.map(toRelease);
}

/**
 * What an installed app is told, FOR the phone asking.
 *
 *   latest                 the newest published release that is not halted and
 *                          that this phone's Android can install
 *   minRequiredVersionCode the highest MANDATORY such release (0 when none)
 *   unsupportedBelow       the highest mandatory release this phone can NOT
 *                          install, when that is above minRequiredVersionCode:
 *                          an install below it must not run and cannot update
 *   unsupportedMinSdk      the Android API level that release needs
 *
 * `sdk` is the phone's API level; unknown (an older app, or a browser) means
 * every release is treated as installable, which is how it behaved before.
 * Halted releases are left out of all of it.
 */
export async function getUpdatePolicy(packageName, { sdk = null } = {}) {
  const level = Number.isInteger(sdk) && sdk > 0 ? sdk : null;
  const { rows } = await pgQuery(
    `WITH live AS (
       SELECT * FROM android_releases
        WHERE package_name = $1 AND published_at IS NOT NULL AND halted_at IS NULL
     ), fits AS (
       SELECT * FROM live WHERE $2::int IS NULL OR min_sdk IS NULL OR min_sdk <= $2::int
     )
     SELECT
       (SELECT row_to_json(r) FROM (SELECT * FROM fits ORDER BY version_code DESC LIMIT 1) r) AS latest,
       COALESCE((SELECT max(version_code) FROM fits WHERE mandatory), 0) AS min_code,
       (SELECT row_to_json(u) FROM (
          SELECT version_code, min_sdk FROM live
           WHERE mandatory AND NOT (version_code IN (SELECT version_code FROM fits))
           ORDER BY version_code DESC LIMIT 1) u) AS beyond`,
    [pkg(packageName), level], 'android_release_policy',
  );
  const minRequiredVersionCode = Number(rows[0].min_code);
  const beyond = rows[0].beyond;
  const unsupported = beyond && Number(beyond.version_code) > minRequiredVersionCode;
  return {
    latest: toRelease(rows[0].latest),
    minRequiredVersionCode,
    unsupportedBelow: unsupported ? Number(beyond.version_code) : 0,
    unsupportedMinSdk: unsupported ? Number(beyond.min_sdk) : null,
  };
}

/**
 * The highest PUBLISHED release, halted or not. What the upload compares a new
 * APK against: a halted build is no longer offered, but phones may run it,
 * so a new build must still be above it and signed with its key. The publish
 * itself enforces the same in its WHERE; this is the early, worded refusal.
 */
export async function getHighestPublished(packageName) {
  const { rows } = await pgQuery(
    `SELECT * FROM android_releases WHERE package_name = $1 AND published_at IS NOT NULL
      ORDER BY version_code DESC LIMIT 1`,
    [pkg(packageName)], 'android_release_highest_published');
  return toRelease(rows[0]);
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
    // clock_timestamp(), not now(): now() is when this transaction BEGAN, which
    // is before it waited for the lock, so a publish that queued behind
    // another was stamped earlier than the one it followed.
    const { rows } = await client.query(
      `UPDATE android_releases r
          SET published_at = clock_timestamp(), published_by = $2
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

/**
 * Stop offering a published release. Refuses a draft and an already-halted
 * release, IN the statement; returns { release } or { refused }.
 */
export async function haltRelease(releaseId, haltedBy, reason) {
  const { rows } = await pgQuery(
    `UPDATE android_releases
        SET halted_at = clock_timestamp(), halted_by = $2, halt_reason = $3
      WHERE release_id = $1 AND published_at IS NOT NULL AND halted_at IS NULL
      RETURNING *`,
    [String(releaseId), haltedBy ?? null, String(reason)], 'android_release_halt');
  if (rows[0]) return { release: toRelease(rows[0]) };
  const cur = await getRelease(releaseId);
  if (!cur) return { refused: 'not_found' };
  if (!cur.published) return { refused: 'not_published' };
  return { refused: 'already_halted' };
}

/** Offer a halted release again. */
export async function resumeRelease(releaseId) {
  const { rows } = await pgQuery(
    `UPDATE android_releases SET halted_at = NULL, halted_by = NULL, halt_reason = NULL
      WHERE release_id = $1 AND halted_at IS NOT NULL
      RETURNING *`,
    [String(releaseId)], 'android_release_resume');
  if (rows[0]) return { release: toRelease(rows[0]) };
  return { refused: (await getRelease(releaseId)) ? 'not_halted' : 'not_found' };
}
