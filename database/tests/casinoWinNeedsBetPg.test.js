// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A casino, crash or sports WIN pays only on a round the player actually bet
 * on, against a REAL PostgreSQL.
 *
 * Owner, 2026-10-01: "Winnings are only given on those where users place bets
 * on rounds." Board games already worked that way — a payout is the WON
 * transition of a PENDING row in `bets`, so a board win without a bet cannot
 * exist. The provider callback did not: a WIN for a round with no BET created
 * the round and credited the player, and no callback checked that the round
 * belonged to the player it named, so a WIN or a ROLLBACK naming player B on
 * player A's round paid B.
 *
 * ── A round is one PLAYER's stake on one PROVIDER's round id ────────────────
 * The first fix keyed a round on the provider's round id alone and refused any
 * callback from a second player or a second provider. That is right for a
 * slot, which one player spins, and wrong for everything multiplayer: a crash
 * round and a live-table round are ONE round id shared by everybody at the
 * table, so the second player to stake on it was refused — and two providers
 * that both number their rounds from 1 collided. A round is therefore keyed
 * (provider, player, round id). Each player's stake is its own row, and
 * "a WIN needs this player's own standing bet" is asked of THAT row, which is
 * the owner's rule exactly — another player's bet on the same table is not
 * this player's bet.
 *
 * Every case asserts the WALLETS — both players' where two are involved —
 * because a refusal that moved money anyway is the failure this exists to
 * catch.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { getBalancesPaise, applyDeltaPaise } from '../repositories/wallets.core.js';
import { applyProviderCallback } from '../repositories/casino.js';
import { getRound } from '../repositories/casino.core.js';
import { openSession } from '../repositories/games.js';

const describePg = pgConfigured() ? describe : describe.skip;

const PLAYER = 'pg-casino-win-player';
const OTHER = 'pg-casino-win-other';
const rid = () => `r-${Math.random().toString(36).slice(2)}`;
const tid = () => `tx-${Math.random().toString(36).slice(2)}`;
const total = async (u) => { const w = await getBalancesPaise(u); return w.depositBalance + w.winningsBalance; };
const call = (over) => applyProviderCallback({
  txId: tid(), userId: PLAYER, amountRupees: 100, providerKey: 'betby', gameId: 'g', ...over,
});
const roundOf = (roundId, userId = PLAYER, providerKey = 'betby') => getRound(roundId, { userId, providerKey });

describePg('a casino WIN needs the player\'s own bet on that round (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`DELETE FROM game_sessions WHERE user_id IN ($1, $2)`, [PLAYER, OTHER]);
    await pgQuery(`TRUNCATE casino_transactions, casino_rounds, wallet_ledger, wallets RESTART IDENTITY CASCADE`);
    for (const u of [PLAYER, OTHER]) {
      await applyDeltaPaise({ userId: u, field: 'depositBalance', deltaPaise: 100_000, txId: `fund-${u}`, type: 'CREDIT', reason: 'test' });
      await openSession({ sessionId: `s-${u}`, userId: u, providerKey: 'betby', ttlMinutes: 240 });
    }
  });

  it('refuses a WIN on a round nobody bet on, and creates no round', async () => {
    const roundId = rid();
    const r = await call({ roundId, type: 'WIN', amountRupees: 500 });
    expect(r).toMatchObject({ ok: false, reason: 'no_prior_bet' });
    expect(await total(PLAYER)).toBe(100_000);
    expect(await roundOf(roundId)).toBeNull();
  });

  it('pays a WIN on the player\'s own bet, including more than the stake', async () => {
    const roundId = rid();
    expect((await call({ roundId, type: 'BET', amountRupees: 100 })).ok).toBe(true);
    const r = await call({ roundId, type: 'WIN', amountRupees: 350 });
    expect(r.ok).toBe(true);
    expect(await total(PLAYER)).toBe(100_000 - 10_000 + 35_000);
  });

  it('refuses a WIN naming ANOTHER player who never bet on this round', async () => {
    const roundId = rid();
    expect((await call({ roundId, type: 'BET' })).ok).toBe(true);
    const r = await call({ roundId, type: 'WIN', userId: OTHER, amountRupees: 500 });
    expect(r).toMatchObject({ ok: false, reason: 'no_prior_bet' });
    expect(await total(OTHER)).toBe(100_000);
    expect(await total(PLAYER)).toBe(90_000);
    expect(await roundOf(roundId, OTHER)).toBeNull();
  });

  it('refuses a ROLLBACK naming another player who never bet on this round', async () => {
    const roundId = rid();
    expect((await call({ roundId, type: 'BET' })).ok).toBe(true);
    const r = await call({ roundId, type: 'ROLLBACK', userId: OTHER, amountRupees: 100 });
    expect(r).toMatchObject({ ok: false, reason: 'no_prior_debit' });
    expect(await total(OTHER)).toBe(100_000);
    expect(await total(PLAYER)).toBe(90_000);
    expect((await roundOf(roundId)).refundedPaise).toBe(0);
  });

  it('lets two players stake on ONE shared round, each on their own row, and pays a WIN only on its winner\'s stake', async () => {
    // A crash round or a live table: one provider round id, many players.
    const roundId = rid();
    expect((await call({ roundId, type: 'BET', amountRupees: 100 })).ok).toBe(true);
    const second = await call({ roundId, type: 'BET', userId: OTHER, amountRupees: 200 });
    expect(second, 'the second player at the table was refused').toMatchObject({ ok: true });

    // Each stake is its own round, and neither advanced the other's.
    expect((await roundOf(roundId)).debitedPaise).toBe(10_000);
    expect((await roundOf(roundId, OTHER)).debitedPaise).toBe(20_000);

    // OTHER wins; PLAYER loses. The WIN lands on OTHER's own stake only.
    const won = await call({ roundId, type: 'WIN', userId: OTHER, amountRupees: 600 });
    expect(won.ok).toBe(true);
    expect(await total(OTHER)).toBe(100_000 - 20_000 + 60_000);
    expect(await total(PLAYER)).toBe(90_000);

    // A rollback of PLAYER's stake is bounded by PLAYER's stake, not the table's.
    const tooMuch = await call({ roundId, type: 'ROLLBACK', amountRupees: 150 });
    expect(tooMuch).toMatchObject({ ok: false, reason: 'refund_exceeds_debit' });
    expect(await total(PLAYER)).toBe(90_000);
  });

  it('treats the same round id at two providers as two rounds', async () => {
    await openSession({ sessionId: `s-${PLAYER}-pp`, userId: PLAYER, providerKey: 'pragmatic', ttlMinutes: 240 });
    const roundId = rid();
    expect((await call({ roundId, type: 'BET', amountRupees: 100 })).ok).toBe(true);
    const there = await call({ roundId, type: 'BET', providerKey: 'pragmatic', amountRupees: 100 });
    expect(there, 'a second provider numbering its rounds the same way was refused').toMatchObject({ ok: true });
    expect((await roundOf(roundId)).debitedPaise).toBe(10_000);
    expect((await roundOf(roundId, PLAYER, 'pragmatic')).debitedPaise).toBe(10_000);
    expect(await total(PLAYER)).toBe(80_000);
  });

  it('refuses a WIN from a DIFFERENT provider that has no bet on this round', async () => {
    const roundId = rid();
    expect((await call({ roundId, type: 'BET' })).ok).toBe(true);
    const r = await call({ roundId, type: 'WIN', providerKey: 'pragmatic' });
    expect(r).toMatchObject({ ok: false, reason: 'no_prior_bet' });
    expect(await total(PLAYER)).toBe(90_000);
  });

  it('refuses a WIN on a round whose bet was rolled back in full', async () => {
    const roundId = rid();
    expect((await call({ roundId, type: 'BET' })).ok).toBe(true);
    expect((await call({ roundId, type: 'ROLLBACK' })).ok).toBe(true);
    const r = await call({ roundId, type: 'WIN', amountRupees: 500 });
    expect(r).toMatchObject({ ok: false, reason: 'no_prior_bet' });
    expect(await total(PLAYER)).toBe(100_000);
  });

  it('the database refuses a credited round with no debit, even with the guard bypassed', async () => {
    const roundId = rid();
    await pgQuery(
      `INSERT INTO casino_rounds (round_id, user_id, provider_key) VALUES ($1, $2, 'betby')`, [roundId, PLAYER]);
    await expect(pgQuery(
      `UPDATE casino_rounds SET credited_paise = 100 WHERE round_id = $1`, [roundId],
    )).rejects.toThrow(/casino_rounds_win_needs_bet/);
  });

  it('the database refuses a second row for one player\'s stake on one provider round', async () => {
    const roundId = rid();
    await pgQuery(
      `INSERT INTO casino_rounds (round_id, user_id, provider_key) VALUES ($1, $2, 'betby')`, [roundId, PLAYER]);
    await expect(pgQuery(
      `INSERT INTO casino_rounds (round_id, user_id, provider_key) VALUES ($1, $2, 'betby')`, [roundId, PLAYER],
    )).rejects.toThrow(/casino_rounds_one_per_player/);
  });
});
