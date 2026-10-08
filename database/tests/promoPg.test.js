// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The GENERAL (promotional) balance, against a real database (owner, 2026-10-08).
 *
 *   Referral → ₹1,000 bonus → ₹10,000 turnover required → play → wins and
 *   losses → ₹10,000 completed → ₹1,000 unlocks → the promotional winnings
 *   unlock too → withdrawable.
 *
 * Each property the owner listed is one test: a separate ledger, turnover
 * counted once, winnings reusable, winning early does not bypass, nothing
 * withdrawable before the requirement, a new bonus adds a requirement, a
 * completed requirement unlocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import * as promo from '../repositories/promo.js';
import { getBalancesPaise, applyDeltaPaise } from '../repositories/wallets.core.js';
import { placeBet, winBet, loseBet, refundBet } from '../repositories/bets.core.js';
import { ensureCycle } from '../repositories/markets.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = `promo-${Date.now()}`;
let seq = 0;
const player = () => `${RUN}-u${++seq}`;

// A game's result on the GENERAL balance, settled against the house the way a
// board settlement is (`{ house: true }`): a loss takes the stake, a win pays.
const play = (userId, ref, deltaPaise) => applyDeltaPaise({
  userId, field: 'promoBalance', deltaPaise, txId: `${RUN}-${ref}`, type: deltaPaise < 0 ? 'DEBIT' : 'CREDIT',
  reason: 'test round', counterparty: { house: true, operation: 'TEST_ROUND' },
});

const balances = (u) => getBalancesPaise(u);
const grants = async (u) => (await promo.promoSummary(u)).grants;

describePg('the GENERAL balance and its turnover requirement', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('pays a referral bonus into GENERAL, never winnings, and asks 10× in turnover', async () => {
    const u = player();
    const r = await promo.creditReferralBonus({ userId: u, amountPaise: 100_000, earningId: `${u}-e1` });
    expect(r.ok).toBe(true);
    const b = await balances(u);
    expect(b.promoBalance).toBe(100_000);
    expect(b.winningsBalance).toBe(0);
    const [g] = await grants(u);
    expect(g.requiredTurnoverPaise).toBe(1_000_000);
    expect(g.completedAt).toBeNull();

    // Keyed by the earning: a replay moves nothing and opens nothing.
    const again = await promo.creditReferralBonus({ userId: u, amountPaise: 100_000, earningId: `${u}-e1` });
    expect(again.idempotent).toBe(true);
    expect((await balances(u)).promoBalance).toBe(100_000);
    expect(await grants(u)).toHaveLength(1);
  });

  it('the owner\'s example: ₹1,000 bonus, ₹400 won along the way, ₹1,400 withdrawable at ₹10,000', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 100_000, earningId: `${u}-e1` });
    await play(u, `${u}-win`, 40_000); // winnings stay in GENERAL and can be bet again

    // ₹9,999 of turnover: not complete, nothing unlocked.
    const part = await promo.recordTurnover({ userId: u, stakeRef: `${u}-s1`, amountPaise: 999_900 });
    expect(part.unlockedPaise).toBe(0);
    expect((await balances(u)).winningsBalance).toBe(0);
    expect((await promo.promoSummary(u)).outstandingTurnoverPaise).toBe(100);

    // The last rupee completes it: the bonus and the winnings unlock.
    const done = await promo.recordTurnover({ userId: u, stakeRef: `${u}-s2`, amountPaise: 100 });
    expect(done.completedGrants).toEqual([`ref_${u}-e1`]);
    expect(done.unlockedPaise).toBe(140_000);
    const b = await balances(u);
    expect(b.winningsBalance).toBe(140_000);
    expect(b.promoBalance).toBe(0);
  });

  it('counts a stake once, however many times it is reported', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 10_000, earningId: `${u}-e1` });
    const first = await promo.recordTurnover({ userId: u, stakeRef: `${u}-s1`, amountPaise: 60_000 });
    const again = await promo.recordTurnover({ userId: u, stakeRef: `${u}-s1`, amountPaise: 60_000 });
    expect(first.counted).toBe(true);
    expect(again.counted).toBe(false);
    expect((await grants(u))[0].turnoverPaise).toBe(60_000);
  });

  it('a big early win does not bypass the requirement', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 10_000, earningId: `${u}-e1` });
    await play(u, `${u}-jackpot`, 500_000);
    await promo.recordTurnover({ userId: u, stakeRef: `${u}-s1`, amountPaise: 10_000 });
    const b = await balances(u);
    expect(b.winningsBalance).toBe(0);
    expect(b.promoBalance).toBe(510_000);
    expect((await promo.promoSummary(u)).outstandingTurnoverPaise).toBe(90_000);
  });

  it('a new bonus adds its own requirement, and turnover fills the oldest first', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 10_000, earningId: `${u}-e1` });
    await promo.creditReferralBonus({ userId: u, amountPaise: 20_000, earningId: `${u}-e2` });
    expect((await promo.promoSummary(u)).outstandingTurnoverPaise).toBe(300_000);

    // Completes the first (₹1,000 of turnover) and starts the second.
    const r = await promo.recordTurnover({ userId: u, stakeRef: `${u}-s1`, amountPaise: 150_000 });
    expect(r.completedGrants).toEqual([`ref_${u}-e1`]);
    // The first bonus unlocks; the rest waits on the second requirement.
    expect(r.unlockedPaise).toBe(10_000);
    let b = await balances(u);
    expect(b.winningsBalance).toBe(10_000);
    expect(b.promoBalance).toBe(20_000);

    const r2 = await promo.recordTurnover({ userId: u, stakeRef: `${u}-s2`, amountPaise: 150_000 });
    expect(r2.completedGrants).toEqual([`ref_${u}-e2`]);
    b = await balances(u);
    expect(b.winningsBalance).toBe(30_000);
    expect(b.promoBalance).toBe(0);
  });

  it('unlocks only what is left when the bonus was partly lost', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 10_000, earningId: `${u}-e1` });
    await play(u, `${u}-loss`, -7_000);
    const r = await promo.recordTurnover({ userId: u, stakeRef: `${u}-s1`, amountPaise: 100_000 });
    expect(r.unlockedPaise).toBe(3_000);
    expect((await grants(u))[0].unlockedPaise).toBe(3_000);
  });

  it('the database refuses a grant marked complete before its turnover is met', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 10_000, earningId: `${u}-e1` });
    await expect(pgQuery(
      'UPDATE promo_grants SET completed_at = now() WHERE user_id = $1', [u],
    )).rejects.toThrow(/promo_grants_complete_when_met/);
  });

  it('switches a player between VIP and GENERAL, and refuses anything else', async () => {
    const u = player();
    await pgQuery(
      `INSERT INTO users (user_id, username, mobile) VALUES ($1, $1, $2)`,
      [u, `9${String(Date.now() + seq).slice(-9)}`],
    );
    expect((await promo.promoSummary(u)).profile).toBe('VIP');
    expect(await promo.setPlayProfile(u, 'GENERAL')).toEqual({ ok: true, profile: 'GENERAL' });
    expect((await promo.promoSummary(u)).profile).toBe('GENERAL');
    await expect(promo.setPlayProfile(u, 'GOLD')).rejects.toMatchObject({ status: 400 });
  });
});

describePg('GENERAL bets on GENERAL boards (owner, 2026-10-08)', () => {
  beforeAll(async () => { await applySchema(); });

  let n = 0;
  const cycleFor = async (audience) => {
    const start = new Date(Date.UTC(2031, 0, 1) + (++n) * 60_000 + seq * 3_600_000);
    const { cycle } = await ensureCycle({
      cycleId: `${RUN}-${audience}-c${n}`, cycleType: '1_MIN', audience,
      startTime: start, endTime: new Date(start.getTime() + 60_000),
    });
    return cycle.cycleId;
  };
  const gen = (amountPaise) => [{ field: 'promoBalance', amountPaise }];

  it('stakes from GENERAL, pays a win back into GENERAL, and counts the stake once as turnover', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 10_000, earningId: `${u}-e1` });
    const c = await cycleFor('GENERAL');
    expect((await placeBet({ betId: `${u}-b1`, userId: u, cycleId: c, side: 'DELHI', slices: gen(4_000) })).ok).toBe(true);
    expect((await balances(u)).promoBalance).toBe(6_000);

    const won = await winBet({ betId: `${u}-b1`, userId: u, slices: gen(4_000), payoutPaise: 7_920 });
    expect(won.ok).toBe(true);
    const b = await balances(u);
    expect(b.promoBalance).toBe(13_920);
    expect(b.winningsBalance).toBe(0);
    expect((await grants(u))[0].turnoverPaise).toBe(4_000);

    // A replayed settlement moves nothing and counts nothing.
    await winBet({ betId: `${u}-b1`, userId: u, slices: gen(4_000), payoutPaise: 7_920 });
    expect((await grants(u))[0].turnoverPaise).toBe(4_000);
  });

  it('counts a lost GENERAL stake, but not a refunded one', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 10_000, earningId: `${u}-e1` });
    const c = await cycleFor('GENERAL');
    await placeBet({ betId: `${u}-lost`, userId: u, cycleId: c, side: 'DELHI', slices: gen(2_000) });
    await placeBet({ betId: `${u}-back`, userId: u, cycleId: c, side: 'DELHI', slices: gen(3_000) });
    await loseBet({ betId: `${u}-lost`, userId: u, slices: gen(2_000) });
    await refundBet({ betId: `${u}-back`, userId: u, slices: gen(3_000) });
    expect((await grants(u))[0].turnoverPaise).toBe(2_000);
    expect((await balances(u)).promoBalance).toBe(8_000);
  });

  it('unlocks into winnings when betting completes the requirement, and a later GENERAL win unlocks too', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 1_000, earningId: `${u}-e1` });
    const c = await cycleFor('GENERAL');
    // Two bets open; the first one settled completes the ₹100 requirement.
    await placeBet({ betId: `${u}-a`, userId: u, cycleId: c, side: 'DELHI', slices: gen(500) });
    await placeBet({ betId: `${u}-b`, userId: u, cycleId: c, side: 'DELHI', slices: gen(500) });
    await promo.recordTurnover({ userId: u, stakeRef: `${u}-earlier`, amountPaise: 9_500 });
    await loseBet({ betId: `${u}-a`, userId: u, slices: gen(500) });
    expect((await grants(u))[0].completedAt).not.toBeNull();
    // The other ₹5 is still staked; nothing is left in GENERAL to unlock yet.
    expect((await balances(u)).promoBalance).toBe(0);

    await winBet({ betId: `${u}-b`, userId: u, slices: gen(500), payoutPaise: 990 });
    const b = await balances(u);
    expect(b.promoBalance).toBe(0);
    expect(b.winningsBalance).toBe(990);
  });

  it('refuses GENERAL money on a VIP board and any other money on a GENERAL board', async () => {
    const u = player();
    await promo.creditReferralBonus({ userId: u, amountPaise: 10_000, earningId: `${u}-e1` });
    const { fundWallet } = await import('./_funding.js');
    await fundWallet(u, 10_000, `${u}-fund`);
    const vip = await cycleFor('VIP');
    const general = await cycleFor('GENERAL');
    expect(await placeBet({ betId: `${u}-x1`, userId: u, cycleId: vip, side: 'DELHI', slices: gen(1_000) }))
      .toMatchObject({ ok: false, reason: 'wrong_balance_for_cycle' });
    expect(await placeBet({
      betId: `${u}-x2`, userId: u, cycleId: general, side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: 1_000 }],
    })).toMatchObject({ ok: false, reason: 'wrong_balance_for_cycle' });
    const b = await balances(u);
    expect(b.promoBalance).toBe(10_000);
    expect(b.lockedBalance).toBe(0);
  });
});
