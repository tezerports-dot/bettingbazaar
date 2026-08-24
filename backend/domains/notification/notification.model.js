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
// `WithdrawalRequest` was removed on 2026-08-24 along with the parallel
// withdrawal system it backed (POST /v1/user/withdraw and the admin
// /withdrawal-requests routes). Nothing called them, no admin screen could
// display them, and they duplicated the P2P flow — see the note in
// domains/user/user.routes.js. Withdrawals are PaymentOrders.

export const Notification = mongoose.model('Notification', notificationSchema);
