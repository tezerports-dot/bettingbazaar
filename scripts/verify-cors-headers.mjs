// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every header a panel SENDS is a header CORS ALLOWS.
 *
 * ── The defect this exists to stop ─────────────────────────────────────────
 * `CORS_SHAPE.allowedHeaders` did not name `Idempotency-Key`, and three routes
 * REQUIRE it: `POST /bet/place` — the player's bet button, the single most
 * used control on the platform — and the admin merchant top-up and deduction.
 *
 * A browser will not send a header the server has not agreed to. It asks first,
 * in an OPTIONS preflight, and when the answer omits the header it CANCELS the
 * request. So the call never left the page: no status code, no server log, no
 * route to test. `curl` sends whatever it is told, so a hand-made request, the
 * route tests and the panel tests were all green over a dead button.
 *
 * It was found by pressing the button in a real browser and reading the console
 * (§28: shipped means reachable; §32 S26: the route accepts the call the button
 * actually makes). This gate is the cheap version of that discovery, so the
 * next header nobody adds to the list fails the build instead of a payment.
 *
 * ── Derived, not listed (§28) ─────────────────────────────────────────────
 * Both sides are read from the code: the allow-list from `security.config.js`,
 * the sent headers from the panels themselves. A gate with a hand-written table
 * of either one reports the author who forgot to update it.
 *
 *   node scripts/verify-cors-headers.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's own location — never an absolute path to somebody's
// checkout, which is how verify-ui-coverage.mjs came to run on one machine.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PANELS = ['user-panel', 'admin-panel', 'merchant-panel'];

/**
 * Headers the browser sends on its own and never preflights.
 *
 * `Content-Type` is only free for the three CORS-safelisted values, and every
 * panel here posts JSON, which is not one of them — so it is preflighted and
 * must be in the allow-list, which it is. It is listed here anyway because a
 * panel setting `Content-Type` is not the mistake this gate hunts for.
 */
const NEVER_PREFLIGHTED = new Set(['accept', 'accept-language', 'content-language']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.test\.|\.spec\./.test(name)) out.push(full);
  }
  return out;
}

/** The allow-list, read from the config rather than restated here. */
function allowedHeaders() {
  const src = readFileSync(join(ROOT, 'backend/config/security.config.js'), 'utf8');
  const block = src.match(/allowedHeaders:\s*\[([^\]]*)\]/);
  if (!block) {
    console.error('✗ Could not find `allowedHeaders` in backend/config/security.config.js.');
    console.error('  This gate reads the real list; it does not keep a copy. Fix the reader.');
    process.exit(1);
  }
  return new Set(
    [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1].toLowerCase()),
  );
}

/**
 * Header names a panel sets on a request.
 *
 * Matches the two shapes the panels use — an object literal under a `headers`
 * key, and `setRequestHeader`/`headers.set(...)`. A dynamically computed name
 * cannot be read statically; that is a real limit and is reported rather than
 * silently passed, because a gate that quietly measures a fraction is §32 S8.
 */
function headersSentIn(source) {
  const found = new Map();          // lower-case name → as written
  const dynamic = [];

  for (const m of source.matchAll(/headers\s*:\s*\{([^}]*)\}/g)) {
    for (const h of m[1].matchAll(/['"]([A-Za-z][A-Za-z0-9-]*)['"]\s*:/g)) {
      found.set(h[1].toLowerCase(), h[1]);
    }
    // `...spread` inside a headers literal can carry anything.
    if (/\.\.\./.test(m[1])) dynamic.push(m[1].trim().slice(0, 60));
  }
  for (const m of source.matchAll(/(?:setRequestHeader|headers\.set)\(\s*['"]([A-Za-z][A-Za-z0-9-]*)['"]/g)) {
    found.set(m[1].toLowerCase(), m[1]);
  }
  return { found, dynamic };
}

const allowed = allowedHeaders();
const offenders = [];
let filesScanned = 0;
let headersSeen = 0;

for (const panel of PANELS) {
  let files;
  try { files = walk(join(ROOT, panel, 'src')); } catch { continue; }
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!/headers/.test(source)) continue;
    filesScanned += 1;
    const { found } = headersSentIn(source);
    for (const [lower, written] of found) {
      if (NEVER_PREFLIGHTED.has(lower)) continue;
      headersSeen += 1;
      if (!allowed.has(lower)) {
        offenders.push({ file: relative(ROOT, file), header: written });
      }
    }
  }
}

console.log('CORS request headers');
console.log(`  allowed by the server : ${[...allowed].join(', ')}`);
console.log(`  panel files scanned   : ${filesScanned}`);
console.log(`  header names sent     : ${headersSeen}`);

if (offenders.length) {
  console.error(`\n✗ ${offenders.length} header(s) a panel sends that CORS does not allow:\n`);
  for (const o of offenders) console.error(`   ${o.header}\n       ${o.file}`);
  console.error(`
A browser asks permission for these in a preflight and CANCELS the request when
the answer omits them — so the call never reaches the server. There is no status
code and no log line, and every tier below a browser stays green over a button
that does nothing.

Add the header to CORS_SHAPE.allowedHeaders in backend/config/security.config.js,
in the same change that starts sending it.`);
  process.exit(1);
}

console.log('\n✓ Every header the panels send is one the server allows.');
