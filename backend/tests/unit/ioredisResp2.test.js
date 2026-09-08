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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Connection sites are DISCOVERED, not listed.
 *
 * The list used to be five hardcoded paths, which failed in both directions: a
 * new module that constructs a Redis client was invisible to the guard until
 * somebody remembered to add it — precisely the "NEW connection site that
 * forgets the pin" this exists to catch — and a module that was deleted broke
 * the suite on a missing file rather than on a real regression.
 */
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(p)) out.push(p);
  }
  return out;
}

const CONSTRUCTS = /new\s+(?:Redis|IORedis)\s*\(/g;
const sites = walk(join(repo, 'backend'))
  .filter((f) => !/[\\/]tests?[\\/]/.test(f))
  .map((f) => [relative(repo, f), readFileSync(f, 'utf8')])
  .filter(([, src]) => CONSTRUCTS.test((CONSTRUCTS.lastIndex = 0, src)));

describe('ioredis 6: every Redis connection pins RESP2', () => {
  it('finds the connection sites at all', () => {
    // A discovery guard that discovers nothing passes silently. If the pattern
    // ever stops matching, this fails instead of quietly guarding zero files.
    expect(sites.length, 'no Redis construction sites found — the scan is broken').toBeGreaterThanOrEqual(3);
  });

  for (const [f, src] of sites) {
    it(`${f} pins protocol: 2`, () => {
      const pins = (src.match(/protocol:\s*2\b/g) || []).length;
      // realtimeBridge shares one opts object across three clients, so we require
      // at least one pin rather than one-per-constructor.
      expect(pins, `${f} constructs Redis without a protocol: 2 (RESP2) pin`).toBeGreaterThanOrEqual(1);
    });
  }
});
