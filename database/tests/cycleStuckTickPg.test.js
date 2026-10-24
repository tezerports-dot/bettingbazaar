// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cycleStuckTickPg.test.js — the board timers stuck at 00:00 (owner, 2026-10-24).
 *
 * Every board stopped at once and nothing moved until a restart. The round
 * manager runs one tick a second, one at a time, and a tick waited for good on
 * one of three things: a row lock on a `cycles` row held by a transaction that
 * never finished, a free pool connection, or the shared boards read in flight.
 * Broken invariant: a tick must always end, so the next second can run.
 *
 * These tests hold each wait open against a real database and prove it now
 * ends: the write fails fast and leaves the row as it was (and the next try,
 * once the lock is gone, succeeds), and a stuck tick is left behind so a fresh
 * one runs. The opposite behaviour is tested too: with nothing in the way the
 * same writes go through first time.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import pg from 'pg';
import { pgConfigured, pgQuery, applySchema, closePg, isBoundedWaitError } from '../client.js';
import { getCycle, setCycleStatus, declareWinner, equalizePhantomPools } from '../repositories/markets.js';
import CycleGenerator, { TICK_ABANDON_MS } from '../../backend/domains/markets/cycleGenerator.service.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const openCycle = (cycleId) => pgQuery(
  `INSERT INTO cycles (cycle_id, cycle_type, status, start_time, end_time)
   VALUES ($1, '30_MIN', 'OPEN', now() - interval '20 minutes', now() + interval '10 minutes')`, [cycleId]);

/**
 * A second connection holding the share lock a bet takes on its round
 * (`bets.core.placeBet`) and never finishing: the transaction that used to
 * freeze every board.
 */
async function holdBetLock(cycleId) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');
  await c.query('SELECT 1 FROM cycles WHERE cycle_id = $1 FOR SHARE', [cycleId]);
  return { release: async () => { await c.query('ROLLBACK'); await c.end(); } };
}

describePg('a round write waits on a stuck bet only so long', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE bets, bet_transitions, cycles, cycle_settlements RESTART IDENTITY CASCADE`);
  });

  for (const [name, write] of [
    ['a phase change', (id) => setCycleStatus(id, 'MERGED', { from: ['OPEN'] })],
    ['the winner', (id) => declareWinner(id, 'DELHI')],
    ['the phantom equalizer', (id) => equalizePhantomPools(id)],
  ]) {
    it(`${name}: fails within its bound behind a stuck lock, writes nothing, and goes through once the lock is gone`, async () => {
      await openCycle('c-stuck');
      const lock = await holdBetLock('c-stuck');
      try {
        const started = Date.now();
        const err = await write('c-stuck').then(() => null, (e) => e);
        expect(err).not.toBeNull();
        expect(isBoundedWaitError(err)).toBe(true);
        // The lock bound is 5 s; it must not wait anything like for ever.
        expect(Date.now() - started).toBeLessThan(10_000);
        const row = await getCycle('c-stuck');
        expect(row.status).toBe('OPEN');
        expect(row.winner).toBeNull();
        expect(row.phantomBetsClosed).toBe(false);
      } finally {
        await lock.release();
      }
      // The next tick's try, with the lock gone.
      const retried = await write('c-stuck');
      expect(retried.ok).toBe(true);
    }, 20_000);
  }

  it('with nothing in the way, the same write goes through at once', async () => {
    await openCycle('c-free');
    const started = Date.now();
    expect((await setCycleStatus('c-free', 'MERGED', { from: ['OPEN'] })).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await getCycle('c-free')).status).toBe('MERGED');
  });
});

describe('a stuck tick is left behind and a fresh one runs', () => {
  it('starts a new tick once the old one has run past the bound, and the old one never clears the new one', async () => {
    vi.useFakeTimers();
    try {
      const gen = new CycleGenerator(null, null);
      gen.isInitialized = true;
      gen.isRunning = false;
      gen.tickSeq = 0;
      let calls = 0;
      let finishFirst;
      gen.manageCycles = vi.fn(() => {
        calls += 1;
        // The first tick hangs, as one waiting on a lost lock did.
        return calls === 1 ? new Promise((r) => { finishFirst = r; }) : Promise.resolve();
      });

      void gen.tick();
      expect(calls).toBe(1);
      // While it is within the bound, nothing runs beside it.
      vi.setSystemTime(Date.now() + TICK_ABANDON_MS - 1_000);
      await gen.tick();
      expect(calls).toBe(1);
      // Past the bound, a fresh tick runs.
      vi.setSystemTime(Date.now() + 2_000);
      await gen.tick();
      expect(calls).toBe(2);
      expect(gen.isRunning).toBe(false);

      // The next second carries on as normal.
      await gen.tick();
      expect(calls).toBe(3);

      // The old tick finally returns while a new one is running: it must not
      // mark the new one finished.
      let finishFourth;
      gen.manageCycles = vi.fn(() => new Promise((r) => { finishFourth = r; }));
      void gen.tick();
      expect(gen.isRunning).toBe(true);
      finishFirst();
      await Promise.resolve(); await Promise.resolve();
      expect(gen.isRunning).toBe(true);
      finishFourth();
      await Promise.resolve(); await Promise.resolve();
      expect(gen.isRunning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('one round that throws costs only that round: the next round in the same tick still advances', async () => {
    const gen = new CycleGenerator(null, null);
    const seen = [];
    gen.advanceCycle = vi.fn(async (cycle) => {
      seen.push(cycle.cycleId);
      if (cycle.cycleId === 'a') throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    });
    const { db } = await import('#db');
    const spy = vi.spyOn(db.markets, 'activeCyclesWithPools').mockResolvedValue([
      { cycleId: 'a', type: '30_MIN', status: 'CLOSED', endTime: new Date() },
      { cycleId: 'b', type: '1_MIN', status: 'CLOSED', endTime: new Date() },
    ]);
    try {
      await gen.updateCycleStatuses();
      expect(seen).toEqual(['a', 'b']);
    } finally {
      spy.mockRestore();
    }
  });
});
