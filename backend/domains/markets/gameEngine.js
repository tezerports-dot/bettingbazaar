// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { Cycle, Bet, User } from '../../models/index.js';
import mongoose from 'mongoose';
import { CacheService } from '../../services/cache.service.js';
import { creditWinnings } from '../wallet/walletAuthority.service.js';
import { unlockLostBet, executeSettlementBatch } from '../settlement/settlementService.js';
import { emitPayoutSuccessBatch } from '../notification/realtimeEmitters.js';
// Risk Platform (Phase A, 2026-07-10): payout arithmetic authority — winners
// are paid gross 2x minus the admin-editable winnings platform fee.
import { getRiskRules, computeWinningsPayout } from '../risk/riskValidation.service.js';
// Items 33/38 (2026-07-13): settlement outcomes feed /metrics; a settlement
// failure on a declared cycle pages the admin-configured alert webhook.
import { sendAlert } from '../../services/alerting.service.js';
import { settlementRuns } from '../../services/metrics.service.js';
// Derived cycle pools (FLAGS.DERIVED_CYCLE_POOLS, default off).
import { refreshRealPools, forgetCycle } from './cyclePool.service.js';
// Hybrid money DB: the settlement RUN is mirrored into Postgres from the two
// points that change its state. See the note on the Cycle model's hooks for why
// those hooks alone cannot see either of them.
import { mirrorCycleSettlement } from '../../postgres/dualWrite.js';
// …and routed through the resolver, so that once Postgres owns this path the
// run is a row with a UNIQUE cycle_id rather than a flag that can be written
// back. beginSettlement/finishSettlement no-op while Mongo is authoritative.
import { beginSettlement, finishSettlement } from '../../postgres/settlementPgAuthority.js';
// The bet lifecycle's other half. Placement has routed through the resolver for
// a while; settlement wrote Bet.status directly here and in settlementService,
// which left half the lifecycle authoritative in each store.
import { onPostgres as betsOnPostgres, settleBetOnPostgres, findPendingBetsForCycleOnPostgres } from '../../postgres/betPgAuthority.js';
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

        // Open the settlement RUN. While Mongo is authoritative this is the
        // mirror — explicit rather than left to the model hook, because
        // findOneAndUpdate above has no `new: true`, so the hook is handed the
        // PRE-update document and would still read PENDING. Fire-and-forget by
        // design: a mirror failure must never stop a payout.
        mirrorCycleSettlement({ ...lock.toObject?.() ?? lock, isSettled: 'PROCESSING' });

        // Once Postgres owns the path this is the real claim, and it is AWAITED
        // — a run that failed to open must not go on to pay anybody. `resumed`
        // is not a refusal: gameEngine re-admits a PROCESSING cycle on purpose
        // so an interrupted payout can be finished, and treating a resume as a
        // stop would strand the cycles that most need finishing.
        const claim = await beginSettlement({
            cycleId: cycle.cycleId, winningSide: cycle.winner,
        });
        if (!claim.ok) {
            console.error(`[Engine] Postgres refused the settlement claim for ${cycle.cycleId}:`, claim.reason);
            sendAlert('settlement-error', 'Postgres refused a settlement claim', {
                cycleId: cycle.cycleId, reason: claim.reason,
            });
            return;
        }

        console.log(`[Engine] Starting payout for cycle ${cycle.cycleId}, Winner: ${cycle.winner}`);

        // Winnings platform fee + payout multiplier (Phase A / Business Config
        // Audit): both owned by Business Policy (SystemConfig.winningsFeePercent,
        // SystemConfig.payoutMultiplier), read ONCE per settlement so every bet
        // in this cycle settles under the same snapshot.
        const { winningsFeePercent, payoutMultiplier } = await getRiskRules();

        // ── WHICH STORE SETTLES THIS CYCLE ────────────────────────────────────
        // Read ONCE, for the whole pass, and passed down to the winning side
        // rather than asked again there. Both halves of the lifecycle must
        // settle in the SAME store: a cycle whose losing bets are authoritative
        // in Postgres and whose winning bets are authoritative in Mongo is the
        // split no reconciliation can tell apart from the two stores genuinely
        // disagreeing. docs/BETS_SETTLEMENT_ROUTING.md; same rule ORDERS was
        // built as one seam for.
        const onPg = betsOnPostgres();

        // Every bet this pass could not settle, with the reason. Reported, never
        // swallowed — a refused bet still has its stake locked, and a settlement
        // pass that returned quietly would leave that for someone to find by
        // hand months later.
        const refusals = [];

        // Mark losing bets immediately and unlock their balances
        const losingBets = await Bet.find({
            cycleId: cycle.cycleId,
            side: { $ne: cycle.winner },
            status: 'PENDING',
            isPhantom: false
        });

        if (onPg) {
            // betPg.loseBet consumes the locked stake and stamps the status in
            // ONE transaction, so unlockLostBet must NOT also run — the wallet
            // path is already on Postgres (BETS dependsOn WALLET), and calling
            // both would release the same stake twice.
            //
            // The bulk updateMany is skipped for the reason it must be: the
            // reverse mirror has already written each status, so re-stamping
            // would overwrite the bets Postgres deliberately REFUSED and turn a
            // reported failure into a silent one.
            for (const bet of losingBets) {
                const r = await settleBetOnPostgres({
                    bet, outcome: 'LOST', reason: 'Lost bet unlock — cycle result',
                });
                if (!r.handled) {
                    // The resolver changed answer underneath a running pass.
                    // Loud rather than a half-settled cycle.
                    throw new Error(
                        `[Engine] bets authority changed mid-settlement of ${cycle.cycleId} — `
                        + 'refusing to settle the rest of the cycle in a different store',
                    );
                }
                if (!r.ok) {
                    refusals.push({ betId: String(bet._id), userId: String(bet.userId), outcome: 'LOST', reason: r.reason });
                }
            }
        } else {
            // Unlock losing bet balances via WalletAuthority helper
            for (const bet of losingBets) {
                await unlockLostBet(bet.userId, bet.amount, bet._id,
                    bet.fromDepositBalance || 0, bet.fromWinningsBalance || 0);
            }

            await Bet.updateMany(
                { cycleId: cycle.cycleId, side: { $ne: cycle.winner }, status: 'PENDING', isPhantom: false },
                { $set: { status: 'LOST' } }
            );
        }

        // Process winning bets
        const cursor = Bet.aggregate([
            { $match: { cycleId: cycle.cycleId, side: cycle.winner, status: 'PENDING', isPhantom: false } },
            // The projected names are the Bet document's OWN names, not aliases.
            // They used to be `fromDeposit`/`fromWinnings`, which the Mongo path
            // read back consistently and nothing else could: betPgAuthority's
            // `slicesFromBet` looks for `fromDepositBalance` and read `undefined`
            // from every one of these. `fromReserveBalance` was not projected at
            // all, and `betPg.settle` requires the slices to sum EXACTLY to the
            // stake — so a reserve-funded bet threw rather than settling.
            { $group: {
                _id: "$userId",
                totalBetAmount: { $sum: "$amount" },
                betIds: { $push: "$_id" },
                bets: {
                    $push: {
                        betId: "$_id",
                        amount: "$amount",
                        fromDepositBalance:  "$fromDepositBalance",
                        fromWinningsBalance: "$fromWinningsBalance",
                        fromReserveBalance:  "$fromReserveBalance",
                        timestamp: "$timestamp"
                    }
                }
            } }
        ]).cursor({ batchSize: BATCH_SIZE });

        let userBulkOps = [];
        let txBulkOps = [];

        // Track winner payouts so we can emit per-user payout_success via WS
        const winnerPayouts = []; // { userId, payout, betAmount }
        // How many winning bets each user had in this pass, so a refusal count
        // can be compared against it rather than against the number of users.
        const betsPerWinner = new Map();

        for await (const winGroup of cursor) {
            // Phase A: per-bet NET payout (gross 2x − winnings platform fee),
            // computed by the Risk Platform arithmetic authority in integer
            // paise. Per-bet stamps let executeSettlementBatch persist the
            // exact net/fee on each Bet document.
            let payoutMinor = 0;
            let feeMinor = 0;
            // { betId, payout, platformFee, bet } — the DOCUMENT travels with the
            // stamp because the Postgres path settles per bet and needs its
            // funding slices. It used to carry the three scalars alone, so
            // routing the winning side had nothing to derive the slices from.
            // The pieces the aggregation cannot know per bet (they are constant
            // across the group) are filled from the group key and the cycle.
            const betStamps = [];
            for (const bet of winGroup.bets) {
                const p = computeWinningsPayout({ amount: bet.amount, feePercent: winningsFeePercent, multiplier: payoutMultiplier });
                payoutMinor += p.netMinor;
                feeMinor    += p.feeMinor;
                betStamps.push({
                    betId: bet.betId,
                    payout: p.net,
                    platformFee: p.fee,
                    bet: {
                        _id:    bet.betId,
                        userId: winGroup._id,
                        cycleId: cycle.cycleId,
                        side:    cycle.winner,
                        amount:  bet.amount,
                        fromDepositBalance:  bet.fromDepositBalance,
                        fromWinningsBalance: bet.fromWinningsBalance,
                        fromReserveBalance:  bet.fromReserveBalance,
                        timestamp: bet.timestamp,
                    },
                });
            }
            const payout = payoutMinor / 100;

            // ✅ FIX #4: Calculate locked amounts to release
            let totalLockedDeposit = 0;
            let totalLockedWinnings = 0;

            for (const bet of winGroup.bets) {
                totalLockedDeposit += bet.fromDepositBalance || 0;
                totalLockedWinnings += bet.fromWinningsBalance || 0;
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
            betsPerWinner.set(winGroup._id.toString(), betStamps.length);

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
                refusals.push(...(await executeSettlementBatch(userBulkOps, txBulkOps, { onPg })).refused);
                userBulkOps = []; txBulkOps = [];
            }
        }

        if (userBulkOps.length > 0) {
            refusals.push(...(await executeSettlementBatch(userBulkOps, txBulkOps, { onPg })).refused);
        }

        // ── REFUSALS ──────────────────────────────────────────────────────────
        // A refused bet is one Postgres would not transition — a legacy bet with
        // no recorded funding split, slices that do not sum to the stake, a
        // status that is no longer PENDING. Its stake is still locked.
        //
        // The pass CONTINUES rather than aborting: the bets that did settle are
        // settled, the money that moved is real, and every transition here is
        // guarded and idempotent, so a re-run advances only what is left. Failing
        // the whole cycle would strand the bets that succeeded alongside the one
        // that did not.
        //
        // What must not happen is that it goes unreported, and there are two
        // independent detectors: this alert, and findIncompleteSettlements —
        // which is precisely the query for "a COMPLETED run with bets still
        // PENDING", i.e. a stake locked with nothing coming to release it.
        if (refusals.length > 0) {
            console.error(`[Engine] Postgres refused ${refusals.length} bet settlement(s) on ${cycle.cycleId}:`,
                refusals.slice(0, 10));
            sendAlert('settlement-error', 'Postgres refused bet settlements — stakes remain locked', {
                cycleId: cycle.cycleId, refused: refusals.length, sample: refusals.slice(0, 10),
            });
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
        //
        // A user whose EVERY bet was refused is dropped: `payout` here is the
        // amount the pass intended to pay, and telling someone they were paid
        // when the transition was refused is worse than telling them nothing.
        // Partially-refused users keep their event — the embedded balances are
        // read fresh from the store, so what they see is what they actually have.
        const refusedByUser = refusals.reduce((m, r) => m.set(r.userId, (m.get(r.userId) || 0) + 1), new Map());
        const paidWinners = refusedByUser.size === 0 ? winnerPayouts : winnerPayouts.filter((w) => {
            const settledForUser = betsPerWinner.get(w.userId) || 0;
            return settledForUser > (refusedByUser.get(w.userId) || 0);
        });

        if (paidWinners.length > 0 && this.io) {
            try {
                const winnerIds   = paidWinners.map(w => w.userId);
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
                    payouts: paidWinners,
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
        //
        // UNCONDITIONAL — this one bulk update is correct on both branches, and
        // it is the only Bet write here that is. A phantom bet is synthetic: it
        // is created with no balance deduction and zero funding provenance, so
        // there is no stake to consume and nothing for `betPg.settle` to settle
        // against. dualWrite.mirrorBet therefore keeps phantom bets out of
        // Postgres entirely, which is what makes stamping them here a Mongo-side
        // bookkeeping write rather than a lifecycle transition behind the
        // resolver's back.
        await Bet.updateMany(
            { cycleId: cycle.cycleId, isPhantom: true, status: 'PENDING' },
            { $set: { status: 'LOST' } }
        );

        // Calculate final stats. totalPaidOut is NET of the winnings platform
        // fee, so netProfit (realPool − totalPaidOut) already contains the
        // retained fee — it reaches PLATFORM_REVENUE through the existing
        // BET_CYCLE_SETTLED posting with no ledger change. The fee fields
        // below itemize it for audit/reporting.
        // The second place a pool figure becomes money: netProfit is what the
        // BET_CYCLE_SETTLED ledger posting records as platform revenue. Under
        // FLAGS.DERIVED_CYCLE_POOLS the stored fields are a periodic projection,
        // so recompute exactly (no-op with the flag off).
        //
        // Unlike winner determination this does not abort on failure: the
        // payouts above have already been written and the money has moved.
        // Refusing to finish would leave the cycle un-marked and re-run the
        // payout pass. The stored fields are the correct fallback here — they
        // are at worst slightly stale, and the reconciler derives the
        // authoritative ledger entry from the bets regardless.
        const settlePools = await refreshRealPools(cycle.cycleId, { exact: true }).catch((e) => {
            console.error(`[Engine] exact pool refresh failed for ${cycle.cycleId}, using stored:`, e.message);
            return null;
        });
        const realPool = settlePools
            ? settlePools.realDelhi + settlePools.realBombay
            : (cycle.realDelhi || 0) + (cycle.realBombay || 0);
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

        // Close the run in Postgres with the totals that were just written.
        // `updateOne` gives a post hook no document, so this is the only point
        // that can report the finish — and reporting it is what lets
        // findIncompleteSettlements tell a finished payout from a stalled one.
        mirrorCycleSettlement({
            cycleId: cycle.cycleId, winner: cycle.winner,
            isSettled: 'COMPLETED', settledAt: new Date(), totalPaidOut,
        });

        // ── Stragglers: bets Mongo had not heard about when we enumerated ────
        // Every enumeration above reads MongoDB. Under Postgres authority the
        // bet is written to Postgres FIRST and mirrored to Mongo only after
        // that transaction commits — which is after the per-cycle advisory lock
        // has released. So a bet can commit, this pass can take the lock and
        // enumerate, and the mirror can land afterwards: a PENDING bet on a
        // cycle whose settlement is closing, never paid, never lost, never
        // refunded, its stake locked.
        //
        // Run LAST deliberately. Sweeping earlier only moves the window — what
        // makes this sound is that by now every in-flight mirror has completed,
        // so a bet still PENDING in Postgres is genuinely unsettled rather than
        // merely late. Reads the store that OWNS the bets, not the mirror.
        //
        // ACCOUNTING CAVEAT, stated rather than hidden: `totalPaidOut` above is
        // a const derived from a Mongo aggregate that has already run, so a
        // straggler's payout is NOT in the cycle's recorded total. The money is
        // correct — the player is paid — and `reconcileSettlement` compares the
        // run's payout against the bets' own, so the discrepancy is reported
        // rather than silent. Making the total authoritative means deriving it
        // from Postgres too, which is a larger change than this sweep.
        //
        // Guarded as a whole: a failure here must not undo a payout that has
        // already happened. `bb_stalled_settlements` is the backstop either way.
        if (onPg) {
            try {
                const stragglers = await findPendingBetsForCycleOnPostgres(cycle.cycleId);
                for (const row of stragglers) {
                    const won = row.side === cycle.winner;
                    const p = won ? computeWinningsPayout({
                        amount: row.stakePaise / 100,
                        feePercent: winningsFeePercent, multiplier: payoutMultiplier,
                    }) : null;
                    const r = await settleBetOnPostgres({
                        bet: null, pgBetId: row.betId, pgSlices: row.slices,
                        outcome: won ? 'WON' : 'LOST',
                        payoutRupees: p?.payout ?? 0, platformFeeRupees: p?.fee ?? 0,
                        reason: `Cycle ${cycle.cycleId} straggler sweep`,
                    });
                    if (!r.ok) {
                        refusals.push({ betId: row.betId, userId: row.userId, outcome: won ? 'WON' : 'LOST', reason: r.reason });
                    } else if (!r.idempotent) {
                        console.warn(`[Engine] straggler settled on ${cycle.cycleId}: ${row.betId} (${won ? 'WON' : 'LOST'}) — its Mongo mirror had not landed when this pass enumerated`);
                        sendAlert('settlement-straggler',
                            'A bet was settled by the straggler sweep — the Mongo mirror lagged the settlement', {
                                cycleId: cycle.cycleId, betId: row.betId, outcome: won ? 'WON' : 'LOST',
                            });
                    }
                }
            } catch (e) {
                console.error(`[Engine] straggler sweep failed for ${cycle.cycleId}:`, e.message);
                sendAlert('settlement-straggler-sweep', 'The straggler sweep threw; stalled bets may remain', {
                    cycleId: cycle.cycleId, error: e.message,
                });
            }
        }

        // …and close the run for real once Postgres owns the path. Awaited, but
        // a refusal is NOT fatal here, unlike the claim: the money has already
        // moved and the bets are already stamped, so failing the pass now would
        // re-run a payout that is finished. It is logged and paged instead, and
        // findIncompleteSettlements is the query that finds it later.
        const finish = await finishSettlement({ cycleId: cycle.cycleId, payoutRupees: totalPaidOut });
        if (!finish.ok) {
            console.error(`[Engine] Postgres refused to close settlement ${cycle.cycleId}:`, finish.reason);
            sendAlert('settlement-error', 'Postgres refused to close a completed settlement', {
                cycleId: cycle.cycleId, reason: finish.reason,
            });
        }

        await CacheService.del('financial_stats');
        // Drop the freshness memo so a settled cycle can never serve a cached
        // projection to a later reader.
        forgetCycle(cycle.cycleId);

        console.log(`[Engine] ✅ Cycle ${cycle.cycleId} settled successfully`);
        console.log(`   Winners: ${totalWinners} users`);
        console.log(`   Total Paid: ₹${totalPaidOut.toLocaleString()} (2x minus ${winningsFeePercent}% fee)`);
        console.log(`   Platform Fees Retained: ₹${totalPlatformFees.toLocaleString()}`);
        console.log(`   Net Profit: ₹${netProfit.toLocaleString()}`);
        if (realPool > 0) console.log(`   Profit Margin: ${((netProfit / realPool) * 100).toFixed(2)}%`);

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
     * Cleanup on shutdown
     */
    stop() {
        if (this.tickInterval) clearInterval(this.tickInterval);
        if (this.recoveryInterval) clearInterval(this.recoveryInterval);
        console.log('🎮 Game Engine: Stopped');
    }
}

export default GameEngine;
