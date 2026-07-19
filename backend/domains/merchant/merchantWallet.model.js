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

  createdAt: { type: Date, default: Date.now, index: true },
});

merchantWalletLedgerSchema.index({ merchantId: 1, createdAt: -1 });

// Hybrid money DB (plan step 2): mirror merchant money movements to Postgres.
import { mirrorMerchantWalletLedger } from '../../postgres/dualWrite.js';
merchantWalletLedgerSchema.post('save', (doc) => { mirrorMerchantWalletLedger(doc); });

export const MerchantWalletLedger = mongoose.model('MerchantWalletLedger', merchantWalletLedgerSchema);
