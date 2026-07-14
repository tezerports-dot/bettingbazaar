// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * gateway/consistentHash.js — consistent hash ring with virtual nodes (CAP-72).
 * Pure logic, no I/O — unit-tested in backend/tests/unit/consistentHash.test.js.
 *
 * WHY (hybrid roadmap): when a domain is extracted to its own horizontally-
 * scaled service, requests/keys must map to instances so that adding or removing
 * one instance reshuffles only ≈1/N of keys — not everything. That is exactly
 * what consistent hashing gives you, and it is the standard primitive behind
 * sticky routing, cache sharding, and partition assignment at scale. Building it
 * now (pure + tested) means the gateway/proxy seam has the routing primitive
 * ready the day the first service is split out.
 *
 * Virtual nodes (default 100/physical) smooth the key distribution so no single
 * instance is hot.
 */
import crypto from 'crypto';

/** Stable 32-bit unsigned hash of a key (sha1 → first 8 hex). Deterministic across processes. */
export function hashKey(key) {
  return parseInt(crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8), 16);
}

export class HashRing {
  constructor(nodes = [], { vnodes = 100 } = {}) {
    this.vnodes = Math.max(1, vnodes | 0);
    this._ring = new Map();   // hash → node
    this._sorted = [];        // sorted hashes
    this._nodes = new Set();
    for (const n of nodes) this.addNode(n);
  }

  get size() { return this._nodes.size; }
  nodes() { return [...this._nodes]; }

  addNode(node) {
    if (node == null || this._nodes.has(node)) return this;
    this._nodes.add(node);
    for (let i = 0; i < this.vnodes; i++) this._ring.set(hashKey(`${node}#${i}`), node);
    this._resort();
    return this;
  }

  removeNode(node) {
    if (!this._nodes.has(node)) return this;
    this._nodes.delete(node);
    for (let i = 0; i < this.vnodes; i++) this._ring.delete(hashKey(`${node}#${i}`));
    this._resort();
    return this;
  }

  _resort() { this._sorted = [...this._ring.keys()].sort((a, b) => a - b); }

  /** Index of the first ring point >= h (wrapping to 0). */
  _slot(h) {
    const s = this._sorted;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < h) lo = mid + 1; else hi = mid; }
    return lo % s.length;
  }

  /** The node that owns `key`. Returns null on an empty ring. */
  get(key) {
    if (!this._sorted.length) return null;
    return this._ring.get(this._sorted[this._slot(hashKey(key))]);
  }

  /** Up to `n` DISTINCT nodes for `key`, walking the ring clockwise (for replicas/failover). */
  getN(key, n) {
    if (!this._sorted.length || n <= 0) return [];
    const want = Math.min(n, this._nodes.size);
    const out = [];
    let idx = this._slot(hashKey(key));
    for (let scanned = 0; scanned < this._sorted.length && out.length < want; scanned++) {
      const node = this._ring.get(this._sorted[idx]);
      if (!out.includes(node)) out.push(node);
      idx = (idx + 1) % this._sorted.length;
    }
    return out;
  }
}
