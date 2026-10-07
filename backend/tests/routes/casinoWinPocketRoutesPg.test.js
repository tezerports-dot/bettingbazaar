// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A casino WIN, end to end through the provider's HTTP callback, lands in the
 * player's WINNINGS — and the player's History says so.
 *
 * Owner, 2026-10-07: "a player wins a casino game, it should go to their
 * winnings balance." The repository case is `casinoWinPocketPg`; this is the
 * same rule through the transport a provider actually uses —
 * `POST /api/game/wallet/:providerKey`, HMAC-signed over the exact bytes, the
 * way server.js parses it — and through the screen that shows it: the wallet's
 * History tab renders `GET /api/v1/wallet/ledger`, and labels each entry by
 * its `field` ("Winnings wallet" / "Deposit wallet", WalletPage.tsx).
 *
 * The session a BET needs is opened with the same write `POST /launch` makes
 * (`games.openSession`): launch builds URLs only for the shipped provider keys,
 * and this suite uses a key of its own so it shares no row with any other.
 */
import crypto from 'node:crypto';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '#db/client.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { createProvider, openSession } from '#db/repositories/games.js';
import { fundWallet } from '#db/tests/_funding.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const PROVIDER = `cwin-http-${RUN}`;
const SECRET = `cwin-webhook-secret-${RUN}`;
let seq = 0;
const tid = () => `cwin-http-${RUN}-tx-${++seq}`;
const rid = () => `cwin-http-${RUN}-r-${++seq}`;

describePg('a casino WIN through the provider callback lands in winnings (PostgreSQL, HTTP)', () => {
  let provider; let players;

  beforeAll(async () => {
    await applySchema();
    const { sealCredential } = await import('../../domains/casino/providerCredentials.js');
    await createProvider({
      providerKey: PROVIDER, name: `Casino win ${RUN}`, category: 'casino',
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

  afterAll(async () => { await closePg(); });

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

  /** A player who launched a game with this provider, holding ₹1,000 of deposit. */
  async function player() {
    const p = await actor({});
    await fundWallet(p.userId, 100_000, `cwin-http-fund-${p.userId}`);
    await openSession({ sessionId: `s-${p.userId}`, userId: p.userId, providerKey: PROVIDER, ttlMinutes: 240 });
    return p;
  }
  const pockets = async (userId) => {
    const w = await getBalancesPaise(userId);
    return { deposit: w.depositBalance, winnings: w.winningsBalance };
  };

  it('pays the WIN into winnings, and the History entry names the winnings wallet', async () => {
    const p = await player();
    const roundId = rid();
    const bet = await callback(body(p.userId, { roundId, type: 'BET', amount: 100 }));
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);

    const win = body(p.userId, { roundId, type: 'WIN', amount: 350 });
    const res = await callback(win);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The provider is told what the player can see: deposit + winnings.
    expect(res.body).toMatchObject({ success: true, balance: 1_250, currency: 'INR' });
    expect(await pockets(p.userId)).toEqual({ deposit: 90_000, winnings: 35_000 });

    const history = await as(players, p).get('/v1/wallet/ledger');
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const entry = history.body.entries.find((e) => e.txId === `casino_${win.transactionId}`);
    expect(entry).toMatchObject({
      type: 'CREDIT', field: 'winningsBalance', amount: 350, balanceBefore: 0, balanceAfter: 350,
    });
    // And the stake still reads as the deposit wallet's.
    const stake = history.body.entries.find((e) => e.type === 'DEBIT' && e.amount === 100);
    expect(stake.field).toBe('depositBalance');
  });

  it('a redelivered WIN answers 200 and pays nothing further', async () => {
    const p = await player();
    const roundId = rid();
    await callback(body(p.userId, { roundId, type: 'BET', amount: 100 }));
    const win = body(p.userId, { roundId, type: 'WIN', amount: 350 });
    expect((await callback(win)).status).toBe(200);
    const again = await callback(win);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.balance).toBe(1_250);

    expect(await pockets(p.userId)).toEqual({ deposit: 90_000, winnings: 35_000 });
    const { rows } = await pgQuery(
      'SELECT count(*)::int AS n FROM game_transactions WHERE tx_id = $1', [win.transactionId]);
    expect(rows[0].n).toBe(1);
  });

  it('a WIN on a round the player never bet on is refused with 400 and moves nothing', async () => {
    const p = await player();
    const res = await callback(body(p.userId, { roundId: rid(), type: 'WIN', amount: 500 }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: 'No standing bet by this player on this round', balance: 1_000 });
    expect(await pockets(p.userId)).toEqual({ deposit: 100_000, winnings: 0 });
  });

  it('a ROLLBACK after a WIN returns the stake to deposit and leaves the win in winnings', async () => {
    const p = await player();
    const roundId = rid();
    await callback(body(p.userId, { roundId, type: 'BET', amount: 100 }));
    await callback(body(p.userId, { roundId, type: 'WIN', amount: 350 }));
    const rb = await callback(body(p.userId, { roundId, type: 'ROLLBACK', amount: 100 }));
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(await pockets(p.userId)).toEqual({ deposit: 100_000, winnings: 35_000 });
  });

  it('every supplier spelling lands in the same pocket: `action` debit / credit, any case', async () => {
    // `normaliseType` reads DEBIT as BET and CREDIT as WIN, and the route takes
    // `type` or `action` and other id field names — §37.1, every spelling.
    const p = await player();
    const roundId = rid();
    const debit = await callback({
      txId: tid(), player_id: p.userId, round_id: roundId, action: 'debit', amount: 100, game_id: 'g',
    });
    expect(debit.status, JSON.stringify(debit.body)).toBe(200);
    const credit = await callback({
      transaction_id: tid(), userId: p.userId, gameRound: roundId, action: 'Credit', bet: 250, gameId: 'g',
    });
    expect(credit.status, JSON.stringify(credit.body)).toBe(200);
    expect(await pockets(p.userId)).toEqual({ deposit: 90_000, winnings: 25_000 });
  });
});
