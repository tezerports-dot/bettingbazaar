// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The dependency audit gate: `npm audit --audit-level=high`, with the
 * advisories the owner has decided to tolerate named one at a time.
 *
 * ── Why it is not plain `npm audit` any more ────────────────────────────────
 * GHSA-vfj7-8cjw-p6xm (braces, 2026-10-03) covers every version of braces ever
 * published, so it failed every lockfile on every branch with no fix to take.
 * npm audit has no way to tolerate one advisory, so the choice was a red gate
 * nobody could clear or switching the gate off. The owner chose a recorded
 * exception (PR #201): this script runs the same audit and refuses everything
 * the exception does not name.
 *
 * ── An exception is narrow, and it expires by itself ────────────────────────
 * Each entry in `audit-exceptions.json` tolerates ONE advisory, and only while
 *   - the advisory's vulnerable range is still the one that was decided on
 *     (a widened advisory is a new decision);
 *   - every copy of the package is dev-only in this lockfile (`dev: true`), so
 *     the day a production dependency pulls it in, the gate fails again;
 *   - the newest published version is still inside that range. The moment a
 *     fix ships, the gate fails and names it: upgrade, then delete the entry.
 * Anything it cannot read (the audit's JSON, the lockfile, the registry) fails
 * the gate. A gate that passes when it could not look is not a gate (§32 S8).
 *
 *   node scripts/audit-gate.mjs          (in the directory whose lockfile to audit)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXCEPTIONS_FILE = fileURLToPath(new URL('./audit-exceptions.json', import.meta.url));
const BLOCKING = new Set(['high', 'critical']);
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const AT_MOST = /^<=(\d+)\.(\d+)\.(\d+)$/;

/** The exception list, refused whole if any entry is malformed. */
export function loadExceptions(raw) {
  const list = raw?.exceptions;
  if (!Array.isArray(list)) throw new Error('audit-exceptions.json: "exceptions" must be an array');
  for (const e of list) {
    const bad = !GHSA.test(e?.id ?? '') ? 'id is not a GHSA id'
      : typeof e.package !== 'string' || !e.package ? 'package is missing'
        : !AT_MOST.test(e.range ?? '') ? 'range must be "<=x.y.z", the only shape this gate can retire'
          : e.devOnly !== true ? 'only a dev-only package may be excepted'
            : !String(e.reason ?? '').trim() || !String(e.decided ?? '').trim() ? 'reason and decided are required'
              : null;
    if (bad) throw new Error(`audit-exceptions.json: ${e?.id ?? '(no id)'}: ${bad}`);
  }
  return list;
}

/** Is `version` still inside an "<=x.y.z" range? Prerelease tags are ignored. */
export function stillVulnerable(version, range) {
  const [, ...max] = range.match(AT_MOST).map(Number);
  const got = String(version).split('-')[0].split('.').map(Number);
  if (got.length !== 3 || got.some(Number.isNaN)) throw new Error(`cannot read version "${version}"`);
  for (let i = 0; i < 3; i += 1) if (got[i] !== max[i]) return got[i] < max[i];
  return true;
}

/**
 * Judge one audit. Pure, so the decision is testable without a registry.
 *
 * @param audit       the parsed output of `npm audit --json`
 * @param lock        the parsed package-lock.json beside it
 * @param exceptions  loadExceptions(...)
 * @param latestOf    (pkg) => newest published version
 * @returns {{ blocking: string[], tolerated: string[] }}
 */
export function judge({ audit, lock, exceptions, latestOf }) {
  if (!audit || typeof audit !== 'object' || audit.error || typeof audit.vulnerabilities !== 'object') {
    throw new Error(`npm audit did not report: ${JSON.stringify(audit?.error ?? audit).slice(0, 300)}`);
  }
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') throw new Error('package-lock.json has no "packages" map');

  const blocking = [];
  const tolerated = [];
  const seen = new Set();
  for (const entry of Object.values(audit.vulnerabilities)) {
    for (const via of entry.via ?? []) {
      // A string names another package; its own advisories are listed under it.
      if (typeof via !== 'object' || !BLOCKING.has(via.severity)) continue;
      const id = String(via.url ?? '').split('/').pop();
      const key = `${id}|${via.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = `${id || via.url || via.source} ${via.name} ${via.range} (${via.severity}): ${via.title}`;

      const exception = exceptions.find((e) => e.id === id && e.package === via.name);
      if (!exception) { blocking.push(label); continue; }
      if (exception.range !== via.range) {
        blocking.push(`${label} — the advisory's range is now ${via.range}, not the ${exception.range} that was decided on`);
        continue;
      }
      const nodes = audit.vulnerabilities[via.name]?.nodes ?? [];
      const notDev = nodes.filter((n) => packages[n]?.dev !== true);
      if (!nodes.length || notDev.length) {
        blocking.push(`${label} — not dev-only here (${notDev.join(', ') || 'no installed copy found'}), so the exception does not apply`);
        continue;
      }
      const latest = latestOf(via.name);
      if (!stillVulnerable(latest, exception.range)) {
        blocking.push(`${label} — ${via.name}@${latest} is outside ${exception.range}: a fix exists. Upgrade, then delete the exception`);
        continue;
      }
      tolerated.push(`${label} — excepted (${exception.decided}); newest ${via.name} is ${latest}`);
    }
  }
  return { blocking, tolerated };
}

function npmJson(args) {
  const run = spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`npm ${args.join(' ')} gave no JSON (exit ${run.status}): ${(run.stderr || run.stdout || '').slice(0, 300)}`);
  }
}

function main() {
  const exceptions = loadExceptions(JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8')));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const audit = npmJson(['audit', '--json']);
  const latestOf = (pkg) => {
    const v = npmJson(['view', pkg, 'version', '--json']);
    if (typeof v !== 'string') throw new Error(`npm view ${pkg} version did not answer a version`);
    return v;
  };
  const { blocking, tolerated } = judge({ audit, lock, exceptions, latestOf });
  for (const t of tolerated) console.log(`tolerated  ${t}`);
  for (const b of blocking) console.log(`BLOCKING   ${b}`);
  const totals = audit.metadata?.vulnerabilities ?? {};
  console.log(`\nnpm audit: ${JSON.stringify(totals)}; ${tolerated.length} excepted, ${blocking.length} blocking`);
  process.exit(blocking.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(`audit gate could not judge this tree: ${err.message}`);
    process.exit(1);
  }
}
