// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
  // NET payout credited to the winner (gross 2x − platformFee). Phase A:
  // pre-fee bets have payout = 2x amount and platformFee 0.
  payout: { type: Number, default: 0 },
  // Platform fee on winnings retained at settlement (Phase A, 2026-07-10).
  // Percent owned by SystemConfig.winningsFeePercent; arithmetic in
  // riskValidation.computeWinningsPayout; stamped by gameEngine.
  platformFee: { type: Number, default: 0 }
});

// CRITICAL PERFORMANCE INDEXES
betSchema.index({ cycleId: 1, status: 1, side: 1, isPhantom: 1 });
betSchema.index({ userId: 1, timestamp: -1 });

// Derived-pool aggregation (cyclePool.service.computeRealPools) — the query that
// REPLACES the per-bet `$inc` on the Cycle document once FEATURE_DERIVED_CYCLE_POOLS
// is on. It matches {cycleId, isPhantom:false, status≠REFUNDED} and groups by side
// summing amount. Ordering the index equality-first (cycleId, isPhantom), then the
// group key (side), then the filtered field (status), and finally `amount` makes
// that sum an index-only scan: the hot per-second aggregation never touches a bet
// document. This is what keeps the derived path's own cost bounded at 10k DAU —
// the whole point of removing the hot counter is not to trade it for a full-scan.
betSchema.index(
  { cycleId: 1, isPhantom: 1, side: 1, status: 1, amount: 1 },
  { name: 'derived_pool_sum' },
);

// The public winners leaderboard (routes/winners.routes.js): the biggest NET
// payouts in a rolling window. Neither index above can serve it — both lead
// with `cycleId`, and this query has no cycleId at all — so it was a collection
// scan plus an in-memory sort over the largest collection in the system, from a
// PUBLIC, unauthenticated endpoint, getting slower every day the platform runs.
//
// Ordered equality-then-sort (`payout: -1` third) so the index PROVIDES the
// order rather than feeding a blocking sort. That is the point: an in-memory
// sort has a hard 32 MB ceiling and fails the request outright past it, whereas
// walking the index in payout order degrades into a longer scan. `settledAt`
// is last so the window filter is answered from the index too.
//
// SCALE LIMIT, stated rather than implied: this is a query over `bets`, and at
// the load target (500–800 bets/sec) a 24-hour window holds tens of millions of
// documents. An index bounds the cost; it does not make it small. Past that,
// the leaderboard wants to be a maintained collection written at settlement,
// not a query — do that when the window scan shows up in latency, not before.
betSchema.index(
  { status: 1, isPhantom: 1, payout: -1, settledAt: -1 },
  { name: 'winners_leaderboard' },
);

// Hybrid money DB (plan step 2): project the bet LIFECYCLE onto the state
// machine Postgres owns, so a cutover finds every in-flight bet already there
// rather than losing the whole PENDING population at the moment of the flip.
//
// State only — the stake movement is mirrored by the wallet path, and moving it
// from two places would double-count. mirrorBet no-ops while Postgres is
// authoritative; the reverse mirror owns that direction.
//
// `updateMany` is deliberately NOT hooked, and it is the settlement path's main
// shape (gameEngine marks a whole cycle LOST in one statement). Mongoose gives
// a bulk update no documents to hand a post hook, so there is nothing to mirror
// from — reconcile.js's cross-store state check is the completeness guarantee
// for those, exactly as it is for the order paths hooks cannot see.
import { mirrorBet } from '../../postgres/dualWrite.js';

betSchema.post('save', (doc) => { mirrorBet(doc); });
betSchema.post('findOneAndUpdate', (doc) => { if (doc) mirrorBet(doc); });

// ════════════════════════════════════════════════════════════════════════════
// 💰 TRANSACTION SCHEMA - WITH BALANCE TYPE TRACKING (FIX #4)
// ════════════════════════════════════════════════════════════════════════════

export const Bet = mongoose.model('Bet', betSchema);
