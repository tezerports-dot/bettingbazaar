// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The compact v2 cycle_phase / cycle_result wire format (owner, 2026-10-09):
 * smaller, versioned, decodable, and never carrying a private field.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  encodeCyclePhase, encodeCycleResult, REALTIME_PROTOCOL_VERSION,
  PHASE_CODES, PHASE_NAMES, AUDIENCE_CODES, SIDE_CODES,
} from '../../../domains/notification/realtimeProtocol.js';
import { emitCyclePhase, emitCycleResult } from '../../../domains/notification/realtimeEmitters.js';
import { registry } from '../../../services/metrics.service.js';

const at = new Date('2026-10-09T04:00:00.000Z');
const bytes = (o) => Buffer.byteLength(JSON.stringify(o));

describe('encodeCyclePhase', () => {
  it('carries version, event code, cycle, board, audience, phase and time — nothing else', () => {
    const w = encodeCyclePhase({ cycleId: 'MIN-20261009-0400', type: 'MINUTE_1', audience: 'GENERAL', phase: 'MERGED', at });
    expect(w).toEqual({ v: REALTIME_PROTOCOL_VERSION, t: 1, c: 'MIN-20261009-0400', k: 'MINUTE_1', a: 2, p: 2, ts: at.getTime() });
  });

  it('refuses an unknown phase or audience instead of sending a code nobody can read', () => {
    expect(() => encodeCyclePhase({ cycleId: 'x', phase: 'SETTLING' })).toThrow(/unknown phase/);
    expect(() => encodeCyclePhase({ cycleId: 'x', phase: 'OPEN', audience: 'VVIP' })).toThrow(/unknown audience/);
    expect(() => encodeCyclePhase({ phase: 'OPEN' })).toThrow(/cycleId/);
  });

  it('every phase code round-trips through the documented inverse table', () => {
    for (const [name, n] of Object.entries(PHASE_CODES)) expect(PHASE_NAMES[n]).toBe(name);
    expect(new Set(Object.values(PHASE_CODES)).size).toBe(Object.keys(PHASE_CODES).length);
    expect(AUDIENCE_CODES).toEqual({ VIP: 1, GENERAL: 2 });
    expect(SIDE_CODES).toEqual({ DELHI: 1, BOMBAY: 2 });
  });
});

describe('encodeCycleResult', () => {
  const result = { cycleId: 'MIN-20261009-0400', type: 'MINUTE_1', audience: 'VIP', winner: 'BOMBAY', delhiPool: 125000, bombayPool: 98000, at };

  it('carries the combined pools and the winner only', () => {
    expect(encodeCycleResult(result)).toEqual({
      v: 2, t: 2, c: 'MIN-20261009-0400', k: 'MINUTE_1', a: 1, w: 2, d: 125000, b: 98000, ts: at.getTime(),
    });
  });

  it('keeps the forced-result flag (disclosed in the board rules)', () => {
    expect(encodeCycleResult({ ...result, forced: true }).f).toBe(1);
    expect(encodeCycleResult(result)).not.toHaveProperty('f');
  });

  it('refuses a real or phantom pool however it is named — the leak that reveals the winner', () => {
    expect(() => encodeCycleResult({ ...result, realDelhi: 1 })).not.toThrow();   // unknown keys are never copied…
    const w = encodeCycleResult({ ...result, realDelhi: 1, phantomBombay: 2 });
    expect(Object.keys(w).some((k) => /real|phantom/i.test(k))).toBe(false);     // …and the allowlist drops them
    expect(JSON.stringify(w)).not.toMatch(/real|phantom/i);
  });

  it('an unknown winner is refused', () => {
    expect(() => encodeCycleResult({ ...result, winner: 'KOLKATA' })).toThrow(/unknown winner/);
  });
});

describe('payload size: before (verbose v1) vs after (compact v2)', () => {
  // The exact shapes cycleGenerator emitted before this change.
  const verbosePhase = {
    cycleId: 'MIN-20261009-0400', type: 'MINUTE_1', audience: 'GENERAL', phase: 'MERGED',
    message: 'Pools merging...', timestamp: at,
  };
  const verboseResult = {
    cycleId: 'MIN-20261009-0400', type: 'MINUTE_1', audience: 'GENERAL', winner: 'BOMBAY',
    delhiPool: 125000, bombayPool: 98000, message: '1 Minute Winner: BOMBAY!', timestamp: at,
  };

  it('cycle_phase is at least 40% smaller', () => {
    const before = bytes(verbosePhase);
    const after = bytes(encodeCyclePhase({ ...verbosePhase, at }));
    expect(after).toBeLessThan(before * 0.6);
  });

  it('cycle_result is at least 35% smaller', () => {
    const before = bytes(verboseResult);
    const after = bytes(encodeCycleResult({ ...verboseResult, at }));
    expect(after).toBeLessThan(before * 0.65);
  });
});

describe('emitCyclePhase / emitCycleResult', () => {
  it('broadcast the SAME encoded payload on SSE and socket.io, and count it', async () => {
    const sse = { broadcast: vi.fn() };
    const io = { emit: vi.fn() };
    const sent = emitCyclePhase({ cycleId: 'c1', type: 'MINUTE_1', audience: 'VIP', phase: 'PAUSED', at }, { io, sseManager: sse });
    expect(sse.broadcast).toHaveBeenCalledWith('cycle_phase', sent);
    expect(io.emit).toHaveBeenCalledWith('cycle_phase', sent);
    emitCycleResult({ cycleId: 'c1', winner: 'DELHI', forced: true, at }, { io, sseManager: sse });
    expect(io.emit).toHaveBeenLastCalledWith('cycle_result', expect.objectContaining({ v: 2, w: 1, f: 1 }));

    const text = await registry.metrics();
    expect(text).toMatch(/bb_realtime_events_total\{[^}]*event="cycle_phase"[^}]*\} [1-9]/);
    expect(text).toMatch(/bb_realtime_payload_bytes_total\{[^}]*event="cycle_result"[^}]*\} [1-9]/);
  });

  it('a transport that throws does not stop the other one', () => {
    const io = { emit: vi.fn() };
    const sse = { broadcast: () => { throw new Error('closed'); } };
    emitCyclePhase({ cycleId: 'c1', phase: 'CANCELLED' }, { io, sseManager: sse });
    expect(io.emit).toHaveBeenCalledOnce();
  });
});
