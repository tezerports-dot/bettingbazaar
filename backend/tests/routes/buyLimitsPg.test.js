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
 * a rail where a cash machine dispenses only 500, 1,000, 5,000 and 10,000 —
 * an order no merchant could ever have served.
 *
 * ── Driven through createDepositOrder, not the validator ───────────────────
 * The validator being correct proves nothing about whether the buy path calls
 * it. That distinction has already cost this branch two rounds — M97 and M98
 * both survived against assertions aimed at a layer nothing reached.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createDepositOrder } from '../../domains/payment/paymentProcessing.service.js';
import { countOpenDeposits } from '#db/repositories/orders.record.js';
import { cancelOrder } from '#db/repositories/orders.core.js';
import {
  PAYMENT_MODES, getActivePolicy, publishPolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
import { BUY_DENOMINATIONS_PAISE, MAX_CASH_BUY_PAISE } from '../../domains/merchant/denominations.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('what a player is allowed to buy', () => {
  let restore = null;

  // `createDepositOrder` returns { order, note }. Unwrapped once here rather
  // than at each call site — reading the wrong level was what made an earlier
  // draft of this suite cancel an order id of `undefined` and then blame the
  // rule under test for the refusal that followed.
  const buy = async (userId, rupees) => (await createDepositOrder(userId, rupees)).order;

  /** A player with no purchase in flight. */
  const freshPlayer = () => actor({ kycStatus: 'APPROVED' });

  beforeAll(async () => {
    await applySchema();
    restore = await getActivePolicy();
  }, 60_000);

  afterAll(async () => {
    if (restore && (await getActivePolicy()).activeMode !== restore.activeMode) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        justification: 'Restoring the rail this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    await closePg();
  });

  describe('on the ATM cash rail', () => {
    beforeAll(async () => {
      await publishPolicyVersion({
        activeMode: PAYMENT_MODES.CASH_ATM,
        justification: 'Buy-limits suite.', changedByName: 'test setup',
      });
    });

    it('accepts every denomination the module declares', async () => {
      for (const paise of BUY_DENOMINATIONS_PAISE) {
        const player = await freshPlayer();
        const order = await buy(player.userId, paise / 100);
        expect(order.orderId).toBeTruthy();
        expect(order.tokenAmount).toBe(paise / 100);
      }
    });

    it('refuses an amount between the denominations, however well-formed', async () => {
      const player = await freshPlayer();
      // Passes min/max and multiples-of-ten. Before this guard it was accepted.
      await expect(buy(player.userId, 7770)).rejects.toMatchObject({ code: 'NOT_A_DENOMINATION' });

      // And nothing was created — a refusal that leaves a row behind is not a
      // refusal, it is a half-opened order nobody will ever serve.
      const player2 = await freshPlayer();
      await expect(buy(player2.userId, 2000)).rejects.toMatchObject({ code: 'NOT_A_DENOMINATION' });
      expect(await countOpenDeposits(player2.userId)).toBe(0);
    });

    it('refuses the withdrawal-only tier as a purchase', async () => {
      // ₹40,000 is a real denomination — it is in the ladder a split uses — so
      // a check that merely asked "is this a denomination" would let it
      // through. No buy is ever that large.
      const player = await freshPlayer();
      await expect(buy(player.userId, 40_000)).rejects.toMatchObject({ code: 'CASH_BUY_CEILING' });
    });
  });

  describe('on the UPI rail', () => {
    beforeAll(async () => {
      await publishPolicyVersion({
        activeMode: PAYMENT_MODES.P2P_UPI,
        justification: 'Buy-limits suite, UPI leg.', changedByName: 'test setup',
      });
    });

    it('allows an amount inside the range, because UPI is a range not a ladder', async () => {
      // The denomination rule is a property of cash machines, not of the
      // platform. Applying it here would break the rail that is live today.
      const player = await freshPlayer();
      const order = await buy(player.userId, 2500);
      expect(order).toBeTruthy();
    });

    it('does NOT apply the cash ceiling on the UPI rail', async () => {
      // ₹10,000 is what a MACHINE dispenses. On the UPI rail there is no
      // machine and nothing to dispense, and this used to refuse ₹12,000 there
      // — a rule enforced somewhere it does not apply. The bound on this rail
      // is the configured max deposit, like any other purchase.
      const player = await freshPlayer();
      const order = await buy(player.userId, MAX_CASH_BUY_PAISE / 100 + 2_000);
      expect(order).toBeTruthy();
    });
  });

  describe('one purchase at a time', () => {
    beforeAll(async () => {
      await publishPolicyVersion({
        activeMode: PAYMENT_MODES.CASH_ATM,
        justification: 'Buy-limits suite, concurrency leg.', changedByName: 'test setup',
      });
    });

    it('refuses a second purchase while one is in flight', async () => {
      const player = await freshPlayer();
      const first = await buy(player.userId, 1000);
      expect(first).toBeTruthy();

      await expect(buy(player.userId, 500)).rejects.toMatchObject({ code: 'BUY_ALREADY_OPEN' });
    });

    it('lets them buy again once the first is finished', async () => {
      // The ceiling is about what a machine dispenses, not about limiting the
      // player — so a finished order must not keep blocking them.
      const player = await freshPlayer();
      const first = await buy(player.userId, 500);
      const orderId = first.orderId;

      // Through the state machine — the one owner of a state change. An
      // earlier draft passed a second positional argument, which `transition`
      // ignores, so the order never left PENDING_QUEUE and the retry was
      // refused for a reason that had nothing to do with the rule.
      const moved = await cancelOrder({ orderId, reason: 'finished for the test' });
      expect(moved.ok).toBe(true);

      const second = await buy(player.userId, 500);
      expect(second).toBeTruthy();
    });
  });
});
