// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A casino debit is tied to the PLAYER's own session, against a REAL PostgreSQL.
 *
 * The provider callback is authenticated by an HMAC over its body, which
 * proves the provider sent it and nothing about whether the provider named the
 * right player. That rested on each provider's launch token, and two of them
 * were weak (found 2026-09-30): Betby's was unsigned base64 JSON naming the
 * userId, and Pragmatic's was md5(userId + secret), the same value forever.
 * `applyProviderCallback` now refuses a BET unless the player holds a live
 * session with that provider, which only the player can open.
 *
 * Every case asserts the WALLET, not just the verdict: a refusal that moved
 * money anyway is the failure this file exists to catch.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { getBalancesPaise, applyDeltaPaise } from '../repositories/wallets.core.js';
import { applyProviderCallback } from '../repositories/casino.js';
import { openSession, hasLiveSession } from '../repositories/games.js';

const describePg = pgConfigured() ? describe : describe.skip;

const VICTIM = 'pg-casino-victim';
const OTHER = 'pg-casino-other';
const deposit = async (u) => (await getBalancesPaise(u)).depositBalance;
const bet = (over = {}) => applyProviderCallback({
  txId: `tx-${Math.random().toString(36).slice(2)}`, roundId: `r-${Math.random().toString(36).slice(2)}`,
  userId: VICTIM, type: 'BET', amountRupees: 100, providerKey: 'betby', gameId: 'g', ...over,
});

describePg('casino debits need the player\'s own live session (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`DELETE FROM game_sessions WHERE user_id IN ($1, $2)`, [VICTIM, OTHER]);
    await pgQuery(`TRUNCATE casino_transactions, casino_rounds, wallet_ledger, wallets RESTART IDENTITY CASCADE`);
    for (const u of [VICTIM, OTHER]) {
      await applyDeltaPaise({ userId: u, field: 'depositBalance', deltaPaise: 100_000, txId: `fund-${u}`, type: 'CREDIT', reason: 'test' });
    }
  });

  it('refuses a BET for a player with no session, and moves nothing', async () => {
    const r = await bet();
    expect(r).toMatchObject({ ok: false, reason: 'no_live_session' });
    expect(await deposit(VICTIM)).toBe(100_000);
  });

  it('accepts a BET while the player holds a live session with that provider', async () => {
    await openSession({ sessionId: 's-live', userId: VICTIM, providerKey: 'betby', ttlMinutes: 240 });
    const r = await bet();
    expect(r.ok).toBe(true);
    expect(await deposit(VICTIM)).toBe(90_000);
  });

  it('refuses a BET once the session has expired, even before any sweep', async () => {
    await openSession({ sessionId: 's-old', userId: VICTIM, providerKey: 'betby', ttlMinutes: 240 });
    await pgQuery(`UPDATE game_sessions SET expires_at = now() - interval '1 s' WHERE session_id = 's-old'`);
    expect(await hasLiveSession(VICTIM, 'betby')).toBe(false);
    expect((await bet()).reason).toBe('no_live_session');
    expect(await deposit(VICTIM)).toBe(100_000);
  });

  it('a session with ANOTHER provider does not authorise this one', async () => {
    await openSession({ sessionId: 's-evo', userId: VICTIM, providerKey: 'evolution', ttlMinutes: 240 });
    expect((await bet({ providerKey: 'betby' })).reason).toBe('no_live_session');
    expect(await deposit(VICTIM)).toBe(100_000);
  });

  it('ANOTHER player\'s session does not authorise a debit on this one', async () => {
    // The attack itself: somebody launches their own game, then a callback
    // naming the victim arrives. Their session is theirs, not the victim's.
    await openSession({ sessionId: 's-attacker', userId: OTHER, providerKey: 'betby', ttlMinutes: 240 });
    expect((await bet({ userId: VICTIM })).reason).toBe('no_live_session');
    expect(await deposit(VICTIM)).toBe(100_000);
    expect(await deposit(OTHER)).toBe(100_000);
  });

  it('a BET with no provider named is refused rather than trusted', async () => {
    await openSession({ sessionId: 's-live2', userId: VICTIM, providerKey: 'betby', ttlMinutes: 240 });
    expect((await bet({ providerKey: null })).reason).toBe('no_live_session');
    expect(await deposit(VICTIM)).toBe(100_000);
  });

  it('a WIN still lands with no live session: a sports bet settles after its session ends', async () => {
    const r = await applyProviderCallback({
      txId: 'tx-win', roundId: 'r-win', userId: VICTIM, type: 'WIN', amountRupees: 50, providerKey: 'betby',
    });
    expect(r.ok).toBe(true);
    const w = await getBalancesPaise(VICTIM);
    expect(w.depositBalance + w.winningsBalance).toBe(105_000);
  });

  it('a refund of a bet made in a live session still lands after the session expired', async () => {
    await openSession({ sessionId: 's-then', userId: VICTIM, providerKey: 'betby', ttlMinutes: 240 });
    expect((await bet({ txId: 'tx-b', roundId: 'r-refund' })).ok).toBe(true);
    await pgQuery(`UPDATE game_sessions SET expires_at = now() - interval '1 s' WHERE session_id = 's-then'`);
    const r = await applyProviderCallback({
      txId: 'tx-rb', roundId: 'r-refund', userId: VICTIM, type: 'ROLLBACK', amountRupees: 100, providerKey: 'betby',
    });
    expect(r.ok).toBe(true);
    expect(await deposit(VICTIM)).toBe(100_000);
  });
});
