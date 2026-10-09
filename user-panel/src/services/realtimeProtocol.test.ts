// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The panel's decoder for compact cycle events: the codes match the backend
 * encoder exactly (one table, two mirrors), legacy payloads still read, an
 * unknown future version is dropped, and garbage never half-applies.
 */
import { describe, it, expect } from 'vitest';
import { decodeCyclePhase, decodeCycleResult, SUPPORTED_PROTOCOL_VERSION } from './realtimeProtocol';
// The backend encoder itself — the mirror is checked against its owner (§5).
import * as wire from '../../../backend/domains/notification/realtimeProtocol.js';

const at = 1791518400000;

describe('decodeCyclePhase', () => {
  it('decodes every phase the backend can encode', () => {
    for (const phase of Object.keys(wire.PHASE_CODES)) {
      const encoded = wire.encodeCyclePhase({ cycleId: 'c1', type: 'MINUTE_1', audience: 'GENERAL', phase, at });
      expect(decodeCyclePhase(encoded)).toEqual({ cycleId: 'c1', type: 'MINUTE_1', audience: 'GENERAL', phase, timestamp: at });
    }
  });

  it('the panel supports exactly the backend protocol version', () => {
    expect(SUPPORTED_PROTOCOL_VERSION).toBe(wire.REALTIME_PROTOCOL_VERSION);
  });

  it('passes a legacy verbose payload through', () => {
    const legacy = { cycleId: 'c1', type: 'MINUTE_1', phase: 'CLOSED', message: 'Bets closed!' };
    expect(decodeCyclePhase(legacy)).toBe(legacy);
  });

  it.each([
    ['a future version', { v: 3, t: 1, c: 'c1', p: 2 }],
    ['a non-integer version', { v: '2', t: 1, c: 'c1', p: 2 }],
    ['the wrong event code', { v: 2, t: 2, c: 'c1', p: 2 }],
    ['an unknown phase code', { v: 2, t: 1, c: 'c1', p: 99 }],
    ['an unknown audience code', { v: 2, t: 1, c: 'c1', a: 9, p: 2 }],
    ['no cycle id', { v: 2, t: 1, p: 2 }],
    ['not an object', 'MERGED'],
    ['null', null],
  ])('drops %s', (_why, raw) => {
    expect(decodeCyclePhase(raw)).toBeNull();
  });

  it('ignores fields added later without a version bump', () => {
    expect(decodeCyclePhase({ v: 2, t: 1, c: 'c1', p: 3, zz: 'new' })).toMatchObject({ cycleId: 'c1', phase: 'CLOSED' });
  });
});

describe('decodeCycleResult', () => {
  it('round-trips the backend encoder, including the forced flag', () => {
    const encoded = wire.encodeCycleResult({
      cycleId: 'c1', type: 'MINUTE_1', audience: 'VIP', winner: 'DELHI', delhiPool: 500, bombayPool: 700, forced: true, at,
    });
    expect(decodeCycleResult(encoded)).toEqual({
      cycleId: 'c1', type: 'MINUTE_1', audience: 'VIP', winner: 'DELHI', delhiPool: 500, bombayPool: 700, forced: true, timestamp: at,
    });
  });

  it('feeds the same fields the result handler reads (poolStats: delhiPool/bombayPool)', () => {
    const d = decodeCycleResult({ v: 2, t: 2, c: 'c1', w: 2, d: 10, b: 20, ts: at })!;
    expect([d.winner, d.delhiPool, d.bombayPool]).toEqual(['BOMBAY', 10, 20]);
    expect(d.forced).toBeUndefined();
  });

  it('drops an unknown winner code', () => {
    expect(decodeCycleResult({ v: 2, t: 2, c: 'c1', w: 3 })).toBeNull();
  });
});
