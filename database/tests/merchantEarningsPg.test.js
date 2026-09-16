// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a merchant is told they earned, and what they actually earned.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `merchantEarnings` and `merchantDailyEarnings` summed
 * `order_states.merchant_profit_paise`. That column is written as the LITERAL
 * ZERO at order creation and never set again — measured on a working database,
 * 0 non-zero rows out of 5,731 — because merchant pay moved to
 * `merchant_commission_policies`/`_rates` and the wallet ledger (CLAUDE.md
 * §26): matched buy→sell volume, above a per-variety high-water mark, from the
 * platform-funded pool.
 *
 * So the merchant panel's entire earnings surface was a structural zero on
 * every rail: the "Today's earnings" tile, the weekly bars, the weekly total
 * and lifetime. Not a bug that fires under some condition — a consumer reading
 * a producer that had been retired. §3 inverted, and §28: the commission engine
 * ships and a merchant could never see a rupee of it.
 *
 * ── The two aggregates beside it ───────────────────────────────────────────
 * Both queries also summed `fiat_amount_paise` for VOLUME. On a USDT order that
 * column holds USDT (trap 15), so a 50,000-token deposit counted as 555 next to
 * a rupee order's 500 and the two were added into one figure. Trap 15 says
 * verbatim to aggregate `token_amount_paise`; that fix went into the commission
 * engine and this sibling was missed.
 *
 * And both windowed on `completed_at` while admitting `state IN ('PAID',
 * 'COMPLETED')`. A PAID order has no `completed_at`, so it fell out of every
 * dated bucket and still counted in the lifetime totals, whose window is two
 * NULL comparisons a NULL date passes: money that had not moved, reported as
 * volume settled.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { applySchema, closePg, pgQuery } from '../client.js';
import { merchantEarnings, merchantDailyEarnings } from '../repositories/stats.js';

const M = 'earn-merchant-1';

async function order({ id, type = 'DEPOSIT', state = 'COMPLETED', tokens, fiat, currency = 'INR', completedAt = 'now()' }) {
  await pgQuery(
    `INSERT INTO order_states
       (order_id, user_id, merchant_id, order_type, state, token_amount_paise,
        fiat_amount_paise, currency, usdt_chain, completed_at)
     VALUES ($1,'earn-user',$2,$3,$4,$5,$6,$7,$8, ${completedAt === null ? 'NULL' : completedAt})`,
    // A USDT order MUST name a chain and an INR order must not —
    // `order_states_usdt_chain_matches_currency` refuses either mistake, which
    // is §25 written into the row rather than trusted to a handler.
    [id, M, type, state, tokens, fiat, currency, currency === 'USDT' ? 'TRC20' : null],
  );
}

/** A commission payment, exactly as `issueMerchantBonus` records one. */
async function paid({ key, paise, at = 'now()' }) {
  await pgQuery(
    `INSERT INTO accounting_events
       (idempotency_key, event_type, amount_paise, ref_model, ref_id, postings, description, created_at)
     VALUES ($1, 'MERCHANT_BONUS_ISSUED', $2, 'Merchant', $3,
             $4::jsonb, 'Merchant commission', ${at})`,
    [key, paise, M, JSON.stringify([
      { account: 'MERCHANT_BONUS_POOL', amountPaise: -paise },
      { account: 'MERCHANT_PAYABLE', amountPaise: paise },
    ])],
  );
}

describe('a merchant’s earnings', () => {
  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE order_states, order_transitions, accounting_events
                   RESTART IDENTITY CASCADE`);
  });

  it('reports what the commission ledger paid, not a column nothing writes', async () => {
    // Two completed orders. Under the old query their `merchant_profit_paise`
    // is 0 and so is every earnings figure — which is what a real merchant saw.
    await order({ id: 'e1', tokens: 50_000_00, fiat: 50_000_00 });
    await order({ id: 'e2', type: 'WITHDRAWAL', tokens: 50_000_00, fiat: 50_000_00 });
    await paid({ key: 'acct_commission_earn-merchant-1~INR:P2P_UPI:none~5000000', paise: 250_00 });

    const e = await merchantEarnings(M);
    expect(e.today.earned).toBe(250);
    expect(e.lifetime.totalEarnings).toBe(250);
  });

  it('counts volume in TOKENS, so a USDT order cannot be added as its own currency', async () => {
    // 50,000 tokens bought for 555.56 USDT, beside an ordinary ₹500 order.
    // Summing `fiat_amount_paise` gives 1,055.56 — a number in no currency at
    // all. Summing tokens gives 50,500, which is what both orders are worth.
    await order({ id: 'u1', tokens: 50_000_00, fiat: 555_56, currency: 'USDT' });
    await order({ id: 'i1', tokens: 500_00, fiat: 500_00, currency: 'INR' });

    const e = await merchantEarnings(M);
    expect(e.lifetime.totalVolume).toBe(50_500);
    expect(e.lifetime.totalVolume).not.toBe(1_055.56);
    expect(e.today.deposits.totalAmount).toBe(50_500);
  });

  it('leaves out an order whose money has not moved', async () => {
    // PAID, so `completed_at` is null. It was admitted by the state filter and
    // then fell out of every dated window, while still counting in the lifetime
    // totals — whose window is two NULL comparisons a NULL date passes.
    await order({ id: 'c1', tokens: 1_000_00, fiat: 1_000_00 });
    await order({ id: 'p1', state: 'PAID', tokens: 9_000_00, fiat: 9_000_00, completedAt: null });

    const e = await merchantEarnings(M);
    expect(e.lifetime.totalOrders).toBe(1);
    expect(e.lifetime.totalVolume).toBe(1_000);
  });

  it('bounds the range by when the commission was PAID', async () => {
    await paid({ key: 'k-old', paise: 100_00, at: "now() - interval '10 days'" });
    await paid({ key: 'k-new', paise:  40_00 });

    const all = await merchantEarnings(M);
    expect(all.lifetime.totalEarnings).toBe(140);

    const recent = await merchantEarnings(M, { from: new Date(Date.now() - 2 * 86_400_000) });
    expect(recent.lifetime.totalEarnings).toBe(40);
    // Today's figure is its own window and is unaffected by the range.
    expect(recent.today.earned).toBe(40);
  });

  it('does not multiply a day’s commission by the orders on that day', async () => {
    // The daily query joins two INDEPENDENT sets to one generated day. A second
    // LEFT JOIN would give the cross product — three orders and one payment
    // would report the payment three times — so the payment comes through a
    // LATERAL that aggregates before the join. This is the case that tells the
    // difference; with one order of each the two shapes agree.
    await order({ id: 'd1', tokens: 100_00, fiat: 100_00 });
    await order({ id: 'd2', tokens: 100_00, fiat: 100_00 });
    await order({ id: 'd3', tokens: 100_00, fiat: 100_00 });
    await paid({ key: 'k-day', paise: 30_00 });

    const days = await merchantDailyEarnings(M, { days: 3 });
    const today = days[days.length - 1];
    expect(today.orders).toBe(3);
    expect(today.earnings).toBe(30);
    expect(today.volume).toBe(300);
    // And an empty day is a zero rather than a missing row.
    expect(days).toHaveLength(3);
    expect(days[0].earnings).toBe(0);
    expect(days[0].orders).toBe(0);
  });

  it('gives a merchant who has been paid nothing a zero, not a crash', async () => {
    await order({ id: 'z1', tokens: 700_00, fiat: 700_00 });
    const e = await merchantEarnings(M);
    expect(e.today.earned).toBe(0);
    expect(e.lifetime.totalEarnings).toBe(0);
    expect(e.lifetime.totalVolume).toBe(700);
  });
});
