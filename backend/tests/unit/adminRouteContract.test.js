// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The admin router really serves the paths the admin panel calls.
 *
 * ── The failure this catches ────────────────────────────────────────────────
 * The admin panel is a separate application built from a separate tree. Nothing
 * in either build checks that a path one calls is a path the other serves, so a
 * renamed route, a changed prefix, or a shadowed pattern surfaces as a 404 in
 * front of an operator — and a 404 on a page nobody opens until the bot is
 * suspended is a 404 discovered during the outage it exists to fix.
 *
 * ── Shadowing, specifically ─────────────────────────────────────────────────
 * `/kyc/bulk/stats` and `/kyc/:userId/approve` live in the same mount. Express
 * matches in registration order, so whether `bulk` is read as a userId depends
 * on which sub-router was mounted first — a property no source-text assertion
 * can see. This walks the ACTUAL router stack.
 */
import { describe, it, expect, beforeAll } from 'vitest';

let paths = [];

beforeAll(async () => {
  // The router pulls in the auth middleware, which pulls in the PASETO
  // authority, which fail-fasts on a missing secret at import time. That
  // fail-fast is deliberate and worth keeping, so the test supplies a throwaway
  // seed rather than the module being made lenient for tests.
  process.env.PASETO_SECRET_KEY ||= 'a'.repeat(64);

  const { default: router } = await import('../../routes/admin/index.js');

  const walk = (stack, out) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          out.push(`${m.toUpperCase()} ${layer.route.path}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, out);
      }
    }
    return out;
  };

  paths = walk(router.stack, []);
});

describe('the identity and payout control plane is reachable', () => {
  // Exactly what admin-panel/src/services/api.ts calls, minus the /api/admin
  // prefix that server.js supplies.
  const required = [
    'GET /telegram/config',
    'POST /telegram/config',
    'POST /telegram/channel',
    'GET /telegram/bots',
    'POST /telegram/bots',
    'POST /telegram/bots/:id/promote',
    'POST /telegram/bots/:id/webhook',
    'POST /telegram/bots/:id/retire',
    'GET /telegram/templates',
    'PUT /telegram/templates/:key',
    'GET /kyc/bulk/stats',
    'GET /kyc/bulk/export',
    'POST /kyc/bulk/import',
    'GET /referral/stats',
    'POST /referral/disburse',
  ];

  it.each(required)('serves %s', (p) => {
    expect(paths).toContain(p);
  });
});

/** Turn an Express path pattern into the regex that decides what it matches. */
const toRegExp = (pattern) => new RegExp(
  `^${pattern.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`,
);

describe('the shadowing check can actually fail', () => {
  // Without this the matcher could quietly become a no-op — matching nothing,
  // and therefore passing no matter what order the routes are mounted in.
  it('sees a wildcard swallowing a concrete path', () => {
    expect(toRegExp('/kyc/:userId/approve').test('/kyc/bulk/approve')).toBe(true);
  });

  it('does not cry wolf when the literal segments differ', () => {
    expect(toRegExp('/kyc/:userId/approve').test('/kyc/bulk/import')).toBe(false);
  });

  it('does not match across a segment boundary', () => {
    expect(toRegExp('/kyc/:userId/approve').test('/kyc/a/b/approve')).toBe(false);
  });
});

describe('the KYC review routes are reachable and unshadowed', () => {
  it('serves the queue and both decisions', () => {
    expect(paths).toContain('GET /kyc/queue');
    expect(paths).toContain('POST /kyc/:userId/approve');
    expect(paths).toContain('POST /kyc/:userId/reject');
  });

  it('has no earlier pattern that swallows a /kyc/bulk/* path', () => {
    // Express matches in registration order, and `/kyc/:userId/approve` sits in
    // the same mount as `/kyc/bulk/import`. Whether `bulk` gets read as a user
    // id depends on which sub-router was mounted first — a property no
    // source-text assertion can see, so the concrete paths are matched against
    // the real patterns here.
    const concrete = paths
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.split(' ')[1].startsWith('/kyc/bulk/'));
    expect(concrete.length).toBe(3);

    for (const { p, i } of concrete) {
      const [method, path] = p.split(' ');
      const swallower = paths.slice(0, i).find((earlier) => {
        const [m, pattern] = earlier.split(' ');
        return m === method && pattern.includes(':') && toRegExp(pattern).test(path);
      });
      expect(swallower, `${swallower} is registered before ${p} and matches it`).toBeUndefined();
    }
  });

  it('no longer serves a document endpoint', () => {
    expect(paths.some((p) => p.includes('/document/'))).toBe(false);
  });
});

describe('the Telegram control plane is unshadowed', () => {
  it('has no earlier wildcard swallowing a concrete /telegram/* path', () => {
    // `/telegram/templates/:key` and `/telegram/bots/:id/promote` sit in the
    // same mount as the concrete `/telegram/config`, `/telegram/channel`,
    // `/telegram/bots` and `/telegram/templates`. These are the routes an
    // operator reaches for during an outage — a shadowed one would 404 at
    // exactly the moment nobody can sign in, which is the worst possible time
    // to discover it.
    const concrete = paths
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => {
        const path = p.split(' ')[1];
        return path.startsWith('/telegram/') && !path.includes(':');
      });
    // Guard against this degenerating into a check over an empty set.
    expect(concrete.length).toBeGreaterThanOrEqual(6);

    for (const { p, i } of concrete) {
      const [method, path] = p.split(' ');
      const swallower = paths.slice(0, i).find((earlier) => {
        const [m, pattern] = earlier.split(' ');
        return m === method && pattern.includes(':') && toRegExp(pattern).test(path);
      });
      expect(swallower, `${swallower} is registered before ${p} and matches it`).toBeUndefined();
    }
  });
});

describe('the removed systems are not still mounted', () => {
  it('has no account-recovery routes', () => {
    expect(paths.some((p) => p.includes('account-recovery'))).toBe(false);
  });

  it('has no withdrawal-request routes', () => {
    // Removed with the orphaned parallel withdrawal system; the live path is
    // the P2P escrow flow under /api/payment.
    expect(paths.some((p) => p.includes('withdrawal-request'))).toBe(false);
  });

  it('has no kyc/link-documents route', () => {
    // One-account-per-Aadhaar is the unique index on KycVerification.aadhaarHash.
    expect(paths.some((p) => p.includes('link-documents'))).toBe(false);
  });
});
