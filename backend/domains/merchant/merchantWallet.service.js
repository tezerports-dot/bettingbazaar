// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/merchant/merchantWallet.service.js — the merchant-side money API.
 *
 * THE SOLE writer of a merchant's balance (§1/§2 — the merchant counterpart of
 * walletAuthority.service.js). Before this existed, seven call sites ran their
 * own increment with three different semantics: guarded, blind, and
 * blind-with-swallowed-errors. They all come through here.
 *
 * ── What this file used to be ───────────────────────────────────────────────
 * Around 200 lines implementing a two-phase ledger reservation against the
 * document store: create a ledger row with a null `balanceAfter`, mutate the
 * merchant, fill the balance in, and delete the reservation on failure. It had
 * a `waitForReservedLedger` that POLLED — twenty attempts, 25ms apart — for
 * another request's half-written row to finish, and threw if it never did.
 *
 * Every line of it was unreachable. Both exported functions began with an
 * unconditional `return pg.…()` inside a bare block, left behind when the
 * resolver was deleted, with the whole document implementation dead below it.
 *
 * None of it is needed. `applyMerchantMovement` does the balance and its ledger
 * row in ONE transaction under the merchant's row lock, and `tx_id` UNIQUE is
 * the idempotency gate INSIDE that transaction — so a duplicate collides and
 * unwinds rather than being screened out by a prior read that a concurrent
 * caller would also pass. There is no half-written row to poll for, because
 * there is no phase in which one exists.
 *
 * ── The `session` parameter is gone ─────────────────────────────────────────
 * Callers passed a document-store session so a debit could join their
 * transaction. There is no such transaction to join: each movement is atomic
 * and idempotent on its own key, which is what makes a multi-step flow safe to
 * retry rather than needing to be rolled back.
 */
import * as pg from '#db/repositories/merchantWallets.js';

/**
 * Decrease a merchant's token balance.
 *
 * Returns `{ merchant, idempotent }`. `merchant` is null when the balance was
 * insufficient and `allowOverdraft` was false — no movement happened, and the
 * caller decides what to tell whoever asked.
 */
export function debitMerchantTokens({
  merchantId, amount, reason, refModel, refId, txId, allowOverdraft = false,
}) {
  if (!(amount > 0)) throw new Error(`debitMerchantTokens: amount must be positive, got ${amount}`);
  if (!txId) throw new Error('debitMerchantTokens: txId is required (idempotency).');
  return pg.debitMerchantTokens({ merchantId, amount, reason, refModel, refId, txId, allowOverdraft });
}

/** Increase a merchant's token balance. */
export function creditMerchantTokens({ merchantId, amount, reason, refModel, refId, txId }) {
  if (!(amount > 0)) throw new Error(`creditMerchantTokens: amount must be positive, got ${amount}`);
  if (!txId) throw new Error('creditMerchantTokens: txId is required (idempotency).');
  return pg.creditMerchantTokens({ merchantId, amount, reason, refModel, refId, txId });
}

/**
 * Merchant Performance Bonus payout into the merchant wallet.
 *
 * Keyed on the SAME deterministic id as the MERCHANT_BONUS_ISSUED accounting
 * event, so the ledger entry and the wallet movement can each be retried
 * independently without either being applied twice.
 */
export function creditMerchantBonus({ merchantId, amount, txId, description }) {
  return creditMerchantTokens({
    merchantId, amount,
    reason: description || 'Merchant Performance Bonus',
    refModel: 'AccountingEvent',
    refId: txId,
    txId,
  });
}

/** A merchant's spendable balance. The figure any eligibility gate must read. */
export const getMerchantTokenBalance = (merchantId) => pg.getMerchantTokenBalance(merchantId);

/** Paginated merchant wallet ledger — the merchant's own audit trail. */
export const getMerchantWalletLedger = (merchantId, options) =>
  pg.getMerchantWalletLedger(merchantId, options);
