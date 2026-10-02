// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An order nobody served, and what happens next: the retry, and the queue that
 * serves it first.
 *
 * ── Why a retry goes first ─────────────────────────────────────────────────
 * An order that never found a merchant owes nothing. But sending that player to
 * the back of the queue that just failed them is how somebody waits twice and
 * gets nothing twice, so a retry outranks a first attempt — and the assertion
 * that matters is the one where a retry created LATER is served BEFORE an older
 * first-time order, because that is the whole rule.
 *
 * ── Who serves the queue now (PROJECT_STATUS §3.10, 2c) ─────────────────────
 * A member of a working team on the order's rail, through
 * `assignQueuedOrders` — the sweep that offers every queued order again, best
 * claim first. The cash-link matcher this suite was first written for (a
 * merchant supplied an ATM link and the matcher handed it to a waiting order)
 * is deleted with the link queue it served, and its cases went with it; the
 * concurrency-cap cases went with `paymentModePolicy.concurrencyCapFor` (the
 * per-rail cap is `SystemConfig.teamRouting.concurrency`, covered by
 * database/tests/teamRoutingPg.test.js).
 *
 * Here the queue is served by ONE cash member who presses Ready, with cap 1:
 * whichever order the sweep reaches first takes them, and the other waits. So
 * which order was served IS the order the sweep walked the queue in.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import {
  createOrderRecord, getOrderRecord, queuedOrdersForAssignment,
} from '#db/repositories/orders.record.js';
import { PAYMENT_MODES, setCashReady } from '#db/repositories/teamRouting.js';
import { getPool, releaseBuyHold } from '#db/repositories/teamPools.js';
import {
  retryOrder, createDepositOrder, cancelOrder, assignQueuedOrders,
} from '../../domains/payment/paymentProcessing.service.js';
import { cancelOrder as cancelState } from '../../domains/payment/orderLifecycle.service.js';
import { teamFixture } from '../teamFixture.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a retry, and the queue that serves it first', () => {
  const teams = teamFixture();
  let seq = 0;
  const oid = () => `rm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  /** ₹1,000 — a cash denomination, so every buy here is on the CASH rail. */
  const DENOM_RUPEES = 1000;

  // Every player and order this suite creates. An order left queued sits ahead
  // of the next test's and takes the member (trap 10); an order left ASSIGNED
  // keeps the member at their cap of one.
  const players = [];
  const created = [];
  let team;
  let member;

  const player = async () => {
    const p = await actor({});
    players.push(p.userId);
    return p;
  };
  const buy = async (p) => {
    const { order } = await createDepositOrder(p.userId, DENOM_RUPEES);
    const id = order.orderId ?? order._id;
    created.push(id);
    return id;
  };

  /**
   * The CASH orders another suite left queued AHEAD of `orderId`. The sweep is
   * global — it walks every queued order in the shared database — so one of
   * those would take this suite's member and the case would be asserting what
   * somebody else left behind. Said by name rather than failing as a mystery.
   */
  const cashAheadOf = async (orderId) => {
    const queue = await queuedOrdersForAssignment({ limit: 500 });
    const at = queue.findIndex((o) => o.orderId === orderId);
    expect(at, `${orderId} is not in the queue`).toBeGreaterThanOrEqual(0);
    return queue.slice(0, at)
      .filter((o) => o.paymentMode === PAYMENT_MODES.CASH_ATM && !created.includes(o.orderId))
      .map((o) => o.orderId);
  };

  beforeAll(async () => {
    await applySchema();
    // A working CASH team with a funded pool, and ONE member online. Ready is
    // off until a case presses it, so every buy created here waits in the queue.
    team = await teams.workingTeam({ rail: 'CASH', poolTokens: 10_000 });
    [member] = team.members;
    await teams.onlyOnline([member]);
    await setCashReady(member, false);
  }, 60_000);

  // What expiry does to an order nobody finished: it is cancelled and a buy's
  // pool hold goes back. Only this suite's own orders.
  afterEach(async () => {
    for (const orderId of created.splice(0)) {
      const row = await getOrderRecord(orderId);
      if (!['PENDING_QUEUE', 'ASSIGNED'].includes(row?.status)) continue;
      await cancelState(orderId, {
        expectFrom: ['PENDING_QUEUE', 'ASSIGNED'],
        set: { cancelReason: 'TEST_CLEANUP', cancelledAt: new Date() },
      }).catch(() => { /* already moved on; nothing to tidy */ });
      await releaseBuyHold(orderId, { actor: 'test-cleanup', reason: 'suite cleanup' });
    }
    await setCashReady(member, false);
  });

  afterAll(async () => {
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await pgQuery('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await teams.cleanup();
    await closePg();
  });

  it('serves a RETRY before an older first-time order', async () => {
    const first = await player();
    const retrier = await player();

    // The retrier's first attempt: nobody was free, and they gave up on it.
    const abandoned = await buy(retrier);
    expect((await getOrderRecord(abandoned)).status).toBe('PENDING_QUEUE');
    await cancelOrder(retrier.userId, false, abandoned);

    // The older order, created first. The retry comes AFTER it and ranks above.
    const older = await buy(first);
    const retry = await retryOrder(retrier.userId, abandoned);
    const retried = retry.order.orderId ?? retry.order._id;
    created.push(retried);
    expect((await getOrderRecord(older)).status).toBe('PENDING_QUEUE');
    expect((await getOrderRecord(retried)).status).toBe('PENDING_QUEUE');

    // The whole rule, in one line: later, and still first.
    const queue = (await queuedOrdersForAssignment({ limit: 500 })).map((o) => o.orderId);
    expect(queue.indexOf(retried)).toBeGreaterThanOrEqual(0);
    expect(queue.indexOf(retried)).toBeLessThan(queue.indexOf(older));
    expect(await cashAheadOf(retried), 'another suite left cash orders queued ahead of this one').toEqual([]);

    // The member reaches the machine, and the sweep runs once.
    const poolBefore = await getPool(team.teamId);
    expect((await setCashReady(member, true)).ok).toBe(true);
    await assignQueuedOrders();

    // One member, cap one: the retry takes them — the point, and the part that
    // feels unfair until you remember the retrier already waited once and got
    // nothing — and the older first-time order still waits.
    const served = await getOrderRecord(retried);
    expect(served.status).toBe('ASSIGNED');
    expect(served.merchantId).toBe(String(member));
    expect((await getOrderRecord(older)).status).toBe('PENDING_QUEUE');
    // And the buy is backed by the team's pool from the moment it is assigned.
    const poolAfter = await getPool(team.teamId);
    expect(poolAfter.heldPaise - poolBefore.heldPaise).toBe(DENOM_RUPEES * 100);
    expect(poolBefore.availablePaise - poolAfter.availablePaise).toBe(DENOM_RUPEES * 100);
  });

  it('keeps first-come-first-served WITHIN a rank', async () => {
    const a = await player();
    const b = await player();

    const earlier = await buy(a);
    await new Promise((r) => setTimeout(r, 15));
    const later = await buy(b);
    // Both first attempts, equal rank — so what separates them is age and
    // nothing else, which is the rule under test.

    const queue = (await queuedOrdersForAssignment({ limit: 500 })).map((o) => o.orderId);
    expect(queue.indexOf(earlier)).toBeGreaterThanOrEqual(0);
    expect(queue.indexOf(earlier)).toBeLessThan(queue.indexOf(later));
    expect(await cashAheadOf(earlier), 'another suite left cash orders queued ahead of this one').toEqual([]);

    expect((await setCashReady(member, true)).ok).toBe(true);
    await assignQueuedOrders();
    expect((await getOrderRecord(earlier)).status).toBe('ASSIGNED');
    expect((await getOrderRecord(later)).status).toBe('PENDING_QUEUE');
  });

  it('is safe to run twice — an order is assigned once, and its tokens held once', async () => {
    const p = await player();
    const orderId = await buy(p);
    expect(await cashAheadOf(orderId), 'another suite left cash orders queued ahead of this one').toEqual([]);

    const poolBefore = await getPool(team.teamId);
    expect((await setCashReady(member, true)).ok).toBe(true);
    // Two sweeps racing — two instances of the cron. The transition is guarded,
    // so one assigns and the other finds the order already moved.
    await Promise.all([assignQueuedOrders(), assignQueuedOrders()]);

    expect((await getOrderRecord(orderId)).status).toBe('ASSIGNED');
    const poolAfter = await getPool(team.teamId);
    expect(poolAfter.heldPaise - poolBefore.heldPaise).toBe(DENOM_RUPEES * 100);
    expect(poolBefore.availablePaise - poolAfter.availablePaise).toBe(DENOM_RUPEES * 100);
  });

  describe('retrying an order nobody served', () => {
    // Nobody online: what is under test is the retry itself, and an order a
    // team took at creation would answer the one-open-buy question differently.
    beforeAll(async () => { await teams.onlyOnline([]); });
    afterAll(async () => { await teams.onlyOnline([member]); });

    /** What `expireOrders` leaves: a buy nobody took, cancelled as EXPIRED. */
    const expiredBuy = async (p) => {
      const orderId = oid();
      await createOrderRecord({
        orderId, userId: p.userId, type: 'DEPOSIT',
        tokenAmountRupees: DENOM_RUPEES, fiatAmountRupees: DENOM_RUPEES,
        state: 'PENDING_QUEUE',
      });
      await cancelState(orderId, { set: { cancelReason: 'EXPIRED', cancelledAt: new Date() } });
      return orderId;
    };
    const retried = async (p, orderId) => {
      const result = await retryOrder(p.userId, orderId);
      const id = result.order.orderId ?? result.order._id;
      created.push(id);
      return id;
    };

    it('creates a NEW order that outranks a first attempt', async () => {
      const p = await player();
      const expired = await expiredBuy(p);

      const fresh = await getOrderRecord(await retried(p, expired));

      expect(fresh.orderId).not.toBe(expired);
      expect(fresh.assignmentPriority).toBe(1);
      expect(fresh.retryOfOrderId).toBe(expired);
      // The same rail the size names: a retry is an ordinary order.
      expect(fresh.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
      // The original stays where it ended. Reviving it would mean letting any
      // cancelled order in the system come back to life.
      expect((await getOrderRecord(expired)).status).toBe('CANCELLED');
    });

    it('refuses a second retry while the first one is still live', async () => {
      const p = await player();
      const expired = await expiredBuy(p);
      await retried(p, expired);

      // Refused by the ONE-OPEN-BUY rule, before the unique index is reached —
      // which is the point of routing a retry through the ordinary creation
      // path. Every guard a first attempt passes, a retry passes too, because
      // it is the same function.
      await expect(retryOrder(p.userId, expired)).rejects.toThrow(/purchase in progress/i);
    });

    it('refuses a second retry even once the first is out of the way', async () => {
      const p = await player();
      const expired = await expiredBuy(p);
      const firstId = await retried(p, expired);

      // Clear the open-buy rule out of the way, so what refuses the next
      // attempt is the UNIQUE index and nothing else. Without it, one expired
      // order could be retried again and again — a fresh live order each time,
      // and on a sell, the player's tokens locked again each time.
      await cancelState(firstId, { set: { cancelReason: 'TEST', cancelledAt: new Date() } });

      await expect(retryOrder(p.userId, expired)).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses to retry an order that was actually served', async () => {
      const p = await player();
      const orderId = oid();
      await createOrderRecord({
        orderId, userId: p.userId, type: 'DEPOSIT',
        tokenAmountRupees: DENOM_RUPEES, fiatAmountRupees: DENOM_RUPEES,
        state: 'PENDING_QUEUE',
      });
      created.push(orderId);

      // Still live. "Try again" is not the right offer for an order that is
      // being worked — it would be a second order for money already in flight.
      await expect(retryOrder(p.userId, orderId)).rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
    });

    it('will not retry somebody else\'s order', async () => {
      const owner = await player();
      const stranger = await player();
      const expired = await expiredBuy(owner);
      await expect(retryOrder(stranger.userId, expired)).rejects.toMatchObject({ status: 403 });
    });
  });
});
