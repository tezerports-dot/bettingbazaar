// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const merchantAdminTokenOrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  tokenAmount: { type: Number, required: true, min: 1 },
  usdtRate: { type: Number, required: true, min: 0 },
  usdtAmount: { type: Number, required: true, min: 0 },
  usdtTxHash: { type: String, trim: true },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', index: true },
  requestedAt: { type: Date, default: Date.now, index: true },
  reviewedAt: { type: Date },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewNote: { type: String },
}, { timestamps: true });

merchantAdminTokenOrderSchema.index({ merchantId: 1, requestedAt: -1 });

export const MerchantAdminTokenOrder = mongoose.model('MerchantAdminTokenOrder', merchantAdminTokenOrderSchema);
