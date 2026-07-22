// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Configuration / Business Policy Platform.
//
// Sole writer of MerchantBonusPolicy documents. Runtime consumer (read-only):
// the Merchant Platform bonus engine (domains/merchant/merchantBonus.service.js)
// via getActiveBonusPolicy().

import { MerchantBonusPolicy } from './merchantBonusPolicy.model.js';

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
  return MerchantBonusPolicy.findOne({ status: 'ACTIVE' }).sort({ version: -1 }).lean();
}

export async function getBonusPolicyHistory() {
  return MerchantBonusPolicy.find({})
    .sort({ version: -1 })
    .populate('changedBy', 'username')
    .lean();
}

async function nextVersionNumber() {
  const latest = await MerchantBonusPolicy.findOne({}).sort({ version: -1 }).select('version').lean();
  return latest ? latest.version + 1 : 1;
}

async function activate(doc) {
  await MerchantBonusPolicy.updateMany(
    { status: 'ACTIVE', _id: { $ne: doc._id } },
    { $set: { status: 'SUPERSEDED' } }
  );
  return doc;
}

/**
 * createBonusPolicyVersion — the write path. Immediate-apply only in v1
 * (no scheduling/approval-gating — see model header + docs/governance/04-GOVERNANCE.md).
 */
export async function createBonusPolicyVersion(fields, actor, { justification } = {}) {
  if (!justification || !justification.trim()) {
    throw new Error('businessJustification is required for every MerchantBonusPolicy change.');
  }
  const merged = {
    enabled: fields.enabled ?? false,
    bonusPercent: fields.bonusPercent ?? 0,
    minMatchedVolume: fields.minMatchedVolume ?? 100,
  };
  validateBonusPolicyFields(merged);

  const doc = await MerchantBonusPolicy.create({
    ...merged,
    version: await nextVersionNumber(),
    status: 'ACTIVE',
    businessJustification: justification.trim(),
    changedBy: actor.userId,
    changedByName: actor.userName,
  });
  return activate(doc);
}

/** Rollback = new ACTIVE version copying an old version's values forward. */
export async function rollbackToBonusPolicyVersion(versionId, actor) {
  const target = await MerchantBonusPolicy.findById(versionId).lean();
  if (!target) throw new Error('Policy version not found');

  const doc = await MerchantBonusPolicy.create({
    enabled: target.enabled,
    bonusPercent: target.bonusPercent,
    minMatchedVolume: target.minMatchedVolume,
    version: await nextVersionNumber(),
    status: 'ACTIVE',
    isRollback: true,
    rollbackOfVersionId: target._id,
    businessJustification: `Rollback to v${target.version} (policy id ${target._id})`,
    changedBy: actor.userId,
    changedByName: actor.userName,
  });
  return activate(doc);
}
