// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Stamps the built service worker with what it must cache at install.
 *
 * A worker that only caches what passes through its fetch handler never sees
 * the first visit's bundle: that page loaded its JS and CSS before the worker
 * existed. The next visit offline then found index.html in the cache and none
 * of the scripts it names, and rendered a blank screen. Precaching the shell
 * at install is what makes the second visit work with no network at all.
 *
 * The build id is a hash of the precached bytes, not a timestamp, so a deploy
 * that changes nothing does not throw away every installed client's cache and
 * reload their tabs; a deploy that changes anything changes the worker's bytes,
 * which is what makes the browser install the new one.
 *
 * Called from vite.config.ts once the bundle is written.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const SW_FILE = 'service-worker.js';

// Not part of the installed app's shell. Source maps are written for crash
// analysis only (vite.config.ts, sourcemap: 'hidden'); the Mini App is
// Telegram's page and never runs under this worker; the README is for people.
const SKIP = [
  (p) => p.endsWith('.map'),
  (p) => p === `/${SW_FILE}`,
  (p) => p === '/mini-app.html',
  (p) => p.endsWith('/README.md'),
  (p) => p.startsWith('/.vite/'),
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every URL path the installed app needs to start offline, sorted. */
export function precacheList(distDir) {
  const paths = walk(distDir)
    .map((full) => '/' + relative(distDir, full).split(sep).join('/'))
    .filter((p) => !SKIP.some((skip) => skip(p)))
    // The shell is requested as '/', not '/index.html'; caching it under the
    // URL navigations actually use is what lets the fetch handler find it.
    .map((p) => (p === '/index.html' ? '/' : p));
  return [...new Set(paths)].sort();
}

/** Hash of the precached files' paths and bytes. */
export function buildId(distDir, list) {
  const hash = createHash('sha256');
  for (const p of list) {
    hash.update(p);
    hash.update(readFileSync(join(distDir, p === '/' ? 'index.html' : p.slice(1))));
  }
  return hash.digest('hex').slice(0, 12);
}

/** Replace the worker's placeholders. Returns what was written, or null. */
export function stampServiceWorker(distDir) {
  const swPath = join(distDir, SW_FILE);
  if (!existsSync(swPath)) return null;
  const list = precacheList(distDir);
  const id = buildId(distDir, list);
  const source = readFileSync(swPath, 'utf8');
  if (!source.includes('__BUILD_ID__') || !source.includes("'__PRECACHE__'")) {
    throw new Error(`${SW_FILE} is missing its __BUILD_ID__ or '__PRECACHE__' placeholder`);
  }
  writeFileSync(swPath, source
    .replace('__BUILD_ID__', id)
    .replace("'__PRECACHE__'", JSON.stringify(list)));
  return { id, list };
}
