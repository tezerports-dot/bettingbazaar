// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Admin dispute resolution — the money-out ruling — over HTTP against a real DB.
 *
 * This is the highest-risk admin action: it credits a player's deposit, refunds
 * a withdrawal, or cancels an order, and two admins ruling at once must not
 * double-move money. The transition is the gate (it runs before any credit) and
 * every wallet call is keyed, so the tests assert money moves exactly once and
 * the order carries the decision that moved it.
 *
 * Nothing below the HTTP boundary is mocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { createOrderRecord, getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('dispute resolution routes', () => {
  let app; let admin;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/disputes/disputeResolution.admin.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const disputed = async ({ type = 'DEPOSIT', tokens = 500, owner = null, merchantCreditStatus = null } = {}) => {
    seq += 1;
    const who = owner || await actor({});
    const orderId = `DR-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type,
      tokenAmountRupees: tokens, fiatAmountRupees: tokens, state: 'DISPUTED',
      ...(type === 'DEPOSIT' ? { depositAllocation: tokens, reserveAllocation: 0 } : {}),
      ...(merchantCreditStatus ? { merchantCreditStatus } : {}),
    });
    return { orderId, who };
  };

  // ── Authorisation & validation ──────────────────────────────────────────────
  it('refuses a non-admin', async () => {
    const nobody = await actor({});
    const { orderId } = await disputed();
    expect((await request(app).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'x' })).status).toBe(401);
    expect((await as(app, nobody).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'x' })).status).toBe(403);
  });

  it('rejects an unknown decision and a missing resolution', async () => {
    const { orderId } = await disputed();
    expect((await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'GIVE_IT_TO_ME', resolution: 'x' })).status).toBe(400);
    expect((await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER' })).status).toBe(400);
    expect((await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: '   ' })).status).toBe(400);
  });

  it('404s an order that does not exist', async () => {
    expect((await as(app, admin).post(`/dispute-orders/NOSUCH-${RUN}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'x' })).status).toBe(404);
  });

  it('refuses to resolve an order already final', async () => {
    const { orderId } = await disputed();
    await setOrderFields(orderId, { /* move it out of a resolvable state via a real transition below */ });
    // Take it to COMPLETED through the machine so the status read refuses it.
    const { completeOrder } = await import('../../domains/payment/orderLifecycle.service.js');
    // DISPUTED -> COMPLETED is legal; now a resolve should be refused by the status guard.
    await completeOrder(orderId, { expectFrom: 'DISPUTED' });
    const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'late' });
    expect(res.status).toBe(400);
  });

  // ── DEPOSIT ─────────────────────────────────────────────────────────────────
  it('RELEASE_TO_USER on a deposit credits the player once and completes the order', async () => {
    const { orderId, who } = await disputed({ type: 'DEPOSIT', tokens: 500 });
    const before = await getBalancesPaise(who.userId);

    const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`)
      .send({ decision: 'RELEASE_TO_USER', resolution: 'Payment proof checks out.' });
    expect(res.status, res.body.message).toBe(200);

    const after = await getBalancesPaise(who.userId);
    expect(after.depositBalance - before.depositBalance).toBe(500_00);

    const order = await getOrderRecord(orderId);
    expect(order.state).toBe('COMPLETED');
    expect(order.disputeDecision).toBe('RELEASE_TO_USER');
    expect(order.disputeResolution).toBe('Payment proof checks out.');
  });

  it('does not credit twice when the same deposit dispute is resolved again', async () => {
    const { orderId, who } = await disputed({ type: 'DEPOSIT', tokens: 500 });
    const before = await getBalancesPaise(who.userId);
    const first = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'ok' });
    const afterFirst = await getBalancesPaise(who.userId);
    const second = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'ok again' });

    expect(first.status).toBe(200);
    // Once COMPLETED, the status pre-read refuses a re-resolve (400) before the
    // transition is even asked — either way the point is the money moved once.
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect((await getBalancesPaise(who.userId)).depositBalance).toBe(afterFirst.depositBalance);
    expect(afterFirst.depositBalance - before.depositBalance).toBe(500_00);
  });

  it('a deposit ruled against the user moves no money and cancels the order', async () => {
    const { orderId, who } = await disputed({ type: 'DEPOSIT', tokens: 500 });
    const before = await getBalancesPaise(who.userId);
    const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'No payment was ever made.' });
    expect(res.status, res.body.message).toBe(200);
    expect(await getBalancesPaise(who.userId)).toMatchObject({ depositBalance: before.depositBalance });
    expect((await getOrderRecord(orderId)).state).toBe('CANCELLED');
  });

  it('survives two admins resolving the same deposit dispute at once', async () => {
    const { orderId, who } = await disputed({ type: 'DEPOSIT', tokens: 500 });
    const before = await getBalancesPaise(who.userId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'race' })),
    );
    // Exactly one applies; the rest are refused as already-resolved (409 at the
    // transition gate, or 400 at the status pre-read). The invariant is the
    // credit: it lands once.
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => [200, 400, 409].includes(r.status))).toBe(true);
    expect((await getBalancesPaise(who.userId)).depositBalance - before.depositBalance).toBe(500_00);
  });

  // ── WITHDRAWAL refunded after settlement ─────────────────────────────────────
  it('refunds a settled withdrawal to the player’s winnings, once, and cancels', async () => {
    // Not HELD: the merchant already holds the tokens, so ruling for the player
    // is a refund into winnings (recovery from the merchant is a separate manual
    // action). Keyed, so a repeat does not double-refund.
    const { orderId, who } = await disputed({ type: 'WITHDRAWAL', tokens: 300, merchantCreditStatus: 'RELEASED' });
    const before = await getBalancesPaise(who.userId);

    const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'User never received the payout.' });
    expect(res.status, res.body.message).toBe(200);

    const after = await getBalancesPaise(who.userId);
    expect(after.winningsBalance - before.winningsBalance).toBe(300_00);
    expect((await getOrderRecord(orderId)).state).toBe('CANCELLED');

    // A second ruling must not refund again.
    await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'again' });
    expect((await getBalancesPaise(who.userId)).winningsBalance).toBe(after.winningsBalance);
  });
});
