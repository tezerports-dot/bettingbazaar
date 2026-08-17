// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The job platform schedules recurring jobs the way BullMQ v6 requires.
 *
 * v6 REMOVED the v5 repeatable API — `queue.add(name, data, { repeat })`. The
 * removal is silent: the `repeat` option is simply ignored, so a job scheduled
 * that way runs ONCE and never repeats. Every cron on this platform (settlement
 * sweeps, reconciliation, retention) is registered through `registerRecurring`,
 * so a regression here would stop them all firing on any Redis-enabled deploy —
 * and nothing else would notice until the money paths quietly went stale.
 *
 * These tests pin the v6 contract: recurring jobs go through
 * `queue.upsertJobScheduler`, and the removed `add({ repeat })` shape is never
 * used. BullMQ and ioredis are mocked because the assertion is about which API
 * is called, not about Redis.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertJobScheduler = vi.fn(async () => ({}));
const queueAdd = vi.fn(async () => ({}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor() {}
    upsertJobScheduler(...a) { return upsertJobScheduler(...a); }
    add(...a) { return queueAdd(...a); }
    close() {}
  },
  Worker: class {
    constructor() {}
    on() {}
    close() {}
  },
}));

vi.mock('ioredis', () => ({
  default: class { constructor() {} on() {} quit() {} disconnect() {} },
}));

// The worker's processor wraps withLeaderLock; stub it so importing the module
// pulls in no Redis-touching lock machinery.
vi.mock('../../startup/cronLock.js', () => ({
  withLeaderLock: vi.fn((_name, _ttl, fn) => fn()),
}));

process.env.REDIS_URL = 'redis://127.0.0.1:6379';
const { registerRecurring, enqueue } = await import('../../services/jobQueue.service.js');

beforeEach(() => { upsertJobScheduler.mockClear(); queueAdd.mockClear(); });

describe('registerRecurring uses the v6 Job Scheduler', () => {
  it('schedules through upsertJobScheduler, not the removed add({ repeat })', async () => {
    await registerRecurring('settlement-sweep', 60_000, async () => {});

    expect(upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [schedulerId, repeatOpts, template] = upsertJobScheduler.mock.calls[0];

    // Idempotent per job name — re-registering on boot re-uses one schedule.
    expect(schedulerId).toBe('recurring:settlement-sweep');
    // The interval the caller asked for.
    expect(repeatOpts).toEqual({ every: 60_000 });
    // The produced jobs carry `name`, so the worker's processors.get(job.name)
    // dispatch still resolves; per-run options live in the template's opts.
    expect(template.name).toBe('settlement-sweep');
    expect(template.data).toEqual({ __ttlMs: 60_000 });
    expect(template.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000, jitter: 1 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  });

  it('never uses the removed repeatable API', async () => {
    await registerRecurring('reconcile', 120_000, async () => {});
    // The regression guard: the recurring path must not touch queue.add at all,
    // and certainly not with a `repeat` option (silently ignored in v6).
    expect(queueAdd).not.toHaveBeenCalled();
    for (const call of queueAdd.mock.calls) {
      expect(call[2] ?? {}).not.toHaveProperty('repeat');
    }
  });

  it('re-registering the same job re-upserts rather than stacking duplicates', async () => {
    await registerRecurring('retention', 3_600_000, async () => {});
    await registerRecurring('retention', 3_600_000, async () => {});
    // Same scheduler id both times — upsert semantics, one schedule.
    expect(upsertJobScheduler.mock.calls.every((c) => c[0] === 'recurring:retention')).toBe(true);
  });
});

describe('enqueue keeps the one-off add API (still valid in v6)', () => {
  it('adds a one-off job with retries and no repeat option', async () => {
    await enqueue('send-report', { to: 'ops' });
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queueAdd.mock.calls[0];
    expect(name).toBe('send-report');
    expect(data).toEqual({ to: 'ops' });
    expect(opts).not.toHaveProperty('repeat');
    expect(opts).toMatchObject({ attempts: 3 });
  });
});
