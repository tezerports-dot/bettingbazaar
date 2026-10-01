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
 * and `drive.report.json`, and prints for each account:
 *
 *   ONLY HERE      controls this account sees that the default account does not.
 *                  Nothing presses as anyone but the default, so every one of
 *                  these has NEVER been pressed by anything. The real gaps.
 *   TURNED AWAY    screens that sent this account somewhere else, and where.
 *   NOT SHOWN      how many of the default's controls this account does not get —
 *                  evidence for a permission model, not coverage of anything.
 *
 * A control's identity here is panel + screen + kind + name, without the row
 * ordinal: "is there a Block button on /users" is the question, not which row.
 *
 *   node scripts/report-control-gaps.mjs                 summary
 *   node scripts/report-control-gaps.mjs --out <md>      the document
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

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

// What the drive did with each control, by identity. The strongest verdict wins
// when one name appears in several rows: one PRESS is enough to say "pressed".
const PRESSED = new Set(['ACTED', 'ALREADY_ON', 'SAID', 'REFETCHED', 'UPSTREAM', 'NEEDS_INPUT', 'INERT', 'REPRESENTED', 'DUPLICATE']);
const ELSEWHERE = new Set(['DEFERRED']);
const pressedBy = new Map();
for (const p of drive.pressed) {
  const k = keyOf(p.panel, p.screen, p);
  const was = pressedBy.get(k);
  const rank = (v) => (PRESSED.has(v) ? 2 : ELSEWHERE.has(v) ? 1 : 0);
  if (!was || rank(p.verdict) > rank(was)) pressedBy.set(k, p.verdict);
}

const controlsOf = (m) => {
  const map = new Map();
  for (const s of m.screens) for (const c of s.controls) map.set(keyOf(s.panel, s.screen, c), { panel: s.panel, screen: s.screen, ...c });
  for (const [panel, cs] of Object.entries(m.shell ?? {})) for (const c of cs) map.set(shellKey(panel, c), { panel, screen: '(shell)', ...c });
  return map;
};
const baseControls = controlsOf(base);

// ── The default accounts themselves: what the drive never pressed ─────────
const baseNever = [...baseControls.entries()].filter(([k]) => !pressedBy.has(k) && !k.includes(`${SEP}(shell)${SEP}`));
const baseOnlyElsewhere = [...baseControls.entries()].filter(([k]) => ELSEWHERE.has(pressedBy.get(k)));

const profiles = readdirSync(DIR)
  .filter((f) => /^controls\.manifest\..+\.json$/.test(f))
  .map((f) => ({ file: f, m: read(join(DIR, f)) }))
  .sort((a, b) => a.file.localeCompare(b.file));

const L = [];
L.push('# Control coverage by account and state');
L.push('');
L.push('> **GENERATED** by `npm run report:control-gaps` from the control manifests `npm run test:browser`');
L.push('> writes, one per account (`BB_PROFILE=<name>`) and screen size (`BB_VIEWPORT=phone`), and the drive');
L.push('> report. Never edit by hand; re-run the inventories and regenerate.');
L.push('>');
L.push('> The drive and mutate passes press as ONE account per panel. A control another account is shown');
L.push('> and the default is not has therefore never been pressed by anything — those are listed under');
L.push('> **Only here**, and they are the gaps. Nothing here is a claim that a control WORKS (§35).');
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
L.push(`Drive report: ${drive.pressed.length} presses, taken ${drive.takenAt}.`);
if (new Date(drive.takenAt) < new Date(base.takenAt)) {
  L.push('');
  L.push('**The drive report is OLDER than the default manifest** — it describes an earlier build. Re-run `test:drive` before reading the default-account numbers.');
}
L.push('');

const summary = [];
const allOnlyHere = new Map();
const sections = [];

for (const { file, m } of profiles) {
  const mine = controlsOf(m);
  const panels = new Set(m.screens.map((s) => s.panel));
  const basePanel = new Map([...baseControls].filter(([, c]) => panels.has(c.panel)));
  const onlyHere = [...mine.entries()].filter(([k]) => !baseControls.has(k));
  const notShown = [...basePanel.keys()].filter((k) => !mine.has(k));
  const turned = m.screens.filter((s) => s.seen?.url && !sameScreen(s));
  for (const [k, c] of onlyHere) {
    const was = allOnlyHere.get(k) ?? { ...c, who: [] };
    was.who.push(`${m.profile}${m.viewport === 'phone' ? '@phone' : ''}`);
    allOnlyHere.set(k, was);
  }
  const label = `${m.profile}${m.viewport === 'phone' ? ' (phone)' : ''}`;
  summary.push({ label, panel: [...panels].join(', '), what: m.profileWhat ?? '', screens: m.screens.length, controls: mine.size, onlyHere: onlyHere.length, notShown: notShown.length, turned: turned.length });

  const S = [];
  S.push(`### ${label}`);
  S.push('');
  S.push(`${m.profileWhat ?? ''} — ${[...panels].join(', ')}, ${m.viewport ?? 'desktop'}, taken ${m.takenAt}.`);
  S.push('');
  S.push(`**Only here, never pressed by anything: ${onlyHere.length}.** Not shown to this account (the default sees them): ${notShown.length}. Screens that sent it elsewhere: ${turned.length}.`);
  S.push('');
  if (onlyHere.length) {
    S.push('| Screen | Kind | Control |');
    S.push('|---|---|---|');
    for (const [, c] of onlyHere.sort(([a], [b]) => a.localeCompare(b))) S.push(`| \`${c.screen}\` | ${c.kind} | ${cell(c.name || '«unnamed»')}${c.disabled ? ' *(disabled)*' : ''} |`);
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
L.push('| Account | Panel | Screens | Controls seen | **Only here (never pressed)** | Default\'s controls not shown | Screens that sent it elsewhere |');
L.push('|---|---|---|---|---|---|---|');
for (const r of summary) L.push(`| ${r.label} | ${r.panel} | ${r.screens} | ${r.controls} | **${r.onlyHere}** | ${r.notShown} | ${r.turned} |`);
L.push('');
L.push(`Distinct controls that exist only for some non-default account, and that nothing has pressed: **${allOnlyHere.size}**.`);
L.push('');
L.push(`The default accounts: ${baseControls.size} controls inventoried; ${baseNever.length} never pressed by the drive at all (absent from its report, or DISABLED/GONE/UNREACHABLE), and ${baseOnlyElsewhere.length} deferred to a mutating case (DRIVEN_ELSEWHERE — a pointer, not a proof, §35.1).`);
L.push('');
L.push('## Per account');
L.push('');
L.push(sections.join('\n'));
L.push('## The default accounts: controls the drive never pressed');
L.push('');
L.push(baseNever.length ? '| Screen | Kind | Control | Drive verdict |\n|---|---|---|---|' : 'None.');
for (const [k, c] of baseNever.sort(([a], [b]) => a.localeCompare(b))) {
  L.push(`| \`${c.panel}${c.screen}\` | ${c.kind} | ${cell(c.name || '«unnamed»')} | ${drive.pressed.find((p) => keyOf(p.panel, p.screen, p) === k)?.verdict ?? 'not in the report'} |`);
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
for (const r of summary) console.log(`  ${r.label.padEnd(26)} ${String(r.controls).padStart(5)} seen  ${String(r.onlyHere).padStart(4)} ONLY HERE  ${String(r.notShown).padStart(5)} not shown  ${r.turned} turned away`);
console.log(`distinct controls only some account has, never pressed: ${allOnlyHere.size}`);
