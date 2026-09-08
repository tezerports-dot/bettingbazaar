// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Every `set: { … }` handed to the order lifecycle names a column that exists.
 *
 * ── Why this is a build gate and not a test ─────────────────────────────────
 * `transitionOrder` moves the state FIRST and writes the accompanying fields
 * SECOND, deliberately: an order must never be found in a new state without the
 * facts that justify it. The cost of that ordering is that a bad field name in
 * the `set` throws AFTER the transition has already committed. The order lands
 * in the new state, the handler's catch returns a 500, and everything the
 * handler meant to do next — including moving money — never runs.
 *
 * It has happened three times, in three different files:
 *
 *   • `resolvedAt` / `resolvedBy` in disputeResolution.admin.routes.js — every
 *     admin dispute resolution failed.
 *   • `updatedAt` in merchant.routes.js's reject handler — the endpoint 500'd
 *     on every call and no screen called it, so nothing noticed.
 *   • `resolutionNotes` + `updatedAt` in paymentOrder.routes.js's resolve
 *     handler — the admin panel's release/refund buttons marked a disputed
 *     deposit COMPLETED and never credited the player.
 *
 * Each was found by hand, one at a time, after the code shipped. A route test
 * catches it only if somebody writes one for that exact handler; two of the
 * three had none. The field names are statically visible, so this reads them
 * and refuses the build.
 *
 * ── What it does NOT prove ──────────────────────────────────────────────────
 * That the values are right, that the transition is legal, or that a handler
 * moves the money it should. Only that no `set` names a field the writer will
 * refuse.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// Derived from this file's own location — never an absolute path that assumes
// one machine's checkout. See CLAUDE.md, "No path that only works on one
// machine": a gate that only runs from one directory is not a gate.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const RECORD = join(ROOT, 'database/repositories/orders.record.js');

/** The allowlist, read from the one place that defines it. */
function settableKeys() {
  const src = readFileSync(RECORD, 'utf8');
  const at = src.indexOf('const SETTABLE = Object.freeze({');
  if (at === -1) throw new Error('verify-settable-fields: SETTABLE not found in orders.record.js');
  const body = src.slice(at, src.indexOf('\n});', at));
  const keys = new Set([...body.matchAll(/(?:^|[{,]\s*)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
  keys.delete('SETTABLE');
  return keys;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Strip comments so a `set:` quoted in prose is not mistaken for code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Top-level keys of the object literal that starts at `open`. */
function topLevelKeys(src, open) {
  let depth = 0; let i = open;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const body = src.slice(open + 1, i);
  // Drop nested literals, so `merchantSnapshot: { name }` contributes only
  // `merchantSnapshot` — the nested names belong to that value, not to a column.
  let d = 0; let flat = '';
  for (const ch of body) {
    if (ch === '{' || ch === '[') d += 1;
    if (d === 0) flat += ch;
    if (ch === '}' || ch === ']') d -= 1;
  }
  return [...new Set([...flat.matchAll(/(?:^|[,{])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]))];
}

/**
 * ── Second check: document-store methods on a PostgreSQL row ────────────────
 *
 * A repository returns a mapped plain object. It has no `.save()`, no
 * `.populate()`, no `.toObject()`, no `.lean()` — calling one is a TypeError
 * that a route's `catch` turns into a 500, and the handler writes nothing.
 *
 * `POST /dispute-orders/:orderId/escalate` assigned three fields to the object
 * and called `await order.save()`. It threw on every call, its catch had no
 * `console.error`, and the admin panel's escalate button reported "Failed to
 * escalate" — so a dispute could never be escalated and nothing anywhere said
 * why. `check:settable`'s first half could not see it: there was no `set`
 * literal, just three assignments and a method that does not exist.
 *
 * The `typeof x.toObject === 'function'` guard is allowed — that is code
 * defending itself against exactly this, not committing it.
 */
const GHOST_METHODS = /\.(save|populate|toObject|lean)\s*\(/g;
const GUARDED = /typeof\s+[\w?.]+\.(save|populate|toObject|lean)\s*===\s*['"]function['"]/;

const settable = settableKeys();
const findings = [];
const ghosts = [];

for (const file of walk(join(ROOT, 'backend'))) {
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw);

  const lines = src.split('\n');
  lines.forEach((line, i) => {
    GHOST_METHODS.lastIndex = 0;
    const hit = GHOST_METHODS.exec(line);
    // A guard may sit on the line above the call it protects.
    if (!hit || GUARDED.test(line) || GUARDED.test(lines[i - 1] ?? '')) return;
    ghosts.push({ file: relative(ROOT, file), line: i + 1, method: hit[1], src: line.trim().slice(0, 100) });
  });

  for (const m of src.matchAll(/(?:^|[^A-Za-z_$.])set\s*:\s*\{/g)) {
    const open = src.indexOf('{', m.index);
    const unknown = topLevelKeys(src, open).filter((k) => !settable.has(k));
    if (!unknown.length) continue;
    findings.push({
      file: relative(ROOT, file),
      line: src.slice(0, open).split('\n').length,
      unknown,
    });
  }
}

console.log('\nOrder lifecycle — the write contract\n');
console.log(`  settable fields declared    : ${settable.size}`);
console.log(`  set literals refused        : ${findings.length}`);
console.log(`  document-store method calls : ${ghosts.length}\n`);

if (ghosts.length) {
  for (const g of ghosts) {
    console.log(`  ✗ ${g.file}:${g.line}`);
    console.log(`      .${g.method}() does not exist on a repository row — this throws.`);
    console.log(`      ${g.src}\n`);
  }
  console.log('A repository returns a mapped plain object. Write through the');
  console.log('repository (setOrderFields, updateUser, …), not through a method');
  console.log('the object does not have.\n');
}

if (findings.length) {
  for (const f of findings) {
    console.log(`  ✗ ${f.file}:${f.line}`);
    console.log(`      setOrderFields will throw on: ${f.unknown.join(', ')}`);
    console.log('      The transition commits BEFORE this write, so the order moves and the handler 500s.\n');
  }
  console.log('Add the column to SETTABLE in database/repositories/orders.record.js,');
  console.log('or use the name that is already there. Do not delete the field silently —');
  console.log('the caller wanted it recorded.\n');
}

if (findings.length || ghosts.length) process.exit(1);

console.log('Every set literal names a real column, and nothing calls a method');
console.log('a PostgreSQL row does not have.\n');
