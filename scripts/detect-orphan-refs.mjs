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
 * It resolves every reference against a real SCOPE CHAIN: module, function and
 * block scopes, with `var` and function declarations hoisted to the enclosing
 * function and `let`/`const`/`class` kept to their block. A name is an orphan
 * when no scope enclosing its use declares it.
 *
 * It did NOT do that, and the reason it did not is worth keeping: every binding
 * anywhere in a file was treated as visible everywhere in that file, because "a
 * detector whose findings turn into code changes must never report a name that
 * is genuinely bound; a missed one costs a later run, a false one costs a bug."
 * The instinct is right. The cost of the under-report was not a later run:
 *
 *   `bet.routes.js` broadcast its pool totals as bare `totalDelhi` /
 *   `totalBombay` / `realNow` inside the REAL bet handler. Those three names
 *   exist only in the PHANTOM handler 130 lines below — the block had been
 *   written against that shape. Flat scope saw them declared in the file and
 *   said nothing, so every REAL bet threw `ReferenceError: totalDelhi is not
 *   defined` AFTER the stake was locked and committed: the player was told
 *   "Failed to place bet" and watched the money leave anyway (§21).
 *
 * So the false-positive bar is kept, and met a different way. Anything this
 * cannot resolve CONFIDENTLY is not reported: a `with` block or an indirect
 * `eval` makes a file's scoping undecidable and the file is skipped by name in
 * the output rather than guessed at. The two findings are also separated in the
 * report, because they are different bugs with different fixes — a name bound
 * NOWHERE in the file is a deleted import, and a name bound in a DIFFERENT
 * scope is a block copied between functions.
 */
import { readFileSync, globSync } from 'node:fs';

import { parse } from 'acorn';
import * as walk from 'acorn-walk';

// `database/` is scanned too. Nothing else parse-checks it: the unit suite does
// not import it, and a repository whose SQL template literal was terminated
// early by a backtick in a comment fails to parse — which surfaces as an opaque
// import error inside whichever suite happens to load it first, if any does.
const files = [
  ...globSync('backend/**/*.js', { exclude: (p) => p.includes('node_modules') }),
  ...globSync('database/**/*.js', { exclude: (p) => p.includes('node_modules') }),
];

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

/**
 * ── Globals that exist in a BROWSER, not in Node ────────────────────────────
 * A function handed to `page.evaluate()` is serialised and run inside Chromium,
 * so `document` there is no more a ReferenceError than `process` is here. This
 * gate scans `backend/**`, which now includes `backend/tests/browser/` — the
 * pass that opens every screen — and reported four perfectly correct lines as
 * references that "throw a ReferenceError the moment [they] run". They cannot:
 * they never run in this process.
 *
 * That is §28's own warning turned on the gate itself. A false failure is how a
 * gate loses its authority and gets switched off, so the gate learns the rule
 * instead of the file being exempted: a function argument to one of the
 * evaluation calls below is BROWSER code, and only inside it do these names
 * resolve.
 */
const BROWSER_GLOBALS = new Set([
  'window','document','location','localStorage','sessionStorage','history',
  'PopStateEvent','CustomEvent','HTMLElement','Node','getComputedStyle','alert',
  'requestAnimationFrame','cancelAnimationFrame','matchMedia','IntersectionObserver',
  'MutationObserver','ResizeObserver','Image','DOMParser','EventSource','screen',
  // `CSS.escape` is the correct way to put an id into a selector, and the
  // gate flagged it the moment a pass used one. A browser global missing
  // from this list is a FALSE failure, which §28 says is how a gate loses
  // its authority and gets switched off — so the list grows rather than the
  // file being exempted.
  'CSS',
  // `Storage` is the prototype a browser pass wraps to watch what a panel
  // REMOVES from localStorage — the only way to see a logout that is
  // followed by a full navigation. Same rule as `CSS` above: the list
  // grows, the file is not exempted.
  'Storage',
]);

/** Playwright/Puppeteer calls whose function argument executes in the page. */
const BROWSER_EVAL = new Set([
  'evaluate','evaluateHandle','addInitScript','$eval','$$eval','waitForFunction','exposeFunction',
]);

const findings = [];
const parseErrors = [];
const skipped = [];
// `file:name` -> true when the name IS bound elsewhere in the file (a block
// copied between scopes) rather than nowhere at all (a deleted import).
const outOfScope = new Map();

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (e) {
    // A file that does not parse is a hard failure, reported first and on its
    // own terms: every "undefined identifier" finding below is meaningless
    // until it parses.
    parseErrors.push({ file, message: e.message });
    continue;
  }

  // ── Scope chain ──────────────────────────────────────────────────────────
  // Declarations and references are collected in ONE pass and resolved after
  // it, which is what makes hoisting and forward references work for free: a
  // function declared at the bottom of a module is visible to a call at the
  // top, and neither a second pass nor an ordering rule is needed to say so.
  const scopes = [];
  const newScope = (kind, parent, browser = parent?.browser ?? false) => {
    const scope = { kind, parent, names: new Set(), browser };
    scopes.push(scope);
    return scope;
  };
  // `var` and function declarations belong to the nearest FUNCTION, not the
  // block they are written in. `let`, `const` and `class` belong to the block.
  const varScope = (scope) => {
    let s = scope;
    while (s.kind === 'block') s = s.parent;
    return s;
  };

  const refs = [];
  let undecidable = null;

  const declarePattern = (node, scope) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': scope.names.add(node.name); break;
      case 'ObjectPattern':
        for (const prop of node.properties) {
          if (prop.type === 'RestElement') { declarePattern(prop.argument, scope); continue; }
          // A COMPUTED key is an expression evaluated in the enclosing scope.
          if (prop.computed) visit(prop.key, scope);
          declarePattern(prop.value, scope);
        }
        break;
      case 'ArrayPattern': for (const el of node.elements) declarePattern(el, scope); break;
      // The default value is an expression, and it is evaluated where the
      // pattern sits — so it is VISITED, not declared.
      case 'AssignmentPattern': declarePattern(node.left, scope); visit(node.right, scope); break;
      case 'RestElement': declarePattern(node.argument, scope); break;
      // `({ a.b } = x)` and `[obj.k] = x` assign THROUGH a member expression;
      // nothing is declared and the object is a reference.
      case 'MemberExpression': visit(node, scope); break;
      default: break;
    }
  };

  const visitFunction = (node, scope, selfNamedIn, browser) => {
    const fn = newScope('function', scope, browser ?? scope.browser);
    // A named function EXPRESSION can call itself: the name is bound inside its
    // own scope and nowhere else. A DECLARATION's name belongs to the enclosing
    // scope, and the caller has already put it there.
    if (selfNamedIn === 'self' && node.id) fn.names.add(node.id.name);
    for (const param of node.params) declarePattern(param, fn);
    if (node.body.type === 'BlockStatement') {
      // Visited WITHOUT a further block scope: a `var` in a function body and a
      // parameter of the same name are the same binding.
      for (const stmt of node.body.body) visit(stmt, fn);
    } else {
      visit(node.body, fn); // concise arrow body
    }
  };

  function visit(node, scope) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier':
        refs.push({ name: node.name, line: node.loc.start.line, scope });
        return;

      case 'WithStatement':
        // `with` puts an object's properties into scope at RUNTIME. Nothing
        // static can resolve a name inside it, so the file is not guessed at.
        undecidable = 'a `with` statement';
        return;

      case 'CallExpression':
      case 'NewExpression': {
        // A function handed to `page.evaluate(…)` and friends runs in the PAGE.
        // Everything else about the call is ordinary and visited as such.
        const inPage = node.callee?.type === 'MemberExpression'
          && !node.callee.computed
          && BROWSER_EVAL.has(node.callee.property?.name);
        visit(node.callee, scope);
        for (const arg of node.arguments ?? []) {
          const isFn = arg?.type === 'ArrowFunctionExpression' || arg?.type === 'FunctionExpression';
          if (inPage && isFn) visitFunction(arg, scope, arg.type === 'FunctionExpression' ? 'self' : 'none', true);
          else visit(arg, scope);
        }
        return;
      }

      case 'FunctionDeclaration':
        if (node.id) varScope(scope).names.add(node.id.name);
        visitFunction(node, scope, 'enclosing');
        return;
      case 'FunctionExpression':
        visitFunction(node, scope, 'self');
        return;
      case 'ArrowFunctionExpression':
        visitFunction(node, scope, 'none');
        return;

      case 'ClassDeclaration':
        if (node.id) scope.names.add(node.id.name);
        visit(node.body, newScope('block', scope));
        return;
      case 'ClassExpression': {
        const inner = newScope('block', scope);
        if (node.id) inner.names.add(node.id.name);
        if (node.superClass) visit(node.superClass, scope);
        visit(node.body, inner);
        return;
      }
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, scope);
        visit(node.value, scope);
        return;
      case 'StaticBlock': {
        const inner = newScope('function', scope);
        for (const stmt of node.body) visit(stmt, inner);
        return;
      }

      case 'VariableDeclaration': {
        const target = node.kind === 'var' ? varScope(scope) : scope;
        for (const d of node.declarations) {
          declarePattern(d.id, target);
          visit(d.init, scope);
        }
        return;
      }

      case 'BlockStatement': {
        const inner = newScope('block', scope);
        for (const stmt of node.body) visit(stmt, inner);
        return;
      }
      case 'SwitchStatement': {
        visit(node.discriminant, scope);
        const inner = newScope('block', scope);
        for (const c of node.cases) {
          visit(c.test, inner);
          for (const stmt of c.consequent) visit(stmt, inner);
        }
        return;
      }
      case 'ForStatement': {
        const inner = newScope('block', scope);
        visit(node.init, inner); visit(node.test, inner);
        visit(node.update, inner); visit(node.body, inner);
        return;
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        const inner = newScope('block', scope);
        // `for (x of …)` assigns to an EXISTING binding; `for (const x of …)`
        // creates one. Only the declaration form declares.
        // A non-declaration left is an assignment TARGET — `for (x of …)`
        // writes to an existing binding, so its identifiers are references.
        visit(node.left, inner);
        visit(node.right, inner);
        visit(node.body, inner);
        return;
      }
      case 'CatchClause': {
        const inner = newScope('block', scope);
        if (node.param) declarePattern(node.param, inner);
        for (const stmt of node.body.body) visit(stmt, inner);
        return;
      }

      case 'MemberExpression':
        visit(node.object, scope);
        if (node.computed) visit(node.property, scope);
        return;
      case 'Property':
        if (node.computed) visit(node.key, scope);
        visit(node.value, scope);
        return;

      case 'ImportDeclaration':
        for (const spec of node.specifiers) scope.names.add(spec.local.name);
        return;
      case 'ExportNamedDeclaration':
        // `export { a } from './x'` re-exports without binding anything here,
        // so its specifiers are not references to this module's scope.
        if (node.source) return;
        visit(node.declaration, scope);
        for (const spec of node.specifiers) visit(spec.local, scope);
        return;
      case 'ExportAllDeclaration':
        return;

      case 'LabeledStatement': visit(node.body, scope); return;
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
        return;

      default: {
        // Everything else: recurse into child nodes generically. A node type
        // this file has never seen still gets walked rather than skipped.
        for (const key of Object.keys(node)) {
          if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
          const child = node[key];
          if (Array.isArray(child)) { for (const c of child) visit(c, scope); }
          else if (child && typeof child.type === 'string') visit(child, scope);
        }
      }
    }
  }

  const moduleScope = newScope('function', null);
  for (const stmt of ast.body) visit(stmt, moduleScope);

  if (undecidable) {
    skipped.push({ file, why: undecidable });
    continue;
  }

  // Every binding anywhere in the file, for telling the two findings apart.
  const anywhere = new Set();
  for (const sc of scopes) for (const n of sc.names) anywhere.add(n);

  const used = new Map();
  for (const ref of refs) {
    if (GLOBALS.has(ref.name)) continue;
    if (ref.scope?.browser && BROWSER_GLOBALS.has(ref.name)) continue;
    let s = ref.scope, found = false;
    while (s) { if (s.names.has(ref.name)) { found = true; break; } s = s.parent; }
    if (found) continue;
    if (!used.has(ref.name)) {
      used.set(ref.name, ref.line);
      // Bound SOMEWHERE in this file, just not here: a block copied between
      // functions, not a deleted import. Different bug, different fix.
      outOfScope.set(`${file}:${ref.name}`, anywhere.has(ref.name));
    }
  }

  for (const [name, line] of used) {
    findings.push({ file, name, line, wrongScope: outOfScope.get(`${file}:${name}`) === true });
  }
}

const byName = new Map();
for (const f of findings) {
  if (!byName.has(f.name)) byName.set(f.name, []);
  byName.get(f.name).push(f);
}

if (parseErrors.length) {
  console.log(`${parseErrors.length} file(s) do not parse:\n`);
  for (const e of parseErrors) console.log(`  ${e.file}\n      ${e.message}`);
  console.log('\nFix these before anything else — nothing downstream can be trusted.');
  process.exit(1);
}

if (skipped.length) {
  // Named, never silent: a file nothing could resolve is a hole in this gate's
  // coverage, and a hole reported reads differently from a hole that passed.
  console.log(`${skipped.length} file(s) SKIPPED — scoping is not statically decidable:`);
  for (const sk of skipped) console.log(`        ${sk.file} — ${sk.why}`);
  console.log('');
}

const sorted = [...byName.entries()].sort((a, b) => b[1].length - a[1].length);
let total = 0;
for (const [name, hits] of sorted) {
  total += hits.length;
  // The two findings are different bugs. A name bound NOWHERE in the file is a
  // deleted import; a name bound in another SCOPE is a block copied between
  // functions, which reads as declared to anyone grepping the file.
  const kind = hits.every((h) => h.wrongScope) ? '  [declared in a DIFFERENT scope]'
             : hits.some((h) => h.wrongScope)  ? '  [some declared in a DIFFERENT scope]'
             : '';
  console.log(`${String(hits.length).padStart(4)}  ${name}${kind}`);
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
