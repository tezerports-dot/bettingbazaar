// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * postgres/adminIssuanceAuthority.js — token issuance, behind the resolver.
 *
 * Domain 4. `merchant.admin.routes.js` transfers merchant inventory out of the
 * platform's own holding — 20,000,000,000 tokens that already exist, never
 * created (owner, 2026-09-23). The figure it moves against is
 * `SystemConfig.adminTokenSupply.transferred`: ONE COUNTER, incremented on a
 * transfer out and decremented on failure. This module is the other
 * implementation behind the same two operations, over treasury_accounts /
 * treasury_entries.
 *
 * ── The three defects that must not be carried across ───────────────────────
 * Recorded in treasury.js's header. They are
 * the reason this domain is worth moving at all — a straight port would be a
 * rewrite of the same bug in a better database.
 *
 * 1. NO IDEMPOTENCY KEY. `reserveAdminTransfer(amount)` takes an amount and
 *    nothing else. Two deliveries of one admin request transfer twice, and
 *    nothing in the system can tell that from two legitimate top-ups. Here
 *    every transfer carries a caller-supplied `movementId` and collides on a
 *    UNIQUE constraint INSIDE the transaction.
 *
 * 2. ROLLBACK IS A BLIND, SWALLOWED DECREMENT.
 *    `$inc: { transferred: -amount }` with `.catch(() => {})`. A retried rollback
 *    decrements twice — inventing holdings that were never released — and if the catch ever fires the supply figure is permanently
 *    wrong with nothing to reconcile against. Here a rollback is a BURN: its own
 *    movement, its own key, its own entries, idempotent, and reconcilable.
 *
 * 3. IT CANNOT SAY WHERE TOKENS WENT. A counter records that 10,000 tokens left
 *    the platform's holding, never to whom. Every movement here names the
 *    merchant and the order that caused it.
 *
 * ── Which number means what ─────────────────────────────────────────────────
 * The `transferred` counter and the treasury's handed-out total are THE SAME
 * QUANTITY reached two ways: one is a running counter, the other is
 * `0 - TOKEN_SUPPLY` derived from double-entry rows. A transfer raises both; a
 * rollback lowers both. That equality is what reconcileAdminSupply checks, and
 * it is only meaningful because the rollback is a return rather than an erasure
 * — a counter you can decrement can be made to agree with anything.
 *
 * What the platform still HOLDS is `total - transferred`, and that is the
 * figure an operator needs before promising a merchant inventory.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 * The panels count TOKENS (rupees). The ledger counts PAISE. The conversion happens
 * here, at the boundary, through the Integer Money Engine.
 */
import { paiseToRupees, rupeesToPaise } from '../../backend/shared/money.js';
import { getSystemConfig } from './config.js';
import { moneyOperations } from '../../backend/services/metrics.service.js';
import {
  ACCOUNTS, TOTAL_SUPPLY_PAISE, transferToMerchantFloat, burnFromMerchantFloat,
  getTreasuryBalances,
} from './treasury.js';

/** Matches the SystemConfig schema default, in tokens. */
export const TOTAL_TOKEN_SUPPLY = 20_000_000_000;

function count(operation, outcome) {
  moneyOperations.inc({ path: 'admin_issuance', store: 'postgres', operation, outcome });
}

/** The error the routes already translate into a 400. Shape must not change. */
const supplyExhausted = (detail) =>
  Object.assign(
    new Error('The platform does not hold enough tokens left to transfer'),
    { status: 400, detail },
  );

// ── The supply ceiling an admin configured ───────────────────────────────────
//
// Historical note, kept because it is the reason the guard lives in the
// database and not in this file: the previous implementation enforced the limit
// with a conditional increment on a counter document, and the condition and
// the upsert could not legally be combined — so every admin transfer threw, and
// no tokens could reach a merchant at all. It survived because nothing
// exercised the path against a real server. Here it is enforced by
// `transferToMerchantFloat` inside the same transaction that moves the
// treasury, where two concurrent transfers cannot both claim tokens only one of
// them can have.

/**
 * The admin-configured ceiling, so the guard enforces the number an admin set.
 *
 * Falls back to the built-in default when the setting is absent or unusable.
 * That fallback is deliberate and must stay: this is how many tokens exist at
 * all, and a configuration read that fails must not read as "unlimited".
 */
async function configuredTotalPaise() {
  try {
    const cfg = await getSystemConfig();
    const total = cfg?.adminTokenSupply?.total;
    if (Number.isFinite(total) && total >= 0) return rupeesToPaise(total);
  } catch { /* fall through to the built-in default */ }
  return TOTAL_SUPPLY_PAISE;
}

// ── The public operations ────────────────────────────────────────────────────

/**
 * Take tokens out of the platform's holding, and record where they went.
 *
 * @param {object} args
 * @param {number} args.amountTokens
 * @param {string} args.movementId  REQUIRED. The idempotency key the
 *   original does not have. A retried request under the same key transfers once.
 * @returns {Promise<{total:number, transferred:number, remaining:number, idempotent:boolean, store:string}>}
 *   the `adminTokenSupply` position the routes render.
 * @throws {Error & {status:400}} when the platform does not hold that many.
 */
export async function reserveAdminTransfer({
  amountTokens, movementId, merchantId = null, actor = null, reason = null,
  refModel = 'Merchant', refId = null, correlationId = null,
}) {
  if (!(amountTokens > 0) || !Number.isFinite(amountTokens)) {
    throw new Error(`reserveAdminTransfer: amountTokens must be a positive number, got ${amountTokens}`);
  }
  if (!movementId) throw new Error('reserveAdminTransfer requires a movementId (idempotency key)');

  const result = await transferToMerchantFloat(rupeesToPaise(amountTokens), {
    movementId, actor, reason: reason || 'Admin token transfer to merchant',
    refModel, refId: refId ?? merchantId, correlationId,
    supplyCapPaise: await configuredTotalPaise(),
  });

  if (!result.ok) {
    count('ADMIN_TRANSFER', result.reason ?? 'error');
    throw supplyExhausted({
      capTokens: paiseToRupees(result.capPaise),
      circulatingTokens: paiseToRupees(result.circulatingPaise),
      requestedTokens: paiseToRupees(result.requestedPaise),
    });
  }

  count('ADMIN_TRANSFER', result.idempotent ? 'idempotent' : 'applied');
  const supply = supplyFromBalances(result.balances, await configuredTotalPaise());
  return { ...supply, idempotent: result.idempotent, store: 'postgres' };
}

/**
 * Put the tokens back when the transfer's downstream credit failed.
 *
 * A RETURN, not an erasure: a second movement with its own key that puts the
 * tokens back into the platform's holding. Retrying it is a no-op, and the pair
 * (transfer, return) stays in the history — which is the difference between "we
 * handed them out and took them back" and "we never handed them out", a
 * distinction an admin investigating a discrepancy actually needs.
 */
export async function rollbackAdminTransfer({
  amountTokens, movementId, actor = null, reason = null,
  refModel = 'Merchant', refId = null, correlationId = null,
}) {
  if (!(amountTokens > 0) || !Number.isFinite(amountTokens)) return { ok: false, reason: 'invalid_amount' };
  if (!movementId) throw new Error('rollbackAdminTransfer requires a movementId (idempotency key)');

  const result = await burnFromMerchantFloat(rupeesToPaise(amountTokens), {
    movementId: `${movementId}_burn`, actor,
    reason: reason || 'Admin token issuance rolled back',
    refModel, refId, correlationId,
  });

  count('ADMIN_TRANSFER_ROLLBACK', result.idempotent ? 'idempotent' : 'applied');
  return { ok: result.ok, idempotent: result.idempotent, store: 'postgres' };
}

/**
 * Where the platform's tokens are, in TOKENS.
 *
 * `remaining` is the figure an operator actually needs — how many of the
 * platform's own tokens are left to sell to merchants — and nothing reported it
 * before: the position was `{cap, minted}`, which asks the reader to do the
 * subtraction and names a ceiling on creation that no longer describes this
 * platform.
 */
export async function adminTokenSupply() {
  return supplyFromBalances(await getTreasuryBalances(), await configuredTotalPaise());
}

/**
 * treasury balances -> the position the panel renders.
 *
 * `transferred` is what has left the platform's holding, which is the negation
 * of the contra account. `0 - x` rather than `-x` so an untouched treasury
 * reports 0 and not -0 (Object.is(-0, 0) is false, and this number is compared
 * and rendered).
 */
function supplyFromBalances(balances, totalPaise) {
  const transferredPaise = 0 - (balances[ACCOUNTS.TOKEN_SUPPLY] ?? 0);
  return {
    total: paiseToRupees(totalPaise),
    transferred: paiseToRupees(transferredPaise),
    remaining: paiseToRupees(totalPaise - transferredPaise),
  };
}
