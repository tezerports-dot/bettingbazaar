// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * gameEngine.js — the settlement engine.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE USED TO DO, AND WHY IT WAS THE LAST THING TO FIX
 * ══════════════════════════════════════════════════════════════════════════
 * It enumerated the bets to settle from the document store and executed their
 * money transitions in PostgreSQL. A money decision read from one store and
 * carried out in another — the one thing the single-store rule forbids
 * outright, and it was here, on the platform's largest money path.
 *
 * The failure that shape invites is not theoretical. If the two stores ever
 * disagreed about which bets on a cycle were still PENDING, this pass would
 * settle the set one store believed in and leave the other's stakes locked,
 * with nothing in either store recording that it had happened.
 *
 * Every read below is now from the rows the pass writes.
 *
 * ── The claim is a COLUMN, not a status flag ───────────────────────────────
 * The old lock was `isSettled: 'PENDING' -> 'PROCESSING'` on the cycle. Three
 * things were wrong with that. It overloaded the settled flag with a lease, so
 * a worker that died left a cycle stuck at PROCESSING forever with no way to
 * tell a live pass from a dead one. It could not be released. And a recovery
 * task had to sweep for the stuck value, which meant the recovery task and the
 * tick could both pick up the same cycle.
 *
 * `claimSettleable` takes a real claim with a LEASE: a worker that dies gives
 * its cycles back when the lease expires, and one query serves both the tick
 * and the recovery sweep because an expired claim is simply claimable again.
 *
 * ── Totals are DERIVED, never accumulated (trap 6) ─────────────────────────
 * A pass resumed after a crash re-processes only the bets still PENDING, so an
 * in-memory accumulator undercounts every bet an earlier pass already paid —
 * and the cycle's recorded payout, which the platform's profit is computed
 * from, is then permanently wrong while the money itself is correct. Nothing
 * afterwards can tell which number lied. `cyclePayoutTotals` sums the rows.
 *
 * ── Order of operations ────────────────────────────────────────────────────
 * Money moves BEFORE the cycle is marked settled, so a failure leaves a cycle
 * that will be picked up and finished rather than one marked done with bets
 * still open. Each bet's transition and its money commit in ONE transaction, so
 * a settled bet with no ledger row is structurally unrepresentable.
 */
import { CacheService } from '../../services/cache.service.js';
import { db } from '#db';
// Risk Platform: payout arithmetic authority — winners are paid gross 2x minus
// the admin-editable winnings platform fee, in integer paise.
import { getRiskRules, computeWinningsPayout } from '../risk/riskValidation.service.js';
import { emitPayoutSuccessBatch } from '../notification/realtimeEmitters.js';
// A settlement failure on a declared cycle pages the admin-configured webhook.
import { sendAlert } from '../../services/alerting.service.js';
import { settlementRuns } from '../../services/metrics.service.js';
// The settlement RUN is a row with a UNIQUE cycle_id, opened before any payout
// and closed after the last one — not a flag that can be written back.
import { beginSettlement, finishSettlement } from '#db/repositories/settlements.js';
// Balances come from the wallet. The accounts table has none.
import { getBalances } from '../wallet/walletAuthority.service.js';

/** How many bets one enumeration pulls at a time. */
const BATCH_SIZE = 500;

/**
 * How long a claimed cycle stays claimed.
 *
 * Long enough that a large settlement finishes inside it, short enough that a
 * worker killed mid-pass does not strand its cycles for an hour. A pass that
 * overruns is not a correctness problem — every transition below is guarded and
 * idempotent, so the second worker advances only what is left.
 */
const SETTLEMENT_LEASE_MINUTES = 15;

class GameEngine {
    constructor(io) {
        this.io = io;
        this.isProcessing = false;
        this.currentCycle = null;
        this.worker = `engine-${process.pid}`;
        this.tickInterval = setInterval(() => this.tick(), 1000);
        // The recovery sweep exists to pick up cycles whose claim lease has
        // expired. It runs on the SAME claim query as the tick, because an
        // expired claim is simply claimable again — there is no second code
        // path that can disagree with the first about what is settleable.
        this.recoveryInterval = setInterval(() => this.payoutRecoveryTask(), 300_000);
    }

    start() {
        console.log('🎮 Game Engine: Payout System Active');
        this.loadCurrentCycle();
    }

    /** The live cycle, with its pools derived from the bets. */
    async loadCurrentCycle() {
        try {
            const [live] = await db.markets.activeCyclesWithPools();
            this.currentCycle = live ?? null;
        } catch (error) {
            console.error('❌ Error loading current cycle:', error);
        }
    }

    /**
     * The game state a client renders.
     *
     * Pools come from `activeCyclesWithPools`, which derives the real halves
     * from the bets and reads only the phantom halves off the cycle row —
     * trap 4. The version this replaced read `realDelhi` and `realBombay` as
     * document fields; they are not columns, so every one of them fell through
     * to its `|| 0` and the admin view of a live cycle showed no real volume at
     * all.
     */
    async getGameState() {
        try {
            await this.loadCurrentCycle();

            if (!this.currentCycle) {
                return {
                    status: 'NO_ACTIVE_CYCLE',
                    message: 'No active betting cycle available',
                    timestamp: new Date(),
                };
            }

            const c = this.currentCycle;
            const endMs = new Date(c.endTime).getTime();

            return {
                cycleId: c.cycleId,
                status: c.status,
                startTime: c.startTime,
                endTime: c.endTime,
                timeRemaining: Math.max(0, Math.floor((endMs - Date.now()) / 1000)),
                // Display pools include phantom, so the client sees the balanced view.
                delhiPool:  c.totalDelhi,
                bombayPool: c.totalBombay,
                totalPool:  c.totalDelhi + c.totalBombay,
                // Admin fields — real only.
                realDelhiPool:  c.realDelhi,
                realBombayPool: c.realBombay,
                winner: c.winner,
                isSettled: c.isSettled,
                timestamp: new Date(),
            };
        } catch (error) {
            console.error('❌ Error getting game state:', error);
            return {
                status: 'ERROR',
                message: 'Failed to retrieve game state',
                error: error.message,
                timestamp: new Date(),
            };
        }
    }

    /**
     * Pick up cycles whose claim lease expired — a worker that died mid-pass.
     *
     * Same claim query as the tick. A pass that was interrupted left its
     * already-settled bets settled, so this finishes what is left rather than
     * re-paying anything.
     */
    async payoutRecoveryTask() {
        try {
            const stranded = await db.markets.claimSettleable({
                limit: 5, worker: `${this.worker}-recovery`,
                leaseMinutes: SETTLEMENT_LEASE_MINUTES,
            });
            for (const cycle of stranded) {
                console.warn(`[Recovery] Resuming interrupted payout for cycle: ${cycle.cycleId}`);
                await this.settleCycle(cycle);
            }
        } catch (e) {
            console.error('[Recovery] sweep failed:', e.message);
        }
    }

    async tick() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            // The claim IS the query: `claimSettleable` returns only cycles with
            // a winner, not yet settled, past their end, and unclaimed. Rule 3 —
            // a cycle with no result must never be offered for settlement,
            // whatever its status column says.
            const [cycle] = await db.markets.claimSettleable({
                limit: 1, worker: this.worker, leaseMinutes: SETTLEMENT_LEASE_MINUTES,
            });
            if (!cycle) return;

            await this.settleCycle(cycle);
            await this.loadCurrentCycle();
            settlementRuns.inc({ outcome: 'success' });
        } catch (e) {
            console.error('GameEngine Tick Error:', e);
            settlementRuns.inc({ outcome: 'error' });
            sendAlert('settlement-error', 'Cycle settlement tick failed', { error: e.message });
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Settle one claimed cycle.
     *
     * The caller has already claimed it. Every step below is guarded and
     * idempotent, so a pass that dies partway can be resumed by the next worker
     * to take the lease.
     */
    async settleCycle(cycle) {
        // Open the settlement RUN. AWAITED — a run that failed to open must not
        // go on to pay anybody. `resumed` is NOT a refusal: an interrupted
        // payout is re-admitted on purpose, and treating a resume as a stop
        // would strand exactly the cycles that most need finishing.
        const claim = await beginSettlement({
            cycleId: cycle.cycleId, winningSide: cycle.winner,
        });
        if (!claim.ok) {
            console.error(`[Engine] settlement claim refused for ${cycle.cycleId}:`, claim.reason);
            sendAlert('settlement-error', 'Settlement claim refused', {
                cycleId: cycle.cycleId, reason: claim.reason,
            });
            // Hand the cycle back rather than sitting on a lease we cannot use.
            await db.markets.releaseSettlementClaim(cycle.cycleId);
            return;
        }

        console.log(`[Engine] Starting payout for cycle ${cycle.cycleId}, Winner: ${cycle.winner}`);

        // Read ONCE per settlement, so every bet in this cycle settles under the
        // same fee and multiplier. Reading per bet would let an admin editing
        // the rate mid-pass pay two winners on the same cycle differently.
        const { winningsFeePercent, payoutMultiplier } = await getRiskRules();

        // Every bet this pass could not settle, with the reason. Reported, never
        // swallowed — a refused bet still has its stake locked, and a pass that
        // returned quietly would leave that for someone to find by hand.
        const refusals = [];
        const winnerPayouts = [];
        const betsPerWinner = new Map();

        try {
            await this.settleLosingBets(cycle, refusals);
            await this.settleWinningBets(cycle, {
                winningsFeePercent, payoutMultiplier, refusals, winnerPayouts, betsPerWinner,
            });
        } catch (e) {
            // The money that moved is real and the bets that settled are
            // settled. Release the claim so the next pass picks the cycle up
            // rather than waiting out the lease, and do NOT mark it settled.
            console.error(`[Engine] settlement of ${cycle.cycleId} failed partway:`, e.message);
            sendAlert('settlement-error', 'Settlement failed partway — cycle left unsettled', {
                cycleId: cycle.cycleId, error: e.message,
            });
            await db.markets.releaseSettlementClaim(cycle.cycleId);
            throw e;
        }

        // ── REFUSALS ────────────────────────────────────────────────────────
        // A refused bet is one the store would not transition — no recorded
        // funding split, slices that do not sum to the stake, a status that is
        // no longer PENDING. Its stake is still locked.
        //
        // The pass CONTINUES rather than aborting: the bets that did settle are
        // settled, and every transition is guarded, so a re-run advances only
        // what is left. Failing the whole cycle would strand the bets that
        // succeeded alongside the one that did not.
        if (refusals.length > 0) {
            console.error(`[Engine] ${refusals.length} bet settlement(s) refused on ${cycle.cycleId}:`,
                refusals.slice(0, 10));
            sendAlert('settlement-error', 'Bet settlements refused — stakes remain locked', {
                cycleId: cycle.cycleId, refused: refusals.length, sample: refusals.slice(0, 10),
            });
        }

        // Phantom bets never win and move no money. One UPDATE, so the history
        // does not leave synthetic bets at PENDING forever.
        await db.bets.closePhantomBets(cycle.cycleId);

        // ── TOTALS, FROM THE ROWS ───────────────────────────────────────────
        // Not from this pass's accumulators. See the header — a resumed pass
        // would undercount every bet an earlier pass paid.
        const totals = await db.bets.cyclePayoutTotals(cycle.cycleId);
        const totalPaidOut = totals.paidOutPaise / 100;
        const totalPlatformFees = totals.platformFeesPaise / 100;

        await this.notifyWinners(cycle, winnerPayouts, betsPerWinner, refusals);

        // The real pool is derived from the bets, never read off the cycle row —
        // trap 4. netProfit is what the BET_CYCLE_SETTLED ledger posting records
        // as platform revenue, and totalPaidOut is NET of the winnings fee, so
        // the retained fee is already inside it.
        const pools = await db.markets.realPools(cycle.cycleId);
        const realPool = pools.realDelhi + pools.realBombay;
        const netProfit = realPool - totalPaidOut;

        // MONEY FIRST, THEN THE STATUS. Everything above has already moved
        // money; this only records what happened. A failure here leaves a cycle
        // that gets picked up and finished, which is the safe direction.
        const settled = await db.markets.markSettled(cycle.cycleId, {
            paidOutRupees: totalPaidOut,
            netProfitRupees: netProfit,
            platformFeesRupees: totalPlatformFees,
            feePercentUsed: winningsFeePercent,
        });
        if (!settled.ok) {
            // Another pass finished it first. Not an error — the guard is in the
            // UPDATE's WHERE clause and exactly one pass wins.
            console.warn(`[Engine] ${cycle.cycleId} was already settled:`, settled.reason);
        }

        // Close the run. A refusal here is NOT fatal, unlike the claim: the money
        // has moved and the bets are stamped, so failing now would re-run a
        // finished payout. It is logged and paged; findIncompleteSettlements is
        // the query that finds it later.
        const finish = await finishSettlement({ cycleId: cycle.cycleId });
        if (!finish.ok) {
            console.error(`[Engine] refused to close settlement ${cycle.cycleId}:`, finish.reason);
            sendAlert('settlement-error', 'Refused to close a completed settlement', {
                cycleId: cycle.cycleId, reason: finish.reason,
            });
        }

        // A settled cycle with bets still PENDING is a stake locked with nothing
        // coming to release it — the exact condition findIncompleteSettlements
        // exists to surface. Reported here too, so it is seen in the same pass
        // rather than at the next sweep.
        if (totals.stillPending > 0) {
            sendAlert('settlement-error', 'Cycle settled with bets still pending', {
                cycleId: cycle.cycleId, stillPending: totals.stillPending,
            });
        }

        await CacheService.del('financial_stats');

        console.log(`[Engine] ✅ Cycle ${cycle.cycleId} settled`);
        console.log(`   Winners: ${totals.winners} users across ${totals.wonBets} bets`);
        console.log(`   Total Paid: ₹${totalPaidOut.toLocaleString()} (${payoutMultiplier}x minus ${winningsFeePercent}% fee)`);
        console.log(`   Platform Fees Retained: ₹${totalPlatformFees.toLocaleString()}`);
        console.log(`   Net Profit: ₹${netProfit.toLocaleString()}`);
        if (realPool > 0) console.log(`   Profit Margin: ${((netProfit / realPool) * 100).toFixed(2)}%`);

        this.io?.emit('payout_complete', {
            cycleId: cycle.cycleId, winner: cycle.winner,
            totalPaidOut, netProfit, winners: totals.winners,
        });

        this.io?.to('admin-room').emit('admin_stats_update', {
            type: 'PAYOUT_COMPLETE',
            cycleId: cycle.cycleId,
            totalPaidOut, totalPlatformFees, netProfit,
            winners: totals.winners,
            server_ts: Date.now(),
        });
    }

    /**
     * The losing side: each stake is consumed and the bet stamped, in ONE
     * transaction per bet.
     *
     * Paged by row id rather than pulled in full, so a cycle with a hundred
     * thousand bets does not need all of them in memory at once. Each page is
     * re-read AFTER the previous one settled, so bets an earlier pass already
     * handled simply are not in the next page.
     */
    async settleLosingBets(cycle, refusals) {
        for (;;) {
            const batch = await db.bets.listSettleableBets(cycle.cycleId, {
                side: 'LOSING', limit: BATCH_SIZE,
            });
            if (!batch.length) return;

            let settledAny = false;
            for (const bet of batch) {
                const r = await db.bets.loseBet({
                    betId: bet.betId, userId: bet.userId, slices: bet.slices,
                    actor: 'settlement', reason: 'Lost bet — cycle result',
                }).catch((e) => ({ ok: false, reason: e.message }));

                if (r.ok) { settledAny = true; continue; }
                refusals.push({ betId: bet.betId, userId: bet.userId, outcome: 'LOST', reason: r.reason });
            }

            // Nothing in this page moved, so the next read returns the same page.
            // Stopping is what turns a refused batch into a reported failure
            // instead of an infinite loop holding the lease open.
            if (!settledAny) return;
        }
    }

    /**
     * The winning side: stake consumed and payout credited, in ONE transaction
     * per bet, under one wallet lock.
     *
     * ── Per bet, not per user ──────────────────────────────────────────────
     * The payout is computed per BET because the fee is, and because a settled
     * bet with no ledger row has to be structurally unrepresentable. Grouping by
     * user and paying a summed amount would make one refused bet inside a group
     * either block the whole group or silently pay for bets that were refused.
     */
    async settleWinningBets(cycle, ctx) {
        const { winningsFeePercent, payoutMultiplier, refusals, winnerPayouts, betsPerWinner } = ctx;
        const paidPerUser = new Map();

        for (;;) {
            const batch = await db.bets.listSettleableBets(cycle.cycleId, {
                side: 'WINNING', limit: BATCH_SIZE,
            });
            if (!batch.length) break;

            let settledAny = false;
            for (const bet of batch) {
                // `computeWinningsPayout` returns { gross, fee, net, … } and has
                // NO `payout` key. Reading `p.payout ?? 0` pays ZERO while still
                // charging the fee — trap 1. It is `net`.
                const p = computeWinningsPayout({
                    amount: bet.stakePaise / 100,
                    feePercent: winningsFeePercent,
                    multiplier: payoutMultiplier,
                });

                const r = await db.bets.winBet({
                    betId: bet.betId, userId: bet.userId, slices: bet.slices,
                    payoutPaise: p.netMinor, platformFeePaise: p.feeMinor,
                    actor: 'settlement',
                    reason: winningsFeePercent > 0
                        ? `Cycle win payout (${payoutMultiplier}x minus ${winningsFeePercent}% platform fee)`
                        : `Cycle win payout (${payoutMultiplier}x)`,
                }).catch((e) => ({ ok: false, reason: e.message }));

                if (!r.ok) {
                    refusals.push({ betId: bet.betId, userId: bet.userId, outcome: 'WON', reason: r.reason });
                    continue;
                }
                settledAny = true;

                // Accumulated ONLY for the realtime notification, which is about
                // what this pass paid. The cycle's recorded totals come from the
                // rows — see the header.
                const before = paidPerUser.get(bet.userId) ?? { payoutPaise: 0, stakePaise: 0 };
                paidPerUser.set(bet.userId, {
                    payoutPaise: before.payoutPaise + p.netMinor,
                    stakePaise: before.stakePaise + bet.stakePaise,
                });
                betsPerWinner.set(bet.userId, (betsPerWinner.get(bet.userId) ?? 0) + 1);
            }

            if (!settledAny) break;
        }

        for (const [userId, sums] of paidPerUser) {
            winnerPayouts.push({
                userId,
                payout: sums.payoutPaise / 100,
                betAmount: sums.stakePaise / 100,
            });
        }
    }

    /**
     * Tell each winner, with the balance they actually have now.
     *
     * Balances are read from the WALLET, one per winner. The accounts table has
     * no balance columns — reading them there returns undefined for every winner
     * and pushes ZERO to a player who has just been paid, which is the single
     * worst moment to show a wrong number.
     *
     * A user whose EVERY winning bet was refused is dropped: telling somebody
     * they were paid when the transition was refused is worse than telling them
     * nothing. Partially-refused users keep their event, because the embedded
     * balance is read fresh and is therefore true.
     */
    async notifyWinners(cycle, winnerPayouts, betsPerWinner, refusals) {
        if (!winnerPayouts.length || !this.io) return;

        const refusedByUser = refusals.reduce(
            (m, r) => m.set(r.userId, (m.get(r.userId) ?? 0) + 1), new Map(),
        );
        const paidWinners = refusedByUser.size === 0 ? winnerPayouts : winnerPayouts.filter(
            (w) => (betsPerWinner.get(w.userId) ?? 0) > (refusedByUser.get(w.userId) ?? 0),
        );
        if (!paidWinners.length) return;

        try {
            const balanceMap = {};
            for (const uid of new Set(paidWinners.map((w) => String(w.userId)))) {
                balanceMap[uid] = await getBalances(uid);
            }

            // Chunked and yielding, so a very large settlement does not
            // monopolise the event loop while still sending per-user updates.
            await emitPayoutSuccessBatch({
                io: this.io,
                payouts: paidWinners,
                balanceMap,
                cycleId: cycle.cycleId,
                winner: cycle.winner,
                batchSize: BATCH_SIZE,
            });
        } catch (emitErr) {
            // Non-critical — the payouts are already written.
            console.warn('[Engine] payout_success emit error:', emitErr.message);
        }
    }

    stop() {
        if (this.tickInterval) clearInterval(this.tickInterval);
        if (this.recoveryInterval) clearInterval(this.recoveryInterval);
        console.log('🎮 Game Engine: Stopped');
    }
}

export default GameEngine;
