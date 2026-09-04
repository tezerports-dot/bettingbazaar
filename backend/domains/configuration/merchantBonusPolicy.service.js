// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Configuration / Business Policy Platform.
//
// Sole writer of merchant bonus policy versions. Runtime consumer (read-only):
// the Merchant Platform bonus engine (domains/merchant/merchantBonus.service.js)
// via getActiveBonusPolicy().
//
// The versioning rules — one ACTIVE at a time, append-only history, rollback as
// a new version — live in the table and its constraints, not here. What stays
// here is the operator-facing validation: the same rules, checked early so the
// panel gets a sentence rather than a constraint name.

import { db } from '#db';

export function validateBonusPolicyFields({ enabled, bonusPercent, minMatchedVolume }) {
  if (typeof enabled !== 'boolean') {
    throw new Error('enabled must be a boolean.');
  }
  if (typeof bonusPercent !== 'number' || !Number.isFinite(bonusPercent) || bonusPercent < 0 || bonusPercent > 100) {
    throw new Error('bonusPercent must be a number between 0 and 100.');
  }
  if (typeof minMatchedVolume !== 'number' || !Number.isFinite(minMatchedVolume) || minMatchedVolume < 0) {
    throw new Error('minMatchedVolume must be a non-negative number of rupees.');
  }
  if (enabled && bonusPercent === 0) {
    throw new Error('An enabled policy with bonusPercent 0 does nothing — either set a percentage or disable it.');
  }
  return true;
}

/** The runtime read path for the bonus engine. Read-only. */
export async function getActiveBonusPolicy() {
  return db.merchantBonusPolicy.getActivePolicy();
}

export async function getBonusPolicyHistory() {
  return db.merchantBonusPolicy.getPolicyHistory();
}

/**
 * A refusal from the table is an operator error with a specific answer. The
 * routes above this already catch Error and render its message, so a refused
 * write is raised rather than returned — the two failure shapes stay one.
 */
function unwrap(result) {
  if (result?.ok) return result.policy;
  const err = new Error(result?.message || 'Bonus policy change refused.');
  err.reason = result?.reason;
  throw err;
}

/**
 * createBonusPolicyVersion — the write path. Immediate-apply only in v1
 * (no scheduling/approval-gating — see docs/governance/04-GOVERNANCE.md).
 */
export async function createBonusPolicyVersion(fields, actor, { justification } = {}) {
  if (!justification || !justification.trim()) {
    throw new Error('businessJustification is required for every bonus policy change.');
  }
  const merged = {
    enabled: fields.enabled ?? false,
    bonusPercent: fields.bonusPercent ?? 0,
    minMatchedVolume: fields.minMatchedVolume ?? 100,
  };
  validateBonusPolicyFields(merged);

  return unwrap(await db.merchantBonusPolicy.createPolicyVersion({
    ...merged,
    justification: justification.trim(),
    changedBy: actor?.userId ?? null,
    changedByName: actor?.userName ?? '',
  }));
}

/** Rollback = new ACTIVE version copying an old version's values forward. */
export async function rollbackToBonusPolicyVersion(versionId, actor) {
  // Panels address a version as `v3`; the table addresses it as 3. Accept both
  // so a link built from a history payload works without the caller unwrapping
  // the id first.
  const version = Number(String(versionId).replace(/^v/i, ''));
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('Policy version not found');
  }
  return unwrap(await db.merchantBonusPolicy.rollbackToVersion(version, {
    changedBy: actor?.userId ?? null,
    changedByName: actor?.userName ?? '',
  }));
}
