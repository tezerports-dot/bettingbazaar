#!/usr/bin/env node
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * verify-ui-coverage.mjs — the panels and the API agree about what exists.
 *
 * Two failures hide from every other check in this repo, because each half is
 * individually correct:
 *
 *   DEAD BUTTON  a panel calls a path the API does not serve. The request
 *                404s, the component catches it, and the screen renders its
 *                empty state. It looks like "no data", not like a bug. Five of
 *                these were live at once: the Payment Control Center's dispute
 *                queue and its resolve button, merchant concurrency limits,
 *                promo image upload, and every merchant's order history. Three
 *                shared one cause — handlers moved out from under a `/queue`
 *                prefix and the panel was never updated. Nothing failed: not a
 *                test, not a typecheck, not CI. A route test proves the handler
 *                works; it cannot prove anyone calls it correctly.
 *
 *   NO UI        the API serves something no panel calls. Harmless on its own,
 *                but it is how a feature gets built, tested, merged and then
 *                quietly never shipped.
 *
 * Only DEAD BUTTON fails the build — it is a defect a user can hit today. NO UI
 * is reported for triage, because plenty of it is legitimate: webhooks, SSE,
 * and endpoints deliberately built ahead of their screens.
 *
 *   node scripts/verify-ui-coverage.mjs           dead buttons only (CI)
 *   node scripts/verify-ui-coverage.mjs --unused  also list endpoints with no UI
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// Balanced-bracket call extraction, shared with the privacy gates. A regex that
// stops at the first `);` stops inside `createSubnetLimiter('auth')`.
import { callsTo, blankComments } from './lib/privacyLists.mjs';
// Derived from this file's own location, never a hardcoded path: the first
// version carried the author's checkout path and so could only run there.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const walk = (d, re, acc = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (['node_modules','dist','.git','build','coverage'].includes(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, re, acc); else if (re.test(e.name)) acc.push(p);
  } return acc;
};
const clean = p => ('/' + p.replace(/^\/+|\/+$/g,'')).replace(/\/{2,}/g,'/');

const ADMIN_INDEX = readFileSync(join(ROOT,'backend/routes/admin/index.js'),'utf8');
const adminMounted = new Set([...ADMIN_INDEX.matchAll(/^import\s+\w+\s+from\s+'([^']+)'/gm)].map(m=>m[1])
  .filter(p=>p.endsWith('.routes.js'))
  .map(p=>p.replace(/^\.\.\/\.\.\//,'backend/').replace(/^\.\//,'backend/routes/admin/')));
/**
 * Where each router is mounted — DERIVED from server.js, not listed here.
 *
 * This was a hand-written table mapping router file to prefix: a second
 * declaration of something server.js already states, and therefore something
 * that drifts. It drifted the first time a router was added — the routes were
 * mounted and served, the panel called them, and this gate reported eight DEAD
 * BUTTONS because its table had never heard of the file. A gate whose failure
 * mode is "the author forgot to update me" reports the author, not the code.
 *
 * So the two statements server.js already makes are read together:
 *
 *     import usdtDepositRoutes from './domains/funding/usdtDeposit.routes.js';
 *     app.use('/api/payment', usdtDepositRoutes);
 *
 * A router mounted twice under different prefixes gets BOTH, because both are
 * real: `payment-config.routes.js` and `payment.routes.js` share `/api/payment`
 * today and nothing stops a future router serving two.
 */
const SERVER = readFileSync(join(ROOT,'backend/server.js'),'utf8');
const importedAs = new Map();  // local name → repo-relative router file
for (const m of SERVER.matchAll(/^import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s+from\s+'(\.[^']+\.js)'/gm)) {
  const file = clean('backend/' + m[2].replace(/^\.\//,'')).slice(1);
  if (file.endsWith('.routes.js') || file.endsWith('/routes.js')) importedAs.set(m[1], file);
}
const PREFIX = {};
// `app.use('<prefix>', a, b, router)` — the prefix is the first string literal
// and the router is the last argument that names an imported router. The
// middleware between them is not one.
//
// The arguments are extracted by BALANCED BRACKETS, through the same helper the
// privacy gates use. A regex ending at the first `);` stops inside
// `createSubnetLimiter('auth')` and loses the router behind it — which is how a
// first attempt at this derivation reported the auth routes as unserved.
for (const call of callsTo(blankComments(SERVER), 'app.use')) {
  const prefix = call.args.match(/^\s*'([^']*)'/);
  if (!prefix) continue;
  const names = [...call.args.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((x) => x[1]);
  const router = names.reverse().find((n) => importedAs.has(n));
  if (!router) continue;
  const file = importedAs.get(router);
  const at = prefix[1].replace(/\/+$/, '');
  if (!(PREFIX[file] ??= []).includes(at)) PREFIX[file].push(at);
}
/**
 * Routers that server.js does NOT mount with `app.use`, and where they land.
 *
 * One entry, with its reason. `sse.routes.js` exports `initSSERoutes(app)` — a
 * function that registers its own handlers, because an SSE stream needs the
 * response object held open and the manager attached before any request
 * arrives. There is no `app.use('<prefix>', router)` to read, so this says
 * where it goes. Adding a line here is a decision somebody made.
 */
const MOUNTED_BY_FUNCTION = {
  'backend/routes/sse.routes.js': ['/api/sse'],
};
for (const [file, at] of Object.entries(MOUNTED_BY_FUNCTION)) PREFIX[file] ??= at;

// A router the panel can reach but that this gate cannot locate is a hole in
// the check, not a pass. Say so rather than silently serving fewer routes.
if (!Object.keys(PREFIX).length) {
  console.error('verify-ui-coverage: could not derive any router mount from server.js — the check would pass vacuously.');
  process.exit(1);
}
// Backend routes as matchers.
const routes = [];
for (const f of walk(join(ROOT,'backend'), /\.routes\.js$|^routes\.js$/)) {
  const rel = relative(ROOT,f);
  const prefixes = PREFIX[rel] ?? (adminMounted.has(rel) ? ['/api/admin'] : null);
  if (prefixes === null) continue;
  for (const m of readFileSync(f,'utf8').matchAll(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)) {
   for (const prefix of prefixes) {
    const path = clean(prefix + '/' + m[2]);
    const re = new RegExp('^' + path.split('/').filter(Boolean)
      .map(s => s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))
      .map(s=>'/'+s).join('') + '$');
    routes.push({ method: m[1].toUpperCase(), path, re, rel });
   }
  }
}
// Also: routes declared directly on the app in server.js (app.post('/api/admin/login', ...)).
{
  const src = SERVER;
  for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)) {
    const path = clean(m[2]);
    const re = new RegExp('^' + path.split('/').filter(Boolean)
      .map(x => x.startsWith(':') ? '[^/]+' : x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))
      .map(x=>'/'+x).join('') + '$');
    routes.push({ method: m[1].toUpperCase(), path, re, rel: 'backend/server.js' });
  }
}

// Frontend calls, with method.
const PANELS = { admin:'admin-panel/src', merchant:'merchant-panel/src', user:'user-panel/src' };
const dead = [];
for (const [panel, dir] of Object.entries(PANELS)) {
  for (const f of walk(join(ROOT,dir), /\.(ts|tsx|js|jsx)$/)) {
    const src = readFileSync(f,'utf8');
    for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\s*(?:<[^>(]*>)?\(\s*['"`]([^'"`]*\/[^'"`]*)['"`]/g)) {
      let raw = m[2];
      if (!raw.startsWith('/')) continue;
      const method = m[1].toUpperCase();
      // strip query, wildcard template params
      const probe = clean(raw.split('?')[0]).replace(/\$\{[^}]*\}/g,'X');
      const cands = probe.startsWith('/api') ? [probe] : [probe, clean('/api'+probe)];
      const hit = cands.some(c => routes.some(r => r.method===method && r.re.test(c)));
      if (!hit) dead.push({ panel, file: relative(ROOT,f), method, path: probe });
    }
  }
}
// ── The same check for panels that do NOT write the path at the call site ───
//
// The scan above matches `api.post('/api/...')` — the path as the first
// argument of the HTTP verb. The merchant panel does not write a single call
// that way: every path lives in `constants.ts` as `ENDPOINTS.X.Y`, and the call
// is `request(ENDPOINTS.X.Y(id), { method: 'POST' })`. So the whole panel was
// exempt from the fatal half of this gate, and a path that 404s sat there while
// the check reported zero dead buttons.
//
// It was found by the INFORMATIONAL `--unused` half, which greps the panel
// sources as text — the route showed up as "no UI calls this" because the
// constant named `/api/upload/merchant/…` while `upload.routes.js` is mounted
// at `/api`. That is the wrong way round: the triage list caught a live 404 the
// build-failing check did not.
//
// So: any string in a panel that LOOKS like an API path must resolve to a route.
// The method is unknown in this form, so it matches on path alone — a path no
// route serves at all is a dead button whatever verb it is called with.
for (const [panel, dir] of Object.entries(PANELS)) {
  for (const f of walk(join(ROOT,dir), /\.(ts|tsx|js|jsx)$/)) {
    // Comments mention endpoints constantly — and a mention is not a call.
    const src = readFileSync(f,'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/['"`](\/api\/[^'"`\s]*)['"`]/g)) {
      const probe = clean(m[1].split('?')[0]).replace(/\$\{[^}]*\}/g,'X');
      if (routes.some(r => r.re.test(probe))) continue;
      dead.push({ panel, file: relative(ROOT,f), method: 'ANY', path: probe });
    }
  }
}

const seen = new Set(), uniq = [];
for (const d of dead) { const k = `${d.panel} ${d.method} ${d.path}`; if (!seen.has(k)) { seen.add(k); uniq.push(d); } }

console.log(`backend routes served      : ${routes.length}`);
console.log(`DEAD BUTTONS (panel -> 404): ${uniq.length}`);
for (const p of ['admin', 'merchant', 'user']) {
  const rows = uniq.filter(d => d.panel === p);
  if (!rows.length) continue;
  console.log(`\n══ ${p}-panel (${rows.length}) ══`);
  for (const r of rows.sort((a, b) => a.path.localeCompare(b.path)))
    console.log(`   ${r.method.padEnd(6)} ${r.path.padEnd(52)} ${r.file}`);
}

// ── Reported, never fatal: an endpoint no panel calls. Webhooks and SSE live
// here legitimately, so this is a triage list rather than a gate.
if (process.argv.includes('--unused')) {
  const hay = {};
  for (const [panel, dir] of Object.entries(PANELS))
    hay[panel] = walk(join(ROOT, dir), /\.(ts|tsx|js|jsx)$/).map(f => readFileSync(f, 'utf8')).join('\n');
  const loose = (path) => {
    const body = path.replace(/^\/api/, '').split('/').filter(Boolean)
      .map(x => x.startsWith(':') ? '[^/\\s\'"`]+' : x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
    // The leading boundary is load-bearing. Without it `/api/admin/support/status`
    // in a panel satisfied `/api/support/status`, because the substring is
    // literally in there — a DIFFERENT endpoint marked this one reached, and it
    // dropped off the triage list while no screen called it. `/api` stays
    // optional because panels also write paths relative to a base URL, so the
    // match must start at a string or interpolation boundary, never mid-path.
    return new RegExp('(?<![A-Za-z0-9_\\-/])(?:/api)?/' + body + '(?![A-Za-z0-9_-])');
  };
  const unused = routes.filter(r => { const re = loose(r.path); return !Object.values(hay).some(h => re.test(h)); });
  console.log(`\nENDPOINTS WITH NO UI       : ${unused.length}  (informational)`);
  const byFile = {};
  for (const u of unused) (byFile[u.rel] ??= []).push(`${u.method} ${u.path}`);
  for (const [f, l] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n── ${f}  (${l.length})`);
    for (const x of l.sort()) console.log(`     ${x}`);
  }
}

if (uniq.length) {
  console.log(`\n❌ ${uniq.length} panel call(s) hit a path no route serves. Each one 404s and renders as an empty screen.`);
  process.exit(1);
}
console.log('\n✅ Every panel API call resolves to a route the server actually serves.');
