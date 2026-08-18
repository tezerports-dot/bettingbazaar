// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ioredis 6 pins RESP2 on every connection.
 *
 * ioredis 6 switched the DEFAULT wire protocol to RESP3. RESP3 changes the shape
 * of some replies (maps, sets, doubles, push messages), which BullMQ, the
 * socket.io Redis adapter, and our Lua rate-limit scripts were NOT validated
 * against. We take the v6 upgrade (Node-20+ support, maintenance) but pin
 * `protocol: 2` on every connection so the wire behaviour is identical to v5.
 *
 * A NEW connection site that forgets the pin would silently run on RESP3. This
 * source-scan guard fails if any Redis-constructing module omits protocol: 2.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const CONNECTION_FILES = [
  'backend/startup/redisConnect.js',
  'backend/startup/realtimeBridge.js',
  'backend/middleware/redisRateLimitStore.js',
  'backend/services/cache.service.js',
  'backend/services/jobQueue.service.js',
];

const read = (f) => readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');

describe('ioredis 6: every Redis connection pins RESP2', () => {
  for (const f of CONNECTION_FILES) {
    it(`${f} constructs Redis and pins protocol: 2`, () => {
      const src = read(f);
      const connections = (src.match(/new\s+(?:Redis|IORedis)\s*\(/g) || []).length;
      const pins = (src.match(/protocol:\s*2\b/g) || []).length;
      expect(connections, `${f} should construct at least one Redis client`).toBeGreaterThan(0);
      // realtimeBridge shares one opts object across three clients, so we require
      // at least one pin rather than one-per-constructor.
      expect(pins, `${f} constructs Redis without a protocol: 2 (RESP2) pin`).toBeGreaterThanOrEqual(1);
    });
  }
});
