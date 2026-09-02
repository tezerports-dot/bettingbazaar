// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/identityPg.js — revoked tokens, and the Aadhaar verification queue.
 *
 * ── No identity DOCUMENTS exist anywhere in this platform ────────────────────
 * KYC is a 12-digit number typed into the bot. There is no ID scan, no address
 * proof, no selfie and no video, and there is no upload route to add one to.
 * The number is held as an HMAC (for uniqueness, enforced by the database) plus
 * an AES-256-GCM ciphertext (for the audited bulk export), and nothing else.
 * See 04-GOVERNANCE.md §1 before proposing any change here.
 *
 * ── Expiry is enforced by the read ───────────────────────────────────────────
 * `isTokenRevoked` filters on `expires_at`, and `sweepExpired` only reclaims
 * space. A revoked token must not become valid again because a cron job was
 * late — which is exactly what would happen if the read trusted the sweep.
 */
import { pgQuery, getPool, connectGuarded } from '../client.js';

const toInt = (v) => (v == null ? null : Number(v));

// ── Revoked tokens ───────────────────────────────────────────────────────────

/**
 * Revoke a token until it would have expired anyway.
 *
 * Idempotent: revoking twice is not an error, and a sign-out that is retried
 * must not fail. The token itself is the primary key, so this is one index
 * probe on a path every authenticated request takes.
 */
export async function revokeToken(token, { ttlSeconds = 86_400 } = {}) {
  if (!token) throw new Error('revokeToken requires a token');
  await pgQuery(
    `INSERT INTO token_blacklist (token, expires_at)
     VALUES ($1, now() + ($2 || ' seconds')::interval)
     ON CONFLICT (token) DO NOTHING`,
    [String(token), String(ttlSeconds)], 'token_revoke',
  );
}

/**
 * Has this token been revoked?
 *
 * Checked on EVERY authenticated request, so it is a primary-key lookup and
 * nothing more. The `expires_at` filter is what makes the sweep optional rather
 * than load-bearing.
 */
export async function isTokenRevoked(token) {
  if (!token) return false;
  const { rows } = await pgQuery(
    `SELECT 1 FROM token_blacklist WHERE token = $1 AND expires_at > now()`,
    [String(token)], 'token_is_revoked',
  );
  return rows.length > 0;
}

// ── Aadhaar verification ─────────────────────────────────────────────────────

/**
 * Every column EXCEPT the ciphertext.
 *
 * `aadhaar_encrypted` is absent on purpose: it is readable only through
 * `exportPending`, which is the audited disclosure path. A projection that
 * included it by default would put an Aadhaar number into whatever response
 * happened to render a verification row.
 */
const KYC_COLUMNS = `
  user_id, aadhaar_hash, aadhaar_last4, phone, status,
  export_batch_id, exported_at, import_batch_id, verified_at,
  failure_reason, created_at, updated_at`;

function toVerification(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    aadhaarHash: row.aadhaar_hash,
    aadhaarLast4: row.aadhaar_last4,
    phone: row.phone,
    status: row.status,
    exportBatchId: row.export_batch_id,
    exportedAt: row.exported_at,
    importBatchId: row.import_batch_id,
    verifiedAt: row.verified_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getVerification(userId) {
  if (!userId) return null;
  const { rows } = await pgQuery(
    `SELECT ${KYC_COLUMNS} FROM kyc_verifications WHERE user_id = $1`,
    [String(userId)], 'kyc_get',
  );
  return toVerification(rows[0]);
}

/** Is this Aadhaar already registered? A hash lookup; the number never appears. */
export async function isAadhaarRegistered(aadhaarHash) {
  const { rows } = await pgQuery(
    `SELECT 1 FROM kyc_verifications WHERE aadhaar_hash = $1`,
    [String(aadhaarHash)], 'kyc_hash_exists',
  );
  return rows.length > 0;
}

/**
 * The same question across every hash a rotation may have produced.
 *
 * The HMAC secret is rotatable, so one Aadhaar has several valid hashes: the
 * current secret's and each retired one's. Checking only the current hash would
 * report a number as unregistered because it was registered under the previous
 * secret — and then the INSERT would collide on a hash the check never looked
 * at, turning a clear "already registered" into an opaque failure.
 *
 * @param {string[]} candidates every hash from `hashAadhaarCandidates`
 */
export async function findRegisteredAadhaar(candidates = []) {
  const hashes = candidates.filter(Boolean).map(String);
  if (!hashes.length) return null;
  const { rows } = await pgQuery(
    `SELECT user_id, aadhaar_hash FROM kyc_verifications WHERE aadhaar_hash = ANY($1::text[])`,
    [hashes], 'kyc_hash_candidates',
  );
  return rows[0] ? { userId: rows[0].user_id, aadhaarHash: rows[0].aadhaar_hash } : null;
}

/**
 * Submit an Aadhaar for verification.
 *
 * The UNIQUE index on the hash decides whether this is a duplicate, not a prior
 * lookup: two signups racing with the same number must not both be accepted,
 * and a check-then-insert has a window between the two statements. A conflict
 * returns `{ ok: false, reason: 'aadhaar_taken' }` rather than throwing, because
 * "this number is already registered" is an answer the bot must give a person,
 * not a 500.
 */
export async function submitVerification({
  userId, aadhaarHash, aadhaarEncrypted, aadhaarLast4, phone,
}) {
  if (!userId || !aadhaarHash || !aadhaarEncrypted) {
    throw new Error('submitVerification requires userId, aadhaarHash and aadhaarEncrypted');
  }
  const { rows } = await pgQuery(
    `INSERT INTO kyc_verifications (user_id, aadhaar_hash, aadhaar_encrypted, aadhaar_last4, phone)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING
     RETURNING ${KYC_COLUMNS}`,
    [String(userId), String(aadhaarHash), String(aadhaarEncrypted),
     String(aadhaarLast4 ?? ''), String(phone ?? '')],
    'kyc_submit',
  );
  if (rows[0]) return { ok: true, verification: toVerification(rows[0]) };

  // Which conflict was it? The two need telling apart: a resubmission by the
  // same person is a retry, and the same number under a DIFFERENT account is
  // the duplicate-account attempt this table exists to stop.
  const existing = await getVerification(userId);
  if (existing?.aadhaarHash === String(aadhaarHash)) {
    return { ok: true, idempotent: true, verification: existing };
  }
  return { ok: false, reason: existing ? 'user_already_submitted' : 'aadhaar_taken' };
}

/**
 * Delete a FAILED submission's row.
 *
 * Not a loophole, and not tidiness. `aadhaar_hash` is unique, so a mistyped
 * digit otherwise parks a STRANGER's Aadhaar in that index and locks its real
 * owner out of signup permanently. Only a FAILED row qualifies — the WHERE
 * clause is the guard, so a caller cannot widen it by passing a status.
 */
export async function releaseFailedSubmission(userId) {
  const { rowCount } = await pgQuery(
    `DELETE FROM kyc_verifications WHERE user_id = $1 AND status = 'FAILED'`,
    [String(userId)], 'kyc_release_failed',
  );
  return rowCount > 0;
}

/**
 * Claim the pending queue for an export batch, oldest first.
 *
 * Returns the CIPHERTEXT — this is the audited disclosure path and the only
 * caller that sees it. Stamping the batch id in the same statement that selects
 * the rows is what makes the disclosure traceable: two rows sharing a batch id
 * went to the verifier in the same file, which is what a disputed result is
 * reconstructed from.
 */
export async function exportPending({ batchId, limit = 500, actorId = null, note = '' }) {
  if (!batchId) throw new Error('exportPending requires a batchId');
  return withIdentityTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE kyc_verifications SET
         export_batch_id = $1, exported_at = now(), updated_at = now()
       WHERE user_id IN (
         SELECT user_id FROM kyc_verifications
          WHERE status = 'PENDING_VERIFICATION' AND export_batch_id IS NULL
          ORDER BY created_at
          LIMIT $2
          -- Two exports running at once must not both claim the same rows and
          -- disclose one Aadhaar in two files.
          FOR UPDATE SKIP LOCKED)
       RETURNING user_id, aadhaar_encrypted, aadhaar_last4, phone`,
      [String(batchId), Math.min(Math.max(Number(limit) || 500, 1), 5000)],
    );
    await client.query(
      `INSERT INTO kyc_batches (batch_id, kind, actor_id, row_count, note)
       VALUES ($1, 'EXPORT', $2, $3, $4)`,
      [String(batchId), String(actorId ?? 'system'), rows.length, note],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      aadhaarEncrypted: r.aadhaar_encrypted,
      aadhaarLast4: r.aadhaar_last4,
      phone: r.phone,
    }));
  });
}

/**
 * Apply a verifier's verdicts.
 *
 * BOTH verdicts are written. Applying only the VERIFIED half leaves a player
 * whose number did not check out sitting at PENDING for ever — never able to
 * withdraw, never told why, and absent from the queue because the batch says it
 * handled them.
 *
 * Counts are RECONSTRUCTED from the rows the statements actually touched, never
 * accumulated in a loop: an accumulator counts iterations, and a crash midway
 * loses the tally while the verdicts stay applied.
 */
export async function importVerdicts({ batchId, verdicts = [], actorId = null, note = '' }) {
  if (!batchId) throw new Error('importVerdicts requires a batchId');

  // A verdict that names no user is a MALFORMED FILE, not a row to skip.
  // Without this it counts as `skipped`, which is the same number a legitimately
  // stale row produces — so an operator reading "skipped: 3" cannot tell
  // "already decided" from "the verifier sent us garbage". Refuse the whole
  // import: a partially-applied batch of unknown provenance is worse than one
  // that has to be re-sent.
  const malformed = verdicts.filter((v) => !v?.userId);
  if (malformed.length) {
    throw new Error(
      `importVerdicts: ${malformed.length} verdict(s) name no user — refusing the batch`);
  }

  const verified = verdicts.filter((v) => v.verified).map((v) => String(v.userId));
  const failed = verdicts.filter((v) => !v.verified);

  return withIdentityTransaction(async (client) => {
    let verifiedCount = 0;
    if (verified.length) {
      const r = await client.query(
        `UPDATE kyc_verifications
            SET status = 'VERIFIED', import_batch_id = $1, verified_at = now(),
                failure_reason = '', updated_at = now()
          WHERE user_id = ANY($2::text[]) AND status = 'PENDING_VERIFICATION'`,
        [String(batchId), verified],
      );
      verifiedCount = r.rowCount ?? 0;
    }

    let failedCount = 0;
    for (const v of failed) {
      const r = await client.query(
        `UPDATE kyc_verifications
            SET status = 'FAILED', import_batch_id = $1, verified_at = now(),
                failure_reason = $3, updated_at = now()
          WHERE user_id = $2 AND status = 'PENDING_VERIFICATION'`,
        // Verbatim from the verifier, so support can tell a player why rather
        // than guessing.
        [String(batchId), String(v.userId), String(v.reason ?? '')],
      );
      failedCount += r.rowCount ?? 0;
    }

    const skipped = verdicts.length - verifiedCount - failedCount;
    await client.query(
      `INSERT INTO kyc_batches (batch_id, kind, actor_id, row_count,
                                verified_count, failed_count, skipped_count, note)
       VALUES ($1,'IMPORT',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (batch_id) DO UPDATE SET
         row_count = EXCLUDED.row_count, verified_count = EXCLUDED.verified_count,
         failed_count = EXCLUDED.failed_count, skipped_count = EXCLUDED.skipped_count`,
      [String(batchId), String(actorId ?? 'system'), verdicts.length,
       verifiedCount, failedCount, Math.max(0, skipped), note],
    );
    return { verifiedCount, failedCount, skipped: Math.max(0, skipped) };
  });
}

/** The batch record — who disclosed what, and when. */
export async function getBatch(batchId) {
  const { rows } = await pgQuery(
    `SELECT batch_id, kind, actor_id, row_count, verified_count, failed_count,
            skipped_count, note, created_at
       FROM kyc_batches WHERE batch_id = $1`,
    [String(batchId)], 'kyc_batch_get',
  );
  const r = rows[0];
  return r ? {
    batchId: r.batch_id, kind: r.kind, actorId: r.actor_id,
    rowCount: r.row_count, verifiedCount: r.verified_count,
    failedCount: r.failed_count, skippedCount: r.skipped_count,
    note: r.note, createdAt: r.created_at,
  } : null;
}

/** How many rows sit at each status. Counted from rows, never accumulated. */
export async function verificationCounts() {
  const { rows } = await pgQuery(
    `SELECT status, count(*)::bigint AS n FROM kyc_verifications GROUP BY status`,
    [], 'kyc_counts',
  );
  const out = { PENDING_VERIFICATION: 0, VERIFIED: 0, FAILED: 0 };
  for (const r of rows) out[r.status] = toInt(r.n);
  return out;
}

/** Reclaim expired revocations. Space only — `isTokenRevoked` decides validity. */
export async function sweepExpired() {
  const { rowCount } = await pgQuery(
    `DELETE FROM token_blacklist WHERE expires_at <= now()`, [], 'token_sweep');
  return { revokedTokens: rowCount ?? 0 };
}

export async function withIdentityTransaction(fn) {
  const pool = await getPool();
  const client = await connectGuarded(pool);
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
