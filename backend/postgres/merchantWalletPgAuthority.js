// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/merchantWalletPgAuthority.js — merchantWallet.service's operations,
 * executed against Postgres.
 *
 * domains/merchant/merchantWallet.service.js is the single writer of
 * `Merchant.tokenBalance`. This module is the OTHER implementation behind it:
 * same operations, same return shapes, same idempotency keys — merchant_wallets
 * instead of the Mongo Merchant document. Which one runs is decided per call by
 * `isPostgresAuthoritative(MONEY_PATHS.MERCHANT_WALLET)`, and MongoDB is the
 * default. This is the merchant-side counterpart of walletPgAuthority.js; see
 * there for the two contracts both files are bound by (return shapes and
 * byte-identical txIds), which apply here unchanged.
 *
 * ── Three things this path must get right that the user wallet does not ──────
 *
 * 1. POSTGRES HAS NO MERCHANT TABLE. `merchant_wallets` is keyed by a Mongo
 *    ObjectId string with no foreign key behind it, and withMerchantLock will
 *    happily materialise a row for any id at all. The Mongo path distinguishes
 *    "merchant does not exist" (findByIdAndUpdate → null) from "insufficient
 *    balance", and admin routes rely on that distinction to answer 404 vs 400 —
 *    so existence is checked in Mongo BEFORE any Postgres write. That check also
 *    stops a typo'd id from quietly creating an orphan wallet.
 *
 * 2. POCKETS COLLAPSE INTO ONE NUMBER. Postgres splits a merchant's position
 *    into available / reserved / settlement; Mongo has a single `tokenBalance`.
 *    Debits and credits here move `available`, because that is precisely what
 *    the Mongo field means today: the number the `$gte` guard tests and the
 *    amount a merchant may spend. Nothing in production writes `reserved` or
 *    `settlement` yet (that is the unbuilt merchant_settlement domain), so the
 *    two representations currently agree exactly. When that domain lands, the
 *    projection below and reverseMirrorMerchantMovement's total-mapping both
 *    have to be revisited together — recorded in docs/FINANCIAL_DOMAIN_MATRIX.md
 *    as a prerequisite rather than left to be discovered.
 *
 * 3. THE ROLLBACK LEG IS LIVE, NOT BATCH. Every committed movement is mirrored
 *    straight back into Mongo (ledger rows AND balance) rather than waiting for
 *    a reconcile repair pass, because Mongo's idempotency gate for this domain
 *    is `MerchantWalletLedger.findOne({ txId })`: until a movement's row exists
 *    there, a fallback to Mongo would not recognise it and a retry would apply
 *    it twice.
 *
 * ── What a Mongo session means here ─────────────────────────────────────────
 * Nothing, for the money. A `session` argument still scopes the Mongo READ of
 * the merchant document, so a caller inside a transaction sees its own writes;
 * but the Postgres movement is its own transaction and will NOT roll back if
 * the enclosing Mongo transaction aborts. What makes that safe is the same
 * property the user wallet relies on: every movement is keyed by a caller-
 * supplied deterministic txId, so the retry that follows an aborted outer
 * transaction is a no-op rather than a double spend.
 */
import mongoose from 'mongoose';
import { paiseToRupees, rupeesToPaise } from '../shared/money.js';
import { moneyOperations } from '../services/metrics.service.js';
import { POCKETS, applyMerchantMovement, getMerchantBalances } from './merchantWalletPg.js';
import { MONEY_PATHS } from './moneyAuthority.js';
import { reverseMirrorMerchantMovement } from './reverseMirror.js';

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
 * The Mongo document, carrying the Postgres balance.
 *
 * Callers read `merchant.userId` (audit rows), render `merchant` into a JSON
 * response, and test it for truthiness — so this must stay a real hydrated
 * document, not a synthetic object. Only `tokenBalance` is overridden, in
 * memory: while Postgres is authoritative the stored Mongo number is a
 * follower, and the caller must see what actually committed. Nothing saves this
 * document; the reverse mirror is what persists the value.
 */
function withPgBalance(merchant, balances) {
  if (!merchant) return null;
  merchant.tokenBalance = spendable(balances);
  // Non-Mongo extra: the full position, for callers that need to explain a
  // number the single Mongo field cannot ("₹X available, ₹Y awaiting payout").
  merchant.pgBalances = balances;
  return merchant;
}

function loadMerchant(merchantId, session) {
  return mongoose.model('Merchant').findById(merchantId, null, session ? { session } : {});
}

/**
 * The one mutation. debit and credit differ only in sign, operation label and
 * whether an overdraft is permitted, so there is exactly one place where a
 * merchant balance changes on this path.
 */
async function move({
  merchantId, amount, sign, operation, reason, refModel, refId, txId, session,
  allowOverdraft = false,
}) {
  if (!(amount > 0)) throw new Error(`${operation}: amount must be positive, got ${amount}`);
  if (!txId) throw new Error(`${operation}: txId is required (idempotency).`);

  const merchant = await loadMerchant(merchantId, session);
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
    return { merchant: withPgBalance(merchant, await getMerchantBalances(merchantId)), idempotent: true };
  }
  if (!result.ok) {
    count(operation, 'insufficient');
    // Insufficient balance — no mutation happened. The Mongo path signals this
    // the same way, and callers keep their own rollback/response logic.
    return { merchant: null, idempotent: false };
  }

  // Fire-and-forget, exactly like the forward mirror: a Mongo failure must
  // never break a movement Postgres has already committed. Failures are logged,
  // counted and paged inside mirrorBack(), and the reverse reconcile repairs
  // whatever it dropped.
  reverseMirrorMerchantMovement({
    merchantId, entries: result.entries, balances: result.balances,
  });

  count(operation, 'applied');
  return { merchant: withPgBalance(merchant, result.balances), idempotent: false };
}

/**
 * merchantWallet.service.debitMerchantTokens — decrease a merchant's balance.
 * Returns { merchant, idempotent }; merchant is null when the merchant does not
 * exist, or when the balance was insufficient and allowOverdraft was false.
 */
export function debitMerchantTokens({
  merchantId, amount, reason, refModel, refId, txId, session, allowOverdraft = false,
}) {
  return move({
    merchantId, amount, sign: -1,
    operation: 'MERCHANT_DEBIT',
    reason, refModel, refId, txId, session, allowOverdraft,
  });
}

/** merchantWallet.service.creditMerchantTokens — increase a merchant's balance. */
export function creditMerchantTokens({
  merchantId, amount, reason, refModel, refId, txId, session,
}) {
  return move({
    merchantId, amount, sign: 1,
    operation: 'MERCHANT_CREDIT',
    reason, refModel, refId, txId, session,
  });
}

/** The merchant's spendable balance in rupees — the Mongo field's meaning. */
export async function getMerchantTokenBalance(merchantId) {
  return spendable(await getMerchantBalances(merchantId));
}
