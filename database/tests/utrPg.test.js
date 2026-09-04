// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The bank-reference registry, against a real PostgreSQL.
 *
 * A UTR is a bank's reference for a real transfer. Reusing one across two
 * orders is either a mistake or an attempt to claim a single payment twice, so
 * this is an anti-fraud control rather than a convenience — and the tests below
 * are the control.
 *
 * Three of them assert something the previous implementation could not do:
 * decide in one statement (it checked, then inserted, leaving a window),
 * survive a delete (a `clearAllUTRs()` export emptied the whole registry), and
 * count a refused duplicate rather than dropping it into a 400.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  normalizeUtr, claimUtr, checkUtr, getUtr, getUtrForOrder, releaseUtr,
  flagFraud, clearFraudFlag, userUtrHistory, contestedUtrs, utrStats, UTR_STATUS,
} from '../repositories/utr.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the bank-reference registry', () => {
  const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
  let seq = 0;
  const utr = () => `UTR${RUN}${String(seq).padStart(6, '0')}`;

  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  const next = () => { seq += 1; return { u: utr(), o: `ord-${RUN}-${seq}` }; };

  it('normalises case and every kind of space, so one transfer is one row', () => {
    // A reference typed with a space in it is the same reference. Without this
    // the primary key means "this spelling", not "this transfer".
    expect(normalizeUtr(' ab12  cd34\tef ')).toBe('AB12CD34EF');
    expect(normalizeUtr(null)).toBeNull();
  });

  it('claims a reference for an order', async () => {
    const { u, o } = next();
    const claim = await claimUtr({ u: undefined, utr: u, orderId: o, userId: 'u1', amountRupees: 500 });
    expect(claim.ok).toBe(true);
    expect(claim.entry).toMatchObject({ utr: u, orderId: o, status: UTR_STATUS.ACTIVE, amount: 500 });
  });

  it('lets exactly ONE order claim a reference, under a storm', async () => {
    // The previous implementation checked then inserted. Two submissions
    // arriving together both passed the check and one died on the index — a
    // 500 to a player who had done nothing wrong.
    const { u } = next();
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, i) => claimUtr({ utr: u, orderId: `race-${RUN}-${i}` })),
    );
    expect(claims.filter((c) => c.ok)).toHaveLength(1);
    expect(claims.filter((c) => c.reason === 'DUPLICATE_UTR')).toHaveLength(11);
  });

  it('treats the SAME order resubmitting as a retry, not a duplicate', async () => {
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o });
    const again = await claimUtr({ utr: u, orderId: o });
    expect(again).toMatchObject({ ok: true, idempotent: true });
  });

  it('COUNTS a refused duplicate — the refusal is the signal', async () => {
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o });
    for (let i = 0; i < 3; i += 1) {
      await claimUtr({ utr: u, orderId: `other-${RUN}-${i}` });
    }
    const entry = await getUtr(u);
    expect(entry.duplicateAttempts).toBe(3);
    // …and it reaches the review queue rather than vanishing into a 400.
    expect((await contestedUtrs({ limit: 500 })).entries.map((e) => e.utr)).toContain(u);
  });

  it('reports who holds a reference, so support has an answer', async () => {
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o, userId: 'holder-1' });
    const refused = await claimUtr({ utr: u, orderId: 'someone-else' });
    expect(refused.entry.orderId).toBe(o);

    const check = await checkUtr(u.toLowerCase());
    expect(check).toMatchObject({ isUsed: true, warning: 'DUPLICATE_UTR' });
    expect(check.previousData.orderId).toBe(o);
  });

  it('RELEASED means spent, not free', async () => {
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o });
    const released = await releaseUtr(o);
    expect(released.status).toBe(UTR_STATUS.RELEASED);

    // The row outlives the order and the key still refuses a second claim.
    const reuse = await claimUtr({ utr: u, orderId: `new-${RUN}` });
    expect(reuse).toMatchObject({ ok: false, reason: 'DUPLICATE_UTR' });
  });

  it('will not let ANYTHING delete a registered reference', async () => {
    // The convention was `clearAllUTRs()` — an exported function that emptied
    // the registry, one import away from any route. A table that can be
    // emptied prevents reuse only until somebody empties it.
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o });
    await expect(pgQuery('DELETE FROM utr_registry WHERE utr = $1', [u]))
      .rejects.toThrow(/permanent/);
    await expect(pgQuery('DELETE FROM utr_registry', []))
      .rejects.toThrow(/permanent/);
  });

  it('refuses a fraud flag with no actor or no reason', async () => {
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o });
    await expect(flagFraud(u, { actor: null, reason: 'x' })).rejects.toThrow(/requires an actor/);
    await expect(flagFraud(u, { actor: 'admin', reason: '  ' })).rejects.toThrow(/requires a reason/);
    // The row refuses it from the other direction too.
    await expect(pgQuery(`UPDATE utr_registry SET status = 'FRAUD' WHERE utr = $1`, [u]))
      .rejects.toThrow(/utr_registry_flag_has_actor/);
  });

  it('flags a reference and reports the flag on the next attempt', async () => {
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o });
    const flagged = await flagFraud(u, { actor: 'admin-1', reason: 'Reused across accounts' });
    expect(flagged.ok).toBe(true);

    const attempt = await claimUtr({ utr: u, orderId: `after-${RUN}` });
    expect(attempt).toMatchObject({ ok: false, reason: 'FRAUD_FLAGGED' });
  });

  it('lifts a flag as a recorded change, keeping what it was', async () => {
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o });
    await flagFraud(u, { actor: 'admin-1', reason: 'Suspected duplicate' });
    const cleared = await clearFraudFlag(u, { actor: 'admin-2' });

    expect(cleared.ok).toBe(true);
    expect(cleared.entry.status).toBe(UTR_STATUS.ACTIVE);
    // The previous reason survives inside the new one: an operator reviewing
    // this later needs to know it WAS flagged, and for what.
    expect(cleared.entry.flagReason).toContain('Suspected duplicate');
    expect(cleared.entry.flagReason).toContain('admin-2');
  });

  it('will not release a flagged reference out from under the flag', async () => {
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o });
    await flagFraud(u, { actor: 'admin-1', reason: 'Under review' });
    // Releasing would quietly retire a flag an operator raised deliberately.
    expect(await releaseUtr(o)).toBeNull();
    expect((await getUtr(u)).status).toBe(UTR_STATUS.FRAUD);
  });

  it('finds a reference by its order, and a player’s references by account', async () => {
    const { u, o } = next();
    await claimUtr({ utr: u, orderId: o, userId: `player-${RUN}` });
    expect((await getUtrForOrder(o)).utr).toBe(u);

    const { u: u2 } = next();
    await claimUtr({ utr: u2, orderId: `ord2-${RUN}`, userId: `player-${RUN}` });
    const history = await userUtrHistory(`player-${RUN}`);
    expect(history.map((e) => e.utr).sort()).toEqual([u, u2].sort());
  });

  it('refuses a claim with no reference rather than storing an empty one', async () => {
    expect(await claimUtr({ utr: '', orderId: 'x' })).toEqual({ ok: false, reason: 'MISSING_UTR' });
    expect(await getUtr(null)).toBeNull();
  });

  it('counts the registry in one pass', async () => {
    const s = await utrStats();
    expect(s.available).toBe(true);
    expect(s.total).toBeGreaterThan(0);
    expect(s.active + s.released + s.fraud).toBe(s.total);
  });
});
