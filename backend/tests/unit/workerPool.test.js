// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the item-5 CPU worker pool. Runs REAL worker_threads (they work
// fine under vitest/node — no DB needed) and proves the inline fallback matches.
import { describe, it, expect, afterAll } from 'vitest';
import { runCpuTask, shouldOffloadCsv, closeWorkerPool, _workerPoolState } from '../../services/workerPool.service.js';
import { toCsv } from '../../domains/reporting/csv.util.js';

afterAll(async () => { await closeWorkerPool(); });

const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, note: i % 2 ? 'has,comma' : 'plain' }));

describe('CPU worker pool', () => {
  it('csvSerialize on a worker equals the inline toCsv', async () => {
    const viaWorker = await runCpuTask('csvSerialize', rows);
    expect(viaWorker).toBe(toCsv(rows));
  });

  it('handles many concurrent tasks (round-robin across the pool)', async () => {
    const inputs = Array.from({ length: 20 }, (_, n) => [{ a: n, b: `v,${n}` }]);
    const results = await Promise.all(inputs.map(r => runCpuTask('csvSerialize', r)));
    results.forEach((res, n) => expect(res).toBe(toCsv(inputs[n])));
  });

  it('rejects an unknown task name', async () => {
    await expect(runCpuTask('nope', {})).rejects.toThrow(/unknown CPU task/);
  });

  it('shouldOffloadCsv only trips for large row counts', () => {
    expect(shouldOffloadCsv(rows)).toBe(false);            // 5 rows → inline
    expect(shouldOffloadCsv(Array.from({ length: 5000 }))).toBe(true);
    expect(shouldOffloadCsv('not-an-array')).toBe(false);
  });

  it('reports pool state', () => {
    const s = _workerPoolState();
    expect(typeof s.enabled).toBe('boolean');
    expect(s.size).toBeGreaterThanOrEqual(1);
  });
});
