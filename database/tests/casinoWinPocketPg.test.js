// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which POCKET each casino callback moves, against a REAL PostgreSQL.
 *
 * Owner, 2026-10-07 (DECISION_LOG): "a player wins a casino game, it should go
 * to their winnings balance." `recordCallback` credited a WIN to
 * `depositBalance`, the pocket the stake came from, so a casino win could not
 * be withdrawn the way a board win can (a SELL draws on winnings only).
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 * A casino round's money is in the pockets its totals say: the player's
 * WINNINGS rose by exactly what the round credited (`credited_paise`), and
 * their DEPOSIT moved by exactly what it debited less what it refunded
 * (`refunded_paise - debited_paise`). A stake returned goes back to the pocket
 * it came from — a BET takes from deposit, so a ROLLBACK or REFUND gives back
 * to deposit. Returning it to winnings would turn a deposit into withdrawable
 * money with no game played: a cash-out route, not a rounding error.
 *
 * Every case asserts both pockets, the ledger row (what the player's History
 * shows) and, where money moved, the treasury's other side.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { getBalancesPaise } from '../repositories/wallets.core.js';
import { debitWinningsForWithdrawal } from '../repositories/wallets.js';
import { applyProviderCallback } from '../repositories/casino.js';
import { getRound } from '../repositories/casino.core.js';
import { openSession } from '../repositories/games.js';
import { fundWallet } from './_funding.js';

const describePg = pgConfigured() ? describe : describe.skip;

// This run's own provider and players: nothing here truncates a shared table,
// so every assertion is about rows this file wrote (trap 10).
const RUN = Math.random().toString(36).slice(2, 8);
const PROVIDER = `cwin-${RUN}`;
let seq = 0;
const tid = () => `cwin-${RUN}-tx-${++seq}`;
const rid = () => `cwin-${RUN}-r-${++seq}`;

/** A player with a live session and the given pockets, funded the way the platform funds. */
async function player({ deposit = 100_000, winnings = 0 } = {}) {
  const userId = `pg-cwin-${RUN}-${++seq}`;
  if (deposit) await fundWallet(userId, deposit, `cwin-fund-dep-${userId}`, 'depositBalance');
  if (winnings) await fundWallet(userId, winnings, `cwin-fund-win-${userId}`, 'winningsBalance');
  await openSession({ sessionId: `s-${userId}`, userId, providerKey: PROVIDER, ttlMinutes: 240 });
  return userId;
}

const call = (userId, over) => applyProviderCallback({
  txId: tid(), userId, providerKey: PROVIDER, gameId: 'g', amountRupees: 100, ...over,
});
const pockets = async (userId) => {
  const w = await getBalancesPaise(userId);
  return { deposit: w.depositBalance, winnings: w.winningsBalance, locked: w.lockedBalance };
};
const ledgerRow = async (txId) => (await pgQuery(
  `SELECT field, tx_type, amount_paise::int AS amount, balance_before_paise::int AS before,
          balance_after_paise::int AS after
     FROM wallet_ledger WHERE tx_id = $1`, [`casino_${txId}`])).rows;
const treasuryLegs = async (txId) => Object.fromEntries((await pgQuery(
  `SELECT account, SUM(amount_paise)::int AS paise FROM treasury_entries
    WHERE movement_id = $1 GROUP BY account`, [`casino_${txId}`])).rows.map((r) => [r.account, r.paise]));

describePg('a casino WIN is paid into winnings; a stake goes back where it came from (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('credits a WIN to winnings and leaves the deposit where the BET left it', async () => {
    const u = await player();
    const roundId = rid();
    expect((await call(u, { roundId, type: 'BET', amountRupees: 100 })).ok).toBe(true);
    const winTx = tid();
    const won = await call(u, { txId: winTx, roundId, type: 'WIN', amountRupees: 350 });
    expect(won).toMatchObject({ ok: true, idempotent: false });

    expect(await pockets(u)).toEqual({ deposit: 90_000, winnings: 35_000, locked: 0 });

    // The ledger names the pocket that moved — what History shows the player.
    expect(await ledgerRow(winTx)).toEqual([
      { field: 'winningsBalance', tx_type: 'CREDIT', amount: 35_000, before: 0, after: 35_000 },
    ]);
    // The house paid it, in the same transaction: USER_FLOAT rose by the win
    // and the house side (its reserve, then the platform's holding) fell by it.
    const legs = await treasuryLegs(winTx);
    expect(legs.USER_FLOAT).toBe(35_000);
    expect((legs.HOUSE_RESERVE ?? 0) + (legs.TOKEN_SUPPLY ?? 0)).toBe(-35_000);

    // The round's totals and the pockets say the same thing.
    const round = await getRound(roundId, { userId: u, providerKey: PROVIDER });
    expect(round).toMatchObject({ debitedPaise: 10_000, creditedPaise: 35_000, refundedPaise: 0 });
  });

  it('a casino win can be withdrawn, as a board win can — and the deposit still cannot', async () => {
    const u = await player();
    const roundId = rid();
    await call(u, { roundId, type: 'BET', amountRupees: 100 });
    await call(u, { roundId, type: 'WIN', amountRupees: 350 });

    // A SELL locks winnings; only winnings are withdrawable.
    await debitWinningsForWithdrawal(u, 350, `cwin-wd-${u}`);
    expect(await pockets(u)).toEqual({ deposit: 90_000, winnings: 0, locked: 35_000 });
    await expect(debitWinningsForWithdrawal(u, 1, `cwin-wd2-${u}`))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_WITHDRAWABLE' });
    expect(await pockets(u)).toEqual({ deposit: 90_000, winnings: 0, locked: 35_000 });
  });

  it('a BET still takes its stake from the deposit only, never from winnings (the opposite behaviour)', async () => {
    // Today's rule, not a new one: a casino BET debits `depositBalance` alone.
    // A board bet draws deposit first and then winnings; whether a casino BET
    // should too is the owner's question (reported with this change).
    const u = await player({ deposit: 5_000, winnings: 100_000 });
    const short = await call(u, { roundId: rid(), type: 'BET', amountRupees: 100 });
    expect(short).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(await pockets(u)).toEqual({ deposit: 5_000, winnings: 100_000, locked: 0 });

    const betTx = tid();
    expect((await call(u, { txId: betTx, roundId: rid(), type: 'BET', amountRupees: 50 })).ok).toBe(true);
    expect(await pockets(u)).toEqual({ deposit: 0, winnings: 100_000, locked: 0 });
    expect(await ledgerRow(betTx)).toEqual([
      { field: 'depositBalance', tx_type: 'DEBIT', amount: 5_000, before: 5_000, after: 0 },
    ]);
  });

  it('a ROLLBACK and a REFUND return the stake to the deposit, even after a WIN', async () => {
    const u = await player();
    const roundId = rid();
    await call(u, { roundId, type: 'BET', amountRupees: 100 });
    await call(u, { roundId, type: 'WIN', amountRupees: 350 });
    const rbTx = tid(); const rfTx = tid();
    expect((await call(u, { txId: rbTx, roundId, type: 'ROLLBACK', amountRupees: 60 })).ok).toBe(true);
    expect((await call(u, { txId: rfTx, roundId, type: 'REFUND', amountRupees: 40 })).ok).toBe(true);

    expect(await pockets(u)).toEqual({ deposit: 100_000, winnings: 35_000, locked: 0 });
    expect((await ledgerRow(rbTx))[0]).toMatchObject({ field: 'depositBalance', tx_type: 'CREDIT', amount: 6_000 });
    expect((await ledgerRow(rfTx))[0]).toMatchObject({ field: 'depositBalance', tx_type: 'CREDIT', amount: 4_000 });
  });

  it('a bet rolled back in full leaves nothing withdrawable: a reversal is never a cash-out', async () => {
    const u = await player();
    const roundId = rid();
    await call(u, { roundId, type: 'BET', amountRupees: 100 });
    await call(u, { roundId, type: 'ROLLBACK', amountRupees: 100 });
    expect(await pockets(u)).toEqual({ deposit: 100_000, winnings: 0, locked: 0 });
    await expect(debitWinningsForWithdrawal(u, 100, `cwin-wd-${u}`))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_WITHDRAWABLE' });
  });

  it('a WIN with no standing stake moves nothing: no pocket, no ledger row, no treasury entry', async () => {
    const u = await player();
    const ghost = tid();
    expect(await call(u, { txId: ghost, roundId: rid(), type: 'WIN', amountRupees: 500 }))
      .toMatchObject({ ok: false, reason: 'no_prior_bet' });

    // And on a round whose stake was rolled back in full.
    const roundId = rid();
    await call(u, { roundId, type: 'BET', amountRupees: 100 });
    await call(u, { roundId, type: 'ROLLBACK', amountRupees: 100 });
    const late = tid();
    expect(await call(u, { txId: late, roundId, type: 'WIN', amountRupees: 500 }))
      .toMatchObject({ ok: false, reason: 'no_prior_bet' });

    expect(await pockets(u)).toEqual({ deposit: 100_000, winnings: 0, locked: 0 });
    for (const tx of [ghost, late]) {
      expect(await ledgerRow(tx)).toEqual([]);
      expect(await treasuryLegs(tx)).toEqual({});
    }
  });

  it('a redelivered WIN credits winnings once', async () => {
    const u = await player();
    const roundId = rid();
    await call(u, { roundId, type: 'BET', amountRupees: 100 });
    const winTx = tid();
    expect((await call(u, { txId: winTx, roundId, type: 'WIN', amountRupees: 350 })).idempotent).toBe(false);
    expect(await call(u, { txId: winTx, roundId, type: 'WIN', amountRupees: 350 }))
      .toMatchObject({ ok: true, idempotent: true });

    expect(await pockets(u)).toEqual({ deposit: 90_000, winnings: 35_000, locked: 0 });
    expect(await ledgerRow(winTx)).toHaveLength(1);
    expect((await treasuryLegs(winTx)).USER_FLOAT).toBe(35_000);
  });

  it('twenty racing copies of one WIN credit winnings once', async () => {
    const u = await player();
    const roundId = rid();
    await call(u, { roundId, type: 'BET', amountRupees: 100 });
    const winTx = tid();
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      call(u, { txId: winTx, roundId, type: 'WIN', amountRupees: 350 })));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
    expect(await pockets(u)).toEqual({ deposit: 90_000, winnings: 35_000, locked: 0 });
    expect(await ledgerRow(winTx)).toHaveLength(1);
  });

  it('a WIN racing a full ROLLBACK of its stake: whichever lands first, the pockets equal the round', async () => {
    // Serialised by the wallet lock. WIN first: both apply (the stake was
    // standing). ROLLBACK first: the WIN is refused (no standing stake). Either
    // way winnings == credited and deposit == start − debited + refunded.
    const seen = new Set();
    for (let i = 0; i < 6; i += 1) {
      const u = await player();
      const roundId = rid();
      await call(u, { roundId, type: 'BET', amountRupees: 100 });
      const [win] = await Promise.all([
        call(u, { roundId, type: 'WIN', amountRupees: 350 }),
        call(u, { roundId, type: 'ROLLBACK', amountRupees: 100 }),
      ]);
      seen.add(win.ok ? 'win-first' : win.reason);

      const round = await getRound(roundId, { userId: u, providerKey: PROVIDER });
      const p = await pockets(u);
      expect(p.winnings).toBe(round.creditedPaise);
      expect(p.deposit).toBe(100_000 - round.debitedPaise + round.refundedPaise);
      expect(round.creditedPaise).toBe(win.ok ? 35_000 : 0);
    }
    // Every outcome is one of the two orders, never a third.
    for (const s of seen) expect(['win-first', 'no_prior_bet']).toContain(s);
  });

  it('on one shared round, the WIN lands in the winner\'s winnings only', async () => {
    // A crash round or a live table: one provider round id, two players.
    const a = await player(); const b = await player();
    const roundId = rid();
    await call(a, { roundId, type: 'BET', amountRupees: 100 });
    await call(b, { roundId, type: 'BET', amountRupees: 200 });
    expect((await call(b, { roundId, type: 'WIN', amountRupees: 600 })).ok).toBe(true);

    expect(await pockets(a)).toEqual({ deposit: 90_000, winnings: 0, locked: 0 });
    expect(await pockets(b)).toEqual({ deposit: 80_000, winnings: 60_000, locked: 0 });
  });
});
