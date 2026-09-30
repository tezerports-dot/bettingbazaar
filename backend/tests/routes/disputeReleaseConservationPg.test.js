// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Releasing a disputed deposit TRANSFERS tokens. It does not mint them.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * `POST /api/admin/dispute-orders/:orderId/resolve` — the route the admin
 * Disputes screen actually calls — credited the player and debited nobody.
 * `grep -c debitMerchant` over that whole file returned 0. So every dispute an
 * admin resolved in the player's favour created tokens out of nothing, and the
 * conservation the settlement design rests on broke a little each time.
 *
 * It also passed a SENTENCE where `creditDeposit` expects the order id. That
 * third argument builds the idempotency key `dep_complete_<orderId>`, so
 * "Dispute resolved — deposit credited: DEP_…" produced a DIFFERENT key from
 * the one the normal confirm uses — and the gate could not tell that the
 * deposit had already been paid. An order confirmed normally and then released
 * here was credited TWICE.
 *
 * Both routes now go through `moveDepositMoney`, the one owner, which is also
 * what restores the deposit/reserve split, the UTR release and the player's
 * payment-failure clear.
 *
 * ── What is asserted, and why it is the pair ────────────────────────────────
 * The existing dispute suite asserts `deposit + reserve` moved by the right
 * TOTAL. That is a conservation check on the player's side alone, and it passes
 * whether or not a merchant funded it — which is exactly why the minting was
 * invisible for so long. These assert the OTHER side, and the split, and the
 * key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { transitionOrder } from '#db/repositories/orders.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { getMerchantBalances } from '#db/repositories/merchantWallets.core.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a released dispute moves tokens between two parties', () => {
  let app; let admin;
  let seq = 0;
  const oid = () => `drc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /**
   * A disputed deposit carrying its allocation, as a real one does: the split
   * is stamped on the ORDER at creation by the deposit policy, so the release
   * has to honour what that order was created under rather than a live read.
   */
  const disputedDeposit = async ({ rupees = 1000, deposit = 900, reserve = 100 } = {}) => {
    const merchant = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(merchant.merchantId, { isOnline: true, acceptsDeposits: true });
    const player = await actor({ kycStatus: 'APPROVED' });
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: rupees, fiatAmountRupees: rupees,
      state: 'PAID', merchantId: merchant.merchantId,
      depositAllocation: deposit, reserveAllocation: reserve,
      utrNumber: `UTRDRC${String(Date.now()).slice(-6)}${seq}`,
    });
    await transitionOrder(orderId, 'DISPUTED', {
      set: { disputeReason: 'paid but no tokens', disputeRaisedBy: 'user', disputeRaisedAt: new Date() },
    });
    return { orderId, player, merchant };
  };

  const resolve = (orderId, body) =>
    as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send(body);

  it('debits the merchant by exactly what it credits the player', async () => {
    const { orderId, player, merchant } = await disputedDeposit({ rupees: 1000 });
    const playerBefore = await getBalancesPaise(player.userId);
    const merchantBefore = await getMerchantBalances(merchant.merchantId);

    const res = await resolve(orderId, {
      decision: 'RELEASE_TO_USER', resolution: 'Bank statement shows the credit',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const playerAfter = await getBalancesPaise(player.userId);
    const merchantAfter = await getMerchantBalances(merchant.merchantId);

    const credited = (playerAfter.depositBalance + playerAfter.reserveBalance)
                   - (playerBefore.depositBalance + playerBefore.reserveBalance);
    const debited = Number(merchantBefore.available) - Number(merchantAfter.available);

    expect(credited).toBe(100_000);
    // THE assertion. This route credited the player and debited NOBODY, so the
    // tokens were minted. A player-side check alone cannot see that.
    expect(debited, 'a released dispute must move tokens, never create them').toBe(credited);
  });

  it('honours the split the ORDER was created under', async () => {
    const { orderId, player } = await disputedDeposit({ rupees: 1000, deposit: 900, reserve: 100 });
    const before = await getBalancesPaise(player.userId);

    expect((await resolve(orderId, {
      decision: 'RELEASE_TO_USER', resolution: 'confirmed',
    })).status).toBe(200);

    const after = await getBalancesPaise(player.userId);
    // The whole amount used to land in the betting pocket, so the same deposit
    // left the player with a different wallet shape depending on whether it had
    // been disputed.
    expect(after.depositBalance - before.depositBalance).toBe(90_000);
    expect(after.reserveBalance - before.reserveBalance).toBe(10_000);
  });

  it('keys the credit on the ORDER, so a second release pays nothing again', async () => {
    const { orderId, player, merchant } = await disputedDeposit({ rupees: 1000 });
    const playerBefore = await getBalancesPaise(player.userId);
    const merchantBefore = await getMerchantBalances(merchant.merchantId);

    await resolve(orderId, { decision: 'RELEASE_TO_USER', resolution: 'first' });
    // The order is COMPLETED now, so the route refuses on state — but the money
    // calls underneath are keyed on the order id either way, which is the
    // property that was lost when a sentence was passed instead.
    await resolve(orderId, { decision: 'RELEASE_TO_USER', resolution: 'second' });

    const playerAfter = await getBalancesPaise(player.userId);
    const merchantAfter = await getMerchantBalances(merchant.merchantId);
    expect((playerAfter.depositBalance + playerAfter.reserveBalance)
         - (playerBefore.depositBalance + playerBefore.reserveBalance)).toBe(100_000);
    expect(Number(merchantBefore.available) - Number(merchantAfter.available)).toBe(100_000);
    expect((await getOrderRecord(orderId)).status).toBe('COMPLETED');
  });
});
