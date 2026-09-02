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

// A statement, not the word: "select a merchant" in prose is not SQL.
const RE_SQL = /\b(SELECT\s+[\w*(]|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX)|ALTER\s+TABLE)\b/i;
const RE_DRIVER = /from\s+'pg(-pool|-format)?'|require\(\s*'pg(-pool|-format)?'\s*\)/;
const RE_RELATIVE_DB = /from\s+'(?:\.\.\/)+database\//;

const findings = { sql: [], driver: [], relative: [] };

for (const file of FILES) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    // Comments are prose. A comment explaining a query is not a query.
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    if (!SQL_EXEMPT.has(file) && RE_SQL.test(code)) findings.sql.push(`${at}  ${line.trim().slice(0, 90)}`);
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

console.log('\nData-layer boundary — nothing outside database/ touches the database\n');
let failed = 0;
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
