// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/workerPool.service.js — CPU worker-thread pool (plan item 5). 2026-07-13.
 *
 * THE PROBLEM (owner's words): "node runs all in one thread… move CPU-BOUND work
 * to worker threads." A single long synchronous computation (serializing a huge
 * regulatory CSV, hashing a large blob) blocks the event loop — while it runs,
 * NOTHING else progresses, including in-flight money paths. Worker threads run
 * that computation on ANOTHER OS thread so the main loop keeps serving.
 *
 * DESIGN (matches this codebase's degradation philosophy):
 *  - A bounded pool of N worker_threads (default = min(cpus-1, 4), env
 *    WORKER_POOL_SIZE). Round-robins tasks to workers; each task is a
 *    request/response message keyed by id.
 *  - runCpuTask(task, payload) returns a Promise. If workers are DISABLED
 *    (WORKER_THREADS_ENABLED=false) or a worker fails to spawn, it runs the task
 *    INLINE on the main thread — identical result, just not offloaded. A worker
 *    error rejects that one task; a worker CRASH is replaced lazily. The feature
 *    can never break a request path — worst case it degrades to today's inline
 *    behavior.
 *  - Callers decide WHEN offloading is worth the ~structured-clone round trip:
 *    only offload genuinely heavy payloads (see shouldOffloadCsv). Small work
 *    stays inline (a thread hop would be slower than just doing it).
 *
 * This is process-local (threads share the process). It complements, not
 * replaces, the BullMQ job platform (cross-instance async jobs) — workers are
 * for synchronous CPU inside one request; jobs are for durable background work.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv } from '../domains/reporting/csv.util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(__dirname, 'cpuWorker.js');

// Inline implementations — the fallback path AND the source of truth for what a
// task computes. Must match cpuWorker.js's TASKS exactly.
const INLINE = {
  csvSerialize: (rows) => toCsv(rows),
};

const ENABLED = String(process.env.WORKER_THREADS_ENABLED ?? 'true').toLowerCase() !== 'false';
const POOL_SIZE = Math.max(1, Number(process.env.WORKER_POOL_SIZE) || Math.min((os.cpus()?.length || 2) - 1, 4));

let pool = null;      // [{ worker, busy, inflight: Map<id,{resolve,reject}> }]
let rr = 0;           // round-robin cursor
let seq = 0;          // task id counter
let WorkerCtor = null;

async function ensurePool() {
  if (!ENABLED) return null;
  if (pool) return pool;
  try {
    ({ Worker: WorkerCtor } = await import('node:worker_threads'));
  } catch { return null; }
  pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = spawn();
    if (slot) pool.push(slot);
  }
  return pool.length ? pool : (pool = null);
}

function spawn() {
  try {
    const worker = new WorkerCtor(WORKER_FILE);
    const slot = { worker, inflight: new Map() };
    worker.on('message', ({ id, ok, result, error }) => {
      const p = slot.inflight.get(id);
      if (!p) return;
      slot.inflight.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    });
    worker.on('error', (err) => failSlot(slot, err));
    worker.on('exit', (code) => { if (code !== 0) failSlot(slot, new Error(`worker exited ${code}`)); });
    return slot;
  } catch { return null; }
}

// A dead worker rejects its in-flight tasks (callers fall back or surface the
// error) and is removed; the pool lazily re-spawns to size on the next task.
function failSlot(slot, err) {
  for (const p of slot.inflight.values()) p.reject(err);
  slot.inflight.clear();
  if (pool) pool = pool.filter(s => s !== slot);
  try { slot.worker.terminate(); } catch { /* already gone */ }
}

/**
 * runCpuTask — run a registered CPU task off the main loop when possible.
 * @param {'csvSerialize'} task
 * @param {*} payload  structured-cloneable input
 * @returns {Promise<*>}
 */
export async function runCpuTask(task, payload) {
  if (!INLINE[task]) throw new Error(`unknown CPU task: ${task}`);
  const p = await ensurePool();
  if (!p || !p.length) return INLINE[task](payload);       // disabled / no workers → inline

  // top the pool back up to size if workers died
  while (p.length < POOL_SIZE) { const s = spawn(); if (!s) break; p.push(s); }

  const slot = p[rr++ % p.length];
  const id = ++seq;
  try {
    return await new Promise((resolve, reject) => {
      slot.inflight.set(id, { resolve, reject });
      slot.worker.postMessage({ id, task, payload });
    });
  } catch (e) {
    // Any worker-path failure degrades to inline — the request still succeeds.
    console.warn(`[workerPool] task '${task}' fell back inline:`, e.message);
    return INLINE[task](payload);
  }
}

/** Heuristic: only worth a thread hop for big serializations. */
export function shouldOffloadCsv(rows) {
  return ENABLED && Array.isArray(rows) && rows.length >= Number(process.env.CSV_OFFLOAD_MIN_ROWS || 2000);
}

/** Graceful shutdown — server.js calls this on SIGTERM/SIGINT. */
export async function closeWorkerPool() {
  if (!pool) return;
  await Promise.all(pool.map(s => s.worker.terminate().catch(() => {})));
  pool = null;
}

export function _workerPoolState() { return { enabled: ENABLED, size: POOL_SIZE, alive: pool?.length || 0 }; }
