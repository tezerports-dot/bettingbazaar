#!/usr/bin/env node
/**
 * extract-operations-map.mjs — the machine-derived half of
 * `docs/reference/OPERATIONS_MAP.html`.
 *
 * The map states route counts, job names, event names, mount prefixes, order
 * transitions and panel screens. Every one of those is read out of the code by
 * this script rather than written from memory, because a reference document
 * whose figures were typed is a document that silently goes stale — and §0.5
 * of the audit map records that a confident reading is exactly what missed
 * every serious defect in this codebase.
 *
 * Run it, diff the numbers against the map, and correct the map. It prints a
 * summary and writes the full structure to the path given as the first
 * argument (default: /tmp/operations-map.json).
 *
 * It is deliberately NOT a gate. It reports; it does not decide. Turning drift
 * into a build failure would need a judgement about whether a new route is
 * supposed to be there, which is the thing a person is for.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Derived from this file's own location — never an absolute path to one
// checkout, which is how `verify-ui-coverage.mjs` once shipped unable to run
// anywhere but its author's machine (§28).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n === 'dist' || n === '.git') continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const blank = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// ── 1. server.js mounts ──
const server = blank(readFileSync(join(ROOT, 'backend/server.js'), 'utf8'));
const mounts = [];
for (const m of server.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*([^)]*)\)/g)) {
  mounts.push({ prefix: m[1], handlers: m[2].split(',').map((x) => x.trim()).filter(Boolean) });
}
const imports = {};
for (const m of server.matchAll(/import\s+(\w+)\s+from\s+'([^']+)'/g)) imports[m[1]] = m[2];

// ── 2. every route ──
const routes = [];
for (const f of walk(join(ROOT, 'backend'))) {
  if (!/\.js$/.test(f) || /\/tests\//.test(f)) continue;
  const src = blank(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]\s*,?\s*([^\n]*)/g)) {
    const guards = (m[3] || '').split(',').map((x) => x.trim())
      .filter((x) => x && !/^async|^\(|^\{|^function/.test(x))
      .map((x) => x.replace(/\(.*$/, ''));
    routes.push({
      file: relative(ROOT, f), method: m[1].toUpperCase(), path: m[2],
      guards: guards.filter((g) => /^[a-zA-Z_$][\w$]*$/.test(g)),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
}

// ── 3. order lifecycle transitions ──
const lifecycle = [];
for (const f of walk(join(ROOT, 'backend'))) {
  if (!/\.js$/.test(f) || /\/tests\//.test(f)) continue;
  const src = blank(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/(\w+Order\w*|\w+OrderState)\(\s*[^,]+,\s*\{[^}]*expectFrom:\s*(\[[^\]]*\]|'[^']*')/g)) {
    lifecycle.push({ file: relative(ROOT, f), call: m[1], expectFrom: m[2] });
  }
}

// ── 4. crons ──
const cron = blank(readFileSync(join(ROOT, 'backend/startup/cronJobs.js'), 'utf8'));
const crons = [...cron.matchAll(/registerRecurring\('([^']+)',\s*([^,]+),/g)]
  .map((m) => ({ name: m[1], every: m[2].trim() }));

// ── 5. queues (bullmq) and redis ──
const queues = [], redis = [];
for (const f of walk(join(ROOT, 'backend'))) {
  if (!/\.js$/.test(f) || /\/tests\//.test(f)) continue;
  const src = blank(readFileSync(f, 'utf8'));
  if (/bullmq|new Queue\(|new Worker\(/.test(src)) {
    for (const m of src.matchAll(/new (Queue|Worker|QueueEvents)\(\s*['"`]?([\w-]*)/g)) {
      queues.push({ file: relative(ROOT, f), kind: m[1], name: m[2] || '(dynamic)' });
    }
    if (!/new (Queue|Worker|QueueEvents)\(/.test(src)) queues.push({ file: relative(ROOT, f), kind: 'import', name: 'bullmq referenced' });
  }
  if (/createClient|ioredis|redis\./i.test(src)) redis.push(relative(ROOT, f));
}

// ── 6. realtime events ──
const events = new Set();
for (const f of walk(join(ROOT, 'backend'))) {
  if (!/\.js$/.test(f) || /\/tests\//.test(f)) continue;
  const src = blank(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/emit\w*\([^,]*,\s*'([a-z_]+)'/g)) events.add(m[1]);
  for (const m of src.matchAll(/\.emit\(\s*'([a-z_]+)'/g)) events.add(m[1]);
}

// ── 7. panel pages ──
const pages = {};
for (const panel of ['user-panel', 'admin-panel', 'merchant-panel']) {
  pages[panel] = [];
  for (const f of walk(join(ROOT, panel, 'src'))) {
    if (!/\.tsx?$/.test(f) || /\.test\./.test(f)) continue;
    const src = blank(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/<Route\s+path=["']([^"']+)["']/g)) {
      pages[panel].push({ path: m[1], file: relative(ROOT, f) });
    }
  }
}

const OUT = process.argv[2] || '/tmp/operations-map.json';
writeFileSync(OUT, JSON.stringify(
  { mounts, imports, routes, lifecycle, crons, queues, redis: [...new Set(redis)], events: [...events].sort(), pages }, null, 2));
console.log('routes', routes.length, '| crons', crons.length, '| queues', queues.length,
  '| redis files', new Set(redis).size, '| events', events.size,
  '| pages', Object.entries(pages).map(([k, v]) => `${k}:${v.length}`).join(' '));
