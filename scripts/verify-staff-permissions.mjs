// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * verify-staff-permissions.mjs — every staff route asks for an AREA (§2).
 *
 * Owner, 2026-10-01: a sub-admin "can only do the work in those permissioned
 * areas". That is only true if no staff route asks a weaker question, so this
 * closes the CLASS that F-001 and F-042 were single instances of: a route open
 * to "any sub-admin", found one at a time, each time after it shipped.
 *
 * ── What it reads ───────────────────────────────────────────────────────────
 * The LIVE route stacks, not the source text. It imports every router
 * `server.js` mounts and walks Express's own layers, reading the marks the
 * gates carry: `hasPermission` → `.permission`, `isAdmin` → `.adminOnly`. A gate
 * derived from the thing it checks cannot drift from it (§28) — the text parse
 * in `audit-map.mjs` once counted one tier guard by name and missed seven
 * routes on the other.
 *
 * ── What fails ──────────────────────────────────────────────────────────────
 *   1. A route under /api/admin that names no area and is not a SELF route.
 *   2. A route anywhere gated `isAdmin` that `ADMIN_ONLY_AREAS` does not list —
 *      a full-admin-only area nobody decided on is one a sub-admin can never
 *      be given, which is the other half of the owner's rule.
 *   3. An `ADMIN_ONLY_AREAS` / `SELF_ROUTES` entry that matches no route (a
 *      stale allow-list is how a gate starts passing things nobody listed).
 *   4. A permission string the ADMIN PANEL uses that the server does not
 *      declare, or a panel mirror (`utils/permissions.ts`) that differs from
 *      the server's list (§5).
 *   5. A SCREEN that calls a route in ANOTHER area without asking `can()` for
 *      that area. The screen is gated on its own area (`<PermRoute>`), so a
 *      sub-admin holding only that area opens it and is refused on press —
 *      measured 2026-10-01 on Users (Add/Deduct/Phantom), Merchants and
 *      Disputes, found by a sweep run once by hand. Read per screen: the page
 *      file and every local component it imports, every call resolved to the
 *      route it reaches and that route's area, and the file asked whether it
 *      names `can('<area>')` / `canAny([... '<area>' ...])` anywhere. File-level
 *      on purpose: it proves the screen KNOWS the call is another area's, not
 *      that the guard wraps the right control; the panel tests own that.
 *
 * Usage: npm run check:staff-permissions
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND = join(ROOT, 'backend');

// Importing the routers needs no database. The token module refuses to LOAD
// without a signing key, so a throwaway one is set for this process: nothing is
// signed or verified here, only route stacks are read.
process.env.NODE_ENV ??= 'test';
process.env.PASETO_SECRET_KEY ??= randomBytes(32).toString('hex');

const {
  PERMISSION_KEYS, ADMIN_ONLY_AREAS, SELF_ROUTES,
} = await import(pathToFileURL(join(BACKEND, 'domains/identity/staffPermissions.js')).href);

// ── Every router server.js mounts, and where ────────────────────────────────
const server = readFileSync(join(BACKEND, 'server.js'), 'utf8');
const importOf = new Map();
for (const m of server.matchAll(/^import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s+from\s+'(\.\/[^']+)';/gm)) {
  importOf.set(m[1], m[2]);
}
const mounts = [];
for (const m of server.matchAll(/app\.use\(\s*'([^']+)'\s*,([^)]*)\)/g)) {
  const names = m[2].split(',').map((x) => x.trim());
  const router = names.reverse().find((n) => importOf.has(n));
  if (router) mounts.push({ prefix: m[1], file: importOf.get(router) });
}
if (mounts.length < 15) {
  console.error(`check:staff-permissions: found only ${mounts.length} mounted routers in server.js — the parse is broken, refusing to report a pass.`);
  process.exit(1);
}

const routes = [];
function walk(stack, mount) {
  for (const layer of stack) {
    if (layer.route) {
      const handles = layer.route.stack.map((x) => x.handle);
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          key: `${method.toUpperCase()} ${layer.route.path}`,
          method: method.toUpperCase(),
          full: `${mount}${layer.route.path}`.replace(/\/+$/, '') || '/',
          mount,
          permission: handles.find((h) => h.permission)?.permission ?? null,
          adminOnly: handles.some((h) => h.adminOnly === true),
        });
      }
    } else if (layer.handle?.stack) {
      walk(layer.handle.stack, mount);
    }
  }
}
for (const { prefix, file } of mounts) {
  const mod = await import(pathToFileURL(resolve(BACKEND, file)).href);
  const router = mod.default;
  if (router?.stack) walk(router.stack, prefix);
}

const failures = [];
const adminOnlyListed = new Set(ADMIN_ONLY_AREAS.flatMap((a) => a.routes));
const selfListed = new Set(SELF_ROUTES);
const seen = new Set();

for (const r of routes) {
  if (r.adminOnly) {
    seen.add(r.key);
    if (!adminOnlyListed.has(r.key)) {
      failures.push(`${r.mount} ${r.key} — gated isAdmin but not in ADMIN_ONLY_AREAS. Give it an area (hasPermission), or list it there WITH the reason it cannot be delegated.`);
    }
    continue;
  }
  if (r.permission) continue;
  if (r.mount === '/api/admin') {
    if (selfListed.has(r.key)) { seen.add(r.key); continue; }
    failures.push(`${r.mount} ${r.key} — a staff route that names no area. Every sub-admin could reach it.`);
  }
}
for (const k of [...adminOnlyListed, ...selfListed]) {
  if (!seen.has(k)) failures.push(`allow-list entry '${k}' matches no route — remove it, or the list stops meaning anything.`);
}

// ── The admin panel speaks the same list ────────────────────────────────────
const declared = new Set(PERMISSION_KEYS);
const panel = (p) => readFileSync(join(ROOT, 'admin-panel/src', p), 'utf8');
const mirrorSrc = panel('utils/permissions.ts');
const mirrorBody = mirrorSrc.match(/PERMISSION_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/);
const mirror = mirrorBody ? [...mirrorBody[1].matchAll(/'(\w+)'/g)].map((m) => m[1]) : [];
if (!mirror.length) failures.push('admin-panel utils/permissions.ts: could not read PERMISSION_KEYS — refusing to report a pass.');
for (const k of mirror) if (!declared.has(k)) failures.push(`admin panel mirror names '${k}', which the server does not declare.`);
for (const k of declared) if (!mirror.includes(k)) failures.push(`admin panel mirror is missing '${k}' (backend/domains/identity/staffPermissions.js).`);

const usedInPanel = [
  ...['App.tsx', 'components/Layout.tsx'].flatMap((f) => [...panel(f).matchAll(/permission(?:=|:\s*)["'](\w+)["']/g)].map((m) => [f, m[1]])),
];
for (const [f, k] of usedInPanel) {
  if (!declared.has(k)) failures.push(`admin-panel/src/${f} gates a screen on '${k}', which no route asks for.`);
}

// ── 5. Each screen calls only its own area, or asks can() for the other ─────
// The client: `export const <obj> = { <method>: async (…) => { … api.<verb>('/path') } }`.
const clientSrc = panel('services/api.ts');
const clientObjects = [...clientSrc.matchAll(/^export const (\w+)\s*=\s*\{/gm)];
const clientCalls = new Map();          // 'obj.method' → [{ verb, path }]
const callRe = /\bapi\.(get|post|put|delete|patch)\s*(?:<[^>(]*>)?\(\s*(['`])(\/[^'`]*)\2/g;
for (let i = 0; i < clientObjects.length; i++) {
  const obj = clientObjects[i][1];
  const body = clientSrc.slice(clientObjects[i].index, clientObjects[i + 1]?.index ?? clientSrc.length);
  const methods = [...body.matchAll(/^ {2}(\w+)\s*:\s*async\b/gm)];
  for (let j = 0; j < methods.length; j++) {
    const chunk = body.slice(methods[j].index, methods[j + 1]?.index ?? body.length);
    const calls = [...chunk.matchAll(callRe)].map((m) => ({ verb: m[1].toUpperCase(), path: m[3] }));
    if (calls.length) clientCalls.set(`${obj}.${methods[j][1]}`, calls);
  }
}

// A client path → the route that serves it, by Express's own pattern.
const patterns = routes.map((r) => ({
  ...r,
  re: new RegExp(`^${r.full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*\w*|:\w+/g, '[^/]+')}$`),
}));
const routeFor = (verb, path) => {
  const concrete = path.split('?')[0].replace(/\$\{[^}]+\}/g, 'x');
  return patterns.find((r) => r.method === verb && r.re.test(concrete)) ?? null;
};

// The screens, from App.tsx: path → component → the permission(s) it is gated on.
const appSrc = panel('App.tsx');
const componentFile = new Map();
for (const m of appSrc.matchAll(/^import\s+\{\s*([\w\s,]+)\}\s+from\s+'(\.\/Pages\/[^']+)'/gm)) {
  for (const name of m[1].split(',').map((x) => x.trim()).filter(Boolean)) componentFile.set(name, m[2]);
}
const screens = [];
for (const m of appSrc.matchAll(/<Route\s+path="([^"]+)"\s+element=\{\s*<PermRoute\s+permission=\{?\[?([^}>\]]+)\]?\}?\s*>[\s\S]*?<(\w+)\s*\/>/g)) {
  const areas = [...m[2].matchAll(/'?"?(\w+)'?"?/g)].map((x) => x[1]).filter((k) => declared.has(k));
  const file = componentFile.get(m[3]);
  if (areas.length && file) screens.push({ path: m[1], component: m[3], areas, file });
}
if (screens.length < 30) failures.push(`cross-area: read only ${screens.length} gated screens from App.tsx — the parse is broken, refusing to report a pass.`);

const SRC = join(ROOT, 'admin-panel/src');
const resolveLocal = (fromFile, spec) => {
  const base = resolve(dirname(fromFile), spec);
  for (const c of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) if (existsSync(c)) return c;
  return null;
};
/** The page and every LOCAL component it pulls in — not services, hooks or utils. */
const filesOf = (entry) => {
  const out = new Set(); const todo = [entry];
  while (todo.length) {
    const f = todo.pop();
    if (!f || out.has(f)) continue;
    out.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^import\s+[^;]*?from\s+'(\.{1,2}\/[^']+)'/gm)) {
      if (/\/(services|hooks|utils|types)(\/|$)|\.test$/.test(m[1])) continue;
      const r = resolveLocal(f, m[1]);
      if (r && (r.includes('/Pages/') || r.includes('/components/')) && !/Layout\.tsx$/.test(r)) todo.push(r);
    }
  }
  return [...out];
};
const blank = (src) => src.replace(/(^|[\s{;(])\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '');
const crossArea = [];
for (const sc of screens) {
  for (const f of filesOf(resolve(SRC, sc.file.replace(/^\.\//, '')) + '.tsx').filter(existsSync)) {
    const src = blank(readFileSync(f, 'utf8'));
    const asks = new Set([...src.matchAll(/\bcan(?:Any|All)?\(\s*\[?([^)]*)\)/g)]
      .flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1])));
    const calls = [
      ...[...src.matchAll(/\bapi\.(\w+)\.(\w+)\s*\(/g)].flatMap((m) => clientCalls.get(`${m[1]}.${m[2]}`) ?? []),
      ...[...src.matchAll(callRe)].map((m) => ({ verb: m[1].toUpperCase(), path: m[3] })),
    ];
    for (const c of calls) {
      const route = routeFor(c.verb, c.path);
      if (!route) continue;                       // unresolved paths are check:ui-coverage's job
      const area = route.adminOnly ? '(full admin only)' : route.permission;
      if (!area || sc.areas.includes(area) || asks.has(area)) continue;
      if (route.adminOnly && /\bisAdmin\b/.test(src)) continue;
      crossArea.push(`${sc.path} (${sc.areas.join('|')}) — ${relativeTo(f)} calls ${c.verb} ${route.full}, which needs ${area}, and never asks can('${area}'). A sub-admin holding only this screen's area is shown a control the server refuses.`);
    }
  }
}
function relativeTo(f) { return f.slice(ROOT.length + 1); }
failures.push(...new Set(crossArea));

const staffRoutes = routes.filter((r) => r.permission || r.adminOnly).length;
if (failures.length) {
  console.error(`check:staff-permissions FAILED (${failures.length}):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`check:staff-permissions: ${routes.length} routes read across ${mounts.length} routers; `
  + `${staffRoutes} staff routes, every one asks for one of ${declared.size} areas or is one of `
  + `${adminOnlyListed.size} listed admin-only routes; ${usedInPanel.length} panel gates all declared; `
  + `${screens.length} gated screens call only their own area or ask can() for the other.`);
process.exit(0);
