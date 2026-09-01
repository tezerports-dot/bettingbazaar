// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { CacheService } from '../../services/cache.service.js';
import { emitPayoutSuccessBatch } from '../notification/realtimeEmitters.js';
// Risk Platform (Phase A, 2026-07-10): payout arithmetic authority — winners
// are paid gross 2x minus the admin-editable winnings platform fee.
import { getRiskRules, computeWinningsPayout } from '../risk/riskValidation.service.js';
// Items 33/38 (2026-07-13): settlement outcomes feed /metrics; a settlement
// failure on a declared cycle pages the admin-configured alert webhook.
import { sendAlert } from '../../services/alerting.service.js';
import { settlementRuns } from '../../services/metrics.service.js';
// The per-cycle freshness memo, dropped when a cycle finishes so a settled
// cycle can never serve a cached projection.
import { forgetCycle } from './cyclePool.service.js';
// The settlement RUN is a Postgres row: `cycle_settlements.cycle_id` is UNIQUE,
// so "settle this cycle twice" is structurally impossible rather than guarded by
// a flag that can be written back to PENDING.
import { beginSettlement, finishSettlement, readSettlement } from '../../postgres/settlementPgAuthority.js';
import { SETTLEMENT_STATUS } from '../../postgres/settlementPg.js';
// The three questions this engine used to ask MongoDB.
import {
  findCurrentCycle, findCyclesAwaitingSettlement, findResumableSettlements,
  derivePoolsForCycle, setStatus, CYCLE_STATUS,
} from '../../postgres/cyclePg.js';
import { getBalancesPaise } from '../../postgres/walletPg.js';
// The bet lifecycle. Placement and settlement both live in Postgres now, so the
// whole lifecycle is one store's to describe.
import { settleBetOnPostgres, findPendingBetsForCycleOnPostgres, derivePayoutTotalsOnPostgres } from '../../postgres/betPgAuthority.js';


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
            this.currentCycle = await findCurrentCycle();
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

            const c = this.currentCycle;
            const timeRemaining = Math.max(0, Math.floor((c.endTime - Date.now()) / 1000));

            // Pools are DERIVED from the bets rather than read off the cycle.
            // Storing the real pools on the cycle row is not an option: a bet
            // holds that row's SHARED lock while it commits, so a bet that also
            // UPDATEd the row would deadlock against a second bet doing the
            // same (40P01, reproduced). Phantom is stored, because nothing
            // races to write it.
            const pools = await derivePoolsForCycle(c.cycleId);

            // "Is it settled?" is now the settlement RUN's status, not a flag on
            // the cycle. No run at all means nobody has claimed it — which is
            // what PENDING used to mean, except it cannot be forgotten or
            // written back.
            const run = await readSettlement(c.cycleId);
            const isSettled = run?.status === SETTLEMENT_STATUS.COMPLETED ? 'COMPLETED'
                : run?.status === SETTLEMENT_STATUS.RUNNING ? 'PROCESSING'
                : 'PENDING';

            return {
                cycleId: c.cycleId,
                status: c.status,
                startTime: c.startTime,
                endTime: c.endTime,
                timeRemaining,
                // Display pools include phantom (so UI sees balanced view)
                delhiPool:  pools.totalDelhiPaise  / 100,
                bombayPool: pools.totalBombayPaise / 100,
                totalPool:  pools.totalPoolPaise   / 100,
                // Admin fields — real only. Never in a public payload: showing
                // these lets a player infer the phantom side by subtraction.
                realDelhiPool:  pools.realDelhiPaise  / 100,
                realBombayPool: pools.realBombayPaise / 100,
                winner:    c.winner ?? null,
                result:    c.winner ?? null,
                isSettled,
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
        // Runs whose claim exists and whose close never landed — a server that
        // died mid-payout. Each carries the side the FIRST pass recorded, not
        // the cycle's current winner, so a result corrected mid-settlement
        // cannot make the resume pay the rest of the bets the other way.
        const stuckCycles = await findResumableSettlements();
        for (const cycle of stuckCycles) {
            console.warn(`[Recovery] Resuming interrupted payout for cycle: ${cycle.cycleId}`);
            await this.processPayoutsOptimized(cycle);
        }
    }

    async tick() {
        if (this.isProcessing) return; 
        this.isProcessing = true;

        try {
            // Declared, and unclaimed — oldest first, so a cycle that failed to
            // settle is retried rather than passed over while newer ones arrive.
            const cyclesToSettle = await findCyclesAwaitingSettlement({ limit: 1 });
            
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
     * Settle a cycle, entirely in PostgreSQL.
     *
     * One enumeration, one transition per bet. `betPg.settle` moves the stake,
     * writes the ledger rows and stamps the status inside ONE transaction under
     * one wallet lock, so a settled bet with no ledger row behind it is not a
     * thing that can be represented.
     */
    async processPayoutsOptimized(cycle) {
        const BATCH_SIZE = 500;

        // ── THE CLAIM IS THE LOCK ─────────────────────────────────────────────
        // `openSettlement` inserts into cycle_settlements (cycle_id UNIQUE) and
        // takes the cycle row's EXCLUSIVE lock in the SAME statement, via a CTE.
        // That does everything the old Mongo findOneAndUpdate lock did, plus two
        // things a flag could not: a bet holds this row's SHARED lock while it
        // commits, so opening the run waits for every bet already in flight and
        // refuses every one that arrives after; and `winning_side` is written
        // once, so a resume settles against the result the first pass paid on.
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
        // `resumed` is NOT a refusal — payoutRecoveryTask re-admits a RUNNING
        // cycle on purpose, and backing off would strand exactly the cycles that
        // need finishing. A COMPLETED run is different: the money has moved.
        if (claim.settlement?.status === SETTLEMENT_STATUS.COMPLETED) {
            console.log(`[Engine] Cycle ${cycle.cycleId} is already settled`);
            return;
        }

        // The side the RUN recorded. Not `cycle.winner`, which an admin may have
        // corrected since the first pass started.
        const winningSide = claim.settlement?.winningSide ?? cycle.winner;
        console.log(`[Engine] Starting payout for cycle ${cycle.cycleId}, Winner: ${winningSide}`);

        // Winnings platform fee + payout multiplier, read ONCE per settlement so
        // every bet in this cycle settles under the same snapshot.
        const { winningsFeePercent, payoutMultiplier } = await getRiskRules();

        // Every bet this pass could not settle, with the reason. Reported, never
        // swallowed — a refused bet still has its stake locked, and a pass that
        // returned quietly would leave that for someone to find by hand later.
        const refusals = [];
        // Winner → what this pass paid them, for the realtime emit.
        const winnerPayouts = new Map();
        const betsPerWinner = new Map();

        // ── ONE ENUMERATION, FROM THE STORE THAT OWNS THE BETS ────────────────
        // This used to be three reads of MongoDB: the losing bets, an aggregate
        // over the winning bets, and a straggler sweep over Postgres to catch
        // the bets whose Mongo mirror had not landed yet. The straggler sweep
        // existed ONLY because the first two read the other store. Reading
        // Postgres once removes the lag, and the sweep with it.
        //
        // The bet set is frozen from the claim onward: `placeBet` takes the same
        // cycle row's shared lock and refuses with `cycle_settling`, so nothing
        // can commit onto this cycle while the enumeration runs.
        const pending = await findPendingBetsForCycleOnPostgres(cycle.cycleId, { limit: 5000 });

        for (const row of pending) {
            const won = row.side === winningSide;
            // `computeWinningsPayout` returns { gross, fee, net, … } — `net` is
            // the payout. It has no `payout` key, and reading one here used to
            // send `undefined ?? 0` down as the amount: a straggler-swept winner
            // was stamped WON, charged the fee, and paid NOTHING.
            const p = won ? computeWinningsPayout({
                amount: row.stakePaise / 100,
                feePercent: winningsFeePercent, multiplier: payoutMultiplier,
            }) : null;

            const r = await settleBetOnPostgres({
                bet: null, pgBetId: row.betId, pgSlices: row.slices,
                outcome: won ? 'WON' : 'LOST',
                payoutRupees: p?.net ?? 0, platformFeeRupees: p?.fee ?? 0,
                reason: won
                    ? (winningsFeePercent > 0
                        ? `Cycle win payout (2x minus ${winningsFeePercent}% platform fee)`
                        : 'Cycle win payout (2x)')
                    : 'Lost bet unlock — cycle result',
            });

            if (!r.ok) {
                refusals.push({
                    betId: row.betId, userId: String(row.userId),
                    outcome: won ? 'WON' : 'LOST', reason: r.reason,
                });
                continue;
            }
            if (!won) continue;

            const userId = String(row.userId);
            const acc = winnerPayouts.get(userId) || { userId, payout: 0, betAmount: 0 };
            acc.payout    += p.net;
            acc.betAmount += row.stakePaise / 100;
            winnerPayouts.set(userId, acc);
            betsPerWinner.set(userId, (betsPerWinner.get(userId) || 0) + 1);
        }

        // ── REFUSALS ──────────────────────────────────────────────────────────
        // A refused bet is one Postgres would not transition — slices that do not
        // sum to the stake, a status that is no longer PENDING. Its stake is
        // still locked.
        //
        // The pass CONTINUES rather than aborting: the bets that did settle are
        // settled, the money that moved is real, and every transition here is
        // guarded and idempotent, so a re-run advances only what is left.
        // Failing the whole cycle would strand the bets that succeeded alongside
        // the one that did not. What must not happen is that it goes unreported,
        // and there are two independent detectors: this alert, and
        // findIncompleteSettlements — the query for "a COMPLETED run with bets
        // still PENDING", i.e. a stake locked with nothing coming to release it.
        if (refusals.length > 0) {
            console.error(`[Engine] Postgres refused ${refusals.length} bet settlement(s) on ${cycle.cycleId}:`,
                refusals.slice(0, 10));
            sendAlert('settlement-error', 'Postgres refused bet settlements — stakes remain locked', {
                cycleId: cycle.cycleId, refused: refusals.length, sample: refusals.slice(0, 10),
            });
        }

        // Cycle totals are DERIVED from the stamped WON bets, never from this
        // pass's accumulators: a resume after a mid-batch crash only re-processes
        // still-PENDING bets, so an accumulator would undercount by everything
        // the previous pass already paid. The table sees every bet paid across
        // every pass, so running it twice answers the same.
        const totals = await derivePayoutTotalsOnPostgres(cycle.cycleId);
        const totalPaidOut      = totals?.paidRupees ?? 0;
        const totalPlatformFees = totals?.feeRupees  ?? 0;
        const totalWinners      = totals?.winners    ?? 0;

        // ── REALTIME PAYOUT NOTIFICATION ──────────────────────────────────────
        // Balances are read fresh so the frontend gets exact new values without
        // polling. A user whose EVERY bet was refused is dropped: telling someone
        // they were paid when the transition was refused is worse than telling
        // them nothing. Partially-refused users keep their event, because the
        // embedded balances are what they actually have.
        const refusedByUser = refusals.reduce((m, r) => m.set(r.userId, (m.get(r.userId) || 0) + 1), new Map());
        const paidWinners = [...winnerPayouts.values()].filter((w) => {
            const settledForUser = betsPerWinner.get(w.userId) || 0;
            return settledForUser > (refusedByUser.get(w.userId) || 0);
        });

        if (paidWinners.length > 0 && this.io) {
            try {
                const balanceMap = {};
                for (const w of paidWinners) {
                    const b = await getBalancesPaise(w.userId);
                    balanceMap[w.userId] = {
                        winningsBalance: b.winningsBalance / 100,
                        depositBalance:  b.depositBalance  / 100,
                        lockedBalance:   b.lockedBalance   / 100,
                    };
                }
                await emitPayoutSuccessBatch({
                    io: this.io,
                    payouts: paidWinners,
                    balanceMap,
                    cycleId: cycle.cycleId,
                    winner: winningSide,
                    batchSize: BATCH_SIZE,
                });
            } catch (emitErr) {
                // Non-critical — payouts were already written to the database.
                console.warn('[Engine] payout_success emit error:', emitErr.message);
            }
        }

        // The real pool, summed from the bets. netProfit is what the
        // BET_CYCLE_SETTLED ledger posting records as platform revenue, and
        // totalPaidOut is NET of the winnings fee, so netProfit already contains
        // the retained fee; totalPlatformFees itemizes it for audit.
        const pools = await derivePoolsForCycle(cycle.cycleId);
        const realPool  = (pools.realDelhiPaise + pools.realBombayPaise) / 100;
        const netProfit = realPool - totalPaidOut;

        // Close the run with the totals this cycle actually paid. Awaited, but a
        // refusal is NOT fatal — unlike the claim: the money has moved and the
        // bets are stamped, so failing now would re-run a finished payout. It is
        // logged and paged instead, and findIncompleteSettlements finds it later.
        // The fee and net-profit figures are RECONSTRUCTED from the bets inside
        // completeSettlement, not passed in — an accumulator would report only
        // what the final pass paid on a run that resumed after a crash.
        const finish = await finishSettlement({ cycleId: cycle.cycleId, payoutRupees: totalPaidOut });
        if (!finish.ok) {
            console.error(`[Engine] Postgres refused to close settlement ${cycle.cycleId}:`, finish.reason);
            sendAlert('settlement-error', 'Postgres refused to close a completed settlement', {
                cycleId: cycle.cycleId, reason: finish.reason,
            });
        }

        // The cycle itself is done. Guarded on RESULT_DECLARED so a cycle that
        // was cancelled or already archived is not dragged back to COMPLETED.
        await setStatus({
            cycleId: cycle.cycleId,
            to: CYCLE_STATUS.COMPLETED,
            from: [CYCLE_STATUS.RESULT_DECLARED, CYCLE_STATUS.CLOSED],
        });

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

        this.io?.emit('payout_complete', {
            cycleId: cycle.cycleId, winner: winningSide,
            totalPaidOut, netProfit, winners: totalWinners,
        });

        // REALTIME: push the financial delta to the admin dashboard.
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
