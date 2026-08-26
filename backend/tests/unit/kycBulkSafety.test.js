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
    const row = code.slice(code.indexOf('lines.push(['), code.indexOf('exported.push'));
    const cells = row.match(/csvCell\(/g) || [];
    expect(cells.length).toBeGreaterThanOrEqual(3);
    expect(row).not.toMatch(/\$\{(?!.*csvCell)/);
  });

  it('uses CRLF, which the tooling on the other end expects', () => {
    expect(code).toMatch(/CRLF\s*=\s*'\\r\\n'/);
  });
});

describe('the export leaves an audit trail and no artefacts', () => {
  it('records who exported what, as a KycBatch row', () => {
    expect(code).toMatch(/KycBatch\.create\(\{[\s\S]*?kind: 'EXPORT'[\s\S]*?actorId/);
  });

  it('refuses to build an export without a named actor', () => {
    expect(code).toMatch(/if \(!actorId\) throw/);
  });

  it('reaches ciphertext through a deliberate select, not by default', () => {
    // `select: false` on the model means an ordinary query cannot return it.
    expect(code).toMatch(/\.select\('\+aadhaarEncrypted'\)/);
  });

  it('never writes the file to disk', () => {
    // A CSV in /tmp outlives the request, reaches backups, and answers to no
    // access control. The export exists only in the response.
    expect(code).not.toMatch(/writeFile|createWriteStream|fs\.write/);
  });

  it('marks rows as exported before handing the file over', () => {
    const updateAt = code.indexOf('exportBatchId: batchId');
    const returnAt = code.indexOf('return { batchId, csv');
    expect(updateAt).toBeGreaterThan(-1);
    expect(updateAt).toBeLessThan(returnAt);
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

  it('only moves rows still awaiting a decision', () => {
    // Re-importing the same file is then a no-op, and a late duplicate cannot
    // quietly overturn a settled verdict.
    expect(code).toMatch(/_id: reference, status: 'PENDING_VERIFICATION'/);
  });

  it('records the import as its own audit row', () => {
    expect(code).toMatch(/KycBatch\.create\(\{[\s\S]*?kind: 'IMPORT'/);
  });

  it('counts verified members only where the verdict is applied', () => {
    // The 8-crore cap must move in exactly one place or it drifts.
    const occurrences = code.match(/verifiedMembers/g) || [];
    expect(occurrences.length).toBe(1);
  });
});

describe('a batch decision is still a KYC decision', () => {
  it('goes through the state machine, never a bulk write on kycStatus', () => {
    // decideKyc owns legal transitions, the rejection reason landing in the same
    // update as the status, and the Mongo/Postgres authority resolution. A batch
    // is not a reason to skip that — it is a reason to apply it ten thousand
    // times. A raw updateMany here would be a second way to decide KYC that
    // honours none of it.
    expect(code).toMatch(/decideKyc\(row\.userId, to/);
    expect(code).not.toMatch(/User\.updateMany[\s\S]*?kycStatus/);
    expect(code).not.toMatch(/\$set: \{ kycStatus/);
  });

  it('mirrors a FAILED verdict too, not only VERIFIED', () => {
    // Otherwise a player whose Aadhaar did not check out keeps
    // PENDING_APPROVAL forever: never able to withdraw, never told why, and
    // absent from the pending queue because their row says the batch handled
    // them.
    expect(code).toMatch(/status: \{ \$in: \['VERIFIED', 'FAILED'\] \}/);
    expect(code).toMatch(/KYC_STATES\.APPROVED : KYC_STATES\.REJECTED/);
  });

  it('carries the verifier’s reason through to the rejection', () => {
    // decideKyc REFUSES a rejection with no reason, so an empty failureReason
    // would throw the row away rather than reject the user.
    expect(code).toMatch(/row\.failureReason \|\| 'Identity verification failed'/);
  });

  it('reports a user the batch could not move instead of dropping it', () => {
    expect(code).toMatch(/if \(!out\.ok\) problems\.push/);
  });

  it('counts only the users this batch actually approved', () => {
    // Counting rows instead would let a re-import inflate the cap.
    expect(code).toMatch(/!out\.idempotent\) approved \+= 1/);
    expect(code).toMatch(/\$inc: \{ verifiedMembers: approved \}/);
  });
});
