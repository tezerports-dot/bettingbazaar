// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Domains 6, 7 and 8 — cycle settlement, casino callbacks, bonuses — against a
 * REAL PostgreSQL.
 *
 * Each domain has ONE property that is the reason it was built, and each gets
 * tests that fail if that property is lost:
 *
 *   CASINO      a ROLLBACK/REFUND must prove a matching prior debit. The Mongo
 *               path calls refundOrder() with no such check and no bound, so a
 *               provider that is buggy, replayed or hostile can MINT REAL MONEY
 *               by rolling back a round that was never bet on.
 *   SETTLEMENT  one settlement per cycle, ever, and a resumed pass settles the
 *               remaining bets against the side the FIRST pass recorded.
 *   BONUS       a bonus is a TRANSFER from a funded pool, not a mint — because
 *               a credit from nowhere breaks the closing invariant every
 *               conservation check downstream is computed from.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../client.js';
import { getBalancesPaise, applyDeltaPaise } from '../repositories/wallets.core.js';
import { BET_STATUS, placeBet, getBet } from '../repositories/bets.core.js';
import {
  CASINO_TX, recordCallback, getRound, getRoundTransactions,
  reconcileRound, findOverRefundedRounds,
} from '../repositories/casino.core.js';
import {
  SETTLEMENT_STATUS, openSettlement, settleBet, completeSettlement,
  voidSettlement, getCycleSettlement, reconcileSettlement, findIncompleteSettlements,
} from '../repositories/settlements.js';
import { grantBonus, clawBackBonus, getGrant, reconcileBonusPools, GRANT_STATUS } from '../repositories/bonuses.core.js';
import { ACCOUNTS, getTreasuryBalances, allocateFromHouse, trialBalance } from '../repositories/treasury.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const U = 'pg-d678-user';
const fund = (paise, key, userId = U, field = 'depositBalance') =>
  applyDeltaPaise({ userId, field, deltaPaise: paise, txId: key, type: 'CREDIT', reason: 'test' });
const bal = (userId = U) => getBalancesPaise(userId);
const slice = (field, amountPaise) => ({ field, amountPaise });

describePg('Domains 6-8 (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE casino_transactions, casino_rounds, cycle_settlements,
                            bonus_grants, bet_transitions, bets,
                            treasury_entries, treasury_accounts,
                            wallet_ledger, wallets RESTART IDENTITY CASCADE`);
  });

  // ══ DOMAIN 7: casino ══════════════════════════════════════════════════════
  describe('casino callbacks: a refund must prove its debit', () => {
    it('refuses a rollback for a round that was never bet on', async () => {
      // THE defect. On Mongo this call reaches
      // refundOrder(userId, amount, roundId, 'depositBalance') and credits real
      // money for a round that does not exist — free money for any provider
      // that asks, by accident or otherwise.
      const r = await recordCallback({
        txId: 'tx_ghost', roundId: 'round_ghost', userId: U,
        type: CASINO_TX.ROLLBACK, amountPaise: 50_000,
      });

      expect(r).toMatchObject({ ok: false, reason: 'no_prior_debit' });
      expect(await bal()).toMatchObject({ depositBalance: 0 });
      // And the refusal did not bring the round into being as a side effect.
      expect(await getRound('round_ghost')).toBeNull();
    });

    it('refuses a rollback LARGER than the bet it reverses', async () => {
      await fund(100_000, 'f1');
      await recordCallback({ txId: 'tx1', roundId: 'r1', userId: U, type: CASINO_TX.BET, amountPaise: 30_000 });

      const r = await recordCallback({
        txId: 'tx2', roundId: 'r1', userId: U, type: CASINO_TX.ROLLBACK, amountPaise: 50_000,
      });
      expect(r).toMatchObject({
        ok: false, reason: 'refund_exceeds_debit',
        debitedPaise: 30_000, refundedPaise: 0, requestedPaise: 50_000,
      });
      expect(await bal()).toMatchObject({ depositBalance: 70_000 });
    });

    it('refuses the SECOND of two partial rollbacks that would together exceed the bet', async () => {
      await fund(100_000, 'f1');
      await recordCallback({ txId: 'tx1', roundId: 'r1', userId: U, type: CASINO_TX.BET, amountPaise: 30_000 });
      await recordCallback({ txId: 'tx2', roundId: 'r1', userId: U, type: CASINO_TX.ROLLBACK, amountPaise: 20_000 });

      const r = await recordCallback({
        txId: 'tx3', roundId: 'r1', userId: U, type: CASINO_TX.ROLLBACK, amountPaise: 20_000,
      });
      // The running total is what makes this checkable — a per-callback check
      // against the bet alone would let any number of partial rollbacks through.
      expect(r).toMatchObject({ ok: false, reason: 'refund_exceeds_debit', refundedPaise: 20_000 });
      expect(await bal()).toMatchObject({ depositBalance: 90_000 });
    });

    it('allows a legitimate rollback up to exactly the amount bet', async () => {
      await fund(100_000, 'f1');
      await recordCallback({ txId: 'tx1', roundId: 'r1', userId: U, type: CASINO_TX.BET, amountPaise: 30_000 });
      const r = await recordCallback({
        txId: 'tx2', roundId: 'r1', userId: U, type: CASINO_TX.ROLLBACK, amountPaise: 30_000,
      });

      expect(r.ok).toBe(true);
      expect(await bal()).toMatchObject({ depositBalance: 100_000 });
      expect(await reconcileRound('r1')).toMatchObject({ ok: true });
    });

    it('the database refuses an over-refund even with the guard bypassed', async () => {
      await fund(100_000, 'f1');
      await recordCallback({ txId: 'tx1', roundId: 'r1', userId: U, type: CASINO_TX.BET, amountPaise: 30_000 });
      // The CHECK constraint, not the `if`. This is what makes the bound a
      // property of the DATA rather than of one function — the version that
      // survives the next caller.
      await expect(pgQuery(`UPDATE casino_rounds SET refunded_paise = 40000 WHERE round_id = 'r1'`))
        .rejects.toThrow(/casino_rounds_refund_bound/);
      expect(await findOverRefundedRounds()).toEqual([]);
    });

    it('a duplicate provider callback moves nothing further', async () => {
      await fund(100_000, 'f1');
      await recordCallback({ txId: 'tx1', roundId: 'r1', userId: U, type: CASINO_TX.BET, amountPaise: 30_000 });
      const again = await recordCallback({ txId: 'tx1', roundId: 'r1', userId: U, type: CASINO_TX.BET, amountPaise: 30_000 });

      // Providers retry hard; duplicates are routine, not exceptional.
      expect(again).toMatchObject({ ok: true, idempotent: true });
      expect(await bal()).toMatchObject({ depositBalance: 70_000 });
      expect(await getRoundTransactions('r1')).toHaveLength(1);
    });

    it('refuses a BET the player cannot cover, and records nothing', async () => {
      await fund(10_000, 'f1');
      expect(await recordCallback({ txId: 'tx1', roundId: 'r1', userId: U, type: CASINO_TX.BET, amountPaise: 30_000 }))
        .toMatchObject({ ok: false, reason: 'insufficient' });
      expect(await getRoundTransactions('r1')).toEqual([]);
      expect(await bal()).toMatchObject({ depositBalance: 10_000 });
    });

    it('50 racing copies of one callback apply exactly once', async () => {
      await fund(100_000, 'f1');
      const results = await Promise.all(Array.from({ length: 50 }, () =>
        recordCallback({ txId: 'tx_storm', roundId: 'r1', userId: U, type: CASINO_TX.BET, amountPaise: 30_000 })));

      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
      expect(await bal()).toMatchObject({ depositBalance: 70_000 });
    });

    it('concurrent rollbacks cannot both pass the bound', async () => {
      await fund(100_000, 'f1');
      await recordCallback({ txId: 'tx1', roundId: 'r1', userId: U, type: CASINO_TX.BET, amountPaise: 30_000 });

      // Two DIFFERENT provider ids, so idempotency does not save us — the
      // round's row lock is what has to. Without it both read
      // "refunded_paise = 0", both pass, and 60,000 comes back for a 30,000 bet.
      const [a, b] = await Promise.all([
        recordCallback({ txId: 'tx_a', roundId: 'r1', userId: U, type: CASINO_TX.ROLLBACK, amountPaise: 30_000 }),
        recordCallback({ txId: 'tx_b', roundId: 'r1', userId: U, type: CASINO_TX.ROLLBACK, amountPaise: 30_000 }),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect(await bal()).toMatchObject({ depositBalance: 100_000 });
      expect((await getRound('r1')).refundedPaise).toBe(30_000);
    });
  });

  // ══ DOMAIN 6: cycle settlement ════════════════════════════════════════════
  describe('cycle settlement', () => {
    const stake = [slice('depositBalance', 10_000)];
    const seedBet = (betId, side = 'DELHI') =>
      placeBet({ betId, userId: U, cycleId: 'cyc1', side, slices: stake });

    it('claims a cycle once; a second pass RESUMES rather than starting over', async () => {
      const first = await openSettlement({ cycleId: 'cyc1', winningSide: 'DELHI', betsTotal: 2 });
      expect(first).toMatchObject({ ok: true, resumed: false });

      const second = await openSettlement({ cycleId: 'cyc1', winningSide: 'DELHI', betsTotal: 2 });
      // Resuming an interrupted payout is the scenario this domain is built
      // around. A caller that treated `resumed` as an error would strand
      // exactly the cycles that need finishing.
      expect(second).toMatchObject({ ok: true, resumed: true });
      expect(second.settlement.settlementId).toBe(first.settlement.settlementId);
    });

    it('a resumed pass cannot change the declared result', async () => {
      await openSettlement({ cycleId: 'cyc1', winningSide: 'DELHI' });
      const resumed = await openSettlement({ cycleId: 'cyc1', winningSide: 'BOMBAY' });
      // Otherwise a cycle whose result was corrected mid-settlement pays some
      // bets on one result and the rest on another. Correcting a result is a
      // void-and-resettle, not an in-place edit.
      expect(resumed.settlement.winningSide).toBe('DELHI');
    });

    it('settles bets and accounts for them on the run', async () => {
      await fund(100_000, 'f1');
      await seedBet('b1'); await seedBet('b2');
      const { settlement } = await openSettlement({ cycleId: 'cyc1', winningSide: 'DELHI', betsTotal: 2 });

      await settleBet({ settlementId: settlement.settlementId, cycleId: 'cyc1', betId: 'b1', userId: U, slices: stake, won: true, payoutPaise: 20_000 });
      await settleBet({ settlementId: settlement.settlementId, cycleId: 'cyc1', betId: 'b2', userId: U, slices: stake, won: false });

      const run = await getCycleSettlement('cyc1');
      expect(run).toMatchObject({ betsSettled: 2, payoutPaise: 20_000 });
      expect(await reconcileSettlement('cyc1')).toMatchObject({ ok: true });
    });

    it('a resumed pass does not re-count bets an earlier pass settled', async () => {
      await fund(100_000, 'f1');
      await seedBet('b1');
      const { settlement } = await openSettlement({ cycleId: 'cyc1', winningSide: 'DELHI', betsTotal: 1 });
      const args = { settlementId: settlement.settlementId, cycleId: 'cyc1', betId: 'b1', userId: U, slices: stake, won: true, payoutPaise: 20_000 };

      await settleBet(args);
      await settleBet(args);   // the resumed pass re-offers it

      // Counters advance only when the transition actually happened, which is
      // what keeps them meaningful across a resume instead of inflating.
      expect(await getCycleSettlement('cyc1')).toMatchObject({ betsSettled: 1, payoutPaise: 20_000 });
      expect(await bal()).toMatchObject({ winningsBalance: 20_000 });
    });

    it('completes once, however many passes finish at the same moment', async () => {
      await openSettlement({ cycleId: 'cyc1', winningSide: 'DELHI' });
      const results = await Promise.all(Array.from({ length: 10 }, () => completeSettlement({ cycleId: 'cyc1' })));

      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
      expect((await getCycleSettlement('cyc1')).status).toBe(SETTLEMENT_STATUS.COMPLETED);
    });

    it('voiding returns every outstanding stake', async () => {
      await fund(100_000, 'f1');
      await seedBet('b1'); await seedBet('b2');
      await openSettlement({ cycleId: 'cyc1', winningSide: 'DELHI' });

      const r = await voidSettlement({
        cycleId: 'cyc1',
        bets: [{ betId: 'b1', userId: U, slices: stake }, { betId: 'b2', userId: U, slices: stake }],
      });
      expect(r.returned).toEqual(['b1', 'b2']);
      expect(await bal()).toMatchObject({ depositBalance: 100_000, lockedBalance: 0 });
      expect((await getBet('b1')).status).toBe(BET_STATUS.VOID);
    });

    it('finds a run that says COMPLETED while bets are still pending', async () => {
      await fund(100_000, 'f1');
      await seedBet('b1'); await seedBet('b2');
      const { settlement } = await openSettlement({ cycleId: 'cyc1', winningSide: 'DELHI', betsTotal: 2 });
      await settleBet({ settlementId: settlement.settlementId, cycleId: 'cyc1', betId: 'b1', userId: U, slices: stake, won: false });
      await completeSettlement({ cycleId: 'cyc1' });   // stopped early

      // The strongest statement this domain makes: b2's stake is locked with
      // nothing left to release it.
      expect(await findIncompleteSettlements())
        .toEqual([{ cycleId: 'cyc1', status: 'COMPLETED', betsSettled: 1, stillPending: 1 }]);
    });
  });

  // ══ DOMAIN 8: bonuses and commissions ═════════════════════════════════════
  describe('bonuses are a transfer from a funded pool, not a mint', () => {
    /** Fund a pool the way revenue actually would: out of house reserve. */
    const fundPool = (pool, paise, key) =>
      allocateFromHouse(paise, pool, { movementId: key, reason: 'test pool funding' });

    it('pays the user AND takes it out of the pool, keeping the books closed', async () => {
      await fundPool(ACCOUNTS.BONUS_POOL, 50_000, 'pool1');

      const r = await grantBonus({ grantId: 'g1', userId: U, kind: 'SIGNUP', amountPaise: 20_000 });
      expect(r.ok).toBe(true);
      expect(await bal()).toMatchObject({ depositBalance: 20_000 });

      const treasury = await getTreasuryBalances();
      expect(treasury[ACCOUNTS.BONUS_POOL]).toBe(30_000);   // 50k funded − 20k paid
      expect(treasury[ACCOUNTS.USER_FLOAT]).toBe(20_000);
      // The whole point. A credit from nowhere would leave this non-zero and
      // every downstream conservation check failing for the wrong reason.
      expect(await trialBalance()).toMatchObject({ ok: true, conservesToZero: true });
    });

    it('lands a COMMISSION in winnings and a bonus in deposit', async () => {
      await fundPool(ACCOUNTS.COMMISSION_POOL, 50_000, 'p1');
      await fundPool(ACCOUNTS.BONUS_POOL, 50_000, 'p2');

      await grantBonus({ grantId: 'g_com', userId: U, kind: 'COMMISSION', amountPaise: 10_000 });
      await grantBonus({ grantId: 'g_sig', userId: U, kind: 'SIGNUP', amountPaise: 5_000 });

      // A commission is EARNED, so it is withdrawable. A signup bonus is not —
      // one that could be withdrawn immediately is a cash-out route, and that
      // is the entire reason the two pockets exist.
      expect(await bal()).toMatchObject({ winningsBalance: 10_000, depositBalance: 5_000 });
    });

    it('a replayed grant pays nothing further', async () => {
      await fundPool(ACCOUNTS.BONUS_POOL, 50_000, 'p1');
      await grantBonus({ grantId: 'g1', userId: U, kind: 'SIGNUP', amountPaise: 20_000 });
      const again = await grantBonus({ grantId: 'g1', userId: U, kind: 'SIGNUP', amountPaise: 20_000 });

      expect(again).toMatchObject({ ok: true, idempotent: true });
      expect(await bal()).toMatchObject({ depositBalance: 20_000 });
      expect((await getTreasuryBalances())[ACCOUNTS.BONUS_POOL]).toBe(30_000);
    });

    it('30 racing copies of one grant pay exactly once', async () => {
      await fundPool(ACCOUNTS.BONUS_POOL, 100_000, 'p1');
      const results = await Promise.all(Array.from({ length: 30 }, () =>
        grantBonus({ grantId: 'g_storm', userId: U, kind: 'SIGNUP', amountPaise: 10_000 })));

      expect(results.every((r) => r.ok)).toBe(true);
      expect(await bal()).toMatchObject({ depositBalance: 10_000 });
      expect(await trialBalance()).toMatchObject({ ok: true });
    });

    it('claws back to the pool and KEEPS both movements in the history', async () => {
      await fundPool(ACCOUNTS.BONUS_POOL, 50_000, 'p1');
      await grantBonus({ grantId: 'g1', userId: U, kind: 'SIGNUP', amountPaise: 20_000 });

      const r = await clawBackBonus({ grantId: 'g1', userId: U, reason: 'fraud' });
      expect(r.ok).toBe(true);
      expect(await bal()).toMatchObject({ depositBalance: 0 });

      // The grant row survives, marked. "Was this user ever given a signup
      // bonus?" is the question fraud review asks, and deleting the row
      // destroys the answer.
      const grant = await getGrant('g1');
      expect(grant).toMatchObject({ status: GRANT_STATUS.CLAWED_BACK, amountPaise: 20_000, kind: 'SIGNUP' });
      expect((await getTreasuryBalances())[ACCOUNTS.BONUS_POOL]).toBe(50_000);
    });

    it('a clawback may drive the balance negative — the money may be spent', async () => {
      await fundPool(ACCOUNTS.BONUS_POOL, 50_000, 'p1');
      await grantBonus({ grantId: 'g1', userId: U, kind: 'SIGNUP', amountPaise: 20_000 });
      // Spent it.
      await applyDeltaPaise({ userId: U, field: 'depositBalance', deltaPaise: -20_000, txId: 'spend', type: 'DEBIT', reason: 'spent' });

      expect((await clawBackBonus({ grantId: 'g1', userId: U })).ok).toBe(true);
      // Refusing to record a reversal that has already happened in the real
      // world is worse than recording an overdraft.
      expect((await bal()).depositBalance).toBe(-20_000);
    });

    it('a replayed clawback takes nothing further', async () => {
      await fundPool(ACCOUNTS.BONUS_POOL, 50_000, 'p1');
      await grantBonus({ grantId: 'g1', userId: U, kind: 'SIGNUP', amountPaise: 20_000 });
      await clawBackBonus({ grantId: 'g1', userId: U });
      const again = await clawBackBonus({ grantId: 'g1', userId: U });

      expect(again).toMatchObject({ ok: true, idempotent: true });
      expect((await bal()).depositBalance).toBe(0);
    });

    it('refuses an unknown bonus kind rather than guessing a pool', async () => {
      await expect(grantBonus({ grantId: 'g1', userId: U, kind: 'MYSTERY', amountPaise: 1 }))
        .rejects.toThrow(/Unknown bonus kind/);
    });

    it('reconciles grants against what the pools actually paid', async () => {
      await fundPool(ACCOUNTS.BONUS_POOL, 100_000, 'p1');
      await grantBonus({ grantId: 'g1', userId: U, kind: 'SIGNUP', amountPaise: 20_000 });
      await grantBonus({ grantId: 'g2', userId: U, kind: 'CASHBACK', amountPaise: 5_000 });
      await clawBackBonus({ grantId: 'g2', userId: U });

      const r = await reconcileBonusPools();
      // The clawed-back grant was paid out and returned, so the treasury's
      // gross payout exceeds the outstanding grants by exactly that amount.
      expect(r.ok).toBe(true);
      expect(r.pools.find((p) => p.pool === ACCOUNTS.BONUS_POOL))
        .toMatchObject({ grantsPaise: 20_000, clawedBackPaise: 5_000, driftPaise: 0 });
    });
  });

  // ══ Pool safety across all three ══════════════════════════════════════════
  it('40 mixed operations across the three domains neither deadlock nor leak a client', async () => {
    const pool = await getPool();
    const users = Array.from({ length: 20 }, (_, i) => `pg-d678-u${i}`);
    await Promise.all(users.map((u, i) => fund(100_000, `mf_${i}`, u)));
    await allocateFromHouse(200_000, ACCOUNTS.BONUS_POOL, { movementId: 'mix_pool' });

    const started = Date.now();
    await Promise.all(users.flatMap((u, i) => [
      recordCallback({ txId: `mx_c${i}`, roundId: `mr${i}`, userId: u, type: CASINO_TX.BET, amountPaise: 10_000 }),
      grantBonus({ grantId: `mx_g${i}`, userId: u, kind: 'SIGNUP', amountPaise: 5_000 }),
    ]));

    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
    // Postgres breaks a deadlock with a 1s timeout, so a run that hit one and
    // retried takes seconds longer than one that simply queued.
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(await trialBalance()).toMatchObject({ conservesToZero: true });
  });
});
