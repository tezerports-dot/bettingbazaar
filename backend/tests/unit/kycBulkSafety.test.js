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
