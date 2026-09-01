// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Concurrency & money correctness for the MERCHANT token wallet — the leg the
 * first concurrency pass missed.
 *
 * moneyConcurrency.integration.test.js covers the USER wallet only. Tokens also
 * move user↔merchant (deposit/withdrawal settlement, payment.routes.js and
 * paymentOrder.routes.js) and admin↔merchant (platform token issuance,
 * merchant.routes.js). Those go through debitMerchantTokens/creditMerchantTokens,
 * which had no concurrency coverage at all.
 *
 * That path uses a different primitive from the user wallet: reserve the ledger
 * row FIRST (written with balanceAfter:null), then move the balance, then $set
 * balanceAfter to complete it. A crash in between therefore leaves a row with a
 * null balanceAfter — detectable, and reconcilable — rather than the unaudited
 * balance move _mongoBetStake can produce. These tests pin that the primitive
 * holds when many callers race.
 *
 * Invariants, asserted rather than a particular winner:
 *   • tokens are never created — total debited ≤ starting balance
 *   • an ordinary debit never overdraws (the $gte filter refuses it). NOTE the
 *     schema's min:0 does NOT enforce this — Mongoose skips validators on
 *     findOneAndUpdate — so the $gte filter is the only guard, and
 *     allowOverdraft:true deliberately bypasses it (last test)
 *   • one txId moves tokens exactly once, however many copies arrive
 *   • the ledger explains the balance: start + credits − debits
 *
 * Real MongoDB (mongodb-memory-server in CI). Cannot run in the audit sandbox,
 * where the mongod download is blocked — CI is the verifier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fundedMerchant } from './_fixtures.js';
import mongoose from 'mongoose';
import '../../models/index.js';
import {
  debitMerchantTokens, creditMerchantTokens,
} from '../../domains/merchant/merchantWallet.service.js';

const Merchant = () => mongoose.model('Merchant');
const MLedger  = () => mongoose.model('MerchantWalletLedger');

let merchantId;

const balance = async () => (await Merchant().findById(merchantId).lean()).tokenBalance;
const settleAll = (p) => Promise.allSettled(p);

beforeEach(async () => {
  await Merchant().deleteMany({});
  await MLedger().deleteMany({});
  const m = await fundedMerchant(Merchant().create({
    name: 'ConcurrencyMerchant',
    mobile: `9400${Date.now() % 1000000}`,
    status: 'ACTIVE',
    tokenBalance: 100000,
  }));
  merchantId = m._id;
});

describe('merchant token wallet under concurrency (real DB)', () => {
  it('never overdraws when 200 settlements race a balance that fits 100', async () => {
    // user↔merchant shape: many deposits settling at once, each debiting the
    // merchant's tokens.
    const results = await settleAll(
      Array.from({ length: 200 }, (_, i) => debitMerchantTokens({
        merchantId, amount: 1000, reason: 'Deposit settlement',
        refModel: 'PaymentOrder', refId: null, txId: `mw_settle_${i}`,
      })),
    );

    const after = await balance();
    expect(after).toBeGreaterThanOrEqual(0);

    const moved = results.filter(
      (r) => r.status === 'fulfilled' && r.value.merchant && !r.value.idempotent,
    ).length;
    expect(moved).toBeLessThanOrEqual(100);
    expect(after).toBe(100000 - moved * 1000);
  });

  it('debits once when the same settlement is retried 50 times at once', async () => {
    // Duplicate webhook / retry storm on ONE order.
    const txId = 'mw_settle_duplicate';
    await settleAll(
      Array.from({ length: 50 }, () => debitMerchantTokens({
        merchantId, amount: 5000, reason: 'Deposit settlement',
        refModel: 'PaymentOrder', refId: null, txId,
      })),
    );

    expect(await balance()).toBe(95000); // charged exactly once

    const rows = await MLedger().find({ txId }).lean();
    expect(rows.length).toBe(1);
  });

  it('credits once when an admin token issuance is replayed', async () => {
    // admin↔merchant shape: platform issues tokens to a merchant.
    const txId = 'mw_admin_issue_1';
    await settleAll(
      Array.from({ length: 30 }, () => creditMerchantTokens({
        merchantId, amount: 25000, reason: 'Admin token purchase',
        refModel: 'MerchantAdminTokenOrder', refId: null, txId,
      })),
    );

    expect(await balance()).toBe(125000); // credited exactly once
    expect((await MLedger().find({ txId }).lean()).length).toBe(1);
  });

  it('keeps the ledger explaining the balance with issuance and settlement interleaved', async () => {
    // Admin issuing tokens WHILE user deposits settle against the same merchant.
    const work = [
      ...Array.from({ length: 40 }, (_, i) => debitMerchantTokens({
        merchantId, amount: 500, reason: 'Deposit settlement',
        refModel: 'PaymentOrder', refId: null, txId: `mw_mix_d${i}`,
      })),
      ...Array.from({ length: 40 }, (_, i) => creditMerchantTokens({
        merchantId, amount: 500, reason: 'Admin token purchase',
        refModel: 'MerchantAdminTokenOrder', refId: null, txId: `mw_mix_c${i}`,
      })),
    ];
    await settleAll(work);

    const after = await balance();
    expect(after).toBeGreaterThanOrEqual(0);

    const rows = await MLedger().find({ merchantId }).lean();
    // A reservation is a row with balanceAfter still null (reserveLedger writes
    // the row first, completeLedger $sets the balance). There is no status
    // field — an in-flight reservation must not be counted as applied money.
    const done = rows.filter((r) => r.balanceAfter !== null && r.balanceAfter !== undefined);
    const credits = done.filter((r) => r.type === 'CREDIT').reduce((s, r) => s + r.amount, 0);
    const debits  = done.filter((r) => r.type === 'DEBIT').reduce((s, r) => s + r.amount, 0);

    expect(after).toBe(100000 + credits - debits);
  });

  it('refuses an overdraft rather than going negative', async () => {
    const r = await debitMerchantTokens({
      merchantId, amount: 100001, reason: 'Oversized settlement',
      refModel: 'PaymentOrder', refId: null, txId: 'mw_overdraft',
    });
    expect(r.merchant).toBeNull();       // refused, no mutation
    expect(await balance()).toBe(100000); // untouched
  });

  it('allows a deliberate overdraft only when the caller opts in', async () => {
    // allowOverdraft exists for corrective admin paths; it must be explicit.
    const r = await debitMerchantTokens({
      merchantId, amount: 150000, reason: 'Corrective adjustment',
      refModel: 'AdminAdjustment', refId: null, txId: 'mw_correct',
      allowOverdraft: true,
    });
    // allowOverdraft:true is documented as a BLIND $inc, and Mongoose does not
    // run the schema's min:0 on findOneAndUpdate, so the balance really does go
    // negative. Asserted as "went below zero" rather than an exact figure — the
    // point is that the escape hatch works and is reachable only on request.
    expect(r.merchant).not.toBeNull();
    expect(await balance()).toBeLessThan(0);
  });
});
