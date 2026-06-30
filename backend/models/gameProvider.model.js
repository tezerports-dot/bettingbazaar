// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const gameProviderSchema = new mongoose.Schema({
  key:      { type: String, required: true, unique: true, index: true },
  // Provider meta
  name:     { type: String, required: true },
  category: { type: String, enum: ['casino', 'crash', 'sports', 'slots'], required: true },
  enabled:  { type: Boolean, default: false },
  // Generic credential fields — each provider uses different names but same slots
  apiUrl:        { type: String, default: '' },  // Base API URL from provider
  apiKey:        { type: String, default: '' },  // API key / public key
  apiSecret:     { type: String, default: '' },  // Secret / HMAC key
  merchantId:    { type: String, default: '' },  // Operator ID / casino ID
  extraConfig:   { type: mongoose.Schema.Types.Mixed, default: {} }, // Provider-specific extras
  webhookSecret: { type: String, default: '' },  // For verifying callbacks
  // Display config (for Coming Soon page)
  logoUrl:       { type: String, default: '' },
  description:   { type: String, default: '' },
  updatedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedAt:     { type: Date, default: Date.now },
});
export const GameProvider = mongoose.model('GameProvider', gameProviderSchema);

// GAME SESSION — tracks an active game session for wallet callbacks
const gameSessionSchema = new mongoose.Schema({
  sessionId:   { type: String, required: true, unique: true, index: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  providerKey: { type: String, required: true },
  gameId:      { type: String, default: '' },
  gameName:    { type: String, default: '' },
  currency:    { type: String, default: 'INR' },
  status:      { type: String, enum: ['ACTIVE', 'CLOSED', 'EXPIRED'], default: 'ACTIVE' },
  launchUrl:   { type: String, default: '' },
  createdAt:   { type: Date, default: Date.now, index: true },
  expiresAt:   { type: Date },
});
export const GameSession = mongoose.model('GameSession', gameSessionSchema);

// GAME TRANSACTION — wallet debit/credit/rollback from provider callbacks
const gameTransactionSchema = new mongoose.Schema({
  roundId:     { type: String, required: true, index: true },
  txId:        { type: String, required: true, unique: true }, // idempotency key
  sessionId:   { type: String, required: true, index: true },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  providerKey: { type: String, required: true },
  type:        { type: String, enum: ['BET', 'WIN', 'ROLLBACK', 'REFUND'], required: true },
  amount:      { type: Number, required: true },
  balanceBefore: { type: Number },
  balanceAfter:  { type: Number },
  gameId:      { type: String },
  gameName:    { type: String },
  createdAt:   { type: Date, default: Date.now, index: true },
});
gameTransactionSchema.index({ userId: 1, createdAt: -1 });
export const GameTransaction = mongoose.model('GameTransaction', gameTransactionSchema);


