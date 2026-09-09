// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * One merchant, one denomination — and the database says so.
 *
 * ── Why a column and not a child table ─────────────────────────────────────
 * A merchant is approved for exactly ONE amount on the cash rail and works only
 * that. As a column, "cannot hold two" is a property of the row; as a table it
 * would be a rule every writer has to remember, and this repository has paid
 * for that difference repeatedly.
 *
 * ── Why the list is asserted against the module ────────────────────────────
 * A CHECK constraint must spell its values out in SQL, so the five
 * denominations necessarily exist twice: in `denominations.js` and in
 * `schema.sql`. Two copies of a value drift, and the drift is silent — a
 * denomination the code offers but the database refuses is a 500 at the moment
 * an admin approves a merchant. So the test walks the module's own list and
 * proves the database accepts exactly it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { updateMerchant, getMerchant, assignmentCandidates } from '#db/repositories/merchants.js';
import { createOrderRecord } from '#db/repositories/orders.record.js';
import { creditMerchantTokens } from '../../domains/merchant/merchantWallet.service.js';
import { selectBestMerchant } from '../../domains/merchant/merchantScoring.service.js';
import { PAYMENT_MODES } from '#db/repositories/paymentModePolicy.js';
import {
  CASH_DENOMINATIONS_PAISE, BUY_DENOMINATIONS_PAISE, MAX_CASH_BUY_PAISE, MAX_CASH_SELL_PAISE,
  splitWithdrawal, isCashDenomination, isBuyDenomination, SPLIT_FLOOR_PAISE,
} from '../../domains/merchant/denominations.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the denomination a merchant is approved for', () => {
  let app;
  let seq = 0;
  const oid = () => `dn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/admin/index.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  it('accepts every denomination the module declares, and refuses everything else', async () => {
    const m = await merchantActor({});

    for (const paise of CASH_DENOMINATIONS_PAISE) {
      const row = await updateMerchant(m.merchantId, { cashDenominationPaise: paise });
      expect(row.cashDenominationPaise).toBe(paise);
    }

    // Amounts an ATM does not dispense. Refused by the ROW, so no writer can
    // let one through — including a future one nobody has written yet.
    for (const bad of [1, 25_000, 200_000, 2_000_000, 5_000_000, 999]) {
      expect(isCashDenomination(bad)).toBe(false);
      await expect(updateMerchant(m.merchantId, { cashDenominationPaise: bad }))
        .rejects.toThrow(/merchants_cash_denomination_known/);
    }

    // And null is a real state: not approved for the cash rail at all.
    const cleared = await updateMerchant(m.merchantId, { cashDenominationPaise: null });
    expect(cleared.cashDenominationPaise).toBeNull();
  });

  it('offers a player only the buy denominations, never the withdrawal-only tier', () => {
    // ₹40,000 is a withdrawal leg. It exists in the ladder a split uses and
    // must NOT exist in what a player can choose, which is what keeps a
    // 40,000 deposit from ever being created.
    expect(BUY_DENOMINATIONS_PAISE).not.toContain(4_000_000);
    expect(BUY_DENOMINATIONS_PAISE).toEqual([50_000, 100_000, 500_000, 1_000_000]);
    expect(isBuyDenomination(4_000_000)).toBe(false);
    // The ceiling is derived from the list rather than being a second number.
    expect(Math.max(...BUY_DENOMINATIONS_PAISE)).toBe(MAX_CASH_BUY_PAISE);
    // And the payout ceiling is the largest tier of all — a leg, never a
    // request: a withdrawal above it is SPLIT rather than refused.
    expect(Math.max(...CASH_DENOMINATIONS_PAISE)).toBe(MAX_CASH_SELL_PAISE);
  });

  it('splits a withdrawal largest-first and never below the floor unless the remainder forces it', () => {
    const rupees = (r) => splitWithdrawal(r * 100)?.map((p) => p / 100);

    // The example from the specification.
    expect(rupees(100_000)).toEqual([40_000, 40_000, 10_000, 10_000]);
    expect(rupees(55_000)).toEqual([40_000, 10_000, 5_000]);
    expect(rupees(5_000)).toEqual([5_000]);

    // Below the floor only when what is left is itself below it.
    expect(rupees(12_500)).toEqual([10_000, 1_000, 1_000, 500]);

    // Every split adds up to exactly what was asked for. A split that loses
    // paise is a player short-paid, silently.
    for (const amount of [500, 1_500, 12_500, 40_000, 55_000, 100_000, 987_500]) {
      const legs = splitWithdrawal(amount * 100);
      expect(legs.reduce((a, b) => a + b, 0)).toBe(amount * 100);
      expect(legs.every((p) => CASH_DENOMINATIONS_PAISE.includes(p))).toBe(true);
    }

    // Amounts no ladder can express are REFUSED, not rounded down. A split
    // that pays less than asked while returning successfully is the worst
    // possible outcome here.
    expect(splitWithdrawal(30_000)).toBeNull();
    expect(splitWithdrawal(0)).toBeNull();
    expect(splitWithdrawal(70_000)).toBeNull();  // ₹700 is not a multiple of ₹500

    // ── The floor, asserted as the property it actually is ─────────────────
    // "Never below ₹5,000 unless the remainder is itself below it" is not
    // enforced by a branch — under largest-first it cannot be violated, and a
    // mutation deleting the guard that claimed to enforce it changed no
    // output. So it is proven across the whole range instead of trusted.
    for (let paise = 50_000; paise <= 20_000_000; paise += 50_000) {
      const legs = splitWithdrawal(paise);
      expect(legs).toBeTruthy();
      expect(legs.reduce((a, b) => a + b, 0)).toBe(paise);
      let left = paise;
      for (const d of legs) {
        if (d < SPLIT_FLOOR_PAISE) expect(left).toBeLessThan(SPLIT_FLOOR_PAISE);
        left -= d;
      }
    }
  });

  it('offers a cash order only to merchants approved for that exact amount', async () => {
    const right = await merchantActor({ tokensRupees: 50_000 });
    const wrong = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(right.merchantId, {
      cashDenominationPaise: 500_000, isOnline: true, merchantApprovalStatus: 'APPROVED',
    });
    await updateMerchant(wrong.merchantId, {
      cashDenominationPaise: 100_000, isOnline: true, merchantApprovalStatus: 'APPROVED',
    });

    const candidates = await assignmentCandidates({
      currency: 'INR', direction: 'DEPOSIT', cashDenominationPaise: 500_000,
    });
    const ids = candidates.map((c) => c.merchantId);
    expect(ids).toContain(right.merchantId);
    // Not "sorted last" — not a candidate at all. A merchant standing at an
    // ATM that dispenses ₹1,000 cannot serve a ₹5,000 order by trying harder.
    expect(ids).not.toContain(wrong.merchantId);
  });

  it('picks the right merchant through selectBestMerchant itself, on the order\'s own rail', async () => {
    // The assertion above drives the repository. That proves the QUERY filters
    // and says nothing about whether the assignment path asks it to — the
    // lesson M97 taught on this branch, where a guard was asserted against a
    // read nothing performed. So this drives the real selector.
    // The wrong merchant is given the DOMINANT wallet balance on the platform.
    // A deposit is ranked by spendable inventory, so without the denomination
    // filter this merchant wins outright — which is what makes the assertion
    // below prove the filter rather than merely coincide with it.
    //
    // The first version of this test gave both the same balance, and the
    // mutation that deletes the filter SURVIVED the full-tier run: with every
    // other suite's merchants in the database, the ranking happened to return
    // an acceptable one anyway. A test whose outcome depends on what other
    // files left behind is not testing the thing it names.
    const right = await merchantActor({ tokensRupees: 50_000 });
    const wrong = await merchantActor({ tokensRupees: 900_000_000 });
    await updateMerchant(right.merchantId, {
      cashDenominationPaise: 1_000_000, isOnline: true, merchantApprovalStatus: 'APPROVED',
    });
    await updateMerchant(wrong.merchantId, {
      cashDenominationPaise: 50_000, isOnline: true, merchantApprovalStatus: 'APPROVED',
    });

    // A ₹10,000 cash buy. Only the ₹10,000 merchant can stand at that machine.
    const picked = await selectBestMerchant('DEPOSIT', 10_000, 'INR', {
      paymentMode: PAYMENT_MODES.CASH_ATM,
    });
    expect(picked).toBeTruthy();
    expect(picked.cashDenominationPaise).toBe(1_000_000);
    expect(picked.merchantId).not.toBe(wrong.merchantId);

    // And with no rail given — the UPI path — the denomination plays no part,
    // so a merchant approved for a different cash amount is still eligible.
    const anyRail = await selectBestMerchant('DEPOSIT', 10_000, 'INR');
    expect(anyRail).toBeTruthy();
  });

  it('ignores the denomination entirely on the UPI rail', async () => {
    // Amounts are a range there, and a merchant with no cash approval must not
    // vanish from the UPI queue because a column they never set is null.
    const m = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(m.merchantId, {
      cashDenominationPaise: null, isOnline: true, merchantApprovalStatus: 'APPROVED',
    });

    const candidates = await assignmentCandidates({ currency: 'INR', direction: 'DEPOSIT' });
    expect(candidates.map((c) => c.merchantId)).toContain(m.merchantId);
  });

  it('refuses a bad denomination from the admin route with the reason, not a 500', async () => {
    const admin = await actor({ isAdmin: true });
    const m = await merchantActor({});

    const bad = await as(app, admin).put(`/merchants/${m.merchantId}/limits`)
      .send({ cashDenomination: 2000 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/ATM dispenses/);

    const good = await as(app, admin).put(`/merchants/${m.merchantId}/limits`)
      .send({ cashDenomination: 5000 });
    expect(good.status).toBe(200);
    expect(good.body.limits.cashDenomination).toBe(5000);
    expect((await getMerchant(m.merchantId)).cashDenominationPaise).toBe(500_000);
  });

  it('will not change the denomination under a merchant who is holding an order', async () => {
    const admin = await actor({ isAdmin: true });
    const player = await actor({});
    const m = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(m.merchantId, { cashDenominationPaise: 500_000 });

    await createOrderRecord({
      orderId: oid(), userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 5000, fiatAmountRupees: 5000,
      state: 'PROCESSING', merchantId: m.merchantId,
    });

    // Changing it now would change the amount they were assigned under.
    const res = await as(app, admin).put(`/merchants/${m.merchantId}/limits`)
      .send({ cashDenomination: 1000 });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('MERCHANT_HAS_OPEN_ORDERS');

    // And a refusal moves NOTHING.
    expect((await getMerchant(m.merchantId)).cashDenominationPaise).toBe(500_000);
  });
});
