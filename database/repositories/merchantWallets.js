// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/merchantWallets.js — a merchant's money, in the vocabulary the
 * merchant domain calls it by.
 *
 * `merchantWallets.core.js` holds the mechanism: the row lock, the pocket
 * arithmetic, the idempotency gate and the ledger entry, all in one
 * transaction. This file is the shape the services call it in.
 *
 * ── One number, three pockets ───────────────────────────────────────────────
 * A merchant's position splits into available / reserved / settlement, and
 * `tokenBalance` — the figure every sufficiency check is written against — is
 * the AVAILABLE pocket alone. Reporting the total instead would tell a merchant
 * they can spend tokens that are already committed to a payout, which is how a
 * merchant accepts an order they cannot fund.
 *
 * ── Existence is checked before the wallet is touched ───────────────────────
 * `withMerchantLock` will happily materialise a wallet row for any id at all,
 * so a typo'd merchant id would quietly create an orphan wallet and report a
 * successful movement. The merchant is looked up first, which also gives admin
 * routes the distinction they answer on: 404 for a merchant that does not
 * exist, 400 for one whose balance is short.
 */
import { paiseToRupees, rupeesToPaise } from '../../backend/shared/money.js';
import { moneyOperations } from '../../backend/services/metrics.service.js';
import { POCKETS, applyMerchantMovement, getMerchantBalances } from './merchantWallets.core.js';
import { getMerchant } from './merchants.js';
import { MONEY_PATHS } from '../moneyPaths.js';
import { pgQuery } from '../client.js';

/** Every exit from move() is counted, so retries and refusals are visible. */
function count(operation, outcome) {
  moneyOperations.inc({
    path: MONEY_PATHS.MERCHANT_WALLET, store: 'postgres', operation, outcome,
  });
}

/**
 * The spendable pocket, in rupees — what `Merchant.tokenBalance` means.
 *
 * Deliberately NOT the total: `tokenBalance` is the number every caller's
 * sufficiency check is written against, and reporting a figure that includes
 * reserved or owed-out tokens would tell a merchant they can spend money that
 * is already committed.
 */
const spendable = (balances) => paiseToRupees(balances.available);

/**
 * The merchant record, with the balance the WALLET holds attached.
 *
 * Callers read `merchant.userId` for audit rows, render it into a response, and
 * test it for truthiness. `tokenBalance` is set from `merchant_wallets` rather
 * than from any column on the merchant row — the merchants table deliberately
 * has none, because one place holds a merchant's money and every movement of it
 * goes through that place under a row lock.
 *
 * `balances` carries the full position for callers that must explain a figure a
 * single number cannot: "₹X available, ₹Y awaiting payout".
 */
function withBalance(merchant, balances) {
  if (!merchant) return null;
  return { ...merchant, tokenBalance: spendable(balances), balances };
}

/**
 * The one mutation. debit and credit differ only in sign, operation label and
 * whether an overdraft is permitted, so there is exactly one place where a
 * merchant balance changes on this path.
 */
async function move({
  merchantId, amount, sign, operation, reason, refModel, refId, txId,
  allowOverdraft = false,
}) {
  if (!(amount > 0)) throw new Error(`${operation}: amount must be positive, got ${amount}`);
  if (!txId) throw new Error(`${operation}: txId is required (idempotency).`);

  const merchant = await getMerchant(merchantId);
  if (!merchant) {
    count(operation, 'not_found');
    return { merchant: null, idempotent: false };
  }

  const amountPaise = rupeesToPaise(amount);
  let result;
  try {
    result = await applyMerchantMovement({
      merchantId,
      txId,
      operation,
      legs: { [POCKETS.AVAILABLE]: sign * amountPaise },
      reason,
      refModel,
      refId,
      // The Mongo path's allowOverdraft:true is a blind $inc that may drive the
      // balance negative; the same authorisation is what lifts the Postgres
      // guard. Neither store silently refuses it, and both record it.
      allowNegativeAvailable: allowOverdraft,
    });
  } catch (error) {
    count(operation, 'error');
    throw error;
  }

  if (result.idempotent) {
    count(operation, 'idempotent');
    // Return the CURRENT balance, not the pre-movement snapshot: a replay must
    // report where the money is now, which is what the first attempt left.
    return { merchant: withBalance(merchant, await getMerchantBalances(merchantId)), idempotent: true };
  }
  if (!result.ok) {
    count(operation, 'insufficient');
    // Insufficient balance — no mutation happened. The Mongo path signals this
    // the same way, and callers keep their own rollback/response logic.
    return { merchant: null, idempotent: false };
  }

  count(operation, 'applied');
  return { merchant: withBalance(merchant, result.balances), idempotent: false };
}

/**
 * merchantWallet.service.debitMerchantTokens — decrease a merchant's balance.
 * Returns { merchant, idempotent }; merchant is null when the merchant does not
 * exist, or when the balance was insufficient and allowOverdraft was false.
 */
export function debitMerchantTokens({
  merchantId, amount, reason, refModel, refId, txId, allowOverdraft = false,
}) {
  return move({
    merchantId, amount, sign: -1,
    operation: 'MERCHANT_DEBIT',
    reason, refModel, refId, txId, allowOverdraft,
  });
}

/** merchantWallet.service.creditMerchantTokens — increase a merchant's balance. */
export function creditMerchantTokens({
  merchantId, amount, reason, refModel, refId, txId,
}) {
  return move({
    merchantId, amount, sign: 1,
    operation: 'MERCHANT_CREDIT',
    reason, refModel, refId, txId,
  });
}

/**
 * The merchant's spendable balance, in rupees.
 *
 * There is one place a merchant's token balance lives — `merchant_wallets` —
 * and every movement of those tokens goes through it under a row lock. Reading
 * the number off a merchant record instead is how an order came to be routed to
 * a merchant with no tokens to serve it: accepted, unfundable, and the player
 * left waiting.
 */
/**
 * A merchant's wallet ledger, one page with its total from the same query.
 *
 * The document version ran `find()` and `countDocuments()` in parallel — two
 * reads of a table that accepts a movement between them, so the total belonged
 * to a different instant than the page. On a merchant's own audit trail that is
 * a footer saying 41 above a last page holding 43.
 */
export async function getMerchantWalletLedger(merchantId, { page = 1, limit = 50 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset = Math.max((Number(page) || 1) - 1, 0) * size;
  const { rows } = await pgQuery(
    `SELECT *, COUNT(*) OVER () AS total_rows
       FROM merchant_wallet_entries
      WHERE merchant_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [String(merchantId), size, offset], 'merchant_ledger_page',
  );
  const total = rows.length ? Number(rows[0].total_rows) : 0;
  return {
    entries: rows.map((r) => ({
      id: Number(r.id),
      merchantId: r.merchant_id,
      type: r.entry_type,
      pocket: r.pocket,
      operation: r.operation,
      amount: paiseToRupees(Number(r.amount_paise)),
      balanceBefore: paiseToRupees(Number(r.balance_before_paise)),
      balanceAfter: paiseToRupees(Number(r.balance_after_paise)),
      actor: r.actor,
      reason: r.reason,
      refModel: r.ref_model,
      refId: r.ref_id,
      txId: r.tx_id,
      movementId: r.movement_id,
      createdAt: r.created_at,
    })),
    total,
    page: Math.max(Number(page) || 1, 1),
    pages: Math.max(Math.ceil(total / size), 1),
  };
}

export async function getMerchantTokenBalance(merchantId) {
  return spendable(await getMerchantBalances(merchantId));
}
