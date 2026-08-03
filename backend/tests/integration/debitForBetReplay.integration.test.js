// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Integration test (real DB): debitForBet must charge a bet exactly once, even
 * when a replay recomputes a DIFFERENT pocket split than the original.
 *
 * debitForBet writes one ledger row per pocket it actually draws from —
 * `<base>_dep` for the deposit portion, `<base>_win` for the winnings
 * shortfall — and writes NO row for a pocket it did not touch. The WalletLedger
 * unique txId index is the durable idempotency gate, but it can only fire when
 * the replay writes a key that already exists.
 *
 * The split is recomputed from the balances as they are at replay time, so a
 * deposit landing between the two attempts can move the whole charge into a
 * different pocket:
 *
 *   original: deposit 0,   winnings 100 → bet 50 writes <base>_win only
 *   …a deposit of 100 lands…
 *   replay:   deposit 100, winnings 50  → bet 50 writes <base>_dep only
 *
 * No key repeats, so the unique index never fires and the transaction commits a
 * SECOND debit for the same bet. The old pre-read did not catch it either: it
 * looked only for `<base>_dep` and the bare key, and neither existed.
 *
 * This is the MongoDB twin of the hazard postgres/walletPg.js documents on
 * debitSpendOrderPaise. It matters more here, because MongoDB is the
 * authoritative money store today.
 *
 * These run against a real MongoDB (mongodb-memory-server in CI). They cannot
 * run in the restricted audit sandbox, where the mongod download is blocked —
 * CI is the verifier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { debitForBet } from '../../domains/wallet/wallet.service.js';

const User   = () => mongoose.model('User');
const Ledger = () => mongoose.model('WalletLedger');

const totalOf = (u) => (u.depositBalance || 0) + (u.winningsBalance || 0);

beforeEach(async () => {
  await User().deleteMany({});
  await Ledger().deleteMany({});
});

describe('debitForBet replay safety (real DB)', () => {
  it('does not charge twice when a deposit changes the split between attempts', async () => {
    const u = await User().create({
      username: 'replay1', mobile: '9100000001',
      depositBalance: 0, winningsBalance: 100,
    });
    const uid = u._id.toString();
    const txId = `bet_${uid}_cycle1_bet1`;

    // Original: nothing in deposit, so the whole stake comes from winnings and
    // only a `_win` row is written.
    const first = await debitForBet(uid, 50, 'Bet', 'Bet', null, txId);
    expect(first.idempotent).toBeFalsy();
    expect(first.fromWinnings).toBe(50);
    expect(first.fromDeposit).toBe(0);

    const afterFirst = await User().findById(uid).lean();
    expect(totalOf(afterFirst)).toBe(50); // 100 − 50

    // A deposit lands, so a replay would now draw from deposit instead.
    await User().updateOne({ _id: u._id }, { $inc: { depositBalance: 100 } });
    const beforeReplay = await User().findById(uid).lean();
    expect(totalOf(beforeReplay)).toBe(150);

    // Replay of the SAME bet. It must be recognised as already charged.
    const second = await debitForBet(uid, 50, 'Bet', 'Bet', null, txId);
    expect(second.idempotent).toBe(true);

    const afterReplay = await User().findById(uid).lean();
    expect(totalOf(afterReplay)).toBe(150); // unchanged — not charged twice
    expect(afterReplay.depositBalance).toBe(100);
    expect(afterReplay.winningsBalance).toBe(50);

    // And exactly one movement is on the ledger for this bet.
    const rows = await Ledger().find({ txId: { $in: [txId, `${txId}_dep`, `${txId}_win`] } }).lean();
    expect(rows.length).toBe(1);
    expect(rows[0].txId).toBe(`${txId}_win`);
  });

  it('does not charge twice in the mirror case (deposit-only original)', async () => {
    const u = await User().create({
      username: 'replay2', mobile: '9100000002',
      depositBalance: 100, winningsBalance: 0,
    });
    const uid = u._id.toString();
    const txId = `bet_${uid}_cycle2_bet2`;

    const first = await debitForBet(uid, 50, 'Bet', 'Bet', null, txId);
    expect(first.fromDeposit).toBe(50);
    expect(first.fromWinnings).toBe(0);

    // Spend the rest of deposit elsewhere and credit winnings, so a replay
    // would now be a winnings-only draw.
    await User().updateOne({ _id: u._id }, { $set: { depositBalance: 0, winningsBalance: 100 } });

    const second = await debitForBet(uid, 50, 'Bet', 'Bet', null, txId);
    expect(second.idempotent).toBe(true);

    const after = await User().findById(uid).lean();
    expect(totalOf(after)).toBe(100); // untouched by the replay

    const rows = await Ledger().find({ txId: { $in: [txId, `${txId}_dep`, `${txId}_win`] } }).lean();
    expect(rows.length).toBe(1);
    expect(rows[0].txId).toBe(`${txId}_dep`);
  });

  it('still charges a genuinely different bet with a similar key', async () => {
    // Guard against over-correction: the probe matches exact keys, not
    // prefixes, so a distinct bet must still go through.
    const u = await User().create({
      username: 'replay3', mobile: '9100000003',
      depositBalance: 200, winningsBalance: 0,
    });
    const uid = u._id.toString();

    await debitForBet(uid, 50, 'Bet', 'Bet', null, `bet_${uid}_c_b1`);
    await debitForBet(uid, 50, 'Bet', 'Bet', null, `bet_${uid}_c_b10`);

    const after = await User().findById(uid).lean();
    expect(totalOf(after)).toBe(100); // both charged
  });

  it('replays as a no-op when the split is unchanged (pre-existing behaviour)', async () => {
    const u = await User().create({
      username: 'replay4', mobile: '9100000004',
      depositBalance: 100, winningsBalance: 100,
    });
    const uid = u._id.toString();
    const txId = `bet_${uid}_c_stable`;

    await debitForBet(uid, 50, 'Bet', 'Bet', null, txId);
    const once = await User().findById(uid).lean();

    const again = await debitForBet(uid, 50, 'Bet', 'Bet', null, txId);
    expect(again.idempotent).toBe(true);

    const twice = await User().findById(uid).lean();
    expect(totalOf(twice)).toBe(totalOf(once));
  });
});
