// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The bulk-KYC boundary, where national identity numbers leave the platform.
 *
 * These are source-level and behavioural checks over the parts that do not need
 * a database: CSV construction, verdict parsing, and the structural rules the
 * research on operator obligations put on this path (segregated PII, an audit
 * row per decision, nothing written to disk).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../domains/identity/kycBulk.service.js'), 'utf8');

/** Executable lines only — comments describe what the code no longer does. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

describe('the export cannot be turned into a spreadsheet attack', () => {
  it('escapes cells that would execute as formulas', () => {
    // Excel and Sheets execute a cell beginning = + - or @. The verifier opens
    // these files by definition, so every cell goes through the guard.
    expect(code).toMatch(/\^\[=\+\\?-@/);
    expect(code).toMatch(/function csvCell/);
  });

  it('routes every exported field through csvCell', () => {
    // A single unescaped interpolation would defeat the guard entirely.
    const row = code.slice(code.indexOf('lines.push(['), code.indexOf('].join(\',\')'));
    const cells = row.match(/csvCell\(/g) || [];
    expect(cells.length).toBeGreaterThanOrEqual(3);
    expect(row).not.toMatch(/\$\{(?!.*csvCell)/);
  });

  it('uses CRLF, which the tooling on the other end expects', () => {
    expect(code).toMatch(/CRLF\s*=\s*'\\r\\n'/);
  });
});

describe('the export leaves an audit trail and no artefacts', () => {
  it('records who exported what, in the same transaction as the disclosure', () => {
    // `exportPending` claims the rows, stamps them with the batch id and writes
    // the batch record in ONE transaction. The shape this replaced wrote the
    // batch record as a separate statement afterwards, so a failure in between
    // disclosed identity numbers with nothing recording it.
    expect(code).toMatch(/db\.identity\.exportPending\(\{[\s\S]*?actorId/);
    expect(code).not.toMatch(/updateMany[\s\S]*?exportBatchId/);
  });

  it('refuses to build an export without a named actor', () => {
    expect(code).toMatch(/if \(!actorId\) throw/);
  });

  it('reaches ciphertext only through the one audited function', () => {
    // The ordinary read never projects the ciphertext. `exportPending` is the
    // single function that returns it, and it stamps the batch id in the same
    // statement that selects the rows — so there is no way to read an Aadhaar
    // without leaving a record of who read it and in which file it went out.
    expect(code).toMatch(/exportPending/);
    expect(code).toMatch(/decryptField\(row\.aadhaarEncrypted\)/);
    // Nothing here reads the ciphertext by any other route.
    expect(code).not.toMatch(/getVerification[\s\S]{0,120}aadhaarEncrypted/);
  });

  it('never writes the file to disk', () => {
    // A CSV in /tmp outlives the request, reaches backups, and answers to no
    // access control. The export exists only in the response.
    expect(code).not.toMatch(/writeFile|createWriteStream|fs\.write/);
  });

  it('marks rows as exported in the statement that selects them', () => {
    // Not "before the return" — IN the same statement. Reading the rows and
    // stamping them afterwards let two exports running at once both claim the
    // same rows and put one Aadhaar in two files.
    const claimAt = code.indexOf('exportPending');
    const returnAt = code.indexOf('return { batchId, csv');
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(returnAt);
  });

  it('skips a row it cannot decrypt rather than exporting it blank', () => {
    // A blank Aadhaar comes back NO and permanently fails an innocent player.
    expect(code).toMatch(/could not be decrypted[\s\S]*?continue;/);
  });
});

describe('importing verdicts', () => {
  it('never guesses at an unrecognised verdict', () => {
    // Defaulting to VERIFIED activates payouts on an unchecked identity;
    // defaulting to FAILED voids innocent upstream commissions. Both are worse
    // than leaving the row pending and reporting it.
    expect(code).toMatch(/unrecognised verdict/);
    expect(code).toMatch(/return null;/);
  });

  it('applies the whole file in one transaction, with its audit row', () => {
    // The verdicts and the batch record commit together. The per-row loop this
    // replaced wrote the batch record afterwards, so a failure partway left
    // verdicts applied that no batch accounted for — in the one place where
    // "which file decided this, and who applied it" is the question a disputed
    // verification turns on.
    expect(code).toMatch(/db\.identity\.importVerdicts\(\{/);
    expect(code).not.toMatch(/for \([\s\S]{0,400}updateOne\([\s\S]{0,200}PENDING_VERIFICATION/);
  });

  it('counts verified members one at a time, so the cap holds', () => {
    // The membership cap is enforced PER MEMBER — the guard is
    // `verified_members < member_cap`. Adding a batch total in one increment
    // sails straight past it, which is what a cap on a real-money referral
    // programme must not do.
    expect(code).toMatch(/countVerifiedMember\('main'\)/);
    expect(code).not.toMatch(/verifiedMembers: approved|\+= approved/);
  });
});

describe('a batch decision is still a KYC decision', () => {
  it('goes through the state machine, never a bulk write on kycStatus', () => {
    // decideKyc owns the legal transitions, the reviewer, and the rejection
    // reason landing in the same update as the status. A batch is not a reason
    // to skip that — it is a reason to apply it ten thousand times. A bulk
    // update here would be a second way to decide KYC that honours none of it.
    expect(code).toMatch(/decideKyc\(row\.userId, to/);
    expect(code).not.toMatch(/updateUser\([\s\S]{0,80}kycStatus/);
    expect(code).not.toMatch(/\$set: \{ kycStatus/);
  });

  it('mirrors a FAILED verdict too, not only VERIFIED', () => {
    // Otherwise a player whose Aadhaar did not check out keeps
    // PENDING_APPROVAL forever: never able to withdraw, never told why, and
    // absent from the pending queue because their row says the batch handled
    // them.
    // `listDecidedInBatch` returns BOTH verdicts — the repository's query is
    // `status IN ('VERIFIED', 'FAILED')` — and both are mirrored here.
    expect(code).toMatch(/listDecidedInBatch\(batchId\)/);
    expect(code).toMatch(/KYC_STATES\.APPROVED : KYC_STATES\.REJECTED/);
  });

  it('carries the verifier’s reason through to the rejection', () => {
    // decideKyc REFUSES a rejection with no reason, so an empty failureReason
    // would throw the row away rather than reject the user.
    expect(code).toMatch(/row\.failureReason \|\| 'Identity verification failed'/);
  });

  it('reports a user the batch could not move instead of dropping it', () => {
    expect(code).toMatch(/if \(!out\.ok\) \{[\s\S]{0,120}problems\.push/);
  });

  it('counts only the users this batch actually approved', () => {
    // `idempotent` is a re-import landing on a settled account. Counting it
    // would let a re-import inflate the cap.
    expect(code).toMatch(/!out\.idempotent/);
  });
});
