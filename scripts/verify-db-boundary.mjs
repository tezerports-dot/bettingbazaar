#!/usr/bin/env node
/**
 * verify-db-boundary.mjs — nothing outside `database/` touches the database.
 *
 * The point of a single data-layer folder is not tidiness. It is that when the
 * schema, the storage engine or a repository's internals change, the change
 * STOPS at `database/index.js` and every caller keeps working. A folder nothing
 * enforces is a folder that leaks: one route writes its own SQL, then five do,
 * and the boundary exists only in the README.
 *
 * Three rules, checked mechanically:
 *
 *   1. NO SQL OUTSIDE database/. A file outside the folder that writes SELECT,
 *      INSERT, UPDATE, DELETE or CREATE TABLE against the database has reached
 *      past the API.
 *   2. NO DRIVER OUTSIDE database/. Importing `pg` elsewhere means opening a
 *      second connection pool the data layer does not know about.
 *   3. IMPORT THROUGH THE FRONT DOOR. Application code imports `#db` or
 *      `#db/...`, never a relative path that happens to reach the folder — a
 *      relative path breaks when either end moves, and it is how a caller ends
 *      up depending on a file's location rather than on its API.
 *
 *   node scripts/verify-db-boundary.mjs           summary
 *   node scripts/verify-db-boundary.mjs --list    every finding
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'database']);
const LIST = process.argv.includes('--list');

/**
 * Files exempt from rule 1, each for a stated reason. An exemption is a
 * decision someone can argue with, not a hole — so it names the file and why.
 */
const SQL_EXEMPT = new Map([
  ['scripts/verify-db-boundary.mjs', 'this file: it names the patterns it forbids'],
  // These two READ SQL as text — they never execute it. The mutation harness
  // edits a repository's query to prove a test catches the change; the
  // coherence check parses schema.sql to find a field with no column. Both are
  // enforcement tooling for the boundary, not code that crosses it.
  ['scripts/mutation-check.mjs', 'quotes repository SQL as mutation text; executes none of it'],
  ['scripts/verify-migration-coherence.mjs', 'parses schema.sql as text to find missing columns'],
  ['scripts/verify-payment-references.mjs', 'names the write patterns it forbids: it refuses a SECOND payment-reference registry, and cannot look for one without saying what a write to one looks like'],
]);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(dir, e.name), acc); }
    else if (/\.(js|mjs|cjs|ts)$/.test(e.name)) {
      acc.push(relative(ROOT, join(dir, e.name)).split(sep).join('/'));
    }
  }
  return acc;
}

const FILES = [
  ...walk(join(ROOT, 'backend')),
  ...walk(join(ROOT, 'scripts')),
];

/*
 * A statement, not the word: "select a merchant" in prose is not SQL.
 *
 * ── The trailing \b was measuring a fraction ────────────────────────────────
 * This pattern ended `...|ALTER\s+TABLE)\b`, and that boundary applies to the
 * WHOLE alternation — including `SELECT\s+[\w*(]`, whose last matched
 * character is a word character. `SELECT COUNT(*)` matches through the `C` and
 * then needs a boundary between `C` and `O`, which does not exist. So the most
 * ordinary SELECT in the codebase was invisible, along with `SELECT *`.
 *
 * It caught `SELECT 1` and `SELECT b.id` — a single-character token followed by
 * punctuation — which is why it never looked broken. §24.6's shape exactly: a
 * check measuring almost nothing reads the same as a check passing.
 *
 * The boundary now sits on each alternative that needs one, and not on the
 * SELECT branch, whose character class already did that job.
 */
const RE_SQL = /\b(SELECT\s+[\w*(]|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(TABLE|INDEX)\b|ALTER\s+TABLE\b)/i;

/**
 * A test may speak SQL. The boundary protects what SHIPS.
 *
 * `#db` exists so a route cannot reach past the repositories — one place owns
 * each table, and a query nobody can find is a query nobody can fix. A test
 * that verifies a TRIGGER has the opposite need: the thing under test IS SQL,
 * and it has to attempt the forbidden UPDATE to prove the database refuses it.
 * Routing that through a repository would test the repository's restraint
 * rather than the database's guard, which is the weaker of the two.
 *
 * So tests are counted and REPORTED rather than failed — visible, arguable,
 * and not a silent hole. Correcting the regex above is what made them visible
 * at all: eight statements in the route suites had never been counted.
 */
const isTest = (f) => /(^|\/)tests?\//.test(f) || /\.(test|spec)\.[jt]s$/.test(f);
const RE_DRIVER = /from\s+'pg(-pool|-format)?'|require\(\s*'pg(-pool|-format)?'\s*\)/;
const RE_RELATIVE_DB = /from\s+'(?:\.\.\/)+database\//;

const findings = { sql: [], testSql: [], driver: [], relative: [] };

for (const file of FILES) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    // Comments are prose. A comment explaining a query is not a query.
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    if (!SQL_EXEMPT.has(file) && RE_SQL.test(code)) {
      (isTest(file) ? findings.testSql : findings.sql).push(`${at}  ${line.trim().slice(0, 90)}`);
    }
    if (RE_DRIVER.test(code)) findings.driver.push(`${at}  ${line.trim().slice(0, 90)}`);
    if (RE_RELATIVE_DB.test(code)) findings.relative.push(`${at}  ${line.trim().slice(0, 90)}`);
  });
}

const CHECKS = [
  ['SQL written outside database/', findings.sql,
    'Move the query into a repository and call it through `#db`.'],
  ['the pg driver imported outside database/', findings.driver,
    'A second pool the data layer does not know about. Use `#db`.'],
  ['database/ reached by relative path', findings.relative,
    "Import '#db/...' — a relative path breaks when either end moves."],
];

console.log('\nData-layer boundary — nothing that SHIPS touches the database directly\n');
let failed = 0;
if (findings.testSql.length) {
  // Informational, and named so it cannot be mistaken for a pass. These were
  // invisible until the regex above was corrected.
  console.log(`NOTE  SQL inside tests: ${findings.testSql.length}  (permitted — see isTest)`);
  if (LIST) for (const h of findings.testSql) console.log(`        ${h}`);
}
for (const [name, hits, remedy] of CHECKS) {
  if (!hits.length) { console.log(`PASS  ${name}: 0`); continue; }
  failed += 1;
  console.log(`FAIL  ${name}: ${hits.length}`);
  console.log(`      ${remedy}`);
  for (const h of (LIST ? hits : hits.slice(0, 10))) console.log(`        ${h}`);
  if (!LIST && hits.length > 10) console.log(`        ... and ${hits.length - 10} more (run with --list)`);
}

if (failed) {
  console.log(`\n${failed} of ${CHECKS.length} boundary rules broken.`);
  console.log('The data layer is only a boundary while nothing reaches past it.\n');
  process.exit(1);
}
console.log('\nThe boundary holds: every database access goes through #db.\n');
