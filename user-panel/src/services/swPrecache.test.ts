// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The service worker's precache list and build id (scripts/sw-precache.mjs).
 *
 * The list is what makes the installed app start offline, so it must hold the
 * shell under the URL navigations use ('/'), every hashed bundle file and the
 * icons — and never the source maps, which are written for crash analysis and
 * must not be served to browsers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { precacheList, stampServiceWorker } from '../../scripts/sw-precache.mjs';

let dist: string;

function file(rel: string, body = rel) {
  const full = join(dist, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'sw-precache-'));
  file('index.html');
  file('mini-app.html');
  file('manifest.json');
  file('README.md');
  file('assets/main-abc.js');
  file('assets/main-abc.js.map');
  file('assets/main-abc.css');
  file('app-assets/icon-192.png');
  file('service-worker.js', "const BUILD_ID = '__BUILD_ID__';\nconst PRECACHE = '__PRECACHE__';\n");
});

afterEach(() => rmSync(dist, { recursive: true, force: true }));

describe('precacheList', () => {
  it('lists the shell as "/", the bundle and the icons, and nothing else', () => {
    expect(precacheList(dist)).toEqual([
      '/',
      '/app-assets/icon-192.png',
      '/assets/main-abc.css',
      '/assets/main-abc.js',
      '/manifest.json',
    ]);
  });
});

describe('stampServiceWorker', () => {
  it('writes the list and a build id into the worker', () => {
    const { id, list } = stampServiceWorker(dist)!;
    const sw = readFileSync(join(dist, 'service-worker.js'), 'utf8');
    expect(sw).toContain(`const BUILD_ID = '${id}'`);
    expect(sw).toContain(`const PRECACHE = ${JSON.stringify(list)}`);
  });

  it('keeps the build id when nothing changed and changes it when a file did', () => {
    const sw = readFileSync(join(dist, 'service-worker.js'), 'utf8');
    const first = stampServiceWorker(dist)!.id;
    file('service-worker.js', sw);
    expect(stampServiceWorker(dist)!.id).toBe(first);
    file('service-worker.js', sw);
    file('assets/main-abc.js', 'changed');
    expect(stampServiceWorker(dist)!.id).not.toBe(first);
  });

  it('refuses a worker without its placeholders, rather than shipping one that precaches nothing', () => {
    file('service-worker.js', 'self.addEventListener("fetch", () => {});');
    expect(() => stampServiceWorker(dist)).toThrow(/placeholder/);
  });
});
