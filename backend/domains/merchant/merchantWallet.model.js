// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Merchant Platform (BBEPS Phase 008).
//
// MerchantWalletLedger — audit trail + idempotency guard for every mutation
// of Merchant.tokenBalance. Written ONLY by merchantWallet.service.js (the
// merchant-wallet single writer, §1) — mirrors the user-side WalletLedger /
// walletAuthority pattern.

import mongoose from 'mongoose';

const merchantWalletLedgerSchema = new mongoose.Schema({
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  type:       { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  amount:     { type: Number, required: true, min: 0 },
  balanceAfter: { type: Number },

  reason:   { type: String, required: true },
  refModel: { type: String },
  refId:    { type: String },

  // Idempotency: one canonical txId per LOGICAL operation (e.g.
  // mw_dep_deduct_<orderId> for a deposit's inventory deduction regardless
  // of which route completes the order) — this protects against
  // double-application across the several completion paths that previously
  // each ran their own raw $inc.
  txId: { type: String, required: true, unique: true },

  // The LOGICAL key, when one operation produces several rows.
  //
  // A Postgres settlement moves more than one pocket at a time and writes one
  // row per pocket, keyed `<key>:<pocket>` so each stays unique. Mongo has no
  // pockets, so those rows arrive here as separate documents whose txIds are
  // none of them the caller's key — and the gate below looks up that key. Until
  // this field existed the reverse mirror had to REFUSE a multi-pocket movement
  // rather than write rows the gate could not match, which is what blocked the
  // merchant-settlement domain from having any fallback at all.
  //
  // Deliberately NOT unique: several rows legitimately share one movementId.
  // And deliberately not solved with a prefix match — `bet_1` matches
  // `bet_10:available`, a bug this audit already found and fixed in walletPg.
  // A prefix is not an identity.
  movementId: { type: String, index: true },

  createdAt: { type: Date, default: Date.now, index: true },
});

merchantWalletLedgerSchema.index({ merchantId: 1, createdAt: -1 });

// Hybrid money DB (plan step 2): mirror merchant money movements to Postgres.
//
// This fires on CREATE, which for this collection is the RESERVATION step —
// balanceAfter is still null there and the row may yet be deleted. The mirror
// skips those, so the real copy happens when merchantWallet.service completes
// the row and calls the mirror itself. The hook stays because it is the only
// choke point covering any other writer that creates an already-complete row.
import { mirrorMerchantWalletLedger } from '../../postgres/dualWrite.js';
merchantWalletLedgerSchema.post('save', (doc) => { mirrorMerchantWalletLedger(doc); });

export const MerchantWalletLedger = mongoose.model('MerchantWalletLedger', merchantWalletLedgerSchema);
