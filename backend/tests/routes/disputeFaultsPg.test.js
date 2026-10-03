// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Whoever was wrong in a dispute is suspended (2c+, owner 2026-10-02 21:13).
 *
 * "In these cases the one who was wrong will be suspended completely and only a
 * sub admin can lift the suspension … if someone crosses these kind of disputes
 * three times he will be suspended and again sent to admin review in high risk
 * case."
 *
 *                 decided FOR the player       decided AGAINST the player
 *   BUY           the member is suspended      the player is suspended
 *   SELL          the member is suspended      the player is suspended
 *
 * What is asserted, through the real routes and the real database:
 *   - each of the three routes that decide a dispute suspends the loser, and
 *     only the loser (§32 S3: one state, one consequence)
 *   - a replayed or concurrent decision counts once (keyed by the order)
 *   - a decision on an order that was NOT disputed suspends nobody
 *   - the third loss opens high-risk review; a sub-admin's lift is then
 *     refused in the write itself, and a full admin's goes through
 *   - below three, a sub-admin's lift goes through (the opposite behaviour)
 *   - a party with no row rolls the whole record back
 *
 * The disputes are real ones: a buy routed to a member of a working team,
 * paid with a reference, rejected on the member's route and disputed on the
 * player's (§32 S16). A sell is accepted and confirmed on the member's routes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getUser, updateUser } from '#db/repositories/users.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { recordDisputeFault, HIGH_RISK_LOSSES } from '#db/repositories/disputeFaults.js';
import { tryAssignMerchant, markOrderPaid, createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const cdn = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../../services/cdn.service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual.default, verifyUploadedObject: cdn.verify } };
});

const TOKENS = 20_000;
const REJECT = {
  reason: 'No credit against this UTR in my statement',
  proofFileKey: 'merchant-reject-proof/x.jpg', proofCdnUrl: 'https://cdn.test/x.jpg',
};

describePg('a decided dispute suspends whoever was wrong', () => {
  let merchantApp; let playerApp; let disputeApp; let pccApp; let usersApp; let merchantsApp;
  let admin; let subAdmin;
  let seq = 0;
  const teams = teamFixture();
  const made = [];
  const oid = () => `dfp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const nextUtr = () => String(480000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  beforeAll(async () => {
    await applySchema();
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    disputeApp = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
    pccApp = mountRouter((await import('../../domains/payment/paymentOrder.routes.js')).default);
    usersApp = mountRouter((await import('../../routes/admin/users.admin.routes.js')).default);
    merchantsApp = mountRouter((await import('../../domains/merchant/merchant.admin.routes.js')).default);
    cdn.verify.mockResolvedValue({ cdnUrl: REJECT.proofCdnUrl, fileKey: REJECT.proofFileKey });
    admin = await actor({ isAdmin: true });
    subAdmin = await actor({ isSubAdmin: true, permissions: { canManageUsers: true, canManageMerchants: true, canResolveDisputes: true } });
  }, 60_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM dispute_faults WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  /** A buy the member rejected as unpaid and the player disputed in time. */
  const disputedBuy = async ({ player: given } = {}) => {
    const member = await merchantActor();
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId] });
    const player = given ?? await actor({});
    const orderId = oid();
    made.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: TOKENS, fiatAmountRupees: TOKENS,
      depositAllocation: TOKENS, reserveAllocation: 0,
    });
    expect(await tryAssignMerchant(order)).toBe(true);
    expect((await markOrderPaid(player.userId, orderId, nextUtr())).status).toBe('PAID');
    expect((await as(merchantApp, member).post(`/orders/${orderId}/reject`).send(REJECT)).status).toBe(200);
    const disputed = await as(playerApp, player).post(`/order/${orderId}/dispute`).send({ reason: 'I paid; the UTR is on the order' });
    expect(disputed.status, JSON.stringify(disputed.body)).toBe(200);
    return { member, player, orderId };
  };

  /** A sell the member marked paid and the player disputed in the hold. */
  const disputedSell = async () => {
    const player = await actor({});
    const member = await merchantActor();
    await teams.workingTeam({ rail: 'CASH', include: [member.merchantId] });
    await updateUser(player.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'TEST0000001', bankName: 'Test Bank', accountHolderName: 'Fault Test' },
    });
    await creditWinnings(player.userId, 1000, 'fault test float', 'Test', `dff-${seq}`, `dff_${seq}_${Date.now()}`);
    const { orderId } = (await createWithdrawalOrder(player.userId, 1000)).order;
    made.push(orderId);
    expect((await getOrderRecord(orderId)).merchantId).toBe(member.merchantId);
    expect((await as(merchantApp, member).post(`/accept/${orderId}`)).status).toBe(200);
    expect((await as(merchantApp, member).post(`/confirm/${orderId}`)).status).toBe(200);
    // Ten minutes after Paid, the player says nothing arrived.
    await pgQuery(`UPDATE order_states SET paid_at = now() - interval '11 minutes' WHERE order_id = $1`, [orderId]);
    const disputed = await as(playerApp, player).post(`/order/${orderId}/dispute`).send({ reason: 'Nothing reached my bank' });
    expect(disputed.status, JSON.stringify(disputed.body)).toBe(200);
    return { member, player, orderId };
  };

  const resolve = (orderId, decision, who = admin) => as(disputeApp, who)
    .post(`/dispute-orders/${orderId}/resolve`).send({ decision, resolution: 'checked the statement' });

  const playerState = async (userId) => {
    const u = await getUser(userId);
    return { blocked: u.isBlocked, status: u.status, lost: u.lostDisputes, highRisk: Boolean(u.highRiskAt) };
  };
  const memberState = async (merchantId) => {
    const m = await getMerchant(merchantId);
    return { status: m.status, lost: m.lostDisputes, highRisk: Boolean(m.highRiskAt) };
  };

  // ── Who loses, on each route ──────────────────────────────────────────────
  it('a buy decided for the player suspends the member, and only the member', async () => {
    const { member, player, orderId } = await disputedBuy();
    const res = await resolve(orderId, 'RELEASE_TO_USER');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await memberState(member.merchantId)).toEqual({ status: 'SUSPENDED', lost: 1, highRisk: false });
    expect(await playerState(player.userId)).toMatchObject({ blocked: false, lost: 0 });
    const { rows } = await pgQuery('SELECT party, lost_count FROM dispute_faults WHERE order_id = $1', [orderId]);
    expect(rows).toEqual([{ party: 'MERCHANT', lost_count: 1 }]);
  });

  it('a buy decided against the player suspends the player, and only the player', async () => {
    const { member, player, orderId } = await disputedBuy();
    expect((await resolve(orderId, 'RELEASE_TO_MERCHANT')).status).toBe(200);
    expect(await playerState(player.userId)).toEqual({ blocked: true, status: 'BLOCKED', lost: 1, highRisk: false });
    expect(await memberState(member.merchantId)).toMatchObject({ status: 'ACTIVE', lost: 0 });
  });

  it('a sell decided for the player suspends the member who said they paid', async () => {
    const { member, player, orderId } = await disputedSell();
    expect((await resolve(orderId, 'RELEASE_TO_USER')).status).toBe(200);
    expect(await memberState(member.merchantId)).toMatchObject({ status: 'SUSPENDED', lost: 1 });
    expect(await playerState(player.userId)).toMatchObject({ blocked: false, lost: 0 });
  });

  it('a sell decided for the member suspends the player who disputed it', async () => {
    const { member, player, orderId } = await disputedSell();
    expect((await resolve(orderId, 'RELEASE_TO_MERCHANT')).status).toBe(200);
    expect(await playerState(player.userId)).toMatchObject({ blocked: true, lost: 1 });
    expect(await memberState(member.merchantId)).toMatchObject({ status: 'ACTIVE', lost: 0 });
  });

  it('the Payment Control Centre\'s resolve applies the same consequence (§32 S3)', async () => {
    const { member, player, orderId } = await disputedBuy();
    const res = await as(pccApp, admin).post(`/payment-orders/${orderId}/resolve`).send({ resolution: 'refund', reason: 'no credit found' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await playerState(player.userId)).toMatchObject({ blocked: true, lost: 1 });
    expect(await memberState(member.merchantId)).toMatchObject({ status: 'ACTIVE', lost: 0 });
  });

  it('the queue action on a DISPUTED order applies the same consequence (§32 S3)', async () => {
    const { member, player, orderId } = await disputedBuy();
    const res = await as(pccApp, admin).post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await memberState(member.merchantId)).toMatchObject({ status: 'SUSPENDED', lost: 1 });
    expect(await playerState(player.userId)).toMatchObject({ blocked: false, lost: 0 });
  });

  it('a decision on an order that was never disputed suspends nobody', async () => {
    // The queue action also approves ordinary PAID buys: that is not a dispute
    // and nobody was found to be wrong.
    const member = await merchantActor();
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId] });
    const player = await actor({});
    const orderId = oid(); made.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT', tokenAmountRupees: TOKENS, fiatAmountRupees: TOKENS,
      depositAllocation: TOKENS, reserveAllocation: 0,
    });
    expect(await tryAssignMerchant(order)).toBe(true);
    expect((await markOrderPaid(player.userId, orderId, nextUtr())).status).toBe('PAID');
    expect((await as(pccApp, admin).post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' })).status).toBe(200);
    expect(await memberState(member.merchantId)).toMatchObject({ status: 'ACTIVE', lost: 0 });
    const { rows } = await pgQuery('SELECT 1 FROM dispute_faults WHERE order_id = $1', [orderId]);
    expect(rows).toHaveLength(0);
  });

  it('the Dispute Manager deciding an order that was never disputed suspends nobody', async () => {
    // Its resolve also takes PAID orders (an admin closing one by hand). Only a
    // DISPUTED order is a dispute, so only that has a loser.
    const member = await merchantActor();
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId] });
    const player = await actor({});
    const orderId = oid(); made.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT', tokenAmountRupees: TOKENS, fiatAmountRupees: TOKENS,
      depositAllocation: TOKENS, reserveAllocation: 0,
    });
    expect(await tryAssignMerchant(order)).toBe(true);
    expect((await markOrderPaid(player.userId, orderId, nextUtr())).status).toBe('PAID');
    expect((await resolve(orderId, 'RELEASE_TO_MERCHANT')).status).toBe(200);
    expect(await playerState(player.userId)).toMatchObject({ blocked: false, lost: 0 });
    expect(await memberState(member.merchantId)).toMatchObject({ status: 'ACTIVE', lost: 0 });
  });

  // ── Once per dispute ──────────────────────────────────────────────────────
  it('the record is keyed by the order: the same dispute recorded twice counts once', async () => {
    // What every route's idempotent branch relies on: a replayed decision
    // repairs a suspension that did not land, and never counts it again.
    const player = await actor({});
    const orderId = oid(); made.push(orderId);
    const first = await recordDisputeFault({ orderId, party: 'PLAYER', userId: player.userId, decision: 'CANCEL_ORDER' });
    const again = await recordDisputeFault({ orderId, party: 'PLAYER', userId: player.userId, decision: 'CANCEL_ORDER' });
    expect(first).toMatchObject({ ok: true, lostCount: 1 });
    expect(again).toMatchObject({ ok: true, already: true, lostCount: 1 });
    expect(await playerState(player.userId)).toMatchObject({ lost: 1 });
  });

  it('a decision pressed again, on any screen, counts once', async () => {
    // A second press after the first is refused at the route's own status
    // check (the order is no longer DISPUTED); the concurrent case below is the
    // one that reaches the keyed record.
    const { member, orderId } = await disputedBuy();
    expect((await resolve(orderId, 'RELEASE_TO_USER')).status).toBe(200);
    for (const again of [
      resolve(orderId, 'RELEASE_TO_USER'),
      as(pccApp, admin).post(`/payment-orders/${orderId}/resolve`).send({ resolution: 'release', reason: 'again' }),
      as(pccApp, admin).post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' }),
    ]) {
      const res = await again;
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await memberState(member.merchantId)).toMatchObject({ lost: 1 });
  });

  it('four admins deciding at once, across two screens, count once', async () => {
    const { player, orderId } = await disputedBuy();
    await Promise.all([
      resolve(orderId, 'RELEASE_TO_MERCHANT'),
      resolve(orderId, 'RELEASE_TO_MERCHANT', subAdmin),
      as(pccApp, admin).post(`/payment-orders/${orderId}/resolve`).send({ resolution: 'refund', reason: 'no credit' }),
      as(pccApp, admin).post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT', reason: 'no credit' }),
    ]);
    expect(await playerState(player.userId)).toMatchObject({ blocked: true, lost: 1 });
    const { rows } = await pgQuery('SELECT COUNT(*)::int AS n FROM dispute_faults WHERE order_id = $1', [orderId]);
    expect(rows[0].n).toBe(1);
  });

  // ── Three strikes, and who may lift ────────────────────────────────────────
  it('below three, a sub-admin lifts a player\'s suspension', async () => {
    const { player, orderId } = await disputedBuy();
    expect((await resolve(orderId, 'RELEASE_TO_MERCHANT')).status).toBe(200);
    const res = await as(usersApp, subAdmin).put(`/users/${player.userId}/unblock`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await playerState(player.userId)).toMatchObject({ blocked: false, status: 'ACTIVE', lost: 1 });
  });

  it('the third lost dispute opens high-risk review; only a full admin lifts it', async () => {
    const player = await actor({});
    // Two earlier losses, through the one writer, as the routes record them.
    for (let i = 0; i < HIGH_RISK_LOSSES - 1; i += 1) {
      const earlier = `${oid()}-prior`; made.push(earlier);
      expect((await recordDisputeFault({ orderId: earlier, party: 'PLAYER', userId: player.userId, decision: 'CANCEL_ORDER' })).ok).toBe(true);
    }
    expect(await playerState(player.userId)).toMatchObject({ lost: 2, highRisk: false });
    // A sub-admin may still lift at two; put the account back to work.
    expect((await as(usersApp, subAdmin).put(`/users/${player.userId}/unblock`).send({})).status).toBe(200);

    const { orderId } = await disputedBuy({ player });
    expect((await resolve(orderId, 'RELEASE_TO_MERCHANT')).status).toBe(200);
    expect(await playerState(player.userId)).toEqual({ blocked: true, status: 'BLOCKED', lost: 3, highRisk: true });

    const refused = await as(usersApp, subAdmin).put(`/users/${player.userId}/unblock`).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('HIGH_RISK_REVIEW');
    expect(refused.body.message).toMatch(/Only an admin/);
    expect(await playerState(player.userId)).toMatchObject({ blocked: true, highRisk: true });

    const lifted = await as(usersApp, admin).put(`/users/${player.userId}/unblock`).send({});
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    // The review is closed; the record of the losses is not.
    expect(await playerState(player.userId)).toEqual({ blocked: false, status: 'ACTIVE', lost: 3, highRisk: false });
  });

  it('the same rule for a team member: a sub-admin cannot reinstate one in high-risk review', async () => {
    const member = await merchantActor();
    for (let i = 0; i < HIGH_RISK_LOSSES; i += 1) {
      const earlier = `${oid()}-m`; made.push(earlier);
      expect((await recordDisputeFault({ orderId: earlier, party: 'MERCHANT', merchantId: member.merchantId, decision: 'RELEASE_TO_USER' })).ok).toBe(true);
    }
    expect(await memberState(member.merchantId)).toEqual({ status: 'SUSPENDED', lost: 3, highRisk: true });

    for (const path of ['activate', 'approve']) {
      const refused = await as(merchantsApp, subAdmin).put(`/merchants/${member.merchantId}/${path}`);
      expect(refused.status, path).toBe(403);
      expect(refused.body.code).toBe('HIGH_RISK_REVIEW');
    }
    expect(await memberState(member.merchantId)).toMatchObject({ status: 'SUSPENDED', highRisk: true });

    expect((await as(merchantsApp, admin).put(`/merchants/${member.merchantId}/activate`)).status).toBe(200);
    expect(await memberState(member.merchantId)).toEqual({ status: 'ACTIVE', lost: 3, highRisk: false });
  });

  it('below three, a sub-admin reinstates a team member', async () => {
    const { member, orderId } = await disputedBuy();
    expect((await resolve(orderId, 'RELEASE_TO_USER')).status).toBe(200);
    const res = await as(merchantsApp, subAdmin).put(`/merchants/${member.merchantId}/activate`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await memberState(member.merchantId)).toMatchObject({ status: 'ACTIVE', lost: 1 });
  });

  // ── A record naming nobody is worse than none ─────────────────────────────
  it('rolls the record back when the party at fault has no row', async () => {
    const orderId = oid(); made.push(orderId);
    const out = await recordDisputeFault({ orderId, party: 'MERCHANT', merchantId: 'no-such-member', decision: 'RELEASE_TO_USER' });
    expect(out).toEqual({ ok: false, reason: 'party_missing' });
    const { rows } = await pgQuery('SELECT 1 FROM dispute_faults WHERE order_id = $1', [orderId]);
    expect(rows).toHaveLength(0);
  });
});
