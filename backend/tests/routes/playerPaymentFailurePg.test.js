// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A buy order nobody paid for is NOBODY's failure — and it still tells us two
 * things.
 *
 * ── Two wrong answers came before the right one ────────────────────────────
 * Every expired assignment first advanced the MERCHANT's refusal streak, which
 * suspended honest merchants for three players who changed their minds. The fix
 * moved the strike to the PLAYER, which was wrong the other way: the player
 * abandoned a purchase, which is an ordinary thing to do.
 *
 * Nobody is at fault. The event is still worth counting, because it answers two
 * different questions:
 *
 *   THE PLAYER, three in a row — every one of those orders HELD a merchant's
 *   tokens for its window (F-018), so a player cycling through them takes
 *   supply other players needed. They cannot open a new order for an hour. The
 *   cool-off lifts itself, and paying clears it early.
 *
 *   THE MERCHANT, three in a row — the one nothing else could see. Three
 *   different players sent to the same merchant, none able to pay, most likely
 *   means that MERCHANT cannot be paid: a dead QR, a closed handle. One order
 *   at a time it looks like an ordinary abandonment. They stop being assigned
 *   until an admin has spoken to them — not suspended, and lifted by a person,
 *   because a clock cannot tell whether the QR was fixed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, setOrderFields, merchantsBarredFrom, getOrderRecord } from '#db/repositories/orders.record.js';
import {
  getMerchant, updateMerchant, assignmentCandidates, resumeAssignment,
} from '#db/repositories/merchants.js';
import { getUser } from '#db/repositories/users.js';
import { setConfigPath, getSystemConfig, invalidateConfigCache } from '#db/repositories/config.js';
import {
  expireOrders, sweepUnansweredPaidDeposits, updateMerchantStatsOnComplete,
  createDepositOrder, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
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

  /**
   * The cap this test needs, set explicitly.
   *
   * `getSystemConfig` reads a STORED document and only falls back to the spec
   * default for keys the document does not carry — so changing a default in
   * `config.spec.js` does not change a database that already has the key. (That
   * is true of a real deployment too, not just this suite: an existing
   * installation keeps the old number until somebody sets it.) A test that
   * relied on the default would pass or fail depending on what every other
   * suite had left behind.
   */
  const withPlayerCap = async (value, run) => {
    const key = 'merchantOrderLimits.maxConsecutivePlayerPaymentFailures';
    const before = (await getSystemConfig())?.merchantOrderLimits
      ?.maxConsecutivePlayerPaymentFailures ?? 3;   // schema default: 3
    await setConfigPath('system', key, value, { actor: 'test', reason: 'player cap test' });
    invalidateConfigCache('system');
    try { await run(); } finally {
      await setConfigPath('system', key, before, { actor: 'test', reason: 'restore' });
      invalidateConfigCache('system');
    }
  };

  it('locks the player out of new orders after THREE in a row', async () => {
    await withPlayerCap(3, async () => {
    const m = await merchant();
    const who = await actor({});

    for (let i = 1; i <= 2; i += 1) {
      await lapsedBuy(m.merchantId, who);
      await expireOrders();
      expect((await getUser(who.userId)).orderLockUntil ?? null,
        `locked after only ${i}`).toBeNull();
    }

    await lapsedBuy(m.merchantId, who);
    await expireOrders();

    const row = await getUser(who.userId);
    expect(row.consecutivePaymentFailures).toBe(3);
    expect(row.orderLockUntil, 'three in a row and nothing happened').toBeTruthy();
    // Roughly an hour out. Asserted as a WINDOW, not a value: the deadline is
    // computed by the database's clock and read back through this one, and
    // demanding they agree to the second is asserting about NTP.
    const minutes = (new Date(row.orderLockUntil) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(55);
    expect(minutes).toBeLessThan(65);
    // Flagged for an admin to see — and NOT blocked. The lock is an hour and
    // lifts itself; closing an account stays a person's decision.
    expect(row.paymentFlagged).toBe(true);
    expect(row.isBlocked ?? false, 'the player was auto-blocked').toBe(false);
    });
  });

  it('refuses a new order while the cool-off is running, and names the time', async () => {
    await withPlayerCap(3, async () => {
      const m = await merchant();
      const who = await actor({});
      for (let i = 0; i < 3; i += 1) {
        await lapsedBuy(m.merchantId, who);
        await expireOrders();
      }

      await expect(createDepositOrder(who.userId, 500))
        .rejects.toMatchObject({ code: 'ORDER_COOL_OFF', status: 429 });
      // The SELL side too — a player locked out of buying who could still sell
      // has simply found the way around it.
      await expect(createWithdrawalOrder(who.userId, 500))
        .rejects.toMatchObject({ code: 'ORDER_COOL_OFF' });
    });
  });

  describe('and the half that finds a BROKEN merchant', () => {
    /**
     * Anil's QR has stopped working.
     *
     * Ravi is assigned Anil, tries to pay, cannot, gives up. Then Priya. Then
     * Sameer. Three different players, none of whom did anything wrong, and
     * Anil never pressed a button — so nothing about any single one of those
     * orders looks like anything but an ordinary abandoned purchase.
     *
     * The pattern is the only evidence, and it points at Anil.
     */
    const threeDifferentPlayersFailOn = async (merchantId) => {
      for (let i = 0; i < 3; i += 1) {
        await lapsedBuy(merchantId, await actor({}));   // a DIFFERENT player each time
        await expireOrders();
      }
    };

    it('pauses the merchant after three, without suspending them', async () => {
      const anil = await merchant();
      await threeDifferentPlayersFailOn(anil.merchantId);

      const row = await getMerchant(anil.merchantId);
      expect(row.consecutiveExpiries).toBe(3);
      expect(row.assignmentPausedAt, 'three players could not pay and nobody noticed').toBeTruthy();
      expect(row.assignmentPauseReason).toMatch(/QR|UPI|bank/i);

      // NOT a suspension, and NOT a refusal. Anil did nothing wrong: he keeps
      // his account, his standing and his refusal streak untouched.
      expect(row.status).toBe('ACTIVE');
      expect(row.consecutiveRejections).toBe(0);
    });

    it('stops sending him new orders while paused', async () => {
      const anil = await merchant();
      const candidate = async () => (await assignmentCandidates({
        currency: 'INR', direction: 'DEPOSIT',
      })).some((c) => String(c.merchantId) === anil.merchantId);

      expect(await candidate(), 'not a candidate even before pausing — vacuous').toBe(true);
      await threeDifferentPlayersFailOn(anil.merchantId);
      expect(await candidate(), 'a merchant nobody can pay was still being assigned').toBe(false);
    });

    it('an admin lifts it, and the count goes with it', async () => {
      const anil = await merchant();
      await threeDifferentPlayersFailOn(anil.merchantId);

      await resumeAssignment(anil.merchantId);

      const row = await getMerchant(anil.merchantId);
      expect(row.assignmentPausedAt ?? null).toBeNull();
      // Zeroed in the same statement. Left at three, the very next ordinary
      // expiry pauses him again and the admin's decision lasts one order.
      expect(row.consecutiveExpiries, 'reinstated at the cap — re-paused by the next expiry').toBe(0);
    });

    it('a completed order clears the run on its own', async () => {
      // Anil fixes his QR and serves somebody. Nothing needed an admin.
      const anil = await merchant();
      await lapsedBuy(anil.merchantId, await actor({}));
      await expireOrders();
      await lapsedBuy(anil.merchantId, await actor({}));
      await expireOrders();
      expect((await getMerchant(anil.merchantId)).consecutiveExpiries).toBe(2);

      await updateMerchantStatsOnComplete(anil.merchantId, true, { direction: 'DEPOSIT', amountRupees: 500 });

      expect((await getMerchant(anil.merchantId)).consecutiveExpiries).toBe(0);
    });
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
