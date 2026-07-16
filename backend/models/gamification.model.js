// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

// ---------------------------------------------------------------------------
const checkInSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  currentStreak: { type: Number, default: 0 },
  longestStreak: { type: Number, default: 0 },
  totalCheckIns: { type: Number, default: 0 },
  lastCheckIn:   { type: String },  // YYYY-MM-DD
  checkInDates:  [{ type: String }], // YYYY-MM-DD array (last 30 days)
  totalEarned:   { type: Number, default: 0 },
});

// Do not create new routes or UI for this feature.
export const CheckIn = mongoose.model('CheckIn', checkInSchema);

const checkInConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  // Rewards per day of streak (day1 through day7, then repeats)
  rewards: {
    day1: { type: Number, default: 5   },
    day2: { type: Number, default: 10  },
    day3: { type: Number, default: 15  },
    day4: { type: Number, default: 20  },
    day5: { type: Number, default: 30  },
    day6: { type: Number, default: 50  },
    day7: { type: Number, default: 100 },
  },
  bonusUnit:   { type: String, enum: ['TOKENS', 'INR'], default: 'TOKENS' },
  enabled:     { type: Boolean, default: true },
  updatedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt:   { type: Date, default: Date.now },
});
// I-02: CheckInConfig removed — no new admin UI. Model retained for data only.
export const CheckInConfig = mongoose.model('CheckInConfig', checkInConfigSchema);

// ---------------------------------------------------------------------------
// GIFT CODE — admin creates, user redeems for balance
// ---------------------------------------------------------------------------
const giftCodeSchema = new mongoose.Schema({
  code:       { type: String, required: true, unique: true, uppercase: true, index: true },
  amount:     { type: Number, required: true },
  bonusType:  { type: String, enum: ['TOKENS', 'DEPOSIT_BALANCE', 'WINNINGS_BALANCE'], default: 'TOKENS' },
  maxUses:    { type: Number, default: 1 },
  usedCount:  { type: Number, default: 0 },
  expiresAt:  { type: Date },
  isActive:   { type: Boolean, default: true },
  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt:  { type: Date, default: Date.now },
  note:       { type: String, default: '' },
});
export const GiftCode = mongoose.model('GiftCode', giftCodeSchema);

const giftCodeRedemptionSchema = new mongoose.Schema({
  codeId:     { type: mongoose.Schema.Types.ObjectId, ref: 'GiftCode', required: true, index: true },
  code:       { type: String, required: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount:     { type: Number, required: true },
  redeemedAt: { type: Date, default: Date.now },
});
giftCodeRedemptionSchema.index({ userId: 1, codeId: 1 }, { unique: true });
export const GiftCodeRedemption = mongoose.model('GiftCodeRedemption', giftCodeRedemptionSchema);

// ---------------------------------------------------------------------------
// BONUS RECORD — unified bonus history for users
// ---------------------------------------------------------------------------
const bonusRecordSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:        { type: String, enum: ['CHECK_IN', 'GIFT_CODE', 'REFERRAL_COMMISSION', 'ADMIN_CREDIT', 'LEVEL_UP', 'FIRST_DEPOSIT', 'MANUAL'], required: true },
  amount:      { type: Number, required: true },
  description: { type: String, default: '' },
  refId:       { type: String },  // reference ID (gift code, betId, etc.)
  createdAt:   { type: Date, default: Date.now, index: true },
});
bonusRecordSchema.index({ userId: 1, createdAt: -1 });
export const BonusRecord = mongoose.model('BonusRecord', bonusRecordSchema);

// ---------------------------------------------------------------------------
// VIP LEVEL — user VIP tier based on total deposits
// ---------------------------------------------------------------------------

// Store user's current VIP level

// ---------------------------------------------------------------------------
// ANNOUNCEMENT — admin pushes site-wide notices to user panel
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
const leaderboardCacheSchema = new mongoose.Schema({
  period:    { type: String, enum: ['daily', 'weekly', 'monthly', 'alltime'], required: true },
  entries: [{
    rank:       { type: Number },
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    username:   { type: String },
    totalBets:  { type: Number, default: 0 },
    totalWon:   { type: Number, default: 0 },
    netProfit:  { type: Number, default: 0 },
    winRate:    { type: Number, default: 0 },
  }],
  generatedAt: { type: Date, default: Date.now },
});
leaderboardCacheSchema.index({ period: 1 }, { unique: true });
export const LeaderboardCache = mongoose.model('LeaderboardCache', leaderboardCacheSchema);

// ---------------------------------------------------------------------------
// ADMIN BALANCE ADJUSTMENT — audit trail for manual credits/debits
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GAME PROVIDER CONFIG — stores API credentials per external game provider.
// Admin configures each provider from the Game Providers admin page.
// When a provider's enabled=false or credentials are empty, the user panel
// shows a "Coming Soon" page for that section.

