// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which POCKETS a casino stake draws on, and where a reversal puts each part
 * back, against a REAL PostgreSQL.
 *
 * Owner, 2026-10-08 (DECISION_LOG): asked "Let casino bets use winnings once
 * the deposit balance runs out?", the answer was "Yes, like boards": a casino
 * stake takes from the pockets a board bet takes from, in the same order, and
 * a rollback or refund returns each part to the pocket it came from. A casino
 * BET used to debit `depositBalance` alone, so casino winnings (paid into
 * winnings since 2026-10-07) could never be staked back into a casino game.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 * A round's stake is split by THE board rule (`splitStakeMinor`, the
 * arithmetic `computeBetFundingPlan` applies to a board bet): the reserve
 * share (`SystemConfig.betReservePercent`, floored, as far as the reserve
 * covers it), then deposit, then winnings — decided from the wallet row the
 * transaction holds locked. The round records each part (`debited_<pocket>`),
 * and for every pocket the player's balance moved by exactly
 * `refunded_<pocket> − debited_<pocket>` (plus, for winnings, what the round
 * credited). No reversal returns more to a pocket than the round took from it,
 * and a partial one returns the reserve share first, then deposit, then
 * winnings: a rollback never makes a deposit withdrawable.
 *
 * Every case asserts the pockets, and where money moved, the ledger rows the
 * player's History shows and the round's per-pocket record.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { getBalancesPaise } from '../repositories/wallets.core.js';
import { applyProviderCallback, spendableBalance } from '../repositories/casino.js';
import { getRound } from '../repositories/casino.core.js';
import { openSession } from '../repositories/games.js';
import { applyConfig, getConfig } from '../repositories/config.js';
import { computeBetFundingPlan } from '../../backend/domains/risk/riskValidation.service.js';
import { fundWallet, refusedBy } from './_funding.js';

const describePg = pgConfigured() ? describe : describe.skip;

// This run's own provider and players: nothing here truncates a shared table,
// so every assertion is about rows this file wrote (trap 10).
const RUN = Math.random().toString(36).slice(2, 8);
const PROVIDER = `cbet-${RUN}`;
const OTHER_PROVIDER = `cbet-other-${RUN}`;
let seq = 0;
const tid = () => `cbet-${RUN}-tx-${++seq}`;
const rid = () => `cbet-${RUN}-r-${++seq}`;

// 10 %, so a reserve share is a round number. Set here and put back (S19).
const RESERVE_PERCENT = 10;

/** A player with a live session and the given pockets, funded the way the platform funds. */
async function player({ deposit = 0, winnings = 0, reserve = 0 } = {}) {
  const userId = `pg-cbet-${RUN}-${++seq}`;
  if (deposit) await fundWallet(userId, deposit, `cbet-fund-dep-${userId}`, 'depositBalance');
  if (winnings) await fundWallet(userId, winnings, `cbet-fund-win-${userId}`, 'winningsBalance');
  if (reserve) await fundWallet(userId, reserve, `cbet-fund-res-${userId}`, 'reserveBalance');
  for (const providerKey of [PROVIDER, OTHER_PROVIDER]) {
    await openSession({ sessionId: `s-${providerKey}-${userId}`, userId, providerKey, ttlMinutes: 240 });
  }
  return userId;
}

const call = (userId, over) => applyProviderCallback({
  txId: tid(), userId, providerKey: PROVIDER, gameId: 'g', amountRupees: 100, ...over,
});
const pockets = async (userId) => {
  const w = await getBalancesPaise(userId);
  return { deposit: w.depositBalance, winnings: w.winningsBalance, reserve: w.reserveBalance, locked: w.lockedBalance };
};
const roundOf = (roundId, userId, providerKey = PROVIDER) => getRound(roundId, { userId, providerKey });
/**
 * Every ledger row one callback wrote, pocket by pocket: the first part under
 * `casino_<txId>` (the movement's key), each further part under
 * `casino:<pocket>:<txId>`.
 */
const POCKETS = ['depositBalance', 'winningsBalance', 'reserveBalance'];
const ledgerOf = async (txId) => (await pgQuery(
  `SELECT field, tx_type, amount_paise::int AS amount FROM wallet_ledger
    WHERE tx_id = ANY($1) ORDER BY field`,
  [[`casino_${txId}`, ...POCKETS.map((f) => `casino:${f}:${txId}`)]])).rows;
const treasuryLegs = async (txId) => Object.fromEntries((await pgQuery(
  `SELECT account, SUM(amount_paise)::int AS paise FROM treasury_entries
    WHERE movement_id = $1 GROUP BY account`, [`casino_${txId}`])).rows.map((r) => [r.account, r.paise]));
const callbackRows = async (userId, roundId) => (await pgQuery(
  `SELECT count(*)::int AS n FROM casino_transactions WHERE user_id = $1 AND round_id = $2`,
  [userId, roundId])).rows[0].n;

describePg('a casino stake draws on the pockets a board bet draws on (PostgreSQL)', () => {
  let baseline;
  beforeAll(async () => {
    await applySchema();
    baseline = await getConfig('system', { fresh: true });
    await applyConfig({ scope: 'system', actor: 'test-setup', patch: { betReservePercent: RESERVE_PERCENT } });
  });
  afterAll(async () => {
    await applyConfig({
      scope: 'system', actor: 'test-restore', patch: { betReservePercent: baseline.betReservePercent },
    }).catch(() => {});
    await closePg();
  });

  it('a stake the deposit cannot cover takes the rest from winnings, plus its reserve share — the board\'s split', async () => {
    const u = await player({ deposit: 5_000, winnings: 10_000, reserve: 2_000 });
    const roundId = rid();
    const betTx = tid();
    const bet = await call(u, { txId: betTx, roundId, type: 'BET', amountRupees: 100 });
    expect(bet).toMatchObject({ ok: true, idempotent: false });

    // 10 % of ₹100 from the reserve, the other ₹90 from deposit (all ₹50 of
    // it) and then winnings (₹40).
    expect(await pockets(u)).toEqual({ deposit: 0, winnings: 6_000, reserve: 1_000, locked: 0 });

    // The same split a BOARD bet takes from these pockets, by the board's own
    // function — not a second copy of the rule.
    const board = computeBetFundingPlan({
      amount: 100, reservePercent: RESERVE_PERCENT,
      availableDeposit: 50, availableWinnings: 100, availableReserve: 20,
    });
    const round = await roundOf(roundId, u);
    expect(round.debitedByPocket).toEqual({
      depositBalance: board.fromDepositMinor,
      winningsBalance: board.fromWinningsMinor,
      reserveBalance: board.fromReserveMinor,
    });
    expect(round.debitedByPocket).toEqual({ depositBalance: 5_000, winningsBalance: 4_000, reserveBalance: 1_000 });
    expect(round).toMatchObject({ debitedPaise: 10_000, refundedPaise: 0 });

    // History shows one row per pocket that moved.
    expect(await ledgerOf(betTx)).toEqual([
      { field: 'depositBalance', tx_type: 'DEBIT', amount: 5_000 },
      { field: 'reserveBalance', tx_type: 'DEBIT', amount: 1_000 },
      { field: 'winningsBalance', tx_type: 'DEBIT', amount: 4_000 },
    ]);
    // The house took the whole stake, in the same transaction.
    const legs = await treasuryLegs(betTx);
    expect(legs.USER_FLOAT).toBe(-10_000);
    expect(legs.HOUSE_RESERVE).toBe(10_000);
  });

  it('a stake the deposit alone covers takes nothing from winnings (the opposite behaviour)', async () => {
    const u = await player({ deposit: 100_000, winnings: 50_000 });
    const betTx = tid();
    expect((await call(u, { txId: betTx, roundId: rid(), type: 'BET', amountRupees: 100 })).ok).toBe(true);
    // No reserve to draw on: its share shifts to the deposit, as on a board.
    expect(await pockets(u)).toEqual({ deposit: 90_000, winnings: 50_000, reserve: 0, locked: 0 });
    expect(await ledgerOf(betTx)).toEqual([{ field: 'depositBalance', tx_type: 'DEBIT', amount: 10_000 }]);

    // With a reserve: its share, the rest from deposit, winnings untouched.
    const v = await player({ deposit: 100_000, winnings: 50_000, reserve: 5_000 });
    expect((await call(v, { roundId: rid(), type: 'BET', amountRupees: 100 })).ok).toBe(true);
    expect(await pockets(v)).toEqual({ deposit: 91_000, winnings: 50_000, reserve: 4_000, locked: 0 });
  });

  it('a stake both pockets together cannot cover is refused and moves nothing', async () => {
    // ₹180 in the wallet, but only 10 % of a stake may come from the reserve:
    // a ₹100 stake needs ₹90 of deposit and winnings, and there are ₹80.
    const u = await player({ deposit: 5_000, winnings: 3_000, reserve: 10_000 });
    const roundId = rid();
    const betTx = tid();
    expect(await call(u, { txId: betTx, roundId, type: 'BET', amountRupees: 100 }))
      .toMatchObject({ ok: false, reason: 'insufficient' });

    expect(await pockets(u)).toEqual({ deposit: 5_000, winnings: 3_000, reserve: 10_000, locked: 0 });
    expect(await roundOf(roundId, u)).toBeNull();
    expect(await callbackRows(u, roundId)).toBe(0);
    expect(await ledgerOf(betTx)).toEqual([]);
    expect(await treasuryLegs(betTx)).toEqual({});
  });

  it('the provider is told exactly what a BET can draw on: that much is taken, a paisa more is refused', async () => {
    // Largest A with A − ⌊A/10⌋ ≤ ₹80 of deposit and winnings: ₹88.88.
    const funds = { deposit: 5_000, winnings: 3_000, reserve: 10_000 };
    const u = await player(funds);
    expect(await spendableBalance(u)).toBe(88.88);

    const over = await call(u, { roundId: rid(), type: 'BET', amountRupees: 88.89 });
    expect(over).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(await pockets(u)).toEqual({ ...funds, locked: 0 });

    const exact = await call(u, { roundId: rid(), type: 'BET', amountRupees: 88.88 });
    expect(exact).toMatchObject({ ok: true, idempotent: false });
    expect(await pockets(u)).toEqual({ deposit: 0, winnings: 0, reserve: 10_000 - 888, locked: 0 });
    // And what the provider is told now is what is left to stake: nothing,
    // because a stake cannot be all reserve.
    expect(exact.balanceRupees).toBe(0);
    expect(await spendableBalance(u)).toBe(0);
  });

  it('a partial rollback returns the reserve share first, then deposit, and winnings last', async () => {
    const u = await player({ deposit: 5_000, winnings: 10_000, reserve: 2_000 });
    const roundId = rid();
    await call(u, { roundId, type: 'BET', amountRupees: 100 }); // reserve 1,000 · deposit 5,000 · winnings 4,000

    const first = tid();
    expect((await call(u, { txId: first, roundId, type: 'ROLLBACK', amountRupees: 3 })).ok).toBe(true);
    expect(await pockets(u)).toEqual({ deposit: 0, winnings: 6_000, reserve: 1_300, locked: 0 });
    expect(await ledgerOf(first)).toEqual([{ field: 'reserveBalance', tx_type: 'CREDIT', amount: 300 }]);

    const second = tid();
    expect((await call(u, { txId: second, roundId, type: 'REFUND', amountRupees: 50 })).ok).toBe(true);
    // The rest of the reserve share (₹7), then ₹43 of the ₹50 deposit part.
    // Winnings still untouched: a rollback reaches them last.
    expect(await pockets(u)).toEqual({ deposit: 4_300, winnings: 6_000, reserve: 2_000, locked: 0 });
    expect(await ledgerOf(second)).toEqual([
      { field: 'depositBalance', tx_type: 'CREDIT', amount: 4_300 },
      { field: 'reserveBalance', tx_type: 'CREDIT', amount: 700 },
    ]);

    const third = tid();
    expect((await call(u, { txId: third, roundId, type: 'ROLLBACK', amountRupees: 47 })).ok).toBe(true);
    expect(await pockets(u)).toEqual({ deposit: 5_000, winnings: 10_000, reserve: 2_000, locked: 0 });
    expect(await ledgerOf(third)).toEqual([
      { field: 'depositBalance', tx_type: 'CREDIT', amount: 700 },
      { field: 'winningsBalance', tx_type: 'CREDIT', amount: 4_000 },
    ]);

    const round = await roundOf(roundId, u);
    expect(round.refundedByPocket).toEqual(round.debitedByPocket);
    expect(round).toMatchObject({ debitedPaise: 10_000, refundedPaise: 10_000 });

    // And nothing past the stake: the round's bound still holds.
    expect(await call(u, { roundId, type: 'ROLLBACK', amountRupees: 1 }))
      .toMatchObject({ ok: false, reason: 'refund_exceeds_debit' });
  });

  it('a full rollback or refund returns each part to the pocket it came from — never a cash-out', async () => {
    for (const type of ['ROLLBACK', 'REFUND']) {
      const start = { deposit: 5_000, winnings: 10_000, reserve: 2_000 };
      const u = await player(start);
      const roundId = rid();
      await call(u, { roundId, type: 'BET', amountRupees: 100 });
      const back = tid();
      expect((await call(u, { txId: back, roundId, type, amountRupees: 100 })).ok).toBe(true);

      expect(await pockets(u)).toEqual({ ...start, locked: 0 });
      expect(await ledgerOf(back)).toEqual([
        { field: 'depositBalance', tx_type: 'CREDIT', amount: 5_000 },
        { field: 'reserveBalance', tx_type: 'CREDIT', amount: 1_000 },
        { field: 'winningsBalance', tx_type: 'CREDIT', amount: 4_000 },
      ]);
      // The house gave back what it took.
      expect((await treasuryLegs(back)).USER_FLOAT).toBe(10_000);
    }
  });

  it('a WIN after a split stake pays winnings only; a rollback after it still returns each part home', async () => {
    const u = await player({ deposit: 5_000, winnings: 10_000, reserve: 2_000 });
    const roundId = rid();
    await call(u, { roundId, type: 'BET', amountRupees: 100 });
    const winTx = tid();
    expect((await call(u, { txId: winTx, roundId, type: 'WIN', amountRupees: 250 })).ok).toBe(true);

    expect(await pockets(u)).toEqual({ deposit: 0, winnings: 31_000, reserve: 1_000, locked: 0 });
    expect(await ledgerOf(winTx)).toEqual([{ field: 'winningsBalance', tx_type: 'CREDIT', amount: 25_000 }]);
    const round = await roundOf(roundId, u);
    expect(round).toMatchObject({ creditedPaise: 25_000 });
    // A WIN is not a return of the stake: the per-pocket record is untouched.
    expect(round.refundedByPocket).toEqual({ depositBalance: 0, winningsBalance: 0, reserveBalance: 0 });

    await call(u, { roundId, type: 'ROLLBACK', amountRupees: 100 });
    expect(await pockets(u)).toEqual({ deposit: 5_000, winnings: 35_000, reserve: 2_000, locked: 0 });
  });

  it('a redelivered BET moves once — even when the pockets could no longer cover it', async () => {
    const u = await player({ deposit: 5_000, winnings: 10_000 });
    const roundId = rid();
    const betTx = tid();
    expect((await call(u, { txId: betTx, roundId, type: 'BET', amountRupees: 100 })).idempotent).toBe(false);
    expect(await call(u, { txId: betTx, roundId, type: 'BET', amountRupees: 100 }))
      .toMatchObject({ ok: true, idempotent: true });

    // Spend the rest, so a SECOND debit of this stake could not be funded. The
    // replay must still answer "already done", not "cannot afford" (S34): the
    // idempotency gate is asked before the split.
    expect((await call(u, { roundId: rid(), type: 'BET', amountRupees: 50 })).ok).toBe(true);
    expect(await pockets(u)).toEqual({ deposit: 0, winnings: 0, reserve: 0, locked: 0 });
    expect(await call(u, { txId: betTx, roundId, type: 'BET', amountRupees: 100 }))
      .toMatchObject({ ok: true, idempotent: true });

    expect(await ledgerOf(betTx)).toEqual([
      { field: 'depositBalance', tx_type: 'DEBIT', amount: 5_000 },
      { field: 'winningsBalance', tx_type: 'DEBIT', amount: 5_000 },
    ]);
    expect((await roundOf(roundId, u)).debitedByPocket)
      .toEqual({ depositBalance: 5_000, winningsBalance: 5_000, reserveBalance: 0 });
  });

  it('twenty racing copies of one split BET move once', async () => {
    const u = await player({ deposit: 5_000, winnings: 10_000, reserve: 2_000 });
    const roundId = rid();
    const betTx = tid();
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      call(u, { txId: betTx, roundId, type: 'BET', amountRupees: 100 })));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
    expect(await pockets(u)).toEqual({ deposit: 0, winnings: 6_000, reserve: 1_000, locked: 0 });
    expect(await ledgerOf(betTx)).toHaveLength(3);
    expect(await callbackRows(u, roundId)).toBe(1);
  });

  it('two different BETs racing for the last of the deposit are both funded — the split is decided under the lock', async () => {
    // A split computed from a balance read BEFORE the lock would plan both
    // stakes from the same ₹100 of deposit and refuse the second. Decided
    // under the wallet lock, the second sees what the first left and draws
    // the rest from winnings.
    for (let i = 0; i < 4; i += 1) {
      const u = await player({ deposit: 10_000, winnings: 10_000 });
      const [a, b] = [rid(), rid()];
      const results = await Promise.all([
        call(u, { roundId: a, type: 'BET', amountRupees: 80 }),
        call(u, { roundId: b, type: 'BET', amountRupees: 80 }),
      ]);
      expect(results.map((r) => r.ok)).toEqual([true, true]);
      expect(await pockets(u)).toEqual({ deposit: 0, winnings: 4_000, reserve: 0, locked: 0 });
      const [ra, rb] = [await roundOf(a, u), await roundOf(b, u)];
      expect(ra.debitedByPocket.depositBalance + rb.debitedByPocket.depositBalance).toBe(10_000);
      expect(ra.debitedByPocket.winningsBalance + rb.debitedByPocket.winningsBalance).toBe(6_000);
    }
  });

  it('two players on one round: each stake is split from, and returned to, that player\'s own pockets', async () => {
    const a = await player({ deposit: 5_000, winnings: 10_000 });
    const b = await player({ deposit: 100_000 });
    const roundId = rid();
    expect((await call(a, { roundId, type: 'BET', amountRupees: 100 })).ok).toBe(true);
    expect((await call(b, { roundId, type: 'BET', amountRupees: 100 })).ok).toBe(true);
    expect(await pockets(a)).toEqual({ deposit: 0, winnings: 5_000, reserve: 0, locked: 0 });
    expect(await pockets(b)).toEqual({ deposit: 90_000, winnings: 0, reserve: 0, locked: 0 });

    // A's rollback is bounded by and paid against A's own parts.
    expect((await call(a, { roundId, type: 'ROLLBACK', amountRupees: 70 })).ok).toBe(true);
    expect(await pockets(a)).toEqual({ deposit: 5_000, winnings: 7_000, reserve: 0, locked: 0 });
    expect(await pockets(b)).toEqual({ deposit: 90_000, winnings: 0, reserve: 0, locked: 0 });
    expect((await roundOf(roundId, b)).refundedByPocket)
      .toEqual({ depositBalance: 0, winningsBalance: 0, reserveBalance: 0 });
  });

  it('the same round id at two providers keeps two records: a rollback at one returns that stake\'s parts only', async () => {
    const u = await player({ deposit: 5_000, winnings: 20_000 });
    const roundId = rid();
    await call(u, { roundId, type: 'BET', amountRupees: 100 });                                 // deposit 5,000 · winnings 5,000
    await call(u, { roundId, type: 'BET', amountRupees: 100, providerKey: OTHER_PROVIDER });     // winnings 10,000
    expect((await roundOf(roundId, u, OTHER_PROVIDER)).debitedByPocket)
      .toEqual({ depositBalance: 0, winningsBalance: 10_000, reserveBalance: 0 });

    // Rolled back at the OTHER provider: winnings only — that stake took no deposit.
    expect((await call(u, { roundId, type: 'ROLLBACK', amountRupees: 100, providerKey: OTHER_PROVIDER })).ok).toBe(true);
    expect(await pockets(u)).toEqual({ deposit: 0, winnings: 15_000, reserve: 0, locked: 0 });
  });

  describe('the database holds the row to the rule, whatever writes it', () => {
    /** A round with a split stake: reserve 1,000 · deposit 5,000 · winnings 4,000. */
    async function splitRound() {
      const u = await player({ deposit: 5_000, winnings: 10_000, reserve: 2_000 });
      const roundId = rid();
      await call(u, { roundId, type: 'BET', amountRupees: 100 });
      const where = `provider_key = '${PROVIDER}' AND user_id = '${u}' AND round_id = '${roundId}'`;
      return { u, roundId, where };
    }

    it('the parts must add up to the stake', async () => {
      const { where } = await splitRound();
      expect((await refusedBy(pgQuery(
        `UPDATE casino_rounds SET debited_paise = debited_paise + 1 WHERE ${where}`))).constraint)
        .toBe('casino_rounds_split_debit');
      expect((await refusedBy(pgQuery(
        `UPDATE casino_rounds SET refunded_paise = 100 WHERE ${where}`))).constraint)
        .toBe('casino_rounds_split_refund');
    });

    it('no pocket gets back more than the round took from it', async () => {
      const { where } = await splitRound();
      // Within the round's total bound, but one paisa more deposit than the
      // stake took from the deposit.
      expect((await refusedBy(pgQuery(
        `UPDATE casino_rounds SET refunded_paise = 6001, refunded_reserve_paise = 1000,
                refunded_deposit_paise = 5001 WHERE ${where}`))).constraint)
        .toBe('casino_rounds_split_refund_bound');
    });

    it('winnings come back last: no reversal reaches them while a deposit or reserve part is out', async () => {
      const { where } = await splitRound();
      expect((await refusedBy(pgQuery(
        `UPDATE casino_rounds SET refunded_paise = 100, refunded_winnings_paise = 100 WHERE ${where}`))).constraint)
        .toBe('casino_rounds_return_order');
      // The deposit before the reserve share is out of order too.
      expect((await refusedBy(pgQuery(
        `UPDATE casino_rounds SET refunded_paise = 100, refunded_deposit_paise = 100 WHERE ${where}`))).constraint)
        .toBe('casino_rounds_return_order');
      // In order, it is accepted — the opposite behaviour — and put back.
      try {
        const { rowCount } = await pgQuery(`UPDATE casino_rounds SET refunded_paise = 1100,
                refunded_reserve_paise = 1000, refunded_deposit_paise = 100 WHERE ${where}`);
        expect(rowCount).toBe(1);
      } finally {
        await pgQuery(`UPDATE casino_rounds SET refunded_paise = 0, refunded_reserve_paise = 0,
                refunded_deposit_paise = 0 WHERE ${where}`);
      }
    });
  });
});
