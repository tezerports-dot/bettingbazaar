// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const cycleSchema = new mongoose.Schema({
  cycleId: { type: String, required: true, unique: true, index: true },
  
  // ✅ ONLY 2 TYPES: 30_MIN and FULL_DAY (FIX #1)
  type: { type: String, enum: ['30_MIN', 'FULL_DAY'], required: true, index: true },
  
  startTime: { type: Number, required: true, index: true },
  endTime: { type: Number, required: true },
  
  status: { 
    type: String, 
    // ✅ FIX #3: Added 'COMPLETED' so cycleGenerator.completeCycle() doesn't silently fail
    enum: ['OPEN', 'MERGED', 'CLOSED', 'RESULT_DECLARED', 'COMPLETED', 'PAUSED', 'CANCELLED'], 
    default: 'OPEN',
    index: true 
  },
  
  // ✅ POOL TRACKING (FIX #2, #6 - Separate real and phantom)
  // User panel shows: totalDelhi/totalBombay
  // Admin panel shows: realDelhi/realBombay only
  totalDelhi: { type: Number, default: 0 },      // real + phantom (shown to users)
  totalBombay: { type: Number, default: 0 },     // real + phantom (shown to users)
  realDelhi: { type: Number, default: 0 },       // actual user bets (admin view)
  realBombay: { type: Number, default: 0 },      // actual user bets (admin view)
  phantomDelhi: { type: Number, default: 0 },    // phantom manager bets
  phantomBombay: { type: Number, default: 0 },   // phantom manager bets
  
  // ✅ PHANTOM EQUALIZER CONTROL (FIX #2, #6)
  phantomBalanced: { type: Boolean, default: false },      // true after equalizer runs
  phantomBetsClosed: { type: Boolean, default: false },    // true after equalizer (no more phantom bets)

  winner: { type: String, enum: ['DELHI', 'BOMBAY', null], default: null },
  pendingResult: { type: String, enum: ['DELHI', 'BOMBAY', null], default: null }, 
  isPaused: { type: Boolean, default: false },
  
  // WINNER DETERMINATION TRACKING
  winnerDetermined: { type: Boolean, default: false },
  winnerDeterminedAt: Date,
  winnerDeterminedBy: {
    type: String,
    enum: ['AUTOMATIC', 'ADMIN_MANUAL', 'PHANTOM_MANAGER'],
    default: 'AUTOMATIC'
  },
  winnerConfidence: {
    type: String,
    enum: ['HIGH', 'MEDIUM', 'LOW', 'EQUAL_POOL'],
    default: 'HIGH'
  },
  
  // SETTLEMENT (FIX #5 - 2x payout tracking)
  isSettled: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'COMPLETED'],
    default: 'PENDING',
    index: true
  },
  settledAt: { type: Date },
  totalPaidOut: { type: Number, default: 0 },   // Total NET payouts to winners (gross − fee since Phase A)
  netProfit: { type: Number, default: 0 },      // House result: realPool − totalPaidOut (includes retained winnings fees)
  // ── WINNINGS PLATFORM FEE (Phase A, 2026-07-10) ─────────────────────────
  // Itemization of the fee retained at settlement. The fee is already inside
  // netProfit (winners are paid net), so the ledger needs no extra posting —
  // these fields exist for audit/reporting. Percent snapshotted at settle
  // time so later config changes can't rewrite history.
  totalPlatformFees:      { type: Number, default: 0 },
  winningsFeePercentUsed: { type: Number, default: 0 }
});

// FIX 5: Unique index on {type, startTime} guarantees at most one cycle per
// type per time block even across concurrent service instances (Railway rolling
// restarts). cycleGenerator now uses findOneAndUpdate+upsert which relies on
// this index to enforce uniqueness atomically.
cycleSchema.index({ type: 1, startTime: 1 }, { unique: true, name: 'cycle_type_start_unique' });

// ════════════════════════════════════════════════════════════════════════════
// 🎲 BET SCHEMA - WITH BALANCE SOURCE TRACKING (FIX #4)
// ════════════════════════════════════════════════════════════════════════════

export const Cycle = mongoose.model('Cycle', cycleSchema);
