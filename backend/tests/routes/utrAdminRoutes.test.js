// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The bank-reference anti-fraud control, driven over HTTP.
 *
 * A UTR is the reference a player quotes to prove they paid. One reference
 * belongs to one order — reusing one is either a mistake or an attempt to claim
 * a single transfer twice. This router is the operator's side of that control:
 * the registry, the flag, the contested queue, the totals and a player's
 * history.
 *
 * ── Why over HTTP and against a real database ───────────────────────────────
 * The defects this file's handlers shipped were not logic errors. A resolve
 * route (deleted 2026-10-01) called `.save()` on a plain repository row and
 * threw on every call; a mocked data layer has whatever method the handler
 * reaches for, so it would have reported that route working.
 *
 * Another: flagging wrote `{ status: 'FRAUD' }` with no actor and no
 * reason. A fraud marking nobody signed is one nobody can defend in a dispute,
 * and it blocks a real customer who then has nobody to appeal to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { claimUtr, getUtr, releaseUtr } from '#db/repositories/utr.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { historyFor } from '#db/repositories/audit.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('UTR admin routes', () => {
  let app; let admin;

  // Unique per run: the registry is append-only by trigger, so a fixture that
  // deleted its rows would be refused — and rightly, because a table that can
  // be emptied prevents reuse only until somebody empties it.
  const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
  let seq = 0;
  const nextRef = () => { seq += 1; return `UTR${RUN}${String(seq).padStart(5, '0')}`; };

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../routes/admin/utr.admin.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A real order with a real reference claimed against it. */
  const claimed = async ({ state = 'PROCESSING', owner = null, extra = {} } = {}) => {
    const who = owner || await actor({});
    const utr = nextRef();
    const orderId = `ORD-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500, state, utrNumber: utr, ...extra,
    });
    const claim = await claimUtr({ utr, orderId, userId: who.userId, amountRupees: 500 });
    expect(claim.ok, 'fixture failed to claim its own reference').toBe(true);
    return { utr, orderId, who };
  };

  // ── Authorisation ─────────────────────────────────────────────────────────
  it('refuses every route without a token', async () => {
    for (const call of [
      () => request(app).get('/utr-registry'),
      () => request(app).get('/utr/stats'),
      () => request(app).put('/utr-registry/ABC/flag').send({ reason: 'x' }),
      () => request(app).put('/utr-registry/ABC/clear').send({}),
      () => request(app).get('/utr/contested'),
      () => request(app).get('/utr/user-history/whoever'),
    ]) {
      expect((await call()).status, 'an unauthenticated call must never reach a handler').toBe(401);
    }
  });

  it('refuses the registry to a signed-in NON-admin', async () => {
    const nobody = await actor({});
    expect((await as(app, nobody).get('/utr-registry')).status).toBe(403);
    expect((await as(app, nobody).put('/utr-registry/ABC/flag').send({ reason: 'x' })).status).toBe(403);
  });

  // ── The registry ──────────────────────────────────────────────────────────
  it('lists the registry with the player and the order joined on', async () => {
    const { utr, orderId, who } = await claimed();
    const res = await as(app, admin).get('/utr-registry?limit=200');
    expect(res.status).toBe(200);

    const entry = res.body.entries.find((e) => e.utr === utr);
    expect(entry, 'the reference just claimed is missing from the registry').toBeTruthy();
    expect(entry.orderId).toBe(orderId);
    expect(entry.user.username).toBe(who.userId);
    expect(entry.order).toMatchObject({ orderId, type: 'DEPOSIT', fiatAmount: 500 });
  });

  it('reports a total that describes the same instant as the page', async () => {
    // The page and its total come from one statement (COUNT(*) OVER ()). Two
    // statements would let a claim land between them and report a total that
    // no page can reach.
    await claimed();
    const res = await as(app, admin).get('/utr-registry?limit=1&page=1');
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(1);
    expect(res.body.pagination.limit).toBe(1);
  });

  it('filters by status', async () => {
    const { utr } = await claimed();
    await releaseUtr((await getUtr(utr)).orderId);
    const res = await as(app, admin).get('/utr-registry?status=RELEASED&limit=200');
    expect(res.body.entries.every((e) => e.status === 'RELEASED')).toBe(true);
    expect(res.body.entries.some((e) => e.utr === utr)).toBe(true);
  });

  it('looks one reference up, normalising how it was typed', async () => {
    // A reference typed with a space in it is the same reference. If the lookup
    // did not normalise, an operator searching for what the player sent them
    // would be told it does not exist.
    const { utr, orderId } = await claimed();
    const spaced = `${utr.slice(0, 4)} ${utr.slice(4).toLowerCase()}`;
    const res = await as(app, admin).get(`/utr-registry/${encodeURIComponent(spaced)}`);
    expect(res.status).toBe(200);
    expect(res.body.entry).toMatchObject({ utr, orderId });
  });

  it('404s a reference nobody has claimed', async () => {
    const res = await as(app, admin).get(`/utr-registry/NOSUCH${RUN}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // ── Flagging ──────────────────────────────────────────────────────────────
  it('REFUSES an unreasoned flag', async () => {
    // The reason is what the player is shown if they appeal. A marking with no
    // reason blocks a real customer who then has nobody to appeal to.
    const { utr } = await claimed();
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: null }]) {
      const res = await as(app, admin).put(`/utr-registry/${utr}/flag`).send(body);
      expect(res.status, `a flag with reason=${JSON.stringify(body.reason)} was accepted`).toBe(400);
    }
    expect((await getUtr(utr)).status, 'a refused flag still changed the row').toBe('ACTIVE');
  });

  it('records WHO flagged and WHY, on the row', async () => {
    const { utr } = await claimed();
    const res = await as(app, admin).put(`/utr-registry/${utr}/flag`).send({ reason: '  Screenshot is edited.  ' });
    expect(res.status).toBe(200);
    expect(res.body.entry).toMatchObject({ status: 'FRAUD', flaggedBy: admin.userId, flagReason: 'Screenshot is edited.' });

    const row = await getUtr(utr);
    expect(row.status).toBe('FRAUD');
    expect(row.flaggedBy).toBe(admin.userId);
    expect(row.flaggedAt).toBeTruthy();
  });

  it('writes the flag to the audit log, attributed', async () => {
    const { utr, orderId } = await claimed();
    await as(app, admin).put(`/utr-registry/${utr}/flag`).send({ reason: 'Duplicate transfer' });
    const entries = (await historyFor(utr)).filter((e) => e.action === 'UTR_FLAGGED_FRAUD');
    expect(entries, 'the flag left no audit trail').toHaveLength(1);
    expect(entries[0].performedBy).toBe(admin.userId);
    expect(entries[0].details).toMatchObject({ reason: 'Duplicate transfer', orderId });
  });

  it('does NOT touch the order it flags', async () => {
    // Flagging and reversing are separate decisions with separate evidence.
    // Coupling them means an operator marking a suspicious reference silently
    // cancels a player's deposit.
    const { utr, orderId } = await claimed({ state: 'PROCESSING' });
    await as(app, admin).put(`/utr-registry/${utr}/flag`).send({ reason: 'Under review' });
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
  });

  it('404s a flag on a reference that is not in the registry', async () => {
    const res = await as(app, admin).put(`/utr-registry/GHOST${RUN}/flag`).send({ reason: 'nope' });
    expect(res.status).toBe(404);
  });

  // ── Clearing ──────────────────────────────────────────────────────────────
  it('lifts a flag as a state change, keeping what it was', async () => {
    // Never by erasing the previous decision: the reason it was flagged is
    // evidence, and so is who lifted it.
    const { utr } = await claimed();
    await as(app, admin).put(`/utr-registry/${utr}/flag`).send({ reason: 'Looked wrong' });
    const res = await as(app, admin).put(`/utr-registry/${utr}/clear`).send({});
    expect(res.status).toBe(200);
    expect(res.body.entry.status).toBe('ACTIVE');
    expect(res.body.entry.flagReason).toContain('Looked wrong');
    expect(res.body.entry.flagReason).toContain(admin.userId);
  });

  it('returns a cleared RELEASED reference to RELEASED, not to ACTIVE', async () => {
    // RELEASED means the order finished and the reference is SPENT. Clearing a
    // flag on one must not make it claimable again.
    const { utr, orderId } = await claimed();
    await releaseUtr(orderId);
    await as(app, admin).put(`/utr-registry/${utr}/flag`).send({ reason: 'later doubt' });
    const res = await as(app, admin).put(`/utr-registry/${utr}/clear`).send({});
    expect(res.body.entry.status).toBe('RELEASED');
  });

  it('404s clearing a reference that was never flagged', async () => {
    const { utr } = await claimed();
    const res = await as(app, admin).put(`/utr-registry/${utr}/clear`).send({});
    expect(res.status).toBe(404);
    expect((await getUtr(utr)).status, 'a refused clear still changed the row').toBe('ACTIVE');
  });

  // ── The review queue ──────────────────────────────────────────────────────
  it('surfaces a REFUSED duplicate rather than losing it in a 400', async () => {
    // A refused duplicate is the signal this control exists to catch, and a
    // signal nobody looks at is not a control. The attempt increments a counter
    // on the row.
    const { utr } = await claimed();
    const clash = await claimUtr({ utr, orderId: `ORD-${RUN}-clash-${seq}` });
    expect(clash.ok).toBe(false);

    const res = await as(app, admin).get('/utr/contested');
    expect(res.status).toBe(200);
    const row = res.body.contested.find((c) => c.utr === utr);
    expect(row, 'a refused duplicate never reached the review queue').toBeTruthy();
    expect(row.duplicateAttempts).toBeGreaterThanOrEqual(1);
  });

  it('PUTS THE NEWEST CONTEST FIRST — the queue nobody could work', async () => {
    // Ordered by attempt count, this queue was unworkable. Nothing ever leaves
    // the registry, so contested rows accumulate for the life of the platform
    // and the top of a count-ordered list is the same rows every day. Anything
    // new sorted underneath hundreds of them and was never seen.
    const { utr } = await claimed();
    await claimUtr({ utr, orderId: `ORD-${RUN}-fresh-${seq}` });

    const res = await as(app, admin).get('/utr/contested?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.contested[0].utr, 'the newest contested reference is not at the top').toBe(utr);
  });

  it('lists a FRAUD reference as contested even with no duplicate attempt', async () => {
    // A hand-flagged reference starts at ZERO attempts, so under the old
    // ordering it sorted below every automated duplicate — the one entry a
    // human had already judged worth flagging was the one nobody could reach.
    const { utr } = await claimed();
    await as(app, admin).put(`/utr-registry/${utr}/flag`).send({ reason: 'manual' });
    const res = await as(app, admin).get('/utr/contested?limit=5');
    expect(res.body.contested.some((c) => c.utr === utr)).toBe(true);
  });

  it('pages the review queue and reports how much of it there is', async () => {
    // A fixed slice of an unbounded list hides everything past it without
    // saying so. The total is what tells an operator there is more.
    const { utr } = await claimed();
    await claimUtr({ utr, orderId: `ORD-${RUN}-page-${seq}` });

    const first = await as(app, admin).get('/utr/contested?limit=1&page=1');
    const second = await as(app, admin).get('/utr/contested?limit=1&page=2');
    expect(first.body.contested).toHaveLength(1);
    expect(second.body.contested).toHaveLength(1);
    expect(second.body.contested[0].utr).not.toBe(first.body.contested[0].utr);
    expect(first.body.pagination.total).toBeGreaterThan(1);
    expect(first.body.pagination.limit).toBe(1);
  });

  it('counts the registry by status', async () => {
    const { utr } = await claimed();
    const before = (await as(app, admin).get('/utr/stats')).body.stats;
    await as(app, admin).put(`/utr-registry/${utr}/flag`).send({ reason: 'counted' });
    const after = (await as(app, admin).get('/utr/stats')).body.stats;
    expect(after.fraud).toBe(before.fraud + 1);
    expect(after.active).toBe(before.active - 1);
    expect(after.total).toBe(before.total);
  });

  it('gives one player’s reference history', async () => {
    const who = await actor({});
    const a = await claimed({ owner: who });
    const b = await claimed({ owner: who });
    const res = await as(app, admin).get(`/utr/user-history/${who.userId}`);
    expect(res.status).toBe(200);
    expect(res.body.totalUTRs).toBe(2);
    expect(res.body.history.map((h) => h.utr).sort()).toEqual([a.utr, b.utr].sort());
  });

  // The held-for-review queue and its resolve route were deleted 2026-10-01:
  // nothing ever set `requires_review`, so these tests set it by hand — a row
  // production could not produce (§32 S16).
});
