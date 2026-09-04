// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/cpuWorker.js — the worker-thread ENTRY for the CPU pool (item 5).
 *
 * Runs on a Node worker_thread, NOT the main event loop. It imports ONLY pure,
 * side-effect-free task functions (no data layer, no network) and dispatches by
 * task name. You cannot pass a function across the thread boundary, so tasks are
 * registered here by name and invoked with the structured-cloned payload.
 *
 * Add a CPU-bound task: implement/import a pure fn and add it to TASKS. Keep it
 * PURE — anything touching the DB or app singletons belongs on the main thread.
 */
import { parentPort } from 'node:worker_threads';
import { toCsv } from '../domains/reporting/csv.util.js';

const TASKS = {
  // Serialize report rows → CSV text. The heavy path this pool exists for:
  // tens of thousands of rows is real string-building work that would otherwise
  // stall every concurrent request (including money paths) on the one loop.
  csvSerialize: (rows) => toCsv(rows),
};

parentPort.on('message', (msg) => {
  const { id, task, payload } = msg || {};
  try {
    const fn = TASKS[task];
    if (!fn) throw new Error(`unknown CPU task: ${task}`);
    const result = fn(payload);
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message });
  }
});
