#!/usr/bin/env node
/**
 * verify-no-mongo.mjs — the definition of done for the single-store migration.
 *
 * BettingBazaar stores all state in PostgreSQL. There is no second store, no
 * mirror, no dual write and no cutover. This script proves that by counting
 * every surviving trace of the removed document store and failing the build
 * while any count is non-zero.
 *
 * Run it after every removal pass. The numbers must only go down.
 *
 * It also reports PROGRESS as a percentage of the references that existed
 * before removal began, per check and overall, from baselines measured with
 * this same script (see BASELINE). That figure is the only one to quote: an
 * estimate made from memory moves its own denominator, and two such estimates
 * taken a day apart are not comparable — which reads as regress even while
 * every count is falling.
 *
 *   npm run check:no-mongo            summary + per-file counts
 *   npm run check:no-mongo -- -v      every file, with matching lines
 *   npm run check:no-mongo -- --summary   totals only
 *
 * Exit codes: 0 = every count is zero. 1 = at least one count is non-zero.
 *
 * This file is the only file in the repository allowed to name the forbidden
 * strings, because it is the thing that forbids them. It excludes itself from
 * every scan by path (see SELF_PATH). Nothing else is exempt.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/**
 * The two files allowed to name the forbidden strings, because they are the
 * things that forbid them: this scanner, and the root rule it enforces (whose
 * exit criteria quote the strings verbatim by design). Nothing else is exempt —
 * not a comment, not a variable name, not a doc.
 */
const SELF_PATH = 'scripts/verify-no-mongo.mjs';
const EXEMPT = new Set([SELF_PATH, 'CLAUDE.md']);

/** Directories never worth walking. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.vite',
  '.gradle',
  '.idea',
  'out',
  'vendor',
]);

/** Generated files, and lockfiles that only mirror package.json. */
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

/** @returns {string[]} repo-relative paths of every scannable file. */
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    const rel = relative(REPO_ROOT, abs).split(sep).join('/');
    if (EXEMPT.has(rel)) continue;
    acc.push(rel);
  }
  return acc;
}

const ALL_FILES = walk(REPO_ROOT);

/** Cached reads — several checks scan the same files. */
const readCache = new Map();
function read(rel) {
  if (!readCache.has(rel)) {
    try {
      readCache.set(rel, readFileSync(join(REPO_ROOT, rel), 'utf8'));
    } catch {
      readCache.set(rel, '');
    }
  }
  return readCache.get(rel);
}

/** Binary files produce garbage matches; skip anything holding a NUL byte. */
function isText(rel) {
  const body = read(rel);
  return body.length === 0 || !body.includes('\0');
}

const isJs = (rel) => ['.js', '.mjs', '.cjs'].includes(extname(rel));
const isJsLike = (rel) => isJs(rel) || ['.ts', '.tsx', '.jsx'].includes(extname(rel));
const isMarkdown = (rel) => extname(rel) === '.md';
const inBackend = (rel) => rel.startsWith('backend/');
const inDatabase = (rel) => rel.startsWith('database/');
const inDocs = (rel) => rel.startsWith('docs/');

// ---------------------------------------------------------------------------
// Comment extraction
// ---------------------------------------------------------------------------

/**
 * Split JavaScript source into comment text and non-comment text, tracking
 * string and template literals so a URL inside a string is not mistaken for a
 * line comment. Returns per-line records so the report can cite line numbers.
 *
 * @returns {{ line: number, comment: string, code: string }[]}
 */
function splitComments(source) {
  const out = [];
  let line = 1;
  let comment = '';
  let code = '';
  let state = 'code'; // code | line-comment | block-comment | single | double | template

  const flush = () => {
    out.push({ line, comment, code });
    comment = '';
    code = '';
    line += 1;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '\n') {
      if (state === 'line-comment') state = 'code';
      flush();
      continue;
    }

    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') {
          state = 'line-comment';
          i += 1;
          comment += '//';
        } else if (ch === '/' && next === '*') {
          state = 'block-comment';
          i += 1;
          comment += '/*';
        } else if (ch === "'") {
          state = 'single';
          code += ch;
        } else if (ch === '"') {
          state = 'double';
          code += ch;
        } else if (ch === '`') {
          state = 'template';
          code += ch;
        } else {
          code += ch;
        }
        break;

      case 'line-comment':
        comment += ch;
        break;

      case 'block-comment':
        comment += ch;
        if (ch === '*' && next === '/') {
          comment += '/';
          i += 1;
          state = 'code';
        }
        break;

      case 'single':
      case 'double':
        code += ch;
        if (ch === '\\') {
          code += next ?? '';
          i += 1;
        } else if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) {
          state = 'code';
        }
        break;

      case 'template':
        code += ch;
        if (ch === '\\') {
          code += next ?? '';
          i += 1;
        } else if (ch === '`') {
          state = 'code';
        }
        break;

      default:
        code += ch;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const RE_MODEL_CALL = /mongoose\s*\.\s*model\s*\(/g;
const RE_IMPORT_DRIVER =
  /(?:import\s[^;]*?from\s*|require\s*\(\s*|import\s*\(\s*)['"](?:mongoose|mongodb|mongodb-memory-server)(?:\/[^'"]*)?['"]/;
const RE_IMPORT_BARE = /^\s*import\s+['"](?:mongoose|mongodb|mongodb-memory-server)['"]/;
const RE_IMPORT_MODEL_INDEX = /['"][^'"]*models\/index(?:\.js)?['"]/;
const RE_PKG_LINE = /mongo/i;
const RE_MONGO_URI = /MONGODB_URI/g;
const RE_MONGO_WORD = /mongo/gi;

/**
 * The gate's own name is not a violation of the gate. Documentation has to be
 * able to tell a reader how to run `npm run check:no-mongo`, and the npm script
 * has to name the file it runs, so those two exact tokens are stripped before a
 * line is scanned. Nothing else is stripped — a sentence that merely mentions
 * the check still counts if it names the store as well.
 */
const RE_GATE_NAME = /check:no-mongo|verify-no-mongo\.mjs/g;
const withoutGateName = (text) => text.replace(RE_GATE_NAME, '');

/** Count non-overlapping matches of a global regex. */
function countMatches(rawText, re) {
  const text = withoutGateName(rawText);
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

/** Lines of `text` matching `re`, as `{ line, text }`. */
function matchingLines(text, re) {
  return text
    .split('\n')
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => {
      re.lastIndex = 0;
      return re.test(withoutGateName(t));
    });
}

/** True when `re` matches, without leaking lastIndex to the next caller. */
function hits(text, re) {
  re.lastIndex = 0;
  const found = re.test(withoutGateName(text));
  re.lastIndex = 0;
  return found;
}

// ---------------------------------------------------------------------------
// Checks — each returns { id, title, unit, total, files }
// ---------------------------------------------------------------------------

/**
 * What each check counted BEFORE any removal began, measured by running this
 * same script against the merge base (commit 6e66b52).
 *
 * These exist so progress is a MEASUREMENT rather than an estimate. Reporting
 * "about 60% done" from memory is how a number drifts: the denominator moves
 * without anybody saying so, and two reports taken a day apart are no longer
 * comparable — which looks like regress even while every count is falling.
 *
 * They are constants, never recomputed. If a baseline is ever wrong, correct it
 * here with the commit that was measured, and say so.
 */
const BASELINE = Object.freeze({
  1: 582,   // mongoose.model() call sites
  2: 147,   // files importing the driver or models/index.js
  3: 3,     // packages declared in package.json
  4: 53,    // MONGODB_URI references
  5: 894,   // comment lines
  6: 390,   // documentation lines
  7: 1689,  // code references
  // Measured at the same commit as the rest, by the same script, when check 8
  // was added. The data layer was never scanned before — the original seven
  // checks covered backend/, docs/ and config, and the whole of database/ sat
  // outside all of them. It is a SEPARATE check with its own baseline rather
  // than an extension of 5 and 7, so the six earlier figures stay comparable
  // with every report already quoted.
  8: 186,   // data-layer references (database/**, code and comments)
});
const BASELINE_COMMIT = '6e66b52';
const BASELINE_TOTAL = Object.values(BASELINE).reduce((a, b) => a + b, 0);

const checks = [];

// 1. mongoose.model() call sites.
{
  const files = [];
  let total = 0;
  for (const rel of ALL_FILES) {
    if (!isJsLike(rel) || !isText(rel)) continue;
    const body = read(rel);
    const count = countMatches(body, RE_MODEL_CALL);
    if (count === 0) continue;
    total += count;
    files.push({ file: rel, count, samples: matchingLines(body, RE_MODEL_CALL).slice(0, 3) });
  }
  checks.push({ id: 1, title: 'mongoose.model() call sites', unit: 'call sites', total, files });
}

// 2. Files importing the driver, its in-memory test server, or the model barrel.
{
  const files = [];
  for (const rel of ALL_FILES) {
    if (!isJsLike(rel) || !isText(rel)) continue;
    const found = [];
    read(rel)
      .split('\n')
      .forEach((text, i) => {
        const isImport =
          RE_IMPORT_DRIVER.test(text) ||
          RE_IMPORT_BARE.test(text) ||
          (RE_IMPORT_MODEL_INDEX.test(text) && /\b(?:import|require|from)\b/.test(text));
        if (isImport) found.push({ line: i + 1, text });
      });
    if (found.length === 0) continue;
    files.push({ file: rel, count: 1, samples: found.slice(0, 3) });
  }
  checks.push({
    id: 2,
    title: 'files importing the document-store driver or models/index.js',
    unit: 'files',
    total: files.length,
    files,
  });
}

// 3. Driver packages declared in any package.json. Parsed as JSON rather than
//    grepped, so the name of this very check (`check:no-mongo`, a script entry)
//    is not itself reported as a dependency.
{
  const DEP_BLOCKS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
    'bundledDependencies',
    'overrides',
    'resolutions',
    'allowScripts',
  ];
  const files = [];
  let total = 0;
  for (const rel of ALL_FILES) {
    if (basename(rel) !== 'package.json' || !isText(rel)) continue;
    let pkg;
    try {
      pkg = JSON.parse(read(rel));
    } catch {
      // Unparseable package.json — fall back to a line scan so it is not a hole.
      const found = matchingLines(read(rel), RE_PKG_LINE);
      if (found.length === 0) continue;
      total += found.length;
      files.push({ file: rel, count: found.length, samples: found.slice(0, 5) });
      continue;
    }
    const found = [];
    for (const block of DEP_BLOCKS) {
      const value = pkg[block];
      if (!value || typeof value !== 'object') continue;
      for (const name of Object.keys(value)) {
        if (RE_PKG_LINE.test(name)) found.push({ line: 0, text: `${block}.${name}` });
      }
    }
    if (found.length === 0) continue;
    total += found.length;
    files.push({ file: rel, count: found.length, samples: found.slice(0, 5) });
  }
  checks.push({
    id: 3,
    title: 'document-store packages declared in package.json',
    unit: 'declarations',
    total,
    files,
  });
}

// 4. MONGODB_URI anywhere — scripts, workflows, env files, compose files, docs.
{
  const files = [];
  let total = 0;
  for (const rel of ALL_FILES) {
    if (!isText(rel)) continue;
    const body = read(rel);
    const count = countMatches(body, RE_MONGO_URI);
    if (count === 0) continue;
    total += count;
    files.push({ file: rel, count, samples: matchingLines(body, RE_MONGO_URI).slice(0, 3) });
  }
  checks.push({
    id: 4,
    title: 'MONGODB_URI in scripts, workflows, env files and config',
    unit: 'references',
    total,
    files,
  });
}

// 5. Document-store words inside backend/**/*.js comments.
{
  const files = [];
  let total = 0;
  for (const rel of ALL_FILES) {
    if (!inBackend(rel) || !isJs(rel) || !isText(rel)) continue;
    const found = splitComments(read(rel))
      .filter(({ comment }) => hits(comment, RE_MONGO_WORD))
      .map(({ line, comment }) => ({ line, text: comment.trim() }));
    if (found.length === 0) continue;
    total += found.length;
    files.push({ file: rel, count: found.length, samples: found.slice(0, 3) });
  }
  checks.push({
    id: 5,
    title: 'document-store references in backend/**/*.js comments',
    unit: 'comment lines',
    total,
    files,
  });
}

// 6. Document-store words in documentation.
{
  const files = [];
  let total = 0;
  for (const rel of ALL_FILES) {
    if (!isMarkdown(rel) || !isText(rel)) continue;
    const isRepoDoc =
      inDocs(rel) ||
      /^[^/]+\.md$/.test(rel) ||
      rel.startsWith('backend/') ||
      rel.startsWith('deploy/') ||
      rel.startsWith('loadtest/') ||
      rel.startsWith('audit/') ||
      rel.startsWith('platform/');
    if (!isRepoDoc) continue;
    const found = matchingLines(read(rel), RE_MONGO_WORD);
    if (found.length === 0) continue;
    total += found.length;
    files.push({ file: rel, count: found.length, samples: found.slice(0, 3) });
  }
  checks.push({
    id: 6,
    title: 'document-store references in documentation (docs/ and repo markdown)',
    unit: 'lines',
    total,
    files,
  });
}

// 7. Anything left in backend/**/*.js outside comments — identifiers, string
//    literals, connection helpers, filenames. Check 5 only sees comments; this
//    closes the gap so nothing hides in code.
{
  const files = [];
  let total = 0;
  for (const rel of ALL_FILES) {
    if (!inBackend(rel) || !isJs(rel) || !isText(rel)) continue;
    const found = splitComments(read(rel))
      .filter(({ code }) => hits(code, RE_MONGO_WORD))
      .map(({ line, code }) => ({ line, text: code.trim() }));
    if (found.length === 0) continue;
    total += found.length;
    files.push({ file: rel, count: found.length, samples: found.slice(0, 3) });
  }
  checks.push({
    id: 7,
    title: 'document-store references in backend/**/*.js code (identifiers, strings)',
    unit: 'lines',
    total,
    files,
  });
}

// 8. The DATA LAYER — database/**, code and comments together.
//
// Checks 5 and 7 stop at backend/. That left the single largest body of prose
// in the repository unscanned, and it is the prose a reader is most likely to
// trust: a header on the wallet repository that says which store owns balances
// is read as current. 186 lines described a second store that no longer
// existed, and two of them were hiding live defects — a grant that reported
// success while moving nothing, and a reconciliation caveat saying drift could
// be benign.
//
// Code and comments are ONE check here rather than two. The split in 5/7 exists
// because they were removed in different passes at very different rates; there
// is no such history to preserve for a check that starts at zero.
{
  const files = [];
  let total = 0;
  for (const rel of ALL_FILES) {
    if (!inDatabase(rel) || !isText(rel)) continue;
    if (!isJsLike(rel) && extname(rel) !== '.sql') continue;
    const found = read(rel).split('\n')
      .map((text, i) => ({ line: i + 1, text }))
      .filter(({ text }) => hits(text, RE_MONGO_WORD))
      .map(({ line, text }) => ({ line, text: text.trim() }));
    if (found.length === 0) continue;
    total += found.length;
    files.push({ file: rel, count: found.length, samples: found.slice(0, 3) });
  }
  checks.push({
    id: 8,
    title: 'document-store references in the data layer (database/**)',
    unit: 'lines',
    total,
    files,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose') || argv.includes('-v');
const summaryOnly = argv.includes('--summary');
const jsonOut = argv.includes('--json');

const ESC = String.fromCharCode(27);
const color = (code) => (s) => (process.stdout.isTTY ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = color('1');
const red = color('31');
const green = color('32');

if (jsonOut) {
  console.log(
    JSON.stringify(
      {
        pass: checks.every((c) => c.total === 0),
        total: checks.reduce((sum, c) => sum + c.total, 0),
        checks: checks.map(({ id, title, unit, total, files }) => ({
          id,
          title,
          unit,
          total,
          files: files.map(({ file, count }) => ({ file, count })),
        })),
      },
      null,
      2,
    ),
  );
  process.exit(checks.every((c) => c.total === 0) ? 0 : 1);
}

console.log(bold('\nSingle-store verification — PostgreSQL is the only store\n'));

for (const check of checks) {
  const label = `  ${check.id}. ${check.title}`;
  const base = BASELINE[check.id];
  const removed = base ? Math.round(((base - check.total) / base) * 100) : null;
  const progress = removed === null ? '' : `  [${removed}% of ${base} removed]`;
  if (check.total === 0) {
    console.log(`${green('PASS')}${label}: ${green('0')}${progress}`);
    continue;
  }
  console.log(
    `${red('FAIL')}${label}: ${red(String(check.total))} ${check.unit} in ${check.files.length} file(s)${progress}`,
  );
  if (summaryOnly) continue;

  const ranked = [...check.files].sort((a, b) => b.count - a.count);
  const shown = verbose ? ranked : ranked.slice(0, 20);
  for (const entry of shown) {
    console.log(`        ${entry.file} (${entry.count})`);
    if (!verbose) continue;
    for (const sample of entry.samples) {
      const text = String(sample.text ?? '').trim().slice(0, 140);
      console.log(`            ${entry.file}:${sample.line}: ${text}`);
    }
  }
  if (ranked.length > shown.length) {
    console.log(`        ... and ${ranked.length - shown.length} more file(s) (run with --verbose)`);
  }
}

const failing = checks.filter((c) => c.total > 0);
const grandTotal = checks.reduce((sum, c) => sum + c.total, 0);

console.log('');
if (failing.length === 0) {
  console.log(green(bold('All checks report zero. PostgreSQL is the only store.\n')));
  process.exit(0);
}

const removedTotal = BASELINE_TOTAL - grandTotal;
const percent = Math.round((removedTotal / BASELINE_TOTAL) * 100);

console.log(
  red(bold(`${failing.length} of ${checks.length} checks non-zero — ${grandTotal} references remain.`)),
);
console.log(
  bold(`Progress: ${removedTotal} of ${BASELINE_TOTAL} references removed — ${percent}% `)
  + `(baseline measured at ${BASELINE_COMMIT}).`,
);
console.log('This is the ONLY number to quote for progress. It is counted, not estimated.');
console.log('The migration is not done. Re-run after the next removal pass.\n');
process.exit(1);
