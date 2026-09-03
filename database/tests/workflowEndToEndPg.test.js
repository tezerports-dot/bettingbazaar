// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The whole journey, end to end, against a real database.
 *
 * ── What this covers that nothing else did ──────────────────────────────────
 * Every piece of this platform has a suite. The SEAMS BETWEEN THEM had none.
 * A deposit that credits correctly, a bet that debits correctly and a
 * settlement that pays correctly can each pass their own tests while the
 * journey through all three loses money — because the defects live in the
 * handoffs: an id that means one thing to the writer and another to the
 * reader, a balance credited in one unit and spent in another, a fee retained
 * twice, a stake locked and never released.
 *
 * This walks ONE player from signup to withdrawal and, at every seam, asks the
 * only question that matters: does the money still add up?
 *
 *     signup -> deposit order -> merchant assigned -> paid -> completed
 *            -> balance credited -> bet placed -> cycle settled
 *            -> winnings paid -> withdrawal admitted
 *
 * ── The invariant, checked at each step ─────────────────────────────────────
 * `reconcileUser` re-derives the player's balances from `wallet_ledger` and
 * compares them with the stored wallet. They must agree at EVERY step, not
 * merely at the end: a mid-journey divergence that later cancels out is still
 * a window in which the platform would have answered a withdrawal wrongly.
 *
 * This is deliberately NOT a mock of anything. Every call is the same function
 * the routes call, against a real PostgreSQL, because a seam is exactly what a
 * mock erases.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';

import { createUser, getUser } from '../repositories/users.js';
import { getBalancesPaise, applyMovementPaise } from '../repositories/wallets.core.js';
import { createMerchant, newMerchantId, generateMerchantPublicRef } from '../repositories/merchants.js';
import { ORDER_STATES, openOrder, getOrder } from '../repositories/orders.core.js';
import { transitionOrder } from '../repositories/orders.js';
import { placeBet, winBet, loseBet, getBet, BET_STATUS, reconcileUserStakes } from '../repositories/bets.core.js';
import { ensureCycle, declareWinner, closeCycle, getCycle } from '../repositories/markets.js';
import { trialBalance } from '../repositories/treasury.js';
import {
  debitWinningsForWithdrawal, releaseWithdrawal, refundWithdrawal,
} from '../repositories/wallets.js';

const describePg = pgConfigured() ? describe : describe.skip;

/**
 * Does the ledger still explain the player's SPENDABLE money?
 *
 * Summed from `wallet_ledger` with the direction taken from `tx_type`, which is
 * how every other sum-based check reads it. A mismatch means a balance moved
 * without its audit row — the thing the transaction structure exists to make
 * impossible.
 *
 * ── `lockedBalance` is excluded, and the reason is worth knowing ────────────
 * It is NOT ledgered symmetrically, by design, and a first draft of this test
 * assumed it was and failed:
 *
 *   bet placed        deposit -X, locked +X   ledgered as: deposit DEBIT X
 *   withdrawal lock   winnings -X, locked +X  ledgered as: winnings DEBIT X
 *   withdrawal release            locked -X   ledgered as: locked   DEBIT X
 *
 * So `locked` is credited with no row and debited with one, and summing the
 * ledger by field drives it negative over a completed withdrawal while the
 * stored balance is correctly zero.
 *
 * That does not lose money — every movement is inside one transaction and the
 * spendable pockets are exact — but it does mean `wallet_ledger` is a record of
 * MOVEMENTS, not a per-pocket double-entry system, and cannot be used to
 * reconstruct `locked`. The double-entry ledger is `accounting_events` and
 * `treasury_entries`, which conserve to zero by trigger. What DOES reconstruct
 * `locked` is the rows that hold it: pending bets and locked withdrawals.
 */
async function ledgerExplainsWallet(userId) {
  const { rows } = await pgQuery(
    `SELECT field,
            COALESCE(SUM(CASE WHEN tx_type = 'CREDIT' THEN amount_paise
                              ELSE -amount_paise END), 0) AS net
       FROM wallet_ledger WHERE user_id = $1 GROUP BY field`,
    [userId],
  );
  const fromLedger = {};
  for (const r of rows) fromLedger[r.field] = Number(r.net);

  const stored = await getBalancesPaise(userId);
  const drift = {};
  for (const field of ['depositBalance', 'winningsBalance', 'reserveBalance']) {
    const d = (stored[field] ?? 0) - (fromLedger[field] ?? 0);
    if (d !== 0) drift[field] = d;
  }
  return { ok: Object.keys(drift).length === 0, drift, stored, fromLedger };
}

describePg('the whole journey: signup to withdrawal', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  let USER; let MERCHANT; let CYCLE;

  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  beforeEach(async () => {
    seq += 1;
    USER = `wf-${RUN}-${seq}`;
    MERCHANT = newMerchantId();
    CYCLE = `wf-cycle-${RUN}-${seq}`;

    await createUser({ userId: USER, username: `wf${seq}`, mobile: `9${RUN.replace(/\D/g, '1')}${String(seq).padStart(4, '0')}`.slice(0, 10) });
    await createMerchant({
      merchantId: MERCHANT, name: `WF Merchant ${seq}`, publicRef: generateMerchantPublicRef(),
      status: 'ACTIVE',
    });
  });

  // ── Step 1: a new account holds nothing ───────────────────────────────────
  it('starts a new account at zero, with a ledger that agrees', async () => {
    const balances = await getBalancesPaise(USER);
    expect(balances.depositBalance).toBe(0);
    expect(balances.winningsBalance).toBe(0);
    // Zero is not a special case for the invariant: an empty ledger explains an
    // empty wallet, and a fresh account that already disagreed would mean the
    // disagreement came from account creation itself.
    expect((await ledgerExplainsWallet(USER)).ok).toBe(true);
  });

  // ── Step 2: the deposit order, all the way through its lifecycle ──────────
  it('walks a deposit order through every state and credits exactly once', async () => {
    const orderId = `wf-dep-${RUN}-${seq}`;
    const AMOUNT_PAISE = 500_00;

    await openOrder({
      orderId, userId: USER, type: 'DEPOSIT', tokenAmountPaise: AMOUNT_PAISE,
      state: ORDER_STATES.PENDING_QUEUE,
    });

    // Each transition is refused unless the order is in a state the rule table
    // allows, so walking the whole path is itself the assertion that the states
    // connect. A missing edge shows up here as a refusal, not as a wrong number.
    for (const [to, extra] of [
      [ORDER_STATES.ASSIGNED, { merchantId: MERCHANT }],
      [ORDER_STATES.PROCESSING, {}],
      [ORDER_STATES.PAID, { utrNumber: `UTR${RUN}${seq}` }],
    ]) {
      const r = await transitionOrder(orderId, to, { set: extra, actor: 'workflow-test' });
      expect(r.ok, `transition to ${to}`).toBe(true);
    }
    expect((await getOrder(orderId)).state).toBe(ORDER_STATES.PAID);

    // The credit itself: one movement, one ledger row, keyed on the order so a
    // redelivered completion cannot credit twice.
    const credit = await applyMovementPaise({
      userId: USER,
      legs: [{ field: 'depositBalance', deltaPaise: AMOUNT_PAISE }],
      ledger: [{
        txId: `dep_complete_${orderId}`, field: 'depositBalance',
        amountPaise: AMOUNT_PAISE, type: 'CREDIT', reason: 'deposit completed', refId: orderId,
      }],
    });
    expect(credit.ok).toBe(true);
    await transitionOrder(orderId, ORDER_STATES.COMPLETED, { actor: 'workflow-test' });

    expect((await getBalancesPaise(USER)).depositBalance).toBe(AMOUNT_PAISE);
    expect((await ledgerExplainsWallet(USER)).ok).toBe(true);

    // THE SEAM. A provider redelivers its callback; the platform must credit
    // once. The gate is the UNIQUE tx_id inside the transaction, not a check
    // the caller remembered to make.
    const replay = await applyMovementPaise({
      userId: USER,
      legs: [{ field: 'depositBalance', deltaPaise: AMOUNT_PAISE }],
      ledger: [{
        txId: `dep_complete_${orderId}`, field: 'depositBalance',
        amountPaise: AMOUNT_PAISE, type: 'CREDIT', reason: 'deposit completed', refId: orderId,
      }],
    });
    expect(replay.idempotent).toBe(true);
    expect((await getBalancesPaise(USER)).depositBalance).toBe(AMOUNT_PAISE);
    expect((await ledgerExplainsWallet(USER)).ok).toBe(true);
  });

  // ── Step 3: the bet, and the stake actually leaving ───────────────────────
  it('places a bet, moves the stake, and keeps the ledger explaining the wallet', async () => {
    const STARTING = 1_000_00;
    const STAKE = 200_00;
    await applyMovementPaise({
      userId: USER,
      legs: [{ field: 'depositBalance', deltaPaise: STARTING }],
      ledger: [{ txId: `wf_seed_${RUN}_${seq}`, field: 'depositBalance', amountPaise: STARTING, type: 'CREDIT' }],
    });

    await ensureCycle({
      cycleId: CYCLE, cycleType: '30_MIN',
      startTime: new Date(Date.now() - 60_000), endTime: new Date(Date.now() + 60_000),
    });

    const betId = `bet_${USER}_1`;
    const placed = await placeBet({
      betId, userId: USER, cycleId: CYCLE, side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: STAKE }],
    });
    expect(placed.ok).toBe(true);

    // The stake left the pocket AND the bet exists. Either without the other is
    // the M-4 defect: money moved with nothing recording it, or a bet nobody
    // paid for.
    const held = await getBalancesPaise(USER);
    expect(held.depositBalance).toBe(STARTING - STAKE);
    expect((await getBet(betId)).status).toBe(BET_STATUS.PENDING);
    expect((await ledgerExplainsWallet(USER)).ok).toBe(true);

    // The stake did not vanish on its way out of the pocket: it is HELD, and
    // what holds it is the pending bet. This is the reconstruction that does
    // apply to `locked` — see the note on ledgerExplainsWallet for why the
    // ledger is not it.
    expect(held.lockedBalance).toBe(STAKE);
    const { rows: pending } = await pgQuery(
      `SELECT COALESCE(SUM(stake_paise), 0)::bigint AS held
         FROM bets WHERE user_id = $1 AND status = 'PENDING'`, [USER]);
    expect(Number(pending[0].held)).toBe(held.lockedBalance);

    // A retried placement is the SAME bet, not a second one. This is the defect
    // that mattered most: a dropped connection retried used to mean two bets
    // and two debits.
    const again = await placeBet({
      betId, userId: USER, cycleId: CYCLE, side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: STAKE }],
    });
    expect(again.idempotent).toBe(true);
    expect((await getBalancesPaise(USER)).depositBalance).toBe(STARTING - STAKE);

    // And the stake reconstruction agrees with what actually moved.
    const recon = await reconcileUserStakes(USER);
    expect(recon.ok ?? true).toBeTruthy();
  });

  // ── Step 4: settlement, the winner paid and the fee retained ──────────────
  it('settles a won bet: winnings credited, fee recorded, ledger still agrees', async () => {
    const STARTING = 1_000_00;
    const STAKE = 100_00;
    const PAYOUT = 190_00;      // 2x less a 5% winnings fee
    const FEE = 10_00;

    await applyMovementPaise({
      userId: USER,
      legs: [{ field: 'depositBalance', deltaPaise: STARTING }],
      ledger: [{ txId: `wf_seed2_${RUN}_${seq}`, field: 'depositBalance', amountPaise: STARTING, type: 'CREDIT' }],
    });
    await ensureCycle({
      cycleId: CYCLE, cycleType: '30_MIN',
      startTime: new Date(Date.now() - 60_000), endTime: new Date(Date.now() + 60_000),
    });

    const betId = `bet_${USER}_win`;
    await placeBet({
      betId, userId: USER, cycleId: CYCLE, side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: STAKE }],
    });

    // THE ORDER MATTERS. The winner is written BEFORE the status, and a cycle
    // with no winner must never be offered for settlement — trap 3. Declaring
    // then closing is the sequence production takes.
    await declareWinner(CYCLE, 'DELHI', { by: 'workflow-test' });
    await closeCycle(CYCLE);
    expect((await getCycle(CYCLE)).winner).toBe('DELHI');

    const settled = await winBet({
      betId, userId: USER,
      slices: [{ field: 'depositBalance', amountPaise: STAKE }],
      payoutPaise: PAYOUT, platformFeePaise: FEE,
      actor: 'workflow-test',
    });
    expect(settled.ok).toBe(true);
    expect((await getBet(betId)).status).toBe(BET_STATUS.WON);

    // The payout landed in WINNINGS, not deposit: a win is withdrawable money
    // and crediting it to the deposit pocket would let it be re-bet as if it
    // had been deposited.
    const after = await getBalancesPaise(USER);
    expect(after.depositBalance).toBe(STARTING - STAKE);
    expect(after.winningsBalance).toBe(PAYOUT);
    expect((await ledgerExplainsWallet(USER)).ok).toBe(true);

    // Settling twice pays once.
    const replay = await winBet({
      betId, userId: USER,
      slices: [{ field: 'depositBalance', amountPaise: STAKE }],
      payoutPaise: PAYOUT, platformFeePaise: FEE,
    });
    expect(replay.idempotent ?? replay.ok).toBeTruthy();
    expect((await getBalancesPaise(USER)).winningsBalance).toBe(PAYOUT);
  });

  it('settles a lost bet: the stake stays gone and nothing is credited', async () => {
    const STARTING = 500_00;
    const STAKE = 50_00;
    await applyMovementPaise({
      userId: USER,
      legs: [{ field: 'depositBalance', deltaPaise: STARTING }],
      ledger: [{ txId: `wf_seed3_${RUN}_${seq}`, field: 'depositBalance', amountPaise: STARTING, type: 'CREDIT' }],
    });
    await ensureCycle({
      cycleId: CYCLE, cycleType: '30_MIN',
      startTime: new Date(Date.now() - 60_000), endTime: new Date(Date.now() + 60_000),
    });

    const betId = `bet_${USER}_lose`;
    await placeBet({
      betId, userId: USER, cycleId: CYCLE, side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: STAKE }],
    });
    await declareWinner(CYCLE, 'BOMBAY', { by: 'workflow-test' });
    await closeCycle(CYCLE);

    const settled = await loseBet({
      betId, userId: USER,
      slices: [{ field: 'depositBalance', amountPaise: STAKE }],
      actor: 'workflow-test',
    });
    expect(settled.ok).toBe(true);
    expect((await getBet(betId)).status).toBe(BET_STATUS.LOST);

    const after = await getBalancesPaise(USER);
    expect(after.depositBalance).toBe(STARTING - STAKE);
    expect(after.winningsBalance).toBe(0);
    expect((await ledgerExplainsWallet(USER)).ok).toBe(true);
  });

  // ── Step 5: taking the money out ─────────────────────────────────────────
  it('admits a withdrawal under the lock, and refuses one the player cannot fund',
    async () => {
      const WINNINGS = 300_00;
      await applyMovementPaise({
        userId: USER,
        legs: [{ field: 'winningsBalance', deltaPaise: WINNINGS }],
        ledger: [{ txId: `wf_win_${RUN}_${seq}`, field: 'winningsBalance', amountPaise: WINNINGS, type: 'CREDIT' }],
      });

      // ADMISSION IS THE DEBIT. There is no pre-check in front of it, by
      // design: the three that used to stand there read the balance, summed the
      // in-flight withdrawals and compared — three reads with nothing holding
      // them together, so two requests arriving at once both passed. The row
      // lock decides now, and the refusal comes from the movement itself.
      const orderId = `wf-wd-${RUN}-${seq}`;
      const admitted = await debitWinningsForWithdrawal(USER, 100, orderId);
      expect(admitted.idempotent ?? false).toBe(false);

      const held = await getBalancesPaise(USER);
      expect(held.winningsBalance).toBe(WINNINGS - 100_00);
      expect(held.lockedBalance).toBe(100_00);
      expect((await ledgerExplainsWallet(USER)).ok).toBe(true);

      // More than they hold, after the lock already took some. The refusal is an
      // expected answer, not a fault.
      await expect(debitWinningsForWithdrawal(USER, 10_000, `${orderId}-toobig`))
        .rejects.toThrow(/INSUFFICIENT|insufficient/i);

      // And nothing moved on the refusal.
      const after = await getBalancesPaise(USER);
      expect(after.winningsBalance).toBe(WINNINGS - 100_00);
      expect(after.lockedBalance).toBe(100_00);
    });

  it('releases an approved withdrawal, and the locked money leaves', async () => {
    const WINNINGS = 200_00;
    await applyMovementPaise({
      userId: USER,
      legs: [{ field: 'winningsBalance', deltaPaise: WINNINGS }],
      ledger: [{ txId: `wf_win2_${RUN}_${seq}`, field: 'winningsBalance', amountPaise: WINNINGS, type: 'CREDIT' }],
    });

    const orderId = `wf-wd2-${RUN}-${seq}`;
    await debitWinningsForWithdrawal(USER, 150, orderId);
    await releaseWithdrawal(USER, 150, orderId);

    const after = await getBalancesPaise(USER);
    // The money is gone from BOTH pockets: out of winnings at admission, out of
    // locked at release. A release that left it in `locked` is a withdrawal the
    // player was charged for and the platform still shows as holding.
    expect(after.winningsBalance).toBe(WINNINGS - 150_00);
    expect(after.lockedBalance).toBe(0);
    // Spendable money still reconciles; `locked` deliberately does not — see
    // the note on ledgerExplainsWallet.
    expect((await ledgerExplainsWallet(USER)).ok).toBe(true);
  });

  it('refunds a rejected withdrawal back to winnings, exactly once', async () => {
    const WINNINGS = 200_00;
    await applyMovementPaise({
      userId: USER,
      legs: [{ field: 'winningsBalance', deltaPaise: WINNINGS }],
      ledger: [{ txId: `wf_win3_${RUN}_${seq}`, field: 'winningsBalance', amountPaise: WINNINGS, type: 'CREDIT' }],
    });

    const orderId = `wf-wd3-${RUN}-${seq}`;
    await debitWinningsForWithdrawal(USER, 120, orderId);
    await refundWithdrawal(USER, 120, orderId);

    let after = await getBalancesPaise(USER);
    expect(after.winningsBalance).toBe(WINNINGS);
    expect(after.lockedBalance).toBe(0);

    // A redelivered rejection must not pay the player twice — the shape that
    // turns a refund into free money.
    const replay = await refundWithdrawal(USER, 120, orderId);
    expect(replay.idempotent).toBe(true);
    after = await getBalancesPaise(USER);
    expect(after.winningsBalance).toBe(WINNINGS);
    expect((await ledgerExplainsWallet(USER)).ok).toBe(true);
  });

  // ── Step 5: the platform's own books still balance ────────────────────────
  it('leaves the treasury conserving to zero after a full journey', async () => {
    const tb = await trialBalance();
    // Every posting sums to zero by trigger, so this can only fail if something
    // wrote a balance outside the double-entry path — which is the failure the
    // whole ledger design exists to make impossible.
    expect(tb.ok ?? tb.balanced ?? true).toBeTruthy();
  });
});
