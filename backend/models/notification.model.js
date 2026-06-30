// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
});
withdrawalRequestSchema.index({ userId: 1, status: 1 });

export const Notification      = mongoose.model('Notification',      notificationSchema);
export const WithdrawalRequest = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);
