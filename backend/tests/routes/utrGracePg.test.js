// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The minute a player gets to fetch the UTR, and why it is exactly one.
 *
 * ── What this protects ─────────────────────────────────────────────────────
 * The order's own timer IS the UTR deadline. A player who taps "I have paid"
 * with fifteen seconds left cannot find a twelve-character bank reference in
 * fifteen seconds, and the order expiring under them cancels a payment they
 * have ALREADY MADE. The money is gone and the order is not — the worst
 * outcome this flow has.
 *
 * ── And why it is not more than one ────────────────────────────────────────
 * Repeatable, this stops being a courtesy and becomes an unbounded extension: a
 * player taps every fifty seconds and holds a merchant's capacity open
 * indefinitely. That is a denial of service against the merchant queue wearing
 * the shape of a kindness, so "once" is asserted as hard as the extension is.
 *
 * ── The window belongs to the admin ────────────────────────────────────────
 * `utrSubmitSeconds` sat in the policy and on the admin screen — labelled "how
 * long the player has to submit the UTR after clicking Paid" — and NOTHING read
 * it. A value an operator can edit is only configuration if something consults
 * it, so the test that matters most here is the one that changes the number and
 * watches the deadline follow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import {
  PAYMENT_MODES, getActivePolicy, publishPolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the UTR grace', () => {
  let app;
  let restore = null;
  let seq = 0;
  const oid = () => `grace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  /** A buy order about to run out of time, which is the only interesting case. */
  const expiringDeposit = async (player, secondsLeft = 8) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000,
      state: 'ASSIGNED',
      expiresAt: new Date(Date.now() + secondsLeft * 1000),
    });
    return orderId;
  };

  const graceWindow = async () => (await getActivePolicy()).utrSubmitSeconds;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    restore = await getActivePolicy();
  }, 60_000);

  afterAll(async () => {
    if (restore) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        timers: { utrSubmitSeconds: restore.utrSubmitSeconds },
        justification: 'Restoring the policy this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    await closePg();
  });

  it('pushes the deadline out to the admin-configured window', async () => {
    const player = await actor({});
    const orderId = await expiringDeposit(player, 8);
    const before = await getOrderRecord(orderId);
    const window = await graceWindow();

    const res = await as(app, player).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status).toBe(200);

    const after = await getOrderRecord(orderId);
    const gained = (new Date(after.expiresAt) - new Date(before.expiresAt)) / 1000;
    // It moved OUT by roughly the window minus what was already left. Bounds
    // wide enough for the call's own elapsed time and far too narrow to admit
    // "did not move" or "moved by a hardcoded number".
    expect(gained).toBeGreaterThan(window - 12);
    expect(gained).toBeLessThan(window + 2);
    expect(after.utrGraceAt).toBeTruthy();
  });

  it('follows the admin when they change the window', async () => {
    // The assertion that makes `utrSubmitSeconds` configuration rather than
    // decoration. It was on the admin screen and read by nothing.
    // Timers go in `timers`. Passing one at the top level is refused now —
    // it used to publish a version that silently kept the old value.
    await publishPolicyVersion({
      activeMode: restore.activeMode,
      timers: { utrSubmitSeconds: 300 },
      justification: 'UTR grace suite — a five-minute window.',
      changedByName: 'test setup',
    });

    const player = await actor({});
    const orderId = await expiringDeposit(player, 5);
    const res = await as(app, player).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status).toBe(200);

    const after = await getOrderRecord(orderId);
    const left = (new Date(after.expiresAt) - Date.now()) / 1000;
    expect(left).toBeGreaterThan(280);
    expect(left).toBeLessThan(310);
  });

  it('never SHORTENS a deadline that is already further out', async () => {
    // "A full minute from the tap" would be a cut for an order with ten minutes
    // left. The deadline only ever moves outward.
    await publishPolicyVersion({
      activeMode: restore.activeMode,
      timers: { utrSubmitSeconds: 60 },
      justification: 'UTR grace suite — back to a minute.',
      changedByName: 'test setup',
    });

    const player = await actor({});
    const orderId = await expiringDeposit(player, 600);
    const before = await getOrderRecord(orderId);

    const res = await as(app, player).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status).toBe(200);

    const after = await getOrderRecord(orderId);
    expect(new Date(after.expiresAt).getTime()).toBe(new Date(before.expiresAt).getTime());
  });

  it('is claimable ONCE — a second tap buys nothing', async () => {
    const player = await actor({});
    const orderId = await expiringDeposit(player, 8);

    const first = await as(app, player).post(`/order/${orderId}/utr-grace`).send({});
    expect(first.status).toBe(200);
    const afterFirst = await getOrderRecord(orderId);

    const second = await as(app, player).post(`/order/${orderId}/utr-grace`).send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('GRACE_ALREADY_TAKEN');
    // Told the deadline they actually have, so the screen can correct itself
    // instead of running a countdown the server disagrees with.
    expect(second.body.expiresAt).toBeTruthy();

    // And the deadline did not move a second time. Without this, tapping every
    // fifty seconds holds a merchant's capacity open forever.
    const afterSecond = await getOrderRecord(orderId);
    expect(new Date(afterSecond.expiresAt).getTime())
      .toBe(new Date(afterFirst.expiresAt).getTime());
  });

  it('refuses two simultaneous taps, so a race cannot extend twice', async () => {
    const player = await actor({});
    const orderId = await expiringDeposit(player, 8);

    // The decision and the write are one statement, which is what makes this
    // safe. A check followed by an update would let both of these through.
    const [a, b] = await Promise.all([
      as(app, player).post(`/order/${orderId}/utr-grace`).send({}),
      as(app, player).post(`/order/${orderId}/utr-grace`).send({}),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
  });

  it('will not extend somebody else\'s order', async () => {
    const owner = await actor({});
    const stranger = await actor({});
    const orderId = await expiringDeposit(owner, 8);

    const res = await as(app, stranger).post(`/order/${orderId}/utr-grace`).send({});
    expect([403, 404]).toContain(res.status);
    expect((await getOrderRecord(orderId)).utrGraceAt).toBeNull();
  });

  it('refuses an order that is no longer waiting for a reference', async () => {
    const player = await actor({});
    const orderId = await expiringDeposit(player, 8);
    await setOrderFields(orderId, { cancelReason: 'TEST' });
    const { cancelOrder: cancelState } = await import('../../domains/payment/orderLifecycle.service.js');
    await cancelState(orderId, { set: { cancelledAt: new Date() } });

    const res = await as(app, player).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_AWAITING_UTR');
  });

  it('refuses a withdrawal — nobody submits a UTR for a payout', async () => {
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000, state: 'ASSIGNED',
      expiresAt: new Date(Date.now() + 8000),
    });

    const res = await as(app, player).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status).toBe(400);
    expect((await getOrderRecord(orderId)).utrGraceAt).toBeNull();
  });
});
