// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The revocation check must FAIL CLOSED.
 *
 * It used to return `false` when the lookup threw, with a comment saying so —
 * "fail open for compatibility". The consequence is the exact thing a
 * revocation list exists to prevent: a signed-out session stays usable for as
 * long as the check is broken, and nothing anywhere reports it, because from
 * the caller's point of view the token simply is not revoked.
 *
 * This is a unit test rather than a Postgres one on purpose: the property under
 * test is what happens when the DATABASE IS NOT REACHABLE, which cannot be
 * exercised against a working database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// auth.middleware pulls in jwt.util, which refuses to load without a signing
// key — the same convention the other unit tests in this directory follow.
process.env.JWT_SECRET ||= 'test-only-paseto-seed';

const pgIsTokenRevoked = vi.fn();
vi.mock('#db/repositories/identity.js', () => ({ isTokenRevoked: pgIsTokenRevoked }));

const { isTokenRevoked } = await import('../../domains/identity/auth.middleware.js');

describe('token revocation fails closed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports a revoked token as revoked', async () => {
    pgIsTokenRevoked.mockResolvedValue(true);
    expect(await isTokenRevoked('t1')).toBe(true);
  });

  it('reports a live token as live', async () => {
    pgIsTokenRevoked.mockResolvedValue(false);
    expect(await isTokenRevoked('t1')).toBe(false);
  });

  it('REFUSES the token when the check itself fails', async () => {
    // The whole point. A database that is down, a pool that is exhausted, a
    // permission that was revoked — none of them may turn into "this token is
    // fine". Answering `true` costs an authenticated request during an outage;
    // answering `false` hands a logged-out session back to whoever holds it.
    pgIsTokenRevoked.mockRejectedValue(new Error('connection terminated'));
    expect(await isTokenRevoked('t1')).toBe(true);
  });

  it('refuses on a synchronous throw as well as a rejected promise', async () => {
    pgIsTokenRevoked.mockImplementation(() => { throw new Error('pool destroyed'); });
    expect(await isTokenRevoked('t1')).toBe(true);
  });
});
