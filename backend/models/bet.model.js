// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const betSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  cycleId: { type: String, required: true, index: true },
  amount: { type: Number, required: true, min: 1 },
  side: { type: String, enum: ['DELHI', 'BOMBAY'], required: true },
  
  // ✅ BALANCE SOURCE TRACKING (FIX #4 + Migration Section 6.2)
  // Tracks which balance the bet came from (for proper refunds)
  fromDepositBalance: { type: Number, default: 0, min: 0 },
  fromWinningsBalance: { type: Number, default: 0, min: 0 },
  fromReserveBalance: { type: Number, default: 0, min: 0 },   // 3% reserve portion
  
  // ✅ PHANTOM BET TRACKING (FIX #2, #6)
  isPhantom: { type: Boolean, default: false, index: true },
  phantomManagerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  status: { 
    type: String, 
    enum: ['PENDING', 'WON', 'LOST', 'REFUNDED'], 
    default: 'PENDING', 
    index: true 
  },
  
  timestamp: { type: Date, default: Date.now, index: true },
  settledAt: { type: Date },
  payout: { type: Number, default: 0 }  // 2x amount for winners
});

// CRITICAL PERFORMANCE INDEXES
betSchema.index({ cycleId: 1, status: 1, side: 1, isPhantom: 1 }); 
betSchema.index({ userId: 1, timestamp: -1 });

// ════════════════════════════════════════════════════════════════════════════
// 💰 TRANSACTION SCHEMA - WITH BALANCE TYPE TRACKING (FIX #4)
// ════════════════════════════════════════════════════════════════════════════

export const Bet = mongoose.model('Bet', betSchema);
