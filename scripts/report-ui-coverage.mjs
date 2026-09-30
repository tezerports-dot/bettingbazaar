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
  SAID: 'pressed; the panel answered with an alert() — the message is in the verdict, and an alert is not a question',
  UPSTREAM: 'pressed; an upstream the operator can fix refused, and the server SAID SO — correct behaviour, not a defect',
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
/**
 * ── What KIND of evidence each verdict is ─────────────────────────────────
 *
 * These are not five ways of saying "covered". They are five different
 * claims, and adding them together produces a number that means nothing —
 * which is the trap this grouping exists to stop. Reclassifying an `alert()`
 * from NEEDS_INPUT to SAID is a correct reading of what happened; it is NOT
 * equivalent to proving a state change. A button correctly disabled is
 * correct behaviour; it is NOT the feature behind it being tested.
 *
 * So the report keeps them apart and refuses to publish one headline
 * percentage. The goal is not 100% of anything. The goal is:
 *
 *   every meaningful behaviour has an appropriate test, or a stated reason
 *   why it cannot or should not have one.
 *
 * A category with a large number in it is a question, not an achievement:
 * REPRESENTED at 574 asks "is the first instance really representative?",
 * and STATE at 0 on a screen full of actions asks why nothing was asserted.
 */
const KIND = {
  // The strongest evidence this pass can produce on its own: the press moved
  // the screen. It is still WEAKER than a mutation case, which reads the
  // database back — `drive.report.json` cannot tell a rendered change from a
  // committed one, and does not claim to.
  SCREEN_MOVED: { verdicts: ['ACTED'], says: 'pressed, and the routed region changed' },
  // It called its route and the answer came back — a working read.
  ANSWERED: {
    verdicts: ['REFETCHED', 'UPSTREAM'],
    says: 'pressed; it called a route and the server answered, including a refusal that names what to fix',
  },
  // It told the person something. An outcome, not a state change.
  SAID: {
    verdicts: ['SAID'],
    says: 'pressed; the panel answered with an alert() — informational, and NOT evidence of a mutation',
  },
  // Nothing should have happened, and nothing did.
  NO_OP_BY_DESIGN: {
    verdicts: ['ALREADY_ON'],
    says: 'pressed; it was already the selected segment, so no change is the correct outcome',
  },
  // Nothing happened and nothing was called. Triage, and the shape worth hunting.
  INERT: {
    verdicts: ['INERT'],
    says: 'pressed; changed nothing AND called nothing — §32 S22 candidate, read the list',
  },
  // Correct state. Whether the ENABLE transition is covered is a separate
  // question, answered by the mutating pass, and a disabled control here is
  // not a claim that the feature behind it works.
  DISABLED: {
    verdicts: ['DISABLED'],
    says: 'disabled on arrival — correct state; the enable transition is a SEPARATE test',
  },
  // ── Two DIFFERENT claims, kept apart ─────────────────────────────────
  // Both mean "not pressed here", and that is where the similarity ends.
  //
  // REPEAT is an ASSUMPTION: the first instance of this name on this screen
  // stood in for it. That is usually fair (fifty rows, fifty identical
  // Delete buttons) and it is not free — row 40's button carries row 40's id,
  // and the assumption is exactly what hides a per-row defect. A large number
  // here is a question about the assumption, never a coverage figure.
  REPEAT: {
    verdicts: ['REPRESENTED', 'DUPLICATE'],
    says: 'a repeat of a name already pressed on this screen — covered ONLY IF the first instance is representative',
  },
  // DRIVEN_ELSEWHERE is a CHECKABLE claim: the mutating pass has a case for
  // it, and `npm run test:mutate` prints whether that case drove. A deferral
  // whose case does not exist is not covered, it is unpressed with a reason.
  DRIVEN_ELSEWHERE: {
    verdicts: ['DEFERRED'],
    says: 'destructive — driven by `npm run test:mutate` against its own rows; check THAT output, this is a pointer not a proof',
  },
  // Asked a question this pass will not answer blind.
  ASKED: {
    verdicts: ['NEEDS_INPUT'],
    says: 'it asked a confirm/prompt and this pass declines — answered in the mutating pass instead',
  },
  // The honest gap.
  // ── A control the press REMOVES from every other screen ──────────────
  // "Dismiss announcement" is one banner shown above all sixteen player
  // screens. The inventory is taken AT REST and sees it on every one; the
  // drive presses it on the first screen, the dismissal sticks, and it is
  // legitimately absent from the other fourteen.
  //
  // Counting those fourteen as NOT REACHED overstates the gap by 14 and
  // describes a control that was pressed twice and ACTED both times. This is
  // the mirror of `revealed` — a screen that SHRINKS when you press it — and
  // it is only claimed when the SAME kind and name ACTED elsewhere in this
  // panel in this run, which is evidence rather than an excuse.
  PRESSED_ON_ANOTHER_SCREEN: {
    verdicts: [],
    says: 'absent because an earlier press removed it platform-wide — the same control ACTED on another screen this run',
  },
  NOT_REACHED: {
    verdicts: ['GONE', 'UNREACHABLE', 'THROTTLED'],
    says: 'NOT pressed and not by choice — this is the number that is left',
  },
  BROKE: { verdicts: ['THREW', 'FIVE_HUNDRED'], says: 'threw, or the server answered 5xx with nothing to act on' },
};
/** verdict → kind, derived so a new verdict cannot be silently uncounted. */
const KIND_OF = new Map();
for (const [kind, spec] of Object.entries(KIND)) {
  for (const v of spec.verdicts) KIND_OF.set(v, kind);
}
const UNCLASSIFIED = 'UNCLASSIFIED';

// A separator that cannot occur in a panel name or a route.
const SEP = '\u0000';
const pressedBy = new Map();
/** (panel, kind, name) that ACTED somewhere — evidence for the class above. */
const actedSomewhere = new Set();
for (const p of report.pressed ?? []) {
  const k = `${p.panel}${SEP}${p.screen}`;
  if (!pressedBy.has(k)) pressedBy.set(k, []);
  pressedBy.get(k).push(p);
  if (p.verdict === 'ACTED') actedSomewhere.add(`${p.panel}${SEP}${p.kind}${SEP}${p.name}`);
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

const grand = { have: 0, exercised: 0, choice: 0, unreached: 0, broke: 0, revealed: 0 };

for (const panel of panels) {
  const screens = manifest.screens.filter((s) => s.panel === panel);
  console.log(md ? `\n### ${panel}\n` : `\n${panel}  ${'-'.repeat(Math.max(0, 60 - panel.length))}`);
  // One column per KIND of evidence. There is deliberately no "exercised"
  // column: summing these is the thing this table exists to stop.
  const head = ['screen', 'controls', 'moved', 'answered', 'said', 'no-op',
                'inert', 'disabled', 'elsewhere', 'asked', 'NOT reached', 'note'];
  console.log(row(head));
  if (md) console.log(`|${head.map(() => '---').join('|')}|`);

  for (const s of [...screens].sort((a, b) => a.screen.localeCompare(b.screen))) {
    const have = s.controls.length;
    const res = pressedBy.get(`${panel}${SEP}${s.screen}`);
    if (!res) {
      grand.have += have;
      grand.NOT_REACHED += have;
      console.log(row([s.screen, have, 0, 0, 0, 0, 0, 0, 0, 0, have, 'NOT DRIVEN']));
      continue;
    }
    // Counted BY KIND, never summed. `UNCLASSIFIED` exists so a verdict
    // nobody added to `KIND` shows up as a hole rather than vanishing.
    const n = {};
    for (const k of Object.keys(KIND)) n[k] = 0;
    n[UNCLASSIFIED] = 0;
    for (const r of res) n[KIND_OF.get(r.verdict) ?? UNCLASSIFIED] += 1;

    // ── When the drive pressed MORE than the inventory found ──────────────
    // `Math.max(0, …)` used to swallow this: a screen printed "15 controls,
    // 17 exercised, 0 not reached" and nothing said the numbers do not add up.
    // Both causes are real and both matter.
    //
    //   The two halves were taken under different platform configurations —
    //   which was live for weeks and is what `stack.js` now prevents.
    //
    //   Or the screen GROWS when you press it: `/settings` draws the load
    //   shedding and IP-defence sub-switches only once their parent toggle is
    //   on, so the drive legitimately reaches controls an inventory taken at
    //   rest can never see.
    //
    // The first is a defect and the second is worth knowing, and a silent
    // clamp reports neither. So it is counted and named.
    const accounted = res.length - n.NOT_REACHED;
    const revealed = Math.max(0, accounted - have);
    let notReached = Math.max(0, have - accounted) + n.NOT_REACHED;

    // Of the shortfall, how much is a control an earlier press removed?
    if (notReached > 0) {
      const here = new Set(res.map((r) => `${r.kind}${SEP}${r.name}${SEP}${r.ordinal}`));
      const removed = s.controls.filter((c) => !here.has(`${c.kind}${SEP}${c.name}${SEP}${c.ordinal}`)
        && actedSomewhere.has(`${panel}${SEP}${c.kind}${SEP}${c.name}`)).length;
      const take = Math.min(removed, notReached);
      n.PRESSED_ON_ANOTHER_SCREEN += take;
      notReached -= take;
    }

    grand.have += have;
    grand.revealed += revealed;
    for (const k of Object.keys(n)) grand[k] = (grand[k] ?? 0) + n[k];
    grand.NOT_REACHED = (grand.NOT_REACHED ?? 0) - n.NOT_REACHED + notReached;

    // Results can now come from different runs — a filtered re-run updates one
    // screen and leaves the rest standing — so each row says how old it is.
    const when = res.map((r) => r.at).filter(Boolean).sort().pop();
    const age = when
      ? `${Math.max(0, Math.round((Date.now() - Date.parse(when)) / 3600000))}h ago`
      : 'unstamped';
    const note = n.BROKE ? 'BROKE'
      : n[UNCLASSIFIED] ? `${n[UNCLASSIFIED]} UNCLASSIFIED verdict(s)`
      : revealed > 0 ? `+${revealed} only a press reveals`
      : notReached > 0 ? 'partial' : 'all pressed';
    console.log(row([s.screen, have, n.SCREEN_MOVED, n.ANSWERED, n.SAID, n.NO_OP_BY_DESIGN,
                     n.INERT, n.DISABLED,
                     n.REPEAT + n.DRIVEN_ELSEWHERE + n.PRESSED_ON_ANOTHER_SCREEN, n.ASKED, notReached,
                     `${note} ${age}`]));
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
console.log('');
// ── No single "coverage" figure, on purpose ──────────────────────────────
// Each line below is a DIFFERENT claim. Adding them gives a percentage that
// answers no question anybody has: an alert() read correctly and a state
// change asserted against the database are not the same evidence, and a
// button correctly disabled is not the feature behind it being tested.
//
// The question this table is for is not "what is the number" but "does every
// meaningful behaviour have an appropriate test, or a stated reason why not".
for (const [kind, spec] of Object.entries(KIND)) {
  const v = grand[kind] ?? 0;
  console.log(`  ${String(v).padStart(5)}  ${pct(v).padStart(6)}  ${kind.padEnd(18)} ${spec.says}`);
}
if (grand[UNCLASSIFIED]) {
  console.log(`  ${String(grand[UNCLASSIFIED]).padStart(5)}          UNCLASSIFIED       a verdict no KIND claims — add it to KIND, do not let it vanish`);
}
if (grand.revealed) {
  console.log(`  ${String(grand.revealed).padStart(5)}          revealed           controls only a PRESS reveals — not in the inventory, which is taken at rest`);
}
console.log(`
  STATE CHANGES are NOT counted here. This pass reads the SCREEN; it cannot
  tell a rendered change from a committed one. What proves a mutation is
  \`npm run test:mutate\`, which asserts the database and a bystander row —
  read its output beside this table, never instead of it.
`);
console.log(`\nmanifest ${manifest.takenAt}  ·  drive ${report.takenAt}`);
