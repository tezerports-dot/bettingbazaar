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
import { isPostgresAuthoritative, MONEY_PATHS } from './moneyAuthority.js';
import {
  ACCOUNTS, DEFAULT_SUPPLY_CAP_PAISE, mintToMerchantFloat, burnFromMerchantFloat,
  getTreasuryBalances,
} from './treasuryPg.js';
import { mirrorAdminSupply } from './dualWrite.js';
import { reverseMirrorAdminSupply } from './reverseMirror.js';

/** Matches the SystemConfig schema default, in tokens. */
export const DEFAULT_CAP_TOKENS = 10_000_000_000;

const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.ADMIN_ISSUANCE);

function count(operation, outcome, store) {
  moneyOperations.inc({ path: MONEY_PATHS.ADMIN_ISSUANCE, store, operation, outcome });
}

/** The error the routes already translate into a 400. Shape must not change. */
const capExceeded = (detail) =>
  Object.assign(new Error('Admin token supply cap exceeded'), { status: 400, detail });

// ── MongoDB: the original, unchanged in behaviour ────────────────────────────

async function reserveOnMongo(amountTokens) {
  const SystemConfig = mongoose.model('SystemConfig');
  const cfg = await SystemConfig.findOneAndUpdate(
    {
      key: 'main',
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ['$adminTokenSupply.minted', 0] }, amountTokens] },
          { $ifNull: ['$adminTokenSupply.cap', DEFAULT_CAP_TOKENS] },
        ],
      },
    },
    {
      $setOnInsert: { key: 'main', 'adminTokenSupply.cap': DEFAULT_CAP_TOKENS },
      $inc: { 'adminTokenSupply.minted': amountTokens },
    },
    { upsert: true, new: true },
  ).lean();
  if (!cfg) throw capExceeded(null);
  return cfg.adminTokenSupply;
}

async function rollbackOnMongo(amountTokens) {
  await mongoose.model('SystemConfig').findOneAndUpdate(
    { key: 'main' },
    { $inc: { 'adminTokenSupply.minted': -amountTokens } },
  ).catch(() => {});
}

/** The Mongo cap, so the Postgres guard enforces the SAME number an admin set. */
async function capPaiseFromMongo() {
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

  if (!onPostgres()) {
    const supply = await reserveOnMongo(amountTokens);
    count('ADMIN_MINT', 'applied', 'mongo');
    // Project the counter's movement onto the treasury so a cutover finds the
    // supply already there.
    //
    // AWAITED, unlike every other mirror in the codebase, and deliberately.
    // The others are called from Mongoose post-save hooks where awaiting is not
    // an option; this one has a caller. Two reasons it should wait:
    //
    //  - reconcileAdminSupply compares the counter against the derived total,
    //    and an unawaited mirror leaves a window after EVERY mint in which
    //    those two legitimately disagree. A drift check that fires on ordinary
    //    traffic is one an operator learns to ignore, which costs more than the
    //    round-trip saves.
    //  - issuance is a human-initiated admin action, not a hot path. A few
    //    milliseconds is not a trade worth making for a response that claims
    //    tokens were minted while the ledger does not yet know.
    //
    // Safe to await because mirror() cannot throw — it logs, counts and pages
    // internally. Mongo has already committed and still owns the decision.
    await mirrorAdminSupply({
      movementId, amountPaise: rupeesToPaise(amountTokens),
      merchantId, actor, reason, refModel, refId, correlationId,
    });
    return { ...supply, idempotent: false, store: 'mongo' };
  }

  const result = await mintToMerchantFloat(rupeesToPaise(amountTokens), {
    movementId, actor, reason: reason || 'Admin token issuance',
    refModel, refId: refId ?? merchantId, correlationId,
    supplyCapPaise: await capPaiseFromMongo(),
  });

  if (!result.ok) {
    count('ADMIN_MINT', result.reason ?? 'error', 'postgres');
    throw capExceeded({
      capTokens: paiseToRupees(result.capPaise),
      circulatingTokens: paiseToRupees(result.circulatingPaise),
      requestedTokens: paiseToRupees(result.requestedPaise),
    });
  }

  count('ADMIN_MINT', result.idempotent ? 'idempotent' : 'applied', 'postgres');
  const supply = supplyFromBalances(result.balances, await capPaiseFromMongo());
  // Keep the Mongo counter current so a fallback reads what Postgres decided.
  // Awaited for the same reason the forward mirror is — see there.
  await reverseMirrorAdminSupply({ minted: supply.minted, cap: supply.cap });
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

  if (!onPostgres()) {
    await rollbackOnMongo(amountTokens);
    count('ADMIN_MINT_ROLLBACK', 'applied', 'mongo');
    await mirrorAdminSupply({
      movementId: `${movementId}_burn`, amountPaise: 0 - rupeesToPaise(amountTokens),
      actor, reason, refModel, refId, correlationId,
    });
    return { ok: true, store: 'mongo' };
  }

  const result = await burnFromMerchantFloat(rupeesToPaise(amountTokens), {
    movementId: `${movementId}_burn`, actor,
    reason: reason || 'Admin token issuance rolled back',
    refModel, refId, correlationId,
  });

  count('ADMIN_MINT_ROLLBACK', result.idempotent ? 'idempotent' : 'applied', 'postgres');
  if (result.ok) {
    const supply = supplyFromBalances(result.balances, await capPaiseFromMongo());
    await reverseMirrorAdminSupply({ minted: supply.minted, cap: supply.cap });
  }
  return { ok: result.ok, idempotent: result.idempotent, store: 'postgres' };
}

/**
 * The current supply position, from whichever store owns it.
 *
 * Returned in the Mongo `{cap, minted}` shape in TOKENS, because that is what
 * the admin panel renders and what every caller already expects.
 */
export async function adminTokenSupply() {
  if (!onPostgres()) {
    const cfg = await mongoose.model('SystemConfig')
      .findOne({ key: 'main' }).select('adminTokenSupply').lean();
    return {
      cap: cfg?.adminTokenSupply?.cap ?? DEFAULT_CAP_TOKENS,
      minted: cfg?.adminTokenSupply?.minted ?? 0,
    };
  }
  return supplyFromBalances(await getTreasuryBalances(), await capPaiseFromMongo());
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
