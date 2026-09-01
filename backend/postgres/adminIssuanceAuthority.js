// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/adminIssuanceAuthority.js — token issuance, behind the resolver.
 *
 * Domain 4. `merchant.admin.routes.js` mints merchant inventory against a fixed
 * 10B cap. Today that is `SystemConfig.adminTokenSupply.minted`: ONE COUNTER,
 * incremented on mint and decremented on failure. This module is the other
 * implementation behind the same two operations, over treasury_accounts /
 * treasury_entries, with the store chosen per call by
 * `isPostgresAuthoritative(MONEY_PATHS.ADMIN_ISSUANCE)`.
 *
 * ── The three defects that must not be carried across ───────────────────────
 * Recorded in treasuryPg.js's header and in docs/MONGO_MONEY_AUDIT.md. They are
 * the reason this domain is worth moving at all — a straight port would be a
 * rewrite of the same bug in a better database.
 *
 * 1. NO IDEMPOTENCY KEY. `reserveAdminMint(amount)` takes an amount and nothing
 *    else. Two deliveries of one admin request mint twice, and nothing in the
 *    system can tell that from two legitimate top-ups. Here every mint carries a
 *    caller-supplied `movementId` and collides on a UNIQUE constraint INSIDE the
 *    transaction.
 *
 * 2. ROLLBACK IS A BLIND, SWALLOWED DECREMENT.
 *    `$inc: { minted: -amount }` with `.catch(() => {})`. A retried rollback
 *    decrements twice — inventing headroom under the cap that was never
 *    released — and if the catch ever fires the supply figure is permanently
 *    wrong with nothing to reconcile against. Here a rollback is a BURN: its own
 *    movement, its own key, its own entries, idempotent, and reconcilable.
 *
 * 3. IT CANNOT SAY WHERE TOKENS WENT. A counter records that 10,000 tokens were
 *    minted, never to whom. Every movement here names the merchant and the order
 *    that caused it.
 *
 * ── Which number means what ─────────────────────────────────────────────────
 * Mongo's `minted` and the treasury's circulating supply are THE SAME QUANTITY
 * reached two ways: `minted` is a running counter, circulating supply is
 * `0 - TOKEN_SUPPLY` derived from double-entry rows. A mint raises both; a
 * rollback lowers both. That equality is what reconcileAdminSupply checks, and
 * it is only meaningful because the rollback is a burn rather than an erasure —
 * a counter you can decrement can be made to agree with anything.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 * Mongo counts TOKENS (rupees). Postgres counts PAISE. The conversion happens
 * here, at the boundary, through the Integer Money Engine.
 */
import mongoose from 'mongoose';
import { paiseToRupees, rupeesToPaise } from '../shared/money.js';
import { moneyOperations } from '../services/metrics.service.js';
import {
  ACCOUNTS, DEFAULT_SUPPLY_CAP_PAISE, mintToMerchantFloat, burnFromMerchantFloat,
  getTreasuryBalances,
} from './treasuryPg.js';

/** Matches the SystemConfig schema default, in tokens. */
export const DEFAULT_CAP_TOKENS = 10_000_000_000;

function count(operation, outcome) {
  moneyOperations.inc({ path: 'admin_issuance', store: 'postgres', operation, outcome });
}

/** The error the routes already translate into a 400. Shape must not change. */
const capExceeded = (detail) =>
  Object.assign(new Error('Admin token supply cap exceeded'), { status: 400, detail });

// ── The supply ceiling an admin configured ───────────────────────────────────
//
// Historical note, kept because it is the reason the guard lives in the
// database and not in this file: the previous implementation enforced the cap
// with a conditional increment on a counter document, and the condition and
// the upsert could not legally be combined — so every admin mint threw, and
// no tokens could be issued at all. It survived because nothing exercised the
// path against a real server. Here the ceiling is enforced by
// `mintToMerchantFloat` inside the same transaction that moves the treasury,
// where two concurrent mints cannot both claim headroom only one of them has.

/** The admin-configured ceiling, so the guard enforces the number an admin set. */
async function configuredCapPaise() {
  try {
    const cfg = await mongoose.model('SystemConfig')
      .findOne({ key: 'main' }).select('adminTokenSupply.cap').lean();
    const cap = cfg?.adminTokenSupply?.cap;
    if (Number.isFinite(cap) && cap >= 0) return rupeesToPaise(cap);
  } catch { /* fall through to the built-in default */ }
  return DEFAULT_SUPPLY_CAP_PAISE;
}

// ── The public operations ────────────────────────────────────────────────────

/**
 * Reserve headroom under the cap for a mint, and record where it went.
 *
 * @param {object} args
 * @param {number} args.amountTokens
 * @param {string} args.movementId  REQUIRED. The idempotency key the Mongo
 *   original does not have. A retried request under the same key mints once.
 * @returns {Promise<{cap:number, minted:number, idempotent:boolean, store:string}>}
 *   `{cap, minted}` is the Mongo `adminTokenSupply` shape the routes render.
 * @throws {Error & {status:400}} when the cap would be exceeded.
 */
export async function reserveAdminMint({
  amountTokens, movementId, merchantId = null, actor = null, reason = null,
  refModel = 'Merchant', refId = null, correlationId = null,
}) {
  if (!(amountTokens > 0) || !Number.isFinite(amountTokens)) {
    throw new Error(`reserveAdminMint: amountTokens must be a positive number, got ${amountTokens}`);
  }
  if (!movementId) throw new Error('reserveAdminMint requires a movementId (idempotency key)');

  const result = await mintToMerchantFloat(rupeesToPaise(amountTokens), {
    movementId, actor, reason: reason || 'Admin token issuance',
    refModel, refId: refId ?? merchantId, correlationId,
    supplyCapPaise: await configuredCapPaise(),
  });

  if (!result.ok) {
    count('ADMIN_MINT', result.reason ?? 'error');
    throw capExceeded({
      capTokens: paiseToRupees(result.capPaise),
      circulatingTokens: paiseToRupees(result.circulatingPaise),
      requestedTokens: paiseToRupees(result.requestedPaise),
    });
  }

  count('ADMIN_MINT', result.idempotent ? 'idempotent' : 'applied');
  const supply = supplyFromBalances(result.balances, await configuredCapPaise());
  return { ...supply, idempotent: result.idempotent, store: 'postgres' };
}

/**
 * Give the headroom back when the mint's downstream credit failed.
 *
 * On Postgres this is a BURN, not an erasure: a second movement with its own
 * key that returns the tokens to TOKEN_SUPPLY. Retrying it is a no-op, and the
 * pair (mint, burn) stays in the history — which is the difference between "we
 * minted and unwound" and "we never minted", a distinction an admin
 * investigating a discrepancy actually needs.
 */
export async function rollbackAdminMint({
  amountTokens, movementId, actor = null, reason = null,
  refModel = 'Merchant', refId = null, correlationId = null,
}) {
  if (!(amountTokens > 0) || !Number.isFinite(amountTokens)) return { ok: false, reason: 'invalid_amount' };
  if (!movementId) throw new Error('rollbackAdminMint requires a movementId (idempotency key)');

  const result = await burnFromMerchantFloat(rupeesToPaise(amountTokens), {
    movementId: `${movementId}_burn`, actor,
    reason: reason || 'Admin token issuance rolled back',
    refModel, refId, correlationId,
  });

  count('ADMIN_MINT_ROLLBACK', result.idempotent ? 'idempotent' : 'applied');
  return { ok: result.ok, idempotent: result.idempotent, store: 'postgres' };
}

/**
 * The current supply position, from whichever store owns it.
 *
 * Returned in the Mongo `{cap, minted}` shape in TOKENS, because that is what
 * the admin panel renders and what every caller already expects.
 */
export async function adminTokenSupply() {
  return supplyFromBalances(await getTreasuryBalances(), await configuredCapPaise());
}

/**
 * treasury balances → the Mongo counter's shape.
 *
 * `minted` is the CIRCULATING SUPPLY, which is the negation of the contra
 * account. `0 - x` rather than `-x` so an untouched treasury reports 0 and not
 * -0 (Object.is(-0, 0) is false, and this number is compared and rendered).
 */
function supplyFromBalances(balances, capPaise) {
  return {
    cap: paiseToRupees(capPaise),
    minted: paiseToRupees(0 - (balances[ACCOUNTS.TOKEN_SUPPLY] ?? 0)),
  };
}
