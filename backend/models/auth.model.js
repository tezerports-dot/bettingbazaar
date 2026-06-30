// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const tokenBlacklistSchema = new mongoose.Schema({
  token: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
});

// ════════════════════════════════════════════════════════════════════════════
// ⚙️ SYSTEM CONFIG SCHEMA
// ════════════════════════════════════════════════════════════════════════════

export const TokenBlacklist = mongoose.model('TokenBlacklist', tokenBlacklistSchema);
