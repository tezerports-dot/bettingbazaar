// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Merchant Platform (BBEPS Phase 008).
//
// THE SOLE writer of Merchant.tokenBalance (docs/governance/04-GOVERNANCE.md §1/§2 — the
// merchant-side counterpart of walletAuthority.service.js). Before Phase
// 008, seven call sites ran their own raw $inc with three different
// semantics (guarded / blind / blind-with-swallowed-errors); they now all
// route through here, gaining a ledger trail and cross-route idempotency.
//
// SEMANTICS (preserved from the sites that were rerouted):
//   - debit with allowOverdraft:false → conditional $gte update; returns
//     { merchant: null } on insufficient balance so callers keep their own
//     rollback/response logic (matches the previously-guarded sites).
//   - debit with allowOverdraft:true  → blind $inc (matches the previously
//     blind sites — flagged in docs/governance/EXECUTION_QUEUE.md to tighten later).
//   - Everything accepts an optional mongoose session and joins it.
//   - txId idempotency: if the ledger already has this txId, the mutation is
//     skipped and { idempotent: true } is returned.

import mongoose from 'mongoose';
import { MerchantWalletLedger } from './merchantWallet.model.js';

function sessOpts(session) { return session ? { session } : {}; }

async function alreadyApplied(txId, session) {
  return MerchantWalletLedger.findOne({ txId }, null, sessOpts(session)).lean();
}

async function reserveLedger({ merchantId, type, amount, reason, refModel, refId, txId }, session) {
  try {
    const [ledger] = await MerchantWalletLedger.create(
      [{ merchantId, type, amount, balanceAfter: null, reason, refModel, refId, txId }],
      sessOpts(session)
    );
    return { ledger, reserved: true };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return { ledger: await alreadyApplied(txId, session), reserved: false };
  }
}

async function completeLedger(txId, balanceAfter, session) {
  await MerchantWalletLedger.updateOne({ txId }, { $set: { balanceAfter } }, sessOpts(session));
}

async function releaseLedgerReservation(txId, session) {
  await MerchantWalletLedger.deleteOne({ txId, balanceAfter: null }, sessOpts(session));
}

async function waitForReservedLedger(txId, session) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const prior = await alreadyApplied(txId, session);
    if (!prior || prior.balanceAfter !== null) return prior;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`merchant wallet txId ${txId} is still pending; retry shortly`);
}

/**
 * debitMerchantTokens — decrease a merchant's token balance.
 * Returns { merchant, idempotent } — merchant is null when the balance was
 * insufficient and allowOverdraft was false (no mutation happened).
 */
export async function debitMerchantTokens({
  merchantId, amount, reason, refModel, refId, txId, session, allowOverdraft = false,
}) {
  if (!(amount > 0)) throw new Error(`debitMerchantTokens: amount must be positive, got ${amount}`);
  if (!txId) throw new Error('debitMerchantTokens: txId is required (idempotency).');

  const reservation = await reserveLedger({
    merchantId, type: 'DEBIT', amount, reason, refModel, refId, txId,
  }, session);
  if (!reservation.reserved) {
    const prior = await waitForReservedLedger(txId, session);
    if (!prior) return debitMerchantTokens({
      merchantId, amount, reason, refModel, refId, txId, session, allowOverdraft,
    });
    const merchant = await mongoose.model('Merchant').findById(merchantId, null, sessOpts(session));
    return { merchant, idempotent: true };
  }

  const Merchant = mongoose.model('Merchant');
  const filter = allowOverdraft
    ? { _id: merchantId }
    : { _id: merchantId, tokenBalance: { $gte: amount } };

  const merchant = await Merchant.findOneAndUpdate(
    filter,
    { $inc: { tokenBalance: -amount } },
    { ...sessOpts(session), new: true }
  );
  if (!merchant) {
    await releaseLedgerReservation(txId, session);
    return { merchant: null, idempotent: false };
  }

  await completeLedger(txId, merchant.tokenBalance, session);

  return { merchant, idempotent: false };
}

/** creditMerchantTokens — increase a merchant's token balance. */
export async function creditMerchantTokens({
  merchantId, amount, reason, refModel, refId, txId, session,
}) {
  if (!(amount > 0)) throw new Error(`creditMerchantTokens: amount must be positive, got ${amount}`);
  if (!txId) throw new Error('creditMerchantTokens: txId is required (idempotency).');

  const reservation = await reserveLedger({
    merchantId, type: 'CREDIT', amount, reason, refModel, refId, txId,
  }, session);
  if (!reservation.reserved) {
    const prior = await waitForReservedLedger(txId, session);
    if (!prior) return creditMerchantTokens({
      merchantId, amount, reason, refModel, refId, txId, session,
    });
    const merchant = await mongoose.model('Merchant').findById(merchantId, null, sessOpts(session));
    return { merchant, idempotent: true };
  }

  const Merchant = mongoose.model('Merchant');
  const merchant = await Merchant.findByIdAndUpdate(
    merchantId,
    { $inc: { tokenBalance: amount } },
    { ...sessOpts(session), new: true }
  );
  if (!merchant) {
    await releaseLedgerReservation(txId, session);
    return { merchant: null, idempotent: false };
  }

  await completeLedger(txId, merchant.tokenBalance, session);

  return { merchant, idempotent: false };
}

/**
 * creditMerchantBonus — Merchant Performance Bonus payout into the merchant
 * wallet. Called by the bonus engine with the SAME deterministic key used
 * for the MERCHANT_BONUS_ISSUED accounting event, so ledger and wallet can
 * each be retried independently without double-application.
 */
export async function creditMerchantBonus({ merchantId, amount, txId, description }) {
  return creditMerchantTokens({
    merchantId, amount,
    reason: description || 'Merchant Performance Bonus',
    refModel: 'AccountingEvent',
    refId: txId,
    txId,
  });
}

/** Paginated merchant wallet ledger (audit trail). */
export async function getMerchantWalletLedger(merchantId, { page = 1, limit = 50 } = {}) {
  const [entries, total] = await Promise.all([
    MerchantWalletLedger.find({ merchantId }).sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    MerchantWalletLedger.countDocuments({ merchantId }),
  ]);
  return { entries, total, page, pages: Math.ceil(total / limit) || 1 };
}
