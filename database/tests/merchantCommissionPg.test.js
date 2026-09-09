// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The merchant commission engine, against a REAL PostgreSQL.
 *
 * The engine this replaces had NO database test at all. It decided what every
 * merchant is paid, and the only thing standing between it and paying every
 * merchant their entire lifetime volume on every pass was that it shipped
 * disabled — a bug found by reading, not by a failing test, because nothing
 * drove it.
 *
 * So this suite drives the real engine through the real ledger and the real
 * wallet. Nothing here is mocked: where a boundary carries money, a suite that
 * asserts on a spy's arguments can report a payment working while the function
 * behind it throws on every call.
 *
 * The invariants, asserted rather than a particular winner:
 *   • volume is matched WITHIN a variety, never across two
 *   • the basis is the INR-equivalent, so a USDT order is not counted at its
 *     USDT face value
 *   • each unit of matched volume is paid exactly ONCE, per variety
 *   • an unpriced variety earns nothing, and says so
 *   • the pool is never over-drawn, and never partially paid
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  commissionHighWaterMarks, legacyBonusIssuedMerchants,
} from '../repositories/ledger.core.js';
import { merchantMatchedVolumesByVariety } from '../repositories/orders.record.js';
import { createPolicyVersion } from '../repositories/merchantCommissionPolicy.js';
import { recordEventOnPostgres } from '../repositories/ledger.js';
import { getMerchantBalances } from '../repositories/merchantWallets.core.js';
import { runCommissionEngine } from '../../backend/domains/merchant/merchantCommission.service.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const M = 'pg-commission-merchant';
// A merchant id holding an underscore, which is exactly why the variety key is
// separated by `~` and read with split_part rather than a regexp.
const M_UNDERSCORE = 'pg_commission_merchant_2';

let orderSeq = 0;

/**
 * One completed order in a named variety.
 *
 * `tokenPaise` is the INR-equivalent — the platform's unit of account — and
 * `fiatPaise` is what the payer sent in the order's own currency. They differ
 * on the USDT rail, which is the whole point of several assertions below.
 */
async function completedOrder({
  merchantId = M, type, tokenPaise, fiatPaise = tokenPaise,
  currency = 'INR', paymentMode = 'P2P_UPI', usdtChain = null,
}) {
  orderSeq += 1;
  await pgQuery(
    `INSERT INTO order_states
       (order_id, user_id, merchant_id, order_type, state,
        token_amount_paise, fiat_amount_paise, currency, payment_mode, usdt_chain)
     VALUES ($1, 'player-1', $2, $3, 'COMPLETED', $4, $5, $6, $7, $8)`,
    [`ord-${orderSeq}`, merchantId, type, tokenPaise, fiatPaise, currency, paymentMode,
      currency === 'USDT' ? (usdtChain || 'TRC20') : null],
  );
}

/**
 * A real merchant row.
 *
 * Not incidental setup: `creditMerchantTokens` returns `{ merchant: null }`
 * rather than throwing when the id has no row, so an engine that skips this
 * would post the ledger event, credit nothing, and advance the mark past the
 * volume — which is what the "no merchant record" test below pins.
 */
async function merchantRow(merchantId, currency = 'INR') {
  await pgQuery(
    `INSERT INTO merchants (merchant_id, name, public_ref, accepted_currencies)
     VALUES ($1, $2, $3, $4) ON CONFLICT (merchant_id) DO NOTHING`,
    [merchantId, `Merchant ${merchantId}`, `REF-${merchantId}`, [currency]],
  );
}

/** Put money in the pool the way the funding path does: revenue -> pool. */
const fundPool = (minor, key = 'pool-fund') => recordEventOnPostgres({
  eventType: 'MERCHANT_BONUS_FUNDED',
  idempotencyKey: key,
  postings: [
    { account: 'PLATFORM_REVENUE', amountMinor: minor },
    { account: 'MERCHANT_BONUS_POOL', amountMinor: -minor },
  ],
  refModel: 'Platform',
  refId: 'test',
  occurredAt: new Date(),
  description: 'test pool funding',
});

const policy = ({ enabled = true, minMatchedVolume = 0, rates }) => createPolicyVersion({
  enabled, minMatchedVolume, rates, justification: 'test policy',
});

const UPI = { currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: null };
const CASH_500 = { currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 50_000 };
const CASH_1000 = { currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 100_000 };
const USDT_50K = { currency: 'USDT', paymentMode: 'P2P_UPI', denominationPaise: 5_000_000 };

describePg('merchant commission — per variety, against real Postgres', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    orderSeq = 0;
    await pgQuery('TRUNCATE order_states, order_transitions RESTART IDENTITY CASCADE');
    await pgQuery('TRUNCATE accounting_events RESTART IDENTITY CASCADE');
    await pgQuery('TRUNCATE merchant_wallets, merchant_wallet_entries RESTART IDENTITY CASCADE');
    await pgQuery('TRUNCATE merchant_commission_policies, merchant_commission_rates RESTART IDENTITY CASCADE');
    await pgQuery('TRUNCATE merchants RESTART IDENTITY CASCADE');
    await merchantRow(M);
    await merchantRow(M_UNDERSCORE);
  });

  describe('the cycle tracker', () => {
    it('matches volume within a variety and keeps varieties apart', async () => {
      // Cash ₹500: 3 in, 1 out -> matched is the smaller side, 1.
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 50_000, ...CASH_500 });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 50_000, ...CASH_500 });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 50_000, ...CASH_500 });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 50_000, ...CASH_500 });
      // UPI: 1 in, 2 out -> matched is 1.
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 700_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 400_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 400_000, ...UPI });

      const rows = await merchantMatchedVolumesByVariety();
      const cash = rows.find((r) => r.paymentMode === 'CASH_ATM');
      const upi = rows.find((r) => r.paymentMode === 'P2P_UPI');

      expect(cash).toMatchObject({ denominationPaise: 50_000, depositMinor: 150_000, withdrawalMinor: 50_000 });
      expect(cash.matchedMinor).toBe(50_000);
      expect(upi).toMatchObject({ denominationPaise: null, depositMinor: 700_000, withdrawalMinor: 800_000 });
      expect(upi.matchedMinor).toBe(700_000);

      // Matched ACROSS varieties would be min(850,000 in, 850,000 out) =
      // 850,000 — pairing a cash run with a UPI payout and paying one rate for
      // two different jobs.
      const total = cash.matchedMinor + upi.matchedMinor;
      expect(total).toBe(750_000);
    });

    it('separates two denominations of the same rail', async () => {
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 50_000, ...CASH_500 });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 50_000, ...CASH_500 });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 100_000, ...CASH_1000 });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 100_000, ...CASH_1000 });

      const rows = await merchantMatchedVolumesByVariety();
      expect(rows.map((r) => r.denominationPaise).sort((a, b) => a - b)).toEqual([50_000, 100_000]);
    });

    /**
     * The trap this query was written to close.
     *
     * `fiat_amount_paise` is what the payer SENDS, in the ORDER's currency. On a
     * USDT order that is USDT: 500 of them, for 50,000 tokens. Summing that
     * column across currencies adds USDT to rupees, and the previous version of
     * this query did exactly that — counting a 50,000-token deposit as ₹500 of
     * matched volume instead of ₹50,000, a hundredfold understatement in the
     * figure a percentage is then paid on.
     */
    it('counts a USDT order at its INR-equivalent, not its USDT face value', async () => {
      // 50,000 tokens (5,000,000 paise) sent as 500 USDT (50,000 minor units).
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 5_000_000, fiatPaise: 50_000, ...USDT_50K });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 5_000_000, fiatPaise: 50_000, ...USDT_50K });

      const [row] = await merchantMatchedVolumesByVariety();
      expect(row.matchedMinor).toBe(5_000_000);   // ₹50,000 of value
      expect(row.matchedMinor).not.toBe(50_000);  // not the 500 USDT face value
      expect(row.denominationPaise).toBe(5_000_000);
    });

    it('ignores orders that never completed', async () => {
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 50_000, ...CASH_500 });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 50_000, ...CASH_500 });
      await pgQuery(
        `INSERT INTO order_states (order_id, user_id, merchant_id, order_type, state,
           token_amount_paise, fiat_amount_paise, currency, payment_mode)
         VALUES ('ord-pending', 'player-1', $1, 'DEPOSIT', 'PENDING_QUEUE', 900000, 900000, 'INR', 'CASH_ATM')`,
        [M],
      );
      const [row] = await merchantMatchedVolumesByVariety();
      expect(row.depositMinor).toBe(50_000);
    });
  });

  describe('high-water marks', () => {
    const issued = (merchantId, variety, cumulative, key) => recordEventOnPostgres({
      eventType: 'MERCHANT_BONUS_ISSUED',
      idempotencyKey: key || `acct_commission_${merchantId}~${variety}~${cumulative}`,
      postings: [
        { account: 'MERCHANT_BONUS_POOL', amountMinor: 100 },
        { account: 'MERCHANT_FUNDS', amountMinor: -100 },
      ],
      refModel: 'Merchant',
      refId: merchantId,
      occurredAt: new Date(),
      description: 'test issuance',
    });

    it('keeps a separate mark per merchant AND variety', async () => {
      await issued(M, 'INR:CASH_ATM:50000', 300_000);
      await issued(M, 'INR:P2P_UPI:none', 900_000);

      const marks = await commissionHighWaterMarks();
      expect(marks[M]['INR:CASH_ATM:50000']).toBe(300_000);
      expect(marks[M]['INR:P2P_UPI:none']).toBe(900_000);
    });

    it('reads a merchant id containing an underscore correctly', async () => {
      // The reason the separator is `~`: a pattern anchored on `_` cannot tell
      // where this id ends and the variety begins.
      await issued(M_UNDERSCORE, 'INR:CASH_ATM:100000', 250_000);
      const marks = await commissionHighWaterMarks();
      expect(marks[M_UNDERSCORE]['INR:CASH_ATM:100000']).toBe(250_000);
    });

    it('takes the MAX, so an out-of-order repair never lowers the mark', async () => {
      await issued(M, 'INR:P2P_UPI:none', 900_000);
      await issued(M, 'INR:P2P_UPI:none', 400_000);
      const marks = await commissionHighWaterMarks();
      // Lowering it would re-pay the difference on the very next pass.
      expect(marks[M]['INR:P2P_UPI:none']).toBe(900_000);
    });

    it('finds a merchant carrying an issuance from the retired flat-rate engine', async () => {
      await issued(M, 'ignored', 0, `acct_bonusissue_${M}_500000`);
      expect(await legacyBonusIssuedMerchants()).toEqual([M]);
    });

    it('does not mistake a commission key for a legacy one', async () => {
      await issued(M, 'INR:P2P_UPI:none', 100_000);
      expect(await legacyBonusIssuedMerchants()).toEqual([]);
    });
  });

  describe('a full engine pass', () => {
    it('does nothing while no policy is enabled', async () => {
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 1_000_000, ...UPI });
      const outcome = await runCommissionEngine();
      expect(outcome.ran).toBe(false);
      expect((await getMerchantBalances(M)).available).toBe(0);
    });

    it('pays both legs of the matched volume and credits the wallet', async () => {
      await fundPool(1_000_000);
      await policy({ rates: [{ ...UPI, buyPercent: 2, sellPercent: 3 }] });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 1_000_000, ...UPI });

      const outcome = await runCommissionEngine();
      expect(outcome.ran).toBe(true);
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0]).toMatchObject({ merchantId: M, variety: 'INR:P2P_UPI:none', issued: true });

      // 5% of ₹10,000 matched = ₹500, and the money is really in the wallet.
      expect((await getMerchantBalances(M)).available).toBe(50_000);
    });

    it('pays each unit of matched volume exactly once', async () => {
      await fundPool(1_000_000);
      await policy({ rates: [{ ...UPI, buyPercent: 5, sellPercent: 0 }] });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 1_000_000, ...UPI });

      await runCommissionEngine();
      const afterFirst = (await getMerchantBalances(M)).available;
      expect(afterFirst).toBe(50_000);

      // The pass that would have re-paid the whole history under the engine
      // this replaces, whose mark always read zero.
      const second = await runCommissionEngine();
      expect(second.results.filter((r) => r.issued)).toHaveLength(0);
      expect((await getMerchantBalances(M)).available).toBe(afterFirst);
    });

    it('pays only the NEW volume when more arrives', async () => {
      await fundPool(1_000_000);
      await policy({ rates: [{ ...UPI, buyPercent: 10, sellPercent: 0 }] });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 1_000_000, ...UPI });
      await runCommissionEngine();
      expect((await getMerchantBalances(M)).available).toBe(100_000);

      await completedOrder({ type: 'DEPOSIT', tokenPaise: 500_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 500_000, ...UPI });
      await runCommissionEngine();
      // 10% of the additional ₹5,000 only.
      expect((await getMerchantBalances(M)).available).toBe(150_000);
    });

    /**
     * One mark per merchant would let a payment for the cash work advance the
     * mark on the UPI work, and the UPI volume underneath it would never be
     * paid at all — money withheld silently, with a ledger that reads complete.
     */
    it('does not let one variety’s payment suppress another’s', async () => {
      await fundPool(1_000_000);
      await policy({ rates: [
        { ...UPI, buyPercent: 10, sellPercent: 0 },
        { ...CASH_500, buyPercent: 10, sellPercent: 0 },
      ] });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 1_000_000, ...UPI });
      await runCommissionEngine();
      expect((await getMerchantBalances(M)).available).toBe(100_000);

      // Cash work of a SMALLER cumulative volume than the UPI mark already set.
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 50_000, ...CASH_500 });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 50_000, ...CASH_500 });
      const outcome = await runCommissionEngine();

      const cash = outcome.results.find((r) => r.variety === 'INR:CASH_ATM:50000');
      expect(cash).toMatchObject({ issued: true });
      expect((await getMerchantBalances(M)).available).toBe(105_000);
    });

    it('reports an unpriced variety rather than paying a default', async () => {
      await fundPool(1_000_000);
      await policy({ rates: [{ ...UPI, buyPercent: 5, sellPercent: 5 }] });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 100_000, ...CASH_1000 });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 100_000, ...CASH_1000 });

      const outcome = await runCommissionEngine();
      const cash = outcome.results.find((r) => r.variety === 'INR:CASH_ATM:100000');
      expect(cash).toMatchObject({ issued: false });
      expect(cash.reason).toMatch(/No rate is set/i);
      // Nothing paid — not the UPI rate borrowed for work it does not price.
      expect((await getMerchantBalances(M)).available).toBe(0);
    });

    it('skips rather than partially paying when the pool cannot cover it', async () => {
      await fundPool(1_000); // ₹10 in the pool
      await policy({ rates: [{ ...UPI, buyPercent: 50, sellPercent: 0 }] });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 1_000_000, ...UPI });

      const outcome = await runCommissionEngine();
      expect(outcome.results[0]).toMatchObject({ issued: false });
      expect(outcome.results[0].reason).toMatch(/exceeds pool/i);
      // Paying what the pool holds while recording the full high-water mark
      // would under-pay this merchant permanently.
      expect((await getMerchantBalances(M)).available).toBe(0);
    });

    it('holds volume below the minimum until it grows past it', async () => {
      await fundPool(1_000_000);
      await policy({ minMatchedVolume: 5_000, rates: [{ ...UPI, buyPercent: 10, sellPercent: 0 }] });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 100_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 100_000, ...UPI });

      // ₹1,000 matched, below the ₹5,000 threshold.
      await runCommissionEngine();
      expect((await getMerchantBalances(M)).available).toBe(0);

      await completedOrder({ type: 'DEPOSIT', tokenPaise: 900_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 900_000, ...UPI });
      await runCommissionEngine();
      // Now ₹10,000 matched, and the whole of it is newly matched.
      expect((await getMerchantBalances(M)).available).toBe(100_000);
    });

    it('refuses a merchant carrying a retired flat-rate issuance', async () => {
      await fundPool(1_000_000);
      await policy({ rates: [{ ...UPI, buyPercent: 10, sellPercent: 0 }] });
      await recordEventOnPostgres({
        eventType: 'MERCHANT_BONUS_ISSUED',
        idempotencyKey: `acct_bonusissue_${M}_500000`,
        postings: [
          { account: 'MERCHANT_BONUS_POOL', amountMinor: 100 },
          { account: 'MERCHANT_FUNDS', amountMinor: -100 },
        ],
        refModel: 'Merchant', refId: M, occurredAt: new Date(), description: 'legacy',
      });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 1_000_000, ...UPI });

      const outcome = await runCommissionEngine();
      expect(outcome.results[0]).toMatchObject({ issued: false });
      expect(outcome.results[0].reason).toMatch(/retired flat-rate/i);
      // The failure this prevents: their whole history re-paid on pass one.
      expect((await getMerchantBalances(M)).available).toBe(0);
    });

    /**
     * The defect this suite found, and the reason the engine checks first.
     *
     * `creditMerchantTokens` does not throw for an id with no merchant row — it
     * returns `{ merchant: null }`. With the ledger event written first, the
     * sequence was: the pool debited, the platform recording that it owed this
     * merchant, the wallet credit doing nothing, and the high-water mark (which
     * is DERIVED from that ledger event) advancing past the volume. Owed,
     * undelivered, never retried — and reported as `issued: true`.
     *
     * `order_states.merchant_id` has no foreign key to `merchants`, so this is
     * reachable rather than hypothetical.
     */
    it('posts nothing at all for an id with no merchant record', async () => {
      await fundPool(1_000_000);
      await policy({ rates: [{ ...UPI, buyPercent: 10, sellPercent: 0 }] });
      await completedOrder({ merchantId: 'ghost-merchant', type: 'DEPOSIT', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ merchantId: 'ghost-merchant', type: 'WITHDRAWAL', tokenPaise: 1_000_000, ...UPI });

      const outcome = await runCommissionEngine();
      const ghost = outcome.results.find((r) => r.merchantId === 'ghost-merchant');
      expect(ghost).toMatchObject({ issued: false });
      expect(ghost.reason).toMatch(/no merchant record/i);

      // The ledger must be untouched: an event here would move the pool and
      // advance the mark for a payment that can never be delivered.
      const { rows } = await pgQuery(
        "SELECT COUNT(*)::int AS n FROM accounting_events WHERE event_type = 'MERCHANT_BONUS_ISSUED'",
      );
      expect(rows[0].n).toBe(0);
      expect(await commissionHighWaterMarks()).toEqual({});
    });

    it('pays a USDT variety on its INR-equivalent', async () => {
      await fundPool(1_000_000);
      await policy({ rates: [{ ...USDT_50K, buyPercent: 1, sellPercent: 1 }] });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 5_000_000, fiatPaise: 50_000, ...USDT_50K });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 5_000_000, fiatPaise: 50_000, ...USDT_50K });

      await runCommissionEngine();
      // 2% of ₹50,000 = ₹1,000. On the USDT face value it would have been ₹10.
      expect((await getMerchantBalances(M)).available).toBe(100_000);
    });

    it('keeps two merchants’ marks apart', async () => {
      await fundPool(1_000_000);
      await policy({ rates: [{ ...UPI, buyPercent: 10, sellPercent: 0 }] });
      await completedOrder({ type: 'DEPOSIT', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ type: 'WITHDRAWAL', tokenPaise: 1_000_000, ...UPI });
      await completedOrder({ merchantId: M_UNDERSCORE, type: 'DEPOSIT', tokenPaise: 200_000, ...UPI });
      await completedOrder({ merchantId: M_UNDERSCORE, type: 'WITHDRAWAL', tokenPaise: 200_000, ...UPI });

      await runCommissionEngine();
      expect((await getMerchantBalances(M)).available).toBe(100_000);
      expect((await getMerchantBalances(M_UNDERSCORE)).available).toBe(20_000);
    });
  });

  describe('the policy the engine reads', () => {
    it('refuses to price one variety twice', async () => {
      const result = await createPolicyVersion({
        enabled: true, minMatchedVolume: 0, justification: 'dup',
        rates: [
          { ...CASH_500, buyPercent: 1, sellPercent: 1 },
          { ...CASH_500, buyPercent: 9, sellPercent: 9 },
        ],
      });
      expect(result).toMatchObject({ ok: false, reason: 'VARIETY_PRICED_TWICE' });
    });

    it('refuses a denomination the rail does not deal in', async () => {
      const result = await createPolicyVersion({
        enabled: true, minMatchedVolume: 0, justification: 'bad denom',
        rates: [{ currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 777_000, buyPercent: 1, sellPercent: 1 }],
      });
      expect(result).toMatchObject({ ok: false, reason: 'DENOMINATION_NOT_ON_RAIL' });
    });

    it('leaves no version behind when its rates are refused', async () => {
      const before = await pgQuery('SELECT COUNT(*)::int AS n FROM merchant_commission_policies');
      await createPolicyVersion({
        enabled: true, minMatchedVolume: 0, justification: 'bad',
        rates: [{ currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 12_345, buyPercent: 1, sellPercent: 1 }],
      });
      const after = await pgQuery('SELECT COUNT(*)::int AS n FROM merchant_commission_policies');
      // A version that exists without the rates it was saved with is a policy
      // the engine would read as pricing nothing.
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('carries the rates forward on a rollback', async () => {
      const { policy: v1 } = await policy({ rates: [{ ...CASH_500, buyPercent: 4, sellPercent: 6 }] });
      await policy({ rates: [{ ...UPI, buyPercent: 1, sellPercent: 1 }] });

      const { rollbackToVersion } = await import('../repositories/merchantCommissionPolicy.js');
      const rolled = await rollbackToVersion(v1.version, { changedBy: 'admin-1' });
      expect(rolled.ok).toBe(true);
      expect(rolled.policy.rates).toHaveLength(1);
      expect(rolled.policy.rates[0]).toMatchObject({
        currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 50_000,
        buyPercent: 4, sellPercent: 6,
      });
    });
  });
});
