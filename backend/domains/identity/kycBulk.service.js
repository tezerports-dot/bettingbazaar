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
 *      table, as ciphertext, and the ordinary read never projects it — reaching
 *      it takes `exportPending`, the one audited function that returns it, and
 *      that function stamps the batch id in the SAME statement that selects the
 *      rows. There is no way to read the ciphertext without leaving a record.
 *   2. Raw KYC reachable only by MFA'd staff. The route enforces isAdmin, and
 *      admin 2FA is mandatory platform-wide, so an export cannot be pulled by a
 *      sub-admin or a session that never presented a second factor.
 *   3. An immutable audit record of every decision — who, what, when, why. Both
 *      halves write a batch row IN THE SAME TRANSACTION as the change, and rows
 *      carry the batch that exported and the batch that decided them, so a
 *      disputed verdict traces to a file and a person. The version this
 *      replaced wrote the batch record as a separate statement afterwards: a
 *      failure in between disclosed identity numbers with nothing recording it.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * Nothing writes a CSV to disk. The export streams to the requesting admin and
 * exists nowhere else on the server — a file in /tmp would outlive the request,
 * survive into a backup, and answer to no access control.
 */
import crypto from 'crypto';
import { db } from '#db';
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

  // The claim, the batch stamp and the batch record are ONE transaction, and
  // the rows come back already marked as disclosed. The shape this replaced
  // read the rows, built the file, and stamped them afterwards — so two exports
  // running at once both claimed the same rows and put one Aadhaar in two
  // files, and a failure after the read handed over a file the platform had no
  // record of.
  const rows = await db.identity.exportPending({
    batchId, limit, actorId,
    note: 'Aadhaar verification export',
  });

  const lines = ['reference,aadhaar_number,mobile_number,verified_yes_no,remarks'];
  let excluded = 0;

  for (const row of rows) {
    let aadhaar;
    try {
      aadhaar = decryptField(row.aadhaarEncrypted);
    } catch (err) {
      // A row that cannot be decrypted is excluded, never exported blank: a
      // blank Aadhaar would come back NO and permanently fail an innocent
      // player. It stays claimed by this batch, so the exclusion is traceable
      // rather than silently rolling back into the next export.
      console.error(`[kyc] row ${row.userId} could not be decrypted — excluded from ${batchId}: ${err.message}`);
      excluded += 1;
      continue;
    }
    // `reference` is the USER id, and it is what the import matches on. The
    // verifier never learns anything else about the person.
    lines.push([
      csvCell(row.userId),
      csvCell(aadhaar),
      csvCell(row.phone),
      '',
      '',
    ].join(','));
  }

  if (excluded) {
    console.warn(`[kyc] ${batchId}: ${excluded} row(s) excluded as undecryptable — `
      + 'they remain claimed by this batch and need a key check, not a re-export');
  }

  return { batchId, csv: lines.join(CRLF) + CRLF, rowCount: rows.length - excluded };
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

  const verdicts = [];
  const errors = [];
  let unparseable = 0;

  for (const [n, line] of body.entries()) {
    const cells = splitCsvLine(line);
    const reference = cells[idx.reference];
    const verdict = parseVerdict(cells[idx.verdict]);
    const remarks = idx.remarks >= 0 ? (cells[idx.remarks] || '') : '';

    if (!reference) { unparseable += 1; continue; }
    if (!verdict) {
      // Unrecognised verdicts are left PENDING and REPORTED. Defaulting either
      // way would be worse: defaulting to VERIFIED activates payouts on an
      // unchecked identity, defaulting to FAILED voids an innocent player's
      // referral commissions upstream.
      unparseable += 1;
      errors.push(`row ${n + 1}: unrecognised verdict "${cells[idx.verdict] ?? ''}"`);
      continue;
    }

    verdicts.push({
      userId: reference,
      verified: verdict === 'VERIFIED',
      reason: verdict === 'FAILED' ? (remarks || 'Verification failed') : '',
    });
  }

  // ── ONE transaction for the whole file ──────────────────────────────────
  // The verdicts and the batch record commit together. The loop this replaced
  // issued an update per row and wrote the batch record afterwards, so a
  // failure partway left verdicts applied that no batch accounted for — in the
  // one place where "which file decided this, and who applied it" is the
  // question a disputed verification turns on.
  //
  // Only rows still awaiting a decision move, so re-importing the same file is
  // a no-op rather than a way to flip a settled verdict.
  const applied = await db.identity.importVerdicts({
    batchId, verdicts, actorId,
    note: errors.length ? `${errors.length} row(s) needed attention` : 'Clean import',
  });

  // Mirror the verdicts onto the accounts the rest of the platform reads.
  if (applied.verifiedCount || applied.failedCount) {
    errors.push(...await syncDecidedUsers(batchId));
  }

  return {
    batchId,
    verified: applied.verifiedCount,
    failed: applied.failedCount,
    // Rows the file itself could not express, plus rows that were already
    // decided. Counted apart in the log below, because "the verifier sent
    // garbage" and "we already handled this" are different problems that the
    // single `skipped` number could not tell apart.
    skipped: applied.skipped + unparseable,
    errors: errors.slice(0, 50),
  };
}

/**
 * Mirror a batch's verdicts onto the User documents, and keep the programme's
 * verified-member counter honest.
 *
 * ── Why this goes through decideKyc rather than a bulk update ───────────────
 * `kycStatus` has a state machine (domains/user/kycDecision.service.js): legal
 * transitions only, the rejection reason written in the SAME update as the
 * status, and the reviewer recorded — all in one place. A bulk update here
 * would be a second way to decide KYC that
 * honours none of that — the exact duplicate-decision-path shape this codebase
 * has been paying for elsewhere. A batch is not a reason to skip the rules; it
 * is a reason to apply them ten thousand times.
 *
 * A FAILED verdict is mirrored too. Without it a player whose Aadhaar did not
 * check out keeps `kycStatus: PENDING_APPROVAL` forever: never allowed to
 * withdraw, never told why, and invisible in the pending queue because the
 * verification row says the batch already dealt with them.
 *
 * @returns {Promise<string[]>} per-user problems, folded into the batch report
 */
async function syncDecidedUsers(batchId) {
  const { decideKyc, KYC_STATES } = await import('../user/kycDecision.service.js');

  const decided = await db.identity.listDecidedInBatch(batchId);
  if (!decided.length) return [];

  const problems = [];

  for (const row of decided) {
    const to = row.status === 'VERIFIED' ? KYC_STATES.APPROVED : KYC_STATES.REJECTED;
    try {
      const out = await decideKyc(row.userId, to, {
        actor: null,   // a batch has no individual reviewer; the batch row names the admin
        reason: to === KYC_STATES.REJECTED
          ? (row.failureReason || 'Identity verification failed')
          : null,
      });
      // `idempotent` is a re-import landing on a settled account, which is fine.
      // A genuine refusal means the account was not where the batch assumed,
      // and that is worth surfacing rather than silently dropping.
      if (!out.ok) {
        problems.push(`user ${row.userId}: ${out.reason} (is ${out.status})`);
        continue;
      }

      // The membership cap counts VERIFIED members, and it is counted ONE AT A
      // TIME because the cap is enforced per member: the guard is
      // `verified_members < member_cap`, so the member who would cross it is
      // refused and every member before them is not. Adding the batch total in
      // one increment sails straight past the cap, which is exactly what a cap
      // on a real-money referral programme must not do.
      if (to === KYC_STATES.APPROVED && !out.idempotent) {
        const counted = await db.referrals.countVerifiedMember('main');
        if (!counted.ok) {
          problems.push(`user ${row.userId}: verified, but the programme member cap is reached`);
        }
      }
    } catch (err) {
      problems.push(`user ${row.userId}: ${err.message}`);
    }
  }

  problems.push(...await releaseFailedSubmissions(batchId));
  return problems;
}

/**
 * Delete the submission rows of everyone this batch FAILED.
 *
 * ── The reason that is not about storage ────────────────────────────────────
 * `aadhaarHash` carries a UNIQUE index — one Aadhaar, one account. That is
 * correct while a submission is live, and actively harmful once it has failed:
 * a player who mistyped one digit has parked a stranger's Aadhaar in that
 * index, and the stranger is then refused at signup with "already registered"
 * for a number they never gave us. The typo locks out its real owner, silently,
 * forever. Releasing the row is what makes the reapply path in the bot possible
 * AND what un-breaks whoever actually holds the mistyped number.
 *
 * ── What is kept ────────────────────────────────────────────────────────────
 * The verdict, which is what anyone actually needs later: `User.kycStatus` is
 * REJECTED with the reason recorded alongside it, and the batch row
 * records how many failed and who imported the file. What goes is the identity
 * data — the hash, the ciphertext and the last four digits of a number that did
 * not check out. There is no reason to hold an Aadhaar the platform has just
 * decided it cannot verify, and every reason not to.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * Strictly AFTER the verdicts are mirrored onto the users. `syncDecidedUsers`
 * finds its work by querying these rows, so deleting them first would leave
 * every failed player stuck on PENDING_APPROVAL with nothing left to explain
 * why — the exact bug this file already carries a comment about.
 */
async function releaseFailedSubmissions(batchId) {
  try {
    // ONE statement, joined against the accounts. The version this replaced ran
    // three queries — the failed rows, the accounts that reached REJECTED, then
    // a delete — and filtered between them in JavaScript, so an account that
    // moved between the second and third had its evidence deleted on a verdict
    // that was no longer true.
    const released = await db.identity.releaseFailedBatch(batchId);
    if (released.length) {
      console.warn(`[kyc] released ${released.length} failed submission(s) from batch ${batchId} — `
        + 'the Aadhaar numbers are no longer held and are free to be used by their real owners');
    }
    return [];
  } catch (err) {
    // Never fails the import: the verdicts are already applied, and a retained
    // row is a smaller problem than an import that reports failure after doing
    // most of its work.
    return [`releasing failed submissions: ${err.message}`];
  }
}

/** Counts for the admin dashboard. */
export async function kycStats() {
  const [counts, batches, failed] = await Promise.all([
    db.identity.verificationCounts(),
    db.identity.listBatches({ limit: 20 }),
    // FAILED is counted from the ACCOUNTS, not from the verification rows. A
    // failed submission's row is DELETED so the Aadhaar it holds is released
    // (see releaseFailedSubmissions), which means counting rows here would
    // report zero failures no matter how many there were. The verdict lives on
    // the account.
    db.users.countUsers({ kycStatus: 'REJECTED' }),
  ]);

  return {
    pending:  counts.PENDING_VERIFICATION,
    verified: counts.VERIFIED,
    failed,
    recentBatches: batches,
  };
}
