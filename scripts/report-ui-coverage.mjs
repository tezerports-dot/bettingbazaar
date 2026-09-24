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
 *   node scripts/report-ui-coverage.mjs --out P    write the whole document to P
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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

/**
 * The two artefacts have to describe ONE platform.
 *
 * This report divides what the drive PRESSED into what the inventory says each
 * screen HAS. That division is only meaningful if both halves were taken under
 * the same configuration, and for a long time they were not: the inventory had
 * its own copy of the browser stack, so it ran without the enabled game
 * providers, without the cached merchant profile and without the rate-limit
 * budget wait. It under-counted by exactly the controls the drive arranges
 * for, and the drive then pressed controls the manifest did not know existed —
 * with no symptom anywhere, because both halves ran green.
 *
 * Both now import `stack.js`, so the configurations cannot drift. What is left
 * is the other way the two can disagree: age. A drive taken BEFORE its
 * manifest is describing a different build, and the answer is to re-run, not
 * to read the percentage. Said out loud, because a stale denominator reads
 * exactly like coverage.
 */
const SKEW_HOURS = 6;
const skew = (() => {
  const m = Date.parse(manifest.takenAt ?? ''), d = Date.parse(report.takenAt ?? '');
  if (!Number.isFinite(m) || !Number.isFinite(d)) return 'one of the two artefacts carries no timestamp';
  if (d < m) return `the drive (${report.takenAt}) is OLDER than the manifest (${manifest.takenAt})`;
  const hours = (d - m) / 3600000;
  if (hours > SKEW_HOURS) return `${hours.toFixed(1)}h between the manifest and the drive (limit ${SKEW_HOURS}h)`;
  return null;
})();
if (skew) {
  console.error(`\n!! STALE PAIR: ${skew}`);
  console.error('   These two were not taken of the same platform. Re-run both:');
  console.error('     npm run test:browser   # the denominator');
  console.error('     npm run test:drive     # what was pressed\n');
}

/** A verdict's meaning, in one line, for the legend. */
const MEANING = {
  ACTED: 'pressed, and the screen changed',
  REFETCHED: 'pressed; it called a route and got the same answer — a working Refresh',
  ALREADY_ON: 'pressed; it was already the selected segment, so nothing should change',
  INERT: 'pressed, and it changed nothing AND called nothing (S22 — the shape worth hunting)',
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
const EXERCISED = new Set(['ACTED', 'REFETCHED', 'ALREADY_ON', 'INERT']);
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

/**
 * `--out <path>` writes the document instead of printing it.
 *
 * The header is written HERE rather than kept beside the file, because a
 * generated document with a hand-maintained preamble is two things that go out
 * of step — and the half that goes stale is always the prose saying how current
 * the numbers are.
 */
const outAt = process.argv.indexOf('--out');
const outPath = outAt >= 0 ? process.argv[outAt + 1] : null;
const lines = [];
if (outPath) {
  const say = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  process.on('exit', () => {
    console.log = say;
    const taken = manifest.takenAt ? new Date(manifest.takenAt).toISOString() : 'unknown';
    const driven = (report.pressed ?? []).map((p) => p.at).filter(Boolean).sort().pop();
    writeFileSync(outPath, [
      '<!-- GENERATED by `npm run report:controls`. Do not edit by hand. -->',
      ...(skew ? ['', `> **STALE PAIR — do not read the percentages.** ${skew}. The denominator and`,
        '> the numerator were not taken of the same platform; re-run `test:browser` and `test:drive`.'] : []),
      '# Every control on every screen, and what happened when it was pressed',
      '',
      'Two artefacts, both left behind by a real browser driving the real panels:',
      '',
      `* the control INVENTORY — every control each screen has — taken ${taken}`,
      `* the DRIVE report — what happened when each was pressed — ${driven ?? 'not run'}`,
      '',
      '## How to read it, and what it does not say',
      '',
      '**The control count depends on the DATA.** A screen with fifty rows has a',
      'delete button on each of them; the same screen on an empty database has none.',
      'So a total here describes this run against this database, and two totals taken',
      'against different data are not comparable. What IS comparable is the',
      '`not reached` column: a control the pass found and did not press.',
      '',
      '**`inert` is triage, not failure.** A control that changed nothing AND called',
      'nothing is §32 S22 — the shape worth hunting — but a tab already selected is',
      'inert and correct. Read the list; do not count it.',
      '',
      '**The shell is inventoried once per panel, not per screen.** The navigation is',
      'the same links on all forty-four admin screens, and counting them per screen',
      'would put the denominator in the thousands and bury the real work.',
      '',
      lines.join('\n'),
      '',
    ].join('\n'));
  });
}
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
