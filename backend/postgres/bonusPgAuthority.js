// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/bonusPgAuthority.js — bonuses and commissions, behind the resolver.
 *
 * The Mongo path grants a bonus in two independent writes: a wallet credit
 * (`creditWinnings` / `creditDeposit`) and a `BonusRecord` for history. The
 * Postgres path (`bonusPg.grantBonus`) makes it one movement funded from the
 * treasury pool that exists to pay for it. Which one runs is decided per call
 * by `isPostgresAuthoritative(MONEY_PATHS.BONUSES_AND_COMMISSIONS)`.
 *
 * ── The property this domain is actually about ──────────────────────────────
 * A bonus is a TRANSFER, not a mint. The Mongo path credits the user from
 * nowhere: tokens appear on the user side with nothing on the other, so
 * `User + Merchant + Treasury = Total Supply` stops holding and every
 * downstream conservation check starts failing for a reason unrelated to the
 * bug it was built to catch. Routing this is what makes the giveaway come out
 * of a pool that can run dry — which is also the only thing that can stop a
 * misconfigured promotion from printing money indefinitely.
 *
 * ── Rupees in, paise inside ────────────────────────────────────────────────
 * Callers are Mongo-shaped and speak float rupees; `bonusPg` speaks integer
 * paise and refuses anything else. The conversion happens here, at the
 * boundary, which is the same wall the mirrors use in both directions.
 *
 * ── A refusal is a refusal ─────────────────────────────────────────────────
 * `grantBonus` returns `{ ok: false, reason: 'pool_movement_failed' }` when the
 * funding pool cannot cover the grant. That is NOT translated into a thrown
 * error or quietly swallowed: an empty pool means the platform has not funded
 * this promotion, and paying anyway is precisely the behaviour the domain
 * exists to prevent. Callers get the refusal and decide what to tell the user.
 */
import { rupeesToPaise, paiseToRupees } from '../shared/money.js';
import { isPostgresAuthoritative, MONEY_PATHS } from './moneyAuthority.js';
import { grantBonus, clawBackBonus, getGrant, BONUS_KIND } from './bonusPg.js';

/** Is Postgres the source of truth for bonuses and commissions? */
export const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.BONUSES_AND_COMMISSIONS);

/**
 * Which Postgres bonus kind a Mongo `BonusRecord.type` corresponds to.
 *
 * Identical to the forward mirror's mapping, and deliberately so — a grant must
 * land in the same pool whichever direction it travelled. ADMIN_CREDIT is
 * absent from both: a manual adjustment has no pool behind it, and inventing
 * one would make the treasury claim it financed something it did not.
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
 * Grant a bonus, from whichever store owns the domain.
 *
 * On the Mongo path this returns `{ source: 'mongo', applied: false }` and the
 * caller keeps doing what it already does. It is NOT a no-op that hides a
 * missing implementation: the Mongo credit is a real, working path, and this
 * function's job is only to decide whether Postgres should own the movement
 * instead.
 */
export async function grant({
  grantId, userId, recordType, amountRupees, refModel = 'BonusRecord', refId = null, reason = null,
}) {

  const kind = KIND_FROM_RECORD_TYPE[recordType];
  // An unmapped type is not an error to throw at a user mid-promotion — it is a
  // giveaway with no pool to fund it, which the Mongo path still handles. Say
  // so plainly rather than failing the request.
  if (!kind || !BONUS_KIND[kind]) {
    return { ok: true, source: 'mongo', applied: false, reason: 'unmapped_kind', recordType };
  }

  const amountPaise = rupeesToPaise(Number(amountRupees) || 0);
  if (amountPaise <= 0) return { ok: false, source: 'postgres', reason: 'non_positive_amount' };

  const result = await grantBonus({
    grantId, userId, kind, amountPaise, refModel, refId, reason,
  });
  return { ...result, source: 'postgres', applied: result.ok };
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
  return { ...result, source: 'postgres', applied: result.ok };
}

/** A grant in rupees, for callers that report to a Mongo-shaped surface. */
export async function read(grantId) {
  const g = await getGrant(grantId);
  return g && { ...g, amount: paiseToRupees(g.amountPaise) };
}
