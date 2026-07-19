// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const vipLevelConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  levels: [{
    level:              { type: Number, required: true },
    name:               { type: String, required: true },   // Bronze, Silver, Gold, Platinum, Diamond
    minTotalDeposit:    { type: Number, required: true },   // INR threshold
    dailyWithdrawalLimit: { type: Number, default: 10000 },
    withdrawalFeeDiscount: { type: Number, default: 0 },    // % off standard fee
    bonusPercent:       { type: Number, default: 0 },       // bonus on each deposit
    badgeColor:         { type: String, default: '#888' },
    badgeIcon:          { type: String, default: '🥉' },
  }],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt: { type: Date, default: Date.now },
});
export const VIPLevelConfig = mongoose.model('VIPLevelConfig', vipLevelConfigSchema);

// Store user's current VIP level
const userVIPSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  currentLevel:   { type: Number, default: 0 },
  totalDeposited: { type: Number, default: 0 },
  levelUpdatedAt: { type: Date, default: Date.now },
});
export const UserVIP = mongoose.model('UserVIP', userVIPSchema);

// ---------------------------------------------------------------------------
// ANNOUNCEMENT — admin pushes site-wide notices to user panel
// ---------------------------------------------------------------------------
const balanceAdjustmentSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  adminId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:      { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
  field:     { type: String, enum: ['depositBalance', 'winningsBalance', 'tokenBalance'], required: true },
  amount:    { type: Number, required: true },
  reason:    { type: String, required: true },
  beforeBalance: { type: Number },
  afterBalance:  { type: Number },
  createdAt: { type: Date, default: Date.now, index: true },
});
export const BalanceAdjustment = mongoose.model('BalanceAdjustment', balanceAdjustmentSchema);

// ---------------------------------------------------------------------------
// GAME PROVIDER CONFIG — stores API credentials per external game provider.
// Admin configures each provider from the Game Providers admin page.
// When a provider's enabled=false or credentials are empty, the user panel
// shows a "Coming Soon" page for that section.
// ---------------------------------------------------------------------------

