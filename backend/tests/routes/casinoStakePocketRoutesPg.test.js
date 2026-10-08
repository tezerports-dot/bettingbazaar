// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A casino BET through the provider's HTTP callback draws on the pockets a
 * board bet draws on — and the balance the provider is told is exactly what a
 * BET can take.
 *
 * Owner, 2026-10-08 (DECISION_LOG): "Yes, like boards" — a casino stake takes
 * from the pockets a board bet takes from, in the same order, and a rollback
 * or refund returns each part to the pocket it came from. The repository case
 * is `casinoStakePocketPg`; this is the same rule through the transport a
 * provider uses (`POST /api/game/wallet/:providerKey`, HMAC-signed over the
 * exact bytes) and through the screen that shows it: the wallet's History tab
 * renders `GET /api/v1/wallet/ledger` and labels each entry by its `field`.
 *
 * The session a BET needs is opened with the write `POST /launch` makes
 * (`games.openSession`), under a provider key of this suite's own.
 */
import crypto from 'node:crypto';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '#db/client.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { createProvider, openSession } from '#db/repositories/games.js';
import { applyConfig, getConfig } from '#db/repositories/config.js';
import { fundWallet } from '#db/tests/_funding.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const PROVIDER = `cbet-http-${RUN}`;
const SECRET = `cbet-webhook-secret-${RUN}`;
let seq = 0;
const tid = () => `cbet-http-${RUN}-tx-${++seq}`;
const rid = () => `cbet-http-${RUN}-r-${++seq}`;
// 10 %, so a reserve share is a round number. Set here and put back (S19).
const RESERVE_PERCENT = 10;

describePg('a casino BET through the provider callback draws on winnings like a board bet (PostgreSQL, HTTP)', () => {
  let provider; let players; let baseline;

  beforeAll(async () => {
    await applySchema();
    baseline = await getConfig('system', { fresh: true });
    await applyConfig({ scope: 'system', actor: 'test-setup', patch: { betReservePercent: RESERVE_PERCENT } });
    const { sealCredential } = await import('../../domains/casino/providerCredentials.js');
    await createProvider({
      providerKey: PROVIDER, name: `Casino stake ${RUN}`, category: 'casino',
      webhookSecretEncrypted: sealCredential(SECRET),
    });
    // The callback router behind the parser server.js puts in front of it,
    // which keeps the exact bytes for the signature check.
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use('/api/game', (await import('../../domains/casino/gameProvider.routes.js')).default);
    provider = app;
    players = mountRouter((await import('../../domains/user/user.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    await applyConfig({
      scope: 'system', actor: 'test-restore', patch: { betReservePercent: baseline.betReservePercent },
    }).catch(() => {});
    await closePg();
  });

  /** The provider's callback, signed over the bytes sent. */
  const callback = (payload) => {
    const raw = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return request(provider).post(`/api/game/wallet/${PROVIDER}`)
      .set('Content-Type', 'application/json').set('X-Signature', signature).send(raw);
  };
  const body = (userId, over) => ({
    transactionId: tid(), playerId: userId, amount: 100, gameId: 'g', ...over,
  });

  /** A player who launched a game with this provider, holding the given pockets. */
  async function player({ deposit = 0, winnings = 0, reserve = 0 }) {
    const p = await actor({});
    if (deposit) await fundWallet(p.userId, deposit, `cbet-http-dep-${p.userId}`, 'depositBalance');
    if (winnings) await fundWallet(p.userId, winnings, `cbet-http-win-${p.userId}`, 'winningsBalance');
    if (reserve) await fundWallet(p.userId, reserve, `cbet-http-res-${p.userId}`, 'reserveBalance');
    await openSession({ sessionId: `s-${p.userId}`, userId: p.userId, providerKey: PROVIDER, ttlMinutes: 240 });
    return p;
  }
  const pockets = async (userId) => {
    const w = await getBalancesPaise(userId);
    return { deposit: w.depositBalance, winnings: w.winningsBalance, reserve: w.reserveBalance };
  };

  it('a BET the deposit cannot cover takes the rest from winnings, and History shows each part', async () => {
    const p = await player({ deposit: 5_000, winnings: 10_000, reserve: 2_000 });
    const bet = body(p.userId, { roundId: rid(), type: 'BET', amount: 100 });
    const res = await callback(bet);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await pockets(p.userId)).toEqual({ deposit: 0, winnings: 6_000, reserve: 1_000 });
    // The provider is told what a BET can take now: ₹60 of winnings is a
    // ₹66.66 stake once ₹6.66 of it comes from the reserve.
    expect(res.body).toMatchObject({ success: true, balance: 66.66, currency: 'INR' });

    const history = await as(players, p).get('/v1/wallet/ledger');
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const parts = history.body.entries
      .filter((e) => e.type === 'DEBIT' && String(e.txId).endsWith(bet.transactionId))
      .map((e) => [e.field, e.amount]).sort();
    expect(parts).toEqual([['depositBalance', 50], ['reserveBalance', 10], ['winningsBalance', 40]]);
  });

  it('the balance the provider is told is a BET that succeeds; a paisa more is refused with 400 and moves nothing', async () => {
    const funds = { deposit: 5_000, winnings: 3_000, reserve: 10_000 };
    const p = await player(funds);
    // A refused BET answers with the balance attached: what a BET can draw on.
    const over = await callback(body(p.userId, { roundId: rid(), type: 'BET', amount: 88.89 }));
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ success: false, message: 'Insufficient balance', balance: 88.88 });
    expect(await pockets(p.userId)).toEqual(funds);

    const exact = await callback(body(p.userId, { roundId: rid(), type: 'BET', amount: over.body.balance }));
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    expect(exact.body.balance).toBe(0);
    expect(await pockets(p.userId)).toEqual({ deposit: 0, winnings: 0, reserve: 10_000 - 888 });
  });

  it('a partial ROLLBACK returns the reserve share and deposit before any winnings', async () => {
    const p = await player({ deposit: 5_000, winnings: 10_000, reserve: 2_000 });
    const roundId = rid();
    expect((await callback(body(p.userId, { roundId, type: 'BET', amount: 100 }))).status).toBe(200);
    const rb = await callback(body(p.userId, { roundId, type: 'ROLLBACK', amount: 55 }));
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    // ₹10 reserve share and ₹45 of the ₹50 deposit part; winnings untouched.
    expect(await pockets(p.userId)).toEqual({ deposit: 4_500, winnings: 6_000, reserve: 2_000 });
    const rest = await callback(body(p.userId, { roundId, type: 'REFUND', amount: 45 }));
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    expect(await pockets(p.userId)).toEqual({ deposit: 5_000, winnings: 10_000, reserve: 2_000 });
  });

  it('a redelivered split BET answers 200 and takes nothing further', async () => {
    const p = await player({ deposit: 5_000, winnings: 10_000 });
    const bet = body(p.userId, { roundId: rid(), type: 'BET', amount: 100 });
    expect((await callback(bet)).status).toBe(200);
    const again = await callback(bet);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await pockets(p.userId)).toEqual({ deposit: 0, winnings: 5_000, reserve: 0 });
    const { rows } = await pgQuery(
      'SELECT count(*)::int AS n FROM game_transactions WHERE tx_id = $1', [bet.transactionId]);
    expect(rows[0].n).toBe(1);
  });
});
