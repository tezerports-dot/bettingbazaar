// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The RTP fund and its house bets (owner, 2026-10-17), against a real
 * database, through the real generator (result) and engine (settlement).
 * The owner's three examples, plus: a fund too small places no house bet, a
 * negative fund refills before paying out, VIP and General never share a
 * fund, a round is counted once, unsettled house bets hold their share of the
 * fund, and a fund never set is off.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { placeBet, getBet } from '../repositories/bets.core.js';
import { applyDeltaPaise } from '../repositories/wallets.core.js';
import { TEST_FUNDING } from './_funding.js';
import { getCycle, currentCycleWithPools, markSettled } from '../repositories/markets.js';
import * as rtp from '../repositories/rtp.js';
import CycleGenerator from '../../backend/domains/markets/cycleGenerator.service.js';
import GameEngine from '../../backend/domains/markets/gameEngine.js';
import { getRiskRules, computeWinningsPayout } from '../../backend/domains/risk/riskValidation.service.js';

const describePg = pgConfigured() ? describe : describe.skip;

function generator() {
  const gen = new CycleGenerator(null, null);
  clearInterval(gen.cycleInterval);
  clearInterval(gen.broadcastInterval);
  return gen;
}
function engine() {
  const io = { emit() {}, to: () => ({ emit() {} }) };
  const e = new GameEngine(io);
  e.stop();
  return e;
}

const fund = (userId, paise) => applyDeltaPaise({
  userId, field: 'depositBalance', deltaPaise: paise, txId: `f-${userId}-${paise}`,
  type: 'CREDIT', reason: 'test', counterparty: TEST_FUNDING,
});
const openCycle = (cycleId, audience = 'VIP') => pgQuery(
  `INSERT INTO cycles (cycle_id, cycle_type, audience, status, start_time, end_time)
   VALUES ($1, '30_MIN', $2, 'OPEN', now() - interval '31 minutes', now() - interval '1 minute')`,
  [cycleId, audience],
);
const bet = (betId, userId, cycleId, side, paise) =>
  placeBet({ betId, userId, cycleId, side, slices: [{ field: 'depositBalance', amountPaise: paise }] });
/** A test's starting balance, written straight to the row (the fund's own entries are the only writer in the app). */
const seed = (balancePaise, audience = 'VIP') => pgQuery(
  'UPDATE rtp_funds SET balance_paise = $1 WHERE game_key = $2 AND audience = $3', [balancePaise, '30_MIN', audience],
);

let rules;
const pays = (rupees) => computeWinningsPayout({
  amount: rupees, feePercent: rules.winningsFeePercent, multiplier: rules.payoutMultiplier,
}).netMinor;
/** What the fund counts as paid back: the payout BEFORE the winnings fee (owner, 2026-10-19). */
const gross = (rupees) => computeWinningsPayout({
  amount: rupees, feePercent: rules.winningsFeePercent, multiplier: rules.payoutMultiplier,
}).grossMinor;

/** Delhi and Bombay stakes in rupees, one player per side; result and settlement run for real. */
async function playRound(cycleId, delhi, bombay) {
  await openCycle(cycleId);
  await fund(`${cycleId}-d`, delhi * 100);
  await fund(`${cycleId}-b`, bombay * 100);
  await bet(`${cycleId}-bd`, `${cycleId}-d`, cycleId, 'DELHI', delhi * 100);
  await bet(`${cycleId}-bb`, `${cycleId}-b`, cycleId, 'BOMBAY', bombay * 100);
  await generator().completeCycle(await currentCycleWithPools('30_MIN', 'VIP'));
  await engine().tick();
  return getCycle(cycleId);
}

describePg('the RTP fund and house bets', () => {
  beforeAll(async () => { await applySchema(); rules = await getRiskRules(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE bets, bet_transitions, wallet_ledger, wallets, cycles, cycle_settlements,
                            accounting_events, treasury_entries, treasury_accounts,
                            rtp_fund_entries, rtp_funds RESTART IDENTITY CASCADE`);
    await rtp.saveSettings({ gameKey: '30_MIN', audience: 'VIP', enabled: true, ratePercent: 80 });
  });

  it('round 1, lopsided: 80% of the pool less what was paid back goes into the fund', async () => {
    const c = await playRound('c-lop', 10_000, 1_000);
    expect(c.winner).toBe('BOMBAY');
    expect(c.houseBetSide).toBeNull();
    const [entry] = await rtp.listEntries('30_MIN', 'VIP');
    expect(entry).toMatchObject({ cycleId: 'c-lop', poolPaise: 11_000_00, paidBackPaise: gross(1_000) });
    expect(entry.deltaPaise).toBe(8_800_00 - gross(1_000));
    expect((await rtp.getFund('30_MIN', 'VIP')).balancePaise).toBe(8_800_00 - gross(1_000));
  });

  it('a close round that pays back more than the rate takes it from the fund, even below zero', async () => {
    const c = await playRound('c-close', 10_000, 9_000);
    expect(c.winner).toBe('BOMBAY');
    const balance = (await rtp.getFund('30_MIN', 'VIP')).balancePaise;
    expect(balance).toBe(15_200_00 - gross(9_000));
    expect(balance).toBeLessThan(0);
  });

  it('a house bet flips a round the fund covers, as its last bet, and the fund pays the whole cost', async () => {
    await seed(5_000_00);
    const c = await playRound('c-help', 2_000, 200);
    // A real bet on the 200 side, just over the 2,000 side, so the 2,000 side is lower and wins.
    expect(c.houseBetSide).toBe('BOMBAY');
    expect(c.houseBet).toBe(1_801);
    expect(c.winner).toBe('DELHI');
    expect((await getBet('c-help-bd')).payoutPaise).toBe(pays(2_000));
    expect((await getBet('c-help-bb')).status).toBe('LOST');

    const [entry] = await rtp.listEntries('30_MIN', 'VIP');
    // The pool is the players' 2,200 only; the house bet is never in it.
    expect(entry).toMatchObject({ poolPaise: 2_200_00, paidBackPaise: gross(2_000), houseBetPaise: 1_801_00 });
    expect(entry.deltaPaise).toBe(1_760_00 - gross(2_000));
    expect(entry.balanceAfterPaise).toBe(5_000_00 + 1_760_00 - gross(2_000));
    expect(entry.balanceAfterPaise).toBeGreaterThanOrEqual(0);
    const [vip] = (await rtp.listFunds()).filter((f) => f.audience === 'VIP');
    expect(vip).toMatchObject({ roundsHelped: 1, returnedPaise: gross(2_000) - 1_760_00 });
  });

  it('places no house bet when the fund cannot cover the whole round', async () => {
    await seed(1_000_00); // the flip would take ~2,200
    const c = await playRound('c-short', 2_000, 200);
    expect(c.houseBetSide).toBeNull();
    expect(c.winner).toBe('BOMBAY');
  });

  it('a negative fund refills from lopsided rounds before it pays anything out', async () => {
    await seed(-3_000_00);
    const c = await playRound('c-refill', 2_000, 200);
    expect(c.houseBetSide).toBeNull();
    expect(c.winner).toBe('BOMBAY');
    expect((await rtp.getFund('30_MIN', 'VIP')).balancePaise).toBe(-3_000_00 + 1_760_00 - gross(200));
  });

  it('VIP and General never share a fund', async () => {
    await rtp.saveSettings({ gameKey: '30_MIN', audience: 'GENERAL', enabled: true, ratePercent: 80 });
    await seed(7_000_00, 'GENERAL');
    const c = await playRound('c-vip', 2_000, 200); // the VIP fund is empty, so no help
    expect(c.houseBetSide).toBeNull();
    expect((await rtp.getFund('30_MIN', 'GENERAL')).balancePaise).toBe(7_000_00);
    expect(await rtp.listEntries('30_MIN', 'GENERAL')).toHaveLength(0);
  });

  it('counts a round once, however often settlement is recorded', async () => {
    await playRound('c-once', 10_000, 1_000);
    const before = (await rtp.getFund('30_MIN', 'VIP')).balancePaise;
    const again = await markSettled('c-once', { paidOutRupees: 1, netProfitRupees: 1, platformFeesRupees: 0, feePercentUsed: 1 });
    expect(again.ok).toBe(false);
    expect((await rtp.getFund('30_MIN', 'VIP')).balancePaise).toBe(before);
    expect(await rtp.listEntries('30_MIN', 'VIP')).toHaveLength(1);
    await expect(pgQuery('UPDATE rtp_fund_entries SET delta_paise = 0')).rejects.toThrow(/append-only/);
  });

  it('an unsettled house bet holds its share of the fund, and a round takes one house bet', async () => {
    await seed(3_000_00);
    for (const id of ['c-r1', 'c-r2']) {
      await openCycle(id);
      await pgQuery("UPDATE cycles SET status = 'CLOSED' WHERE cycle_id = $1", [id]);
    }
    expect((await rtp.placeHouseBet({ cycleId: 'c-r1', side: 'BOMBAY', stakePaise: 100, reservedPaise: 2_500_00 })).ok).toBe(true);
    expect(await rtp.placeHouseBet({ cycleId: 'c-r1', side: 'DELHI', stakePaise: 100, reservedPaise: 0 }))
      .toMatchObject({ ok: false, reason: 'ALREADY_PLACED' });
    expect(await rtp.placeHouseBet({ cycleId: 'c-r2', side: 'BOMBAY', stakePaise: 100, reservedPaise: 1_000_00 }))
      .toMatchObject({ ok: false, reason: 'FUND_SHORT', availablePaise: 500_00 });
    expect((await rtp.fundForRound('30_MIN', 'VIP')).availablePaise).toBe(500_00);
  });

  it('is off until an admin switches it on: no house bet and no entry', async () => {
    await pgQuery('TRUNCATE rtp_funds, rtp_fund_entries');
    const c = await playRound('c-off', 2_000, 200);
    expect(c.houseBetSide).toBeNull();
    expect(await rtp.listFunds()).toHaveLength(0);
    await expect(rtp.saveSettings({ gameKey: '30_MIN', audience: 'VIP', enabled: true, ratePercent: 101 }))
      .rejects.toThrow(/0 to 100/);
  });
});
