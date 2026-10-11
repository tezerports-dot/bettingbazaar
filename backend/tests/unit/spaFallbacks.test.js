// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Each panel's page paths, its root included, answer with that panel's
 * index.html; nothing else reaches the admin or merchant panel.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mountSpaFallbacks } from '../../startup/spaFallbacks.js';

let root; let server; let base;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-'));
  for (const [dir, body] of [['dist', 'PLAYER'], ['admin-panel/dist', 'ADMIN'], ['merchant-panel/dist', 'MERCHANT']]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'index.html'), body);
  }
  const app = express();
  mountSpaFallbacks(app, root);
  app.use((_req, res) => res.status(404).send('NONE'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});

const page = async (p) => (await fetch(base + p)).text();

describe('SPA fallbacks', () => {
  it.each([
    ['/admin', 'ADMIN'], ['/admin/', 'ADMIN'], ['/admin/teams', 'ADMIN'],
    ['/merchant', 'MERCHANT'], ['/merchant/', 'MERCHANT'], ['/merchant/orders/1', 'MERCHANT'],
    ['/', 'PLAYER'], ['/wallet', 'PLAYER'],
    ['/administrator', 'PLAYER'], ['/merchants', 'PLAYER'],
  ])('%s is answered by %s', async (p, want) => {
    expect(await page(p)).toBe(want);
  });

  it('leaves file and API paths to later handlers', async () => {
    expect(await page('/admin/missing.js')).toBe('NONE');
    expect(await page('/api/v1/nothing')).toBe('NONE');
  });
});
