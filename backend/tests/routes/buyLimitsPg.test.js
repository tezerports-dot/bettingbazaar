// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a player is allowed to buy, proven on the SERVER.
 *
 * ── Why this suite exists at all ───────────────────────────────────────────
 * The player app ships as an Android build (`user-panel/capacitor.config.ts`),
 * and a Capacitor APK contains the entire JavaScript bundle. Anyone who unzips
 * one has the full API surface and can send whatever body they like. So every
 * assertion here is written from the attacker's position: not "the picker
 * offers four amounts" but "the server refuses the fifth".
 *
 * Before these rules existed, `createDepositOrder` accepted any amount that
 * passed min/max and multiples-of-ten. A hand-made request could buy ₹7,777 on
 * the cash rail, where a machine dispenses only 500, 1,000, 5,000 and 10,000 —
 * an order no member at an ATM could ever have served.
 *
 * ── Which rule applies is decided by the ORDER, not by a switch ─────────────
 * There is no platform-wide rail any more (PROJECT_STATUS §3.10, 2c). An INR
 * buy up to the cash ceiling (10,000 tokens) IS a cash buy and must be one of
 * the denominations; a larger one is a UPI/bank buy, bounded only by the
 * configured min and max. The gate and the order writer derive the rail with
 * the same function (`paymentModeFor`), so the rule a buy is judged by is the
 * rail it is born on — `railSnapshotPg` asserts the stamp.
 *
 * ── Driven through createDepositOrder, not the validator ───────────────────
 * The validator being correct proves nothing about whether the buy path calls
 * it. That distinction has already cost this branch two rounds — M97 and M98
 * both survived against assertions aimed at a layer nothing reached.
 *
 * Nobody is routed here: every team member in the database is put offline
 * first, so each buy stays queued and holds nothing. This suite is about
 * ADMISSION; who serves an admitted buy is `railSnapshotPg`'s question.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { createDepositOrder } from '../../domains/payment/paymentProcessing.service.js';
import { countOpenDeposits, getOrderRecord } from '#db/repositories/orders.record.js';
import { cancelOrder } from '#db/repositories/orders.core.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { BUY_DENOMINATIONS_PAISE, MAX_CASH_BUY_PAISE } from '../../domains/merchant/denominations.js';
import { teamFixture } from '../teamFixture.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('what a player is allowed to buy', () => {
  const teams = teamFixture();
  const orders = [];

  // `createDepositOrder` returns { order, note }. Unwrapped once here rather
  // than at each call site — reading the wrong level was what made an earlier
  // draft of this suite cancel an order id of `undefined` and then blame the
  // rule under test for the refusal that followed.
  const buy = async (userId, rupees) => {
    const { order } = await createDepositOrder(userId, rupees);
    orders.push(order.orderId);
    return order;
  };

  /** A player with no purchase in flight. */
  const freshPlayer = () => actor({});

  beforeAll(async () => {
    await applySchema();
    // Nobody online, so nothing an admitted buy could be held against.
    await teams.onlyOnline([]);
  }, 60_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await closePg();
  });

  // The lists themselves are asserted in merchantDenominationsPg; this is
  // whether the buy path ENFORCES them.
  describe('up to the cash ceiling: what a machine dispenses', () => {
    it('accepts every denomination the module declares', async () => {
      for (const paise of BUY_DENOMINATIONS_PAISE) {
        const player = await freshPlayer();
        const order = await buy(player.userId, paise / 100);
        expect(order.orderId).toBeTruthy();
        expect(order.tokenAmount).toBe(paise / 100);
      }
    });

    it('refuses an amount between the denominations, however well-formed, and writes nothing', async () => {
      const player = await freshPlayer();
      // Passes min/max and multiples-of-ten. Before this guard it was accepted.
      await expect(buy(player.userId, 7770)).rejects.toMatchObject({ code: 'NOT_A_DENOMINATION', status: 400 });
      // And the refusal says what they CAN do, not only what they did wrong (§25).
      await expect(buy(player.userId, 7770)).rejects.toThrow(/₹500, ₹1,000, ₹5,000, ₹10,000.*paid by UPI/);

      // Nothing was created — a refusal that leaves a row behind is not a
      // refusal, it is a half-opened order nobody will ever serve.
      const player2 = await freshPlayer();
      await expect(buy(player2.userId, 2000)).rejects.toMatchObject({ code: 'NOT_A_DENOMINATION' });
      expect(await countOpenDeposits(player2.userId)).toBe(0);
    });
  });

  describe('above the cash ceiling: UPI/bank, a range and not a ladder', () => {
    it('takes any amount in range one step past the ceiling, and beyond', async () => {
      // ₹10,000 is what a MACHINE dispenses. Above it there is no machine, and
      // refusing ₹12,000 for not being a cash note-run was a rule enforced
      // where it does not apply.
      for (const rupees of [MAX_CASH_BUY_PAISE / 100 + 10, 12_000, 40_000]) {
        const player = await freshPlayer();
        const order = await buy(player.userId, rupees);
        expect(order.tokenAmount).toBe(rupees);
        expect((await getOrderRecord(order.orderId)).status).toBe('PENDING_QUEUE');
      }
    });

    it('is still bounded by the configured maximum', async () => {
      // Read, not written: this suite does not change config (trap 10).
      const max = Number((await getSystemConfig())?.maxDeposit || 50_000); // schema default: 50000
      const player = await freshPlayer();
      await expect(buy(player.userId, max + 10)).rejects.toMatchObject({ status: 400 });
      expect(await countOpenDeposits(player.userId)).toBe(0);
    });
  });

  describe('one purchase at a time', () => {
    it('refuses a second purchase while one is in flight', async () => {
      const player = await freshPlayer();
      const first = await buy(player.userId, 1000);
      expect(first).toBeTruthy();

      await expect(buy(player.userId, 500)).rejects.toMatchObject({ code: 'BUY_ALREADY_OPEN', status: 409 });
    });

    it('counts across both INR rails — a cash buy in flight blocks a UPI one', async () => {
      // The rule is per CURRENCY, not per rail. A player who could hold a cash
      // buy and a UPI buy at once would occupy two members during a shortage,
      // which is the thing the rule exists to stop.
      const player = await freshPlayer();
      await buy(player.userId, 500);
      await expect(buy(player.userId, 20_000)).rejects.toMatchObject({ code: 'BUY_ALREADY_OPEN' });
    });

    it('lets them buy again once the first is finished', async () => {
      // The ceiling is about what a machine dispenses, not about limiting the
      // player — so a finished order must not keep blocking them.
      const player = await freshPlayer();
      const first = await buy(player.userId, 500);

      // Through the state machine — the one owner of a state change. An
      // earlier draft passed a second positional argument, which `transition`
      // ignores, so the order never left PENDING_QUEUE and the retry was
      // refused for a reason that had nothing to do with the rule.
      const moved = await cancelOrder({ orderId: first.orderId, reason: 'finished for the test' });
      expect(moved.ok).toBe(true);

      const second = await buy(player.userId, 500);
      expect(second).toBeTruthy();
    });
  });
});
