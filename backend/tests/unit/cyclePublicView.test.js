// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
import { readFileSync } from 'node:fs';
import {
  publicCycleView,
  publicCyclePools,
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
  phantomBetsClosed: true,
  phantomBalanced: true,
  winner: null,
  isSettled: 'PENDING',
});

/** Strip comments so a negative assertion means "the code can't", not "doesn't mention". */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}
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
    expect(publicCyclePools(rawCycle())).toEqual({ delhiPool: 1200, bombayPool: 800 });
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
    expect(gen).toMatch(/emitPublic\('cycle_result', assertPublicCycleSafe\(/);
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
