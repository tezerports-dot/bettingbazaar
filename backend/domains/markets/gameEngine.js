// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { Cycle, Bet, User } from '../../models/index.js';
import mongoose from 'mongoose';
import { CacheService } from '../../services/cache.service.js';
import { creditWinnings, creditCommission } from '../wallet/walletAuthority.service.js';
import { unlockLostBet, executeSettlementBatch } from '../settlement/settlementService.js';
import { emitPayoutSuccessBatch } from '../notification/realtimeEmitters.js';
// Risk Platform (Phase A, 2026-07-10): payout arithmetic authority — winners
// are paid gross 2x minus the admin-editable winnings platform fee.
import { getRiskRules, computeWinningsPayout } from '../risk/riskValidation.service.js';
// Items 33/38 (2026-07-13): settlement outcomes feed /metrics; a settlement
// failure on a declared cycle pages the admin-configured alert webhook.
import { sendAlert } from '../../services/alerting.service.js';
import { settlementRuns } from '../../services/metrics.service.js';
// unlockLostBet and executeSettlementBatch moved to domains/settlement/ on 2026-07-03.
// processPayoutsOptimized stays here as the orchestrator -- see domains/settlement/README.md.


class GameEngine {
    constructor(io) {
        this.io = io;
        this.isProcessing = false;
        this.currentCycle = null; // Track current active cycle
        this.tickInterval = setInterval(() => this.tick(), 1000);
        // Recovery task runs every 5 minutes
        this.recoveryInterval = setInterval(() => this.payoutRecoveryTask(), 300000);
    }

    start() {
        console.log("🎮 Game Engine: Payout System Active");
        // Load current cycle on startup
        this.loadCurrentCycle();
    }

    /**
     * ✅ FIX #1: Load current active cycle — uses statuses that actually exist
     */
    async loadCurrentCycle() {
        try {
            // ✅ FIX: OPEN/MERGED/CLOSED are what CycleGenerator creates
            this.currentCycle = await Cycle.findOne({
                status: { $in: ['OPEN', 'MERGED', 'CLOSED', 'RESULT_DECLARED'] }
            }).sort({ createdAt: -1 });
        } catch (error) {
            console.error('❌ Error loading current cycle:', error);
        }
    }

    /**
     * ✅ FIX #4: Get current game state — uses correct schema field names
     */
    async getGameState() {
        try {
            await this.loadCurrentCycle();
            
            if (!this.currentCycle) {
                return {
                    status: 'NO_ACTIVE_CYCLE',
                    message: 'No active betting cycle available',
                    timestamp: new Date()
                };
            }

            const now = Date.now();
            const endTime = new Date(this.currentCycle.endTime).getTime();
            const timeRemaining = Math.max(0, Math.floor((endTime - now) / 1000));

            // ✅ FIX #4: Use correct schema field names (realDelhi not delhiPool)
            const realDelhi  = this.currentCycle.realDelhi  || 0;
            const realBombay = this.currentCycle.realBombay || 0;
            const phantomDelhi  = this.currentCycle.phantomDelhi  || 0;
            const phantomBombay = this.currentCycle.phantomBombay || 0;

            return {
                cycleId: this.currentCycle.cycleId,
                status: this.currentCycle.status,
                startTime: this.currentCycle.startTime,
                endTime: this.currentCycle.endTime,
                timeRemaining,
                // Display pools include phantom (so UI sees balanced view)
                delhiPool:  realDelhi  + phantomDelhi,
                bombayPool: realBombay + phantomBombay,
                totalPool:  realDelhi  + realBombay + phantomDelhi + phantomBombay,
                // Admin fields — real only
                realDelhiPool:  realDelhi,
                realBombayPool: realBombay,
                winner:    this.currentCycle.winner    || null,
                result:    this.currentCycle.result    || null,
                isSettled: this.currentCycle.isSettled || 'PENDING',
                timestamp: new Date()
            };
        } catch (error) {
            console.error('❌ Error getting game state:', error);
            return {
                status: 'ERROR',
                message: 'Failed to retrieve game state',
                error: error.message,
                timestamp: new Date()
            };
        }
    }

    async payoutRecoveryTask() {
        // Find cycles that got stuck in 'PROCESSING' state due to server restart
        const stuckCycles = await Cycle.find({ isSettled: 'PROCESSING' });
        for (const cycle of stuckCycles) {
            console.warn(`[Recovery] Resuming interrupted payout for cycle: ${cycle.cycleId}`);
            await this.processPayoutsOptimized(cycle);
        }
    }

    async tick() {
        if (this.isProcessing) return; 
        this.isProcessing = true;

        try {
            // ✅ FIX #1/#2: Look for RESULT_DECLARED — set by fixed CycleGenerator.completeCycle()
            const cyclesToSettle = await Cycle.find({ 
                status: 'RESULT_DECLARED', 
                isSettled: 'PENDING' 
            }).limit(1);
            
            if (cyclesToSettle.length > 0) {
                await this.processPayoutsOptimized(cyclesToSettle[0]);
                await this.loadCurrentCycle();
                settlementRuns.inc({ outcome: 'success' });
            }

        } catch (e) {
            console.error("GameEngine Tick Error:", e);
            settlementRuns.inc({ outcome: 'error' });
            sendAlert('settlement-error', 'Cycle settlement tick failed', { error: e.message });
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * ✅ FIX #4, #5: Optimized Payout Engine with Dual Balance System
     * - 2x payout (bet amount × 2)
     * - ALL payouts go to winningsBalance (withdrawable)
     * - Unlocks both deposit and winnings portions of locked balance
     * Uses MongoDB cursors and bulk writes for O(1) memory usage.
     * Ensures transaction logs are created for every wallet credit.
     */
    async processPayoutsOptimized(cycle) {
        const BATCH_SIZE = 500; 

        // Lock cycle to prevent concurrent settlement by multiple nodes
        const lock = await Cycle.findOneAndUpdate(
            { _id: cycle._id, $or: [{ isSettled: 'PENDING' }, { isSettled: 'PROCESSING' }] }, 
            { $set: { isSettled: 'PROCESSING' } }
        );
        
        if (!lock) {
            console.log(`[Engine] Cycle ${cycle.cycleId} already being processed`);
            return;
        }

        console.log(`[Engine] Starting payout for cycle ${cycle.cycleId}, Winner: ${cycle.winner}`);

        // Winnings platform fee + payout multiplier (Phase A / Business Config
        // Audit): both owned by Business Policy (SystemConfig.winningsFeePercent,
        // SystemConfig.payoutMultiplier), read ONCE per settlement so every bet
        // in this cycle settles under the same snapshot.
        const { winningsFeePercent, payoutMultiplier } = await getRiskRules();

        // Mark losing bets immediately and unlock their balances
        const losingBets = await Bet.find({
            cycleId: cycle.cycleId,
            side: { $ne: cycle.winner },
            status: 'PENDING',
            isPhantom: false
        });

        // Unlock losing bet balances via WalletAuthority helper
        for (const bet of losingBets) {
            await unlockLostBet(bet.userId, bet.amount, bet._id,
                bet.fromDepositBalance || 0, bet.fromWinningsBalance || 0);
        }

        await Bet.updateMany(
            { cycleId: cycle.cycleId, side: { $ne: cycle.winner }, status: 'PENDING', isPhantom: false },
            { $set: { status: 'LOST' } }
        );

        // Process winning bets
        const cursor = Bet.aggregate([
            { $match: { cycleId: cycle.cycleId, side: cycle.winner, status: 'PENDING', isPhantom: false } },
            { $group: {
                _id: "$userId",
                totalBetAmount: { $sum: "$amount" },
                betIds: { $push: "$_id" },
                bets: {
                    $push: {
                        betId: "$_id",
                        amount: "$amount",
                        fromDeposit: "$fromDepositBalance",
                        fromWinnings: "$fromWinningsBalance"
                    }
                }
            } }
        ]).cursor({ batchSize: BATCH_SIZE });

        let userBulkOps = [];
        let txBulkOps = [];

        // Track winner payouts so we can emit per-user payout_success via WS
        const winnerPayouts = []; // { userId, payout, betAmount }

        for await (const winGroup of cursor) {
            // Phase A: per-bet NET payout (gross 2x − winnings platform fee),
            // computed by the Risk Platform arithmetic authority in integer
            // paise. Per-bet stamps let executeSettlementBatch persist the
            // exact net/fee on each Bet document.
            let payoutMinor = 0;
            let feeMinor = 0;
            const betStamps = []; // { betId, payout, platformFee }
            for (const bet of winGroup.bets) {
                const p = computeWinningsPayout({ amount: bet.amount, feePercent: winningsFeePercent, multiplier: payoutMultiplier });
                payoutMinor += p.netMinor;
                feeMinor    += p.feeMinor;
                betStamps.push({ betId: bet.betId, payout: p.net, platformFee: p.fee });
            }
            const payout = payoutMinor / 100;

            // ✅ FIX #4: Calculate locked amounts to release
            let totalLockedDeposit = 0;
            let totalLockedWinnings = 0;

            for (const bet of winGroup.bets) {
                totalLockedDeposit += bet.fromDeposit || 0;
                totalLockedWinnings += bet.fromWinnings || 0;
            }

            // Queue payout — executed via WalletAuthority in executeSettlementBatch
            userBulkOps.push({
                userId: winGroup._id.toString(),
                payout,
                feePercent: winningsFeePercent,
                totalBetAmount: winGroup.totalBetAmount,
                totalLockedDeposit,
                totalLockedWinnings,
                betIds: winGroup.betIds,
                betStamps,
            });

            // Track for WS emit after batch
            winnerPayouts.push({
                userId:    winGroup._id.toString(),
                payout,
                betAmount: winGroup.totalBetAmount,
            });

            txBulkOps.push({
                insertOne: {
                    document: {
                        userId: winGroup._id,
                        type: 'BET_WIN',
                        amount: payout,
                        balanceType: 'WINNINGS',  // ✅ FIX #4: Track that this went to winnings
                        status: 'SUCCESS',
                        referenceId: cycle.cycleId,
                        description: `Payout: ${cycle.cycleId} - ${cycle.winner} won - 2x ${winGroup.totalBetAmount} minus ${winningsFeePercent}% platform fee (₹${feeMinor / 100}) = ${payout}`,
                        timestamp: new Date()
                    }
                }
            });

            if (userBulkOps.length >= BATCH_SIZE) {
                await executeSettlementBatch(userBulkOps, txBulkOps);
                userBulkOps = []; txBulkOps = [];
            }
        }

        if (userBulkOps.length > 0) {
            await executeSettlementBatch(userBulkOps, txBulkOps);
        }

        // Cycle totals are DERIVED from the stamped WON bets, not from this
        // run's in-memory accumulators (F-2 recovery fix, 2026-07-10): a
        // resume after a mid-batch crash only re-processes still-PENDING
        // bets, so accumulators would undercount — the DB sees every bet
        // paid across all passes. Round: payout/platformFee are 2-decimal
        // values whose float sum can drift at the 1e-12 scale.
        const [wonTotals] = await Bet.aggregate([
            { $match: { cycleId: cycle.cycleId, status: 'WON', isPhantom: false } },
            { $group: {
                _id: null,
                paid: { $sum: '$payout' },
                fees: { $sum: '$platformFee' },
                winners: { $addToSet: '$userId' },
            } },
        ]);
        const totalPaidOut      = Math.round((wonTotals?.paid || 0) * 100) / 100;
        const totalPlatformFees = Math.round((wonTotals?.fees || 0) * 100) / 100;
        const totalWinners      = wonTotals?.winners?.length || 0;

        // ── REALTIME PAYOUT NOTIFICATION ──────────────────────────────────────
        // Emit payout_success to each winner's personal room so their wallet
        
        // We query fresh balances so the frontend gets the exact new values.
        if (winnerPayouts.length > 0 && this.io) {
            try {
                const winnerIds   = winnerPayouts.map(w => w.userId);
                const freshUsers  = await User.find({ _id: { $in: winnerIds } })
                                              .select('winningsBalance depositBalance lockedBalance')
                                              .lean();

                const balanceMap  = {};
                for (const u of freshUsers) {
                    balanceMap[u._id.toString()] = u;
                }

                // Fresh balances are embedded, so winners do not need to poll an API.
                // Fan-out is chunked/yielding to keep very large settlements from
                // monopolizing the event loop while preserving live per-user updates.
                await emitPayoutSuccessBatch({
                    io: this.io,
                    payouts: winnerPayouts,
                    balanceMap,
                    cycleId: cycle.cycleId,
                    winner: cycle.winner,
                    batchSize: BATCH_SIZE,
                });
            } catch (emitErr) {
                // Non-critical — payouts were already written to DB
                console.warn('[Engine] payout_success emit error:', emitErr.message);
            }
        }

        // ✅ FIX #6: Mark phantom bets as lost (they never win)
        await Bet.updateMany(
            { cycleId: cycle.cycleId, isPhantom: true, status: 'PENDING' },
            { $set: { status: 'LOST' } }
        );

        // Calculate final stats. totalPaidOut is NET of the winnings platform
        // fee, so netProfit (realPool − totalPaidOut) already contains the
        // retained fee — it reaches PLATFORM_REVENUE through the existing
        // BET_CYCLE_SETTLED posting with no ledger change. The fee fields
        // below itemize it for audit/reporting.
        const realPool = (cycle.realDelhi || 0) + (cycle.realBombay || 0);
        const netProfit = realPool - totalPaidOut;

        await Cycle.updateOne(
            { _id: cycle._id },
            {
                isSettled: 'COMPLETED',
                settledAt: Date.now(),
                totalPaidOut: totalPaidOut,
                netProfit: netProfit,
                totalPlatformFees: totalPlatformFees,
                winningsFeePercentUsed: winningsFeePercent
            }
        );

        await CacheService.del('financial_stats');

        console.log(`[Engine] ✅ Cycle ${cycle.cycleId} settled successfully`);
        console.log(`   Winners: ${totalWinners} users`);
        console.log(`   Total Paid: ₹${totalPaidOut.toLocaleString()} (2x minus ${winningsFeePercent}% fee)`);
        console.log(`   Platform Fees Retained: ₹${totalPlatformFees.toLocaleString()}`);
        console.log(`   Net Profit: ₹${netProfit.toLocaleString()}`);
        if (realPool > 0) console.log(`   Profit Margin: ${((netProfit / realPool) * 100).toFixed(2)}%`);

        // F1 referral commission (non-blocking — won't affect main settlement)
        if (winnerPayouts.length > 0) {
            this.creditF1Commission(winnerPayouts, cycle.cycleId).catch(e =>
                console.warn('[Commission] background error:', e.message)
            );
        }

        // Broadcast settlement complete
        this.io?.emit('payout_complete', {
            cycleId: cycle.cycleId,
            winner: cycle.winner,
            totalPaidOut,
            netProfit,
            winners: totalWinners
        });

        // REALTIME: Push financial delta to admin dashboard — no page reload needed
        this.io?.to('admin-room').emit('admin_stats_update', {
            type:        'PAYOUT_COMPLETE',
            cycleId:     cycle.cycleId,
            totalPaidOut,
            totalPlatformFees,
            netProfit,
            winners:     totalWinners,
            server_ts:   Date.now()
        });
    }

    /**
     * F1 Referral Commission — 1% of winning bet amount credited to direct referrer.
     * Rate is admin-configurable via PUT /api/referral/config { f1Rate: 0.01 }
     */
    async creditF1Commission(winnerPayouts, cycleId) {
        try {
            const CommissionLevel  = mongoose.model('CommissionLevel');
            const cfg = await CommissionLevel.findOne({ key: 'main' }).lean();
            if (!cfg || cfg.commissionEnabled === false || !(cfg.f1Rate > 0)) return;

            const Referral         = mongoose.model('Referral');
            const CommissionRecord = mongoose.model('CommissionRecord');

            const winnerIds = winnerPayouts.map(w => new mongoose.Types.ObjectId(w.userId));
            const refs = await Referral.find({ userId: { $in: winnerIds }, referredBy: { $ne: null } }).lean();
            if (!refs.length) return;

            const commOps = [];
            for (const ref of refs) {
                const wp = winnerPayouts.find(w => w.userId === String(ref.userId));
                if (!wp) continue;
                const commission = Math.round(wp.betAmount * cfg.f1Rate * 100) / 100;
                if (commission <= 0) continue;
                commOps.push({ insertOne: { document: {
                    beneficiaryId: ref.referredBy, fromUserId: ref.userId,
                    amount: commission, rate: cfg.f1Rate, level: 1,
                    betAmount: wp.betAmount, cycleId, credited: true, createdAt: new Date()
                }}});
            }

            if (commOps.length > 0) {
                // Credit commissions via WalletAuthority (ledgered, idempotent per cycleId+userId pair)
                for (const op of commOps) {
                    const doc = op.insertOne.document;
                    await creditCommission(
                        String(doc.beneficiaryId),
                        doc.amount,
                        String(doc.fromUserId),
                        cycleId
                    ).catch(e => console.warn('[Commission] creditCommission error:', e.message));
                }
                await CommissionRecord.bulkWrite(commOps);
                console.log('[Commission] F1 paid to ' + commOps.length + ' referrers @ ' + (cfg.f1Rate*100).toFixed(1) + '%');
            }
        } catch (e) { console.error('[Commission] F1 error:', e.message); }
    }

    /**
     * Cleanup on shutdown
     */
    stop() {
        if (this.tickInterval) clearInterval(this.tickInterval);
        if (this.recoveryInterval) clearInterval(this.recoveryInterval);
        console.log('🎮 Game Engine: Stopped');
    }
}

export default GameEngine;
