// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The real bet pools never reach a browser.
 *
 * The winner of a cycle is the MINORITY real-bet side
 * (`cycleGenerator.completeCycle`), so `realDelhi`/`realBombay` disclose the
 * result before it is declared — a player who can read them can bet the winner.
 * `phantomDelhi`/`phantomBombay` expose the house's balancing. None may cross
 * the public boundary: the frontend is public code, so a field in the HTTP body
 * or socket payload is exposed regardless of whether the panel renders it.
 *
 * This was already true by convention — three hand-written whitelists and
 * careful emitPublic-vs-emitAdmin discipline. These tests make it structural, so
 * a fourth public payload added the old way fails CI instead of shipping the
 * winner to every client.
 */
import { describe, it, expect } from 'vitest';
// ONE stripper, in `sourceText.js` — this file had its own copy, with an
// UNANCHORED block-comment pattern. Strip comments so a negative assertion
// means "the code can't", not "doesn't mention".
import { stripComments } from './sourceText.js';
import { readFileSync } from 'node:fs';
import {
  publicCycleView,
  publicCyclePools,
  poolsHidden,
  assertPublicCycleSafe,
  FORBIDDEN_PUBLIC_CYCLE_FIELDS,
} from '../../domains/markets/cyclePublicView.js';

/** A cycle carrying the secret breakdown, as the DB document does. */
const rawCycle = () => ({
  cycleId: 'c-1',
  type: '30_MIN',
  status: 'OPEN',
  startTime: 1_700_000_000_000,
  endTime: 1_700_000_060_000,
  realDelhi: 700,     // ← the secret: Delhi is the majority real side,
  realBombay: 300,    //   so BOMBAY (the minority) will win. Must never ship.
  phantomDelhi: 500,
  phantomBombay: 500,
  totalDelhi: 1200,   // real + phantom — the only figure users may see
  totalBombay: 800,
  phantomBetsClosed: false,
  phantomBalanced: false,
  winner: null,
  isSettled: 'PENDING',
});

/**
 * The same cycle once the house pools are balanced (`equalizePhantomPools`):
 * the two totals now differ by real money alone, so the smaller one, BOMBAY,
 * is the winner. This is what the merged phase must not send.
 */
const balancedCycle = () => ({ ...rawCycle(), status: 'MERGED', phantomBalanced: true });

const SIDE_FIELDS = ['delhiPool', 'bombayPool', 'totalDelhi', 'totalBombay'];

const src = (p) => stripComments(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

/**
 * The exact forbidden CYCLE-POOL field names — NOT a blanket /real|phantom/,
 * which would false-positive on legitimate neighbours like `isPhantom` (a bet
 * query filter) or `phantomAccess` (a user's own role). What must never appear
 * in a public payload is the per-side pool breakdown, by name.
 */
const FORBIDDEN_NAMES = new RegExp(FORBIDDEN_PUBLIC_CYCLE_FIELDS.join('|'));

describe('publicCycleView — the safe projection', () => {
  it('exposes the combined totals and NOTHING from the real/phantom breakdown', () => {
    const view = publicCycleView(rawCycle());
    // The user sees the total the whole time — never the split that reveals the winner.
    expect(view.totalDelhi).toBe(1200);
    expect(view.totalBombay).toBe(800);
    expect(view.delhiPool).toBe(1200);
    for (const field of FORBIDDEN_PUBLIC_CYCLE_FIELDS) {
      expect(view).not.toHaveProperty(field);
    }
    // Naming-independent sweep: no key even contains "real"/"phantom".
    expect(Object.keys(view).some((k) => /real|phantom/i.test(k))).toBe(false);
  });

  it('serialised to JSON, names no real/phantom field', () => {
    // The field NAME is the reliable signal — a raw value like 700 also appears
    // inside timestamps, so only the key sweep is meaningful here.
    const json = JSON.stringify(publicCycleView(rawCycle()));
    expect(json).not.toMatch(/real|phantom/i);
  });

  it('publicCyclePools returns combined totals only', () => {
    expect(publicCyclePools(rawCycle())).toEqual({
      poolsHidden: false, delhiPool: 1200, bombayPool: 800, totalDelhi: 1200, totalBombay: 800, totalPool: 2000,
    });
  });
});

describe('the pools are blind from the merge until the result (owner, 2026-10-08)', () => {
  it('a merged, balanced cycle carries the total alone, no side under any name', () => {
    const view = publicCycleView(balancedCycle());
    expect(view.poolsHidden).toBe(true);
    expect(view.totalPool).toBe(2000);
    for (const f of SIDE_FIELDS) expect(view).not.toHaveProperty(f);
    expect(JSON.stringify(view)).not.toMatch(/1200|800/);
  });

  it('hides MERGED and CLOSED, and an OPEN cycle whose house pools are already balanced', () => {
    expect(poolsHidden({ ...rawCycle(), status: 'MERGED' })).toBe(true);
    expect(poolsHidden({ ...rawCycle(), status: 'CLOSED' })).toBe(true);
    // The ticker balanced the pools but has not yet moved the status.
    expect(poolsHidden({ ...rawCycle(), status: 'OPEN', phantomBalanced: true })).toBe(true);
  });

  it('opposite: an OPEN unbalanced cycle and a declared one name both sides', () => {
    expect(poolsHidden(rawCycle())).toBe(false);
    const declared = publicCycleView({ ...balancedCycle(), status: 'RESULT_DECLARED', winner: 'BOMBAY' });
    expect(declared.poolsHidden).toBe(false);
    expect(declared.totalDelhi).toBe(1200);
    expect(declared.totalBombay).toBe(800);
  });

  it('the guard refuses a side figure beside poolsHidden, under every name', () => {
    for (const f of [...SIDE_FIELDS, 'newTotalDelhi', 'newTotalBombay']) {
      expect(() => assertPublicCycleSafe({ cycleId: 'c', poolsHidden: true, totalPool: 1, [f]: 1 }))
        .toThrow(/hidden/);
    }
    const ok = { cycleId: 'c', poolsHidden: true, totalPool: 1 };
    expect(assertPublicCycleSafe(ok)).toBe(ok);
  });

  it('the live snapshot builds its pools through publicCyclePools', () => {
    expect(src('domains/markets/cycleGenerator.service.js')).toMatch(/\.\.\.publicCyclePools\(cycle\)/);
  });

  it('every public recordBet names the cycle\'s poolsHidden', () => {
    const bet = src('domains/markets/bet.routes.js');
    const calls = [...bet.matchAll(/recordBet\(\s*cycleId\s*,\s*\{([\s\S]*?)\}\s*\)/g)];
    expect(calls.length).toBe(2);
    for (const m of calls) expect(m[1]).toMatch(/poolsHidden: poolsHidden\(/);
  });

  it('no socket event answers with the engine\'s raw game state (it carried the real pools)', () => {
    expect(src('startup/socketHandlers.js')).not.toMatch(/request_game_state|game_state/);
    expect(src('domains/markets/gameEngine.js')).not.toMatch(/getGameState|realDelhiPool/);
  });
});

describe('assertPublicCycleSafe — the runtime guard on hand-built emits', () => {
  it('passes a totals-only payload through unchanged', () => {
    const p = { cycleId: 'c-1', newTotalDelhi: 1200, newTotalBombay: 800 };
    expect(assertPublicCycleSafe(p)).toBe(p);
  });

  it('throws on the canonical breakdown fields', () => {
    for (const field of FORBIDDEN_PUBLIC_CYCLE_FIELDS) {
      expect(() => assertPublicCycleSafe({ cycleId: 'c', [field]: 1 })).toThrow(/forbidden field/);
    }
  });

  it('throws on the broadcast-renamed variants too (newRealDelhi, …)', () => {
    // The bet broadcast names its fields new*; a leak there would be
    // `newRealDelhi`, which a fixed-name list would miss.
    expect(() => assertPublicCycleSafe({ newRealDelhi: 700 })).toThrow(/forbidden/);
    expect(() => assertPublicCycleSafe({ newPhantomBombay: 500 })).toThrow(/forbidden/);
  });
});

describe('the public code paths cannot name a real/phantom field', () => {
  it('user.routes.js routes every cycle response through publicCycleView', () => {
    const source = src('domains/user/user.routes.js');
    // The whole file — every user-facing cycle route lives here — references no
    // breakdown field once the serializer is centralised.
    expect(source).toMatch(/import \{ publicCycleView \}/);
    expect(source).not.toMatch(FORBIDDEN_NAMES);
  });

  it('the live snapshot and public result emits are wrapped by the guard', () => {
    const gen = src('domains/markets/cycleGenerator.service.js');
    // The two public emits that carry pool numbers — the snapshot pushed on every
    // socket connect, and the public cycle_result — are wrapped, so a forbidden
    // field added to either throws at runtime instead of shipping.
    expect(gen).toMatch(/snapshot\[type\] = assertPublicCycleSafe\(/);
    // cycle_result is sent in the compact v2 format (realtimeProtocol.js), whose
    // encoder runs the guard before it builds the allowlisted wire object.
    expect(gen).toMatch(/emitCycleResult\(\{/);
    expect(gen).not.toMatch(/emitPublic\('cycle_result'/);
    const proto = src('domains/notification/realtimeProtocol.js');
    expect(proto).toMatch(/export function encodeCycleResult[\s\S]*?assertPublicCycleSafe\(/);
    // The breakdown that legitimately remains in this file goes to admins only.
    expect(gen).toMatch(/emitAdmin\('admin_cycle_result'/);
  });

  it('the public pool broadcast is coalesced through the guarded publisher, totals only', () => {
    const bet = src('domains/markets/bet.routes.js');
    // bet.routes no longer fans a public bet event out itself — it hands the
    // snapshot publisher the post-$inc totals, which the publisher coalesces and
    // guards. Every recordBet call carries totalDelhi/totalBombay ONLY; the
    // real/phantom breakdown in this file survives solely in the admin_bet_placed
    // emit (to admin-room).
    const recordCalls = [...bet.matchAll(/recordBet\(\s*cycleId\s*,\s*\{([\s\S]*?)\}\s*\)/g)];
    expect(recordCalls.length).toBeGreaterThan(0);
    for (const m of recordCalls) expect(m[1]).not.toMatch(/real|phantom/i);

    // The guard now lives at the single publish boundary: the publisher builds
    // every payload through assertPublicCycleSafe, so a forbidden field added to
    // the snapshot throws at runtime instead of shipping to every watcher.
    const pub = src('domains/markets/cycleSnapshotPublisher.js');
    expect(pub).toMatch(/assertPublicCycleSafe\(/);
    expect(pub).toMatch(/buildPayload\(cycleId, snap\)/);
  });
});
