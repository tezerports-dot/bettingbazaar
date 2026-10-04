// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a merchant refusing orders costs them, and who the order goes to next.
 *
 * ── The two rules ───────────────────────────────────────────────────────────
 * 1. THREE CONSECUTIVE rejections and the merchant is suspended. Consecutive,
 *    not lifetime: any completed order resets the streak, so an ordinary
 *    merchant who occasionally declines never approaches it. A lifetime
 *    allowance of three would catch every honest merchant eventually, which is
 *    the failure mode that makes an operator switch a control off.
 * 2. A merchant who refuses an order never sees it again, and never sees
 *    another order from that PLAYER. Without the first half the reject route
 *    requeues and immediately reassigns, and can hand the order straight back
 *    to the merchant who just declined.
 *
 * ── Why the record is a table ───────────────────────────────────────────────
 * `order_states.rejected_by` is one column and is overwritten, so once a second
 * merchant declines the same order the first has vanished. Neither rule can be
 * answered from the order; both are answered from `order_rejections`.
 *
 * ── On the team model (PROJECT_STATUS §3.10, Step 2c) ────────────────────────
 * An order reaches a member by being ROUTED to them, so every order here is
 * made that way (§32 S16): a buy created queued with its split and offered by
 * `tryAssignMerchant` to the one online member of a working UPI team — the
 * pool HOLDS its tokens — and a sell through the player's own admission,
 * which locks the stake and routes it. "Is this member a candidate" is asked
 * of the router itself (`routingCandidates`), which replaced the deleted
 * `assignmentCandidates`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import {
  createOrderRecord, getOrderRecord, merchantsBarredFrom, setOrderFields,
} from '#db/repositories/orders.record.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { updateUser } from '#db/repositories/users.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { routingCandidates, routingSettings } from '#db/repositories/teamRouting.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  expireOrders, tryAssignMerchant, markOrderPaid, createWithdrawalOrder, cancelOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// Above the cash ceiling: the UPI_BANK rail, so no Ready press is involved.
const TOKENS = 50_000;

describePg('a merchant who keeps refusing', () => {
  let app;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const teams = teamFixture();
  const players = [];

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await c.query('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    });
    await teams.cleanup();
    await closePg();
  });

  const player = async () => {
    const who = await actor({});
    players.push(who.userId);
    return who;
  };

  // Members come in tens — a team works only at ten (2a) — and each test
  // takes ones nobody has used, so no earlier refusal or open order is theirs.
  const bench = [];
  const member = async () => {
    if (!bench.length) {
      const ms = [];
      for (let i = 0; i < 10; i += 1) ms.push(await merchantActor());
      const team = await teams.workingTeam({
        rail: 'UPI_BANK', poolTokens: 1_000_000, include: ms.map((m) => m.merchantId),
      });
      bench.push(...ms.map((m) => ({ ...m, team })));
    }
    return bench.shift();
  };

  /** A buy, queued as `createDepositOrder` writes it and offered with only `to` online. */
  const queuedBuy = async (to, owner = null) => {
    seq += 1;
    const who = owner || await player();
    const orderId = `REJ-${RUN}-${seq}`;
    const order = await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: TOKENS, fiatAmountRupees: TOKENS,
      depositAllocation: 45_000, reserveAllocation: 5_000,
    });
    await teams.onlyOnline(to ? [to.merchantId] : []);
    const routed = await tryAssignMerchant(order);
    return { orderId, who, routed };
  };

  /** An ASSIGNED buy this member can decline — routed to them. */
  const assigned = async (m, owner = null) => {
    const b = await queuedBuy(m, owner);
    expect(b.routed, `the buy was not routed to ${m.merchantId}`).toBe(true);
    expect((await getOrderRecord(b.orderId)).merchantId).toBe(String(m.merchantId));
    return b;
  };

  /**
   * An ASSIGNED **sell** this member is expected to pay out — through the
   * player's own admission, which locks the stake and routes it.
   *
   * The direction matters to the cap now: a sell that lapses is the merchant
   * failing to pay the player, which is theirs; a buy that lapses is the player
   * failing to pay, which is not.
   */
  const assignedSell = async (m) => {
    const who = await player();
    await updateUser(who.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    seq += 1;
    await creditWinnings(who.userId, TOKENS, 'rejection cap suite float', 'Test',
      `seed_${who.userId}`, `rej_seed_${who.userId}_${seq}`);
    await teams.onlyOnline([m.merchantId]);
    const { order } = await createWithdrawalOrder(who.userId, TOKENS);
    const orderId = order.orderId ?? order._id;
    const row = await getOrderRecord(orderId);
    expect(row.state, 'the sell was not routed').toBe('ASSIGNED');
    expect(row.merchantId).toBe(String(m.merchantId));
    return { orderId, who };
  };

  const reject = (m, orderId, reason = 'Cannot serve this right now') =>
    as(app, m).post(`/reject/${orderId}`).send({ reason });

  /**
   * Is this member a candidate for a buy — or a sell — right now? Asked of the
   * router with only them online, so the answer is about THEM: a member who is
   * offline is never a candidate, and "the exclusion removed them" would pass
   * against a list they were never in.
   */
  const isCandidate = async (m, { type = 'DEPOSIT', barredMerchantIds = [] } = {}) => {
    await teams.onlyOnline([m.merchantId]);
    const probe = { orderId: `probe-${RUN}`, type, currency: 'INR', tokenAmountPaise: TOKENS * 100 };
    const { concurrency } = routingSettings(await getSystemConfig());
    const rows = await routingCandidates(probe, { cap: concurrency.UPI_BANK, barredMerchantIds, limit: 500 });
    return rows.some((c) => c.merchantId === String(m.merchantId));
  };

  describe('the cap', () => {
    it('suspends on the THIRD consecutive rejection, and not before', async () => {
      const m = await member();

      for (const n of [1, 2]) {
        const { orderId } = await assigned(m);
        expect((await reject(m, orderId)).status, `reject ${n}`).toBe(200);
        const row = await getMerchant(m.merchantId);
        expect(row.consecutiveRejections ?? n, `streak after ${n}`).toBe(n);
        expect(row.status, `suspended too early, after ${n}`).toBe('ACTIVE');
      }

      const third = await assigned(m);
      expect((await reject(m, third.orderId)).status).toBe(200);
      expect((await getMerchant(m.merchantId)).status).toBe('SUSPENDED');
    });

    it('a suspended merchant is no longer a candidate for anything', async () => {
      // Suspension is a refusal to ASSIGN, not a deletion — the merchant keeps
      // the orders they already hold, because taking those away would strand
      // players who are mid-payment on them.
      const m = await member();
      expect(await isCandidate(m), 'not a candidate even before rejecting').toBe(true);
      expect(await isCandidate(m, { type: 'WITHDRAWAL' })).toBe(true);

      for (let i = 0; i < 3; i += 1) {
        const { orderId } = await assigned(m);
        expect((await reject(m, orderId)).status).toBe(200);
      }
      expect((await getMerchant(m.merchantId)).status).toBe('SUSPENDED');
      expect(await isCandidate(m)).toBe(false);
      expect(await isCandidate(m, { type: 'WITHDRAWAL' })).toBe(false);
    });

    it('a COMPLETED order resets the streak, so the cap is consecutive not lifetime', async () => {
      const m = await member();
      const { orderId: a } = await assigned(m);
      const { orderId: b } = await assigned(m);
      await reject(m, a);
      await reject(m, b);
      expect((await getMerchant(m.merchantId)).consecutiveRejections).toBe(2);

      // A buy they DO serve: routed, paid by the player, confirmed.
      const served = await assigned(m);
      const utr = String(530000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));
      await readyToPay(served.orderId);
      expect((await markOrderPaid(served.who.userId, served.orderId, utr)).status).toBe('PAID');
      const confirmed = await as(app, m).post(`/confirm/${served.orderId}`);
      expect(confirmed.status, confirmed.body.message).toBe(200);
      expect((await getOrderRecord(served.orderId)).state).toBe('COMPLETED');

      expect((await getMerchant(m.merchantId)).consecutiveRejections).toBe(0);

      // And a third rejection AFTER the reset is only the first of a new run.
      const { orderId: c } = await assigned(m);
      await reject(m, c);
      const row = await getMerchant(m.merchantId);
      expect(row.consecutiveRejections).toBe(1);
      expect(row.status).toBe('ACTIVE');
    });
  });

  describe('an EXPIRED SELL counts exactly the same as pressing reject', () => {
    /**
     * The hole the first version of this cap had, and the over-correction that
     * followed it.
     *
     * A merchant who never presses reject and simply lets the window close has
     * refused the order in every way that matters — and the streak did not
     * move, so they refused without limit. Counting only the button penalises
     * the merchant who tells you. That was the hole, and it was closed.
     *
     * Closing it by counting EVERY expiry then charged the wrong party. A BUY
     * order expires at ASSIGNED or PROCESSING because **the player never
     * paid** — the merchant was standing by, did nothing wrong, and took a
     * strike for it. Three players who changed their minds and an honest
     * merchant was suspended.
     *
     * So the direction decides. These cases are all SELL orders, where the
     * merchant had the order and did not pay the player. The buy side is in
     * `playerPaymentFailurePg.test.js`, which asserts the opposite: the streak
     * must NOT move.
     */
    const expired = async (m) => {
      const { orderId, who } = await assignedSell(m);
      // The window closing. Assignment set the deadline from the rail's own
      // window; it is moved into the past rather than waited for.
      await setOrderFields(orderId, { expiresAt: new Date(Date.now() - 60 * 1000) });
      return { orderId, who };
    };

    it('advances the streak', async () => {
      const m = await member();
      await expired(m);
      await expireOrders();
      expect((await getMerchant(m.merchantId)).consecutiveRejections).toBe(1);
    });

    it('bars the pair, so the order cannot come back to them', async () => {
      const m = await member();
      const { orderId, who } = await expired(m);
      await expireOrders();

      const barred = await merchantsBarredFrom({ orderId, userId: who.userId });
      expect(barred, 'an expiry left the merchant eligible for the same order').toContain(m.merchantId);
    });

    it('reaches the cap by expiry ALONE — the bypass is closed', async () => {
      // Three lapses, no button ever pressed.
      const m = await member();
      for (let i = 0; i < 3; i += 1) {
        await expired(m);
        await expireOrders();
      }
      expect((await getMerchant(m.merchantId)).status).toBe('SUSPENDED');
    });

    it('MIXES with rejections, because they are the same event', async () => {
      // Two lapses and one decline is still three refusals in a row. A cap that
      // counted them in separate buckets would let a merchant alternate and
      // never reach either.
      const m = await member();
      await expired(m);
      await expireOrders();
      await expired(m);
      await expireOrders();
      expect((await getMerchant(m.merchantId)).status).toBe('ACTIVE');

      const third = await assigned(m);
      await reject(m, third.orderId);
      expect((await getMerchant(m.merchantId)).status).toBe('SUSPENDED');
    });

    it('an order nobody held does not blame anybody', async () => {
      // PENDING_QUEUE orders reach the same sweep and have no merchant. A
      // refusal recorded against a null merchant would be a row nothing can
      // read, and a streak advanced on nobody.
      //
      // A buy nobody was free for. What makes it due in production is the
      // assignment wait counted from `created_at`, which is append-only, so the
      // deadline is put in the past instead.
      const { orderId, routed } = await queuedBuy(null);
      expect(routed).toBe(false);
      await setOrderFields(orderId, { expiresAt: new Date(Date.now() - 60 * 1000) });

      await expect(expireOrders()).resolves.toBeGreaterThanOrEqual(0);
      expect((await getOrderRecord(orderId)).state).toBe('CANCELLED');
      expect(await merchantsBarredFrom({ orderId })).toHaveLength(0);
    });
  });

  describe('who the order goes to next', () => {
    it('records the refusal against the order AND the player', async () => {
      const m = await member();
      const { orderId, who } = await assigned(m);
      await reject(m, orderId);

      const { rows } = await pgQuery(
        'SELECT merchant_id, user_id FROM order_rejections WHERE order_id = $1', [orderId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].merchant_id).toBe(m.merchantId);
      expect(rows[0].user_id).toBe(who.userId);
    });

    it('bars that merchant from THIS order', async () => {
      const m = await member();
      const { orderId } = await assigned(m);
      await reject(m, orderId);

      expect(await merchantsBarredFrom({ orderId })).toContain(m.merchantId);
      // And the order really was requeued rather than left with them — the
      // decline's own re-offer ran with them still online, and passed them over.
      const row = await getOrderRecord(orderId);
      expect(row.state).toBe('PENDING_QUEUE');
      expect(row.merchantId ?? null).not.toBe(m.merchantId);
      expect(await tryAssignMerchant(row), 'the declined order went straight back to them').toBe(false);
    });

    it('bars that merchant from the same PLAYER\'s other orders too', async () => {
      // The order they refused is not the only one they should stop seeing.
      // The player holds one open buy at a time, so they cancel the declined
      // one (it is back in the queue) before buying again.
      const m = await member();
      const who = await player();
      const first = await assigned(m, who);
      await reject(m, first.orderId);
      await cancelOrder(who.userId, false, first.orderId);

      const second = await queuedBuy(m, who);
      const barred = await merchantsBarredFrom({ orderId: second.orderId, userId: who.userId });
      expect(barred, 'a refusal on one order did not bar the pair').toContain(m.merchantId);
      expect(second.routed, 'the router handed the player straight back to them').toBe(false);
    });

    it('leaves a DIFFERENT player untouched', async () => {
      // The bar is a pair, not a blacklist. A merchant who declined one
      // person's order must still serve everybody else.
      const m = await member();
      const declined = await player();
      const other = await player();
      const { orderId } = await assigned(m, declined);
      await reject(m, orderId);

      const barred = await merchantsBarredFrom({ orderId: null, userId: other.userId });
      expect(barred).not.toContain(m.merchantId);
      expect((await queuedBuy(m, other)).routed, 'the bar reached a different player').toBe(true);
    });

    it('the exclusion is applied by the QUERY, not left to the caller', async () => {
      const m = await member();
      expect(await isCandidate(m)).toBe(true);
      expect(await isCandidate(m, { barredMerchantIds: [m.merchantId] })).toBe(false);
    });

    it('an empty bar list changes nothing', async () => {
      // The ordinary case must cost nothing and must not accidentally exclude
      // everybody — an `<> ALL('{}')` that was built wrong would.
      const m = await member();
      expect(await isCandidate(m, { barredMerchantIds: [] })).toBe(true);
    });
  });
});
