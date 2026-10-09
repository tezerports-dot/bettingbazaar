// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The PM2 process file: cluster mode with the configured worker count, a
 * graceful stop longer than the server's own drain deadline, readiness-gated
 * reloads, and never more than one scheduler.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FILE = require.resolve('../../../../ecosystem.config.cjs');

function load(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  delete require.cache[FILE];
  try { return require(FILE); } finally { process.env = saved; }
}

afterEach(() => { delete require.cache[FILE]; });

describe('ecosystem.config.cjs', () => {
  it('runs the api role as a 4-worker cluster', () => {
    const [app] = load({ BB_RUNTIME_ROLE: 'api', BB_WORKERS: '4' }).apps;
    expect(app).toMatchObject({ name: 'bb-api', script: 'backend/server.js', instances: 4, exec_mode: 'cluster' });
    expect(app.env.BB_RUNTIME_ROLE).toBe('api');
  });

  it('waits for readiness on reload and outlasts the 25 s shutdown deadline', () => {
    const [app] = load({ BB_RUNTIME_ROLE: 'realtime', BB_WORKERS: '2' }).apps;
    expect(app.wait_ready).toBe(true);
    expect(app.kill_timeout).toBeGreaterThan(25_000);
    expect(app.autorestart).toBe(true);
    expect(app.watch).toBe(false);
  });

  it('refuses more than one scheduler', () => {
    expect(() => load({ BB_RUNTIME_ROLE: 'scheduler', BB_WORKERS: '2' })).toThrow(/exactly one/);
    expect(load({ BB_RUNTIME_ROLE: 'scheduler', BB_WORKERS: '1' }).apps[0].exec_mode).toBe('fork');
  });

  it('the production compose gives 6 workers to api + realtime', async () => {
    const { readFileSync } = await import('node:fs');
    const compose = readFileSync(new URL('../../../../deploy/vps/docker-compose.prod.yml', import.meta.url), 'utf8');
    const workers = [...compose.matchAll(/BB_WORKERS: "(\d+)"/g)].map((m) => Number(m[1]));
    expect(workers.reduce((a, b) => a + b, 0)).toBe(6);
    expect(compose).toMatch(/@pgbouncer:6432\//);           // workers go through PgBouncer
    expect(compose).not.toMatch(/^\s*ports:.*(5432|6432|6379)/m); // no datastore published
  });
});
