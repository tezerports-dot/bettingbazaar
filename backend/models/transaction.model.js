// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { 
    type: String, 
    enum: [
      'DEPOSIT',           
      'WITHDRAWAL',        
      // ── NEW TOKEN-ECONOMY TYPES ─────────────────────────────────────────
      'TOKEN_PURCHASE',    // User buys BB tokens with INR (depositBalance credit)
      'TOKEN_REDEMPTION',  // User sells BB tokens for INR (winningsBalance debit)
      // ── MERCHANT FUNDING (never appear in user deposit/withdrawal dashboards) ──
      'MERCHANT_TOPUP',    // Admin funds merchant token wallet
      'MERCHANT_RESERVE',  // Merchant reserved allocation
      'MERCHANT_LIQUIDITY',// Merchant liquidity adjustment
      // ── GAME TYPES ──────────────────────────────────────────────────────
      'BET_PLACED',
      'BET_WIN',
      'BET_LOSS',
      'BET_REFUND',
      'ADMIN_ADJUSTMENT',
      'ESCROW_LOCK',
      'ESCROW_RELEASE'
    ], 
    required: true,
    index: true
  },
  amount: { type: Number, required: true },
  
  // ✅ BALANCE TYPE TRACKING (FIX #4)
  balanceType: { 
    type: String, 
    enum: ['DEPOSIT', 'WINNINGS', 'BOTH'],
    default: 'DEPOSIT'
  },
  
  // Before/After snapshots for audit trail
  depositBalanceBefore: { type: Number },
  depositBalanceAfter: { type: Number },
  winningsBalanceBefore: { type: Number },
  winningsBalanceAfter: { type: Number },
  lockedBalanceBefore: { type: Number },
  lockedBalanceAfter: { type: Number },
  
  status: { type: String, enum: ['SUCCESS', 'PENDING', 'FAILED'], default: 'SUCCESS', index: true },
  referenceId: { type: String },  // Bet ID, Order ID, Cycle ID
  description: { type: String },
  adminId: { type: String },
  merchantId: { type: String },
  timestamp: { type: Date, default: Date.now, index: true }
});

// ════════════════════════════════════════════════════════════════════════════
// 🏪 MERCHANT SCHEMA
// ════════════════════════════════════════════════════════════════════════════

export const Transaction = mongoose.model('Transaction', transactionSchema);
