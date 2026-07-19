// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Revenue & Settlement Platform (BBEPS Phase 007 bootstrap, 2026-07-09).
//
// AccountingEvent — the settlement ledger. APPEND-ONLY, double-entry.
//
//   - Each document is one immutable journal entry: a set of signed postings
//     (integer paise) that sum to exactly zero.
//   - Written ONLY by revenueSettlement.service.js (docs/governance/04-GOVERNANCE.md §1/§2 —
//     single-writer authority). Route handlers and other services must call
//     that service, never this model.
//   - Never updated, never deleted. Corrections are new ADJUSTMENT entries
//     that reverse the original (standard reversing-entry practice). The
//     query/document middleware below makes mutation attempts throw loudly.
//   - Balances are ALWAYS derived by summing postings — never stored in a
//     separate "balance" field that could drift from the entries.
//   - idempotencyKey is globally unique: recording the same source event
//     twice is a silent no-op at the service layer and a duplicate-key error
//     at the DB layer (belt and braces).

import mongoose from 'mongoose';
import { ACCOUNT_CODES, EVENT_TYPE_LIST } from './chartOfAccounts.js';

const postingSchema = new mongoose.Schema({
  account:     { type: String, required: true, enum: ACCOUNT_CODES },
  // Signed integer minor units (paise). Positive = debit, negative = credit.
  amountMinor: {
    type: Number, required: true,
    validate: {
      validator: Number.isInteger,
      message: 'Posting amounts must be integer minor units (paise) — no floats in the ledger.',
    },
  },
}, { _id: false });

const accountingEventSchema = new mongoose.Schema({
  eventType: { type: String, required: true, enum: EVENT_TYPE_LIST, index: true },

  // Globally unique — the idempotency guard. Convention: `acct_<source>_<id>`
  // (e.g. acct_dep_<orderId>, acct_cycle_<cycleId>, acct_bonusfund_<key>).
  idempotencyKey: { type: String, required: true, unique: true },

  // Signed postings summing to zero — validated in the service before create
  // AND here as a schema-level invariant.
  postings: {
    type: [postingSchema],
    required: true,
    validate: [
      {
        validator: (arr) => Array.isArray(arr) && arr.length >= 2,
        message: 'An accounting event needs at least two postings (double-entry).',
      },
      {
        validator: (arr) => arr.reduce((s, p) => s + p.amountMinor, 0) === 0,
        message: 'Postings must sum to exactly zero (double-entry invariant).',
      },
    ],
  },

  // Source record this entry was derived from (reconciliation anchor).
  refModel: { type: String, enum: ['PaymentOrder', 'Cycle', 'Manual', 'Merchant'], required: true },
  refId:    { type: String, required: true }, // String, not ObjectId — Cycle uses cycleId strings

  // When the underlying financial event actually happened (source timestamp),
  // vs. createdAt = when the ledger recorded it (reconciler lag ≤ ~60s).
  occurredAt: { type: Date, required: true, index: true },

  description: { type: String, required: true },

  // Free-form snapshot of source figures for audit (rupee amounts as found,
  // rates, allocations...). Never used for balance math — postings are.
  metadata: { type: mongoose.Schema.Types.Mixed },

  // Who/what recorded it: 'reconciler' for the worker, or an admin user id
  // for manual events (bonus funding, adjustments).
  recordedBy: { type: String, required: true, default: 'reconciler' },

  createdAt: { type: Date, default: Date.now, index: true },
});

// Reconciliation anchor — lets the worker anti-join "completed sources with
// no ledger entry yet" efficiently.
accountingEventSchema.index({ refModel: 1, refId: 1 });
accountingEventSchema.index({ eventType: 1, createdAt: -1 });
// Balance derivation path
accountingEventSchema.index({ 'postings.account': 1 });

// ── Immutability enforcement ─────────────────────────────────────────────────
// The ledger is append-only. Any code path that tries to mutate or delete an
// entry is a bug — fail loudly rather than corrupting the audit trail.
const IMMUTABLE_MSG = 'AccountingEvent is append-only — corrections are new ADJUSTMENT entries, never edits (Revenue & Settlement Platform invariant).';

accountingEventSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error(IMMUTABLE_MSG));
  next();
});
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace',
                  'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  accountingEventSchema.pre(op, function (next) { next(new Error(IMMUTABLE_MSG)); });
}

// Hybrid money DB (plan step 2): mirror every posting to Postgres
// accounting_events (append-only + conserve-to-zero enforced by PG triggers).
import { mirrorAccountingEvent } from '../../postgres/dualWrite.js';
accountingEventSchema.post('save', (doc) => { mirrorAccountingEvent(doc); });
accountingEventSchema.post('insertMany', (docs) => { (docs || []).forEach(d => mirrorAccountingEvent(d)); });

export const AccountingEvent = mongoose.model('AccountingEvent', accountingEventSchema);
