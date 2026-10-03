// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The game engine and the cycle generator start AFTER the schema is applied.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 * `server.js` called `gameEngine.start()` and `cycleGenerator.start()` at module
 * load, while `applySchema()` was still running in the boot chain below them.
 * Only the cron jobs waited for it. Measured 2026-10-01 on a live server:
 *
 *   · a fresh database — the generator's first ticks answered
 *     `relation "cycles" does not exist`;
 *   · an existing database — PostgreSQL logged `deadlock detected` between the
 *     generator's pool read and the schema apply's AccessExclusiveLock (its
 *     constraint drop-and-re-add), and the full-day cycle ensure failed.
 *
 * The settlement engine was started the same way, so payouts could run
 * against a half-applied schema. The fix starts both where the cron jobs
 * start: after the PostgreSQL chain has succeeded, and not at all if it failed.
 *
 * This reads the source because the property is an ORDER in one file, and
 * booting a server to observe a race is not a unit test. The live proof is in
 * PROJECT_STATUS §3.9 (boot twice against one database, no deadlock).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../server.js', import.meta.url)), 'utf8')
  .replace(/(^|[\s{;(])\/\*[\s\S]*?\*\//g, '$1').replace(/^\s*\/\/.*$/gm, '');

describe('schedulers wait for the schema', () => {
  const ready = src.indexOf("console.log('✅ DB services initialized')");

  it('finds the point at which PostgreSQL is ready', () => {
    expect(ready).toBeGreaterThan(-1);
    expect(src.indexOf('applySchema()')).toBeGreaterThan(-1);
    expect(src.indexOf('applySchema()')).toBeLessThan(ready);
  });

  for (const call of ['gameEngine.start()', 'cycleGenerator.start()']) {
    it(`starts ${call.split('.')[0]} only after it`, () => {
      const at = [...src.matchAll(new RegExp(call.replace(/[.()]/g, '\\$&'), 'g'))].map((m) => m.index);
      expect(at, `${call} is called exactly once`).toHaveLength(1);
      expect(at[0], `${call} runs before the schema is applied`).toBeGreaterThan(ready);
    });
  }

  it('does not start them when the PostgreSQL chain failed', () => {
    const refused = src.indexOf("console.error('❌ Startup failed while preparing PostgreSQL:'");
    expect(refused).toBeGreaterThan(-1);
    // The failure branch returns before the success log, so anything after the
    // log is unreachable on failure.
    const between = src.slice(refused, ready);
    expect(between).toMatch(/return;/);
  });
});
