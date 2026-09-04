// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CROSS-DOMAIN money conservation — the whole chain, not one domain at a time.
 *
 * Every other suite here proves a domain in isolation: the wallet races
 * correctly, the merchant wallet races correctly, settlements transition
 * correctly. All of them can pass while money is still lost or created at the
 * SEAMS between them, because a domain test only ever sees one side of a
 * transfer. A merchant debit that dispenses ₹500 and a user credit of ₹450 are
 * each individually correct.
 *
 * This file walks the real flow —
 *
 *     admin issuance → merchant → user deposit → bet stake → settlement
 *                    → winnings → withdrawal → merchant → payout
 *
 * — and after EVERY step asserts one invariant:
 *
 *     Σ(every merchant pocket) + Σ(every user balance) + attributed sinks
 *         == total ever issued
 *
 * Tokens are conserved. They move between holders, or they enter by an explicit
 * admin issuance, or they leave to a named sink the test has to declare. There
 * is no fourth option, and a step that quietly creates or destroys value fails
 * here even when every domain suite is green.
 *
 * ── Two strengths of the same invariant ────────────────────────────────────
 * The scenarios below come in two kinds, and the difference is the point.
 *
 * The `sink`-based ones state where value went and check the arithmetic holds.
 * `sink` was originally a placeholder for money with nowhere to go — a losing
 * stake to the house, a commission to the platform — so those scenarios prove
 * only that THE TEST accounted for it. They remain because they exercise the
 * seams under cancellation, reversal and retry storms, where what matters is
 * that both legs of a transfer move together.
 *
 * The final scenario has NO sink. Every movement that leaves the user/merchant
 * books is posted to a real treasury account (postgres/treasuryPg.js), so the
 * invariant tightens to "THE BOOKS account for it" — checked two ways after
 * every step: the treasury trial balance sums to zero, and MERCHANT_FLOAT /
 * USER_FLOAT equal the actual wallet sums. The second is the claim no isolated
 * suite can make, and the test after it demonstrates the failure it catches.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  getMerchantBalances, adminIssueToMerchant, reconcileMerchant,
} from '../repositories/merchantWallets.core.js';
import {
  DIRECTIONS, openSettlement, completeSettlement, cancelSettlement,
  reconcileSettlements,
} from '../repositories/merchantSettlements.js';
import { getBalancesPaise } from '../repositories/wallets.core.js';
import {
  ACCOUNTS, trialBalance, getTreasuryBalances,
  mintToMerchantFloat, merchantDispensedToUser, userPaidMerchant,
  stakeLostToHouse, housePaidWinnings,
} from '../repositories/treasury.js';
import {
  creditDeposit, creditWinnings, lockBetStake, releaseLockedStake,
  debitWinningsForWithdrawal, releaseWithdrawal, refundWithdrawal,
} from '../repositories/wallets.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const MERCHANT = 'conserve-merchant';
const USER = 'conserve-user';

/**
 * The holdings that count. `lockedDepositAmount` / `lockedWinningsAmount` are
 * PROVENANCE counters recording which pocket a locked stake came from — they
 * shadow `lockedBalance` rather than holding value of their own, so summing
 * them would double-count every locked stake and make the invariant meaningless.
 */
const USER_HOLDINGS = ['depositBalance', 'winningsBalance', 'tokenBalance', 'reserveBalance', 'lockedBalance'];
const MERCHANT_HOLDINGS = ['available', 'reserved', 'settlement'];

/** Everything the platform's merchant and user books currently hold, in paise. */
async function systemTotal() {
  const merchant = await getMerchantBalances(MERCHANT);
  const user = await getBalancesPaise(USER);
  return {
    merchant: MERCHANT_HOLDINGS.reduce((s, k) => s + merchant[k], 0),
    user: USER_HOLDINGS.reduce((s, k) => s + user[k], 0),
    merchantDetail: merchant,
    userDetail: user,
  };
}

describePg('Cross-domain money conservation', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(
      `TRUNCATE merchant_settlement_transitions, merchant_settlements,
                merchant_wallets, merchant_wallet_entries,
                wallets, wallet_ledger,
                treasury_entries, treasury_accounts RESTART IDENTITY CASCADE`,
    );
  });

  /**
   * The running books for one scenario. `issued` only moves on an explicit
   * admin mint; `sink` only moves when the test declares that value left to a
   * place PostgreSQL does not yet model. Everything else must be a transfer.
   */
  function books() {
    let issued = 0;
    let sink = 0;
    const steps = [];

    return {
      issue(paise) { issued += paise; },
      /** Value left the merchant/user books to somewhere unmodelled. */
      toSink(paise, why) { sink += paise; steps.push(`sink +${paise} (${why})`); },
      /** Value returned from that unmodelled place. */
      fromSink(paise, why) { sink -= paise; steps.push(`sink -${paise} (${why})`); },

      /** THE assertion. Runs after every step, not just at the end. */
      async check(label) {
        const total = await systemTotal();
        steps.push(`${label}: merchant=${total.merchant} user=${total.user} sink=${sink} issued=${issued}`);
        expect(
          total.merchant + total.user + sink,
          `CONSERVATION BROKEN at "${label}".\n` +
          `  merchant pockets : ${JSON.stringify(total.merchantDetail)}\n` +
          `  user balances    : ${JSON.stringify(total.userDetail)}\n` +
          `  declared sink    : ${sink}\n` +
          `  total issued     : ${issued}\n` +
          `  trail            :\n    ${steps.join('\n    ')}`,
        ).toBe(issued);
        return total;
      },
    };
  }

  // ── The full chain ─────────────────────────────────────────────────────────
  it('conserves every paise across issuance → deposit → bet → settle → withdraw', async () => {
    const b = books();

    // 1. ADMIN ISSUANCE — ₹10,000 minted into the merchant's inventory. The
    //    only step in the whole scenario permitted to change the total.
    await adminIssueToMerchant({
      merchantId: MERCHANT, amountPaise: 1_000_000, txId: 'e2e_issue',
      actor: 'admin-1', reason: 'Treasury issuance',
    });
    b.issue(1_000_000);
    let t = await b.check('after admin issuance');
    expect(t.merchant).toBe(1_000_000);

    // 2. USER BUYS TOKENS — ₹2,000. The merchant reserves inventory, then
    //    dispenses it; the user is credited the SAME amount. This is the seam
    //    a per-domain test cannot see: two suites can both pass while these
    //    two numbers differ.
    await openSettlement({
      settlementId: 'ms_e2e_dep', merchantId: MERCHANT, orderId: 'order_dep',
      direction: DIRECTIONS.DEPOSIT, amountPaise: 200_000,
    });
    t = await b.check('after deposit reserved');
    expect(t.merchantDetail.reserved).toBe(200_000);

    await completeSettlement({ settlementId: 'ms_e2e_dep', merchantId: MERCHANT });
    // The tokens have LEFT the merchant. Until the user credit lands they are
    // in flight — declared as a sink so the invariant stays checkable mid-flight
    // rather than being suspended for the gap.
    b.toSink(200_000, 'dispensed, awaiting user credit');
    await b.check('after deposit completed (in flight)');

    await creditDeposit(USER, 2_000, 'order_dep');
    b.fromSink(200_000, 'user credited');
    t = await b.check('after user credited');
    expect(t.userDetail.depositBalance).toBe(200_000);
    expect(t.merchantDetail.available).toBe(800_000);

    // 3. BET STAKE — ₹500 moves from deposit into locked. A pure internal
    //    move: the total must not budge by a paise.
    await lockBetStake(USER, {
      amountPaise: 50_000, txId: 'e2e_bet', refId: 'bet-1',
      slices: [{ field: 'depositBalance', suffix: '_dep', amountPaise: 50_000, reason: 'Bet stake' }],
    });
    t = await b.check('after bet staked');
    expect(t.userDetail.lockedBalance).toBe(50_000);
    expect(t.userDetail.depositBalance).toBe(150_000);

    // 4. SETTLEMENT — the bet loses. The stake is released from `locked` and
    //    goes to the house, which PostgreSQL does not model yet.
    await releaseLockedStake(USER, {
      amount: 500, fromDeposit: 500, txId: 'e2e_bet_settle', reason: 'Bet lost — stake to house',
    });
    b.toSink(50_000, 'losing stake to house (NO PG TREASURY YET)');
    t = await b.check('after losing bet settled');
    expect(t.userDetail.lockedBalance).toBe(0);

    // 5. WINNINGS — a later bet wins ₹800. Value arrives from the house.
    await creditWinnings(USER, 800, 'Bet win payout', 'Bet', 'bet-2', 'e2e_win');
    b.fromSink(80_000, 'winnings from house (NO PG TREASURY YET)');
    t = await b.check('after winnings credited');
    expect(t.userDetail.winningsBalance).toBe(80_000);

    // 6. WITHDRAWAL REQUESTED — winnings → locked. Internal; total unchanged.
    await debitWinningsForWithdrawal(USER, 800, 'order_wd');
    t = await b.check('after withdrawal locked');
    expect(t.userDetail.lockedBalance).toBe(80_000);
    expect(t.userDetail.winningsBalance).toBe(0);

    // 7. MERCHANT SETTLES THE WITHDRAWAL — the user's locked stake is consumed
    //    and the merchant is owed the same amount. The second seam, and the
    //    mirror image of step 2.
    await openSettlement({
      settlementId: 'ms_e2e_wd', merchantId: MERCHANT, orderId: 'order_wd',
      direction: DIRECTIONS.WITHDRAWAL, amountPaise: 80_000,
    });
    // The merchant's books grew; the user's have not yet shrunk.
    b.toSink(-80_000, 'merchant owed, user stake not yet consumed');
    await b.check('after withdrawal held (in flight)');

    await releaseWithdrawal(USER, 800, 'order_wd');
    b.fromSink(-80_000, 'user stake consumed');
    t = await b.check('after user stake released');
    expect(t.userDetail.lockedBalance).toBe(0);
    expect(t.merchantDetail.settlement).toBe(80_000);

    // 8. HOLD EXPIRES — owed becomes spendable. Internal to the merchant.
    await completeSettlement({ settlementId: 'ms_e2e_wd', merchantId: MERCHANT });
    t = await b.check('after withdrawal settled');
    expect(t.merchantDetail.settlement).toBe(0);
    expect(t.merchantDetail.available).toBe(880_000);

    // ── Final books ─────────────────────────────────────────────────────────
    // ₹10,000 issued. ₹2,000 dispensed to the user, of which ₹500 was lost to
    // the house and ₹800 of winnings came back; the user withdrew ₹800 through
    // the merchant. Nothing vanished.
    const final = await systemTotal();
    expect(final.merchant + final.user).toBe(1_000_000 - 50_000 + 80_000);

    // And every domain's own books still explain themselves.
    expect((await reconcileMerchant(MERCHANT)).ok).toBe(true);
    expect((await reconcileSettlements(MERCHANT)).ok).toBe(true);
  });

  // ── The seams, under failure ───────────────────────────────────────────────
  it('conserves when a deposit is cancelled after reservation', async () => {
    const b = books();
    await adminIssueToMerchant({ merchantId: MERCHANT, amountPaise: 500_000, txId: 'c_issue' });
    b.issue(500_000);

    await openSettlement({
      settlementId: 'ms_c1', merchantId: MERCHANT, orderId: 'o_c1',
      direction: DIRECTIONS.DEPOSIT, amountPaise: 120_000,
    });
    await b.check('reserved');

    // The order dies before the user is credited. The reservation must come
    // back whole — this is the compensating path, and the place a half-applied
    // transfer would show up as created or destroyed tokens.
    await cancelSettlement({ settlementId: 'ms_c1', merchantId: MERCHANT, reason: 'order expired' });
    const t = await b.check('cancelled');
    expect(t.merchantDetail.available).toBe(500_000);
    expect(t.merchantDetail.reserved).toBe(0);
  });

  it('conserves when a withdrawal is reversed after the stake was taken', async () => {
    const b = books();
    await adminIssueToMerchant({ merchantId: MERCHANT, amountPaise: 500_000, txId: 'r_issue' });
    b.issue(500_000);
    await creditWinnings(USER, 1_000, 'seed', 'Bet', 'b', 'r_seed');
    b.fromSink(100_000, 'seeded winnings from house');
    await b.check('seeded');

    await debitWinningsForWithdrawal(USER, 1_000, 'o_r1');
    await openSettlement({
      settlementId: 'ms_r1', merchantId: MERCHANT, orderId: 'o_r1',
      direction: DIRECTIONS.WITHDRAWAL, amountPaise: 100_000,
    });
    b.toSink(-100_000, 'merchant owed, user stake not yet consumed');
    await b.check('held');

    // Dispute upheld inside the hold window: the merchant never sent the fiat.
    // The merchant's claim is cancelled AND the user's stake returns. Both legs
    // must happen or tokens are created on one side.
    await cancelSettlement({ settlementId: 'ms_r1', merchantId: MERCHANT, reason: 'dispute upheld' });
    b.fromSink(-100_000, 'merchant claim cancelled');
    await refundWithdrawal(USER, 1_000, 'o_r1');
    const t = await b.check('reversed');

    expect(t.userDetail.winningsBalance).toBe(100_000); // whole, back where it started
    expect(t.userDetail.lockedBalance).toBe(0);
    expect(t.merchantDetail.settlement).toBe(0);
  });

  it('conserves under a retry storm across BOTH domains at once', async () => {
    // Every operation in the chain replayed 20 times concurrently. Idempotency
    // is proven per-domain elsewhere; what this adds is that the two domains'
    // gates cannot disagree about whether a transfer happened.
    const b = books();
    await adminIssueToMerchant({ merchantId: MERCHANT, amountPaise: 1_000_000, txId: 's_issue' });
    b.issue(1_000_000);

    const storm = (fn) => Promise.all(Array.from({ length: 20 }, fn));

    await storm(() => openSettlement({
      settlementId: 'ms_s1', merchantId: MERCHANT, orderId: 'o_s1',
      direction: DIRECTIONS.DEPOSIT, amountPaise: 300_000,
    }));
    await b.check('reserved (20×)');

    await storm(() => completeSettlement({ settlementId: 'ms_s1', merchantId: MERCHANT }));
    b.toSink(300_000, 'dispensed, awaiting user credit');
    await b.check('completed (20×)');

    await storm(() => creditDeposit(USER, 3_000, 'o_s1'));
    b.fromSink(300_000, 'user credited');
    const t = await b.check('credited (20×)');

    expect(t.userDetail.depositBalance).toBe(300_000);  // once, not twenty times
    expect(t.merchantDetail.available).toBe(700_000);
    expect((await reconcileMerchant(MERCHANT)).ok).toBe(true);
  });

  // ── The books, closed ──────────────────────────────────────────────────────
  it('closes the books: the treasury explains every paise the other domains hold', async () => {
    // The version of the chain with NO `sink` variable. Every movement that
    // leaves the user/merchant books is posted to a real treasury account, so
    // the invariant stops being "the test accounted for it" and becomes "the
    // ledger accounts for it" — checked two ways after every step:
    //
    //   1. the treasury trial balance sums to zero (nothing invented)
    //   2. MERCHANT_FLOAT and USER_FLOAT equal the actual wallet sums
    //      (the treasury's view agrees with the domains it describes)
    //
    // (2) is the one no isolated suite can check: it is precisely the claim
    // that the platform's own books and its customers' books tell the same
    // story.
    const check = async (label) => {
      const tb = await trialBalance();
      const total = await systemTotal();
      const t = tb.balances;

      expect(tb.conservesToZero, `treasury does not close at "${label}": ${JSON.stringify(t)}`).toBe(true);
      expect(tb.unexplained, `treasury balance without an entry at "${label}"`).toEqual([]);
      expect(t[ACCOUNTS.MERCHANT_FLOAT], `MERCHANT_FLOAT disagrees with merchant wallets at "${label}"`)
        .toBe(total.merchant);
      expect(t[ACCOUNTS.USER_FLOAT], `USER_FLOAT disagrees with user wallets at "${label}"`)
        .toBe(total.user);
      return { treasury: t, total };
    };

    // 1. Mint ₹10,000 into merchant float, and issue the same into the wallet.
    await mintToMerchantFloat(1_000_000, { movementId: 'cb_mint', actor: 'admin-1' });
    await adminIssueToMerchant({
      merchantId: MERCHANT, amountPaise: 1_000_000, txId: 'cb_issue', reason: 'Treasury issuance',
    });
    await check('minted and issued');

    // 2. User buys ₹2,000 of tokens: reserve, dispense, credit — with the
    //    treasury recording the same transfer from merchant float to user float.
    await openSettlement({
      settlementId: 'ms_cb', merchantId: MERCHANT, orderId: 'o_cb',
      direction: DIRECTIONS.DEPOSIT, amountPaise: 200_000,
    });
    await completeSettlement({ settlementId: 'ms_cb', merchantId: MERCHANT });
    await creditDeposit(USER, 2_000, 'o_cb');
    await merchantDispensedToUser(200_000, { movementId: 'cb_dispense', refModel: 'PaymentOrder', refId: 'o_cb' });
    let s = await check('deposit dispensed');
    expect(s.treasury[ACCOUNTS.USER_FLOAT]).toBe(200_000);
    expect(s.treasury[ACCOUNTS.MERCHANT_FLOAT]).toBe(800_000);

    // 3. Bet lost. The stake goes to the HOUSE — a real account now, not a
    //    number the test was told to remember.
    await lockBetStake(USER, {
      amountPaise: 50_000, txId: 'cb_bet', refId: 'bet-1',
      slices: [{ field: 'depositBalance', suffix: '_dep', amountPaise: 50_000, reason: 'Bet stake' }],
    });
    await check('stake locked');            // internal to the user; nothing moved
    await releaseLockedStake(USER, {
      amount: 500, fromDeposit: 500, txId: 'cb_settle', reason: 'Bet lost',
    });
    await stakeLostToHouse(50_000, { movementId: 'cb_lost', refModel: 'Bet', refId: 'bet-1' });
    s = await check('stake lost to house');
    expect(s.treasury[ACCOUNTS.HOUSE_RESERVE]).toBe(50_000);

    // 4. A win, paid out of the house reserve it was funded by.
    await creditWinnings(USER, 300, 'Bet win payout', 'Bet', 'bet-2', 'cb_win');
    await housePaidWinnings(30_000, { movementId: 'cb_paid', refModel: 'Bet', refId: 'bet-2' });
    s = await check('winnings paid');
    expect(s.treasury[ACCOUNTS.HOUSE_RESERVE]).toBe(20_000);

    // 5. Withdrawal: user → merchant, both sides recorded.
    await debitWinningsForWithdrawal(USER, 300, 'o_cb_wd');
    await openSettlement({
      settlementId: 'ms_cb_wd', merchantId: MERCHANT, orderId: 'o_cb_wd',
      direction: DIRECTIONS.WITHDRAWAL, amountPaise: 30_000,
    });
    await releaseWithdrawal(USER, 300, 'o_cb_wd');
    await userPaidMerchant(30_000, { movementId: 'cb_wd', refModel: 'PaymentOrder', refId: 'o_cb_wd' });
    await completeSettlement({ settlementId: 'ms_cb_wd', merchantId: MERCHANT });
    s = await check('withdrawal settled');

    // The whole system, closed. Tokens in existence equal what the merchant and
    // user hold plus what the house took — no residue, nothing unaccounted.
    const t = s.treasury;
    expect(t[ACCOUNTS.TOKEN_SUPPLY]).toBe(-1_000_000);
    expect(
      t[ACCOUNTS.MERCHANT_FLOAT] + t[ACCOUNTS.USER_FLOAT] + t[ACCOUNTS.HOUSE_RESERVE],
    ).toBe(1_000_000);
    expect((await reconcileMerchant(MERCHANT)).ok).toBe(true);
    expect((await reconcileSettlements(MERCHANT)).ok).toBe(true);
  });

  it('catches a treasury posting that disagrees with the wallets it describes', async () => {
    // The failure mode the closed-books check exists for: both ledgers
    // internally consistent, telling different stories about the same money.
    await mintToMerchantFloat(500_000, { movementId: 'dis_mint' });
    await adminIssueToMerchant({ merchantId: MERCHANT, amountPaise: 500_000, txId: 'dis_issue' });

    // A dispense posted to the treasury that never happened in the wallets.
    await merchantDispensedToUser(100_000, { movementId: 'dis_ghost' });

    const t = await getTreasuryBalances();
    const total = await systemTotal();
    expect((await trialBalance()).conservesToZero).toBe(true);   // treasury still closes
    expect(t[ACCOUNTS.USER_FLOAT]).toBe(100_000);                // but claims the user holds ₹1,000
    expect(total.user).toBe(0);                                  // and the user holds nothing
    expect(t[ACCOUNTS.USER_FLOAT]).not.toBe(total.user);
  });
});
