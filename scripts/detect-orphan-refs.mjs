/**
 * scripts/detect-orphan-refs.mjs — the gate that catches a deleted import.
 *
 * Finds identifiers a module USES but never declares, imports, or receives as a
 * parameter: the ReferenceError a codemod leaves behind when it removes an
 * import and not its call sites.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A sweeping removal is the right way to take a dependency out — but a codemod
 * that deletes `import { getSystemConfig } …` and leaves the twenty calls to it
 * produces twenty files that PARSE, LINT and pass every unit test that does not
 * execute the specific line. The failure surfaces as a 500 on a route in
 * production, and only for the request that reaches that branch.
 *
 * The first run of this script found 29 of them across 21 files, including
 * `betsOnPostgres` on the bet-placement path and `MerchantModel` in the
 * merchant auth middleware — every merchant request answered 500.
 *
 * ── What it will and will not tell you ──────────────────────────────────────
 * There is no scope analysis here: every binding anywhere in a file is treated
 * as visible everywhere in that file. That UNDER-reports — a name declared
 * inside one function covers a use inside another — and deliberately so. A
 * detector whose findings turn into code changes must never report a name that
 * is genuinely bound; a missed one costs a later run, a false one costs a bug.
 */
import { readFileSync, globSync } from 'node:fs';

import { parse } from 'acorn';
import * as walk from 'acorn-walk';

const files = globSync('backend/**/*.js', { exclude: (p) => p.includes('node_modules') });

const GLOBALS = new Set([
  'console','process','Math','JSON','Date','Object','Array','String','Number','Boolean',
  'Promise','Set','Map','WeakMap','WeakSet','Symbol','Error','TypeError','RangeError',
  'RegExp','Buffer','URL','URLSearchParams','setTimeout','setInterval','clearTimeout',
  'clearInterval','setImmediate','globalThis','global','require','module','exports',
  '__dirname','__filename','AbortController','AbortSignal','TextEncoder','TextDecoder',
  'fetch','Response','Request','Headers','structuredClone','queueMicrotask','BigInt',
  'Intl','Reflect','Proxy','ArrayBuffer','Uint8Array','Int32Array','Float64Array',
  'isNaN','isFinite','parseInt','parseFloat','encodeURIComponent','decodeURIComponent',
  'encodeURI','decodeURI','NaN','Infinity','undefined','performance','crypto','FormData',
  'Blob','File','ReadableStream','WritableStream','TransformStream','Event','EventTarget',
  'atob','btoa','navigator','WebSocket','arguments','Function','Intl','FinalizationRegistry',
]);

const findings = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (e) {
    findings.push({ file, name: '(parse error)', line: 0, note: e.message });
    continue;
  }

  // Acorn-walk has no scope analysis, so collect every binding name in the file
  // and treat the file as one flat scope. That under-reports (a name declared in
  // one function "covers" a use in another) but never FALSELY reports, which is
  // what matters for a detector whose findings become code changes.
  const declared = new Set();
  const addPattern = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': declared.add(node.name); break;
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') addPattern(p.argument);
          else addPattern(p.value);
        } break;
      case 'ArrayPattern': node.elements.forEach(addPattern); break;
      case 'AssignmentPattern': addPattern(node.left); break;
      case 'RestElement': addPattern(node.argument); break;
      default: break;
    }
  };

  walk.full(ast, (node) => {
    if (node.type === 'VariableDeclarator') addPattern(node.id);
    else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
             || node.type === 'ArrowFunctionExpression') {
      if (node.id) declared.add(node.id.name);
      node.params.forEach(addPattern);
    } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      if (node.id) declared.add(node.id.name);
    } else if (node.type === 'ImportDeclaration') {
      for (const s of node.specifiers) declared.add(s.local.name);
    } else if (node.type === 'CatchClause') addPattern(node.param);
    else if (node.type === 'LabeledStatement') declared.add(node.label.name);
  });

  const used = new Map();
  walk.ancestor(ast, {
    Identifier(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      // Skip anything that is a name rather than a reference.
      if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
      if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
      if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return;
      if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return;
      if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier'
          || parent.type === 'ImportNamespaceSpecifier') return;
      if (parent.type === 'ExportSpecifier') return;
      if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement'
          || parent.type === 'ContinueStatement') return;
      if (!used.has(node.name)) used.set(node.name, node.loc.start.line);
    },
  });

  for (const [name, line] of used) {
    if (declared.has(name) || GLOBALS.has(name)) continue;
    findings.push({ file, name, line });
  }
}

const byName = new Map();
for (const f of findings) {
  if (!byName.has(f.name)) byName.set(f.name, []);
  byName.get(f.name).push(f);
}

const sorted = [...byName.entries()].sort((a, b) => b[1].length - a[1].length);
let total = 0;
for (const [name, hits] of sorted) {
  total += hits.length;
  console.log(`${String(hits.length).padStart(4)}  ${name}`);
  for (const h of hits.slice(0, 60)) console.log(`        ${h.file}:${h.line}${h.note ? ' — ' + h.note : ''}`);
  if (hits.length > 60) console.log(`        … and ${hits.length - 60} more`);
}
const fileCount = new Set(findings.map((f) => f.file)).size;
if (total === 0) {
  console.log('No orphaned references: every identifier used is declared, imported or a parameter.');
  process.exit(0);
}
console.log(`\n${total} orphaned reference(s) across ${fileCount} file(s)`);
console.log('Each one throws a ReferenceError the moment its line runs.');
process.exit(1);
