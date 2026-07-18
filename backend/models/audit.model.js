// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  adminId: { type: String, index: true },
  action: { type: String, index: true },
  details: String,
  targetId: String,
  ip: String,
  timestamp: { type: Date, default: Date.now, index: true }
});

// ════════════════════════════════════════════════════════════════════════════
// 🔒 TOKEN BLACKLIST SCHEMA
// ════════════════════════════════════════════════════════════════════════════
const tokenBlacklistSchema = new mongoose.Schema({
  token: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
});

// ════════════════════════════════════════════════════════════════════════════
// ⚙️ SYSTEM CONFIG SCHEMA
const enhancedAuditLogSchema = new mongoose.Schema({
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  performedByName: { type: String },
  performedByRole: { type: String },
  action: { type: String, required: true, index: true },
  category: {
    type: String,
    enum: ['USER_MANAGEMENT', 'KYC', 'FINANCIAL', 'MERCHANT', 'CONTENT', 'SYSTEM', 'SECURITY'],
    required: true,
    index: true
  },
  targetType: { type: String },
  targetId: { type: String, index: true },
  targetName: { type: String },
  details: { type: mongoose.Schema.Types.Mixed },
  changes: {
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed }
  },
  ip: { type: String },
  userAgent: { type: String },
  method: { type: String },
  endpoint: { type: String },
  success: { type: Boolean, default: true },
  errorMessage: { type: String },
  timestamp: { type: Date, default: Date.now, index: true }
});

enhancedAuditLogSchema.index({ performedBy: 1, timestamp: -1, _id: -1 });
enhancedAuditLogSchema.index({ category: 1, action: 1, timestamp: -1, _id: -1 });

// ════════════════════════════════════════════════════════════════════════════
// 🔔 NOTIFICATION SCHEMA
// ════════════════════════════════════════════════════════════════════════════

export const AuditLog        = mongoose.model('AuditLog',        auditLogSchema);
export const EnhancedAuditLog = mongoose.model('EnhancedAuditLog', enhancedAuditLogSchema);
