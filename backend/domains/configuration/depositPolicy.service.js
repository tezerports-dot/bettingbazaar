// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Configuration / Business Policy Platform (BBEPS Phase 006).
//
// This is the ONLY allowed writer of DepositPolicy documents (04-GOVERNANCE.md
// §1). Route handlers must call these functions — never
// DepositPolicy.findOneAndUpdate / .create directly.
//
// RUNTIME CONSUMERS (read-only, via getActivePolicy):
//   - backend/domains/payment/paymentOrder.model.js pre-save hook — computes
//     depositAllocation/reserveAllocation for new DEPOSIT orders and snapshots
//     the policy version used onto the order (depositPolicySnapshot).
//   - Not yet wired: an actual merchant-commission payout engine. This service
//     makes merchantCommissionPercent / commissionFundingSource versioned,
//     validated, and readable — but no code in this repository yet executes a
//     platform-funded commission payment to a merchant. See the migration
//     notes in PHASE_STATUS.md for why that's a deliberately separate task.

import mongoose from 'mongoose';
import { DepositPolicy, SUPPORTED_CURRENCIES } from './depositPolicy.model.js';

/**
 * validatePolicyFields — cross-field validation that can't be expressed as
 * plain Mongoose schema constraints. Throws a plain Error with a message
 * that's safe to return to an admin client as-is.
 */
export function validatePolicyFields(fields) {
  const {
    currency,
    depositAllocationPercent,
    reserveAllocationPercent,
    merchantCommissionPercent = 0,
    commissionFundingSource = 'PLATFORM',
  } = fields;

  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(`Unsupported currency '${currency}'. Add it to SUPPORTED_CURRENCIES in depositPolicy.model.js first.`);
  }
  if (typeof depositAllocationPercent !== 'number' || typeof reserveAllocationPercent !== 'number') {
    throw new Error('depositAllocationPercent and reserveAllocationPercent are required numbers.');
  }
  if (depositAllocationPercent < 0 || reserveAllocationPercent < 0) {
    throw new Error('Allocation percentages cannot be negative.');
  }
  // Floating point safety margin — 99.99–100.01 treated as 100.
  const sum = depositAllocationPercent + reserveAllocationPercent;
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(`depositAllocationPercent + reserveAllocationPercent must equal 100 (got ${sum}).`);
  }
  if (merchantCommissionPercent < 0 || merchantCommissionPercent > 100) {
    throw new Error('merchantCommissionPercent must be between 0 and 100.');
  }
  // Hard business rule (2026-07 direction): commission is never user-funded.
  // This is not a default — reject explicitly even if a caller tries to pass
  // something else, so the rule can't be silently bypassed via the API.
  if (commissionFundingSource !== 'PLATFORM') {
    throw new Error(`commissionFundingSource must be 'PLATFORM' — merchant commission is never deducted from user balances.`);
  }
  return true;
}

/** getActivePolicy — the runtime read path. Read-only. */
export async function getActivePolicy(currency) {
  return DepositPolicy.findOne({ currency, status: 'ACTIVE' }).sort({ version: -1 }).lean();
}

/** getPolicyHistory — every version for a currency, newest first. Audit trail. Read-only. */
export async function getPolicyHistory(currency) {
  return DepositPolicy.find({ currency })
    .sort({ version: -1 })
    .populate('changedBy', 'username')
    .lean();
}

async function nextVersionNumber(currency) {
  const latest = await DepositPolicy.findOne({ currency }).sort({ version: -1 }).select('version').lean();
  return latest ? latest.version + 1 : 1;
}

/**
 * createPolicyVersion — the write path for a new DepositPolicy version.
 *
 * @param {string} currency
 * @param {object} fields    { depositAllocationPercent, reserveAllocationPercent,
 *                             merchantCommissionPercent, commissionFundingSource,
 *                             reserveUsageRules }
 * @param {object} actor     { userId, userName }
 * @param {object} opts      { justification (required), effectiveAt, requireApproval }
 *
 * Mirrors configVersioning.service.js's setConfigField status logic
 * (PENDING_APPROVAL / SCHEDULED / ACTIVE), but at whole-document granularity:
 * making a new version ACTIVE also supersedes whatever was previously ACTIVE
 * for that currency, so exactly one ACTIVE document per currency ever exists.
 */
export async function createPolicyVersion(currency, fields, actor, opts = {}) {
  const { justification, effectiveAt = new Date(), requireApproval = false } = opts;
  if (!justification || !justification.trim()) {
    throw new Error('businessJustification is required for every DepositPolicy change.');
  }

  const merged = {
    currency,
    depositAllocationPercent: fields.depositAllocationPercent,
    reserveAllocationPercent: fields.reserveAllocationPercent,
    merchantCommissionPercent: fields.merchantCommissionPercent ?? 0,
    commissionFundingSource: fields.commissionFundingSource ?? 'PLATFORM',
  };
  validatePolicyFields(merged);

  const isFuture = effectiveAt > new Date();
  let status, approvalStatus;
  if (requireApproval) {
    status = 'PENDING_APPROVAL';
    approvalStatus = 'PENDING_APPROVAL';
  } else if (isFuture) {
    status = 'SCHEDULED';
    approvalStatus = 'AUTO_APPROVED';
  } else {
    status = 'ACTIVE';
    approvalStatus = 'AUTO_APPROVED';
  }

  const version = await nextVersionNumber(currency);

  const doc = await DepositPolicy.create({
    currency,
    depositAllocationPercent: merged.depositAllocationPercent,
    reserveAllocationPercent: merged.reserveAllocationPercent,
    merchantCommissionPercent: merged.merchantCommissionPercent,
    commissionFundingSource: merged.commissionFundingSource,
    reserveUsageRules: fields.reserveUsageRules ?? undefined, // falls back to schema defaults
    version,
    status,
    approvalStatus,
    effectiveAt,
    businessJustification: justification,
    changedBy: actor.userId,
    changedByName: actor.userName,
  });

  if (status === 'ACTIVE') {
    await activate(doc);
  }

  return doc;
}

/** activate — internal helper: marks `doc` ACTIVE/applied and supersedes the
 *  previous ACTIVE version for the same currency, if any. Not exported —
 *  every external caller goes through createPolicyVersion, approvePolicyVersion,
 *  rollbackToPolicyVersion, or applyScheduledPolicyChanges. */
async function activate(doc) {
  await DepositPolicy.updateMany(
    { currency: doc.currency, status: 'ACTIVE', _id: { $ne: doc._id } },
    { $set: { status: 'SUPERSEDED' } }
  );
  doc.status = 'ACTIVE';
  doc.appliedAt = new Date();
  await doc.save();
  return doc;
}

/**
 * approvePolicyVersion — moves a PENDING_APPROVAL version forward, mirroring
 * configVersioning.service.js's approveConfigVersion. Rejecting is the same
 * call with approve=false.
 */
export async function approvePolicyVersion(versionId, actor, approve = true) {
  const doc = await DepositPolicy.findById(versionId);
  if (!doc) throw new Error('Policy version not found');
  if (doc.status !== 'PENDING_APPROVAL') {
    throw new Error(`Version is ${doc.status}, not awaiting approval`);
  }

  doc.approvedBy = actor.userId;
  doc.approvedAt = new Date();

  if (!approve) {
    doc.status = 'REJECTED';
    doc.approvalStatus = 'REJECTED';
    await doc.save();
    return doc;
  }

  doc.approvalStatus = 'APPROVED';
  const isFuture = doc.effectiveAt > new Date();
  if (isFuture) {
    doc.status = 'SCHEDULED';
    await doc.save();
    return doc;
  }

  return activate(doc);
}

/**
 * rollbackToPolicyVersion — restores an old version's field values as a NEW
 * active version. Per BBEPS §6.10, never deletes or mutates history: the
 * target version being restored FROM is untouched; the version being
 * replaced is superseded via the normal activate() path, same as any other
 * new version. Whole-policy rollback means "reinstate this old snapshot",
 * distinct from configVersioning.service.js's per-field rollback semantics
 * ("undo this one change") — see depositPolicy.model.js file header for why
 * field-level semantics don't fit this model.
 */
export async function rollbackToPolicyVersion(versionId, actor) {
  const target = await DepositPolicy.findById(versionId).lean();
  if (!target) throw new Error('Policy version not found');

  const version = await nextVersionNumber(target.currency);

  const doc = await DepositPolicy.create({
    currency: target.currency,
    depositAllocationPercent: target.depositAllocationPercent,
    reserveAllocationPercent: target.reserveAllocationPercent,
    merchantCommissionPercent: target.merchantCommissionPercent,
    commissionFundingSource: target.commissionFundingSource,
    reserveUsageRules: target.reserveUsageRules,
    version,
    status: 'ACTIVE',
    approvalStatus: 'AUTO_APPROVED',
    effectiveAt: new Date(),
    isRollback: true,
    rollbackOfVersionId: target._id,
    businessJustification: `Rollback to v${target.version} (policy id ${target._id})`,
    changedBy: actor.userId,
    changedByName: actor.userName,
  });

  return activate(doc);
}

/**
 * applyScheduledPolicyChanges — run on a schedule (e.g. every minute via
 * cronJobs.js, alongside applyScheduledConfigChanges) to activate SCHEDULED
 * versions whose effectiveAt has passed. Not wired into cronJobs.js yet —
 * this is the function to call once it is (same status as
 * applyScheduledConfigChanges was before this migration).
 */
export async function applyScheduledPolicyChanges() {
  const due = await DepositPolicy.find({ status: 'SCHEDULED', effectiveAt: { $lte: new Date() } });
  const results = [];
  for (const doc of due) {
    try {
      await activate(doc);
      results.push({ versionId: doc._id, currency: doc.currency, applied: true });
    } catch (e) {
      results.push({ versionId: doc._id, currency: doc.currency, applied: false, error: e.message });
    }
  }
  return results;
}
