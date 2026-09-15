// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a merchant can take on is what they HOLD minus what they have PROMISED.
 *
 * ── The gap (F-018) ─────────────────────────────────────────────────────────
 * Every eligibility gate on the buy side asked `getAvailablePaiseFor` — the
 * wallet's available pocket, and nothing else. A merchant holding 10,000 tokens
 * who had just accepted an 8,000 buy order still read as 10,000, so the next
 * order was assigned to them too. Both players paid. One of them was never
 * going to be credited, and found out only at the end.
 *
 * The platform DOES escrow, but only in one direction: `lockWithdrawal` holds a
 * PLAYER's tokens the instant they place a SELL, so they cannot spend or
 * re-sell what is already promised. Every one of the twenty-one escrow call
 * sites is guarded by `order.type === 'WITHDRAWAL'`. There has never been a
 * counterpart on the BUY side, where the tokens at risk are the merchant's.
 *
 * ── What these tests hold to ────────────────────────────────────────────────
 * The commitment is DERIVED from `order_states`, not written into a reserved
 * pocket, so there is nothing to release and nothing to strand (see the note on
 * `getSpendablePaiseFor`). These tests therefore assert the derivation directly
 * AND through each gate that consumes it — a number that is right in the
 * repository and unread by the route it protects is worth nothing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { updateMerchant, assignmentCandidates } from '#db/repositories/merchants.js';
import {
  getAvailablePaiseFor, getSpendablePaiseFor,
} from '#db/repositories/merchantWallets.core.js';
import { getMerchantSpendableTokens } from '#db/repositories/merchantWallets.js';
import { selectBestMerchant } from '../../domains/merchant/merchantScoring.service.js';
import { actor, merchantActor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a merchant can only take on what they have not already promised', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });

  /**
   * A merchant the candidate query will actually return.
   *
   * `merchantActor` leaves `is_online` at its schema default of FALSE, so a
   * merchant from it is never a candidate at all — and "the filter excluded
   * them" would pass against a list they had never been in.
   */
  const made = [];
  const onlineMerchant = async (tokensRupees) => {
    const m = await merchantActor({ tokensRupees });
    await updateMerchant(m.merchantId, {
      isOnline: true, acceptsDeposits: true, acceptsWithdrawals: true,
      maxConcurrentDepositOrders: 10, maxConcurrentWithdrawalOrders: 10,
    });
    made.push(m.merchantId);
    return m;
  };

  /**
   * Every merchant this suite makes goes OFFLINE after the test that made it.
   *
   * They carry a raised `maxOrder` and a large balance, which makes them the
   * most attractive candidates in the whole shared database — and they were
   * being left online for good. Another suite's assignment test, running in
   * parallel, had ITS order taken by one of these and failed on roughly one run
   * in three with an id it had never heard of. Trap 10: a fixture left running
   * is shared state as surely as a row.
   */
  afterEach(async () => {
    for (const id of made.splice(0)) {
      await updateMerchant(id, { isOnline: false }).catch(() => {});
    }
  });

  /** A buy order sitting in `state`, held by `merchantId`. */
  const buyOrder = async (merchantId, tokensRupees, state = 'ASSIGNED', owner = null) => {
    seq += 1;
    const who = owner || await actor({});
    const orderId = `SPEND-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokensRupees, fiatAmountRupees: tokensRupees, state,
      depositAllocation: tokensRupees, reserveAllocation: 0, merchantId,
    });
    return orderId;
  };

  const spendableOf = async (merchantId) =>
    (await getSpendablePaiseFor([merchantId])).get(String(merchantId));

  describe('the derivation', () => {
    it('subtracts an open buy order from what the merchant may take next', async () => {
      const m = await onlineMerchant(10_000);
      // Before: nothing promised, so both readers agree.
      expect((await getAvailablePaiseFor([m.merchantId])).get(m.merchantId)).toBe(1_000_000);
      expect((await spendableOf(m.merchantId)).spendable).toBe(1_000_000);

      await buyOrder(m.merchantId, 8_000);

      // The wallet has not moved — the tokens are still there, and that is
      // exactly why the raw pocket cannot answer this question.
      expect(
        (await getAvailablePaiseFor([m.merchantId])).get(m.merchantId),
        'the wallet column moved; this test is no longer about the derivation',
      ).toBe(1_000_000);

      const row = await spendableOf(m.merchantId);
      expect(row.available).toBe(1_000_000);
      expect(row.committed).toBe(800_000);
      expect(row.spendable).toBe(200_000);
    });

    /**
     * Walked through the LIFECYCLE, not written into the column.
     *
     * `setOrderFields` refuses a state change by design (§21), and rightly: a
     * row placed directly into a terminal state proves the enum accepts the
     * string and proves nothing about the transitions that actually produce it.
     * `ALLOWED_FROM` is the rule, so the test obeys it.
     */
    const walk = async (orderId, path) => {
      const core = await import('#db/repositories/orders.core.js');
      const step = {
        PROCESSING: core.startOrder, PAID: core.markPaid, COMPLETED: core.completeOrder,
        DISPUTED: core.disputeOrder, CANCELLED: core.cancelOrder,
        FAILED: core.failOrder, REJECTED: core.rejectOrder,
      };
      for (const to of path) {
        const res = await step[to]({ orderId, actor: 'test', reason: 'spendable matrix' });
        expect(res.ok, `${orderId} could not reach ${to}: ${res.reason}`).toBe(true);
      }
    };

    it.each([
      [['PROCESSING'],                     true,  'the merchant has taken it and owes the tokens'],
      [['PAID'],                           true,  'the player has paid; the tokens are still the merchant\'s to hand over'],
      [['PAID', 'COMPLETED'],              false, 'the tokens have left the wallet already'],
      [['REJECTED'],                       false, 'refused, so nothing is owed'],
      [['CANCELLED'],                      false, 'abandoned, so nothing is owed'],
      [['FAILED'],                         false, 'failed, so nothing is owed'],
      // Disputed with the tokens NOT yet handed over: the obligation is live,
      // because a resolution in the player's favour still takes them.
      [['PAID', 'DISPUTED'],               true,  'disputed before the debit'],
    ])('%s → committed=%s (%s)', async (path, counted) => {
      const m = await onlineMerchant(10_000);
      const orderId = await buyOrder(m.merchantId, 5_000);
      await walk(orderId, path);
      expect((await spendableOf(m.merchantId)).committed).toBe(counted ? 500_000 : 0);
    });

    /**
     * The pair the STATE cannot tell apart.
     *
     * A dispute raised from PAID and one raised from COMPLETED put the same
     * string in the same column, and the answers are opposite. What separates
     * them is whether the tokens have actually left the wallet — so these two
     * go through the real debit rather than the lifecycle alone, because the
     * ledger entry IS the discriminator and a test that skipped it would be
     * asserting against a fact the production path writes and the test does not.
     */
    describe('a dispute, on both sides of the debit', () => {
      const disputedAfterDebit = async ({ reverse }) => {
        const m = await onlineMerchant(10_000);
        const orderId = await buyOrder(m.merchantId, 5_000);
        await walk(orderId, ['PAID']);

        // The real key the deposit path uses, through the one owner of merchant
        // balance mutations. Naming it here rather than inventing a test key is
        // the point: a different key would write a row this query does not find.
        const { debitMerchantTokens, creditMerchantTokens } =
          await import('#db/repositories/merchantWallets.js');
        await debitMerchantTokens({
          merchantId: m.merchantId, amount: 5_000,
          reason: `Deposit ${orderId} confirmed — tokens dispensed to user`,
          refModel: 'PaymentOrder', refId: orderId,
          txId: `mw_dep_deduct_${orderId}`,
        });
        await walk(orderId, ['COMPLETED', 'DISPUTED']);

        if (reverse) {
          await creditMerchantTokens({
            merchantId: m.merchantId, amount: 5_000,
            reason: `Deposit ${orderId} reversed — dispute resolved for the merchant`,
            refModel: 'PaymentOrder', refId: orderId,
            txId: `mw_dep_reverse_${orderId}`,
          });
        }
        return spendableOf(m.merchantId);
      };

      it('disputed AFTER the debit is not counted — the tokens are already gone', async () => {
        const row = await disputedAfterDebit({ reverse: false });
        expect(row.available, 'the debit did not happen; this test proves nothing').toBe(500_000);
        expect(row.committed).toBe(0);
        expect(row.spendable).toBe(500_000);
      });

      it('a REVERSED debit restores the obligation as well as the tokens', async () => {
        // Both halves move together, so the merchant is neither given credit
        // for tokens they got back nor charged twice for one order.
        const row = await disputedAfterDebit({ reverse: true });
        expect(row.available).toBe(1_000_000);
        expect(row.committed).toBe(500_000);
        expect(row.spendable).toBe(500_000);
      });
    });

    it('an ASSIGNED order is committed from the moment it is handed over', async () => {
      const m = await onlineMerchant(10_000);
      await buyOrder(m.merchantId, 5_000);
      expect((await spendableOf(m.merchantId)).committed).toBe(500_000);
    });

    it('does not count a SELL order — those tokens are the player\'s, not the merchant\'s', async () => {
      const m = await onlineMerchant(10_000);
      seq += 1;
      const who = await actor({});
      await createOrderRecord({
        orderId: `SPEND-${RUN}-w${seq}`, userId: who.userId, type: 'WITHDRAWAL',
        tokenAmountRupees: 8_000, fiatAmountRupees: 8_000, state: 'ASSIGNED',
        merchantId: m.merchantId,
      });
      // A sell order MOVES TOKENS TOWARD the merchant. Subtracting it would
      // shrink their capacity for doing the very work that refills them.
      expect((await spendableOf(m.merchantId)).committed).toBe(0);
      expect((await spendableOf(m.merchantId)).spendable).toBe(1_000_000);
    });

    it('another merchant\'s order is not charged to this one', async () => {
      const mine = await onlineMerchant(10_000);
      const theirs = await onlineMerchant(10_000);
      await buyOrder(theirs.merchantId, 9_000);
      expect((await spendableOf(mine.merchantId)).committed).toBe(0);
      expect((await spendableOf(theirs.merchantId)).committed).toBe(900_000);
    });

    it('floors at zero — commitments beyond the balance are not a credit line', async () => {
      const m = await onlineMerchant(1_000);
      await buyOrder(m.merchantId, 900);
      await buyOrder(m.merchantId, 900);
      const row = await spendableOf(m.merchantId);
      expect(row.available - row.committed).toBeLessThan(0);
      expect(row.spendable).toBe(0);
    });

    it('excludeOrderId keeps one order from being charged against itself', async () => {
      const m = await onlineMerchant(10_000);
      const orderId = await buyOrder(m.merchantId, 10_000);
      // Counted, the merchant cannot fund the very order they are holding.
      expect((await spendableOf(m.merchantId)).spendable).toBe(0);
      // Excluded, the question "can you fund THIS one" has the right answer.
      const excluded = (await getSpendablePaiseFor([m.merchantId], { excludeOrderId: orderId }))
        .get(m.merchantId);
      expect(excluded.committed).toBe(0);
      expect(excluded.spendable).toBe(1_000_000);
    });

    it('a merchant with no wallet row reads as nothing, not as unknown-so-allow', async () => {
      expect((await getSpendablePaiseFor(['nobody-at-all'])).size).toBe(0);
      expect(await getMerchantSpendableTokens('nobody-at-all')).toBe(0);
    });
  });

  describe('the scenario, through auto-assignment', () => {
    /**
     * Scoped to the merchants this test made.
     *
     * The suite shares one database, so `selectBestMerchant` over every
     * candidate is a question about every other test's merchants as well — and
     * an assertion on the winner would be asserting a global invariant over a
     * shared table (trap 10). Barring everyone else makes the comparison be
     * between the two merchants the test is actually about.
     */
    const pickAmong = async (amount, allow) => {
      const allowed = new Set(allow.map(String));
      const everyone = await assignmentCandidates({
        currency: 'INR', direction: 'DEPOSIT', limit: 5000,
      });
      const barred = everyone.map((c) => String(c.merchantId)).filter((id) => !allowed.has(id));
      return selectBestMerchant('DEPOSIT', amount, 'INR', { barredMerchantIds: barred });
    };

    /**
     * The user's own example. A merchant holding 10,000 tokens is the biggest
     * holder, so the 8,000 order goes to them — correctly. The question is what
     * happens to the NEXT order.
     */
    it('the biggest holder wins the biggest order, then cannot be given a second they cannot cover', async () => {
      const big = await onlineMerchant(10_000);
      const small = await onlineMerchant(3_000);
      const both = [big.merchantId, small.merchantId];

      expect((await pickAmong(8_000, both))?.merchantId, 'the 10,000 holder should take the 8,000 order')
        .toBe(big.merchantId);

      await buyOrder(big.merchantId, 8_000);

      // 2,000 uncommitted at `big`, 3,000 at `small`. A 5,000 order fits
      // neither, and must not be handed to the merchant who merely LOOKS like
      // they hold enough.
      expect(await pickAmong(5_000, both), 'assigned an order the merchant cannot fund').toBeNull();

      // A 3,000 order fits `small` alone, and goes there rather than to the
      // bigger holder whose tokens are spoken for.
      expect((await pickAmong(3_000, both))?.merchantId).toBe(small.merchantId);

      // And one that fits the remainder may still come to `big`.
      expect((await pickAmong(2_000, [big.merchantId]))?.merchantId).toBe(big.merchantId);
    });

    it('ranks on the remainder, so the biggest holder is not always the pick', async () => {
      const big = await onlineMerchant(10_000);
      const mid = await onlineMerchant(6_000);
      const both = [big.merchantId, mid.merchantId];

      // Untouched, the bigger holder wins — the priority rule the platform
      // already had, and this change must not break it.
      expect((await pickAmong(5_000, both))?.merchantId).toBe(big.merchantId);

      // With 9,000 promised, `big` has 1,000 left and is now the smaller of
      // the two for any new work.
      await buyOrder(big.merchantId, 9_000);
      expect(
        (await pickAmong(5_000, both))?.merchantId,
        'ranked on the raw pocket instead of the remainder',
      ).toBe(mid.merchantId);
    });
  });
});
