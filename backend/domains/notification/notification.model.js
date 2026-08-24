// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: {
    type: String,
    enum: ['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'KYC', 'PAYMENT', 'BET', 'SYSTEM'],
    required: true
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  actionUrl: { type: String },
  actionLabel: { type: String },
  relatedId: { type: String },
  relatedType: { type: String },
  isRead: { type: Boolean, default: false, index: true },
  readAt: { type: Date },
  createdAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date }
});

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

// ════════════════════════════════════════════════════════════════════════════
// EXPORT ALL MODELS
// ════════════════════════════════════════════════════════════════════════════
const withdrawalRequestSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount:        { type: Number, required: true },
  method:        { type: String, enum: ['UPI','BANK'], default: 'UPI' },
  upiId:         { type: String },
  bankName:      { type: String },
  accountNumber: { type: String },
  ifscCode:      { type: String },
  status:        { type: String, enum: ['PENDING','APPROVED','REJECTED','PAID'], default: 'PENDING', index: true },
  adminNote:     { type: String },
  processedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  processedAt:   { type: Date },
  createdAt:     { type: Date, default: Date.now, index: true },

  // ── PROOF OF RESERVATION (the payable-record invariant) ───────────────────
  // The `wd_lock_<id>` txId of the wallet movement that reserved this payout.
  // A withdrawal request is a PAYABLE INSTRUMENT: an operator reads it and
  // sends real money by hand. It must therefore be impossible for one to exist
  // without the funds already moved out of the player's withdrawable balance.
  //
  // REQUIRED, so the schema itself refuses a request that names no reservation,
  // and UNIQUE, so one reservation can never back two payable records (a replay
  // or a concurrent duplicate collides here rather than producing a second
  // instrument against the same money).
  reservationTxId: { type: String, required: true, unique: true },
});
withdrawalRequestSchema.index({ userId: 1, status: 1 });

// ── ONE OPEN PAYOUT PER PLAYER, ENFORCED BY THE DATABASE ────────────────────
// This rule used to be a read ("is there already a PENDING one?") followed by a
// write, which two concurrent requests both pass — the classic TOCTOU that let a
// player open N payable records against one balance. A partial unique index
// makes the database the arbiter: the second concurrent insert fails with
// E11000 no matter how the requests interleave or which process serves them.
withdrawalRequestSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' }, name: 'one_pending_withdrawal_per_user' },
);

export const Notification      = mongoose.model('Notification',      notificationSchema);
export const WithdrawalRequest = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);
