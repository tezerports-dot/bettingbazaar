// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/identity/kycBulk.service.js — bulk Aadhaar verification.
 *
 * The operator exports pending rows (Aadhaar + the Telegram-verified phone) to
 * an outside verifier, who confirms the two belong together and returns YES or
 * NO per row. Only YES activates betting and payouts.
 *
 * ── This is the most sensitive code path on the platform ────────────────────
 * An export is the one moment national identity numbers leave the database in
 * clear. Gambling regulators and ISO 27001 A.5.34 expect three things of it,
 * and all three are implemented here rather than left to operator discipline:
 *
 *   1. Sensitive PII segregated from operational data. Aadhaar lives in its own
 *      collection, as ciphertext, `select: false` — reaching it takes the
 *      deliberate `.select('+aadhaarEncrypted')` that appears in exactly one
 *      function below.
 *   2. Raw KYC reachable only by MFA'd staff. The route enforces isAdmin, and
 *      admin 2FA is mandatory platform-wide, so an export cannot be pulled by a
 *      sub-admin or a session that never presented a second factor.
 *   3. An immutable audit record of every decision — who, what, when, why. Both
 *      halves write a KycBatch row, and rows carry the batch that exported and
 *      the batch that decided them, so a disputed verdict traces to a file and
 *      a person.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * Nothing writes a CSV to disk. The export streams to the requesting admin and
 * exists nowhere else on the server — a file in /tmp would outlive the request,
 * survive into a backup, and answer to no access control.
 */
import crypto from 'crypto';
import { KycVerification, KycBatch } from './kycVerification.model.js';
import { decryptField } from './fieldCrypto.util.js';

/** Excel and most verifier tooling expect CRLF; a bare \n silently mangles rows. */
const CRLF = '\r\n';

/**
 * A CSV cell that cannot be turned into a spreadsheet formula.
 *
 * A value beginning =, +, -, or @ is executed by Excel and Sheets when the file
 * is opened. The verifier opens these files by definition, so a field that ever
 * carries user input is prefixed — Aadhaar and phone are digits today, but the
 * escape belongs at the boundary rather than depending on that staying true.
 */
function csvCell(value) {
  const s = String(value ?? '');
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Build the verification export.
 *
 * @param {object} args
 * @param {string} args.actorId  the admin — recorded, not optional
 * @param {number} [args.limit]  bound one file to something a verifier can handle
 * @returns {Promise<{batchId: string, csv: string, rowCount: number}>}
 */
export async function buildExport({ actorId, limit = 10_000 }) {
  if (!actorId) throw Object.assign(new Error('An acting admin is required'), { status: 400 });

  const batchId = `kycexp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  // Oldest first, so nobody waits behind a later signup.
  const rows = await KycVerification.find({ status: 'PENDING_VERIFICATION' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('+aadhaarEncrypted')
    .lean();

  const lines = ['reference,aadhaar_number,mobile_number,verified_yes_no,remarks'];
  const exported = [];

  for (const row of rows) {
    let aadhaar;
    try {
      aadhaar = decryptField(row.aadhaarEncrypted);
    } catch (err) {
      // A row that cannot be decrypted is skipped, never exported blank: a blank
      // Aadhaar would come back NO and permanently fail an innocent player.
      console.error(`[kyc] row ${row._id} could not be decrypted — excluded from ${batchId}: ${err.message}`);
      continue;
    }
    // `reference` is the row id, and it is what the import matches on. The
    // verifier never needs to know which player this is.
    lines.push([
      csvCell(String(row._id)),
      csvCell(aadhaar),
      csvCell(row.phone),
      '',
      '',
    ].join(','));
    exported.push(row._id);
  }

  // Mark what went out BEFORE handing over the file. If the download fails the
  // rows are still attributable to a batch that exists; the reverse — a file in
  // someone's hands that the platform has no record of — is the bad direction.
  if (exported.length) {
    await KycVerification.updateMany(
      { _id: { $in: exported } },
      { $set: { exportBatchId: batchId, exportedAt: new Date(), updatedAt: new Date() } },
    );
  }

  await KycBatch.create({
    batchId, kind: 'EXPORT', actorId, rowCount: exported.length,
    note: `Exported ${exported.length} pending verification(s)`,
  });

  return { batchId, csv: lines.join(CRLF) + CRLF, rowCount: exported.length };
}

/** Accepts the verifier's spelling of yes/no without guessing at anything else. */
function parseVerdict(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  if (['YES', 'Y', 'TRUE', '1', 'VERIFIED', 'PASS'].includes(v)) return 'VERIFIED';
  if (['NO', 'N', 'FALSE', '0', 'FAILED', 'FAIL', 'REJECT', 'REJECTED'].includes(v)) return 'FAILED';
  return null;   // blank or unrecognised — left pending, never guessed
}

/** Minimal RFC4180 line splitter: handles quoted fields containing commas. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Apply a completed verification file.
 *
 * @param {object} args
 * @param {string} args.csv      the verifier's returned file
 * @param {string} args.actorId  the admin applying it
 * @returns {Promise<{batchId, verified, failed, skipped, errors: string[]}>}
 */
export async function applyImport({ csv, actorId }) {
  if (!actorId) throw Object.assign(new Error('An acting admin is required'), { status: 400 });
  if (!csv || typeof csv !== 'string') {
    throw Object.assign(new Error('A CSV body is required'), { status: 400 });
  }

  const batchId = `kycimp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw Object.assign(new Error('The file is empty'), { status: 400 });

  // Tolerate a header or its absence — a verifier may return either.
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = header.includes('reference') || header.includes('aadhaar_number');
  const body = hasHeader ? lines.slice(1) : lines;

  const idx = {
    reference: hasHeader ? header.indexOf('reference') : 0,
    verdict:   hasHeader ? header.findIndex((h) => h.includes('verified') || h.includes('status')) : 3,
    remarks:   hasHeader ? header.findIndex((h) => h.includes('remark') || h.includes('reason')) : 4,
  };

  let verified = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];

  for (const [n, line] of body.entries()) {
    const cells = splitCsvLine(line);
    const reference = cells[idx.reference];
    const verdict = parseVerdict(cells[idx.verdict]);
    const remarks = idx.remarks >= 0 ? (cells[idx.remarks] || '') : '';

    if (!reference) { skipped += 1; continue; }
    if (!verdict) {
      // Unrecognised verdicts are left PENDING and REPORTED. Defaulting either
      // way would be worse: defaulting to VERIFIED activates payouts on an
      // unchecked identity, defaulting to FAILED voids an innocent player's
      // referral commissions upstream.
      skipped += 1;
      errors.push(`row ${n + 1}: unrecognised verdict "${cells[idx.verdict] ?? ''}"`);
      continue;
    }

    // Only rows that are still awaiting a decision are moved. Re-importing the
    // same file is therefore a no-op rather than a way to flip a settled
    // verdict, and a late duplicate cannot overturn a decision quietly.
    const res = await KycVerification.updateOne(
      { _id: reference, status: 'PENDING_VERIFICATION' },
      {
        $set: {
          status: verdict,
          importBatchId: batchId,
          verifiedAt: new Date(),
          failureReason: verdict === 'FAILED' ? (remarks || 'Verification failed') : '',
          updatedAt: new Date(),
        },
      },
    ).catch((err) => { errors.push(`row ${n + 1}: ${err.message}`); return { modifiedCount: 0 }; });

    if (res.modifiedCount) {
      if (verdict === 'VERIFIED') verified += 1; else failed += 1;
    } else {
      skipped += 1;
    }
  }

  // Mirror the verdicts onto the User documents the rest of the platform reads.
  if (verified || failed) errors.push(...await syncDecidedUsers(batchId));

  await KycBatch.create({
    batchId, kind: 'IMPORT', actorId,
    rowCount: body.length, verifiedCount: verified, failedCount: failed, skippedCount: skipped,
    note: errors.length ? `${errors.length} row(s) needed attention` : 'Clean import',
  });

  return { batchId, verified, failed, skipped, errors: errors.slice(0, 50) };
}

/**
 * Mirror a batch's verdicts onto the User documents, and keep the programme's
 * verified-member counter honest.
 *
 * ── Why this goes through decideKyc rather than an updateMany ────────────────
 * `kycStatus` has a state machine (domains/user/kycDecision.service.js): legal
 * transitions only, the rejection reason written in the SAME update as the
 * status, the reviewer recorded, and the Postgres/Mongo authority resolved in
 * one place. A bulk `updateMany` here would be a second way to decide KYC that
 * honours none of that — the exact duplicate-decision-path shape this codebase
 * has been paying for elsewhere. A batch is not a reason to skip the rules; it
 * is a reason to apply them ten thousand times.
 *
 * A FAILED verdict is mirrored too. Without it a player whose Aadhaar did not
 * check out keeps `kycStatus: PENDING_APPROVAL` forever: never allowed to
 * withdraw, never told why, and invisible in the pending queue because the
 * KycVerification row says the batch already dealt with them.
 *
 * @returns {Promise<string[]>} per-user problems, folded into the batch report
 */
async function syncDecidedUsers(batchId) {
  const { decideKyc, KYC_STATES } = await import('../user/kycDecision.service.js');
  const { ReferralProgramme } = await import('../referral/referral.model.js');

  const decided = await KycVerification.find({ importBatchId: batchId, status: { $in: ['VERIFIED', 'FAILED'] } })
    .select('userId status failureReason').lean();
  if (!decided.length) return [];

  const problems = [];
  let approved = 0;

  for (const row of decided) {
    const to = row.status === 'VERIFIED' ? KYC_STATES.APPROVED : KYC_STATES.REJECTED;
    try {
      const out = await decideKyc(row.userId, to, {
        actor: null,   // a batch has no individual reviewer; the KycBatch names the admin
        reason: to === KYC_STATES.REJECTED
          ? (row.failureReason || 'Identity verification failed')
          : null,
      });
      // `idempotent` is a re-import landing on a settled user, which is fine.
      // A genuine refusal means the user was not where the batch assumed, and
      // that is worth surfacing rather than silently dropping.
      if (!out.ok) problems.push(`user ${row.userId}: ${out.reason} (is ${out.status})`);
      else if (to === KYC_STATES.APPROVED && !out.idempotent) approved += 1;
    } catch (err) {
      problems.push(`user ${row.userId}: ${err.message}`);
    }
  }

  // The 8-crore cap counts VERIFIED members, so it moves here and only here —
  // and counts only the users this batch actually moved, so a re-import does
  // not inflate it.
  if (approved) {
    await ReferralProgramme.updateOne(
      { key: 'main' },
      { $inc: { verifiedMembers: approved }, $set: { updatedAt: new Date() } },
      { upsert: true },
    );
  }

  return problems;
}

/** Counts for the admin dashboard. */
export async function kycStats() {
  const [byStatus, batches] = await Promise.all([
    KycVerification.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    KycBatch.find({}).sort({ createdAt: -1 }).limit(20).populate('actorId', 'username').lean(),
  ]);
  const counts = Object.fromEntries(byStatus.map((r) => [r._id, r.count]));
  return {
    pending:  counts.PENDING_VERIFICATION || 0,
    verified: counts.VERIFIED || 0,
    failed:   counts.FAILED || 0,
    recentBatches: batches.map((b) => ({
      batchId: b.batchId, kind: b.kind, rowCount: b.rowCount,
      verified: b.verifiedCount, failed: b.failedCount, skipped: b.skippedCount,
      actor: b.actorId?.username || 'unknown', at: b.createdAt, note: b.note,
    })),
  };
}
