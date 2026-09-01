// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The admin dashboard's betting figures, summed from the bets.
 *
 * These replace two MongoDB aggregations over a `Transaction` feed, and the
 * reason is not tidiness. `BET_PLACED` transactions are never written by
 * anything — the strings that look like them are `reason` text on ledger rows —
 * so `totalBets` read ZERO and `netProfit`, which is bets minus payouts, has
 * been reporting minus-the-payouts as though the house had taken nothing.
 * `BET_WIN` rows came from a settlement helper the engine no longer calls.
 *
 * A denormalised feed can be missing rows and still look healthy. A sum over
 * `bets` cannot: the bets ARE the thing being counted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { betTotals, betTotalsByDay } from '../../postgres/analyticsPg.js';
import { pgQuery, applySchema } from '../../postgres/pgClient.js';

const HAS_PG = !!process.env.DATABASE_URL;
const d = HAS_PG ? describe : describe.skip;

let seq = 0;
const CYCLE = `an_cyc_${Date.now()}`;

/** A bet row, written directly — these queries read, they do not place. */
async function givenBet({ status, stake, payout = 0, fee = 0, placedAt }) {
  const id = `an_bet_${Date.now()}_${seq++}`;
  await pgQuery(
    `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status,
                       payout_paise, platform_fee_paise, placed_at)
     VALUES ($1,$2,$3,'DELHI',$4,$5,$6,$7,$8)`,
    [id, `an_u_${seq}`, CYCLE, stake, status, payout, fee, placedAt],
  );
  return id;
}

d('betting figures derived from the bets', () => {
  beforeAll(async () => { await applySchema(); });

  /**
   * Assertions are DELTAS, never absolutes.
   *
   * `betTotals()` answers for the whole table because that is what the
   * dashboard asks, and these suites share one database — so every other file's
   * bets are in the sum too. An earlier draft asserted the totals directly and
   * failed the moment it ran after anything else, which is a property of the
   * test, not of the query.
   */
  const delta = (after, before) => ({
    bets:     Math.round((after.bets - before.bets) * 100) / 100,
    payouts:  Math.round((after.payouts - before.payouts) * 100) / 100,
    count:    after.betCount - before.betCount,
    fees:     Math.round((after.fees - before.fees) * 100) / 100,
  });

  it('sums stakes and payouts, and leaves REFUNDED stakes out of both', async () => {
    const before = await betTotals();
    const now = new Date();
    await givenBet({ status: 'WON',      stake: 10000, payout: 19800, fee: 200, placedAt: now });
    await givenBet({ status: 'LOST',     stake: 10000, placedAt: now });
    // A refunded stake was returned, so it was never the house's to count. Left
    // in, it inflates turnover and understates the margin on every report.
    await givenBet({ status: 'REFUNDED', stake: 50000, placedAt: now });

    expect(delta(await betTotals(), before))
      .toEqual({ bets: 200, payouts: 198, count: 2, fees: 2 });
  });

  it('nets to what the house actually kept', async () => {
    // ₹200 staked, ₹198 returned to the winner — the house keeps ₹2, the
    // retained fee. Before this, `netProfit` was 0 − 198 = −198, because the
    // stake side summed a transaction type nothing ever writes.
    const before = await betTotals();
    await givenBet({ status: 'WON',  stake: 10000, payout: 19800, fee: 200, placedAt: new Date() });
    await givenBet({ status: 'LOST', stake: 10000, placedAt: new Date() });
    const d2 = delta(await betTotals(), before);
    expect(d2.bets - d2.payouts).toBe(2);
  });

  it('counts only what falls inside the window', async () => {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const beforeAll_ = await betTotals();
    const beforeDay  = await betTotals({ since: new Date(Date.now() - 86_400_000) });
    await givenBet({ status: 'WON', stake: 70000, payout: 100000, placedAt: old });

    // The 30-day-old bet lands in the all-time sum and in no recent window.
    expect(delta(await betTotals(), beforeAll_).bets).toBe(700);
    expect(delta(await betTotals({ since: new Date(Date.now() - 86_400_000) }), beforeDay).bets).toBe(0);
  });

  it('keeps a cycle\'s stakes and its payouts on the SAME day', async () => {
    // The regression this shape exists to prevent. The Mongo version grouped
    // stakes by the bet's day and payouts by the SETTLEMENT's day, so a cycle
    // closing either side of midnight split across two lines and made the net
    // profit wrong on both. Here a won bet contributes its stake AND its payout
    // to the day it was placed.
    //
    // Five days back, where nothing else in these suites places bets.
    const day = new Date(Date.now() - 5 * 86_400_000);
    const key = day.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const before = (await betTotalsByDay({ since: new Date(Date.now() - 7 * 86_400_000) }))
      .find((r) => r.date === key) || { bets: 0, payouts: 0 };

    await givenBet({ status: 'WON', stake: 30000, payout: 59400, placedAt: day });

    const rows = await betTotalsByDay({ since: new Date(Date.now() - 7 * 86_400_000) });
    const line = rows.find((r) => r.date === key);
    expect(line, `no row for ${key} in ${rows.map((r) => r.date).join(', ')}`).toBeDefined();
    expect({
      bets:    Math.round((line.bets - before.bets) * 100) / 100,
      payouts: Math.round((line.payouts - before.payouts) * 100) / 100,
    }).toEqual({ bets: 300, payouts: 594 });
  });

  it('returns days oldest first, so a chart does not have to sort', async () => {
    const rows = await betTotalsByDay({ since: new Date(Date.now() - 7 * 86_400_000) });
    expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort());
  });
});
