// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The harness must never hand back an account that was never written.
 *
 * ── What this cost, and how it hid ──────────────────────────────────────────
 * `createUser` is `ON CONFLICT (mobile) DO NOTHING` and, on a collision,
 * returns the OTHER user — the one that already holds that number. `actor()`
 * ignored that return value, so it signed a token for a `userId` with no row
 * behind it and `updateUser` matched nothing.
 *
 * Nothing failed at that point. The consequence arrived later, as a 401 from
 * `authenticate` and a `null` from the test's own read, in whichever assertion
 * happened to touch the phantom actor first — and, because the database is
 * shared across this whole tier and never reset between files, in a FILE THAT
 * HAD NOTHING TO DO WITH IT. Six tests across two unrelated suites went red in
 * CI while every one of them passed locally.
 *
 * The generator's number space was the cause: a seed from a 90,000-wide range,
 * counted upward, drawn once per file, across 65 files sharing one database.
 *
 * ── Why these assertions and not a collision simulation ────────────────────
 * Forcing a collision means reaching inside the generator, which would test the
 * mock rather than the harness. These assert the property that actually has to
 * hold — every actor this harness returns is an account that exists and can
 * authenticate — which is the thing that was false.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getUser, createUser } from '#db/repositories/users.js';
import { actor, merchantActor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the route harness builds accounts that actually exist', () => {
  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });

  it('returns an actor whose row is really in the database', async () => {
    const who = await actor({});
    const row = await getUser(who.userId);
    expect(row).toBeTruthy();
    expect(row.userId).toBe(who.userId);
    // The mobile it reports is the one it actually claimed, not the one it
    // first tried — a retry must not leave the caller holding a stale number.
    expect(row.mobile).toBe(who.mobile);
  });

  it('applies the role patch, which a phantom actor silently would not', async () => {
    // `updateUser` on a userId with no row matches nothing and reports nothing.
    // An admin actor that is not actually an admin fails later as a 403 that
    // reads exactly like a genuine authorisation bug.
    const admin = await actor({ isAdmin: true });
    const row = await getUser(admin.userId);
    expect(row.isAdmin).toBe(true);
  });

  it('gives many concurrent actors distinct, real accounts', async () => {
    // Promise.all is where the old generator repeated within a millisecond,
    // and it is how most suites build their fixtures.
    const many = await Promise.all(Array.from({ length: 12 }, () => actor({})));
    const ids = new Set(many.map((a) => a.userId));
    const mobiles = new Set(many.map((a) => a.mobile));
    expect(ids.size).toBe(12);
    expect(mobiles.size).toBe(12);

    const rows = await Promise.all(many.map((a) => getUser(a.userId)));
    expect(rows.every((r) => r !== null)).toBe(true);
  });

  it('builds a merchant with its own account row', async () => {
    const m = await merchantActor({});
    expect(m.merchantId).toBeTruthy();
    expect(m.auth).toMatch(/^Bearer /);
  });

  it('documents the conflict behaviour the harness now guards against', async () => {
    // This is the mechanism, asserted so nobody has to rediscover it: a second
    // insert on a taken mobile writes NOTHING and hands back the FIRST user.
    const mobile = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    const firstId = `hz-first-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const secondId = `hz-second-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const first = await createUser({ userId: firstId, username: 'first', mobile });
    expect(first.created).toBe(true);

    const second = await createUser({ userId: secondId, username: 'second', mobile });
    expect(second.created).toBe(false);
    // Not the id that was asked for — the one that already held the number.
    expect(second.user.userId).toBe(firstId);
    // And nothing was written for the id the caller named.
    expect(await getUser(secondId)).toBeNull();
  });
});
