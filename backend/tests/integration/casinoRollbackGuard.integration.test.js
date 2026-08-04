// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * M-7 on the LIVE MongoDB path — a casino reversal must prove its debit.
 *
 * ── Why this one is not "resolved in Postgres" like M-2 and M-4 ─────────────
 * Those two are latent: `bet.routes.js` mints a fresh key per request, so the
 * unsafe primitive is not currently reachable in a way that loses money. M-7 is
 * different. `POST /api/games/wallet` is a LIVE endpoint that any configured
 * provider can call, and the rollback branch credited the player with no check
 * that the round was ever bet on and no bound on the amount.
 *
 * So a provider that is buggy, replayed, or hostile could mint real money by
 * rolling back a round that never had a bet. Fixing that only in the Postgres
 * path — which is not authoritative and will not be on launch day — would leave
 * the exploitable version running. It is fixed in both.
 *
 * ── What the duplicate-txId check does NOT cover ────────────────────────────
 * The handler already rejects a repeated `txId`. That stops the SAME callback
 * applying twice. It says nothing about a DIFFERENT callback that should never
 * have been honoured, which is the entire exposure — so these tests use fresh
 * transaction ids throughout, where that gate cannot help.
 *
 * REQUIRES MongoDB (a replica set). CI-only; the sandbox cannot run mongod.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { refundOrder } from '../../domains/wallet/walletAuthority.service.js';

const GameTransaction = () => mongoose.model('GameTransaction');
const User = () => mongoose.model('User');

/**
 * The guard itself, lifted out of the route so it can be exercised without
 * standing up webhook signature verification.
 *
 * It is a COPY of the route's logic, which is a real weakness of this test and
 * worth naming: if the route changes and this does not, the test keeps passing
 * while the endpoint regresses. The route-level assertion belongs in an
 * end-to-end suite with a signed payload; this covers the arithmetic, which is
 * the part that was wrong.
 */
async function reversalAllowed({ roundId, userId, amount }) {
  const priorTx = await GameTransaction().find({ roundId, userId }).select('type amount').lean();
  const debited = priorTx
    .filter((t) => t.type === 'BET')
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const refunded = priorTx
    .filter((t) => t.type === 'ROLLBACK' || t.type === 'REFUND')
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  if (debited <= 0) return { ok: false, reason: 'no_prior_debit' };
  if (refunded + amount > debited) return { ok: false, reason: 'refund_exceeds_debit', debited, refunded };
  return { ok: true, debited, refunded };
}

const tx = (over = {}) => GameTransaction().create({
  roundId: 'r1', txId: `tx_${Math.random().toString(16).slice(2)}`,
  userId: over.userId, providerKey: 'p1', type: 'BET', amount: 100,
  balanceBefore: 0, balanceAfter: 0, gameId: 'g1', ...over,
});

describe('M-7: casino reversals must prove a prior debit (MongoDB path)', () => {
  let user;
  beforeEach(async () => {
    user = await User().create({ username: 'casino_u', mobile: '9500000001', depositBalance: 1000 });
  });

  it('refuses a rollback for a round that was never bet on', async () => {
    // The exploit. Before the guard this reached refundOrder() and credited
    // real money for a round that does not exist.
    expect(await reversalAllowed({ roundId: 'ghost', userId: user._id, amount: 500 }))
      .toMatchObject({ ok: false, reason: 'no_prior_debit' });
  });

  it('refuses a rollback larger than the bet it reverses', async () => {
    await tx({ userId: user._id, type: 'BET', amount: 100 });
    expect(await reversalAllowed({ roundId: 'r1', userId: user._id, amount: 500 }))
      .toMatchObject({ ok: false, reason: 'refund_exceeds_debit', debited: 100, refunded: 0 });
  });

  it('refuses the second of two partial rollbacks that together exceed the bet', async () => {
    await tx({ userId: user._id, type: 'BET', amount: 100 });
    await tx({ userId: user._id, type: 'ROLLBACK', amount: 60 });
    // Accumulating is the point — a per-callback check against the bet alone
    // would let any number of partial rollbacks through.
    expect(await reversalAllowed({ roundId: 'r1', userId: user._id, amount: 60 }))
      .toMatchObject({ ok: false, reason: 'refund_exceeds_debit', debited: 100, refunded: 60 });
  });

  it('allows a legitimate rollback up to exactly the amount bet', async () => {
    await tx({ userId: user._id, type: 'BET', amount: 100 });
    expect(await reversalAllowed({ roundId: 'r1', userId: user._id, amount: 100 })).toMatchObject({ ok: true });

    await refundOrder(user._id, 100, 'r1', 'depositBalance');
    expect((await User().findById(user._id).lean()).depositBalance).toBe(1100);
  });

  it('does not count another player\'s bet on the same round id', async () => {
    const other = await User().create({ username: 'casino_o', mobile: '9500000002', depositBalance: 0 });
    await tx({ userId: other._id, type: 'BET', amount: 100 });
    // Round ids are provider-supplied and not guaranteed unique across players,
    // so the lookup is scoped by user. Without that, one player's bet would
    // authorise another player's refund.
    expect(await reversalAllowed({ roundId: 'r1', userId: user._id, amount: 100 }))
      .toMatchObject({ ok: false, reason: 'no_prior_debit' });
  });
});
