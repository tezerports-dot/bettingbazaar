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
 * ── And the schema's own second owners ─────────────────────────────────────
 * `CREATE OR REPLACE FUNCTION f()` written twice in one file is not two rules —
 * it is one rule, the last one, and everything the earlier copies say is text.
 * `bb_forbid_order_mode_change()` was written THREE times: once for the rail,
 * once for the USDT chain, once for the frozen quote. Each later copy restated
 * the earlier branches, so it looked correct at every point in the file, and
 * editing the first block changed nothing at all. The mutation that deletes the
 * rail check from block one was reported as SURVIVED for exactly that reason —
 * the third block put it straight back.
 *
 * Same shape for a trigger: `CREATE OR REPLACE TRIGGER t ON tbl` twice is one
 * trigger, whichever body ran last.
 *
 * This is derive-don't-duplicate applied to SQL, and it is mechanical: the
 * names are read out of the schema itself, so nothing here holds its own copy
 * of what the schema defines.
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

/**
 * Objects the schema defines more than once.
 *
 * Only the LAST definition exists once the file has been applied, so every
 * earlier one is a comment that reads like code. Counted by NAME, from the
 * schema's own text — a duplicate is a name that appears in two `CREATE OR
 * REPLACE` statements of the same kind.
 *
 * `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE … ADD COLUMN IF NOT EXISTS` are
 * deliberately not in scope: those are idempotent by design and repeat all over
 * this file on purpose.
 */
function redefinitions() {
  const found = new Map();
  const patterns = [
    ['function', /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi],
    ['trigger',  /CREATE\s+OR\s+REPLACE\s+TRIGGER\s+([a-z_][a-z0-9_]*)\s/gi],
    ['view',     /CREATE\s+OR\s+REPLACE\s+VIEW\s+([a-z_][a-z0-9_]*)\s/gi],
  ];
  for (const [kind, re] of patterns) {
    for (const m of SCHEMA.matchAll(re)) {
      const key = `${kind} ${m[1]}`;
      const line = SCHEMA.slice(0, m.index).split('\n').length;
      found.set(key, [...(found.get(key) ?? []), line]);
    }
  }
  return [...found.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([name, lines]) => ({ name, lines }));
}

/**
 * Columns an INSERT names that the table does not have.
 *
 * ── Why this is a separate check from the read gap above ────────────────────
 * That one scans for `row.some_column` — names the code READS off a result. It
 * says so itself, and it is per-NAME rather than per-table because a join makes
 * the table ambiguous.
 *
 * An INSERT is the opposite case and the table is not ambiguous at all: the
 * statement names it. And the failure mode is far louder — PostgreSQL refuses
 * the whole statement, so the feature does not degrade, it throws.
 *
 * This was not checked, and the cost was measured rather than imagined:
 * `createMerchantAccount` inserted `email` into `users` after `users.email` was
 * removed with the player email (CLAUDE.md §2). Every merchant signup threw
 * `column "email" of relation "users" does not exist`, was caught by the
 * handler, and answered "Signup failed. Please try again." **No merchant could
 * ever self-register**, on a check that reported the schema coherent, because
 * nothing read `row.email` anywhere.
 *
 * Only literal column lists are examined — `INSERT INTO t (a, b, c)`. A
 * dynamically built list is skipped rather than guessed at, and the skip is
 * reported so the number is not mistaken for full coverage.
 */
function insertGaps() {
  const out = [];
  let skipped = 0;
  for (const file of REPOS) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const lines = src.split('\n');
    for (const m of src.matchAll(/INSERT\s+INTO\s+([a-z][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
      const table = m[1].toLowerCase();
      const cols = m[2].split(',').map((c) => c.trim().toLowerCase());
      // A list built at runtime, or one carrying an expression, is not a
      // literal column list. Say so rather than inventing a verdict for it.
      if (cols.some((c) => !/^[a-z][a-z0-9_]*$/.test(c))) { skipped += 1; continue; }
      const line = src.slice(0, m.index).split('\n').length;
      for (const col of cols) {
        if (tableColumns(table)?.has(col)) continue;
        if (!tableColumns(table)) { skipped += 1; break; }   // table not in schema.sql
        out.push({ file, line, table, col });
      }
    }
  }
  return { gaps: out, skipped };
}

/**
 * The columns of ONE table — which the read check deliberately does not need,
 * and this one does, because an INSERT names its table unambiguously.
 */
const TABLE_COLUMNS = (() => {
  const byTable = new Map();
  for (const m of SCHEMA.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/g)) {
    const cols = new Set();
    for (const c of m[2].matchAll(/\n\s{2}([a-z][a-z0-9_]*)\s+(?:BIG)?[A-Z]/g)) cols.add(c[1]);
    // A table written more than once in the file (CREATE + later ALTERs) keeps
    // the union, not the last — an ALTER adds, it does not replace.
    const prev = byTable.get(m[1]) ?? new Set();
    byTable.set(m[1], new Set([...prev, ...cols]));
  }
  for (const m of SCHEMA.matchAll(/ALTER TABLE\s+([a-z][a-z0-9_]*)[\s\S]{0,200}?ADD COLUMN IF NOT EXISTS ([a-z][a-z0-9_]*)/g)) {
    const set = byTable.get(m[1]) ?? new Set();
    set.add(m[2]);
    byTable.set(m[1], set);
  }
  return byTable;
})();
const tableColumns = (t) => TABLE_COLUMNS.get(t);

const dupes = redefinitions();

const inserts = insertGaps();
const list = process.argv.includes('--list');
console.log('\nMigration coherence — does every column the code names exist?\n');
console.log(`  ${REPOS.length} repositories scanned`);
console.log(`  ${COLUMNS.size} column names declared by the schema`);
console.log(`  ${gaps.length} GAP    (a name read off a row with no column behind it)`);
console.log(`  ${dupes.length} DOUBLE (a schema object defined more than once)`);
console.log(`  ${inserts.gaps.length} INSERT (a column an INSERT names that its table does not have)`);
console.log(`  ${inserts.skipped} insert lists skipped (built at runtime, or a table this file does not declare)\n`);

if (dupes.length) {
  console.log('DOUBLE — the schema defines this object more than once:');
  for (const d of dupes) console.log(`  ${d.name}  at lines ${d.lines.join(', ')}`);
  console.log('');
  console.log('Only the LAST definition survives. Every earlier one is text that reads');
  console.log('like code: edit it and nothing changes, and a check aimed at it measures');
  console.log('nothing. Collapse them into one definition.\n');
  process.exit(1);
}

if (inserts.gaps.length) {
  console.log('INSERT — the statement names a column the table does not have:');
  for (const g of inserts.gaps) console.log(`  ${g.file}:${g.line}  INSERT INTO ${g.table} (… ${g.col} …)`);
  console.log('');
  console.log('PostgreSQL refuses the whole statement, so this does not degrade — it');
  console.log('throws, and whatever the handler answers is what the user is told. The');
  console.log('merchant signup answered "Signup failed. Please try again." to every');
  console.log('applicant, forever, on a green check.\n');
  process.exit(1);
}

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
