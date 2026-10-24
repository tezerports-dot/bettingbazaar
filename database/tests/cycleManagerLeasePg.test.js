// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cycleManagerLeasePg.test.js — one scheduler manages the rounds, a second
 * stands by and takes over (security & reliability review, 2026-10-24: "if the
 * one scheduler crashes, rounds freeze until it restarts").
 *
 * Invariant: at most ONE process runs the round manager at a time, and when
 * that process is gone another one runs it without anybody restarting it.
 * Held by the `cycle-manager` lease in `cron_locks`, against a real database:
 * the lease's takeover rule is a statement of PostgreSQL's, not of this code.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import CycleGenerator, {
  CYCLE_MANAGER_LEASE, LEADER_LEASE_MS, LEADER_SAFETY_MS,
} from '../../backend/domains/markets/cycleGenerator.service.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

/**
 * A scheduler process as start() leaves it, without its timers: a named lease
 * holder (two in one test process stand for two processes) and a round
 * manager that only counts what it was asked to do.
 */
function scheduler(holder) {
  const gen = new CycleGenerator(null, null);
  Object.assign(gen, {
    leaseHolder: holder, isInitialized: true, isLeader: false, leaseUntil: 0,
    isRunning: false, tickSeq: 0,
  });
  gen.work = [];
  gen.initializeCycles = vi.fn(async () => { gen.work.push('init'); });
  gen.manageCycles = vi.fn(async () => { gen.work.push('manage'); });
  return gen;
}

const holderNow = async () => (await pgQuery(
  'SELECT holder FROM cron_locks WHERE job_name = $1', [CYCLE_MANAGER_LEASE])).rows[0]?.holder ?? null;

/** The leader vanished: no renewal since longer than the lease. */
const leaseLapses = () => pgQuery(
  `UPDATE cron_locks SET acquired_at = now() - interval '1 minute', expires_at = now() - interval '1 second'
    WHERE job_name = $1`, [CYCLE_MANAGER_LEASE]);

describePg('the round manager runs on exactly one scheduler', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => { await pgQuery('DELETE FROM cron_locks WHERE job_name = $1', [CYCLE_MANAGER_LEASE]); });

  it('a single scheduler leads at once, starts up, then manages every tick (as before the standby existed)', async () => {
    const a = scheduler('sched-a');
    await a.renewLeadership();
    expect(a.leads()).toBe(true);
    await a.tick();
    await a.tick();
    await a.tick();
    expect(a.work).toEqual(['init', 'manage', 'manage']);
  });

  it('a second scheduler is refused while the first leads, and does nothing', async () => {
    const a = scheduler('sched-a');
    const b = scheduler('sched-b');
    await a.renewLeadership();
    await b.renewLeadership();
    expect(a.leads()).toBe(true);
    expect(b.leads()).toBe(false);
    await a.tick();
    await b.tick();
    await b.tick();
    expect(a.work).toEqual(['init']);
    expect(b.work).toEqual([]);
    // Renewing keeps it: the leader is still the leader a renewal later.
    await a.renewLeadership();
    await b.renewLeadership();
    expect(await holderNow()).toBe('sched-a');
    expect(b.leads()).toBe(false);
  });

  it('when the leader stops renewing, the standby takes over and starts up as a fresh process would', async () => {
    const a = scheduler('sched-a');
    const b = scheduler('sched-b');
    await a.renewLeadership();
    await b.renewLeadership();
    await leaseLapses();                 // a crashed: no renewal for longer than the lease
    await b.renewLeadership();
    expect(b.leads()).toBe(true);
    expect(await holderNow()).toBe('sched-b');
    await b.tick();
    await b.tick();
    expect(b.work).toEqual(['init', 'manage']);
    // The old leader, if it comes back, finds it has lost and stands by.
    await a.renewLeadership();
    expect(a.leads()).toBe(false);
    await a.tick();
    expect(a.work).toEqual([]);
  });

  it('a graceful stop gives the lease back, so the standby takes over at its next renewal', async () => {
    const a = scheduler('sched-a');
    const b = scheduler('sched-b');
    await a.renewLeadership();
    a.stop();
    await vi.waitFor(async () => expect(await holderNow()).toBeNull());
    await b.renewLeadership();
    expect(b.leads()).toBe(true);
  });

  it('a leader that cannot renew stops ticking before its lease could lapse (its own clock, not the database\'s)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const a = scheduler('sched-a');
      await a.renewLeadership();
      expect(a.leads()).toBe(true);
      // Renewals stop answering. Just inside its own margin it still leads…
      vi.setSystemTime(Date.now() + LEADER_LEASE_MS - LEADER_SAFETY_MS - 1_000);
      expect(a.leads()).toBe(true);
      // …and before the database lease can lapse, it has already stopped.
      vi.setSystemTime(Date.now() + 2_000);
      expect(a.leads()).toBe(false);
      await a.tick();
      expect(a.work).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a generator nobody started still runs its ticks (tests, and the stuck-tick bound, are unchanged)', async () => {
    const gen = new CycleGenerator(null, null);
    gen.isInitialized = true;
    gen.manageCycles = vi.fn(async () => {});
    await gen.tick();
    expect(gen.manageCycles).toHaveBeenCalledTimes(1);
  });
});
