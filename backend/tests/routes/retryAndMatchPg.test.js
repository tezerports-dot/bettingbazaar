// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Two halves of the same problem: an order nobody served, and what happens next.
 *
 * ── The gap the matcher closes ─────────────────────────────────────────────
 * `claimLinkFor` ran exactly ONCE per order, at creation. An order created at a
 * moment when no merchant held a link at its denomination therefore never got
 * one — nothing looked again when the link it had been waiting for was supplied
 * a minute later. The player watched a live order sit at PENDING_QUEUE until it
 * expired while a merchant stood at a machine with a link nobody took. Both
 * sides waiting for each other, and every check in this repository green.
 *
 * ── And why a retry goes first ─────────────────────────────────────────────
 * An order that never found a merchant owes nothing. But sending that player to
 * the back of the queue that just failed them is how somebody waits twice and
 * gets nothing twice, so a retry outranks a first attempt — and the assertion
 * that matters is the one where a retry created LATER is served BEFORE an older
 * first-time order, because that is the whole rule.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import {
  createOrderRecord, getOrderRecord, ordersAwaitingCashLink, setOrderFields,
} from '#db/repositories/orders.record.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import {
  PAYMENT_MODES, getActivePolicy, publishPolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
import { supplyCashLink } from '../../domains/merchant/cashLink.service.js';
// The matcher lives with the ASSIGNMENT, not with the link supply: it has to go
// through the complete operation — claim the link, make its owner the order's
// merchant, take the machine's deadline — and calling the raw claim instead
// leaves a half-assigned order showing a link nobody is serving.
import { retryOrder, matchWaitingOrdersToLinks } from '../../domains/payment/paymentProcessing.service.js';
import { cancelOrder as cancelState } from '../../domains/payment/orderLifecycle.service.js';
import { actor, merchantActor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a retry, and the link that arrives late', () => {
  let restore = null;
  let seq = 0;
  const oid = () => `rm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  /** ₹5,000 — a denomination both a buy and a merchant can hold. */
  const DENOM_RUPEES = 5000;
  const DENOM_PAISE = DENOM_RUPEES * 100;

  /**
   * The pg suites share one database, so this queue always has other people's
   * waiting orders in it. A test that supplies a link and asserts ITS order got
   * it is asserting that nothing else was waiting — a fact about which suites
   * ran, not about the matcher.
   *
   * So this suite ranks its own orders above the noise. And the noise includes
   * ITS OWN earlier tests: a test that leaves an order deliberately unclaimed
   * leaves it in the queue, older than everything after it, taking the next
   * link supplied. So every test takes a FRESH rank above the last one, and
   * asserts the order within its own.
   *
   * Same baseline-and-delta discipline the treasury check needed, applied to a
   * queue — including the part where the thing contaminating the shared state
   * turns out to be you.
   */
  /**
   * A rank above everything ACTUALLY waiting, read at the moment it is needed.
   *
   * The matcher is global: it walks every waiting order in the shared database,
   * so a link this suite supplies goes to whoever is at the front of that
   * queue — which includes other suites' orders, and its own from earlier runs.
   *
   * Guessing a high constant does not work, and neither does seeding from the
   * clock: consecutive runs are seconds apart and each uses a handful of ranks,
   * so the ranges overlap. Cleaning up after itself is necessary and still not
   * sufficient, because the competition is not all its own.
   *
   * So it reads the queue and goes one above. That is the same
   * baseline-and-delta discipline the treasury check needed: measure what is
   * there, then assert about what you added to it.
   */
  const rankAboveQueue = async () => {
    const queue = await ordersAwaitingCashLink({ limit: 500 });
    const top = queue.reduce((max, o) => Math.max(max, Number(o.assignmentPriority ?? 0)), 0);
    return top + 1;
  };

  // Every order this suite creates, so nothing it leaves behind sits in the
  // shared queue taking links from the next test or the next run.
  const created = [];

  const waitingBuy = async (player, { priority } = {}) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: DENOM_RUPEES, fiatAmountRupees: DENOM_RUPEES,
      state: 'PENDING_QUEUE',
      paymentMode: PAYMENT_MODES.CASH_ATM,
      assignmentPriority: priority,
    });
    created.push(orderId);
    return orderId;
  };

  const cashMerchant = async () => {
    const merchant = await merchantActor({ tokensRupees: 500_000 });
    await updateMerchant(merchant.merchantId, {
      cashDenominationPaise: DENOM_PAISE, isOnline: true, merchantApprovalStatus: 'APPROVED',
    });
    return merchant;
  };

  beforeAll(async () => {
    await applySchema();
    restore = await getActivePolicy();
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      // ── Set explicitly, because the DEFAULT does not match the rule ──────
      // `max_concurrent_orders` seeds to 3 for both rails. On the cash rail the
      // answer is ONE — the notes a merchant is holding are the same notes, so
      // two orders would promise them twice — and the column's own comment says
      // so while its default says otherwise.
      //
      // It is admin-editable per policy version, so a real cash-rail operator
      // sets it, and this suite configures what it is testing rather than
      // relying on a default that is wrong for this rail.
      timers: { maxConcurrentOrders: 1 },
      justification: 'Retry and match suite.', changedByName: 'test setup',
    });
  }, 60_000);

  // Anything still waiting is taken out of the queue. Cancelling is enough: the
  // waiting list is `state = 'PENDING_QUEUE'`, so a cancelled order is invisible
  // to the matcher — which is exactly the property being relied on.
  afterEach(async () => {
    for (const orderId of created.splice(0)) {
      const row = await getOrderRecord(orderId);
      if (row?.status !== 'PENDING_QUEUE') continue;
      await cancelState(orderId, { set: { cancelReason: 'TEST_CLEANUP', cancelledAt: new Date() } })
        .catch(() => { /* already moved on; nothing to tidy */ });
    }
  });

  afterAll(async () => {
    if (restore) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        timers: { maxConcurrentOrders: restore.maxConcurrentOrders },
        justification: 'Restoring the rail this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    await closePg();
  });

  it('hands a waiting order the link that appears after it', async () => {
    const player = await actor({});
    const merchant = await cashMerchant();
    const orderId = await waitingBuy(player, { priority: await rankAboveQueue() });

    // Created with nothing available: this is the state that used to be
    // permanent.
    expect((await getOrderRecord(orderId)).cashLinkId).toBeNull();

    const supplied = await supplyCashLink({
      merchantId: merchant.merchantId,
      merchant: { cashDenominationPaise: DENOM_PAISE },
      paymentLink: `upi://pay?pa=atm@bank&am=${DENOM_RUPEES}&tn=${orderId}`,
    });
    expect(supplied.ok).toBe(true);

    await matchWaitingOrdersToLinks();

    // Before this the order sat here until it expired while the link went
    // unused. And the assignment is COMPLETE — a link id with no merchant is a
    // player looking at a payment link nobody is serving.
    const served = await getOrderRecord(orderId);
    expect(served.cashLinkId).toBeTruthy();
    expect(served.merchantId).toBe(String(merchant.merchantId));
    expect(served.status).toBe('ASSIGNED');
  });

  it('serves a RETRY before an older first-time order', async () => {
    const first = await actor({});
    const retrier = await actor({});
    const merchant = await cashMerchant();

    // The older order, created first. The retry comes AFTER it and ranks above.
    const base = await rankAboveQueue();
    const above = base + 1;
    const older = await waitingBuy(first, { priority: base });
    const retried = await waitingBuy(retrier, { priority: above });

    const queue = await ordersAwaitingCashLink({ limit: 500 });
    const positions = queue.map((o) => o.orderId);
    // The whole rule, in one line: later, and still first.
    expect(positions.indexOf(retried)).toBeLessThan(positions.indexOf(older));

    // And one link goes to the retry, not to the order that has been waiting
    // longer — which is the point, and the part that feels unfair until you
    // remember the retrier already waited once and got nothing.
    await supplyCashLink({
      merchantId: merchant.merchantId,
      merchant: { cashDenominationPaise: DENOM_PAISE },
      paymentLink: 'upi://pay?pa=atm@bank&am=5000',
    });
    await matchWaitingOrdersToLinks();
    expect((await getOrderRecord(retried)).cashLinkId).toBeTruthy();
    expect((await getOrderRecord(older)).cashLinkId).toBeNull();
  });

  it('keeps first-come-first-served WITHIN a rank', async () => {
    const a = await actor({});
    const b = await actor({});
    const merchant = await cashMerchant();

    const shared = await rankAboveQueue();
    const earlier = await waitingBuy(a, { priority: shared });
    await new Promise((r) => setTimeout(r, 15));
    const later = await waitingBuy(b, { priority: shared });
    // Both above everything else, and equal to each other — so what separates
    // them is age and nothing else, which is the rule under test.

    const queue = (await ordersAwaitingCashLink({ limit: 500 })).map((o) => o.orderId);
    expect(queue.indexOf(earlier)).toBeLessThan(queue.indexOf(later));

    await supplyCashLink({
      merchantId: merchant.merchantId,
      merchant: { cashDenominationPaise: DENOM_PAISE },
      paymentLink: 'upi://pay?pa=atm@bank&am=5000',
    });
    await matchWaitingOrdersToLinks();
    expect((await getOrderRecord(earlier)).cashLinkId).toBeTruthy();
  });

  it('leaves an order that already holds a link out of the queue', async () => {
    const player = await actor({});
    const merchant = await cashMerchant();
    const orderId = await waitingBuy(player, { priority: await rankAboveQueue() });
    await supplyCashLink({
      merchantId: merchant.merchantId,
      merchant: { cashDenominationPaise: DENOM_PAISE },
      paymentLink: 'upi://pay?pa=atm@bank&am=5000',
    });
    await matchWaitingOrdersToLinks();
    expect((await getOrderRecord(orderId)).cashLinkId).toBeTruthy();

    // It is not looking for one any more. A queue that still listed it would
    // hand it a second link and strand the first.
    const queue = (await ordersAwaitingCashLink({ limit: 500 })).map((o) => o.orderId);
    expect(queue).not.toContain(orderId);
  });

  it('will not hand a second link to an order that already holds one', async () => {
    // ── This state is reachable, which is why the clause is not dead ──────
    // `tryClaimCashLink` claims the link FIRST and then transitions the order.
    // If that transition is refused — the order moved under it — the claim is
    // NOT rolled back: the link is consumed and the order is left holding a
    // link id while still PENDING_QUEUE.
    //
    // Without `cash_link_id IS NULL` the waiting query would offer that order
    // another link, consuming a second one and stranding the first until it
    // expires. Two merchants sent to two machines for one order.
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: DENOM_RUPEES, fiatAmountRupees: DENOM_RUPEES,
      state: 'PENDING_QUEUE', paymentMode: PAYMENT_MODES.CASH_ATM,
      assignmentPriority: await rankAboveQueue(),
    });
    created.push(orderId);
    // The half-state, written directly: a link id on an order that never left
    // the queue.
    await setOrderFields(orderId, { cashLinkId: 'cl_halfclaimed_probe' });

    const queue = (await ordersAwaitingCashLink({ limit: 500 })).map((o) => o.orderId);
    expect(queue).not.toContain(orderId);
  });

  it('is safe to run twice — a link goes to exactly one order', async () => {
    const a = await actor({});
    const b = await actor({});
    const merchant = await cashMerchant();
    const shared = await rankAboveQueue();
    const first = await waitingBuy(a, { priority: shared });
    const second = await waitingBuy(b, { priority: shared });

    await supplyCashLink({
      merchantId: merchant.merchantId,
      merchant: { cashDenominationPaise: DENOM_PAISE },
      paymentLink: 'upi://pay?pa=atm@bank&am=5000',
    });
    await matchWaitingOrdersToLinks();
    // Two matchers racing hand each link to exactly one order — the claim takes
    // it FOR UPDATE with a unique index behind it, and the loser finds nothing.
    await Promise.all([matchWaitingOrdersToLinks(), matchWaitingOrdersToLinks()]);

    const claimed = [first, second]
      .map(async (id) => (await getOrderRecord(id)).cashLinkId);
    const links = (await Promise.all(claimed)).filter(Boolean);
    expect(links.length).toBeLessThanOrEqual(1);
  });

  it('will not let a merchant supply again while they are working an order', async () => {
    // ── The hole this closes ────────────────────────────────────────────
    // `cash_link_one_live_per_merchant` stops two UNCLAIMED links. It stops
    // nothing once one is claimed: the row becomes CLAIMED, the partial index
    // no longer matches, and the merchant may supply again — while serving.
    //
    // And the cash-link claim never goes through `selectBestMerchant`, so the
    // concurrency cap every other assignment obeys was never consulted on this
    // rail at all. Supply → claimed → supply → claimed gave one merchant
    // unbounded concurrent orders, and on this rail the cap is ONE because the
    // notes they are holding are the same notes.
    //
    // The merchant is given an open order DIRECTLY rather than by supplying and
    // matching. Going through the matcher makes the test depend on whose link
    // gets claimed — the queue is shared, so another suite's live link can be
    // taken by this order and leave this merchant's own link still waiting,
    // refused for the wrong reason. What is under test is the guard, so the
    // state it guards against is set up plainly.
    const player = await actor({});
    const merchant = await cashMerchant();
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: DENOM_RUPEES, fiatAmountRupees: DENOM_RUPEES,
      state: 'PROCESSING', paymentMode: PAYMENT_MODES.CASH_ATM,
      merchantId: merchant.merchantId,
    });

    const refused = await supplyCashLink({
      merchantId: merchant.merchantId,
      merchant: { cashDenominationPaise: DENOM_PAISE },
      paymentLink: 'upi://pay?pa=atm@bank&am=5000',
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('ALREADY_SERVING');

    // And once that order is done they may go to a machine again — the guard is
    // about being busy, not a ban.
    await cancelState(orderId, { set: { cancelReason: 'TEST_CLEANUP', cancelledAt: new Date() } });
    const allowed = await supplyCashLink({
      merchantId: merchant.merchantId,
      merchant: { cashDenominationPaise: DENOM_PAISE },
      paymentLink: 'upi://pay?pa=atm@bank&am=5000',
    });
    expect(allowed.ok).toBe(true);
  });

  describe('retrying an order nobody served', () => {
    const expiredBuy = async (player) => {
      const orderId = oid();
      await createOrderRecord({
        orderId, userId: player.userId, type: 'DEPOSIT',
        tokenAmountRupees: DENOM_RUPEES, fiatAmountRupees: DENOM_RUPEES,
        state: 'PENDING_QUEUE', paymentMode: PAYMENT_MODES.CASH_ATM,
      });
      await cancelState(orderId, { set: { cancelReason: 'EXPIRED', cancelledAt: new Date() } });
      return orderId;
    };

    it('creates a NEW order that outranks a first attempt', async () => {
      const player = await actor({});
      const expired = await expiredBuy(player);

      const result = await retryOrder(player.userId, expired);
      const fresh = await getOrderRecord(result.order.orderId ?? result.order._id);

      expect(fresh.orderId).not.toBe(expired);
      expect(fresh.assignmentPriority).toBe(1);
      expect(fresh.retryOfOrderId).toBe(expired);
      // The original stays where it ended. Reviving it would mean letting any
      // cancelled order in the system come back to life.
      expect((await getOrderRecord(expired)).status).toBe('CANCELLED');
    });

    it('refuses a second retry while the first one is still live', async () => {
      const player = await actor({});
      const expired = await expiredBuy(player);
      await retryOrder(player.userId, expired);

      // Refused by the ONE-OPEN-BUY rule, before the unique index is reached —
      // which is the point of routing a retry through the ordinary creation
      // path. Every guard a first attempt passes, a retry passes too, because
      // it is the same function.
      await expect(retryOrder(player.userId, expired)).rejects.toThrow(/purchase in progress/i);
    });

    it('refuses a second retry even once the first is out of the way', async () => {
      const player = await actor({});
      const expired = await expiredBuy(player);
      const first = await retryOrder(player.userId, expired);
      const firstId = first.order.orderId ?? first.order._id;

      // Clear the open-buy rule out of the way, so what refuses the next
      // attempt is the UNIQUE index and nothing else. Without it, one expired
      // order could be retried again and again — a fresh live order each time,
      // and on a sell, the player's tokens locked again each time.
      await cancelState(firstId, { set: { cancelReason: 'TEST', cancelledAt: new Date() } });

      await expect(retryOrder(player.userId, expired)).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses to retry an order that was actually served', async () => {
      const player = await actor({});
      const orderId = oid();
      await createOrderRecord({
        orderId, userId: player.userId, type: 'DEPOSIT',
        tokenAmountRupees: DENOM_RUPEES, fiatAmountRupees: DENOM_RUPEES,
        state: 'PENDING_QUEUE', paymentMode: PAYMENT_MODES.CASH_ATM,
      });

      // Still live. "Try again" is not the right offer for an order that is
      // being worked — it would be a second order for money already in flight.
      await expect(retryOrder(player.userId, orderId)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
    });

    it('will not retry somebody else\'s order', async () => {
      const owner = await actor({});
      const stranger = await actor({});
      const expired = await expiredBuy(owner);
      await expect(retryOrder(stranger.userId, expired)).rejects.toMatchObject({ status: 403 });
    });
  });
});
