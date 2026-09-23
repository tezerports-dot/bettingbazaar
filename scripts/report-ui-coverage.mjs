// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What has actually been pressed, per screen, per control, per panel.
 *
 * ── Why this is generated and not written ──────────────────────────────────
 * §29: "clean", "complete" and "every button tested" are claims about EVIDENCE,
 * and every one requires naming the gate that was run and the number it
 * printed. A hand-written coverage table is an impression with a table around
 * it — it goes stale the first time somebody adds a screen, and nothing says so.
 *
 * So this reads the two artefacts the browser passes leave behind:
 *
 *   controls.manifest.json   every control each screen HAS      (test:browser)
 *   drive.report.json        what happened when each was PRESSED (test:drive)
 *
 * and prints the difference. A screen in the manifest and missing from the
 * report is NOT DRIVEN and says so; it does not silently score zero, and it
 * does not silently score full marks either.
 *
 *   node scripts/report-ui-coverage.mjs            per-screen summary
 *   node scripts/report-ui-coverage.mjs --controls every control, by verdict
 *   node scripts/report-ui-coverage.mjs --md       markdown tables
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = join(ROOT, 'backend/tests/browser/controls.manifest.json');
const REPORT = join(ROOT, 'backend/tests/browser/drive.report.json');

const read = (p, what) => {
  if (!existsSync(p)) {
    console.error(`No ${what} at ${p}.`);
    console.error('Run it first — this reports what was measured, it does not measure.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
};

const manifest = read(MANIFEST, 'control manifest (npm run test:browser)');
const report = read(REPORT, 'drive report (npm run test:drive)');

/** A verdict's meaning, in one line, for the legend. */
const MEANING = {
  ACTED: 'pressed, and the screen changed',
  INERT: 'pressed, and NOTHING a person could see changed',
  DEFERRED: 'not pressed on purpose — destructive, or it leaves the app',
  DISABLED: 'disabled on arrival, so there was nothing to press',
  REPRESENTED: 'a repeat of a control already pressed on this screen',
  GONE: 'vanished before its turn — an earlier press removed it',
  UNREACHABLE: 'could not be clicked (covered, or it broke the attempt)',
  THROTTLED: 'never reached — the platform rate-limited the run (NOT verified)',
  THREW: 'threw an uncaught error',
  FIVE_HUNDRED: 'the server answered 5xx',
  DUPLICATE: 'the same control seen twice in one collection',
  NEEDS_INPUT: 'it asked a confirm/prompt and this pass declined — NOT a dead button',
};
/** Verdicts that mean "this control was genuinely exercised". */
const EXERCISED = new Set(['ACTED', 'INERT']);
/** Verdicts that mean "deliberately not pressed, and that is a decision". */
const BY_CHOICE = new Set(['DEFERRED', 'DISABLED', 'REPRESENTED', 'DUPLICATE', 'NEEDS_INPUT']);

// A separator that cannot occur in a panel name or a route.
const SEP = '\u0000';
const pressedBy = new Map();
for (const p of report.pressed ?? []) {
  const k = `${p.panel}${SEP}${p.screen}`;
  if (!pressedBy.has(k)) pressedBy.set(k, []);
  pressedBy.get(k).push(p);
}

const md = process.argv.includes('--md');
const panels = [...new Set(manifest.screens.map((s) => s.panel))];

const WIDTHS = [34, 9, 10, 6, 10, 12, 22];
const row = (cells) => (md
  ? `| ${cells.join(' | ')} |`
  : cells.map((c, i) => String(c).padEnd(WIDTHS[i])).join('  '));

const grand = { have: 0, exercised: 0, choice: 0, unreached: 0, broke: 0 };

for (const panel of panels) {
  const screens = manifest.screens.filter((s) => s.panel === panel);
  console.log(md ? `\n### ${panel}\n` : `\n${panel}  ${'-'.repeat(Math.max(0, 60 - panel.length))}`);
  const head = ['screen', 'controls', 'exercised', 'inert', 'by choice', 'not reached', 'verdict'];
  console.log(row(head));
  if (md) console.log(`|${head.map(() => '---').join('|')}|`);

  for (const s of [...screens].sort((a, b) => a.screen.localeCompare(b.screen))) {
    const have = s.controls.length;
    const res = pressedBy.get(`${panel}${SEP}${s.screen}`);
    if (!res) {
      grand.have += have;
      grand.unreached += have;
      console.log(row([s.screen, have, 0, 0, 0, have, 'NOT DRIVEN']));
      continue;
    }
    const by = (f) => res.filter((r) => f(r.verdict)).length;
    const exercised = by((v) => EXERCISED.has(v));
    const inert = by((v) => v === 'INERT');
    const choice = by((v) => BY_CHOICE.has(v));
    const broke = by((v) => v === 'THREW' || v === 'FIVE_HUNDRED');
    const unreached = Math.max(0, have - exercised - choice - broke);

    grand.have += have;
    grand.exercised += exercised;
    grand.choice += choice;
    grand.unreached += unreached;
    grand.broke += broke;

    // Results can now come from different runs — a filtered re-run updates one
    // screen and leaves the rest standing — so each row says how old it is.
    const when = res.map((r) => r.at).filter(Boolean).sort().pop();
    const age = when
      ? `${Math.max(0, Math.round((Date.now() - Date.parse(when)) / 3600000))}h ago`
      : 'unstamped';
    const verdict = broke ? 'BROKE' : unreached > 0 ? 'partial' : 'all pressed';
    console.log(row([s.screen, have, exercised, inert, choice, unreached, `${verdict} ${age}`]));
  }
}

if (process.argv.includes('--controls')) {
  console.log(md ? '\n### Every control, by verdict\n' : '\nevery control, by verdict');
  const byVerdict = new Map();
  for (const p of report.pressed ?? []) {
    if (!byVerdict.has(p.verdict)) byVerdict.set(p.verdict, []);
    byVerdict.get(p.verdict).push(p);
  }
  for (const [v, list] of [...byVerdict].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${v} (${list.length}) — ${MEANING[v] ?? '?'}`);
    for (const p of list.slice(0, 40)) {
      const name = p.name || 'unnamed';
      const ord = p.ordinal ? `[${p.ordinal}]` : '';
      const why = p.why ? `  — ${String(p.why).slice(0, 90)}` : '';
      console.log(`   ${p.panel}${p.screen}  ${p.kind}:${name}${ord}${why}`);
    }
    if (list.length > 40) console.log(`   ... and ${list.length - 40} more`);
  }
}

const pct = (n) => (grand.have ? `${((n / grand.have) * 100).toFixed(1)}%` : '-');
console.log(`\n${'-'.repeat(72)}`);
console.log(`${grand.have} controls across ${manifest.screens.length} screens`);
console.log(`  ${String(grand.exercised).padStart(5)}  ${pct(grand.exercised).padStart(6)}  pressed, and the screen answered`);
console.log(`  ${String(grand.choice).padStart(5)}  ${pct(grand.choice).padStart(6)}  not pressed BY CHOICE (destructive, disabled, or a repeat)`);
console.log(`  ${String(grand.unreached).padStart(5)}  ${pct(grand.unreached).padStart(6)}  NOT REACHED - this is the number that is left`);
console.log(`  ${String(grand.broke).padStart(5)}  ${pct(grand.broke).padStart(6)}  threw or 5xx'd`);
console.log(`\nmanifest ${manifest.takenAt}  ·  drive ${report.takenAt}`);
