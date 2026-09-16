// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every brand colour a panel paints from a literal instead of from `Branding`.
 *
 * ── Why this exists, and why it is a REPORT rather than a gate ─────────────
 * CLAUDE.md §4 said to re-count with `grep -ro "D4AF37"`. That command counts
 * ONE SPELLING of ONE of the three brand colours, and the panel writes the same
 * gold three other ways:
 *
 *     #D4AF37              89   the hex
 *     rgba(212,175,55,…)   91   the same colour, for a shadow or a tint
 *     #F5C77A              15   --brand-accent
 *     #B8860B              13   --brand-secondary
 *
 * So the figure everyone had been quoting — 89 — was under half the real total.
 * A number that is wrong in the safe direction is the worse kind: the work
 * looked nearly done, and an operator who changed their brand colour would have
 * found most of the player panel still gold. `CLAUDE.md` §1 already says this
 * about the migration counter — quote the printed figure, not an estimate — and
 * the rule about colours had exactly the estimate problem.
 *
 * It does not FAIL, on purpose. A gate that goes red on work already known to
 * be outstanding is a gate somebody switches off, and this remediation is real
 * and is not finished. It prints the number, per panel and per file, so the
 * number in the rules file can be a measured one.
 *
 * ── What is NOT a violation ───────────────────────────────────────────────
 * The brand tokens have to be DEFINED somewhere, and the definition is a hex by
 * necessity. So a literal is permitted where it is the schema default sitting
 * behind a brand variable — `--brand-primary: #D4AF37`, or a `var(…, #D4AF37)`
 * fallback — which is §4's own "a fallback is a loading placeholder" carve-out
 * applied to colour. Those lines are counted separately and reported as
 * anchors, so that deleting one by accident is visible rather than looking like
 * progress.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's own location. An absolute path to somebody's
// checkout is how `verify-ui-coverage.mjs` came to run on one machine (§28).
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PANELS = ['user-panel/src', 'admin-panel/src', 'merchant-panel/src'];
const EXT = /\.(tsx?|jsx?|css)$/;

/**
 * The three brand colours, in every spelling a panel actually uses.
 *
 * Keyed by the CSS variable that owns each, so the report can say what to write
 * instead rather than only that something is wrong.
 */
const BRAND = [
  { token: '--brand-primary',   patterns: [/#D4AF37\b/gi, /rgba?\(\s*212\s*,\s*175\s*,\s*55\s*[,)]/gi] },
  { token: '--brand-secondary', patterns: [/#B8860B\b/gi, /rgba?\(\s*184\s*,\s*134\s*,\s*11\s*[,)]/gi] },
  { token: '--brand-accent',    patterns: [/#F5C77A\b/gi, /rgba?\(\s*245\s*,\s*199\s*,\s*122\s*[,)]/gi] },
];

/** A line that DEFINES a brand token, or falls back to one inside `var()`. */
const isAnchor = (line) =>
  /--brand-(primary|secondary|accent)\s*:/.test(line) || /var\(\s*--brand-[a-z]+\s*,/.test(line);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

const perPanel = new Map();
let totalViolations = 0;
let totalAnchors = 0;

for (const panel of PANELS) {
  const files = new Map();
  let violations = 0;
  let anchors = 0;

  for (const file of walk(join(ROOT, panel))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let hits = 0;
    lines.forEach((line, i) => {
      // A line of prose about the colour is not a line that paints with it.
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      let found = 0;
      for (const { patterns } of BRAND) {
        for (const re of patterns) found += (code.match(re) ?? []).length;
      }
      if (!found) return;
      if (isAnchor(code)) { anchors += found; return; }
      hits += found;
      if (process.argv.includes('--lines')) {
        console.log(`  ${relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
    });
    if (hits) { files.set(relative(ROOT, file), hits); violations += hits; }
  }

  perPanel.set(panel, { violations, anchors, files });
  totalViolations += violations;
  totalAnchors += anchors;
}

console.log('\nBrand colours painted from a literal instead of from `Branding`\n');
for (const [panel, { violations, anchors, files }] of perPanel) {
  const name = panel.replace('/src', '');
  console.log(`${name.padEnd(16)} ${String(violations).padStart(4)} literal${violations === 1 ? '' : 's'}`
    + `   (${anchors} permitted anchor${anchors === 1 ? '' : 's'})`);
  if (violations && process.argv.includes('--files')) {
    for (const [f, n] of [...files].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)}  ${f}`);
    }
  }
}

console.log(`\n${totalViolations} to remediate, ${totalAnchors} token definitions and var() fallbacks kept.`);
console.log('`--files` lists them per file; `--lines` prints every line.\n');

// Always zero. See the header: this reports, it does not gate.
process.exit(0);
