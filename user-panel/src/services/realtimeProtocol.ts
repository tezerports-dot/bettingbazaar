// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Decoder for the compact, versioned `cycle_phase` / `cycle_result` payloads.
 *
 * Mirror of `backend/domains/notification/realtimeProtocol.js` (§5): the codes
 * below are that file's PHASE_CODES, AUDIENCE_CODES, SIDE_CODES and
 * EVENT_CODES, and change with it. The documented mapping is in
 * docs/reference/REALTIME_EVENTS.md.
 *
 * Decodes to the verbose shape the screens already read ({ cycleId, type,
 * audience, phase | winner, delhiPool, bombayPool, forced, timestamp }), so a
 * handler is the same for every version:
 *   - no `v`            → a legacy verbose payload, passed through;
 *   - v ≤ SUPPORTED     → decoded (unknown extra fields are ignored — the
 *                         server adds fields without raising `v`);
 *   - v > SUPPORTED     → null: this build cannot read it, and the app's
 *                         minimum-version gate is what moves it forward.
 * A payload that fails validation decodes to null and the event is dropped,
 * never half-applied.
 */
export const SUPPORTED_PROTOCOL_VERSION = 2;

const EVENT = { cycle_phase: 1, cycle_result: 2 } as const;
const PHASE: Record<number, string> = {
  1: 'OPEN', 2: 'MERGED', 3: 'CLOSED', 4: 'PAUSED', 5: 'CANCELLED', 6: 'RESULT_DECLARED', 7: 'COMPLETED',
};
const AUDIENCE: Record<number, 'VIP' | 'GENERAL'> = { 1: 'VIP', 2: 'GENERAL' };
const SIDE: Record<number, 'DELHI' | 'BOMBAY'> = { 1: 'DELHI', 2: 'BOMBAY' };

export type CyclePhaseEvent = {
  cycleId: string; type?: string; audience?: 'VIP' | 'GENERAL'; phase: string; timestamp?: number;
};
export type CycleResultEvent = {
  cycleId: string; type?: string; audience?: 'VIP' | 'GENERAL'; winner: 'DELHI' | 'BOMBAY';
  delhiPool?: number; bombayPool?: number; forced?: boolean; timestamp?: number;
};

type Wire = Record<string, unknown>;

function versionOf(raw: Wire): number | null {
  if (raw.v === undefined) return 0;                     // legacy verbose
  return Number.isInteger(raw.v) ? (raw.v as number) : null;
}

function common(raw: Wire, event: keyof typeof EVENT) {
  if (raw.t !== undefined && raw.t !== EVENT[event]) return null;
  if (typeof raw.c !== 'string' || !raw.c) return null;
  const audience = raw.a === undefined ? undefined : AUDIENCE[raw.a as number];
  if (raw.a !== undefined && !audience) return null;
  return {
    cycleId: raw.c,
    type: typeof raw.k === 'string' ? raw.k : undefined,
    audience,
    timestamp: Number.isFinite(raw.ts) ? (raw.ts as number) : undefined,
  };
}

export function decodeCyclePhase(raw: unknown): CyclePhaseEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Wire;
  const v = versionOf(w);
  if (v === null || v > SUPPORTED_PROTOCOL_VERSION) return null;
  if (v === 0) {
    return typeof w.cycleId === 'string' && typeof w.phase === 'string' ? (w as unknown as CyclePhaseEvent) : null;
  }
  const base = common(w, 'cycle_phase');
  const phase = PHASE[w.p as number];
  if (!base || !phase) return null;
  return { ...base, phase };
}

export function decodeCycleResult(raw: unknown): CycleResultEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Wire;
  const v = versionOf(w);
  if (v === null || v > SUPPORTED_PROTOCOL_VERSION) return null;
  if (v === 0) {
    return typeof w.cycleId === 'string' && (w.winner === 'DELHI' || w.winner === 'BOMBAY')
      ? (w as unknown as CycleResultEvent) : null;
  }
  const base = common(w, 'cycle_result');
  const winner = SIDE[w.w as number];
  if (!base || !winner) return null;
  return {
    ...base,
    winner,
    delhiPool: Number.isFinite(w.d) ? (w.d as number) : undefined,
    bombayPool: Number.isFinite(w.b) ? (w.b as number) : undefined,
    forced: w.f === 1 ? true : undefined,
  };
}
