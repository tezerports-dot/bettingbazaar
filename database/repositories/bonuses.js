// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * repositories/bonuses.js — bonuses and commissions.
 *
 * A grant used to be two independent writes: a wallet credit and a record for
 * history. It is ONE movement now, funded from the treasury pool that exists to
 * pay for it.
 *
 * ── The property this domain is actually about ──────────────────────────────
 * A bonus is a TRANSFER, not a mint. Crediting the user from nowhere makes
 * tokens appear on one side with nothing on the other, so
 * `User + Merchant + Treasury = Total Supply` stops holding and every
 * downstream conservation check starts failing for a reason unrelated to the
 * bug it was built to catch. Funding it from a pool is what makes the giveaway
 * come out of somewhere that can run dry — which is also the only thing that
 * stops a misconfigured promotion printing money indefinitely.
 *
 * ── Rupees in, paise inside ────────────────────────────────────────────────
 * Callers speak rupees, because that is what routes serialise; the movement
 * speaks integer paise and refuses anything else. The conversion happens here,
 * at the boundary, once.
 *
 * ── A refusal is a refusal ─────────────────────────────────────────────────
 * `grantBonus` returns `{ ok: false, reason: 'pool_movement_failed' }` when the
 * funding pool cannot cover the grant. That is NOT translated into a thrown
 * error or quietly swallowed: an empty pool means the platform has not funded
 * this promotion, and paying anyway is precisely the behaviour the domain
 * exists to prevent. Callers get the refusal and decide what to tell the user.
 */
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';
import { MONEY_PATHS } from '../moneyPaths.js';
import { grantBonus, clawBackBonus, getGrant, BONUS_KIND } from './bonuses.core.js';

/** Is Postgres the source of truth for bonuses and commissions? */

/**
 * Which pool a bonus record type is funded from.
 *
 * ADMIN_CREDIT is deliberately absent: a manual adjustment has no pool behind
 * it, and inventing one would make the treasury claim it financed something it
 * did not. An absent type is a refusal, not a default — see `grant`.
 */
export const KIND_FROM_RECORD_TYPE = Object.freeze({
  GIFT_CODE:           'PROMO',
  CHECK_IN:            'PROMO',
  LEVEL_UP:            'PROMO',
  FIRST_DEPOSIT:       'PROMO',
  MANUAL:              'PROMO',
  REFERRAL_COMMISSION: 'COMMISSION',
});

/**
 * Grant a bonus: move it out of the pool that funds it, into the player's
 * wallet, in one transaction.
 *
 * ── An unmapped record type is a REFUSAL ────────────────────────────────────
 * It used to return `{ ok: true, applied: false }`, on the reasoning that the
 * other store's credit path would handle it. There is no other store, so that
 * answer told the caller a grant had succeeded when nothing had moved — and the
 * gift-code route goes on to write an audit row saying the player received the
 * money. An audit trail that records a payment the ledger never made is worse
 * than a failed promotion.
 *
 * `ok: false` is the honest answer and the caller already handles it: the claim
 * stands, the player is told the reward is processing, and it is retried.
 */
export async function grant({
  grantId, userId, recordType, amountRupees, refModel = 'BonusRecord', refId = null, reason = null,
}) {

  const kind = KIND_FROM_RECORD_TYPE[recordType];
  // A giveaway with no pool to fund it. Not thrown — a promotion failing is not
  // an exception the player should see — but not reported as success either.
  if (!kind || !BONUS_KIND[kind]) {
    return { ok: false, applied: false, reason: 'unmapped_kind', recordType };
  }

  const amountPaise = rupeesToPaise(Number(amountRupees) || 0);
  if (amountPaise <= 0) return { ok: false, applied: false, reason: 'non_positive_amount' };

  const result = await grantBonus({
    grantId, userId, kind, amountPaise, refModel, refId, reason,
  });
  return { ...result, applied: result.ok };
}

/**
 * Take a grant back. The grant ROW survives, marked — "was this user ever given
 * a signup bonus?" is what fraud review asks, and deleting the row destroys the
 * answer. The clawback may drive the balance negative, because the money may
 * already be spent and refusing to record a reversal that already happened is
 * worse than recording an uncomfortable number.
 */
export async function clawBack({ grantId, userId, actor = null, reason = null }) {
  const result = await clawBackBonus({ grantId, userId, actor, reason });
  return { ...result, applied: result.ok };
}

/** A grant in rupees, which is what the routes serialise. */
export async function read(grantId) {
  const g = await getGrant(grantId);
  return g && { ...g, amount: paiseToRupees(g.amountPaise) };
}
