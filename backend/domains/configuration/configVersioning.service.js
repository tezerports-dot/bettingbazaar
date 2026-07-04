// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Configuration / Business Policy Platform (BBEPS Phase 006).
//
// This is the intended write path for every future admin-editable business
// parameter (merchant commission, reserve ratio, deposit split, withdrawal
// rules, betting limits, etc.) — see PHASE_STATUS.md "Current Active Phase."
//
// SCOPE NOTE: this does NOT retrofit existing direct writes to SystemConfig
// (e.g. the Merchant Pool feature's PUT /queue/merchant-pool, which writes
// queueManagerPool directly). Retrofitting that is a separate, deliberate
// decision — not something to change silently as a side effect of building
// this service. New configuration surfaces should use this service from the
// start; existing ones migrate to it individually, verified each time.

import mongoose from 'mongoose';
import { ConfigVersion } from './configVersion.model.js';

const MODEL_BY_KEY = { SystemConfig: 'SystemConfig', TokenRates: 'TokenRates' };

function getModel(modelName) {
  if (!MODEL_BY_KEY[modelName]) {
    throw new Error(`Unknown config model: ${modelName}. Add it to MODEL_BY_KEY first.`);
  }
  return mongoose.model(modelName);
}

function getByPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

/**
 * setConfigField — the write path for a single business-parameter change.
 *
 * @param {string} modelName    'SystemConfig' | 'TokenRates'
 * @param {string} field        dot-path, e.g. 'betLimits.thirtyMin.min'
 * @param {*}      newValue
 * @param {object} actor        { userId, userName }
 * @param {object} opts         { justification, effectiveAt, requireApproval }
 *
 * If effectiveAt is in the future, the version is recorded as SCHEDULED and
 * NOT applied yet — a scheduled job (applyScheduledConfigChanges, below) picks
 * it up when the time comes. If requireApproval is true, the version is
 * recorded as PENDING_APPROVAL and not applied until approveConfigVersion runs.
 * Otherwise the change applies immediately.
 */
export async function setConfigField(modelName, field, newValue, actor, opts = {}) {
  const { justification = '', effectiveAt = new Date(), requireApproval = false } = opts;
  const Model = getModel(modelName);
  const configKey = 'main'; // both SystemConfig and TokenRates use key:'main' today

  const current = await Model.findOne({ key: configKey }).lean();
  const previousValue = current ? getByPath(current, field) : undefined;

  const isFuture = effectiveAt > new Date();

  // These are genuinely different reasons to hold a change back, kept distinct
  // per BBEPS §6.8's Draft -> Review -> Approval -> Scheduled -> Active flow:
  //   PENDING_APPROVAL: a human needs to sign off, regardless of date.
  //   SCHEDULED: already approved (or never needed approval), just waiting for its date.
  //   ACTIVE: approved AND due now — applied immediately.
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

  const version = await ConfigVersion.create({
    modelName, configKey, field, previousValue, newValue,
    changedBy: actor.userId, changedByName: actor.userName,
    businessJustification: justification,
    approvalStatus, effectiveAt, status,
  });

  // Apply immediately only if not scheduled for the future and not pending approval.
  if (status === 'ACTIVE') {
    await Model.findOneAndUpdate(
      { key: configKey },
      { $set: { [field]: newValue, updatedAt: new Date(), updatedBy: actor.userId } },
      { upsert: true }
    );
    version.appliedAt = new Date();
    await version.save();
  }

  return version;
}

/**
 * approveConfigVersion — moves a PENDING_APPROVAL version forward. If its
 * effectiveAt has already passed, applies it immediately (-> ACTIVE). If
 * effectiveAt is still in the future, marks it SCHEDULED so the scheduled-apply
 * job picks it up later. Rejecting is the same call with approve=false.
 */
export async function approveConfigVersion(versionId, actor, approve = true) {
  const version = await ConfigVersion.findById(versionId);
  if (!version) throw new Error('Version not found');
  if (version.status !== 'PENDING_APPROVAL') {
    throw new Error(`Version is ${version.status}, not awaiting approval`);
  }

  version.approvedBy = actor.userId;
  version.approvedAt = new Date();

  if (!approve) {
    version.status = 'REJECTED';
    version.approvalStatus = 'REJECTED';
    await version.save();
    return version;
  }

  version.approvalStatus = 'APPROVED';
  const isFuture = version.effectiveAt > new Date();

  if (isFuture) {
    version.status = 'SCHEDULED';
    await version.save();
    return version;
  }

  const Model = getModel(version.modelName);
  await Model.findOneAndUpdate(
    { key: 'main' },
    { $set: { [version.field]: version.newValue, updatedAt: new Date(), updatedBy: actor.userId } }
  );
  version.status = 'ACTIVE';
  version.appliedAt = new Date();
  await version.save();
  return version;
}

/** getFieldHistory — every version of a field, newest first. Read-only. */
export async function getFieldHistory(modelName, field) {
  return ConfigVersion.find({ modelName, configKey: 'main', field })
    .sort({ createdAt: -1 })
    .populate('changedBy', 'username')
    .lean();
}

/**
 * rollbackToVersion — restores a field to what it was BEFORE a given version.
 * Per BBEPS §6.10: never deletes history. Creates a new version recording the
 * rollback, applies it, and marks the original as ROLLED_BACK (the original
 * document itself is never mutated beyond that status flag — its
 * previousValue/newValue stay exactly as they were, so the record of what
 * happened remains accurate).
 */
export async function rollbackToVersion(versionId, actor) {
  const target = await ConfigVersion.findById(versionId);
  if (!target) throw new Error('Version not found');
  if (target.status !== 'ACTIVE') {
    throw new Error(`Cannot roll back a version with status ${target.status}`);
  }

  const Model = getModel(target.modelName);

  const rollbackVersion = await ConfigVersion.create({
    modelName: target.modelName,
    configKey: target.configKey,
    field: target.field,
    previousValue: target.newValue,   // what it currently is
    newValue: target.previousValue,   // what we're reverting TO
    changedBy: actor.userId,
    changedByName: actor.userName,
    businessJustification: `Rollback of version ${target._id}`,
    approvalStatus: 'AUTO_APPROVED',
    effectiveAt: new Date(),
    status: 'ACTIVE',
    isRollback: true,
    rollbackOfVersionId: target._id,
  });

  await Model.findOneAndUpdate(
    { key: 'main' },
    { $set: { [target.field]: target.previousValue, updatedAt: new Date(), updatedBy: actor.userId } }
  );
  rollbackVersion.appliedAt = new Date();
  await rollbackVersion.save();

  target.status = 'ROLLED_BACK';
  await target.save();

  return rollbackVersion;
}

/**
 * applyScheduledConfigChanges — run on a schedule (e.g. every minute via
 * cronJobs.js) to apply SCHEDULED versions whose effectiveAt has passed.
 * Not wired into cronJobs.js yet — this is the function to call once it is.
 */
export async function applyScheduledConfigChanges() {
  const due = await ConfigVersion.find({ status: 'SCHEDULED', effectiveAt: { $lte: new Date() } });
  const results = [];
  for (const version of due) {
    try {
      const Model = getModel(version.modelName);
      await Model.findOneAndUpdate(
        { key: 'main' },
        { $set: { [version.field]: version.newValue, updatedAt: new Date() } }
      );
      version.status = 'ACTIVE';
      version.appliedAt = new Date();
      await version.save();
      results.push({ versionId: version._id, applied: true });
    } catch (e) {
      results.push({ versionId: version._id, applied: false, error: e.message });
    }
  }
  return results;
}
