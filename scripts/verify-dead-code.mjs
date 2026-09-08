// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * scripts/verify-dead-code.mjs — an export nothing references is a build failure.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `check:ui-coverage` finds endpoints no screen calls. It cannot see one layer
 * deeper: a repository function with no service, no route and no screen is
 * invisible to it, and 73 such exports were found by hand in one sweep. Two of
 * them mattered. `cache.service.js` built a Redis client inside an `initCache`
 * nobody called, so every cache operation silently used a per-process Map — and
 * the Map was never written to either, because the entire service had one call
 * site deleting a key nothing sets. `securityMonitor` recorded every refused
 * request into the audit trail and was mounted nowhere, so a burst of failed
 * admin logins left no trace at all.
 *
 * Neither failed a test. Nothing was looking.
 *
 * ── The three tiers, and why only one is fatal ──────────────────────────────
 * DEAD          nothing anywhere names it, not even a test. FATAL. It cannot
 *               run, so it cannot be right, and it cannot be reviewed against
 *               anything.
 * TEST-ONLY     only tests name it. REPORTED. Reconciliation helpers
 *               (`findOrdersMissingLedgerEvents`) and deliberate test seams
 *               (`_setLoadShedConfig`) live here legitimately; so does a
 *               feature built at the data layer and never wired up. Triage,
 *               not failure.
 * OVER-EXPORTED used only inside its own file. REPORTED. The code runs; the
 *               export is wider than it needs to be.
 *
 * ── What counts as a reference ──────────────────────────────────────────────
 * A textual mention of the name in any other file. Deliberately crude, and
 * therefore SAFE in the direction that matters: namespace access
 * (`db.games.setProviderEnabled`) and re-export lists both contain the name, so
 * a live symbol is never called dead. The cost is the reverse — a name that
 * merely appears in a comment counts as used — which loses coverage rather than
 * inventing a failure.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's own location. An absolute path baked in here once
// shipped a verifier that ran only on its author's machine and died in CI at
// the first readFileSync.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

const ROOTS = ['backend', 'database', 'admin-panel/src', 'user-panel/src', 'merchant-panel/src', 'scripts'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

// Names that are legitimately unreferenced from inside this tree.
const ALLOW = new Set([
  'default',           // a default export is named at the import site, not here
]);
// Files whose exports are a public surface consumed from outside the tree.
const ALLOW_FILES = [/^scripts\//];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js|ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const isTest = (f) => /[\\/]tests?[\\/]|\.test\.|\.spec\./.test(f);
const files = ROOTS.flatMap((d) => walk(join(ROOT, d)));
const all = files.map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]);

const dead = [], testOnly = [], over = [];
for (const [f, src] of all) {
  if (isTest(f) || ALLOW_FILES.some((re) => re.test(f))) continue;
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|class)\s+(\w+)/gm)) names.add(m[1]);
  for (const name of names) {
    if (ALLOW.has(name)) continue;
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let prod = 0, tests = 0;
    for (const [g, s] of all) {
      if (g === f) continue;
      const n = (s.match(re) || []).length;
      if (isTest(g)) tests += n; else prod += n;
    }
    if (prod > 0) continue;
    // Uses inside its own file. Only the DEFINITION line and bare re-export
    // entries are excluded — `export const x = thisName(...)` is a real use.
    const defRe = new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`);
    const own = src.split('\n')
      .filter((l) => !defRe.test(l) && !new RegExp(`^\\s*${name},?\\s*$`).test(l))
      .join('\n');
    const self = (own.match(re) || []).length;
    const row = { file: f, name };
    if (self > 0) over.push(row);
    else if (tests > 0) testOnly.push(row);
    else dead.push(row);
  }
}

/**
 * ── A MODULE nothing imports ────────────────────────────────────────────────
 *
 * The export scan above cannot see this. `default` is on ALLOW because a
 * default export is named at the import site, not at the definition — which
 * means a module whose ONLY export is a default is exempt from every check in
 * this file.
 *
 * `backend/services/admin.service.js` was exactly that: `export default new
 * AdminService()`, 380 lines of block/unblock/delete/sub-admin CRUD that no
 * route, service or script ever imported. It duplicated live routes, held two
 * writes of NULL into a NOT NULL column, and carried a money guard the LIVE
 * delete route did not have — while `moneyDecisionsReadTheWallet.test.js`
 * asserted that guard against it and passed. Every check in this repository was
 * green the whole time.
 *
 * So: a module under the application tree that nothing imports by path is dead,
 * whatever it exports. A test naming the path is NOT an import — reading a
 * file's source text to assert on it is precisely how the file above stayed
 * alive through a dead-code sweep.
 */
const ENTRY = [
  /^backend\/server\.js$/,           // the process entry point
  /^backend\/cron\//,                // scheduled jobs, started by the runner
  /\/index\.(m?js|ts|tsx)$/,          // barrels, imported by directory
  /^(admin|user|merchant)-panel\/src\//, // bundler-resolved: JSX, lazy(), assets
  /\.d\.ts$/,
];

/**
 * Orphans that are DELIBERATE, each with the reason it is not a defect.
 *
 * An allowlist rather than a heuristic, because the difference between "an
 * extension point nobody has built against yet" and "a duplicate of a live
 * route that somebody forgot to delete" is a judgement, not a pattern — and the
 * whole point of this check is to force that judgement at the moment the orphan
 * appears, instead of letting it sit for months while tests assert against it.
 *
 * Adding a line here is a decision. Make it explicitly.
 */
const ORPHAN_ALLOW = [
  // Abstract base classes for integrations that do not exist yet. No
  // implementation extends them (StorageProvider, which two do extend, is
  // correctly NOT here — it is imported). They are the declared shape a future
  // provider must satisfy, and `tools/validate-migration.sh` checks they exist.
  [/^backend\/providers\/(casino|payment|sportsbook)\/\w+\.interface\.js$/,
   'declared extension point; no implementation built yet'],
];

const importedPaths = new Set();
for (const [f, src] of all) {
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/g)) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('#')) continue;
    // Resolve a relative specifier against the importing file's directory; a
    // `#db/...` subpath maps to database/. Extensionless and /index forms both
    // count, so a barrel import marks the barrel.
    const base = spec.startsWith('#db')
      ? spec.replace(/^#db\/?/, 'database/').replace(/^database$/, 'database/index.js')
      : join(dirname(f), spec);
    for (const cand of [base, `${base}.js`, `${base}.ts`, `${base}.tsx`,
                        `${base}/index.js`, `${base}/index.ts`]) {
      importedPaths.add(cand.replace(/\\/g, '/'));
    }
  }
}

// A file can also be reached WITHOUT an import: a worker thread is loaded by
// path (`path.join(__dirname, 'cpuWorker.js')`, `new Worker(...)`), and calling
// that dead would be wrong — it runs on every CSV export. Any quoted string
// naming the file counts, which is deliberately generous: this check exists to
// catch a module NOTHING reaches, not to police how it is reached.
const pathLoaded = new Set();
for (const [f, src] of all) {
  for (const m of src.matchAll(/['"`]([\w.-]+\.(?:m?js|ts))['"`]/g)) {
    for (const [g] of all) {
      if (g !== f && g.endsWith(`/${m[1]}`)) pathLoaded.add(g);
    }
  }
}

const orphanModules = all
  .map(([f]) => f)
  .filter((f) => !isTest(f)
    && !ENTRY.some((re) => re.test(f))
    && !ALLOW_FILES.some((re) => re.test(f))
    && !ORPHAN_ALLOW.some(([re]) => re.test(f))
    && !importedPaths.has(f)
    && !pathLoaded.has(f));

const group = (rows) => {
  const by = {};
  for (const r of rows) (by[r.file] ??= []).push(r.name);
  return Object.entries(by).sort((a, b) => b[1].length - a[1].length);
};
const print = (title, rows) => {
  console.log(`\n${title}: ${rows.length}`);
  for (const [f, ns] of group(rows)) console.log(`   ${f}\n       ${ns.join(', ')}`);
};

console.log(`exports scanned            : ${dead.length + testOnly.length + over.length + files.length}`);
console.log(`DEAD (referenced nowhere)  : ${dead.length}`);
console.log(`orphan modules (no import) : ${orphanModules.length}`);
console.log(`test-only (informational)  : ${testOnly.length}`);
console.log(`over-exported (info)       : ${over.length}`);

if (process.argv.includes('--all')) {
  print('TEST-ONLY — only a test names it; triage, not failure', testOnly);
  print('OVER-EXPORTED — used only inside its own file', over);
}

// Both failures are REPORTED before either exits. `process.exit(1)` here meant
// a run that had dead exports never printed its orphan modules, so fixing the
// first was the only way to discover the second — one round trip per finding.
if (dead.length) {
  print('DEAD — referenced nowhere, not even a test', dead);
  console.error('\n✗ Delete these, or wire them up. Code nothing calls cannot be right.');
  process.exitCode = 1;
}
if (orphanModules.length) {
  console.log(`\nORPHAN MODULES — nothing imports the file: ${orphanModules.length}`);
  for (const f of orphanModules) console.log(`   ${f}`);
  console.log('\nA module nothing imports cannot run. Delete it, or import it from');
  console.log('wherever it was meant to be used. A test that READS its source is not');
  console.log('an import — that is how a 380-line duplicate survived a dead-code sweep');
  console.log('while a money guard it held was asserted against it and passed.');
  process.exitCode = 1;
}

if (!dead.length && !orphanModules.length) {
  console.log('\n✅ Every export is referenced by something, and every module is imported.');
}
