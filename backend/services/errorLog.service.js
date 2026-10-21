// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * errorLog.service.js — how a failure reaches the error log (owner, 2026-10-20;
 * the table and its one writer are database/repositories/errorLog.js).
 *
 * Server side there are four doors, each with its category and severity:
 *
 *   API          a request answered 500 that nobody decided (`serverError`,
 *                the global `errorHandler`)                          WARNING
 *   MONEY_ALERT  `sendAlert`: a money or job failure a human must see CRITICAL
 *   JOB          anything a background job logs with console.error  WARNING
 *   SERVER_LOG   any other console.error                             MINOR
 *
 * The last two come from `installServerErrorCapture`, which wraps
 * console.error once at boot: that is the one place every cron, sweep and
 * handler already reports a failure, so nothing has to remember to call us.
 * A door that records explicitly logs through `withoutCapture` so one failure
 * is one entry.
 *
 * Recording never throws and never waits: reports are buffered per error for
 * `FLUSH_MS` and written as one row update with their count, so a storm of the
 * same failure is one write every few seconds. If the database itself is the
 * failure, the write fails quietly (to the ORIGINAL console.error, never back
 * into the capture).
 */
import { fingerprintOf } from '#db/repositories/errorLog.js';

const FLUSH_MS = 5000;
/** Distinct errors held between flushes; past this a report is dropped, never queued without bound. */
const MAX_PENDING = 500;

const rawConsoleError = console.error.bind(console);
const pending = new Map(); // fingerprint -> { report, count }
let timer = null;
let quiet = 0;
let enabled = process.env.NODE_ENV !== 'test' && !process.env.VITEST;

/** Turn recording on or off (tests that assert it switch it on). */
export function setErrorLogEnabled(on) { enabled = Boolean(on); }

async function flush() {
  timer = null;
  const batch = [...pending.values()];
  pending.clear();
  if (!batch.length) return;
  try {
    const { recordError } = await import('#db/repositories/errorLog.js');
    for (const { report, count } of batch) {
      try { await recordError({ ...report, count }); }
      catch (e) { rawConsoleError('[error-log] could not record an error:', e?.message || e); }
    }
  } catch (e) {
    rawConsoleError('[error-log] unavailable:', e?.message || e);
  }
}

/** Flush now (shutdown, tests). */
export async function flushErrorLog() {
  if (timer) clearTimeout(timer);
  await flush();
}

/**
 * Queue one occurrence. Fire and forget: returns nothing and cannot throw.
 * @param {{source:string, category:string, severity:string, message:string,
 *          detail?:string|null, component?:string|null, location?:string|null}} report
 */
export function logError(report) {
  if (!enabled) return;
  try {
    if (!report?.message) return;
    const key = fingerprintOf(report);
    const held = pending.get(key);
    if (held) { held.count += 1; held.report = report; }
    else if (pending.size < MAX_PENDING) pending.set(key, { report, count: 1 });
    else return;
    if (!timer) {
      timer = setTimeout(() => { void flush(); }, FLUSH_MS);
      timer.unref?.();
    }
  } catch { /* recording must never break the caller */ }
}

const textOf = (v) => (v instanceof Error ? v.message : typeof v === 'string' ? v : (() => {
  try { return JSON.stringify(v); } catch { return String(v); }
})());

/** A request that failed with nobody's decision behind it. */
export function logServerFailure(where, err) {
  logError({
    source: 'SERVER', category: 'API', severity: 'WARNING',
    message: `${where}: ${textOf(err) || 'unknown failure'}`,
    detail: err?.stack ?? null,
    location: where,
  });
}

/** A money or job alert (`sendAlert`). */
export function logAlert(key, title, details) {
  logError({
    source: 'SERVER', category: 'MONEY_ALERT', severity: 'CRITICAL',
    message: title || key,
    detail: details && Object.keys(details).length ? textOf(details) : null,
    location: key,
  });
}

/** Run `fn` with the console.error capture switched off (an explicit door already recorded). */
export function withoutCapture(fn) {
  quiet += 1;
  try { return fn(); } finally { quiet -= 1; }
}

const JOB_HINT = /cron|sweep|worker|job|reconcile|retention|watcher|backup|scheduler/i;

/** What a console.error call says, as an error-log report. */
export function reportFromConsole(args) {
  const parts = args.map(textOf).filter(Boolean);
  const message = parts.join(' ').trim();
  if (!message) return null;
  const tag = /^\[([^\]]{1,60})\]/.exec(message)?.[1] ?? null;
  const stack = args.find((a) => a instanceof Error)?.stack
    ?? (typeof args[1] === 'string' && /\n\s+at /.test(args[1]) ? args[1] : null);
  const job = JOB_HINT.test(tag ?? '') || /cron error/i.test(message);
  return {
    source: 'SERVER',
    category: job ? 'JOB' : 'SERVER_LOG',
    severity: job ? 'WARNING' : 'MINOR',
    message,
    detail: stack,
    location: tag,
  };
}

let installed = false;
/** Wrap console.error once, at boot. Idempotent. */
export function installServerErrorCapture() {
  if (installed) return;
  installed = true;
  console.error = (...args) => {
    rawConsoleError(...args);
    if (quiet) return;
    try {
      const report = reportFromConsole(args);
      if (report && !report.message.startsWith('[error-log]')) logError(report);
    } catch { /* never into the caller */ }
  };
}
