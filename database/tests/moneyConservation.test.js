// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * CROSS-DOMAIN money conservation — the whole chain, not one domain at a time.
 *
 * Every other suite here proves a domain in isolation: the wallet races
 * correctly, the team pool races correctly, routing holds correctly. All of
 * them can pass while money is still lost or created at the SEAMS between
 * them, because a domain test only ever sees one side of a transfer. A pool
 * that pays out ₹500 and a player credit of ₹450 are each individually correct.
 *
 * This file walks the real flow (PROJECT_STATUS §3.10, Step 2c) —
 *
 *     platform → team pool → player buy → bet stake → settlement
 *              → winnings → player sell → team pool
 *
 * — through the real writers (the pool fulfilment, team routing's hold, the
 * one confirm owner `moveDepositMoney`, the wallet, the pool's sell credit),
 * and after EVERY step asserts the books close, two ways:
 *
 *   1. the treasury trial balance sums to zero, with no balance an entry does
 *      not explain (nothing invented);
 *   2. TEAM_FLOAT equals what the team pools actually hold, and USER_FLOAT
 *      equals what the player's wallet actually holds (the treasury's view
 *      agrees with the domains it describes).
 *
 * (2) is the claim no isolated suite can make — that the platform's own books
 * and its customers' books tell the same story — and the last test shows the
 * failure it catches.
 *
 * Nothing is CREATED anywhere in this flow (§2): every token starts in
 * TOKEN_SUPPLY, the platform's holding, and moves. So the final assertion is
 * that what left the platform is exactly what the pools, the player and the
 * house now hold.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { getBalancesPaise } from '../repositories/wallets.core.js';
import {
  ACCOUNTS, trialBalance, postMovement, stakeLostToHouse, housePaidWinnings,
} from '../repositories/treasury.js';
import {
  creditDeposit, creditReserve, creditWinnings, lockBetStake, releaseLockedStake,
  debitWinningsForWithdrawal, releaseWithdrawal, refundWithdrawal,
} from '../repositories/wallets.js';
import { createOrderRecord } from '../repositories/orders.record.js';
import { assignToTeam } from '../repositories/teamRouting.js';
import { releaseBuyHold, spendForBuy, creditSellToPool } from '../repositories/teamPools.js';
import { teamFixture } from '../../backend/tests/teamFixture.js';
import { moveDepositMoney } from '../../backend/domains/payment/depositCredit.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;
const id = (p) => `${p}_${RUN}_${seq += 1}`;

/**
 * The holdings that count. `lockedDepositAmount` / `lockedWinningsAmount` are
 * PROVENANCE counters recording which pocket a locked stake came from — they
 * shadow `lockedBalance` rather than holding value of their own, so summing
 * them would double-count every locked stake and make the invariant meaningless.
 */
const USER_HOLDINGS = ['depositBalance', 'winningsBalance', 'tokenBalance', 'reserveBalance', 'lockedBalance'];

describePg('Cross-domain money conservation', () => {
  const teams = teamFixture();
  const orders = [];
  let USER;

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => {
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await pgQuery('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await teams.cleanup();
    await closePg();
  });
  beforeEach(async () => {
    // The closed-books check compares the treasury against EVERY pool and the
    // player's wallet, so each scenario starts from empty books.
    await pgQuery(
      `TRUNCATE wallets, wallet_ledger, team_pool_entries, team_pools,
                treasury_entries, treasury_accounts RESTART IDENTITY CASCADE`,
    );
    USER = id('conserve-user');
  });

  /** What every team pool holds, and what the player holds, in paise. */
  async function holdings() {
    const { rows } = await pgQuery(
      'SELECT COALESCE(SUM(available_paise + held_paise), 0)::bigint AS p FROM team_pools');
    const user = await getBalancesPaise(USER);
    return {
      pools: Number(rows[0].p),
      user: USER_HOLDINGS.reduce((s, k) => s + user[k], 0),
      userDetail: user,
    };
  }

  /** THE assertion. Runs after every step, not just at the end. */
  async function closes(label) {
    const tb = await trialBalance();
    const h = await holdings();
    const t = tb.balances;
    expect(tb.conservesToZero, `treasury does not close at "${label}": ${JSON.stringify(t)}`).toBe(true);
    expect(tb.unexplained, `treasury balance without an entry at "${label}"`).toEqual([]);
    expect(t[ACCOUNTS.TEAM_FLOAT] ?? 0, `TEAM_FLOAT disagrees with the pools at "${label}"`).toBe(h.pools);
    expect(t[ACCOUNTS.USER_FLOAT] ?? 0, `USER_FLOAT disagrees with the wallet at "${label}"`).toBe(h.user);
    return { treasury: t, ...h };
  }

  /** A player order, through the one creation path. */
  async function order(type, tokens) {
    const orderId = id(type === 'DEPOSIT' ? 'MC_BUY' : 'MC_SELL');
    orders.push(orderId);
    return createOrderRecord({ orderId, userId: USER, type, tokenAmountRupees: tokens, currency: 'INR' });
  }
  const assign = async (o) => {
    const got = await assignToTeam(o, { cap: 3, buildSet: async () => ({}) });
    expect(got, JSON.stringify(got)).toMatchObject({ ok: true });
    return got;
  };
  const confirm = (o) => moveDepositMoney(o, { creditDeposit, creditReserve, releaseUTR: async () => {} });

  // ── The full chain, books closed at every step ─────────────────────────────
  it('conserves every paise across pool funding → buy → bet → settle → sell', async () => {
    // 1. A team buys 100,000 tokens from the platform: TOKEN_SUPPLY → TEAM_FLOAT.
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
    let s = await closes('pool funded');
    expect(s.pools).toBe(10_000_000);

    // 2. The player buys 20,000 tokens. Routing HOLDS them in the pool (a move
    //    inside the pool — nothing leaves it yet)…
    const buy = await order('DEPOSIT', 20_000);
    await assign(buy);
    s = await closes('buy held');
    expect(s.pools).toBe(10_000_000);

    //    …and the confirm spends the hold and credits the player, in the one
    //    owner every completing route goes through.
    expect(await confirm(buy)).toMatchObject({ ok: true });
    s = await closes('buy confirmed');
    expect(s.pools).toBe(8_000_000);
    expect(s.userDetail.depositBalance).toBe(2_000_000);

    // 3. A 15,000-token bet is staked and lost. The stake goes to the HOUSE.
    await lockBetStake(USER, {
      amountPaise: 1_500_000, txId: id('bet'), refId: 'bet-1',
      slices: [{ field: 'depositBalance', suffix: '_dep', amountPaise: 1_500_000, reason: 'Bet stake' }],
    });
    await closes('stake locked');            // internal to the player; nothing moved
    await releaseLockedStake(USER, {
      amount: 15_000, fromDeposit: 15_000, txId: id('settle'), reason: 'Bet lost',
    });
    await stakeLostToHouse(1_500_000, { movementId: id('lost'), refModel: 'Bet', refId: 'bet-1' });
    s = await closes('stake lost to house');
    expect(s.treasury[ACCOUNTS.HOUSE_RESERVE]).toBe(1_500_000);

    // 4. A later bet wins 12,000, paid out of the house reserve it was funded by.
    await creditWinnings(USER, 12_000, 'Bet win payout', 'Bet', 'bet-2', id('win'));
    await housePaidWinnings(1_200_000, { movementId: id('paid'), refModel: 'Bet', refId: 'bet-2' });
    s = await closes('winnings paid');
    expect(s.treasury[ACCOUNTS.HOUSE_RESERVE]).toBe(300_000);

    // 5. The player sells the 12,000: the stake is locked at admission, the
    //    order routed to a member, and on settlement the pool is credited the
    //    tokens the player gave up.
    const sell = await order('WITHDRAWAL', 12_000);
    await debitWinningsForWithdrawal(USER, 12_000, sell.orderId);
    await closes('sell admitted');           // winnings → locked; nothing left the player
    await assign(sell);
    expect((await creditSellToPool(sell.orderId)).ok).toBe(true);
    await releaseWithdrawal(USER, 12_000, sell.orderId);
    s = await closes('sell settled');
    expect(s.pools).toBe(9_200_000);
    expect(s.user).toBe(500_000);

    // The whole system, closed: what left the platform is exactly what the
    // pools, the player and the house now hold.
    const t = s.treasury;
    expect(t[ACCOUNTS.TOKEN_SUPPLY]).toBe(-10_000_000);
    expect(t[ACCOUNTS.TEAM_FLOAT] + t[ACCOUNTS.USER_FLOAT] + t[ACCOUNTS.HOUSE_RESERVE]).toBe(10_000_000);
    expect(team.teamId).toBeTruthy();
  });

  // ── The seams, under failure ───────────────────────────────────────────────
  it('conserves when a buy is cancelled after its tokens were held', async () => {
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000 });
    const buy = await order('DEPOSIT', 12_000);
    await assign(buy);
    await closes('held');

    // The order dies before the player is credited. The hold must come back
    // whole — this is the compensating path, and the place a half-applied
    // transfer would show up as created or destroyed tokens.
    expect((await releaseBuyHold(buy.orderId)).ok).toBe(true);
    const s = await closes('released');
    expect(s.pools).toBe(5_000_000);
    const { rows } = await pgQuery('SELECT available_paise, held_paise FROM team_pools WHERE team_id = $1', [team.teamId]);
    expect(Number(rows[0].available_paise)).toBe(5_000_000);
    expect(Number(rows[0].held_paise)).toBe(0);
  });

  it('conserves when a sell is refunded before it settled', async () => {
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 0 });
    // Winnings arrive from the house so the player has something to sell.
    await creditWinnings(USER, 11_000, 'seed', 'Bet', 'b', id('seed'));
    await postMovement({
      movementId: id('seed_house'), operation: 'HOUSE_WINNINGS_PAID',
      legs: { [ACCOUNTS.TOKEN_SUPPLY]: -1_100_000, [ACCOUNTS.USER_FLOAT]: 1_100_000 },
    });
    await closes('seeded');

    const sell = await order('WITHDRAWAL', 11_000);
    await debitWinningsForWithdrawal(USER, 11_000, sell.orderId);
    await assign(sell);
    await closes('sell assigned');

    // Dispute upheld: the member never paid. The stake returns; the pool was
    // never credited, so nothing comes out of it.
    await refundWithdrawal(USER, 11_000, sell.orderId);
    const s = await closes('refunded');
    expect(s.userDetail.winningsBalance).toBe(1_100_000);   // whole, back where it started
    expect(s.userDetail.lockedBalance).toBe(0);
    expect(s.pools).toBe(0);
  });

  it('conserves under a retry storm across BOTH sides at once', async () => {
    // Every movement of a confirm replayed 20 times concurrently. Idempotency is
    // proven per side elsewhere; what this adds is that the pool's gate and the
    // wallet's gate cannot disagree about whether a transfer happened.
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
    const buy = await order('DEPOSIT', 30_000);
    await assign(buy);

    const storm = (fn) => Promise.all(Array.from({ length: 20 }, fn));
    await storm(() => confirm(buy));
    const s = await closes('confirmed (20×)');

    expect(s.userDetail.depositBalance).toBe(3_000_000);   // once, not twenty times
    expect(s.pools).toBe(7_000_000);
    // And a straggler spend after the storm moves nothing.
    expect(await spendForBuy(buy.orderId)).toEqual({ ok: true, alreadyTaken: true });
    await closes('straggler');
  });

  it('catches a treasury posting that disagrees with the pools it describes', async () => {
    // The failure mode the closed-books check exists for: both ledgers
    // internally consistent, telling different stories about the same money.
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000 });

    // A payout posted to the treasury that no pool and no wallet performed.
    await postMovement({
      movementId: id('ghost'), operation: 'TEAM_BUY_PAID',
      legs: { [ACCOUNTS.TEAM_FLOAT]: -1_000_000, [ACCOUNTS.USER_FLOAT]: 1_000_000 },
    });

    const tb = await trialBalance();
    const h = await holdings();
    expect(tb.conservesToZero).toBe(true);                       // treasury still closes
    expect(tb.balances[ACCOUNTS.USER_FLOAT]).toBe(1_000_000);    // but claims the player holds 10,000
    expect(h.user).toBe(0);                                      // and the player holds nothing
    expect(tb.balances[ACCOUNTS.TEAM_FLOAT]).not.toBe(h.pools);  // and the pools still hold it all
  });
});
