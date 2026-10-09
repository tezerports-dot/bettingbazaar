// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The compact, versioned wire format of the public cycle lifecycle events
 * `cycle_phase` and `cycle_result` (owner, 2026-10-09). The one owner of the
 * codes; the player panel's decoder (`user-panel/src/services/realtimeProtocol.ts`)
 * mirrors it, and docs/reference/REALTIME_EVENTS.md documents it.
 *
 *   cycle_phase   { v, t:1, c, k, a, p, ts }
 *   cycle_result  { v, t:2, c, k, a, w, d, b, ts, f? }
 *
 *   v   protocol version (REALTIME_PROTOCOL_VERSION). Additive fields keep the
 *       version; renaming, removing or re-coding a field raises it.
 *   t   event code (EVENT_CODES), repeated in the body so a decoder can check
 *       it was handed the event it expects.
 *   c   cycleId      k   board key (the cycle's `type`)
 *   a   audience (AUDIENCE_CODES)      p   phase (PHASE_CODES)
 *   w   winner (SIDE_CODES)
 *   d,b combined Delhi / Bombay pools after the result, in rupees — the same
 *       numbers the verbose result carried; never a real or phantom pool
 *   ts  epoch milliseconds      f   1 when staff forced the result (kept: it
 *       is what the rules' "exceptional situations" line discloses)
 *
 * What it dropped: the human sentence (`message`) — fixed text per phase that
 * the panel already knows — and the ISO timestamp string. What it never
 * carries: anything per side before the result, or any private field; every
 * encoder output is an allowlist, and a result goes through
 * `assertPublicCycleSafe` before it is encoded.
 */
import { assertPublicCycleSafe } from '../markets/cyclePublicView.js';

export const REALTIME_PROTOCOL_VERSION = 2;

export const EVENT_CODES = Object.freeze({ cycle_phase: 1, cycle_result: 2 });
export const PHASE_CODES = Object.freeze({
  OPEN: 1, MERGED: 2, CLOSED: 3, PAUSED: 4, CANCELLED: 5, RESULT_DECLARED: 6, COMPLETED: 7,
});
export const AUDIENCE_CODES = Object.freeze({ VIP: 1, GENERAL: 2 });
export const SIDE_CODES = Object.freeze({ DELHI: 1, BOMBAY: 2 });

const PHASE_KEYS = ['v', 't', 'c', 'k', 'a', 'p', 'ts'];
const RESULT_KEYS = ['v', 't', 'c', 'k', 'a', 'w', 'd', 'b', 'ts', 'f'];

function code(table, value, what) {
  const n = table[value];
  if (n === undefined) throw Object.assign(new Error(`realtimeProtocol: unknown ${what} '${value}'`), { status: 500 });
  return n;
}

function epochMs(at) {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.now();
  return Number.isFinite(ms) ? ms : Date.now();
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** @param {{cycleId:string, type?:string, audience?:string, phase:string, at?:Date|number}} e */
export function encodeCyclePhase({ cycleId, type, audience, phase, at }) {
  if (!cycleId) throw Object.assign(new Error('realtimeProtocol: cycle_phase needs a cycleId'), { status: 500 });
  return pick({
    v: REALTIME_PROTOCOL_VERSION,
    t: EVENT_CODES.cycle_phase,
    c: String(cycleId),
    k: type ? String(type) : undefined,
    a: audience ? code(AUDIENCE_CODES, audience, 'audience') : undefined,
    p: code(PHASE_CODES, phase, 'phase'),
    ts: epochMs(at),
  }, PHASE_KEYS);
}

/**
 * @param {{cycleId:string, type?:string, audience?:string, winner:string,
 *          delhiPool?:number, bombayPool?:number, forced?:boolean, at?:Date|number}} e
 */
export function encodeCycleResult({ cycleId, type, audience, winner, delhiPool, bombayPool, forced, at }) {
  if (!cycleId) throw Object.assign(new Error('realtimeProtocol: cycle_result needs a cycleId'), { status: 500 });
  // The same guard the verbose payload passed: no real/phantom field, and no
  // per-side figure beside a hidden-pools flag.
  assertPublicCycleSafe({ cycleId, type, audience, winner, delhiPool, bombayPool });
  return pick({
    v: REALTIME_PROTOCOL_VERSION,
    t: EVENT_CODES.cycle_result,
    c: String(cycleId),
    k: type ? String(type) : undefined,
    a: audience ? code(AUDIENCE_CODES, audience, 'audience') : undefined,
    w: code(SIDE_CODES, winner, 'winner'),
    d: Number.isFinite(delhiPool) ? delhiPool : undefined,
    b: Number.isFinite(bombayPool) ? bombayPool : undefined,
    ts: epochMs(at),
    f: forced ? 1 : undefined,
  }, RESULT_KEYS);
}

/** Inverse phase table, for the decoder tests and for anyone reading a capture. */
export const PHASE_NAMES = Object.freeze(Object.fromEntries(Object.entries(PHASE_CODES).map(([k, v]) => [v, k])));
