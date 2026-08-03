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
//     blind sites — flagged in docs/governance/04-GOVERNANCE.md to tighten later).
//   - Everything accepts an optional mongoose session and joins it.
//   - txId idempotency: if the ledger already has this txId, the mutation is
//     skipped and { idempotent: true } is returned.

import mongoose from 'mongoose';
import { MerchantWalletLedger } from './merchantWallet.model.js';
import { isPostgresAuthoritative, MONEY_PATHS } from '../../postgres/moneyAuthority.js';
import { mirrorMerchantBalance, mirrorMerchantWalletLedger } from '../../postgres/dualWrite.js';
import { moneyOperations } from '../../services/metrics.service.js';
import * as pg from '../../postgres/merchantWalletPgAuthority.js';

/** Is Postgres the source of truth for merchant balances right now? */
const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.MERCHANT_WALLET);

/**
 * Count this movement under the SAME metric the Postgres path uses, differing
 * only in the `store` label. That is what makes a cutover legible: the operation
 * and outcome series continue across the flip, so a change in the idempotent or
 * insufficient rate is visible as a change rather than lost when one series
 * stops and an unrelated one starts.
 */
function count(operation, outcome) {
  moneyOperations.inc({
    path: MONEY_PATHS.MERCHANT_WALLET, store: 'mongo', operation, outcome,
  });
}

/**
 * Mirror the merchant's balance to Postgres after a Mongo-authoritative move.
 *
 * The ledger rows were already mirrored (merchantWallet.model.js post-save);
 * the BALANCE was not, so merchant_wallets stayed empty while its ledger
 * filled. A cutover would then have begun reading balances of zero. This is
 * fire-and-forget for the same reason every other dual-write is: the mirror
 * must never be able to fail a Mongo money movement that has already
 * committed. Failures are counted and alerted inside dualWrite.mirror().
 */
function mirrorBalance(merchant) {
  if (merchant) mirrorMerchantBalance(merchant);
  return merchant;
}

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

/**
 * Fill in the reservation's balanceAfter, and re-mirror the completed row.
 *
 * The re-mirror is not optional. The Postgres mirror is hooked on the model's
 * post-save, which fires when reserveLedger CREATES the row — at that moment
 * balanceAfter is still null, and the updateOne below is not a document save so
 * it fires nothing. Every merchant ledger row in Postgres therefore carried
 * balance_after_paise = NULL, which is the one column a rollback reads to
 * restore Merchant.tokenBalance. Passing the completed doc through the mirror
 * again is what makes the merchant path's dual-write actually complete.
 */
async function completeLedger(ledger, balanceAfter, session) {
  await MerchantWalletLedger.updateOne(
    { txId: ledger.txId }, { $set: { balanceAfter } }, sessOpts(session),
  );
  mirrorMerchantWalletLedger({ ...(ledger.toObject?.() ?? ledger), balanceAfter });
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

  if (onPostgres()) {
    return pg.debitMerchantTokens({
      merchantId, amount, reason, refModel, refId, txId, session, allowOverdraft,
    });
  }

  const reservation = await reserveLedger({
    merchantId, type: 'DEBIT', amount, reason, refModel, refId, txId,
  }, session);
  if (!reservation.reserved) {
    const prior = await waitForReservedLedger(txId, session);
    if (!prior) return debitMerchantTokens({
      merchantId, amount, reason, refModel, refId, txId, session, allowOverdraft,
    });
    const merchant = await mongoose.model('Merchant').findById(merchantId, null, sessOpts(session));
    count('MERCHANT_DEBIT', 'idempotent');
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
    // Mongo cannot tell "no such merchant" from "balance too low" in one
    // findOneAndUpdate — both miss the filter. The Postgres path separates
    // them; here the caller does the follow-up lookup, so the counter records
    // what this layer actually knows.
    count('MERCHANT_DEBIT', 'insufficient');
    return { merchant: null, idempotent: false };
  }

  await completeLedger(reservation.ledger, merchant.tokenBalance, session);

  count('MERCHANT_DEBIT', 'applied');
  return { merchant: mirrorBalance(merchant), idempotent: false };
}

/** creditMerchantTokens — increase a merchant's token balance. */
export async function creditMerchantTokens({
  merchantId, amount, reason, refModel, refId, txId, session,
}) {
  if (!(amount > 0)) throw new Error(`creditMerchantTokens: amount must be positive, got ${amount}`);
  if (!txId) throw new Error('creditMerchantTokens: txId is required (idempotency).');

  if (onPostgres()) {
    return pg.creditMerchantTokens({
      merchantId, amount, reason, refModel, refId, txId, session,
    });
  }

  const reservation = await reserveLedger({
    merchantId, type: 'CREDIT', amount, reason, refModel, refId, txId,
  }, session);
  if (!reservation.reserved) {
    const prior = await waitForReservedLedger(txId, session);
    if (!prior) return creditMerchantTokens({
      merchantId, amount, reason, refModel, refId, txId, session,
    });
    const merchant = await mongoose.model('Merchant').findById(merchantId, null, sessOpts(session));
    count('MERCHANT_CREDIT', 'idempotent');
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
    // A credit has no sufficiency guard, so the only way to miss here is that
    // the merchant does not exist.
    count('MERCHANT_CREDIT', 'not_found');
    return { merchant: null, idempotent: false };
  }

  await completeLedger(reservation.ledger, merchant.tokenBalance, session);

  count('MERCHANT_CREDIT', 'applied');
  return { merchant: mirrorBalance(merchant), idempotent: false };
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
