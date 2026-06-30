// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const referralSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  inviteCode:  { type: String, required: true, unique: true, index: true },
  referredBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  level:       { type: Number, default: 0 },  // 0=root, 1=F1, 2=F2, 3=F3
  totalReferrals:  { type: Number, default: 0 },
  activeReferrals: { type: Number, default: 0 },
  totalEarned:     { type: Number, default: 0 },
  todayEarned:     { type: Number, default: 0 },
  lastEarnedDate:  { type: String },  // YYYY-MM-DD
  createdAt:   { type: Date, default: Date.now },
});
export const Referral = mongoose.model('Referral', referralSchema);

// ---------------------------------------------------------------------------
// COMMISSION LEVEL — admin sets rates per F-level
// ---------------------------------------------------------------------------
const commissionLevelSchema = new mongoose.Schema({
  key:    { type: String, default: 'main', unique: true },
  f1Rate: { type: Number, default: 0.05 }, // 5% of bet placed by direct referral
  // f2Rate and f3Rate removed — multi-level referral not implemented in gameEngine.js.
  // These fields were admin-configurable but never read at settlement — operators
  // were misled into believing F2/F3 commissions were being paid. They were not.
  // GOVERNANCE.md s2: No admin-editable field without a real consumer.
  minBetForCommission: { type: Number, default: 10 },
  commissionEnabled:   { type: Boolean, default: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: { type: Date, default: Date.now },
});
export const CommissionLevel = mongoose.model('CommissionLevel', commissionLevelSchema);

// ---------------------------------------------------------------------------
// COMMISSION RECORD — each commission earned
// ---------------------------------------------------------------------------
const commissionRecordSchema = new mongoose.Schema({
  beneficiaryId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  fromUserId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  betId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Bet' },
  betAmount:     { type: Number, required: true },
  rate:          { type: Number, required: true },
  amount:        { type: Number, required: true },
  level:         { type: Number, enum: [1, 2, 3], required: true },
  credited:      { type: Boolean, default: false },
  creditedAt:    { type: Date },
  createdAt:     { type: Date, default: Date.now, index: true },
});
commissionRecordSchema.index({ beneficiaryId: 1, createdAt: -1 });

export const CommissionRecord = mongoose.model('CommissionRecord', commissionRecordSchema);
