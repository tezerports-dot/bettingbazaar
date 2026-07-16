// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): the merchant token wallet is a TRANSFER
// mechanism, not a mint. Proves the safety property behind audit fix F-1 —
// a debit without allowOverdraft REFUSES when the merchant is short (returns
// merchant:null), so the deposit-confirm path can decline instead of
// crediting the user against tokens that don't exist.
import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { debitMerchantTokens, creditMerchantTokens } from '../../domains/merchant/merchantWallet.service.js';

const Merchant = () => mongoose.model('Merchant');
const Ledger   = () => mongoose.model('MerchantWalletLedger');

beforeEach(async () => {
  await Merchant().deleteMany({});
  await Ledger().deleteMany({});
});

describe('merchant wallet transfer safety (F-1)', () => {
  it('refuses to debit below zero without allowOverdraft (no minting)', async () => {
    const m = await Merchant().create({ name: 'M One', username: 'm1', mobile: '9000001001', tokenBalance: 50 });
    const { merchant } = await debitMerchantTokens({
      merchantId: m._id, amount: 100, reason: 'test', refModel: 'PaymentOrder',
      refId: 'o1', txId: 'mw_test_1',
    });
    expect(merchant).toBeNull(); // refused — caller must NOT credit the user
    const fresh = await Merchant().findById(m._id).lean();
    expect(fresh.tokenBalance).toBe(50); // untouched
  });

  it('debits when funded and records a ledger entry', async () => {
    const m = await Merchant().create({ name: 'M Two', username: 'm2', mobile: '9000001002', tokenBalance: 500 });
    const { merchant } = await debitMerchantTokens({
      merchantId: m._id, amount: 100, reason: 'test', refModel: 'PaymentOrder',
      refId: 'o2', txId: 'mw_test_2',
    });
    expect(merchant.tokenBalance).toBe(400);
    expect(await Ledger().countDocuments({ type: 'DEBIT' })).toBe(1);
  });

  it('debit is idempotent — same txId does not double-deduct', async () => {
    const m = await Merchant().create({ name: 'M Three', username: 'm3', mobile: '9000001003', tokenBalance: 500 });
    await debitMerchantTokens({ merchantId: m._id, amount: 100, reason: 't', refModel: 'PaymentOrder', refId: 'o3', txId: 'mw_test_3' });
    const again = await debitMerchantTokens({ merchantId: m._id, amount: 100, reason: 't', refModel: 'PaymentOrder', refId: 'o3', txId: 'mw_test_3' });
    expect(again.idempotent).toBe(true);
    const fresh = await Merchant().findById(m._id).lean();
    expect(fresh.tokenBalance).toBe(400); // not 300
  });


  it('concurrent debit retries with the same txId apply only one balance mutation', async () => {
    const m = await Merchant().create({ name: 'M Five', username: 'm5', mobile: '9000001005', tokenBalance: 500 });
    const attempts = await Promise.all(Array.from({ length: 8 }, () => debitMerchantTokens({
      merchantId: m._id, amount: 100, reason: 'concurrent retry', refModel: 'PaymentOrder',
      refId: 'o5', txId: 'mw_test_concurrent_5',
    })));

    expect(attempts.filter(result => !result.idempotent)).toHaveLength(1);
    expect(attempts.filter(result => result.idempotent)).toHaveLength(7);
    const fresh = await Merchant().findById(m._id).lean();
    expect(fresh.tokenBalance).toBe(400);
    expect(await Ledger().countDocuments({ txId: 'mw_test_concurrent_5' })).toBe(1);
  });

  it('compensating refund restores the merchant (F-1 rollback path)', async () => {
    const m = await Merchant().create({ name: 'M Four', username: 'm4', mobile: '9000001004', tokenBalance: 500 });
    await debitMerchantTokens({ merchantId: m._id, amount: 100, reason: 't', refModel: 'PaymentOrder', refId: 'o4', txId: 'mw_dep_deduct_o4' });
    await creditMerchantTokens({ merchantId: m._id, amount: 100, reason: 'reversed', refModel: 'PaymentOrder', refId: 'o4', txId: 'mw_dep_refund_o4' });
    const fresh = await Merchant().findById(m._id).lean();
    expect(fresh.tokenBalance).toBe(500); // net zero after debit + compensating credit
  });
});
