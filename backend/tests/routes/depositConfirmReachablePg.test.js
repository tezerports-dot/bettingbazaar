// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A member can actually release the tokens.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * `POST /api/merchant/confirm/:id` refused every deposit with "Payment proof
 * screenshot is required."
 *
 * Payment-proof COLLECTION had been removed platform-wide, deliberately and for
 * good reasons: the presign route was deleted, `mark-paid` takes the reference
 * alone, and no player screen has an upload. The CONSUMER was left behind. So
 * `order.proofScreenshot` was NULL on every order created after that pass, the
 * check could never pass, and EVERY deposit confirm 400'd.
 *
 * What that looked like to the two people involved:
 *   - The player sent real money, submitted their UTR, and was told "Payment
 *     marked. Awaiting merchant review."
 *   - The merchant opened the order, pressed "Confirm & release", and the panel
 *     told them "The user has not uploaded payment proof yet" — blaming the
 *     player for not supplying something nothing on the platform asks them for.
 * The order then sat at PAID until the 30-minute unanswered sweep moved it to
 * DISPUTED, or the player disputed it. No deposit could complete.
 *
 * Every check was green throughout. Both handlers pass their own route tests;
 * it was the PAIR that was broken, which is §28 — a route test proves a handler
 * works and can never prove the other half agrees with it. It was found by
 * running a deposit end to end against a real server, not by reading one.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * 1. The confirm works with NO BODY AT ALL, which is what the panel sends.
 * 2. The money actually moved — the team pool's hold is spent and the player
 *    holds it. A status check alone would pass against a route that completed
 *    the order and credited nobody (§21, and trap 17: `completed_at` is not
 *    "money moved").
 * 3. A deposit with no reference from the player is still refused, so removing
 *    the dead check did not remove the live one — and the refusal spends
 *    nothing.
 * 4. The player's reference is never taken from the member's request body
 *    (§27): one payment, one claim, and the claim belongs to the player's.
 *
 * Each buy is made as production makes it: queued, assigned by the router
 * (which holds its tokens in the team's pool), and marked paid by the player.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getPool } from '#db/repositories/teamPools.js';
import { setCashReady } from '#db/repositories/teamRouting.js';
import { getBalances } from '../../domains/wallet/walletAuthority.service.js';
import { tryAssignMerchant, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a member can release tokens on a paid deposit', () => {
  let app;
  let seq = 0;
  const teams = teamFixture();
  const orders = [];
  const oid = () => `dcr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await teams.cleanup();
    await closePg();
  });

  // A payment reference is unique across orders by index (§27), so each order
  // gets its own.
  const nextUtr = () => String(410000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  /**
   * A deposit in exactly the state the player leaves it in: PAID, carrying the
   * reference THEY submitted, its tokens held in the team's pool, and no proof
   * screenshot — because nothing on this platform can produce one.
   *
   * `utr: null` is the CASH rail's tap: at a machine the player says Paid so the
   * member can carry on, and the reference follows. That is the only way a
   * PAID buy without a reference comes to exist, so it is the way this builds
   * one — on the cash rail, through a member who pressed Ready.
   */
  const paidDeposit = async ({ utr = nextUtr() } = {}) => {
    const cash = utr === null;
    const tokens = cash ? 5_000 : 20_000;   // a cash denomination, or above the cash ceiling
    const member = await merchantActor();
    const team = await teams.workingTeam({
      rail: cash ? 'CASH' : 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId],
    });
    if (cash) expect(await setCashReady(member.merchantId, true)).toEqual({ ok: true, ready: true });
    const player = await actor({});
    const orderId = oid();
    orders.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens,
    });
    expect(await tryAssignMerchant(order), 'the router did not assign the buy').toBe(true);
    expect((await getOrderRecord(orderId)).merchantId).toBe(member.merchantId);
    await readyToPay(orderId);
    const paid = await markOrderPaid(player.userId, orderId, cash ? '' : utr);
    expect(paid.status).toBe('PAID');
    return { member, player, orderId, tokens, utr, team };
  };

  it('completes on an empty body, and the money moves', async () => {
    const { member, player, orderId, tokens, team } = await paidDeposit();
    const paise = tokens * 100;
    const before = await getPool(team.teamId);
    expect(before.heldPaise).toBe(paise);

    // No body. Not `{}` with fields the route ignores — nothing at all, which
    // is what `api.confirmPayment` sends.
    const res = await as(app, member).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);

    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('COMPLETED');

    // ── The assertion the 400 was hiding ──────────────────────────────────
    // COMPLETED is not "the money moved" (trap 17). Both sides are checked.
    // The hold IS the payment: it is spent out of `held`, and `available` does
    // not move. A debit of `available` beside it is the double charge (F-026).
    const after = await getPool(team.teamId);
    expect(after.heldPaise).toBe(before.heldPaise - paise);
    expect(after.availablePaise).toBe(before.availablePaise);
    expect(row.poolHeldPaise).toBe(0);

    // The player holds exactly what the pool lost — moved, never minted.
    // `getBalances` answers in RUPEES; the split between the two pockets is
    // `depositPolicy`'s business, so this asserts only the total.
    const wallet = await getBalances(player.userId);
    const credited = Number(wallet.depositBalance) + Number(wallet.reserveBalance);
    expect(credited).toBe(tokens);
  });

  it('still refuses a deposit the player has not referenced, and spends nothing', async () => {
    const { member, player, orderId, team } = await paidDeposit({ utr: null });
    expect((await getOrderRecord(orderId)).utrNumber ?? null).toBeNull();
    const poolBefore = await getPool(team.teamId);

    const res = await as(app, member).post(`/confirm/${orderId}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no payment reference/i);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
    // Refused BEFORE the money: the hold stands and the player has nothing yet.
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    const wallet = await getBalances(player.userId);
    expect(Number(wallet.depositBalance) + Number(wallet.reserveBalance)).toBe(0);
  });

  it('never takes the payment reference from the member', async () => {
    const { member, orderId, utr: PLAYERS } = await paidDeposit();

    // A member posting a different reference. `utr_registry` claimed the
    // PLAYER's against this order (§27); writing the member's over it would
    // leave the order naming a reference nothing had claimed, and free the
    // member's string to be spent again on another order.
    const res = await as(app, member).post(`/confirm/${orderId}`)
      .send({ utrNumber: '999999999999', proof: 'https://cdn.test/forged.jpg' });
    expect(res.status).toBe(200);

    const row = await getOrderRecord(orderId);
    expect(row.utrNumber).toBe(PLAYERS);
    // And the removed proof field was not resurrected through the body either.
    expect(row.proofScreenshot ?? null).toBeNull();
  });

  // F-017's second confirm route, `POST /api/payment/deposit/:orderId/confirm`,
  // admitted PROCESSING as well as PAID and never read the payment reference —
  // driven on a live server, it completed a deposit nobody had paid for, a
  // collusion route nothing on any screen called. The route was deleted
  // 2026-10-01 (owner decision), so the weaker door no longer exists to hold.
  // The panel route's admission is asserted above and in
  // merchantPanelRoutes.test.js.
});
