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

/**
 * The writers, and where each declares what it will accept.
 *
 * This compared every `set: { … }` in the backend against the ORDER lifecycle's
 * list, on the assumption that there is only ever one writer. A second
 * lifecycle briefly existed and the gate reported its perfectly valid `set` as
 * a field the ORDER writer would refuse — a FALSE failure, which is the way a
 * gate loses the reader's trust and gets silenced.
 *
 * That lifecycle is gone (USDT is served by merchants now, so it is an ordinary
 * order), and the list below is one entry again. The structure stays: a `set`
 * is checked against the writer it is actually handed to, and one handed to a
 * writer this gate does not know is REPORTED rather than passed. Restoring the
 * single-writer assumption would just re-arm the same false failure for whoever
 * adds the next lifecycle.
 */
const WRITERS = [
  {
    label: 'the order lifecycle',
    file: join(ROOT, 'database/repositories/orders.record.js'),
    declaration: 'const SETTABLE = Object.freeze({',
    // Every function that forwards a `set` to `setOrderFields`, DERIVED from
    // the lifecycle module's own exports rather than listed here. A hand-kept
    // list would miss the next state somebody adds, and the `set` behind it
    // would go unchecked — silently, which is the one outcome a gate must not
    // have.
    callsFrom: join(ROOT, 'backend/domains/payment/orderLifecycle.service.js'),
    calls: ['setOrderFields'],
    remedy: 'Add the column to SETTABLE in database/repositories/orders.record.js',
  },
];

/** One writer's allowlist, read from the one place that declares it. */
function settableKeys({ file, declaration }) {
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf(declaration);
  if (at === -1) {
    throw new Error(`verify-settable-fields: '${declaration}' not found in ${relative(ROOT, file)}`);
  }
  const body = src.slice(at, src.indexOf('\n});', at));
  const keys = new Set([...body.matchAll(/(?:^|[{,]\s*)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
  keys.delete('SETTABLE');
  keys.delete('USDT_DEPOSIT_SETTABLE');
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

/** Exported function names of a module — anything that could take a `set`. */
function exportedFunctions(file) {
  const src = readFileSync(file, 'utf8');
  return [
    ...[...src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
    // `export const assignOrder = (id, o) => transitionOrder(...)` — an arrow
    // taking two arguments is a lifecycle wrapper; a frozen object is not.
    ...[...src.matchAll(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>/gm)].map((m) => m[1]),
  ];
}

// Each writer's allowlist, and every call name that reaches it.
const writers = WRITERS.map((w) => ({
  ...w,
  keys: settableKeys(w),
  calls: [...w.calls, ...(w.callsFrom ? exportedFunctions(w.callsFrom) : [])],
}));
const byCall = new Map();
for (const w of writers) for (const name of w.calls) byCall.set(name, w);

const findings = [];
const ghosts = [];
const unattributed = [];

for (const file of walk(join(ROOT, 'backend'))) {
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw);

  // local name → the name it was exported under.
  const aliases = new Map();
  for (const imp of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of imp[1].split(',')) {
      const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (m) aliases.set(m[2], m[1]);
    }
  }

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
    const where = { file: relative(ROOT, file), line: src.slice(0, open).split('\n').length };

    // Which writer is this `set` handed to? The nearest enclosing call, found
    // by walking BACK from the literal and counting brackets — the callee is
    // whatever name sits before the `(` that is still open here.
    const callee = calleeEnclosing(src, m.index);
    // Resolved through this file's own imports: `assignOrder as
    // assignOrderState` is the SAME writer under a different local name, and a
    // gate that could not see that would report every aliased call as
    // unattributed — noise, which is how a gate gets silenced.
    const resolve = (n) => byCall.get(aliases.get(n) ?? n);
    const writer = Array.isArray(callee)
      ? callee.map(resolve).find(Boolean)
      : resolve(callee);
    if (!writer) {
      // A `set` handed to something this gate does not know is the unchecked
      // case — the exact one that has shipped three times. Reported, not
      // silently passed: a gate that ignores what it does not recognise is a
      // gate that measures nothing the day the code moves.
      unattributed.push(where);
      continue;
    }
    const unknown = topLevelKeys(src, open).filter((k) => !writer.keys.has(k));
    if (unknown.length) findings.push({ ...where, unknown, writer });
  }
}

/**
 * The name of the function call that encloses `index`.
 *
 * Walks backwards counting brackets: every `)` seen is a call already closed
 * and is skipped with its `(`; the first unmatched `(` is the one we are inside,
 * and the identifier chain before it names the callee. `db.usdtDeposits
 * .transition(` answers `transition`, so a writer is recognised however it is
 * reached. A parenthesised callee — a ternary picking between two lifecycle
 * functions — answers with every name in the group instead of one.
 */
function calleeEnclosing(src, index) {
  let depth = 0;
  for (let i = index; i >= 0; i -= 1) {
    const c = src[i];
    if (c === ')') depth += 1;
    else if (c === '(') {
      if (depth === 0) {
        const before = src.slice(Math.max(0, i - 400), i);
        const m = before.match(/([A-Za-z_$][\w$]*)\s*$/);
        if (m) return m[1];
        // `(cond ? completeOrder : cancelOrder)(id, { set: … })` — the callee is
        // a parenthesised expression, so there is no identifier immediately
        // before the `(`. Every name inside that group is a candidate; the
        // caller picks whichever is a known writer, and a ternary whose two
        // branches were DIFFERENT writers would be a real defect worth seeing.
        const group = before.match(/\(([^()]*)\)\s*$/);
        return group ? [...group[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]) : null;
      }
      depth -= 1;
    }
  }
  return null;
}

console.log('\nLifecycle writers — the write contract\n');
for (const w of writers) {
  console.log(`  ${w.label.padEnd(28)}: ${w.keys.size} settable field(s)`);
}
console.log(`  set literals refused        : ${findings.length}`);
console.log(`  set literals unattributed   : ${unattributed.length}`);
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
    console.log(`      ${f.writer.label} will throw on: ${f.unknown.join(', ')}`);
    console.log('      The transition commits BEFORE this write, so the row moves and the handler 500s.');
    console.log(`      ${f.writer.remedy},`);
    console.log('      or use the name that is already there. Do not delete the field silently —');
    console.log('      the caller wanted it recorded.\n');
  }
}

if (unattributed.length) {
  for (const u of unattributed) {
    console.log(`  ✗ ${u.file}:${u.line}`);
    console.log('      a `set` handed to a function this gate does not know about.');
    console.log('      Add it to WRITERS in scripts/verify-settable-fields.mjs, with the');
    console.log('      module that declares its columns — an unchecked `set` is the');
    console.log('      exact case this gate exists for.\n');
  }
}

if (findings.length || ghosts.length || unattributed.length) process.exit(1);

console.log('Every set literal names a real column of the writer it is handed to,');
console.log('and nothing calls a method a PostgreSQL row does not have.\n');
