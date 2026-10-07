// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which controls has nothing ever pressed — per ACCOUNT TYPE and per STATE?
 *
 * Owner, 2026-10-01: measure "every control never pressed per account type and
 * state" instead of guessing. `report:controls` answers that question for ONE
 * account per panel: the default actors `drive.js` and `mutate.js` press as.
 * Anything only another account is shown — the GHOST MODE toggle only a
 * phantom agent has, the narrower admin panel a sub-admin gets, what a
 * suspended merchant or a blocked player is left with, a phone's collapsed
 * menu — was never in that inventory, so it could never be reported missing.
 *
 * This reads every manifest the inventory wrote:
 *
 *   controls.manifest.json                 the default accounts (the denominator the drive divides)
 *   controls.manifest.<profile>.json       one panel, as one account from browser/profiles.js
 *   controls.manifest[.<profile>].phone.json   the same, at a phone's width
 *
 * and the drive's reports — `drive.report.json` for the default accounts, and
 * `drive.report.<profile>.json` for a profile pressed AS that account
 * (`BB_PROFILE=<name> npm run test:drive`) — and prints for each account:
 *
 *   ONLY HERE      controls this account sees that the default account does not.
 *                  The default drive never presses these. Where this account
 *                  has its own drive report, each is classified by the §35
 *                  kind of evidence that press produced; where it has none,
 *                  every one has NEVER been pressed by anything. The real gaps.
 *   TURNED AWAY    screens that sent this account somewhere else, and where.
 *   NOT SHOWN      how many of the default's controls this account does not get —
 *                  evidence for a permission model, not coverage of anything.
 *
 * A control's identity here is panel + screen + kind + name, without the row
 * ordinal: "is there a Block button on /users" is the question, not which row.
 *
 * ── Matching a profile's presses to its own inventory ─────────────────────
 * The inventory and the drive each seed the profile's account afresh, so a
 * name that carries a seeded identity — "Log of e2e-merch-6gqj34-10" — differs
 * between the two by the harness's per-process run token (`rid`, e2e/harness.js)
 * and by nothing else: both seed through `seedProfile` in the same order, so
 * the counter after the token is the same. That token, and only that token, is
 * ignored when a profile's drive verdict is looked up (`runFree`). It is NOT
 * ignored when an account is compared with the default: there it would merge
 * two different accounts' controls. A control the lookup cannot match reads as
 * never pressed — the failure is conservative, never a press nobody made.
 *
 *   node scripts/report-control-gaps.mjs                 summary
 *   node scripts/report-control-gaps.mjs --out <md>      the document
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { KIND, kindOf, NOT_A_PRESS, UNCLASSIFIED } from './lib/controlEvidence.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'backend/tests/browser');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : null; })();

const DEFAULT = join(DIR, 'controls.manifest.json');
const DRIVE = join(DIR, 'drive.report.json');
for (const [p, what] of [[DEFAULT, 'default control manifest (npm run test:browser)'], [DRIVE, 'drive report (npm run test:drive)']]) {
  if (!existsSync(p)) {
    console.error(`No ${what} at ${p}. Run it first — this reports what was measured, it does not measure.`);
    process.exit(1);
  }
}
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const base = read(DEFAULT);
const drive = read(DRIVE);

const SEP = '␟';
// A name carries its control's STATE in some places — an accordion's ▲/▼, a
// FAQ row's trailing "+" — and the same control open and closed is one control.
const norm = (name) => String(name || '«unnamed»').replace(/[▲▼]/g, '').replace(/\s[+−]$/, '').replace(/\s+/g, ' ').trim();
const keyOf = (panel, screen, c) => [panel, screen, c.kind, norm(c.name)].join(SEP);
const shellKey = (panel, c) => [panel, '(shell)', c.kind, norm(c.name)].join(SEP);
/** A seeded identity without the per-process run token: `e2e-<what>-<run>-<n>` → `e2e-<what>-·-<n>`. */
const runFree = (key) => key.replace(/\be2e-([A-Za-z0-9_-]+?)-[a-z0-9]{6}-(\d+)\b/g, 'e2e-$1-·-$2');

// What a drive did with each control, by identity. The strongest verdict wins
// when one name appears in several rows: one PRESS is enough to say "pressed".
// The kinds are §35's, from the one table both reports read.
const rank = (v) => {
  const k = kindOf(v);
  if (k === 'DRIVEN_ELSEWHERE') return 1;
  return NOT_A_PRESS.has(k) || k === UNCLASSIFIED ? 0 : 2;
};
const verdictsOf = (report, key = (k) => k) => {
  const by = new Map();
  for (const p of report.pressed ?? []) {
    const k = key(keyOf(p.panel, p.screen, p));
    const was = by.get(k);
    if (!was || rank(p.verdict) > rank(was)) by.set(k, p.verdict);
  }
  return by;
};
const pressedBy = verdictsOf(drive);
/** A press, in §35's sense: anything but disabled, deferred, not reached, or a verdict nobody classified. */
const isPress = (v) => v !== undefined && rank(v) === 2;

const controlsOf = (m) => {
  const map = new Map();
  for (const s of m.screens) for (const c of s.controls) map.set(keyOf(s.panel, s.screen, c), { panel: s.panel, screen: s.screen, ...c });
  for (const [panel, cs] of Object.entries(m.shell ?? {})) for (const c of cs) map.set(shellKey(panel, c), { panel, screen: '(shell)', ...c });
  return map;
};
const baseControls = controlsOf(base);

// ── The default accounts themselves: what the drive never pressed ─────────
// Never pressed means what it says: absent from the drive's report, or there
// and DISABLED / not reached. The shell is inventoried once per panel and no
// pass presses it; it is left out here as it always was.
const baseScreenControls = [...baseControls.entries()].filter(([k]) => !k.includes(`${SEP}(shell)${SEP}`));
const baseNever = baseScreenControls.filter(([k]) => {
  const v = pressedBy.get(k);
  return v === undefined || (!isPress(v) && kindOf(v) !== 'DRIVEN_ELSEWHERE');
});
const baseOnlyElsewhere = [...baseControls.entries()].filter(([k]) => kindOf(pressedBy.get(k)) === 'DRIVEN_ELSEWHERE');

const profiles = readdirSync(DIR)
  .filter((f) => /^controls\.manifest\..+\.json$/.test(f))
  .map((f) => ({ file: f, m: read(join(DIR, f)) }))
  .sort((a, b) => a.file.localeCompare(b.file));

/**
 * A profile's own drive report, if it was pressed as itself. Only at the
 * viewport the drive runs at (desktop): a phone manifest is not what it pressed.
 */
const profileDrive = (m) => {
  if ((m.viewport ?? 'desktop') !== 'desktop' || !m.profile || m.profile === 'default') return null;
  const p = join(DIR, `drive.report.${m.profile}.json`);
  if (!existsSync(p)) return null;
  const r = read(p);
  return { file: `drive.report.${m.profile}.json`, report: r, verdicts: verdictsOf(r, runFree) };
};

const L = [];
L.push('# Control coverage by account and state');
L.push('');
L.push('> **GENERATED** by `npm run report:control-gaps` from the control manifests `npm run test:browser`');
L.push('> writes, one per account (`BB_PROFILE=<name>`) and screen size (`BB_VIEWPORT=phone`), and the drive');
L.push('> reports `npm run test:drive` writes (the default accounts, and `BB_PROFILE=<name>` for an account');
L.push('> pressed as itself). Never edit by hand; re-run the inventories and drives and regenerate.');
L.push('>');
L.push('> The default drive and the mutate pass press as ONE account per panel. A control another account is');
L.push('> shown and the default is not is listed under **Only here**. Where that account was driven as itself,');
L.push('> each is classified by the §35 kind of evidence its press produced; every other one has never been');
L.push('> pressed by anything — those are the gaps. Nothing here is a claim that a control WORKS: MUTATION is');
L.push('> only `test:mutate`\'s to claim (§35).');
L.push('');
L.push('## Inputs');
L.push('');
L.push('| Manifest | Account | Viewport | Screens | Controls | Taken |');
L.push('|---|---|---|---|---|---|');
L.push(`| \`controls.manifest.json\` | default — ${base.profileWhat ?? 'the accounts the drive and mutate passes press as'} | ${base.viewport ?? 'desktop'} | ${base.screens.length} | ${baseControls.size} | ${base.takenAt} |`);
for (const { file, m } of profiles) {
  L.push(`| \`${file}\` | **${m.profile}** — ${m.profileWhat ?? ''} | ${m.viewport ?? 'desktop'} | ${m.screens.length} | ${controlsOf(m).size} | ${m.takenAt} |`);
}
L.push('');
L.push(`Drive report (default accounts): ${drive.pressed.length} presses, taken ${drive.takenAt}.`);
if (new Date(drive.takenAt) < new Date(base.takenAt)) {
  L.push('');
  L.push('**The drive report is OLDER than the default manifest** — it describes an earlier build. Re-run `test:drive` before reading the default-account numbers.');
}
for (const { m } of profiles) {
  const d = profileDrive(m);
  if (!d) continue;
  L.push('');
  L.push(`Drive report as **${m.profile}** (\`${d.file}\`): ${d.report.pressed.length} presses, taken ${d.report.takenAt}.`
    + (new Date(d.report.takenAt) < new Date(m.takenAt)
      ? ' **OLDER than this account\'s manifest** — re-run `BB_PROFILE=' + m.profile + ' npm run test:drive`.' : ''));
}
L.push('');

/** The §35 kind for one only-here control of an account driven as itself. */
const KIND_ORDER = [...Object.keys(KIND), UNCLASSIFIED, 'NEVER_PRESSED'];
const kindFor = (d, k, c) => {
  if (c.screen === '(shell)') return 'NOT_REACHED';           // no pass presses the shell
  const v = d.verdicts.get(runFree(k));
  return v === undefined ? 'NOT_REACHED' : kindOf(v);
};
const kindLine = (counts) => KIND_ORDER.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(' · ') || 'none';

const summary = [];
const allNever = new Map();
const sections = [];

for (const { m } of profiles) {
  const mine = controlsOf(m);
  const panels = new Set(m.screens.map((s) => s.panel));
  const basePanel = new Map([...baseControls].filter(([, c]) => panels.has(c.panel)));
  const onlyHere = [...mine.entries()].filter(([k]) => !baseControls.has(k));
  const notShown = [...basePanel.keys()].filter((k) => !mine.has(k));
  const turned = m.screens.filter((s) => s.seen?.url && !sameScreen(s));
  const d = profileDrive(m);
  const distinctOf = (list) => new Set(list.map(([, c]) => [c.panel, c.kind, norm(c.name)].join(SEP))).size;

  // Per slot: the kind of evidence its press as this account produced, or
  // NEVER_PRESSED when nothing pressed as this account at all.
  const kinds = new Map(onlyHere.map(([k, c]) => [k, d ? kindFor(d, k, c) : 'NEVER_PRESSED']));
  const pressedSlot = ([k]) => {
    const kd = kinds.get(k);
    return kd !== 'NEVER_PRESSED' && kd !== UNCLASSIFIED && !NOT_A_PRESS.has(kd);
  };
  const deferredSlot = ([k]) => kinds.get(k) === 'DRIVEN_ELSEWHERE';
  const never = onlyHere.filter((e) => !pressedSlot(e) && !deferredSlot(e));
  for (const [k, c] of never) {
    const was = allNever.get(k) ?? { ...c, who: [] };
    was.who.push(`${m.profile}${m.viewport === 'phone' ? '@phone' : ''}`);
    allNever.set(k, was);
  }
  const counts = {};
  for (const kd of kinds.values()) counts[kd] = (counts[kd] ?? 0) + 1;

  const label = `${m.profile}${m.viewport === 'phone' ? ' (phone)' : ''}`;
  summary.push({
    label, panel: [...panels].join(', '), what: m.profileWhat ?? '', screens: m.screens.length, controls: mine.size,
    onlyHere: distinctOf(onlyHere), onlyHereSlots: onlyHere.length,
    drivenAsItself: Boolean(d),
    never: distinctOf(never), neverSlots: never.length,
    notShown: notShown.length, turned: turned.length, counts,
  });

  const S = [];
  S.push(`### ${label}`);
  S.push('');
  S.push(`${m.profileWhat ?? ''} — ${[...panels].join(', ')}, ${m.viewport ?? 'desktop'}, taken ${m.takenAt}.`);
  S.push('');
  if (d) {
    S.push(`**Only here: ${distinctOf(onlyHere)} distinct control(s), on ${onlyHere.length} screen slot(s). Pressed as this account`
      + ` by \`BB_PROFILE=${m.profile} npm run test:drive\` (${d.report.takenAt}), per slot, by kind of evidence:`
      + ` ${kindLine(counts)}.** Never pressed by anything: ${distinctOf(never)} distinct (${never.length} slots).`
      + ` Not shown to this account (the default sees them): ${notShown.length}. Screens that sent it elsewhere: ${turned.length}.`);
    S.push('');
    S.push('No kind here is MUTATION: the drive reads the screen, not the database. DRIVEN_ELSEWHERE is a pointer to'
      + ' `test:mutate`, not a proof; read that pass\'s output for the case. The shell is pressed by no pass, so a shell'
      + ' control counts as NOT_REACHED.');
  } else {
    S.push(`**Only here, never pressed by anything: ${distinctOf(onlyHere)} distinct control(s), on ${onlyHere.length} screen slot(s).** Not shown to this account (the default sees them): ${notShown.length}. Screens that sent it elsewhere: ${turned.length}.`);
  }
  S.push('');
  if (onlyHere.length) {
    // The same control on many screens (a shell link, the no-access screen's
    // way out) is ONE control, listed once with the screens it is on.
    const groups = new Map();
    for (const [k, c] of onlyHere) {
      const g0 = [c.panel, c.kind, norm(c.name)].join(SEP);
      const g = groups.get(g0) ?? groups.set(g0, { ...c, screens: [], kinds: [] }).get(g0);
      g.screens.push(c.screen);
      g.kinds.push(kinds.get(k));
    }
    S.push(d ? '| Screen(s) | Kind | Control | Pressed as this account |' : '| Screen(s) | Kind | Control |');
    S.push(d ? '|---|---|---|---|' : '|---|---|---|');
    for (const g of [...groups.values()].sort((a, b) => a.screens[0].localeCompare(b.screens[0]))) {
      const where = g.screens.length > 3
        ? `${g.screens.length} screens (${g.screens.slice(0, 3).map((x) => `\`${x}\``).join(', ')} …)`
        : g.screens.map((x) => `\`${x}\``).join(', ');
      const evidence = [...new Set(g.kinds)].join(', ');
      S.push(`| ${where} | ${g.kind} | ${cell(g.name || '«unnamed»')}${g.disabled ? ' *(disabled)*' : ''} |${d ? ` ${evidence} |` : ''}`);
    }
    S.push('');
  }
  if (turned.length) {
    S.push('Screens that did not stay where they were opened:');
    S.push('');
    S.push('| Opened | Landed on | What it said |');
    S.push('|---|---|---|');
    for (const s of turned) S.push(`| \`${s.screen}\` | \`${s.seen.url}\` | ${cell(s.seen.heading || s.seen.excerpt.slice(0, 90))} |`);
    S.push('');
  }
  const perScreen = m.screens.map((s) => ({ s, base: base.screens.find((b) => b.panel === s.panel && b.screen === s.screen) }))
    .filter(({ s, base: b }) => b && Math.abs(b.controls.length - s.controls.length) > 0);
  if (perScreen.length) {
    S.push('<details><summary>Per screen: controls this account saw against the default</summary>');
    S.push('');
    S.push('| Screen | This account | Default | What the screen said |');
    S.push('|---|---|---|---|');
    for (const { s, base: b } of perScreen) S.push(`| \`${s.screen}\` | ${s.controls.length} | ${b.controls.length} | ${cell((s.seen?.heading || s.seen?.excerpt || '').slice(0, 90))} |`);
    S.push('');
    S.push('</details>');
    S.push('');
  }
  sections.push(S.join('\n'));
}

L.push('## Summary');
L.push('');
// The kinds stay apart (§35): the drive-as-itself column lists each kind with
// its own count, per screen slot, and never sums them into one "pressed".
L.push('| Account | Panel | Screens | Controls seen | Only here | Only here, driven as this account (per slot, by kind) | **Only here, never pressed** | Default\'s controls not shown | Screens that sent it elsewhere |');
L.push('|---|---|---|---|---|---|---|---|---|');
for (const r of summary) {
  const driven = r.drivenAsItself ? `${kindLine(r.counts)} (of ${r.onlyHereSlots} slots)` : 'not driven as itself';
  L.push(`| ${r.label} | ${r.panel} | ${r.screens} | ${r.controls} | ${r.onlyHere} | ${driven} | **${r.never}** | ${r.notShown} | ${r.turned} |`);
}
L.push('');
const allDistinct = new Set([...allNever.values()].map((c) => [c.panel, c.kind, norm(c.name)].join(SEP))).size;
L.push(`Distinct controls that exist only for some non-default account or screen size, and that nothing has pressed: **${allDistinct}** (on ${allNever.size} screen slots).`);
L.push('');
L.push(`The default accounts: ${baseControls.size} controls inventoried; ${baseNever.length} on screens never pressed by the drive (absent from its report, or DISABLED/GONE/UNREACHABLE/THROTTLED), and ${baseOnlyElsewhere.length} deferred to a mutating case (DRIVEN_ELSEWHERE — a pointer, not a proof, §35.1).`);
L.push('');
L.push('## Per account');
L.push('');
L.push(sections.join('\n'));
L.push('## The default accounts: controls the drive never pressed');
L.push('');
L.push(baseNever.length ? '| Screen | Kind | Control | Drive verdict |\n|---|---|---|---|' : 'None.');
for (const [k, c] of baseNever.sort(([a], [b]) => a.localeCompare(b))) {
  L.push(`| \`${c.panel}${c.screen}\` | ${c.kind} | ${cell(c.name || '«unnamed»')} | ${pressedBy.get(k) ?? 'not in the report'} |`);
}
L.push('');

function sameScreen(s) {
  const want = s.screen.replace(/\/$/, '');
  const url = s.seen.url;
  // hash routers carry the screen after '#', history routers in the path.
  const got = (url.includes('#') ? url.split('#')[1] : url.replace(/^\/(merchant|admin)/, '')).split('?')[0].replace(/\/$/, '');
  return got === want || (want === '' && got === '');
}
function cell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

const doc = `${L.join('\n')}\n`;
if (OUT) { writeFileSync(OUT, doc); console.log(`Wrote ${OUT}`); }
console.log(`default: ${baseControls.size} controls, ${baseNever.length} never pressed by the drive`);
for (const r of summary) {
  console.log(`  ${r.label.padEnd(26)} ${String(r.controls).padStart(5)} seen  ${String(r.onlyHere).padStart(4)} ONLY HERE`
    + `  ${String(r.never).padStart(4)} never pressed  ${String(r.notShown).padStart(5)} not shown  ${r.turned} turned away`
    + (r.drivenAsItself ? `\n  ${' '.repeat(26)} driven as itself, per only-here slot: ${kindLine(r.counts)}` : ''));
}
console.log(`distinct controls only some account has, never pressed: ${allDistinct} (${allNever.size} screen slots)`);
