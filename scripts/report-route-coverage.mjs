// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which routes did any test actually CALL, and which did nothing ever reach?
 *
 * Owner, 2026-10-01: "measure the coverage gaps … instead of guessing". A route
 * test proves its handler; it says nothing about the other routes (§28). This
 * reads what `backend/startup/routeCoverage.js` recorded while the tiers ran:
 *
 *   <dir>/<tier>.jsonl                  one line per request a route answered
 *   <dir>/<tier>.jsonl.inventory.json   every route the REAL server mounts
 *
 * and prints, per route, which tier reached it and what it answered. A route is
 * identified by the file and line that registered it, so a route test mounting
 * one router at "/" and the server mounting it under /api/admin count as the
 * same route.
 *
 * What it does NOT claim (§35): a hit means a request REACHED the route and got
 * an answer. It is not an assertion that the answer was right — that is the
 * test's job — and a route answered only with refusals has never been seen to
 * do its work. Both are printed apart for that reason.
 *
 *   node scripts/report-route-coverage.mjs --dir <dir>              summary
 *   node scripts/report-route-coverage.mjs --dir <dir> --out <md>   the document
 *
 * Collect with BB_ROUTE_COVERAGE=<dir>/<tier>.jsonl on each tier (the vitest
 * setup and the server both honour it). The inventory is written by the real
 * server at boot, so at least one tier must run a server (e2e or a browser pass).
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const DIR = resolve(arg('--dir') || '.route-coverage');
const OUT = arg('--out');

if (!existsSync(DIR)) {
  console.error(`No coverage directory at ${DIR}. Run the tiers with BB_ROUTE_COVERAGE set first —`);
  console.error('this reports what was measured, it does not measure.');
  process.exit(1);
}

// Tiers that call a router in-process (a route test) rather than a running
// server over HTTP. A route reached ONLY by these has never been reached the way
// a panel reaches it.
const IN_PROCESS = new Set(['unit', 'pg', 'redis']);
const ORDER = ['unit', 'pg', 'redis', 'e2e', 'browser'];

const files = readdirSync(DIR);
const tiers = files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length))
  .sort((a, b) => (ORDER.indexOf(a) + 99 * (ORDER.indexOf(a) < 0)) - (ORDER.indexOf(b) + 99 * (ORDER.indexOf(b) < 0)) || a.localeCompare(b));

const inventories = files.filter((f) => f.endsWith('.inventory.json'));
if (!inventories.length) {
  console.error('No route inventory. It is written by the real server at boot — run e2e or a browser pass with BB_ROUTE_COVERAGE set.');
  process.exit(1);
}
// Every server boot writes the same inventory; take the largest, and say if they differ.
const invs = inventories.map((f) => ({ f, rows: JSON.parse(readFileSync(join(DIR, f), 'utf8')) }));
invs.sort((a, b) => b.rows.length - a.rows.length);
const inventory = invs[0].rows;
const inventoryDrift = invs.filter((i) => i.rows.length !== inventory.length).map((i) => `${i.f}: ${i.rows.length}`);

const key = (id, m) => `${m} ${id}`;
const routes = new Map(inventory.map((r) => [key(r.id, r.m), { ...r, by: {} }]));

const tierInfo = [];
const strays = new Map(); // hits on routes the server does not mount (a test's own router)
for (const t of tiers) {
  const p = join(DIR, `${t}.jsonl`);
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  let hits = 0;
  for (const line of lines) {
    let h;
    try { h = JSON.parse(line); } catch { continue; }
    if (h.k !== 'hit') continue;
    hits += 1;
    // A HEAD is answered by the GET route.
    const r = routes.get(key(h.id, h.m)) ?? (h.m === 'HEAD' ? routes.get(key(h.id, 'GET')) : undefined);
    if (!r) { strays.set(`${h.m} ${h.id}`, (strays.get(`${h.m} ${h.id}`) ?? 0) + 1); continue; }
    const b = (r.by[t] ??= { n: 0, ok: 0, c4: 0, c5: 0, statuses: {} });
    b.n += 1;
    if (h.s < 400) b.ok += 1; else if (h.s < 500) b.c4 += 1; else b.c5 += 1;
    b.statuses[h.s] = (b.statuses[h.s] ?? 0) + 1;
  }
  tierInfo.push({ tier: t, hits, mtime: statSync(p).mtime.toISOString() });
}

const all = [...routes.values()].sort((a, b) => a.path.localeCompare(b.path) || a.m.localeCompare(b.m));
const reached = (r, pred = () => true) => Object.entries(r.by).some(([t, b]) => pred(t) && b.n > 0);
const succeeded = (r, pred = () => true) => Object.entries(r.by).some(([t, b]) => pred(t) && b.ok > 0);
const fileOf = (id) => id.replace(/:\d+$/, '');

const never = all.filter((r) => !reached(r));
const onlyRefused = all.filter((r) => reached(r) && !succeeded(r));
const inProcessOnly = all.filter((r) => reached(r) && !reached(r, (t) => !IN_PROCESS.has(t)));
const fiveHundreds = all.filter((r) => Object.values(r.by).some((b) => b.c5 > 0));

const statusList = (r) => Object.entries(r.by).map(([t, b]) => `${t}: ${Object.entries(b.statuses).map(([s, n]) => `${s}×${n}`).join(' ')}`).join('; ');

const L = [];
L.push('# Route coverage — which routes any test actually reached');
L.push('');
L.push('> **GENERATED** by `npm run report:routes` from what `backend/startup/routeCoverage.js` recorded');
L.push('> while each tier ran. Never edit by hand; re-run the tiers and regenerate.');
L.push('>');
L.push('> A hit means a request REACHED the route and was answered. It is not an assertion that the');
L.push('> answer was right (§35). A route reached only with refusals (4xx) has never been seen doing');
L.push('> its work, and is listed apart.');
L.push('');
L.push('## Inputs');
L.push('');
L.push('| Tier | How it reaches a route | Requests recorded | Recorded at |');
L.push('|---|---|---|---|');
for (const t of tierInfo) {
  L.push(`| ${t.tier} | ${IN_PROCESS.has(t.tier) ? 'in-process route test' : 'a running server, over HTTP'} | ${t.hits} | ${t.mtime} |`);
}
L.push('');
L.push(`Inventory: **${inventory.length}** method+route pairs the server mounts (\`${invs[0].f}\`).`);
if (inventoryDrift.length) L.push(`\n**The inventories disagree** — a tier ran a different build: ${inventoryDrift.join(', ')}.`);
L.push('');
L.push('## Summary');
L.push('');
L.push('| | Routes |');
L.push('|---|---|');
L.push(`| Mounted by the server | ${all.length} |`);
L.push(`| Reached by any tier | ${all.length - never.length} |`);
L.push(`| **Never reached by anything** | **${never.length}** |`);
L.push(`| Reached, but only ever REFUSED (no 2xx/3xx anywhere) | ${onlyRefused.length} |`);
L.push(`| Reached only by in-process route tests, never through a running server | ${inProcessOnly.length} |`);
L.push(`| Answered a 5xx at least once | ${fiveHundreds.length} |`);
L.push('');
L.push('Per tier (a route can count in several):');
L.push('');
L.push('| Tier | Reached | Succeeded at least once | Only refused |');
L.push('|---|---|---|---|');
for (const { tier } of tierInfo) {
  const r = all.filter((x) => x.by[tier]?.n);
  const ok = r.filter((x) => x.by[tier].ok);
  L.push(`| ${tier} | ${r.length} | ${ok.length} | ${r.length - ok.length} |`);
}
L.push('');

const table = (rows, cols) => {
  L.push(`| ${cols.map((c) => c[0]).join(' | ')} |`);
  L.push(`|${cols.map(() => '---').join('|')}|`);
  for (const r of rows) L.push(`| ${cols.map((c) => c[1](r)).join(' | ')} |`);
  L.push('');
};
const grouped = (rows, cols) => {
  const by = new Map();
  for (const r of rows) (by.get(fileOf(r.id)) ?? by.set(fileOf(r.id), []).get(fileOf(r.id))).push(r);
  for (const [f, rs] of [...by.entries()].sort()) {
    L.push(`### \`${f}\` — ${rs.length}`);
    L.push('');
    table(rs, cols);
  }
};
const route = [['Method', (r) => r.m], ['Path', (r) => `\`${r.path}\``], ['Registered at', (r) => `\`${r.id.split('/').pop()}\``]];

L.push(`## Never reached by any tier — ${never.length}`);
L.push('');
L.push('Nothing in any tier sent a request that this route answered. Each one is either a test that does not');
L.push('exist yet, or a route nothing needs (§28: read it, do not count it).');
L.push('');
grouped(never, route);

L.push(`## Reached, but only ever refused — ${onlyRefused.length}`);
L.push('');
L.push('Every request this route answered, in every tier, was a 4xx. The refusal is tested; the work is not.');
L.push('');
table(onlyRefused, [...route, ['What it answered', statusList]]);

L.push(`## Reached only by in-process route tests — ${inProcessOnly.length}`);
L.push('');
L.push('A route test mounts the router on its own. Nothing reached these through the real server, its');
L.push('middleware stack and its mounts — the way a panel reaches them.');
L.push('');
table(inProcessOnly, [...route, ['What it answered', statusList]]);

L.push(`## Answered a 5xx at least once — ${fiveHundreds.length}`);
L.push('');
L.push('Some of these are tests provoking a failure on purpose. Each is still worth reading: a 5xx a');
L.push('browser pass hit is a screen that broke.');
L.push('');
table(fiveHundreds, [...route, ['What it answered', statusList]]);

// ── Client methods no screen calls ────────────────────────────────────────
// The other half of "a route nothing reaches". A panel's API client can hold a
// method that calls a real route while NO screen calls the method:
// `check:ui-coverage` sees the client's call resolve and reports it covered.
// Found when the Aadhaar resubmission route — route, service, client method —
// turned out to have no button at all.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENTS = [
  ['user-panel', 'user-panel/src/services/realBackend.ts'],
  ['admin-panel', 'admin-panel/src/services/api.ts'],
  ['merchant-panel', 'merchant-panel/src/services/api.ts'],
];
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory()
  ? (d.name === 'node_modules' ? [] : walk(join(dir, d.name)))
  : (/\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [join(dir, d.name)] : [])));
const uncalled = [];
for (const [panel, file] of CLIENTS) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  const others = walk(join(ROOT, panel, 'src')).filter((f) => f !== abs && !/backend\.interface\.ts$/.test(f))
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  const defs = [...src.matchAll(/^\s+(?:async\s+)?([a-zA-Z_]\w*)\s*(?:\(|:\s*(?:async\s*)?\()/gm)];
  const skip = new Set(['if', 'for', 'while', 'switch', 'catch', 'constructor', 'request', 'return', 'function', 'get', 'set', 'onUploadProgress']);
  defs.forEach((m, i) => {
    const name = m[1];
    if (skip.has(name) || new RegExp(`\\b${name}\\b`).test(others)) return;
    if (uncalled.some((u) => u.panel === panel && u.name === name)) return;
    // Comments blanked, so a path a comment mentions is not taken for the request.
    const body = src.slice(m.index, defs[i + 1]?.index ?? src.length)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const path = body.match(/['\`](\/(?:api|v1)[^'\`]*)['\`]/)?.[1] ?? '';
    uncalled.push({ panel, file: relative(ROOT, abs), name, path });
  });
}
L.push(`## Client methods no screen calls — ${uncalled.length}`);
L.push('');
L.push('A method in a panel\'s API client that nothing else in that panel names. `check:ui-coverage` counts');
L.push('its request as reaching a route; no person can make it. Each is either a feature with no button');
L.push('(wire it) or code nothing needs (delete it, §30).');
L.push('');
table(uncalled, [['Panel', (r) => r.panel], ['Method', (r) => `\`${r.name}\``], ['Requests', (r) => (r.path ? `\`${r.path}\`` : '—')]]);

L.push('## Every route');
L.push('');
table(all, [['Method', (r) => r.m], ['Path', (r) => `\`${r.path}\``],
  ...tierInfo.map(({ tier }) => [tier, (r) => {
    const b = r.by[tier];
    if (!b) return '·';
    return b.ok ? `${b.ok}✓${b.c4 ? ` ${b.c4}✗` : ''}${b.c5 ? ` ${b.c5}‼` : ''}` : `${b.c4}✗${b.c5 ? ` ${b.c5}‼` : ''}`;
  }])]);
L.push('`n✓` answered below 400, `n✗` refused (4xx), `n‼` 5xx, `·` never reached by that tier.');
L.push('');
if (strays.size) {
  L.push(`Requests to routers the server does not mount (a test's own router): ${[...strays.values()].reduce((a, b) => a + b, 0)} across ${strays.size} routes — not counted above.`);
  L.push('');
}

const doc = `${L.join('\n')}\n`;
if (OUT) {
  writeFileSync(OUT, doc);
  console.log(`Wrote ${OUT}`);
}
console.log(`client methods no screen calls: ${uncalled.length}`);
console.log(`${all.length} routes mounted · ${all.length - never.length} reached · ${never.length} NEVER reached · ${onlyRefused.length} only refused · ${inProcessOnly.length} in-process only · ${fiveHundreds.length} answered a 5xx`);
for (const { tier } of tierInfo) {
  const r = all.filter((x) => x.by[tier]?.n);
  console.log(`  ${tier.padEnd(8)} reached ${r.length}, succeeded ${r.filter((x) => x.by[tier].ok).length}`);
}
