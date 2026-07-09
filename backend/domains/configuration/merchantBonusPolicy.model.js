// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Configuration / Business Policy Platform (BBEPS Phase 008 consumer).
//
// MerchantBonusPolicy — the ONLY place the Merchant Performance Bonus
// percentage (and its enablement) is configured. The Merchant Platform's
// bonus engine READS this; it never owns the number (2026-07-09 directive:
// "Merchant bonuses are configurable only through Business Policy").
//
// Follows the DepositPolicy whole-document versioning pattern: each document
// IS a version; exactly one ACTIVE at a time; rollback creates a new version
// copying old values forward. Divergence from DepositPolicy (deliberate,
// scope-boxed): no scheduling / approval-gating in v1 — every new version
// applies immediately. Flagged in EXECUTION_QUEUE.md; add those lifecycle
// states by mirroring depositPolicy.service.js when needed.
//
// Sole writer: merchantBonusPolicy.service.js (04-GOVERNANCE.md §1/§2).

import mongoose from 'mongoose';

const merchantBonusPolicySchema = new mongoose.Schema({
  // Master switch: the bonus engine does nothing while false — safe default,
  // so shipping the policy changes no live behavior until an admin enables it.
  enabled: { type: Boolean, required: true, default: false },

  // % of newly matched buy→sell cycle volume issued as bonus. NEVER derived
  // from buyRate/sellRate (retired 2026-07-08); NEVER deducted from users —
  // it draws exclusively on the platform-funded MERCHANT_BONUS_POOL.
  bonusPercent: { type: Number, required: true, min: 0, max: 100, default: 0 },

  // Minimum newly matched volume (rupees) before an issuance triggers —
  // avoids micro-issuances on every tiny completed order pair.
  minMatchedVolume: { type: Number, required: true, min: 0, default: 100 },

  // ── Versioning (whole-policy, per DepositPolicy pattern) ─────────────────
  version: { type: Number, required: true },
  status:  { type: String, enum: ['ACTIVE', 'SUPERSEDED'], default: 'ACTIVE', index: true },

  isRollback:          { type: Boolean, default: false },
  rollbackOfVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'MerchantBonusPolicy' },

  businessJustification: { type: String, required: true },
  changedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  changedByName: { type: String },

  createdAt: { type: Date, default: Date.now, index: true },
});

merchantBonusPolicySchema.index({ status: 1, version: -1 });

export const MerchantBonusPolicy = mongoose.model('MerchantBonusPolicy', merchantBonusPolicySchema);
