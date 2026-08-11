// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Routing bet SETTLEMENT — the other half of domain 5's lifecycle.
 *
 * Placement has routed through the resolver for a while. Settlement wrote
 * `Bet.status` directly in two places — gameEngine's losing-side `updateMany`
 * and settlementService's winning-side `bulkWrite` — which left half the
 * lifecycle authoritative in one store and half in the other.
 *
 * ── What is on trial here ───────────────────────────────────────────────────
 * The DECISION, not the movement. `betSettlementPg.test.js` and `betPg.test.js`
 * prove the transitions against a real PostgreSQL. What no database test can
 * see is whether the two halves of a settlement pass agree about which store
 * they are writing to, and whether the Mongo bulk writes are correctly
 * SUPPRESSED when Postgres owns the path. Those are the failures that produce a
 * cycle no reconciliation can interpret:
 *
 *  - route the losing side and not the winning side, and the two stores
 *    disagree in a way indistinguishable from genuine drift;
 *  - leave `updateMany`/`bulkWrite` running on the Postgres branch, and a bet
 *    Postgres REFUSED gets stamped WON in Mongo anyway — a reported failure
 *    turned into a silent one, with the payout never having moved;
 *  - call `creditWinnings` as well as `winBet`, and the payout is credited
 *    twice, because BETS depends on WALLET so both are on Postgres together.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── The seam under test ─────────────────────────────────────────────────────
const pgAuthority = vi.hoisted(() => ({
  onPostgres: false,
  calls: [],
  result: { handled: true, ok: true, idempotent: false },
  resultFor: null, // (args) => result, when a test needs per-bet outcomes
}));

vi.mock('../../postgres/betPgAuthority.js', () => ({
  onPostgres: () => pgAuthority.onPostgres,
  settleBetOnPostgres: async (args) => {
    pgAuthority.calls.push(args);
    return pgAuthority.resultFor ? pgAuthority.resultFor(args) : pgAuthority.result;
  },
}));

const wallet = vi.hoisted(() => ({ creditWinnings: [], releaseLockedStake: [] }));
vi.mock('../../domains/wallet/walletAuthority.service.js', () => ({
  creditWinnings: async (...a) => { wallet.creditWinnings.push(a); },
  releaseLockedStake: async (...a) => { wallet.releaseLockedStake.push(a); },
}));

const mongo = vi.hoisted(() => ({ betBulkWrite: [], txBulkWrite: [] }));
vi.mock('../../models/index.js', () => ({
  Bet: { bulkWrite: async (ops) => { mongo.betBulkWrite.push(ops); } },
  Transaction: { bulkWrite: async (ops) => { mongo.txBulkWrite.push(ops); } },
}));

const { executeSettlementBatch } = await import('../../domains/settlement/settlementService.js');

/** One winning user, with `n` bets, shaped the way gameEngine builds it. */
function userOp(userId, bets) {
  return {
    userId,
    payout: bets.reduce((s, b) => s + b.payout, 0),
    feePercent: 1,
    totalBetAmount: bets.reduce((s, b) => s + b.amount, 0),
    totalLockedDeposit: bets.reduce((s, b) => s + (b.fromDepositBalance || 0), 0),
    totalLockedWinnings: bets.reduce((s, b) => s + (b.fromWinningsBalance || 0), 0),
    betIds: bets.map((b) => b.id),
    betStamps: bets.map((b) => ({
      betId: b.id,
      payout: b.payout,
      platformFee: b.platformFee,
      bet: {
        _id: b.id, userId, cycleId: 'c1', side: 'DELHI', amount: b.amount,
        fromDepositBalance: b.fromDepositBalance || 0,
        fromWinningsBalance: b.fromWinningsBalance || 0,
        fromReserveBalance: b.fromReserveBalance || 0,
        timestamp: new Date(1),
      },
    })),
  };
}

const txOp = (userId) => ({ insertOne: { document: { userId, type: 'BET_WIN' } } });

const oneWinner = () => [userOp('u1', [
  { id: 'b1', amount: 100, payout: 198, platformFee: 2, fromDepositBalance: 100 },
])];

beforeEach(() => {
  pgAuthority.onPostgres = false;
  pgAuthority.calls.length = 0;
  pgAuthority.result = { handled: true, ok: true, idempotent: false };
  pgAuthority.resultFor = null;
  wallet.creditWinnings.length = 0;
  wallet.releaseLockedStake.length = 0;
  mongo.betBulkWrite.length = 0;
  mongo.txBulkWrite.length = 0;
});

describe('the winning side while MongoDB is authoritative', () => {
  it('pays through walletAuthority and stamps the bets, touching Postgres not at all', async () => {
    const r = await executeSettlementBatch(oneWinner(), [txOp('u1')], { onPg: false });

    expect(pgAuthority.calls).toHaveLength(0);
    expect(wallet.creditWinnings).toHaveLength(1);
    expect(wallet.releaseLockedStake).toHaveLength(1);
    expect(mongo.betBulkWrite[0]).toEqual([{
      updateOne: {
        filter: { _id: 'b1', status: { $ne: 'WON' } },
        update: { $set: { status: 'WON', payout: 198, platformFee: 2, settledAt: expect.any(Date) } },
      },
    }]);
    expect(r.refused).toEqual([]);
  });

  it('releases the stake with the full amount and both provenance counters', async () => {
    await executeSettlementBatch([userOp('u1', [
      { id: 'b1', amount: 100, payout: 198, platformFee: 2, fromDepositBalance: 60, fromWinningsBalance: 40 },
    ])], [], { onPg: false });

    expect(wallet.releaseLockedStake[0][1]).toMatchObject({
      amount: 100, fromDeposit: 60, fromWinnings: 40,
    });
  });
});

describe('the winning side once PostgreSQL owns the path', () => {
  it('settles per bet through the authority and does NOT move money twice', async () => {
    await executeSettlementBatch(oneWinner(), [txOp('u1')], { onPg: true });

    expect(pgAuthority.calls).toHaveLength(1);
    expect(pgAuthority.calls[0]).toMatchObject({
      outcome: 'WON', payoutRupees: 198, platformFeeRupees: 2,
      bet: { _id: 'b1', userId: 'u1', amount: 100, fromDepositBalance: 100 },
    });

    // betPg.winBet consumes the locked stake and credits the payout inside ONE
    // transaction. BETS dependsOn WALLET, so by the time this branch is live the
    // wallet path is on Postgres too — calling these as well would credit the
    // payout twice and release the stake twice.
    expect(wallet.creditWinnings).toHaveLength(0);
    expect(wallet.releaseLockedStake).toHaveLength(0);
  });

  it('does NOT re-stamp the bets — the reverse mirror has already written them', async () => {
    await executeSettlementBatch(oneWinner(), [], { onPg: true });
    // The rule from docs/BETS_SETTLEMENT_ROUTING.md: re-stamping would overwrite
    // the bets Postgres deliberately refused, turning a reported failure into a
    // silent one.
    expect(mongo.betBulkWrite).toHaveLength(0);
  });

  it('carries the retained fee, so the cycle total cannot silently read zero', async () => {
    await executeSettlementBatch([userOp('u1', [
      { id: 'b1', amount: 100, payout: 198, platformFee: 2, fromDepositBalance: 100 },
      { id: 'b2', amount: 50, payout: 99, platformFee: 1, fromDepositBalance: 50 },
    ])], [], { onPg: true });

    expect(pgAuthority.calls.map((c) => c.platformFeeRupees)).toEqual([2, 1]);
  });

  it('settles EVERY bet of a multi-bet winner, not one per user', async () => {
    await executeSettlementBatch([userOp('u1', [
      { id: 'b1', amount: 100, payout: 198, platformFee: 2, fromDepositBalance: 100 },
      { id: 'b2', amount: 50, payout: 99, platformFee: 1, fromDepositBalance: 50 },
      { id: 'b3', amount: 25, payout: 49.5, platformFee: 0.5, fromDepositBalance: 25 },
    ])], [], { onPg: true });

    expect(pgAuthority.calls.map((c) => c.bet._id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('passes the bet DOCUMENT, so the funding slices can be derived', async () => {
    // Blocker (b): betStamps used to carry {betId, payout, platformFee} and no
    // document, so slicesFromBet had nothing to read and betPg.settle refuses to
    // settle without slices that sum exactly to the stake.
    await executeSettlementBatch([userOp('u1', [
      { id: 'b1', amount: 100, payout: 198, platformFee: 2, fromDepositBalance: 30, fromWinningsBalance: 20, fromReserveBalance: 50 },
    ])], [], { onPg: true });

    expect(pgAuthority.calls[0].bet).toMatchObject({
      fromDepositBalance: 30, fromWinningsBalance: 20, fromReserveBalance: 50,
    });
  });
});

describe('a refusal is reported, never swallowed', () => {
  it('returns the refused bet with its reason, and stamps nothing', async () => {
    pgAuthority.resultFor = (a) => (a.bet._id === 'b2'
      ? { handled: true, ok: false, reason: 'no_funding_slices' }
      : { handled: true, ok: true });

    const r = await executeSettlementBatch([userOp('u1', [
      { id: 'b1', amount: 100, payout: 198, platformFee: 2, fromDepositBalance: 100 },
      { id: 'b2', amount: 50, payout: 99, platformFee: 1 },
    ])], [], { onPg: true });

    expect(r.refused).toEqual([
      { betId: 'b2', userId: 'u1', outcome: 'WON', reason: 'no_funding_slices' },
    ]);
    expect(mongo.betBulkWrite).toHaveLength(0);
  });

  it('keeps settling the rest of the batch — one bad bet does not strand the good ones', async () => {
    pgAuthority.resultFor = (a) => (a.bet._id === 'b1'
      ? { handled: true, ok: false, reason: 'invalid_transition' }
      : { handled: true, ok: true });

    const r = await executeSettlementBatch([userOp('u1', [
      { id: 'b1', amount: 100, payout: 198, platformFee: 2, fromDepositBalance: 100 },
      { id: 'b2', amount: 50, payout: 99, platformFee: 1, fromDepositBalance: 50 },
    ])], [], { onPg: true });

    expect(pgAuthority.calls).toHaveLength(2);
    expect(r.refused).toHaveLength(1);
  });

  it('THROWS if the authority answers `handled: false` mid-batch', async () => {
    // The resolver changing answer underneath a running pass would settle the
    // winning side in a different store from the losing side. Loud beats a
    // half-settled cycle nobody can reconcile.
    pgAuthority.resultFor = () => ({ handled: false });

    await expect(executeSettlementBatch(oneWinner(), [], { onPg: true }))
      .rejects.toThrow(/authority changed mid-batch/);
  });
});

describe('the Transaction log — blocker (c), decided', () => {
  it('is written on BOTH branches: it is the user\'s history, not the ledger', async () => {
    await executeSettlementBatch(oneWinner(), [txOp('u1')], { onPg: false });
    expect(mongo.txBulkWrite).toHaveLength(1);

    mongo.txBulkWrite.length = 0;
    await executeSettlementBatch(oneWinner(), [txOp('u1')], { onPg: true });
    // Skipping it under Postgres authority would delete winners' payouts from
    // their own transaction history and buy no consistency — the auditable
    // record is wallet_ledger + accounting_events, which betPg writes inside
    // the settling transaction.
    expect(mongo.txBulkWrite).toHaveLength(1);
  });

  it('survives its own failure without failing the settlement', async () => {
    const { Transaction } = await import('../../models/index.js');
    const original = Transaction.bulkWrite;
    Transaction.bulkWrite = async () => { throw new Error('mongo down'); };
    try {
      await expect(executeSettlementBatch(oneWinner(), [txOp('u1')], { onPg: true })).resolves.toBeDefined();
    } finally {
      Transaction.bulkWrite = original;
    }
  });
});

describe('the routing decision is the CALLER\'s, taken once', () => {
  it('follows the flag it is given, not the resolver, so one pass cannot split', async () => {
    // The resolver says Mongo; the pass says Postgres. The pass wins, because
    // gameEngine read the resolver ONCE for the whole cycle and the losing side
    // has already been settled on that answer. A second read here is exactly how
    // the two halves would end up in different stores.
    pgAuthority.onPostgres = false;
    await executeSettlementBatch(oneWinner(), [], { onPg: true });
    expect(pgAuthority.calls).toHaveLength(1);
    expect(wallet.creditWinnings).toHaveLength(0);
  });

  it('falls back to the resolver only when no decision is passed', async () => {
    pgAuthority.onPostgres = true;
    await executeSettlementBatch(oneWinner(), []);
    expect(pgAuthority.calls).toHaveLength(1);
  });
});
