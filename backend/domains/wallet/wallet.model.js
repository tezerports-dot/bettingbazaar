// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

// Never update or delete entries — only append.
// ---------------------------------------------------------------------------
const walletLedgerSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:          { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  // 'lockedBalance' added 2026-07-10 (F-2): stake-unlock entries are now
  // honest first-class ledger records instead of 0-amount winningsBalance rows.
  field:         { type: String, enum: ['depositBalance', 'winningsBalance', 'tokenBalance', 'reserveBalance', 'lockedBalance'], required: true },
  amount:        { type: Number, required: true },
  balanceBefore: { type: Number, required: true },
  balanceAfter:  { type: Number, required: true },
  reason:        { type: String, required: true },
  // What caused this entry
  refModel:      { type: String, enum: ['Bet', 'PaymentOrder', 'GiftCode', 'CheckIn', 'SpinWheel', 'Commission', 'AdminAdjustment', 'GameTransaction', 'Referral', 'VIP', 'Other'] },
  refId:         { type: mongoose.Schema.Types.ObjectId },
  txId:          { type: String }, // uniqueness handled by schema.index({ txId:1 }) below
  createdAt:     { type: Date, default: Date.now, index: true },
});
walletLedgerSchema.index({ userId: 1, createdAt: -1 });
walletLedgerSchema.index({ txId: 1 }, { sparse: true, unique: true });
// Ledger is append-only — prevent updates and deletes at schema level
walletLedgerSchema.pre('findOneAndUpdate', function() { throw new Error('WalletLedger is append-only'); });
walletLedgerSchema.pre('updateOne',        function() { throw new Error('WalletLedger is append-only'); });
walletLedgerSchema.pre('updateMany',       function() { throw new Error('WalletLedger is append-only'); });
// Hybrid money DB (plan step 2): mirror every ledger row to Postgres.
// Fire-and-forget — a PG failure can never break the money path (see
// postgres/dualWrite.js); reconcile.js repairs any drift.
import { mirrorWalletLedger } from '../../postgres/dualWrite.js';
walletLedgerSchema.post('save', (doc) => { mirrorWalletLedger(doc); });

export const WalletLedger = mongoose.model('WalletLedger', walletLedgerSchema);

// ===========================================================================

// ===========================================================================

// ---------------------------------------------------------------------------
// FAKE WINNER — admin-managed winners list entries
// Can reference real users OR be fully synthetic (profilePic/username supplied)
// ---------------------------------------------------------------------------
