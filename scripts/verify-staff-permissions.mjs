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
 *
 * Usage: npm run check:staff-permissions
 */
import { readFileSync } from 'node:fs';
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

const staffRoutes = routes.filter((r) => r.permission || r.adminOnly).length;
if (failures.length) {
  console.error(`check:staff-permissions FAILED (${failures.length}):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`check:staff-permissions: ${routes.length} routes read across ${mounts.length} routers; `
  + `${staffRoutes} staff routes, every one asks for one of ${declared.size} areas or is one of `
  + `${adminOnlyListed.size} listed admin-only routes; ${usedInPanel.length} panel gates all declared.`);
process.exit(0);
