// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Concurrency & money correctness — the scenarios ordinary unit and integration
 * tests miss because they run one call at a time.
 *
 * Every test here fires many operations SIMULTANEOUSLY against ONE wallet and
 * asserts an invariant that must hold no matter how they interleave:
 *
 *   • money is never created  — total debited ≤ total available
 *   • money is never destroyed — a refused debit leaves the balance untouched
 *   • a balance never goes negative
 *   • a replayed movement charges exactly once, however many copies arrive
 *
 * Assertions are on INVARIANTS, not on a particular winner. Which of 50 racing
 * calls commits first is not deterministic and asserting it would produce a
 * flaky test that teaches nothing.
 *
 * Coverage note: these exercise application-level concurrency against a real
 * MongoDB. They do NOT cover process crashes mid-movement, database failover,
 * or multi-instance contention — those need infrastructure, and the plan for
 * them is in docs/CONCURRENCY_CERTIFICATION.md.
 *
 * Real MongoDB (mongodb-memory-server in CI). Cannot run in the audit sandbox,
 * where the mongod download is blocked — CI is the verifier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { debitForBet, creditWinnings } from '../../domains/wallet/wallet.service.js';

const User   = () => mongoose.model('User');
const Ledger = () => mongoose.model('WalletLedger');

const totalOf = (u) => (u.depositBalance || 0) + (u.winningsBalance || 0);

async function makeUser({ deposit = 0, winnings = 0 }, n = 1) {
  return User().create({
    username: `conc${n}_${Date.now()}`,
    mobile: `93${String(n).padStart(8, '0')}`,
    depositBalance: deposit,
    winningsBalance: winnings,
  });
}

/** Run everything at once and report outcomes without throwing. */
const settleAll = (promises) => Promise.allSettled(promises);
const fulfilled = (results) => results.filter((r) => r.status === 'fulfilled');

beforeEach(async () => {
  await User().deleteMany({});
  await Ledger().deleteMany({});
});

describe('concurrent money movement (real DB)', () => {
  it('charges once when the SAME bet arrives 50 times at once (retry storm)', async () => {
    const u = await makeUser({ deposit: 1000 }, 1);
    const uid = u._id.toString();
    const txId = `bet_${uid}_storm`;

    // A retry storm after a network blip: the same logical bet, many copies.
    const results = await settleAll(
      Array.from({ length: 50 }, () => debitForBet(uid, 100, 'Bet', 'Bet', null, txId)),
    );

    const after = await User().findById(uid).lean();
    expect(totalOf(after)).toBe(900); // charged exactly once
    expect(fulfilled(results).length).toBeGreaterThan(0);

    // Exactly one movement is on the ledger for this bet.
    const rows = await Ledger().find({ txId: { $in: [txId, `${txId}_dep`, `${txId}_win`] } }).lean();
    expect(rows.length).toBe(1);
  });

  it('never overdraws when 100 distinct bets race for a balance that fits 10', async () => {
    const u = await makeUser({ deposit: 1000 }, 2);
    const uid = u._id.toString();

    // 100 genuinely different bets of 100 against a balance of 1000. At most 10
    // can succeed; the rest must be refused, and the balance must never go
    // negative whichever order they land in.
    const results = await settleAll(
      Array.from({ length: 100 }, (_, i) =>
        debitForBet(uid, 100, 'Bet', 'Bet', null, `bet_${uid}_race_${i}`)),
    );

    const after = await User().findById(uid).lean();
    expect(after.depositBalance).toBeGreaterThanOrEqual(0);
    expect(after.winningsBalance).toBeGreaterThanOrEqual(0);

    // Money conservation: what left the wallet equals what the ledger recorded.
    const debited = 1000 - totalOf(after);
    const rows = await Ledger().find({ type: 'DEBIT' }).lean();
    const ledgerTotal = rows.reduce((sum, r) => sum + r.amount, 0);
    expect(ledgerTotal).toBe(debited);
    expect(debited).toBeLessThanOrEqual(1000);

    const charged = fulfilled(results).filter((r) => !r.value?.idempotent).length;
    expect(charged).toBeLessThanOrEqual(10);
  });

  it('credits once when a payment webhook is delivered 20 times (duplicate delivery)', async () => {
    // Providers routinely redeliver. The same txId must credit once.
    const u = await makeUser({ deposit: 0 }, 3);
    const uid = u._id.toString();
    const txId = 'win_provider_tx_1';

    await settleAll(
      Array.from({ length: 20 }, () =>
        creditWinnings(uid, 500, 'Casino WIN', 'GameTransaction', null, txId)),
    );

    const after = await User().findById(uid).lean();
    expect(after.winningsBalance).toBe(500); // credited exactly once

    const rows = await Ledger().find({ txId }).lean();
    expect(rows.length).toBe(1);
  });

  it('keeps the wallet consistent with debits and credits interleaved', async () => {
    // Deposits/wins landing WHILE bets are being placed — the interleaving that
    // produced the debitForBet re-split double-charge.
    const u = await makeUser({ deposit: 500, winnings: 500 }, 4);
    const uid = u._id.toString();

    const work = [
      ...Array.from({ length: 20 }, (_, i) =>
        debitForBet(uid, 50, 'Bet', 'Bet', null, `bet_${uid}_mix_${i}`)),
      ...Array.from({ length: 20 }, (_, i) =>
        creditWinnings(uid, 50, 'Win', 'Bet', null, `win_${uid}_mix_${i}`)),
    ];
    await settleAll(work);

    const after = await User().findById(uid).lean();
    expect(after.depositBalance).toBeGreaterThanOrEqual(0);
    expect(after.winningsBalance).toBeGreaterThanOrEqual(0);

    // The ledger must explain the balance exactly: start + credits − debits.
    const rows = await Ledger().find({}).lean();
    const credits = rows.filter((r) => r.type === 'CREDIT').reduce((s, r) => s + r.amount, 0);
    const debits  = rows.filter((r) => r.type === 'DEBIT').reduce((s, r) => s + r.amount, 0);
    expect(totalOf(after)).toBe(1000 + credits - debits);
  });

  it('never writes two ledger rows for one idempotency key', async () => {
    // The unique index is the durable gate; this proves it holds under a race
    // rather than only in sequential replays.
    const u = await makeUser({ deposit: 10_000 }, 5);
    const uid = u._id.toString();

    await settleAll(
      Array.from({ length: 30 }, () =>
        creditWinnings(uid, 10, 'Win', 'Bet', null, `win_${uid}_dup`)),
    );

    const rows = await Ledger().find({ txId: `win_${uid}_dup` }).lean();
    expect(rows.length).toBe(1);
  });
});
