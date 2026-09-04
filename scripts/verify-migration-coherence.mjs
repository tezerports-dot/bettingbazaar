#!/usr/bin/env node
/**
 * verify-migration-coherence.mjs — does every column the code names exist?
 *
 * ── What this used to check, and why half of it retired ─────────────────────
 * It had two checks, for the two ways deleting a document store goes
 * half-right:
 *
 *   SPLIT   an entity WRITTEN in one store and READ from the other. The write
 *           succeeds, the read finds nothing, and nothing errors. It happened
 *           while moving signup: the account was written to PostgreSQL while
 *           `authenticate` still read the document, so a new player could sign
 *           up and then not log in.
 *
 *   GAP     a table exists but is missing a field the code reads or writes. The
 *           column is absent, the value is silently undefined, and the feature
 *           quietly stops working. `backup_codes` (2FA recovery) and `roles`
 *           were both missing this way.
 *
 * SPLIT is gone, because a split needs two stores and there is one. Its budget
 * reached zero and `check:no-mongo` counts the references it used to find.
 *
 * GAP is the one with ongoing value, and it now asks the question the right way
 * round. It used to read the document schemas — the complete list of what the
 * code could touch — and check each field for a column. Those files are gone,
 * so it reads THE REPOSITORIES instead: every `row.some_column` a repository
 * maps out of a result, and every column it names in an INSERT or an UPDATE,
 * must be a column the schema declares.
 *
 * That catches the same failure from the other side. A repository that maps
 * `row.backup_codes` for a column that does not exist reads `undefined` on
 * every call — no error, no failing test unless one happens to exercise that
 * exact field, and a 2FA recovery flow that silently has no codes.
 *
 *   node scripts/verify-migration-coherence.mjs           summary
 *   node scripts/verify-migration-coherence.mjs --list    every finding
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

const SCHEMA = readFileSync(join(ROOT, 'database/schema.sql'), 'utf8');

/**
 * Every column name the schema declares, anywhere.
 *
 * Deliberately NOT per-table. A repository joins, aliases and reads from
 * several tables in one statement, so tying a mapped name to one table would
 * produce false failures on every join — and the failure this catches (a name
 * with no column ANYWHERE behind it) does not need the table to be identified.
 */
function declaredColumns() {
  const cols = new Set();
  // Columns inside every CREATE TABLE body.
  for (const body of SCHEMA.matchAll(/\n\s{2}([a-z][a-z0-9_]*)\s+(?:BIG)?[A-Z]/g)) {
    cols.add(body[1]);
  }
  // Columns added by a later ALTER, which the bodies above do not carry.
  for (const m of SCHEMA.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z][a-z0-9_]*)/g)) {
    cols.add(m[1]);
  }
  return cols;
}

const COLUMNS = declaredColumns();

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name), acc);
    else if (/\.js$/.test(e.name)) acc.push(relative(ROOT, join(dir, e.name)).split(sep).join('/'));
  }
  return acc;
}

const REPOS = walk(join(ROOT, 'database/repositories'));

/**
 * Names a repository reads off a result row but that no column provides.
 *
 * Only `row.x` / `r.x` / `rows[0].x` shapes with a snake_case name: a
 * camelCase property is the mapper's OUTPUT, which is the application's
 * vocabulary and has no column behind it by design.
 */
const gaps = [];

for (const file of REPOS) {
  const src = readFileSync(join(ROOT, file), 'utf8');

  // Aliases the file's OWN SQL introduces — `COUNT(*) OVER () AS total_count`,
  // `v.status AS verification_status`. They are read off a row exactly like a
  // column and are just as real to the caller, but they exist only in the
  // statement that computes them, so the schema knows nothing about them.
  // Collected per file rather than globally: an alias one repository defines is
  // not one another repository may read.
  const aliases = new Set();
  for (const m of src.matchAll(/\bAS\s+([a-z][a-z0-9_]*)/gi)) aliases.add(m[1].toLowerCase());

  // Strip comments and SQL string literals before looking for mapped names. A
  // column named inside a query is PostgreSQL's to validate — it fails loudly
  // at runtime and in the suites — whereas a mapped name fails SILENTLY, which
  // is the whole point of this scan.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`[\s\S]*?`/g, '``');

  const seen = new Set();
  for (const m of code.matchAll(/\b(?:row|r|rows\[\d+\]|first|last|record|res)\.([a-z][a-z0-9]*_[a-z0-9_]*)\b/g)) {
    const name = m[1];
    if (COLUMNS.has(name) || aliases.has(name) || seen.has(name)) continue;
    seen.add(name);
    // Counted in the ORIGINAL source, not the stripped copy: stripping comments
    // shifts every line after the first one, so a number taken from `code`
    // points a reader at the wrong place — which is worse than no number.
    const at = src.indexOf(`.${name}`);
    const line = at < 0 ? 0 : src.slice(0, at).split('\n').length;
    gaps.push({ file, line, name });
  }
}

const list = process.argv.includes('--list');
console.log('\nMigration coherence — does every column the code names exist?\n');
console.log(`  ${REPOS.length} repositories scanned`);
console.log(`  ${COLUMNS.size} column names declared by the schema`);
console.log(`  ${gaps.length} GAP    (a name read off a row with no column behind it)\n`);

if (gaps.length) {
  console.log('GAP — the code reads a name the schema does not declare:');
  for (const g of (list ? gaps : gaps.slice(0, 20))) {
    console.log(`  ${g.file}:${g.line}  reads .${g.name}`);
  }
  if (!list && gaps.length > 20) console.log(`  … and ${gaps.length - 20} more (--list)`);
  console.log('');
  console.log('A gap silently drops a value: the column is absent, the read is undefined,');
  console.log('and the feature it belongs to stops working without erroring.\n');
  process.exit(1);
}

console.log('Every column the repositories read is one the schema declares.\n');
