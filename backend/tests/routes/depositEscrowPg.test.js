// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant's side of a buy order is HELD, not merely checked.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * Eligibility was read at assignment and the tokens stayed spendable for the
 * whole life of the order. Two orders arriving together both passed the read and
 * were both assigned to a merchant who could fund one. Measured before this
 * existed: two 600-token orders on a merchant holding 1,000, `assigned=true,true`.
 *
 * Making the read more accurate does not fix it. A number read in one statement
 * and acted on in another is a snapshot however good the number is. That is the
 * distinction §0.5 question 2 exists to ask, and the first fix for F-018 failed
 * it — which is why these tests assert the HOLD and never a balance.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * 1. The hold is real and atomic — the loser of a race is refused by the
 *    database, not by a check that happened to run second.
 * 2. Every terminal path gives the tokens back, automatically.
 * 3. Nothing is charged twice: the hold becomes the payment, it does not sit
 *    beside it.
 * 4. The two sweeps see the two opposite faults.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateMerchant, assignmentCandidates } from '#db/repositories/merchants.js';
import { cancelOrder } from '#db/repositories/orders.core.js';
import { getMerchantBalances, getSpendablePaiseFor } from '#db/repositories/merchantWallets.core.js';
import {
  liveDepositSettlementFor, findStrandedDepositHolds, findUnheldDepositOrders,
} from '#db/repositories/merchantSettlements.js';
import {
  holdForOrder, releaseForOrder, dispenseForOrder, sweepDepositHolds,
} from '../../domains/merchant/depositEscrow.service.js';
import { tryAssignMerchant } from '../../domains/payment/paymentProcessing.service.js';
import { selectBestMerchant } from '../../domains/merchant/merchantScoring.service.js';
import { actor, merchantActor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a buy order HOLDS the merchant\'s tokens', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });

  /** A merchant the candidate query actually returns — `merchantActor` leaves
   *  `is_online` FALSE, so without this every assignment test is vacuous. */
  const made = [];
  const merchant = async (tokensRupees, extra = {}) => {
    const m = await merchantActor({ tokensRupees });
    await updateMerchant(m.merchantId, {
      isOnline: true, acceptsDeposits: true, acceptsWithdrawals: true,
      maxConcurrentDepositOrders: 10, maxConcurrentWithdrawalOrders: 10,
      ...extra,
    });
    made.push(m.merchantId);
    return m;
  };

  /**
   * Every merchant this suite made goes OFFLINE after the test that made it.
   *
   * Trap 10, arriving by the back door. These merchants carry a `maxOrder` of
   * ₹1,000,000 — raised so the large amounts below can reach them — which also
   * makes every one of them a candidate for every later test in this file.
   * They accumulate, and a ranking assertion written about two named merchants
   * quietly becomes an assertion about all of them: `expected '51d8…' to be
   * 'e846…'`, a stranger from three tests ago outranking the merchant the test
   * had just funded.
   *
   * Taking them offline touches ONLY rows this suite created and leaves the
   * assertions above intact — it is the "create your own rows, assert the
   * delta" rule applied to the fixtures rather than to the assertions.
   */
  afterEach(async () => {
    // The ORDERS go first, because a live hold belongs to one and the merchant
    // cannot be tidied out from under it.
    //
    // A buy order left PENDING_QUEUE is not inert: it sits in the waiting queue
    // at its denomination, and the next run's `supplyCashLink` hands its link
    // to whichever order has waited longest — which was THIS suite's leftover
    // from the run before, not the order the test had just created. Three
    // consecutive runs went 0, 2, then 8 failures on unchanged code, which is
    // the signature of a suite feeding on its own residue.
    for (const orderId of orders.splice(0)) {
      const row = await getOrderRecord(orderId).catch(() => null);
      if (!row) continue;
      await releaseForOrder(row, { actor: 'test-cleanup' }).catch(() => {});
      if (['PENDING_QUEUE', 'ASSIGNED', 'PROCESSING'].includes(row.state)) {
        await cancelOrder({ orderId, actor: 'test-cleanup', reason: 'suite cleanup' }).catch(() => {});
      }
    }
    for (const id of made.splice(0)) {
      await updateMerchant(id, { isOnline: false }).catch(() => {});
    }
  });

  const orders = [];
  const buy = async (tokens, { state = 'PENDING_QUEUE', merchantId = null, paymentMode = null } = {}) => {
    seq += 1;
    const who = await actor({});
    const orderId = `ESC-${RUN}-${seq}`;
    orders.push(orderId);
    await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens, state,
      depositAllocation: tokens, reserveAllocation: 0,
      ...(merchantId ? { merchantId } : {}),
      // The rail is FORCED on the order rather than switched on the platform.
      // `stampForNewOrder` allows it precisely so a test can build a cash order
      // without moving the live policy under every other suite.
      ...(paymentMode ? { paymentMode } : {}),
    });
    return getOrderRecord(orderId);
  };

  const pockets = (id) => getMerchantBalances(id);

  describe('the hold itself', () => {
    it('moves tokens out of available and into reserved', async () => {
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });

      expect(await pockets(m.merchantId)).toMatchObject({ available: 100_000, reserved: 0 });

      expect((await holdForOrder(order, m.merchantId)).ok).toBe(true);

      const after = await pockets(m.merchantId);
      expect(after.available, 'the tokens never left available').toBe(40_000);
      expect(after.reserved).toBe(60_000);
      // liability is what the merchant owes but cannot spend, and the hold is
      // exactly that. A hold that did not move it would be invisible to every
      // report that reads it.
      expect(after.liability).toBe(60_000);
    });

    it('refuses a merchant who cannot cover it, and moves nothing', async () => {
      const m = await merchant(100);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });

      const held = await holdForOrder(order, m.merchantId);
      expect(held.ok).toBe(false);
      expect(held.reason).toBe('insufficient');
      expect(await pockets(m.merchantId)).toMatchObject({ available: 10_000, reserved: 0 });
      expect(await liveDepositSettlementFor(order.orderId)).toBeNull();
    });

    it('is idempotent for the merchant who already holds it', async () => {
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });
      await holdForOrder(order, m.merchantId);

      const again = await holdForOrder(order, m.merchantId);
      expect(again.ok).toBe(true);
      expect(again.idempotent).toBe(true);
      // Charged ONCE. A retry that reserved a second time would take 1,200
      // tokens for a 600-token order and the merchant would never get them back.
      expect(await pockets(m.merchantId)).toMatchObject({ available: 40_000, reserved: 60_000 });
    });

    it('refuses a SECOND merchant while one holds it', async () => {
      const a = await merchant(1_000);
      const b = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: a.merchantId });
      await holdForOrder(order, a.merchantId);

      const stolen = await holdForOrder(order, b.merchantId);
      expect(stolen.ok).toBe(false);
      expect(stolen.reason).toBe('held_by_another');
      expect(stolen.heldBy).toBe(a.merchantId);
      expect(await pockets(b.merchantId), 'b was charged for a\'s order')
        .toMatchObject({ available: 100_000, reserved: 0 });
    });

    it('two merchants racing the SAME order: the database picks one', async () => {
      // ── This is the test the partial unique index exists for ──────────────
      // `holdForOrder` reads for an existing hold before opening one, and that
      // read is what answers the SEQUENTIAL case. Two callers arriving together
      // both see nothing, so the read decides neither of them — the only thing
      // that does is `merchant_settlements_one_live_deposit`, which lets exactly
      // one INSERT land and gives the other a unique violation to read back.
      //
      // Written because dropping that index broke NO test: every case was
      // sequential, so the index was load-bearing and unmeasured, which reads
      // exactly like a pass (§0.5).
      const a = await merchant(1_000);
      const b = await merchant(1_000);
      const order = await buy(600);

      const [ra, rb] = await Promise.all([
        holdForOrder(order, a.merchantId),
        holdForOrder(order, b.merchantId),
      ]);

      const winners = [ra, rb].filter((r) => r.ok);
      expect(winners.length, 'both merchants held the same order').toBe(1);

      const live = await liveDepositSettlementFor(order.orderId);
      expect(live).not.toBeNull();

      // And the loser was not charged. Two holds for one promise would take
      // 1,200 tokens of inventory off the platform for a 600-token order.
      const held = await Promise.all([a.merchantId, b.merchantId].map(pockets));
      expect(held.filter((p) => p.reserved === 60_000).length).toBe(1);
      expect(held.filter((p) => p.reserved === 0).length).toBe(1);
    });

    it('does not hold anything for a SELL — those tokens move toward the merchant', async () => {
      const m = await merchant(1_000);
      seq += 1;
      const who = await actor({});
      const orderId = `ESC-${RUN}-w${seq}`;
      await createOrderRecord({
        orderId, userId: who.userId, type: 'WITHDRAWAL',
        tokenAmountRupees: 600, fiatAmountRupees: 600, state: 'ASSIGNED',
        merchantId: m.merchantId,
      });
      expect(await liveDepositSettlementFor(orderId)).toBeNull();
      expect(await pockets(m.merchantId)).toMatchObject({ available: 100_000, reserved: 0 });
    });
  });

  describe('the race — the whole reason a hold and not a read', () => {
    /**
     * SCOPED BY AMOUNT, deliberately.
     *
     * The suite shares one database, so `tryAssignMerchant` considers every
     * merchant every other test has made, and asserting on the winner would be
     * asserting a global invariant over a shared table (trap 10). A merchant
     * row's `max_order_paise` defaults to ₹50,000, so an order of 120,000
     * tokens excludes every merchant except the ones these tests raise the cap
     * on — which makes the comparison be between the merchants named here.
     */
    const BIG = 120_000;

    it('two orders, one merchant who can fund one: their tokens are held ONCE', async () => {
      const m = await merchant(200_000);
      const a = await buy(BIG);
      const b = await buy(BIG);

      // The baseline is taken AFTER the merchant exists and BEFORE these two
      // orders, and the assertions below are deltas from it. An online merchant
      // holding 200,000 tokens with a raised order cap is the most attractive
      // candidate in a shared database, and other suites' assignment sweeps run
      // in parallel — measured: this merchant picked up somebody else's order
      // mid-test and the absolute pocket assertion failed on roughly one run in
      // three. Trap 10 again: take a baseline, assert the delta.
      const base = await pockets(m.merchantId);

      await Promise.all([tryAssignMerchant(a), tryAssignMerchant(b)]);

      const rows = await Promise.all([a.orderId, b.orderId].map((id) => getOrderRecord(id)));
      const mine = rows.filter((r) => String(r.merchantId) === String(m.merchantId));

      // ── Asserted about THIS merchant's pocket, not about who won ──────────
      // The first version asserted "exactly one of the two orders was assigned"
      // and "one of them is mine". Both are claims about every merchant in the
      // database, and this suite makes its own: a merchant from an earlier test
      // in the same run took one of the orders and the assertion failed while
      // the mechanism was working perfectly (trap 10, arriving as a fixture
      // rather than as an assertion).
      //
      // What the hold actually promises is about ONE merchant: they can be
      // committed to at most what they hold. That is true whoever else is in
      // the queue, so it is what is asserted.
      const after = await pockets(m.merchantId);
      expect(mine.length, 'both orders went to a merchant who can fund one').toBeLessThanOrEqual(1);
      expect(after.reserved - base.reserved, 'reserved more than these orders are worth')
        .toBe(mine.length * BIG * 100);
      expect(base.available - after.available).toBe(mine.length * BIG * 100);
      expect(after.available, 'the wallet went negative').toBeGreaterThanOrEqual(0);
    });

    it('a merchant whose tokens are all held is no longer a candidate', async () => {
      // Asked of the CANDIDATE QUERY with every other merchant barred, not of
      // `tryAssignMerchant`. Assignment ranks across the whole database and this
      // suite cannot own that: a merchant funded for exactly one BIG order is
      // out-ranked by anyone holding more, so "my merchant won" was a claim
      // about every other suite's fixtures. Scoped, the question is the one the
      // hold actually answers.
      const m = await merchant(BIG);
      const only = async () => {
        const all = await assignmentCandidates({ currency: 'INR', direction: 'DEPOSIT' });
        const barred = all.map((c) => String(c.merchantId)).filter((id) => id !== m.merchantId);
        return selectBestMerchant('DEPOSIT', BIG, 'INR', { barredMerchantIds: barred });
      };

      expect((await only())?.merchantId, 'not a candidate even before holding — vacuous')
        .toBe(m.merchantId);

      const order = await buy(BIG, { state: 'ASSIGNED', merchantId: m.merchantId });
      expect((await holdForOrder(order, m.merchantId)).ok).toBe(true);

      expect(await only(), 'a merchant with every token held was still offered an order')
        .toBeNull();
    });

    it('the order the hold refused is left QUEUED, never failed', async () => {
      const m = await merchant(BIG);
      const a = await buy(BIG);
      const b = await buy(BIG);

      // Both handed to the merchant in turn; the second cannot be funded.
      await holdForOrder(a, m.merchantId);
      const refused = await holdForOrder(b, m.merchantId);
      expect(refused.ok).toBe(false);
      expect(refused.reason).toBe('insufficient');

      // The ORDER is untouched — still assignable, nothing consumed. The hold
      // refuses the merchant, never the order: somebody else may still serve it.
      const row = await getOrderRecord(b.orderId);
      expect(row.state).toBe('PENDING_QUEUE');
      expect(await liveDepositSettlementFor(b.orderId)).toBeNull();
    });

    it('ranks on what is LEFT, not on what the merchant holds', async () => {
      // Through `selectBestMerchant` with every other candidate barred, so the
      // comparison is between the two merchants this test made and nobody
      // else's. `tryAssignMerchant` cannot be scoped that way, and a ranking
      // assertion over the whole candidate list is an assertion about every
      // merchant in a shared database.
      const rich = await merchant(BIG + 10_000);
      const poor = await merchant(BIG);
      const mine = new Set([rich.merchantId, poor.merchantId]);

      const pick = async () => {
        const all = await assignmentCandidates({ currency: 'INR', direction: 'DEPOSIT' });
        const barred = all.map((c) => String(c.merchantId)).filter((id) => !mine.has(id));
        return selectBestMerchant('DEPOSIT', BIG, 'INR', { barredMerchantIds: barred });
      };

      expect((await pick())?.merchantId, 'the bigger holder should take the first order')
        .toBe(rich.merchantId);

      // Hold the first order's tokens against `rich`, leaving them 10,000 —
      // less than `poor` has uncommitted.
      const first = await buy(BIG, { state: 'ASSIGNED', merchantId: rich.merchantId });
      expect((await holdForOrder(first, rich.merchantId)).ok).toBe(true);

      expect((await pick())?.merchantId,
        'ranked on the raw balance instead of what is left after the hold')
        .toBe(poor.merchantId);
    });
  });

  describe('the CASH rail attaches a merchant too, so it holds too', () => {
    /**
     * `tryClaimCashLink` is the FOURTH route by which an order becomes a
     * merchant's, and the one that looks least like an assignment — a cash
     * order is matched to a link the merchant has already produced at a
     * machine, not scored against a candidate list. It does not go through
     * `tryAssignMerchant`, so it was missed on the first pass of this work and
     * the cash rail kept the whole defect the UPI rail had just lost.
     *
     * ₹10,000 — `MAX_CASH_BUY_PAISE`, the largest a machine dispenses in one
     * go and so the largest tier a cash BUY can legally be.
     *
     * A first draft used ₹40,000 because `cashLinkRoutes.test.js` does, and
     * that was wrong twice over. ₹40,000 is a WITHDRAWAL leg tier: no cash buy
     * can exist at it, so the order this test built was not a legal order. And
     * that suite uses it precisely BECAUSE no buy can exist there — its links
     * are safe from the matcher for exactly that reason. Creating a ₹40,000 buy
     * took the property away from them, and three of their cases started failing
     * in the full run while both files passed alone.
     *
     * **A test may not spend another suite's invariant.**
     */
    const DENOM = 1_000_000;

    it('holds the merchant\'s tokens when a cash link is claimed', async () => {
      // ── The link is supplied through the REPOSITORY, not the service ──────
      // `supplyCashLink` refuses unless the platform is on the cash rail, so
      // the first version of this test published a CASH_ATM policy and restored
      // it in a `finally`. That policy is GLOBAL and vitest runs files in
      // parallel: `cashLinkRoutes.test.js` sets the rail in its own `beforeAll`
      // and this test moved it underneath, so three of its cases failed while
      // both files passed alone. A test may own its rows; it may not own the
      // platform.
      //
      // The subject here is `tryClaimCashLink` taking a hold, and supply is
      // only the fixture, so it goes in the way `cashLinkQueuePg` does — the
      // repository, which asks nothing about the rail.
      const { supplyLink } = await import('#db/repositories/cashLinks.js');
      const { tryClaimCashLink } = await import('../../domains/payment/paymentProcessing.service.js');

      const m = await merchant(50_000, { cashDenominationPaise: DENOM });
      const order = await buy(DENOM / 100, { paymentMode: 'CASH_ATM' });

      const supplied = await supplyLink({
        linkId: `esc-lnk-${RUN}-${seq}`, merchantId: m.merchantId,
        denominationPaise: DENOM, paymentLink: 'upi://pay?pa=atm@bank&am=40000',
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
      expect(supplied.ok, `link not supplied: ${supplied.reason}`).toBe(true);

      // ── Asserted about the ORDER's OWN merchant, whoever that turns out ──
      // The denomination ladder has five rungs and every one is used by some
      // other suite, which leaves its own live links behind. So this order can
      // be handed SOMEBODY ELSE'S link — measured: the claim succeeded and this
      // merchant's pocket never moved, because a stranger's link won. Both
      // earlier drafts were wrong in the same way, once about which order won
      // and once about which link did.
      //
      // The invariant does not depend on either: whichever merchant's link a
      // cash buy claims, THAT merchant's tokens are held for it, once.
      expect(await tryClaimCashLink(order), 'no link was claimed — vacuous').toBe(true);

      const row = await getOrderRecord(order.orderId);
      expect(row.merchantId, 'the claim attached nobody').toBeTruthy();

      const held = await liveDepositSettlementFor(order.orderId);
      expect(held, 'a cash buy attached a merchant without holding their tokens').not.toBeNull();
      expect(String(held.merchantId), 'the hold is against a different merchant than the order')
        .toBe(String(row.merchantId));
      expect(held.amountPaise).toBe(DENOM);
      expect((await pockets(row.merchantId)).reserved).toBeGreaterThanOrEqual(DENOM);
    });
  });

  describe('every ending gives the tokens back', () => {
    it('a release returns them to available', async () => {
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });
      await holdForOrder(order, m.merchantId);

      expect((await releaseForOrder(order, { reason: 'test' })).ok).toBe(true);
      expect(await pockets(m.merchantId)).toMatchObject({ available: 100_000, reserved: 0 });
      expect(await liveDepositSettlementFor(order.orderId), 'the hold is still live').toBeNull();
    });

    it('a dispense SPENDS them — they do not come back', async () => {
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });
      await holdForOrder(order, m.merchantId);

      expect((await dispenseForOrder(order)).ok).toBe(true);
      // reserved -600 and NOT available +600: the tokens went to the player.
      // Returning them here is the shape that pays a deposit out of thin air.
      expect(await pockets(m.merchantId)).toMatchObject({ available: 40_000, reserved: 0 });
    });

    it('releasing an order that never had a hold is fine, not an error', async () => {
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });
      const out = await releaseForOrder(order);
      expect(out.ok).toBe(true);
      expect(out.noHold).toBe(true);
    });

    it('after a release the same merchant can be given the order again', async () => {
      // The settlement id carries a random suffix precisely for this: a
      // deterministic one would collide with the CANCELLED settlement from the
      // first attachment and report a hold that holds nothing.
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });
      await holdForOrder(order, m.merchantId);
      await releaseForOrder(order);

      const again = await holdForOrder(order, m.merchantId);
      expect(again.ok, 'a re-attachment was reported held while holding nothing').toBe(true);
      expect(again.idempotent).toBeFalsy();
      expect(await pockets(m.merchantId)).toMatchObject({ available: 40_000, reserved: 60_000 });
    });
  });

  describe('the derived figure becomes the INVARIANT', () => {
    it('spendable equals available once the tokens are actually held', async () => {
      // `getSpendablePaiseFor` was the first fix for F-018 — available minus the
      // open orders, computed. With a real hold the wallet already excludes
      // them, so the two must agree. They disagree exactly when an order owes
      // tokens nothing is holding, which is what the sweep reports.
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });

      const before = (await getSpendablePaiseFor([m.merchantId])).get(m.merchantId);
      expect(before.spendable, 'unheld: the derivation subtracts it').toBe(40_000);
      expect(before.available, 'unheld: the wallet does not').toBe(100_000);

      await holdForOrder(order, m.merchantId);

      const after = (await getSpendablePaiseFor([m.merchantId])).get(m.merchantId);
      expect(after.available).toBe(40_000);
      expect(after.committed, 'double-subtracted the held order').toBe(0);
      expect(after.spendable).toBe(after.available);
    });
  });

  describe('the sweeps — the net under a path that forgets', () => {
    it('releases a hold whose order has finished', async () => {
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });
      await holdForOrder(order, m.merchantId);

      // The order finishes without its hold being released — the exact fault.
      // Through the real transition, not an UPDATE: a row forced into a
      // terminal state proves the enum accepts the string, and the sweep is
      // supposed to see orders the LIFECYCLE finished.
      expect((await cancelOrder({ orderId: order.orderId, actor: 'test', reason: 'sweep fixture' })).ok)
        .toBe(true);

      // Grace of ZERO instead of backdating the row. The grace exists so
      // ordinary in-flight orders are not reported, and setting it to nothing
      // is the same question without reaching past `#db` to age a timestamp —
      // which the boundary gate correctly refuses, and which would also have
      // tested a row shape rather than the query.
      const found = await findStrandedDepositHolds({ olderThanMinutes: 0 });
      expect(found.map((f) => f.orderId)).toContain(order.orderId);

      await sweepDepositHolds({ graceMinutes: 0 });
      expect(await pockets(m.merchantId)).toMatchObject({ available: 100_000, reserved: 0 });
    });

    it('REPORTS an order that owes tokens with no hold, and does not silently re-hold it', async () => {
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });

      const unheld = await findUnheldDepositOrders({ olderThanMinutes: 0 });
      expect(unheld.map((u) => u.orderId)).toContain(order.orderId);

      await sweepDepositHolds({ graceMinutes: 0 });
      // Still unheld ON PURPOSE. Re-taking it could fail, and succeeding would
      // hide the path that forgot — which is the thing worth knowing.
      expect(await liveDepositSettlementFor(order.orderId)).toBeNull();
      expect(await pockets(m.merchantId)).toMatchObject({ available: 100_000, reserved: 0 });
    });

    it('leaves an in-flight order alone — the grace is what makes the sweep usable', async () => {
      const m = await merchant(1_000);
      const order = await buy(600, { state: 'ASSIGNED', merchantId: m.merchantId });
      await holdForOrder(order, m.merchantId);

      const stranded = await findStrandedDepositHolds({ olderThanMinutes: 15 });
      expect(stranded.map((s) => s.orderId)).not.toContain(order.orderId);
      const unheld = await findUnheldDepositOrders({ olderThanMinutes: 15 });
      expect(unheld.map((u) => u.orderId)).not.toContain(order.orderId);

      await sweepDepositHolds({ graceMinutes: 15 });
      expect(await pockets(m.merchantId)).toMatchObject({ available: 40_000, reserved: 60_000 });
    });
  });
});
