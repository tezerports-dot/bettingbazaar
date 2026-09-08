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
const PREFIX = {
  'backend/routes.js':'/api/v1/auth','backend/domains/identity/twoFactor.routes.js':'/api/2fa',
  'backend/routes/winners.routes.js':'/api','backend/routes/app-bootstrap.routes.js':'/api/app',
  'backend/domains/casino/gameProvider.routes.js':'/api/game','backend/domains/gameRegistry/gameRegistry.routes.js':'/api/game',
  'backend/domains/telegram/telegram.routes.js':'/api/telegram','backend/domains/markets/bet.routes.js':'/api/bet',
  'backend/domains/user/user.routes.js':'/api','backend/domains/merchant/merchant.routes.js':'/api/merchant',
  'backend/domains/payment/payment.routes.js':'/api/payment','backend/domains/support/support.routes.js':'/api/support',
  'backend/routes/upload.routes.js':'/api','backend/routes/giftcode.routes.js':'/api/giftcode',
  'backend/routes/payment-config.routes.js':'/api/payment','backend/routes/retention.routes.js':'/api',
  'backend/routes/sse.routes.js':'/api/sse','backend/routes/wellKnown.routes.js':'/.well-known',
  'backend/routes/referralRedirect.routes.js':'',
};
// Backend routes as matchers.
const routes = [];
for (const f of walk(join(ROOT,'backend'), /\.routes\.js$|^routes\.js$/)) {
  const rel = relative(ROOT,f);
  const prefix = PREFIX[rel] ?? (adminMounted.has(rel) ? '/api/admin' : null);
  if (prefix === null) continue;
  for (const m of readFileSync(f,'utf8').matchAll(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g)) {
    const path = clean(prefix + '/' + m[2]);
    const re = new RegExp('^' + path.split('/').filter(Boolean)
      .map(s => s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))
      .map(s=>'/'+s).join('') + '$');
    routes.push({ method: m[1].toUpperCase(), path, re, rel });
  }
}
// Also: routes declared directly on the app in server.js (app.post('/api/admin/login', ...)).
{
  const src = readFileSync(join(ROOT,'backend/server.js'),'utf8');
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
