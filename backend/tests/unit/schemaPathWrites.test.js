// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * An update to a path the schema does not declare is silently discarded.
 *
 * ── The bug class ───────────────────────────────────────────────────────────
 * Mongoose runs in strict mode. In strict mode an update operator naming a path
 * that is not in the schema has that path STRIPPED before the query is sent —
 * no error, no warning. `updateOne` then reports `acknowledged: true` and
 * `modifiedCount: 0`, which almost nobody checks, and the write simply never
 * happened.
 *
 * This has bitten this codebase five separate times, and every one of them was
 * invisible until something downstream made no sense:
 *
 *   - `kycData.reviewedBy` was written by two services and declared by neither,
 *     so every KYC approval was anonymous — the exact thing that audit field
 *     existed to prevent.
 *   - `isAccountLocked` was read by four gates and declared nowhere, so all four
 *     compared against `undefined` and let everyone through.
 *   - `userKycSnapshot.aadhaar` was written on withdrawal orders and was not a
 *     path on the model.
 *   - `referralClicks` would have been the fifth, caught while writing the
 *     referral redirect.
 *
 * ── Why a test and not a code review ────────────────────────────────────────
 * Because reading cannot catch it. The write looks correct at the call site, the
 * field name is spelled the way the author intended, and the schema is in
 * another file that nobody opens during the change. The only reliable detector
 * is a machine comparing the two.
 *
 * ── What this does ──────────────────────────────────────────────────────────
 * Loads every registered model, then reads the source of every route, service
 * and middleware looking for `Model.updateOne/updateMany/findOneAndUpdate/
 * findByIdAndUpdate` calls whose receiver is a model name it knows. Every field
 * named inside `$set`, `$inc`, `$unset`, `$push` and `$addToSet` must exist on
 * that model's schema.
 *
 * It is deliberately conservative: it only inspects calls whose receiver
 * literally matches a registered model name, and only object literals it can
 * read statically. A dynamic update it cannot parse is skipped rather than
 * guessed at, because a false alarm here would train people to ignore it.
 */
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import '../../models/index.js';

const backend = join(dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'tests') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Load every model file, so `mongoose.models` is complete.
 *
 * `models/index.js` covers most of them, but the domain-local models
 * (TelegramBot, ReferralClick, KycVerification …) are only registered when
 * their own module is imported. A model this test cannot see is a model it
 * cannot check, so the coverage assertion below guards against that silently
 * shrinking.
 */
const modelFiles = walk(backend).filter((p) => p.endsWith('.model.js'));
await Promise.all(modelFiles.map((f) => import(f).catch(() => {})));

const declared = new Map(
  Object.entries(mongoose.models).map(([name, m]) => [name, new Set(Object.keys(m.schema.paths))]),
);

/** Update operators whose keys are field paths on the target model. */
const FIELD_OPERATORS = ['\\$set', '\\$setOnInsert', '\\$inc', '\\$unset', '\\$push', '\\$addToSet'];

/** Remove line and block comments, so a comment is never read as a field name. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Read the argument text of a call, by matching brackets from the open paren. */
function callArgs(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    i += 1;
  }
  return src.slice(from, i);
}

function scan() {
  const sources = walk(backend).filter((p) => /\/(domains|routes|services|middleware|jobs|scripts)\//.test(p));
  const findings = [];
  let calls = 0;

  const callPattern = /(\w+)\s*\.\s*(?:updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate)\s*\(/g;

  for (const file of sources) {
    const src = readFileSync(file, 'utf8');
    let match;
    while ((match = callPattern.exec(src)) !== null) {
      const modelName = match[1];
      const paths = declared.get(modelName);
      if (!paths) continue;   // not a model we know — skip rather than guess
      calls += 1;

      // Comments are stripped before parsing. An update object often carries a
      // trailing `// why` beside a field, and reading that as a key produced a
      // finding named after the sentence — noise that trains people to ignore
      // this test, which is worse than not having it.
      const args = stripComments(callArgs(src, match.index + match[0].length));

      for (const op of FIELD_OPERATORS) {
        // Only object literals with no nested braces are read; a nested update
        // is skipped rather than mis-parsed.
        const opPattern = new RegExp(`${op}\\s*:\\s*\\{([^{}]*)\\}`, 'g');
        let block;
        while ((block = opPattern.exec(args)) !== null) {
          for (const pair of block[1].split(',')) {
            const key = pair.split(':')[0].trim().replace(/['"`]/g, '');
            // Spreads, computed keys and blank entries carry no static name.
            if (!key || key.startsWith('...') || key.startsWith('[') || key.includes('(')) continue;
            // A dotted path is satisfied by its root being declared — that is
            // how Mongoose resolves nested and subdocument writes.
            if (paths.has(key) || paths.has(key.split('.')[0])) continue;
            findings.push(`${modelName}.${key}  —  ${file.replace(backend, 'backend')}`);
          }
        }
      }
    }
  }
  return { findings, calls };
}

describe('no update writes to a path its schema does not declare', () => {
  const { findings, calls } = scan();

  it('finds nothing', () => {
    expect(findings, `Mongoose strict mode silently DISCARDS these writes:\n  ${findings.join('\n  ')}\n`)
      .toEqual([]);
  });

  it('actually inspected a meaningful number of update calls', () => {
    // Without this, a refactor that renamed the update helpers would turn the
    // assertion above into "nothing was checked, so nothing was wrong".
    expect(calls, 'the scanner matched almost no update calls — has the pattern rotted?')
      .toBeGreaterThan(20);
  });

  it('loaded the domain-local models, not just the shared index', () => {
    // The models most likely to grow a new field are the newest ones, and they
    // live outside models/index.js. If these stop being registered, the scan
    // silently stops covering them.
    for (const name of ['TelegramBot', 'TelegramIdentity', 'ReferralClick', 'ReferralEarning', 'KycVerification', 'User']) {
      expect(declared.has(name), `${name} must be registered for this scan to cover it`).toBe(true);
    }
  });
});

describe('the scanner can actually fail', () => {
  // A detector that cannot report a problem is decoration. This proves the
  // matching logic finds an undeclared field in text of the shape it scans.
  it('flags a $set to a field that is not on the schema', () => {
    const paths = declared.get('User');
    expect(paths.has('depositBalance'), 'a real path must be recognised').toBe(true);
    expect(paths.has('thisFieldDoesNotExist'), 'an invented path must not be').toBe(false);
  });

  it('reads a field name out of an update call the way the scan does', () => {
    const sample = `User.updateOne({ _id: id }, { $set: { madeUpField: 1 } });`;
    const m = /(\w+)\s*\.\s*(?:updateOne)\s*\(/.exec(sample);
    const args = callArgs(sample, m.index + m[0].length);
    const block = /\$set\s*:\s*\{([^{}]*)\}/.exec(args);
    const key = block[1].split(':')[0].trim();
    expect(key).toBe('madeUpField');
    expect(declared.get('User').has(key)).toBe(false);
  });
});
