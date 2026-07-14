// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the consistent hash ring (CAP-72) — pure, no I/O. Proves the
// two properties that matter: even distribution, and MINIMAL remap on node churn
// (the whole reason to use consistent hashing over key % N).
import { describe, it, expect } from 'vitest';
import { HashRing, hashKey } from '../../gateway/consistentHash.js';

describe('HashRing', () => {
  it('empty ring returns null', () => {
    expect(new HashRing().get('x')).toBe(null);
  });

  it('maps a key deterministically to a member node', () => {
    const r = new HashRing(['a', 'b', 'c']);
    const k = 'user-42';
    expect(r.get(k)).toBe(r.get(k));
    expect(['a', 'b', 'c']).toContain(r.get(k));
  });

  it('distributes keys roughly evenly', () => {
    const r = new HashRing(['a', 'b', 'c', 'd']);
    const counts = {};
    for (let i = 0; i < 4000; i++) { const o = r.get('k' + i); counts[o] = (counts[o] || 0) + 1; }
    for (const n of ['a', 'b', 'c', 'd']) expect(counts[n]).toBeGreaterThan((4000 / 4) * 0.6);
  });

  it('remaps only ~1/N of keys when a node is removed (not ~all)', () => {
    const r = new HashRing(['a', 'b', 'c', 'd']);
    const N = 4000;
    const before = [];
    for (let i = 0; i < N; i++) before.push(r.get('k' + i));
    r.removeNode('c');
    let moved = 0;
    for (let i = 0; i < N; i++) if (r.get('k' + i) !== before[i]) moved++;
    expect(moved / N).toBeLessThan(0.4); // key % N would move ~0.75
  });

  it('getN returns distinct nodes, capped at ring size', () => {
    const r = new HashRing(['a', 'b', 'c', 'd']);
    const three = r.getN('key', 3);
    expect(three.length).toBe(3);
    expect(new Set(three).size).toBe(3);
    expect(r.getN('key', 99).length).toBe(4);
  });

  it('hashKey is stable', () => {
    expect(hashKey('abc')).toBe(hashKey('abc'));
    expect(typeof hashKey('abc')).toBe('number');
  });
});
