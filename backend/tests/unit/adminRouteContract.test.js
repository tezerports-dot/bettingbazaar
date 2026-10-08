// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
 * A concrete path and a parameter pattern can live in the same mount. Express
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
    'GET /telegram/bot',
    'PUT /telegram/bot',
    'GET /account/telegram',
    'POST /account/telegram/relink',
    'PUT /account/telegram/two-factor',
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
    expect(toRegExp('/users/:userId/approve').test('/users/bulk/approve')).toBe(true);
  });

  it('does not cry wolf when the literal segments differ', () => {
    expect(toRegExp('/users/:userId/approve').test('/users/bulk/import')).toBe(false);
  });

  it('does not match across a segment boundary', () => {
    expect(toRegExp('/users/:userId/approve').test('/users/a/b/approve')).toBe(false);
  });
});

describe('no route is shadowed by an earlier pattern', () => {
  it('serves no KYC route — KYC was removed (owner, 2026-10-02)', () => {
    expect(paths.filter((p) => /\/kyc(\/|$)/.test(p))).toEqual([]);
  });

  it('has no earlier pattern that swallows a concrete path', () => {
    // Express matches in registration order. Whether `/x/bulk/stats` is read
    // as `/x/:id/stats` depends on which sub-router was mounted first — a
    // property no source-text assertion can see, so every concrete path is
    // matched against the real patterns registered before it.
    const swallowed = [];
    paths.forEach((p, i) => {
      const [method, path] = p.split(' ');
      if (path.includes(':')) return;
      const swallower = paths.slice(0, i).find((earlier) => {
        const [m, pattern] = earlier.split(' ');
        return m === method && pattern.includes(':') && toRegExp(pattern).test(path);
      });
      if (swallower) swallowed.push(`${swallower} is registered before ${p} and matches it`);
    });
    expect(swallowed).toEqual([]);
  });
  it('has no withdrawal-request routes', () => {
    // Removed with the orphaned parallel withdrawal system; the live path is
    // the P2P escrow flow under /api/payment.
    expect(paths.some((p) => p.includes('withdrawal-request'))).toBe(false);
  });

});
