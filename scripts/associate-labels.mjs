// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Associate every `<label>` with the control it names.
 *
 * ── What it found, and why that is a defect rather than a tidy-up ──────────
 * The browser pass inventories every control a person can touch, by the name a
 * screen reader would give it. 202 admin controls came back with NO NAME AT
 * ALL, 61 of them on System Settings — the screen where §21 says an operator
 * types the platform's business numbers. The markup is
 *
 *     <label className="label">Min Deposit Amount (Rs.)</label>
 *     <input type="number" value={…} onChange={…} className="input" />
 *
 * The text is on screen, so it looks labelled. It is not ASSOCIATED: no
 * `htmlFor`, no `id`, no `name`, no `placeholder`, no `aria-label`. Three
 * consequences, in order of how much they matter:
 *
 *   1. A screen reader announces "spin button" thirty times over. An operator
 *      using one cannot tell the deposit floor from the withdrawal floor.
 *   2. Clicking the label does not focus the field — every browser gives you
 *      that for free once they are associated, and this gave it up.
 *   3. Nothing can address the field by name, so no test — and no browser pass
 *      — can type into it. Untestable and unusable have the same cause here.
 *
 * ── What this touches, and what it refuses to ──────────────────────────────
 * ONLY the exact shape above: a `<label>` with literal text, immediately
 * followed by a sibling `<input>`, `<select>` or `<textarea>` that has no `id`
 * of its own. It gives the control an id derived from the label's own words —
 * one owner for the name, not a second copy of the text (§5) — and points the
 * label at it.
 *
 * Anything else it REPORTS and leaves alone: a label with interpolated text, a
 * control that already has an id, two controls under one label. A codemod that
 * guesses at the rest is how a screen quietly loses a field.
 *
 *     node scripts/associate-labels.mjs            # report only
 *     node scripts/associate-labels.mjs --write    # apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRITE = process.argv.includes('--write');

const files = ['user-panel', 'admin-panel', 'merchant-panel'].flatMap((p) =>
  globSync(join(ROOT, p, 'src', '**', '*.tsx'), { exclude: (f) => f.includes('node_modules') }));

/** `Min Deposit Amount (Rs.)` -> `min-deposit-amount-rs`. */
const slug = (text) => text
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'field';

// <label …>TEXT</label> then whitespace then <input|select|textarea …
const PAIR = /(<label\b([^>]*)>)([^<>{}]+?)(<\/label>)(\s*)(<(input|select|textarea)\b)/g;

let changed = 0, skipped = 0, filesTouched = 0;
const skipReasons = new Map();

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('<label')) continue;

  const used = new Set([...src.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  let localChanged = 0;

  const out = src.replace(PAIR, (whole, openTag, attrs, text, closeTag, gap, ctrlOpen) => {
    const label = text.trim();
    if (!label) { skipped++; bump('the label has no literal text'); return whole; }
    if (/htmlFor=/.test(attrs)) { skipped++; bump('already associated'); return whole; }

    // The control's own attributes, up to the end of its opening tag.
    const rest = src.slice(src.indexOf(whole) + whole.length);
    const tagEnd = rest.search(/\/?>/);
    const ctrlAttrs = tagEnd === -1 ? '' : rest.slice(0, tagEnd);
    if (/\bid=/.test(ctrlAttrs)) { skipped++; bump('the control already has an id'); return whole; }

    let id = slug(label);
    for (let n = 2; used.has(id); n++) id = `${slug(label)}-${n}`;
    used.add(id);
    localChanged++;
    return `${openTag.slice(0, -1)} htmlFor="${id}">${text}${closeTag}${gap}${ctrlOpen} id="${id}"`;
  });

  if (localChanged) {
    changed += localChanged;
    filesTouched++;
    console.log(`${String(localChanged).padStart(3)}  ${relative(ROOT, file)}`);
    if (WRITE) writeFileSync(file, out);
  }
}

function bump(why) { skipReasons.set(why, (skipReasons.get(why) ?? 0) + 1); }

console.log(`\n${changed} label(s) associated across ${filesTouched} file(s)${WRITE ? '' : ' — DRY RUN, pass --write'}`);
if (skipped) {
  console.log(`${skipped} left alone, deliberately:`);
  for (const [why, n] of [...skipReasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${why}`);
  }
  console.log('These need a person: guessing at them is how a screen loses a field.');
}
