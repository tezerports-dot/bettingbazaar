// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/merchantBonusPolicy.js — the merchant performance bonus rate.
 *
 * The Merchant Platform's bonus engine reads the ACTIVE row here and never owns
 * the number itself. Every change is a NEW version; nothing is edited in place,
 * so "what rate was in force when this bonus was issued" stays answerable.
 *
 * ── The rules that moved into the table ─────────────────────────────────────
 * "Exactly one ACTIVE version" used to be two writes in the service, in the
 * wrong order: create the new ACTIVE row, THEN supersede the old one. Between
 * those two statements the engine could read two ACTIVE policies and take
 * whichever the sort returned. Both statements are now one transaction behind
 * `merchant_bonus_policies_one_active`, so the overlap is refused rather than
 * ordered around.
 *
 * "An enabled policy needs a non-zero percentage" and "the percentage is
 * between 0 and 100" were JavaScript validators — true for callers that
 * remembered to call them. They are CHECK constraints now, so the service
 * validator is a better error message rather than the only guard.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 * `min_matched_volume` is RUPEES, deliberately: it is a threshold an admin
 * types into a panel. The engine converts it to minor units at the single
 * point where it compares against matched volume. `bonus_percent` is a
 * percentage, applied to minor units, and the arithmetic stays in paise.
 */
import { pgQuery, withTransaction } from '../client.js';

const toPolicy = (r) => (r ? {
  id: Number(r.id),
  // Callers built against the document store address a version by id. Give it
  // the same shape as deposit policy's: stable, readable, and derived from the
  // version rather than a surrogate key that means nothing to a reviewer.
  _id: `v${r.version}`,
  version: Number(r.version),
  status: r.status,
  enabled: r.enabled,
  bonusPercent: Number(r.bonus_percent),
  minMatchedVolume: Number(r.min_matched_volume),
  isRollback: r.is_rollback,
  rollbackOfVersion: r.rollback_of_version === null ? null : Number(r.rollback_of_version),
  businessJustification: r.justification,
  changedBy: r.changed_by,
  changedByName: r.changed_by_name,
  createdAt: r.created_at,
  supersededAt: r.superseded_at,
} : null);

/** The rate the engine pays at. One row, by construction. */
export async function getActivePolicy() {
  const { rows } = await pgQuery(
    "SELECT * FROM merchant_bonus_policies WHERE status = 'ACTIVE'",
    [], 'merchant_bonus_policy_active',
  );
  return toPolicy(rows[0]);
}

/** Every version, newest first. The audit trail. */
export async function getPolicyHistory({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM merchant_bonus_policies
      ORDER BY version DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    [], 'merchant_bonus_policy_history',
  );
  return rows.map(toPolicy);
}

/** One version by its number. Used by rollback to read the values forward. */
export async function getPolicyVersion(version) {
  const { rows } = await pgQuery(
    'SELECT * FROM merchant_bonus_policies WHERE version = $1',
    [Number(version)], 'merchant_bonus_policy_version',
  );
  return toPolicy(rows[0]);
}

/**
 * Map a constraint violation onto the operator error it actually is.
 *
 * These are answerable mistakes ("you cannot enable a 0% bonus"), not 500s, so
 * they come back as a refusal with a reason the panel can show.
 */
function refusal(err, fields) {
  if (err.constraint === 'merchant_bonus_policies_enabled_has_percent') {
    return { ok: false, reason: 'ENABLED_NEEDS_PERCENT',
      message: 'An enabled policy with bonusPercent 0 does nothing — either set a percentage or disable it.' };
  }
  if (err.constraint === 'merchant_bonus_policies_percent_range') {
    return { ok: false, reason: 'PERCENT_OUT_OF_RANGE',
      message: `bonusPercent must be between 0 and 100 (got ${fields?.bonusPercent}).` };
  }
  if (err.constraint === 'merchant_bonus_policies_volume_range') {
    return { ok: false, reason: 'VOLUME_NEGATIVE',
      message: 'minMatchedVolume cannot be negative.' };
  }
  if (err.constraint === 'merchant_bonus_policies_justified') {
    return { ok: false, reason: 'JUSTIFICATION_REQUIRED',
      message: 'businessJustification is required for every bonus policy change.' };
  }
  if (err.code === '23505') {
    return { ok: false, reason: 'CONCURRENT_CHANGE',
      message: 'Another change to this policy landed first. Reload and try again.' };
  }
  return null;
}

/**
 * The write path. Supersede-then-insert in one transaction.
 *
 * The version number is assigned by the INSERT itself (`MAX(version) + 1` as a
 * subquery), not read first and passed in: a read-then-write would hand two
 * concurrent admins the same number, and the UNIQUE on version would then fail
 * the second one after it had already superseded the live policy.
 */
export async function createPolicyVersion({
  enabled = false, bonusPercent = 0, minMatchedVolume = 100,
  justification = '', changedBy = null, changedByName = '',
  isRollback = false, rollbackOfVersion = null,
} = {}) {
  try {
    return await withTransaction(async (client) => {
      await client.query(
        `UPDATE merchant_bonus_policies SET status = 'SUPERSEDED', superseded_at = now()
          WHERE status = 'ACTIVE'`,
      );
      const { rows } = await client.query(
        `INSERT INTO merchant_bonus_policies
           (version, status, enabled, bonus_percent, min_matched_volume,
            is_rollback, rollback_of_version, justification, changed_by, changed_by_name)
         VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM merchant_bonus_policies),
                 'ACTIVE', $1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [Boolean(enabled), Number(bonusPercent), Number(minMatchedVolume),
          Boolean(isRollback), rollbackOfVersion === null ? null : Number(rollbackOfVersion),
          String(justification ?? '').trim(), changedBy, String(changedByName ?? '')],
      );
      return { ok: true, policy: toPolicy(rows[0]) };
    });
  } catch (err) {
    const refused = refusal(err, { bonusPercent });
    if (refused) return refused;
    throw err;
  }
}

/**
 * Rollback — a NEW ACTIVE version carrying an old version's values forward.
 *
 * Never a status flip on the old row: reviving a superseded version would erase
 * the fact that it was ever replaced, and the history is the point of the table.
 */
export async function rollbackToVersion(version, { changedBy = null, changedByName = '' } = {}) {
  const target = await getPolicyVersion(version);
  if (!target) return { ok: false, reason: 'NOT_FOUND', message: 'Policy version not found' };

  return createPolicyVersion({
    enabled: target.enabled,
    bonusPercent: target.bonusPercent,
    minMatchedVolume: target.minMatchedVolume,
    justification: `Rollback to v${target.version}`,
    changedBy,
    changedByName,
    isRollback: true,
    rollbackOfVersion: target.version,
  });
}
