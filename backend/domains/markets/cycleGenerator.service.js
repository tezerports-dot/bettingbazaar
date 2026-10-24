// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { randomInt } from 'node:crypto';
import { db } from '#db';
import { fetchCycleHistory } from './cycleHistory.service.js';
// Derived cycle pools (FLAGS.DERIVED_CYCLE_POOLS, default off) — see
// cyclePool.service.js for why the running total is the scaling ceiling.
import { computeRealPools } from './cyclePool.service.js';
// Public cycle payloads must never carry real/phantom pools (they reveal the
// minority-side winner). assertPublicCycleSafe throws if one slips in.
import { assertPublicCycleSafe, publicCyclePools, poolsHidden } from './cyclePublicView.js';
import { cycleSnapshotPublisher } from './cycleSnapshotPublisher.js';
// Auto phantom bets (owner, 2026-10-15): one bet a second per plan, until the equalizer.
import { secondsToPlace, firstSecond, sizeAtSecond } from './phantomBets.js';
// The boards (one row each, admin-created): timer, phases, labels. See
// cycleTypes.js; every board's timing is read from its row.
import { allBoards, enabledBoards, boardOf, cycleLabel, boardMessages } from './cycleTypes.js';
import { AUDIENCES } from '#db/repositories/markets.js';
import { emitToStaff } from '../notification/staffEventAreas.js';
import { emitCyclePhase, emitCycleResult } from '../notification/realtimeEmitters.js';
import { announceRoundResults } from './roundResult.service.js';
import { recordRealtimeEvent } from '../../services/metrics.service.js';
import { planHouseBet } from './rtpHouseBet.js';
import { getRiskRules, multiplierFor } from '../risk/riskValidation.service.js';
import { sendAlert } from '../../services/alerting.service.js';
import { placePlayerBet, announcePlacedBet } from './playerBet.service.js';
import { stopBefore, stopForRefusal, autoBetId, AUTO_STOP_TEXT } from './autoBets.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { notify } from '../communication/communication.service.js';
import { holdLeadership, release as releaseLease } from '../../startup/cronLock.js';

/** A tick of the cycle manager running this long means every board has stopped (it runs every second). */
const TICK_STALL_MS = 20_000;
/**
 * A tick still running this long is left behind and a fresh one starts
 * (owner, 2026-10-24: "the users' timers never get stuck"). Every write a tick
 * makes is guarded in its own statement (a phase only from the statuses it
 * may leave, the winner only while none is set, a round only once per block,
 * phantom bets keyed by their second), so a late tick finishing beside a new
 * one changes nothing twice. Waiting on it for ever froze every board at 00:00
 * with no way back but a restart.
 */
export const TICK_ABANDON_MS = 30_000;

/**
 * ONE scheduler manages the rounds at a time; a second one stands by
 * (deploy/vps/docker-compose.prod.yml `scheduler-standby`). The round manager
 * keeps per-round state in memory (the live-cycle cache, the celebration lock,
 * the auto bets tried), so two running side by side is not what its guarded
 * writes are for — they make a LATE tick harmless, not a second manager.
 *
 * The active one renews a lease in `cron_locks` every LEADER_RENEW_MS; a
 * standby is refused until that lease lapses (LEADER_LEASE_MS after the last
 * renewal: a crash, a frozen process, a lost database), then takes over.
 * A leader stops ticking LEADER_SAFETY_MS before its own lease could have
 * lapsed, timed from when it ASKED for the renewal on its own clock, so it has
 * always stopped before a standby can start. A graceful stop (a deploy)
 * releases the lease at once, so the standby takes over within one renewal.
 */
export const CYCLE_MANAGER_LEASE = 'cycle-manager';
export const LEADER_LEASE_MS = 15_000;
export const LEADER_RENEW_MS = 3_000;
export const LEADER_SAFETY_MS = 5_000;

/**
 * Each board runs one cycle per slot for each audience (VIP, GENERAL), and the
 * two never share one (owner, 2026-10-08). Everything the generator keeps per
 * board — the broadcast cache, the celebration lock — is keyed by both.
 */
const slotKey = (type, audience) => `${type}:${audience}`;
const slotOf = (cycle) => slotKey(cycle.type, cycle.audience);
/** VIP ids keep their historical shape; GENERAL's carry a G so the two never collide. */
const idFor = (prefix, audience) => `${prefix}_${audience === 'GENERAL' ? 'G_' : ''}${Date.now()}`;

class CycleGenerator {
    constructor(io, sseManager) {
        this.io = io;
        this.sseManager = sseManager;  // SSE broadcast manager for public events
        this.initialized = false;
        this.IST_OFFSET = 5.5 * 60 * 60 * 1000;
        this.lastBroadcast = {};
        // Celebration lock: don't create a board's next cycle until this
        // timestamp passes; set when a cycle completes, per board and audience.
        // An absent key is unlocked, so a board created at runtime needs no entry.
        this.celebrationLockUntil = {};
        // In-memory cache of active cycles — updated by manageCycles() every 1s,
        // read by broadcastLiveUpdates() in the same tick with zero DB hits.
        this.liveCycleCache = {};  // { [type:audience]: cycleDoc } — see slotKey
        // Player auto bets already tried on a round (`planId:cycleId`), so a
        // tick does not ask again. Only a saving: the bet's id is keyed by
        // plan and round, so a forgotten entry still places nothing twice.
        this.autoBetsTried = new Set();
        // Leadership is elected only by start(). A generator that is never
        // started (a test driving tick()) leads, exactly as before.
        this.isLeader = true;
        this.leaseUntil = Infinity;
        this.needsInit = false;
        this.renewing = false;
        // Who holds the lease: this process unless a test names one.
        this.leaseHolder = undefined;
    }

    start() {
        console.log('🔄 Cycle Generator: Starting...');

        this.isRunning     = false;
        this.tickStartedAt = 0;
        this.stallReported = false;
        this.tickSeq       = 0;   // the tick that owns `isRunning`; a tick left behind never clears it

        // Nothing is read or written until this process LEADS: the start-up
        // pass (`initializeCycles`) is the first tick it runs as leader, so a
        // standby that takes over starts exactly as a fresh process would. A
        // start-up pass that never answers is a stuck tick, and the tick's own
        // bound leaves it behind (TICK_ABANDON_MS).
        this.isInitialized = true;
        this.isLeader      = false;
        this.leaseUntil    = 0;
        this.needsInit     = false;
        this.leaderTimer = setInterval(() => { void this.renewLeadership(); }, LEADER_RENEW_MS);
        void this.renewLeadership();

        // ── CYCLE MANAGER (1 000 ms) ────────────────────────────────────────
        // Handles phase transitions, phantom equalizer, new-cycle creation.
        // No separate broadcast loop needed — all public state is pushed via
        // event-driven SSE: cycle_snapshot (connect), cycle_phase (transitions),
        // bet_placed (pools), new_cycle + cycle_result (lifecycle).
        // Timer is derived client-side from endTime, zero server push required.
        this.tickTimer = setInterval(() => { void this.tick(); }, 1000);

        console.log('✅ Cycle Generator: Intervals started (waiting for the round-manager lease...)');
    }

    /**
     * Take or keep the round-manager lease. One renewal at a time: a renewal
     * that is slow to answer is simply late, and the leader stops ticking
     * on its own once `leaseUntil` passes.
     */
    async renewLeadership() {
        if (this.renewing) return;
        this.renewing = true;
        const askedAt = Date.now();
        try {
            const leads = await holdLeadership(CYCLE_MANAGER_LEASE, LEADER_LEASE_MS, this.leaseHolder);
            if (leads) {
                this.leaseUntil = askedAt + LEADER_LEASE_MS - LEADER_SAFETY_MS;
                if (!this.isLeader) {
                    console.log('👑 CycleGenerator: this scheduler now manages the rounds');
                    this.needsInit = true;
                    this.isLeader = true;
                }
            } else if (this.isLeader) {
                console.warn('⏸️ CycleGenerator: another scheduler manages the rounds; standing by');
                this.isLeader = false;
            }
        } finally {
            this.renewing = false;
        }
    }

    /** Does this process manage the rounds right now? */
    leads() {
        return this.isLeader && Date.now() < this.leaseUntil;
    }

    /**
     * Stop managing rounds (shutdown). The lease is given back at once, so a
     * standby takes over within one renewal instead of waiting it out.
     */
    stop() {
        if (this.tickTimer) clearInterval(this.tickTimer);
        if (this.leaderTimer) clearInterval(this.leaderTimer);
        const wasLeader = this.isLeader;
        this.isLeader = false;
        this.leaseUntil = 0;
        if (wasLeader) void releaseLease(CYCLE_MANAGER_LEASE, this.leaseHolder);
        console.log('🔄 Cycle Generator: Stopped');
    }

    /**
     * One second's work, one tick at a time. A tick that has not returned
     * (a query waiting on a lock, or on a pool with no free connection) is
     * reported at TICK_STALL_MS and left behind at TICK_ABANDON_MS, so the
     * next second starts a fresh one and the boards move again.
     */
    async tick() {
        if (!this.isInitialized) return;
        // A standby (or a leader whose lease it can no longer vouch for) does nothing.
        if (!this.leads()) return;
        if (this.isRunning) {
            const ranMs = Date.now() - this.tickStartedAt;
            if (ranMs >= TICK_STALL_MS && !this.stallReported) {
                this.stallReported = true;
                console.error(`❌ CycleGenerator: one tick has run for ${Math.round(ranMs / 1000)}s; every board is waiting on it`);
                sendAlert('cycle-manager-stalled', 'Board rounds are not moving: the cycle manager is stuck on one tick', {
                    runningForSeconds: Math.round(ranMs / 1000),
                }).catch(() => {});
            }
            if (ranMs < TICK_ABANDON_MS) return;
            console.error(`❌ CycleGenerator: leaving a tick stuck for ${Math.round(ranMs / 1000)}s behind and starting a fresh one`);
        }
        const seq = ++this.tickSeq;
        this.isRunning = true;
        this.tickStartedAt = Date.now();
        this.stallReported = false;
        try {
            // The first tick as leader is the start-up pass; every one after
            // it is the ordinary second's work.
            if (this.needsInit) {
                this.needsInit = false;
                await this.initializeCycles();
                console.log('✅ Cycle Generator: Initialization complete');
            } else {
                await this.manageCycles();
            }
        } catch (e) {
            console.error('❌ CycleGenerator interval error:', e);
        } finally {
            if (seq === this.tickSeq) {
                this.isRunning = false;
            } else {
                console.warn(`⚠️  CycleGenerator: a tick left behind finished after ${Math.round((Date.now() - this.tickStartedAt) / 1000)}s`);
            }
        }
    }

    async initializeCycles() {
        await this.ensureEveryCycle();
        // Populate broadcast cache with currently-active (non-expired) cycles.
        // ensureActive*Cycle() above already force-expired any stale ones,
        // but guard on endTime here too in case any slip through.
        const nowMs = Date.now();
        // With their pools, because that is what the broadcast carries. Reading
        // them per cycle afterwards would be one round trip per type on every
        // boot, each seeing the database at its own instant.
        const existing = await db.markets.activeCyclesWithPools({
            statuses: ['OPEN', 'MERGED', 'CLOSED'], includeExpired: true,
        });
        for (const c of existing) {
            const endMs = new Date(c.endTime).getTime();
            if (endMs > nowMs - 60000) {  // allow 60s grace for cycles in CLOSED/celebration
                this.liveCycleCache[slotOf(c)] = c;
            }
        }
    }

    async manageCycles() {
        await this.ensureEveryCycle();
        await this.updateCycleStatuses();
    }

    /** The live cycle of every switched-on board, for every audience. */
    async ensureEveryCycle() {
        const boards = await enabledBoards();
        for (const audience of AUDIENCES) {
            for (const board of boards) await this.ensureBoardCycle(board, audience);
        }
    }

    // ─── EMIT HELPERS ─────────────────────────────────────────────────────────

    // All users (public) — broadcasts over SSE (one-way stream, all clients)
    // SSE is cheaper than WS for broadcast data: no per-client handshake,
    // HTTP/2 multiplexes streams, browser reconnects automatically.
    /** The two public transports, for the shared emitters in realtimeEmitters.js. */
    transports() {
        return { io: this.io, sseManager: this.sseManager };
    }

    emitPublic(event, data) {
        recordRealtimeEvent(event, data);
        // Broadcast to ALL connected clients via BOTH channels simultaneously.
        // SSE: browser EventSource clients (user panel public stream)
        
        // Both channels must fire — a client may be on one or the other depending
        // on connection state. Never rely on only one channel for public events.
        if (this.sseManager) {
            this.sseManager.broadcast(event, data);
        }
        
        // This covers: logged-in users who may not have SSE open, reconnecting clients,
        // and any client where EventSource failed to connect.
        this.io?.emit(event, data);
    }

    
    emitAdmin(event, data) {
        emitToStaff(this.io, event, data);
    }



    // ─────────────────────────────────────────────────────────────────────────

    async updateCycleStatuses() {
        try {
            const now = Date.now();

            // Exclude RESULT_DECLARED — the settlement engine handles those.
            // `includeExpired` is what finds a cycle the server was down for:
            // every other read filters those out, and a cycle nothing can see
            // is a round players' stakes are locked against forever.
            const activeCycles = await db.markets.activeCyclesWithPools({
                statuses: ['OPEN', 'MERGED', 'CLOSED'], includeExpired: true,
            });

            // Auto phantom-bet plans, read once a tick. A failed read places none
            // this tick and leaves every phase below untouched.
            const autoPlans = activeCycles.some((c) => ['OPEN', 'MERGED'].includes(c.status))
                ? await db.phantomAutoPlans.runnablePlans().catch((e) => {
                    console.error('❌ Auto phantom bets: plans unreadable:', e.message);
                    return [];
                })
                : [];

            // Player auto bets, read at most once a tick and only when a plan
            // has a round it has not been tried on (`runPlayerAutoBets`).
            let autoPlayerPlans = null;
            const playerPlansFor = async () => {
                if (!autoPlayerPlans) autoPlayerPlans = this.loadPlayerAutoPlans(activeCycles);
                return autoPlayerPlans;
            };

            for (const cycle of activeCycles) {
                // One round's failure (a lock it waited on too long, a read
                // that failed) costs that round this tick only: the next round
                // and every other board carry on, and it is retried next second.
                try {
                    await this.advanceCycle(cycle, { now, autoPlans, playerPlansFor });
                } catch (error) {
                    console.error(`❌ Advancing ${cycle.cycleId} (${cycle.type}):`, error.message);
                }
            }
        } catch (error) {
            console.error('❌ Error updating cycle statuses:', error);
        }
    }

    /** One live round's phase for this tick (`updateCycleStatuses`). */
    async advanceCycle(cycle, { now, autoPlans, playerPlansFor }) {
                const cycleEndMs = new Date(cycle.endTime).getTime();

                // ── STALE CYCLE FAST-PATH ─────────────────────────────────────
                // If a cycle is in active status but its endTime is already past
                // (server was down, cold start after a gap), skip the normal phase
                // logic and force-complete it immediately so ensureActive*Cycle()
                // can create the correct current cycle on the next tick.
                if (cycleEndMs <= now && cycle.status !== 'CLOSED') {
                    console.warn(`⚠️  updateCycleStatuses: force-closing stale ${cycle.type} cycle ${cycle.cycleId}`);
                    // Guarded on the statuses it may move FROM, so a tick that
                    // lost a race does not drag a cycle backwards out of CLOSED.
                    await db.markets.setCycleStatus(cycle.cycleId, 'CLOSED', {
                        from: ['OPEN', 'MERGED'],
                    });
                    cycle.status = 'CLOSED';
                }
                if (cycleEndMs <= now - 10000 && cycle.status === 'CLOSED') {
                    // endTime passed + 10s grace → declare result now
                    await this.completeCycle(cycle);
                    return;
                }
                // A cycle whose board cannot be read cannot be phased safely,
                // and throwing here would abandon every OTHER cycle in this tick,
                // including one waiting to be settled. Skip it loudly instead.
                // (`cycles_board_fk` means this is a read failure, not a missing row.)
                const board = await boardOf(cycle.type);
                if (!board) {
                    console.error(`❌ updateCycleStatuses: no board '${cycle.type}' for ${cycle.cycleId} — skipping`);
                    return;
                }

                // The board's phase offsets, seconds before endTime. The schema
                // holds them in order and inside the block (`boards_phases_ordered`).
                const p = board.phases;
                const mergeTime      = cycleEndMs - (p.mergeBeforeEndSec     * 1000);
                const equalizerTime  = cycleEndMs - (p.equalizerBeforeEndSec * 1000);
                const betsClosedTime = cycleEndMs - (p.closeBeforeEndSec     * 1000);
                const fireworksTime  = cycleEndMs - (p.celebrateBeforeEndSec * 1000);

                // ─── PHASE 1: MERGE ─────────────────────────────────────────
                if (now >= mergeTime && now < equalizerTime && cycle.status === 'OPEN') {
                    const merged = await db.markets.setCycleStatus(cycle.cycleId, 'MERGED', { from: ['OPEN'] });
                    // Another tick got there first. Not an error — but the
                    // announcement below must not fire twice, so skip it.
                    if (!merged.ok) return;
                    cycle.status = 'MERGED';
                    // Compact v2 wire format (realtimeProtocol.js).
                    emitCyclePhase({
                        cycleId: cycle.cycleId, type: cycle.type, audience: cycle.audience, phase: 'MERGED',
                    }, this.transports());
                    console.log(`📊 Cycle ${cycle.cycleId} (${cycle.type}): MERGED`);
                }

                // ─── AUTO PHANTOM BETS, until the equalizer ───────────────────
                if (now < equalizerTime && ['OPEN', 'MERGED'].includes(cycle.status) && !cycle.phantomBetsClosed) {
                    await this.runAutoPhantomBets(cycle, autoPlans, now, equalizerTime);
                }

                // ─── PLAYER AUTO BETS, one a round, a second before the close ──
                if (now < betsClosedTime - 1000 && ['OPEN', 'MERGED'].includes(cycle.status)) {
                    await this.runPlayerAutoBets(cycle, await playerPlansFor());
                }

                // ─── PHASE 2: PHANTOM EQUALIZER ─────────────────────────────
                // Runs silently server-side.
                // Users only see the resulting updated totals via cycle_update.
                // Also when a slow tick missed the window: the phantom side must be
                // balanced (and phantom betting closed) before the result, or the
                // combined totals players see disagree with the real ones.
                if (now >= equalizerTime && !cycle.phantomBetsClosed) {
                    await this.runPhantomEqualizer(cycle);
                }

                // ─── PHASE 3: BETS CLOSED ───────────────────────────────────
                // BUG 4a FIX: was cycle.status === 'MERGED'. If server missed the MERGED
                // window (DB lag, slow tick), cycle is still OPEN here — Phase 3 was
                // silently skipped and cycle stayed OPEN forever.
                // Fix: allow OPEN or MERGED → both can transition to CLOSED.
                if (now >= betsClosedTime && now < fireworksTime && ['OPEN', 'MERGED'].includes(cycle.status)) {
                    const closed = await db.markets.setCycleStatus(cycle.cycleId, 'CLOSED', {
                        from: ['OPEN', 'MERGED'],
                    });
                    if (!closed.ok) return;
                    cycle.status = 'CLOSED';
                    emitCyclePhase({
                        cycleId: cycle.cycleId, type: cycle.type, audience: cycle.audience, phase: 'CLOSED',
                    }, this.transports());
                    console.log(`🔒 Cycle ${cycle.cycleId} (${cycle.type}): CLOSED`);
                }

                // ─── PHASE 4: DECLARE WINNER ─────────────────────────────────
                // BUG 4a FIX: was cycle.status === 'CLOSED'. Allow OPEN/MERGED/CLOSED
                // so a cycle that missed earlier phases can still complete.
                // BUG 3 FIX: `continue` skips the cache-update line below.
                // Without continue: completeCycle() does `delete liveCycleCache[type]`
                // then the next line immediately does liveCycleCache[type] = cycle
                // (with status still 'CLOSED'). broadcastLiveUpdates then emits
                // status:'CLOSED' every 100ms, overwriting the 'RESULT_DECLARED'
                // that cycle_result just set on the frontend → celebration never renders.
                if (now >= fireworksTime && ['OPEN', 'MERGED', 'CLOSED'].includes(cycle.status)) {
                    await this.completeCycle(cycle);
                    return; // ← CRITICAL: skip cache-update, cache was evicted inside completeCycle
                }

                // Only reached for cycles that did NOT complete this tick.
                // Refresh cache with latest values so 100ms broadcast is accurate.
                this.liveCycleCache[slotOf(cycle)] = cycle;
    }

    /**
     * Place the round's RTP house bet if its fund covers it, or find the one a
     * crashed tick already placed (rtp.placeHouseBet writes it once). Null when
     * there is none. A failure places none: the round runs as it would have.
     */
    async placeRtpHouseBet(cycle) {
        try {
            const fund = await db.rtp.fundForRound(cycle.type, cycle.audience);
            if (!fund) {
                const placed = await db.markets.getCycle(cycle.cycleId);
                return placed?.houseBetSide ? { side: placed.houseBetSide, stakePaise: Math.round(placed.houseBet * 100) } : null;
            }
            const [stakes, rules] = await Promise.all([
                db.bets.cycleStakesByPlayer(cycle.cycleId), getRiskRules(),
            ]);
            const { winningsFeePercent } = rules;
            const payoutMultiplier = multiplierFor(rules, cycle.audience);
            const plan = planHouseBet({
                stakes, rateBp: fund.rateBp, availablePaise: fund.availablePaise,
                feePercent: winningsFeePercent, multiplier: payoutMultiplier,
            });
            if (!plan) {
                const placed = await db.markets.getCycle(cycle.cycleId);
                return placed?.houseBetSide ? { side: placed.houseBetSide, stakePaise: Math.round(placed.houseBet * 100) } : null;
            }
            const r = await db.rtp.placeHouseBet({
                cycleId: cycle.cycleId, side: plan.side, stakePaise: plan.stakePaise, reservedPaise: plan.reservedPaise,
            });
            if (r.ok || r.reason === 'ALREADY_PLACED') return r.houseBet;
            return null;
        } catch (error) {
            console.error(`❌ RTP house bet on ${cycle.cycleId}:`, error.message);
            return null;
        }
    }

    async completeCycle(cycle) {
        try {
            // Betting stops BEFORE the pools are read. A tick that skipped the
            // CLOSED step reaches here with the round still OPEN or MERGED, and
            // a bet committing between the read below and the declaration
            // would be accepted and settled without ever having been counted
            // when the smaller side was chosen. Closing is an UPDATE of the
            // round's row, so it waits for every bet still being written (each
            // holds a share lock on that row, `bets.core.placeBet`), and every
            // later bet sees CLOSED and is refused. After this, the bets are
            // final.
            if (['OPEN', 'MERGED'].includes(cycle.status)) {
                const closed = await db.markets.setCycleStatus(cycle.cycleId, 'CLOSED', { from: ['OPEN', 'MERGED'] });
                if (closed.ok) {
                    cycle.status = 'CLOSED';
                    emitCyclePhase({
                        cycleId: cycle.cycleId, type: cycle.type, audience: cycle.audience, phase: 'CLOSED',
                    }, this.transports());
                }
            }
            // The phantom side balanced before the result, if the equalizer's
            // window was missed (a no-op when it already ran).
            if (!cycle.phantomBetsClosed) await this.runPhantomEqualizer(cycle);

            // The winner is decided by which real pool is SMALLER, so these two
            // numbers are the single most consequential read in the platform.
            // Under FLAGS.DERIVED_CYCLE_POOLS the stored fields are a periodic
            // projection of the bets and may trail by up to a refresh interval
            // — bounded staleness that is fine for a live display and not fine
            // here. Recompute exactly first; no-op when the flag is off.
            //
            // If that recompute FAILS while the flag is on, abort the whole
            // completion rather than falling back to the stored fields. Those
            // fields are only as fresh as the last successful refresh, and if
            // refreshes are failing they may be arbitrarily stale — settling on
            // them would pick a winner from pools that are not the real ones and
            // pay out accordingly. The cycle stays un-completed and the next
            // tick retries, which is a delay rather than a mispayment.
            const exactPools = await computeRealPools(cycle.cycleId).catch((e) => {
                console.error(`[Cycle] pool read failed for ${cycle.cycleId}:`, e.message);
                return null;
            });
            // No fallback to a figure on the cycle row. There is none — the real
            // pools are derived and the row carries only the phantom ones — and
            // settling on a stale number picks the winning SIDE from pools that
            // are not the real ones and pays out accordingly. The cycle stays
            // un-completed and the next tick retries: a delay, not a mispayment.
            if (!exactPools) {
                console.error(`[Cycle] Refusing to settle ${cycle.cycleId} on unread pools — retrying next tick.`);
                return;
            }
            const realDelhi  = exactPools.realDelhi;
            const realBombay = exactPools.realBombay;

            // The RTP house bet, the round's last bet: betting is closed and
            // the phantom side settled, so nothing can follow it. A real bet,
            // counted on its side when the winner is chosen; never a phantom.
            const houseBet = await this.placeRtpHouseBet(cycle);
            const houseDelhi  = houseBet?.side === 'DELHI'  ? houseBet.stakePaise / 100 : 0;
            const houseBombay = houseBet?.side === 'BOMBAY' ? houseBet.stakePaise / 100 : 0;
            const decideDelhi  = realDelhi + houseDelhi;
            const decideBombay = realBombay + houseBombay;

            // Winner = minority real-bet side (platform profits from majority)
            let winner;
            // Compared in paise: a rupee float sum must not decide a winner.
            const dPaise = Math.round(decideDelhi * 100);
            const bPaise = Math.round(decideBombay * 100);
            if (dPaise > bPaise) {
                winner = 'BOMBAY';
            } else if (bPaise > dPaise) {
                winner = 'DELHI';
            } else {
                // EXACT TIE — the only branch where a real-money outcome is
                // decided by chance rather than by the pools, so it must be
                // decided by a CSPRNG.
                //
                // This was `Math.random() < 0.5`. V8 implements Math.random as
                // xorshift128+, which is seeded per isolate and RECOVERABLE from
                // a modest run of observed outputs — an adversary who can force
                // ties (trivial in a low-liquidity cycle: bet the two sides
                // equally) and watch the results could predict subsequent
                // tie-breaks and bet the winning side. Independently of
                // exploitability, GLI-19, UKGC RTS 2A and the MGA technical
                // requirements all demand that anything determining a game
                // outcome come from a cryptographically secure generator.
                //
                // randomInt(2) is crypto-backed and rejection-samples, so the
                // two sides are exactly equiprobable (no modulo bias).
                winner = randomInt(2) === 0 ? 'DELHI' : 'BOMBAY';
            }

            // The winner and the status in ONE statement, guarded on
            // `winner IS NULL` — trap 3. Two statements open a window in which
            // the cycle reads as declared with no winner, and the settlement
            // sweep reads exactly that.
            //
            // A refusal means another tick declared it first. Stop rather than
            // announcing a result this pass did not decide: the winner in hand
            // is from THIS adjudication, and the one players are about to be
            // paid on is the other tick's.
            const declared = await db.markets.declareWinner(cycle.cycleId, winner, {
                by: 'engine', confidence: null,
            });
            if (!declared.ok) {
                if (declared.reason === 'ALREADY_DECLARED') {
                    console.log(`[Cycle] ${cycle.cycleId} was declared by another tick — ${declared.winner}`);
                } else {
                    console.error(`[Cycle] could not declare ${cycle.cycleId}:`, declared.reason);
                }
                return;
            }

            const board = await boardOf(cycle.type);
            const cycleType = board ? cycleLabel(board) : cycle.type;
            // COMBINED totals only — the same numbers players watched during
            // betting. Sending realDelhi/realBombay would let anyone infer the
            // phantom split by subtraction, and since the winner is the
            // MINORITY real side, that is the result itself.
            //
            // Built from the pools this adjudication actually used, not from
            // whatever the cached cycle object carried: announcing a total that
            // disagrees with the one the winner was decided from is how a
            // result comes to look arbitrary.
            const combinedDelhi  = decideDelhi  + cycle.phantomDelhi;
            const combinedBombay = decideBombay + cycle.phantomBombay;

            // Public result — combined pool only, guarded against a real/phantom
            // field being added here later.
            // Compact v2 wire format; the encoder runs assertPublicCycleSafe.
            emitCycleResult({
                cycleId:    cycle.cycleId,
                type:       cycle.type,
                audience:   cycle.audience,
                winner,
                delhiPool:  combinedDelhi,
                bombayPool: combinedBombay,
            }, this.transports());
            // Each player's own result, now: settlement can follow seconds later.
            void announceRoundResults({ cycleId: cycle.cycleId, winner, audience: cycle.audience });

            // Admin result — full breakdown
            this.emitAdmin('admin_cycle_result', {
                cycleId:      cycle.cycleId,
                type:         cycle.type,
                audience:     cycle.audience,
                winner,
                realDelhi,
                realBombay,
                phantomDelhi:  cycle.phantomDelhi,
                phantomBombay: cycle.phantomBombay,
                houseBetSide:  houseBet?.side ?? null,
                houseBet:      houseBet ? houseBet.stakePaise / 100 : 0,
                totalDelhi:    combinedDelhi,
                totalBombay:   combinedBombay,
                timestamp:     new Date()
            });

            // Evict completed cycle from broadcast cache immediately
            delete this.liveCycleCache[slotOf(cycle)];
            console.log(`🏆 Cycle ${cycle.cycleId} (${cycleType}) RESULT_DECLARED — Winner: ${winner}`);
            console.log(`   Real bets: Delhi ₹${realDelhi} | Bombay ₹${realBombay}`);

            // Celebration length is this type's celebrate offset: the window
            // between the result being declared and endTime. Hardcoding 10 here
            // would tell a 1-minute client to celebrate for 10s of a 60s block
            // and leave it counting down through the next cycle's betting.
            // `cycles_board_fk` guarantees the board; 0 only if it could not be read.
            const celebrateSec = board?.phases.celebrateBeforeEndSec ?? 0;

            this.emitPublic('celebration', { cycleId: cycle.cycleId, type: cycle.type, audience: cycle.audience, winner });
            this.emitPublic('fireworks',   { cycleId: cycle.cycleId, type: cycle.type, audience: cycle.audience, winner, secondsLeft: celebrateSec, message: `${winner} wins!`, timestamp: new Date() });

            // Push updated cycle history to ALL clients after result.
            // This replaces the 5-minute HTTP polling interval in GameContext.
            // Small delay so the DB write is committed before we query it.
            //
            // ONLY THIS TYPE'S history is sent. No other type's list changed,
            // and a 1-minute block fires this 60 times an hour — restating all
            // three types each time is 3x the payload to every connected client
            // to tell them what they already had. The client merges on `types`.
            setTimeout(async () => {
                try {
                    this.emitPublic('cycle_history', await fetchCycleHistory({ types: cycle.type, audience: cycle.audience }));
                } catch { /* non-critical — clients will re-request on next mount */ }
            }, 1500);

            // BUG 4b FIX: celebration lock was 12s, but completeCycle fires at the
            // celebrate offset before endTime. A lock LONGER than that offset put
            // the next cycle's creation after endTime — the user saw the timer hit
            // 00:00, then a blank gap, then a new cycle.
            //
            // So the lock is exactly this type's celebrate offset, which by
            // construction expires as the timer reaches 00:00. Derived per type
            // rather than fixed at 10s: for the 1-minute block a 10s lock would
            // swallow a sixth of the next cycle before betting could open.
            this.celebrationLockUntil[slotOf(cycle)] = Date.now() + celebrateSec * 1000;

            // Create the next cycle as celebration ends (timer = 00:00), plus a
            // 500ms buffer for the DB write to land.
            setTimeout(async () => {
                console.log(`🔄 Auto-creating next ${cycleType} cycle...`);
                await this.ensureActiveCycle(cycle.type, cycle.audience);
            }, celebrateSec * 1000 + 500);

        } catch (error) {
            console.error('❌ Error completing cycle:', error);
        }
    }

    /**
     * Place this tick's auto phantom bets on one cycle (owner, 2026-10-15).
     *
     * Every runnable plan for the cycle's board bets one size a second, in its
     * list's order and looped, from the round's start (or the plan's save)
     * until the equalizer. The seconds offered are the last few up to now
     * (`secondsToPlace`); one already placed is skipped by its bet id, so a
     * slow or repeated tick never doubles a bet. All of a tick's bets on one
     * cycle are one transaction (`placeAutoPhantomBets`).
     *
     * A failure is logged and costs this tick's bets only: the phases of this
     * and every other cycle carry on.
     */
    async runAutoPhantomBets(cycle, plans, now, equalizerTime) {
        // A plan runs on its own board's rounds of its own audience only.
        const mine = plans.filter((p) => p.boardKey === cycle.type && p.audience === cycle.audience);
        if (!mine.length) return;
        const startMs = new Date(cycle.startTime).getTime();
        const bets = [];
        for (const plan of mine) {
            const first = firstSecond(startMs, plan.startsAtMs);
            for (const second of secondsToPlace({ startMs, stopMs: equalizerTime, fromMs: plan.startsAtMs, nowMs: now })) {
                bets.push({
                    userId: plan.userId, side: plan.side, second,
                    amountPaise: sizeAtSecond(plan.amountsPaise, first, second),
                });
            }
        }
        if (!bets.length) return;
        try {
            const result = await db.markets.placeAutoPhantomBets({ cycleId: cycle.cycleId, cycleType: cycle.type, bets });
            if (!result.ok || !result.placed) return;
            const updated = result.cycle;
            cycle.phantomDelhi = updated.phantomDelhi;
            cycle.phantomBombay = updated.phantomBombay;
            const realNow = await db.markets.realPools(cycle.cycleId).catch(() => ({ realDelhi: 0, realBombay: 0 }));
            const totalDelhi = realNow.realDelhi + (updated.phantomDelhi || 0);
            const totalBombay = realNow.realBombay + (updated.phantomBombay || 0);
            // The public number is the total, coalesced like any bet's.
            cycleSnapshotPublisher.recordBet(cycle.cycleId, {
                cycleType: cycle.type, totalDelhi, totalBombay, poolsHidden: poolsHidden(updated),
            });
            // The split, to full admins only (staffEventAreas: undeclared).
            this.emitAdmin('admin_bet_placed', {
                cycleId: cycle.cycleId, cycleType: cycle.type,
                isPhantom: true, isAuto: true, bets: result.placed,
                amountDelhi: result.delhiRupees, amountBombay: result.bombayRupees,
                newRealDelhi: realNow.realDelhi, newRealBombay: realNow.realBombay,
                newPhantomDelhi: updated.phantomDelhi, newPhantomBombay: updated.phantomBombay,
                newTotalDelhi: totalDelhi, newTotalBombay: totalBombay,
            });
        } catch (error) {
            console.error(`❌ Auto phantom bets on ${cycle.cycleId}:`, error.message);
        }
    }

    /**
     * The running player auto-bets plans that still have a round to try this
     * tick, with their standing (`playerAutoBets.runnablePlans`). A failed read
     * places none this tick; every phase carries on.
     */
    async loadPlayerAutoPlans(activeCycles) {
        try {
            const live = new Set(activeCycles.map((c) => c.cycleId));
            for (const key of this.autoBetsTried) {
                if (!live.has(key.slice(key.indexOf(':') + 1))) this.autoBetsTried.delete(key);
            }
            const open = activeCycles.filter((c) => ['OPEN', 'MERGED'].includes(c.status));
            const running = await db.playerAutoBets.runningPlanKeys();
            const due = running.filter((p) => open.some((c) => c.type === p.boardKey && c.audience === p.audience
                && !this.autoBetsTried.has(`${p.planId}:${c.cycleId}`)));
            if (!due.length) return [];
            let plans = await db.playerAutoBets.runnablePlans(due.map((p) => p.planId));
            // While the platform is closed for maintenance, only its testers play.
            const cfg = await getSystemConfig();
            if (cfg?.maintenanceMode) plans = plans.filter((p) => p.maintenanceTester);
            return plans;
        } catch (e) {
            console.error('❌ Player auto bets: plans unreadable:', e.message);
            return [];
        }
    }

    /**
     * Place each due player auto bet on one round (owner, 2026-10-22;
     * autoBets.js). One bet per plan per round, the step's stake, through the
     * player's own admission (`placePlayerBet`), keyed by plan and round so a
     * repeated tick or a restart never places it twice. A plan whose last bet
     * has not settled waits; one that reaches a stop, or is refused for what a
     * tapped bet would be refused for, stops and the player is told.
     */
    async runPlayerAutoBets(cycle, plans) {
        const mine = plans.filter((p) => p.boardKey === cycle.type && p.audience === cycle.audience);
        for (const plan of mine) {
            const key = `${plan.planId}:${cycle.cycleId}`;
            if (this.autoBetsTried.has(key)) continue;
            // The last round's bet is not settled yet: its result decides the step.
            if (plan.pending > 0) continue;
            try {
                const stop = stopBefore({
                    netPaise: plan.netPaise, stakePaise: plan.nextStakePaise,
                    stopLossPaise: plan.stopLossPaise, takeProfitPaise: plan.takeProfitPaise, budgetPaise: plan.budgetPaise,
                });
                if (stop) { await this.stopPlayerAutoPlan(plan, stop); continue; }
                this.autoBetsTried.add(key);
                const amount = plan.nextStakePaise / 100;
                const placed = await placePlayerBet({
                    userId: plan.userId, cycleId: cycle.cycleId, side: plan.side, amount,
                    betId: autoBetId(plan.planId, cycle.cycleId), autoPlanId: plan.planId,
                });
                if (placed.kind === 'placed') {
                    await announcePlacedBet({
                        userId: plan.userId, cycleId: cycle.cycleId, cycle: placed.cycle,
                        side: plan.side, amount, balances: placed.balances,
                    });
                } else if (placed.kind === 'refused') {
                    const reason = stopForRefusal(placed.body?.code);
                    if (reason) await this.stopPlayerAutoPlan(plan, reason);
                }
            } catch (error) {
                console.error(`❌ Player auto bet ${plan.planId} on ${cycle.cycleId}:`, error.message);
            }
        }
    }

    /** Stop a plan once and tell its player why. */
    async stopPlayerAutoPlan(plan, reason) {
        const stopped = await db.playerAutoBets.stopPlan({ planId: plan.planId, userId: plan.userId, reason });
        if (!stopped) return;
        const net = plan.netPaise / 100;
        const boardName = (await boardOf(plan.boardKey).catch(() => null))?.name ?? plan.boardKey;
        await notify({
            userId: plan.userId,
            type: ['TAKE_PROFIT'].includes(reason) ? 'SUCCESS' : 'INFO',
            title: `Auto bets stopped on ${boardName}`,
            message: `${AUTO_STOP_TEXT[reason]} Net ${net < 0 ? '−' : '+'}₹${Math.abs(net).toLocaleString('en-IN')} over ${plan.played} round${plan.played === 1 ? '' : 's'}.`,
        }).catch(() => {});
    }

    /**
     * runPhantomEqualizer — raise the lower phantom side to match the higher.
     *
     * The equalizer's ONLY job is to balance the two phantom pools. It must
     * never change realDelhi/realBombay: those are the record of actual user
     * money and are owned exclusively by the bet routes' $inc.
     *
     * WHY AN AGGREGATION PIPELINE AND NOT A PLAIN $set (bug fix 2026-07-29):
     * this ran `totalDelhi: (cycle.realDelhi || 0) + equalizedValue` — an
     * ABSOLUTE write computed from a `cycle` snapshot the ticker read earlier
     * in the loop. Phase 2 fires while real betting is still OPEN (see the
     * `now < betsClosedTime` guard at the call site), so any real bet landing
     * between that read and this write had its `$inc` on totalDelhi silently
     * overwritten — the user watched the pool SHRINK just after they bet.
     * realDelhi kept the money (it is $inc-only and untouched here), so
     * settlement was never wrong; the displayed pool was, for the rest of the
     * cycle, and the schema invariant total = real + phantom was broken.
     *
     * A pipeline update evaluates `$realDelhi`/`$phantomDelhi` against the
     * LIVE document, inside the same atomic document write, so a concurrent
     * bet either lands before this (and is included) or after (and $incs a
     * correct base). There is no window.
     *
     * It also removes a second staleness bug: the old code chose between
     * "equalize" and "already balanced" from the snapshot, so a phantom bet
     * arriving mid-tick could leave the pools permanently unequal. `$max`
     * collapses both branches — when the sides are already equal it is a
     * no-op, so one code path is correct for both cases.
     */
    async runPhantomEqualizer(cycle) {
        try {
            // The arithmetic is IN the statement and guarded on
            // `phantom_bets_closed`, so two overlapping ticks equalize once.
            //
            // What this replaced read the cycle, took the max of the two phantom
            // sides in JavaScript and wrote both back as ABSOLUTE values — and
            // it ran while real betting was still open, so a bet landing between
            // the read and the write had its pool contribution silently
            // overwritten. Players watched the pool SHRINK just after they bet.
            const result = await db.markets.equalizePhantomPools(cycle.cycleId);
            if (!result.ok) {
                // Already closed by another tick or an admin: remember it, so
                // this cycle object stops asking.
                if (result.reason === 'PHANTOM_CLOSED') cycle.phantomBetsClosed = true;
                return;
            }

            const { cycle: after } = result;
            const equalizedValue = after.phantomDelhi;
            cycle.phantomBetsClosed = true;
            const before = { delhi: cycle.phantomDelhi, bombay: cycle.phantomBombay };
            cycle.phantomDelhi = after.phantomDelhi;
            cycle.phantomBombay = after.phantomBombay;
            const board = await boardOf(cycle.type);
            const cycleType = board ? cycleLabel(board) : cycle.type;

            // Nothing to balance — the write only closed phantom betting.
            if (before.delhi === before.bombay) {
                console.log(`⚖️  Phantom equalizer: ${cycle.cycleId} — already balanced at ₹${equalizedValue}`);
                return;
            }

            // ADMIN ROOM ONLY. Phantom figures expose the house's balancing, and
            // the winner is the minority REAL side — so a client that can see
            // them can infer the result before it is declared.
            this.emitAdmin('phantom_equalized', {
                cycleId:       cycle.cycleId,
                type:          cycle.type,
                phantomDelhi:  equalizedValue,
                phantomBombay: equalizedValue,
                message:       `${cycleType} phantom pools balanced to ₹${equalizedValue}`,
                timestamp:     new Date(),
            });

            console.log(`⚖️  Phantom equalizer: ${cycle.cycleId} (${cycleType}) → ₹${equalizedValue} each side`);
        } catch (error) {
            console.error('❌ Phantom equalizer error:', error);
        }
    }

    /**
     * A cycle whose end time passed while nobody was running: adjudicate it.
     *
     * ══════════════════════════════════════════════════════════════════════
     * WHAT THIS REPLACED WAS A MONEY BUG, NOT A HOUSEKEEPING ONE
     * ══════════════════════════════════════════════════════════════════════
     * Both ensure paths force-expired a stale cycle by writing
     * `{ status: 'RESULT_DECLARED', winner: 'DELHI' }` — a HARDCODED winner, on
     * a round nobody adjudicated, chosen because DELHI is the first side in the
     * list.
     *
     * That is not an inert placeholder. The settlement engine claims on
     * `winner IS NOT NULL`, so the very next tick would pay every DELHI bet on
     * that cycle at 2x and consume every BOMBAY stake — real money, decided by
     * alphabetical order, every time a deploy or a crash outlasted a block.
     *
     * A stale cycle gets the SAME adjudication as any other: the minority real
     * pool wins. Those pools are derived from the bets, so they are just as
     * computable an hour late as they were on time, and `completeCycle` is the
     * one place that decides a winner.
     *
     * If the pools cannot be read, the cycle is left alone and the next tick
     * retries. A delay is not a mispayment.
     */
    async adjudicateStaleCycle(cycle, label) {
        console.warn(
            `⚠️  Stale ${label} cycle detected: ${cycle.cycleId} `
            + `(ended ${new Date(cycle.endTime).toISOString()}). Adjudicating.`,
        );
        await this.completeCycle(cycle);
        delete this.liveCycleCache[slotOf(cycle)];
    }

    /**
     * ensureActiveCycle — create/refresh the live cycle of one board, by key.
     * A board switched off (or gone) gets no new round.
     */
    async ensureActiveCycle(type, audience) {
        const board = await boardOf(type);
        if (!board?.enabled) return;
        return this.ensureBoardCycle(board, audience);
    }

    /**
     * The current block of a board, as of `now`. Pure: the board's row is the
     * whole of its timing.
     *
     *   INTERVAL  blocks tile the IST hour: start = floor(minute / d) * d, so
     *             {0,30} at d=30, every minute at d=1. (`boards_timer_runs`
     *             holds d to a divisor of 60, which is what keeps
     *             (cycle_type, audience, start_time) unique.)
     *   DAILY     24 hours from the most recent `anchorHourIst`:00 IST, which
     *             is YESTERDAY's before the hour and today's from it.
     *
     * Both start at the block that contains `now`, never the next boundary: a
     * future start left the player screen with no current cycle to show.
     */
    blockFor(board, now = new Date()) {
        const ist = new Date(now.getTime() + this.IST_OFFSET);
        let startTime;
        if (board.kind === 'DAILY') {
            const startIst = new Date(ist);
            startIst.setUTCHours(board.anchorHourIst, 0, 0, 0);
            if (ist.getUTCHours() < board.anchorHourIst) startIst.setUTCDate(startIst.getUTCDate() - 1);
            startTime = new Date(startIst.getTime() - this.IST_OFFSET);
        } else {
            const d = board.durationMin;
            const minute = ist.getUTCMinutes();
            const elapsedMs = ((minute - Math.floor(minute / d) * d) * 60 + ist.getUTCSeconds()) * 1000;
            startTime = new Date(now.getTime() - elapsedMs);
            startTime.setMilliseconds(0);
        }
        return { startTime, endTime: new Date(startTime.getTime() + board.durationMin * 60 * 1000) };
    }

    /**
     * ensureBoardCycle — the one creation path, for every board and audience.
     *
     * Celebration lock, stale-cycle recovery, block anchoring, the
     * one-winner insert and the announcements are the same for every board;
     * only the block (`blockFor`), the id prefix and the name differ, and
     * those are the board's row.
     */
    async ensureBoardCycle(board, audience) {
        const type = board.key;
        const label = `${cycleLabel(board)} ${audience}`;
        try {
            // Celebration lock: do not create the next cycle while fireworks are running.
            // manageCycles() ticks every 1 s; without this guard a new OPEN cycle would
            // appear within 1 s of result declaration, making getCycleState return
            // winner=null to any user who loads the page mid-celebration.
            if (Date.now() < (this.celebrationLockUntil[slotKey(type, audience)] ?? 0)) return;

            const existing = await db.markets.currentCycleWithPools(type, audience, {
                statuses: ['OPEN', 'MERGED', 'CLOSED'],
            });

            if (existing) {
                if (new Date(existing.endTime).getTime() > Date.now()) return;  // healthy
                // ── STALE CYCLE RECOVERY ─────────────────────────────────────
                // The server was down (deploy, crash, cold start) while this
                // cycle was live: its end time has passed but no result was
                // declared. It is ADJUDICATED, not stamped with a hardcoded
                // winner — see adjudicateStaleCycle for what that used to cost.
                await this.adjudicateStaleCycle(existing, label);
            }

            const { startTime, endTime } = this.blockFor(board);

            // Two instances or two rapid ticks reaching here must produce ONE
            // cycle. The unique index on (cycle_type, audience, start_time)
            // decides — `ensureCycle` uses ON CONFLICT DO NOTHING, so the loser
            // is a no-op that then reads the winner's row.
            //
            // No pool fields are written. Real pools are DERIVED from the bets
            // (trap 4) and the phantom ones default to zero.
            const { cycle, created } = await db.markets.ensureCycle({
                cycleId:  idFor(board.idPrefix, audience),
                cycleType: type,
                audience,
                startTime,
                endTime,
            });

            // Another instance created it and announced it; this one must not.
            if (!created) return;

            this.liveCycleCache[slotKey(type, audience)] = cycle;  // seed broadcast cache immediately
            console.log(`🆕 Created new ${label} cycle: ${cycle.cycleId}`);
            console.log(`   Start: ${startTime.toISOString()}`);
            console.log(`   End:   ${endTime.toISOString()}`);

            // BUG-DATE FIX: emit timestamps (ms) not Date objects. A Date is
            // serialised to an ISO string, and the client's (endTimeMs - nowMs)
            // then returns NaN → broken countdown.
            const startMs = cycle.startTime instanceof Date ? cycle.startTime.getTime() : Number(cycle.startTime);
            const endMs   = cycle.endTime   instanceof Date ? cycle.endTime.getTime()   : Number(cycle.endTime);
            const newCyclePayload = {
                cycleId:   cycle.cycleId,
                type,
                audience,
                startTime: startMs,
                endTime:   endMs,
                status:    'OPEN',
                message:   boardMessages(board).newCycle,
                timestamp: Date.now()
            };
            this.emitPublic('new_cycle', newCyclePayload);
            // Admin gets same payload so their panel updates cycleId state immediately.
            this.emitAdmin('admin_new_cycle', newCyclePayload);

            // Also push a fresh cycle_snapshot so any client that missed new_cycle
            // (brief disconnect, slow mobile) gets authoritative state immediately.
            await this.broadcastSnapshot(audience);

        } catch (error) {
            console.error(`❌ Error ensuring ${label} cycle:`, error);
        }
    }

    /**
     * Immediately refresh liveCycleCache for a single cycle type after a bet is placed.
     * Without this, broadcastLiveUpdates() would broadcast stale pool totals for up to
     * 1 second (the manageCycles() interval), overwriting the correct value that
     * bet_placed SSE just delivered to the frontend.
     */
    refreshCacheForCycle(cycleDoc) {
        if (!cycleDoc || !cycleDoc.type || !cycleDoc.audience) return;
        this.liveCycleCache[slotOf(cycleDoc)] = cycleDoc;
    }

    /**
     * Push one audience's snapshot to everyone. Each carries its `audience`;
     * a panel applies only its own player's (public totals only, so the other
     * audience's snapshot reveals nothing a player of it could not see).
     */
    async broadcastSnapshot(audience) {
        const snapshot = await this.getCycleSnapshotData(audience);
        this.emitPublic('cycle_snapshot', { audience, cycles: snapshot, timestamp: Date.now() });
        this.emitAdmin('admin_cycle_snapshot', { audience, cycles: snapshot, timestamp: Date.now() });
    }

    /** The live cycle of every type for one audience, keyed by type. */
    async getCycleSnapshotData(audience) {
        // Every board, switched off included: a board switched off mid-round
        // still shows that round until it settles. A snapshot that omits one
        // leaves clients with no state for that board until its next new_cycle.
        const types = (await allBoards()).map((b) => b.key);
        const snapshot = {};

        for (const type of types) {
            const cycle = await db.markets.currentCycleWithPools(type, audience);
            if (!cycle) continue;

            const now            = Date.now();
            const endTime        = new Date(cycle.endTime).getTime();
            const msLeft         = Math.max(0, endTime - now);
            const timeRemaining  = Math.max(0, Math.floor(msLeft / 1000));
            const timeRemainingMs = msLeft;
            // Real halves derived from the bets, phantom halves off the row.
            // The read this replaced took `realDelhi` as a document field — not
            // a column — so both sides fell through to `|| 0` and every
            // connecting client was told the pools were empty. From the merge
            // until the result, the total alone (`poolsHidden`).

            // Wrapped: this is the live state pushed to every connecting client,
            // so it is the highest-value place to prove no real/phantom pool
            // leaks. It carries timing fields publicCycleView does not, so it is
            // hand-built and guarded rather than produced by the serializer.
            snapshot[type] = assertPublicCycleSafe({
                cycleId:         cycle.cycleId,
                type:            cycle.type,
                audience:        cycle.audience,
                status:          cycle.status,
                startTime:       new Date(cycle.startTime).getTime(),
                endTime:         endTime,
                // SNAPSHOT FIX: was only sending timeRemaining (seconds).
                // CycleControl reads timeRemainingMs first — missing it caused timer = 0 on load.
                timeRemaining,
                timeRemainingMs,
                ...publicCyclePools(cycle),
                winner:          cycle.winner,
                isSettled:       cycle.isSettled ? 'COMPLETED' : 'PENDING',
                timestamp:       now,
            });
        }

        return snapshot;
    }

    
    async getActiveCycles() {
        try {
            return await db.markets.activeCyclesWithPools({
                statuses: ['OPEN', 'MERGED', 'CLOSED'], includeExpired: true,
            });
        } catch (error) {
            console.error('❌ Error getting active cycles:', error);
            return [];
        }
    }
}

export default CycleGenerator;
