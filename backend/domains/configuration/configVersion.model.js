// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Configuration / Business Policy Platform (BBEPS Phase 006 §6.7-§6.10).
//
// Why this exists separately from EnhancedAuditLog (models/audit.model.js):
// EnhancedAuditLog is a generic cross-cutting "something happened" record used
// across USER_MANAGEMENT, KYC, MERCHANT, CONTENT, SECURITY, etc. Configuration
// versioning has requirements none of those categories need: per-FIELD history
// (not a document-level diff blob), future-dated scheduling, and rollback that
// creates a new version rather than deleting anything. Mixing these into
// EnhancedAuditLog would bloat it with fields that don't apply to its other
// categories. This model is the primary data source for "what was field X at
// time T" and "revert field X to what it was" — not a side-effect log.
//
// BBEPS §6.10 is explicit: "Rollback never deletes history." Every write here
// is a new document; nothing is ever mutated or deleted.

import mongoose from 'mongoose';

const configVersionSchema = new mongoose.Schema({
  // Which Mongoose model this touches. 'TokenRates' stays in the enum ONLY so
  // historical version documents from before its 2026-07-08 removal (fixed
  // 1:1 conversion, Phase 006 flattening) remain valid audit records — new
  // TokenRates versions are impossible (removed from MODEL_BY_KEY in
  // configVersioning.service.js).
  modelName: { type: String, required: true, enum: ['SystemConfig', 'TokenRates'], index: true },

  // Matches SystemConfig.key ('main') — which config document this touches.
  configKey: { type: String, required: true, index: true },

  // Dot-notation field path within that document, e.g. 'betLimits.thirtyMin.min'
  // or 'queueManagerPool'. Field-level, not document-level, per BBEPS §6.7.
  field: { type: String, required: true, index: true },

  previousValue: { type: mongoose.Schema.Types.Mixed },
  newValue:      { type: mongoose.Schema.Types.Mixed, required: true },

  changedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  changedByName: { type: String },

  // BBEPS §6.7: "Business Justification" — required for anything beyond trivial changes.
  // Not enforced as mandatory at the schema level (some changes are genuinely
  // routine), but the field always exists so it CAN be required at the route
  // level for high-impact policies per §6.8.
  businessJustification: { type: String },

  // BBEPS §6.8 Approval Workflows. Most fields auto-approve (the person with
  // write access to the config route already passed a permission check);
  // high-impact fields (reserve ratio, commission, withdrawal limits) can be
  // routed through PENDING_APPROVAL by the route layer, not this model.
  approvalStatus: {
    type: String,
    enum: ['AUTO_APPROVED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'],
    default: 'AUTO_APPROVED',
    index: true,
  },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },

  // BBEPS §6.9 Effective Dates. Defaults to "now" (immediate). A future date
  // means this version is SCHEDULED and a job applies it when effectiveAt passes.
  effectiveAt: { type: Date, default: Date.now, index: true },
  appliedAt:   { type: Date }, // null until actually written to the live config document

  status: {
    type: String,
    enum: ['PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'SUPERSEDED', 'ROLLED_BACK', 'REJECTED'],
    default: 'ACTIVE',
    index: true,
  },

  // BBEPS §6.10 Rollback. A rollback creates a NEW version (this one) that
  // restores a field to an earlier value, and links back to what it reverted —
  // it never deletes or mutates the version being rolled back.
  isRollback:          { type: Boolean, default: false },
  rollbackOfVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConfigVersion' },

  createdAt: { type: Date, default: Date.now, index: true },
});

configVersionSchema.index({ configKey: 1, field: 1, createdAt: -1 });
configVersionSchema.index({ status: 1, effectiveAt: 1 }); // for the scheduled-apply job

export const ConfigVersion = mongoose.model('ConfigVersion', configVersionSchema);
