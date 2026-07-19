// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Configuration / Business Policy Platform (BBEPS Phase 006 §6.7-§6.10).
//
// SCOPE (corrected 2026-07-08): this policy governs ONLY the deposit/reserve
// wallet split and reserve usage rules for a single incoming deposit. It does
// NOT govern merchant incentive pay. Deposit creation and a completed
// buy+sell cycle are different trigger events — the merchant bonus is earned
// on cycle completion, not on deposit approval, so it cannot live on a
// deposit-triggered policy. See docs/governance/ENTERPRISE_DECISIONS.md 2026-07-08 for the
// correction and "Merchant Performance Bonus" as the platform-funded,
// cycle-completion-triggered mechanism that replaces the fields formerly
// modeled here (`merchantCommissionPercent`, `commissionFundingSource`).
//
// WHY A DEDICATED MODEL INSTEAD OF MORE SystemConfig FIELDS:
// configVersioning.service.js + ConfigVersion version individual FIELDS on a
// flat key:'main' document. That's correct for independent values (bet
// limits, maintenance mode) but wrong here: deposit-allocation % and
// reserve-allocation % are not independent numbers — they are one coherent
// business decision about what happens to a single incoming deposit.
// Field-level versioning would let them drift out of sync mid-change (e.g.
// an admin updates one in one request and the other in a second request a
// minute later — with field-level versioning there is no single version ID
// that describes "the policy in effect" during that gap). Whole-document
// versioning closes that gap: every version is a complete, internally
// consistent snapshot.
//
// NAMING: called DepositPolicy, not "Deposit Allocation Policy" or
// "Financial Allocation Policy" — to match the sibling policies this same
// migration anticipates (WithdrawalPolicy, SettlementPolicy, RiskPolicy,
// MerchantPolicy): one policy per money-moving EVENT TYPE, not one policy per
// field group.
//
// VERSIONING MODEL: each document IS a version (whole-policy, not per-field).
// Exactly one ACTIVE document per currency at a time — enforced in
// depositPolicy.service.js (the only allowed writer of this model; see
// docs/governance/04-GOVERNANCE.md §2 "No second write path to a value with a designated
// single-writer service" — added as a new §1 authority in this migration).

import mongoose from 'mongoose';

// Currencies this policy can govern. Extending to a new currency is:
// (1) add it here, (2) have an admin create its first DepositPolicy version
// for it via PUT /api/admin/deposit-policy/:currency — no other schema or
// service change required. This is the concrete mechanism behind BBEPS'
// "future currencies" requirement.
export const SUPPORTED_CURRENCIES = ['INR', 'USDT'];

const depositPolicySchema = new mongoose.Schema({
  currency: { type: String, required: true, enum: SUPPORTED_CURRENCIES, index: true },

  // ── Wallet split ─────────────────────────────────────────────────────────
  // Must sum to 100 — enforced in depositPolicy.service.js validatePolicyFields(),
  // not here (cross-field validation belongs in the service so the error
  // message can name both fields together).
  depositAllocationPercent: { type: Number, required: true, min: 0, max: 100 },
  reserveAllocationPercent: { type: Number, required: true, min: 0, max: 100 },

  // ── Reserve usage rules ──────────────────────────────────────────────────
  // Typed, not Schema.Types.Mixed — a Mixed blob would lose validation and
  // defeat the point of a versioned, admin-editable policy. Extend with new
  // named fields as real reserve-usage rules are defined.
  reserveUsageRules: {
    withdrawable:     { type: Boolean, default: false }, // can a user ever withdraw FROM reserveBalance directly?
    settlementBuffer: { type: Boolean, default: true },   // is reserve treated as a settlement/loss buffer?
    notes:            { type: String, default: '' },
  },

  // ── Versioning / lifecycle (whole-policy granularity — see file header) ──
  version: { type: Number, required: true }, // human-readable, per-currency sequence: 1, 2, 3...

  status: {
    type: String,
    enum: ['PENDING_APPROVAL', 'SCHEDULED', 'ACTIVE', 'SUPERSEDED', 'ROLLED_BACK', 'REJECTED'],
    default: 'ACTIVE',
    index: true,
  },
  approvalStatus: {
    type: String,
    enum: ['AUTO_APPROVED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'],
    default: 'AUTO_APPROVED',
  },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },

  effectiveAt: { type: Date, default: Date.now, index: true },
  appliedAt:   { type: Date }, // null until actually made ACTIVE

  // A rollback (per depositPolicy.service.js rollbackToPolicyVersion) creates
  // a NEW version copying an old version's field values forward — it never
  // deletes or mutates the version being restored from (BBEPS §6.10).
  isRollback:          { type: Boolean, default: false },
  rollbackOfVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'DepositPolicy' },

  businessJustification: { type: String, required: true }, // mandatory here: every DepositPolicy
                                                             // change is high-impact by definition
  changedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  changedByName: { type: String },

  createdAt: { type: Date, default: Date.now, index: true },
});

depositPolicySchema.index({ currency: 1, version: -1 });
depositPolicySchema.index({ currency: 1, status: 1, effectiveAt: 1 }); // scheduled-apply job

export const DepositPolicy = mongoose.model('DepositPolicy', depositPolicySchema);
