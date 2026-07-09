// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): reserveBalance is now credited only via
// walletAuthority.creditReserve — idempotent, with a WalletLedger trail
// (was a raw $inc with no audit record; §7 fix, 2026-07-09 audit).
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { creditReserve } from '../../domains/wallet/walletAuthority.service.js';

const User   = () => mongoose.model('User');
const Ledger = () => mongoose.model('WalletLedger');

beforeEach(async () => {
  await User().deleteMany({});
  await Ledger().deleteMany({});
});

describe('creditReserve (real DB)', () => {
  it('credits reserveBalance and writes a ledger entry', async () => {
    const u = await User().create({ username: 'u1', mobile: '9000000001', reserveBalance: 0 });
    const orderId = new mongoose.Types.ObjectId().toString();

    const r = await creditReserve(u._id.toString(), 100, orderId);
    expect(r.reserveAfter).toBe(100);

    const fresh = await User().findById(u._id).lean();
    expect(fresh.reserveBalance).toBe(100);

    const entries = await Ledger().find({ field: 'reserveBalance' }).lean();
    expect(entries.length).toBe(1);
    expect(entries[0].amount).toBe(100);
    expect(entries[0].txId).toBe(`reserve_credit_${orderId}`);
  });

  it('is idempotent — same order credits reserve only once', async () => {
    const u = await User().create({ username: 'u2', mobile: '9000000002', reserveBalance: 0 });
    const orderId = new mongoose.Types.ObjectId().toString();

    await creditReserve(u._id.toString(), 100, orderId);
    const second = await creditReserve(u._id.toString(), 100, orderId);
    expect(second.idempotent).toBe(true);

    const fresh = await User().findById(u._id).lean();
    expect(fresh.reserveBalance).toBe(100); // not 200
    expect(await Ledger().countDocuments({ field: 'reserveBalance' })).toBe(1);
  });
});
