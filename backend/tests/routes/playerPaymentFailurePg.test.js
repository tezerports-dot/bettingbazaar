// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A buy order nobody paid for is the PLAYER's failure, not the merchant's.
 *
 * ── The party who failed and the party who was charged were different ───────
 * Every expired assignment used to advance the merchant's consecutive-refusal
 * streak. On a BUY that is the wrong person: the order expires at ASSIGNED or
 * PROCESSING because the player never paid, and the merchant — who was standing
 * by with their tokens held for it — took the strike. Three players who changed
 * their minds suspended a merchant who had done nothing.
 *
 * It is not free, though, and that is why the count moved rather than
 * disappearing: every one of those orders HELD a merchant's tokens for the
 * length of its window. Real inventory, unavailable to anybody else, released
 * only when the order died.
 *
 * ── What is asserted ───────────────────────────────────────────────────────
 * 1. A lapsed buy does NOT touch the merchant — no streak, no bar.
 * 2. It DOES advance the player's, and flags them at the cap.
 * 3. Flagged, not blocked. The platform's answer to a pattern is a person.
 * 4. Paying resets it — and only really paying, not merely claiming to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, setOrderFields, merchantsBarredFrom, getOrderRecord } from '#db/repositories/orders.record.js';
import { getMerchant, updateMerchant } from '#db/repositories/merchants.js';
import { getUser } from '#db/repositories/users.js';
import { setConfigPath, getSystemConfig, invalidateConfigCache } from '#db/repositories/config.js';
import { expireOrders, sweepUnansweredPaidDeposits } from '../../domains/payment/paymentProcessing.service.js';
import { clearPlayerPaymentFailures } from '../../domains/payment/playerPaymentFailure.service.js';
import { actor, merchantActor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a buy order nobody paid for', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });

  const merchant = async () => {
    const m = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(m.merchantId, { isOnline: true, acceptsDeposits: true });
    return m;
  };

  /** An ASSIGNED buy, already past its deadline, that the player never paid. */
  const lapsedBuy = async (merchantId, owner = null) => {
    seq += 1;
    const who = owner || await actor({});
    const orderId = `PPF-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500, state: 'ASSIGNED',
      depositAllocation: 450, reserveAllocation: 50, merchantId,
    });
    await setOrderFields(orderId, { expiresAt: new Date(Date.now() - 60 * 1000) });
    return { orderId, who };
  };

  it('does NOT count against the merchant — not the streak, not the bar', async () => {
    const m = await merchant();
    const { orderId, who } = await lapsedBuy(m.merchantId);

    await expireOrders();

    expect((await getMerchant(m.merchantId)).consecutiveRejections,
      'the merchant was charged for a payment the player never made').toBe(0);
    expect((await getMerchant(m.merchantId)).status).toBe('ACTIVE');
    // …and they are still eligible for this player's next order. Barring them
    // would shrink the pool by one merchant every time somebody abandoned a
    // purchase.
    expect(await merchantsBarredFrom({ orderId, userId: who.userId }))
      .not.toContain(m.merchantId);
  });

  it('THREE lapsed buys still leave the merchant ACTIVE', async () => {
    // The exact scenario the old rule suspended an honest merchant for.
    const m = await merchant();
    for (let i = 0; i < 3; i += 1) {
      await lapsedBuy(m.merchantId);
      await expireOrders();
    }
    const row = await getMerchant(m.merchantId);
    expect(row.consecutiveRejections).toBe(0);
    expect(row.status, 'three abandoned purchases suspended the merchant').toBe('ACTIVE');
  });

  it('advances the PLAYER\'s count instead', async () => {
    const m = await merchant();
    const who = await actor({});
    await lapsedBuy(m.merchantId, who);
    await expireOrders();

    expect((await getUser(who.userId)).consecutivePaymentFailures).toBe(1);
  });

  it('flags the player at the cap — and does not block them', async () => {
    // Lowered so the test states the RULE rather than repeating five orders,
    // and restored after: the suite shares this document with every other file
    // (trap 10 — the config is as shared as any table).
    //
    // Through `setConfigPath`, the one owner of a config write. Reading the
    // whole document and writing it back would clobber any field another suite
    // changed while this one ran.
    const PATH = 'merchantOrderLimits.maxConsecutivePlayerPaymentFailures';
    const before = (await getSystemConfig())?.merchantOrderLimits
      ?.maxConsecutivePlayerPaymentFailures ?? 5; // schema default: 5
    await setConfigPath('system', PATH, 2, { actor: 'test', reason: 'player failure cap test' });
    invalidateConfigCache('system');
    try {
      const m = await merchant();
      const who = await actor({});

      await lapsedBuy(m.merchantId, who);
      await expireOrders();
      expect((await getUser(who.userId)).paymentFlagged ?? false,
        'flagged before reaching the cap').toBe(false);

      await lapsedBuy(m.merchantId, who);
      await expireOrders();

      const row = await getUser(who.userId);
      expect(row.consecutivePaymentFailures).toBe(2);
      expect(row.paymentFlagged, 'the cap was reached and nobody was told').toBe(true);
      // Flagged is a hand raised, not a door closed. An abandoned purchase is
      // an ordinary thing to do; the answer to a PATTERN of them is a person.
      expect(row.isBlocked ?? false, 'the player was auto-blocked').toBe(false);
    } finally {
      await setConfigPath('system', PATH, before, { actor: 'test', reason: 'restore' });
      invalidateConfigCache('system');
    }
  });

  describe('the other side of the same clock — a PAID buy nobody answered', () => {
    /**
     * The window that had no owner.
     *
     * `expireOrders` cancels what nobody paid for and stops short of PAID on
     * purpose — cancelling an order the player has already paid for strands the
     * payment. So a merchant who neither approved nor rejected a PAID buy
     * simply kept it: nothing swept it, nothing counted it, and the only route
     * out was the player noticing and pressing dispute. The one window where
     * the money is ALREADY GONE was the one with no clock on it.
     */
    const paidAndIgnored = async (merchantId, minutesAgo = 120) => {
      seq += 1;
      const who = await actor({});
      const orderId = `PPF-${RUN}-p${seq}`;
      await createOrderRecord({
        orderId, userId: who.userId, type: 'DEPOSIT',
        tokenAmountRupees: 500, fiatAmountRupees: 500, state: 'PAID',
        depositAllocation: 450, reserveAllocation: 50, merchantId,
      });
      await setOrderFields(orderId, { paidAt: new Date(Date.now() - minutesAgo * 60_000) });
      return { orderId, who };
    };

    it('sends it to the admin queue and counts the silence against the merchant', async () => {
      const m = await merchant();
      const { orderId } = await paidAndIgnored(m.merchantId);

      expect(await sweepUnansweredPaidDeposits()).toBeGreaterThan(0);

      const row = await getOrderRecord(orderId);
      // DISPUTED, not CANCELLED: the player paid THIS merchant's account, so
      // only a person can decide whether the money arrived. Cancelling would
      // strand the payment; reassigning would ask a second merchant to hand
      // over tokens for a payment they never received.
      expect(row.state).toBe('DISPUTED');
      expect(row.disputeRaisedBy, 'a player who raised nothing was recorded as raising it')
        .toBe('system');

      expect((await getMerchant(m.merchantId)).consecutiveRejections,
        'the silence cost the merchant nothing').toBe(1);
    });

    it('leaves an order still inside the window alone', async () => {
      // The grace is what makes the sweep usable: a merchant checking a bank
      // app needs longer than a page refresh.
      const m = await merchant();
      const { orderId } = await paidAndIgnored(m.merchantId, 1);
      await sweepUnansweredPaidDeposits();
      expect((await getOrderRecord(orderId)).state).toBe('PAID');
      expect((await getMerchant(m.merchantId)).consecutiveRejections).toBe(0);
    });

    it('counts one silence once, however often the sweep runs', async () => {
      const m = await merchant();
      await paidAndIgnored(m.merchantId);
      await sweepUnansweredPaidDeposits();
      await sweepUnansweredPaidDeposits();
      await sweepUnansweredPaidDeposits();
      expect((await getMerchant(m.merchantId)).consecutiveRejections,
        'one unanswered order advanced the streak more than once').toBe(1);
    });
  });

  it('a real payment clears the streak', async () => {
    const m = await merchant();
    const who = await actor({});
    await lapsedBuy(m.merchantId, who);
    await expireOrders();
    expect((await getUser(who.userId)).consecutivePaymentFailures).toBe(1);

    // `clearPlayerPaymentFailures` is called from the deposit-credit path — the
    // one place both confirm routes agree the money ARRIVED. Reaching PAID is
    // only the player saying so, and resetting there would let a false UTR wipe
    // the record the count exists to keep.
    await clearPlayerPaymentFailures(who.userId);
    expect((await getUser(who.userId)).consecutivePaymentFailures).toBe(0);
  });
});
