// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { Cycle } from '../../models/index.js';
import mongoose from 'mongoose';

// ── CYCLE PHASE OFFSETS (Business Config Audit, 2026-07-11) ───────────────────
// Seconds BEFORE a cycle's endTime that each phase fires. Previously hardcoded
// inline in updateCycleStatuses(). Now admin-editable via SystemConfig.cyclePhases;
// these are the historical defaults AND the safe fallback used whenever config is
// unset or fails the ordering invariant. Invariant: merge > equalizer > close >
// celebrate > 0 (each phase strictly earlier than the next, all within the block).
const DEFAULT_CYCLE_PHASES = {
  thirtyMin: { mergeBeforeEndSec: 180, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 },
  fullDay:   { mergeBeforeEndSec: 300, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 },
};

// Reject a phase set that would break the state machine (out-of-order or negative
// offsets). A bad admin value falls back to DEFAULT_CYCLE_PHASES for that type
// rather than corrupting cycle transitions.
function validPhaseSet(p) {
  if (!p) return false;
  const m = p.mergeBeforeEndSec, e = p.equalizerBeforeEndSec,
        c = p.closeBeforeEndSec, f = p.celebrateBeforeEndSec;
  return [m, e, c, f].every(v => Number.isFinite(v)) && m > e && e > c && c > f && f >= 0;
}

class CycleGenerator {
    constructor(io, sseManager) {
        this.io = io;
        this.sseManager = sseManager;  // SSE broadcast manager for public events
        this.initialized = false;
        this.IST_OFFSET = 5.5 * 60 * 60 * 1000;
        this.lastBroadcast = {};
        // Celebration lock: don't create a new cycle of each type until this
        // timestamp passes.  Set to Date.now() + 12 000 when a cycle completes.
        this.celebrationLockUntil = { '30_MIN': 0, 'FULL_DAY': 0 };
        // In-memory cache of active cycles — updated by manageCycles() every 1s,
        // read by broadcastLiveUpdates() in the same tick with zero DB hits.
        this.liveCycleCache = {};  // { '30_MIN': cycleDoc, 'FULL_DAY': cycleDoc }
        // Short-TTL cache of the admin-configured phase offsets. The status tick
        // runs every 1s for every active cycle; without this we'd re-read
        // SystemConfig each tick. 30s TTL → an admin edit takes effect within 30s.
        this._cyclePhasesCache = null;
        this._cyclePhasesCacheAt = 0;
    }

    /**
     * getCyclePhases — admin-configured phase offsets (Business Config Audit).
     * Owned by SystemConfig.cyclePhases; cached 30s because the 1s status tick
     * calls this for every active cycle. Any missing/invalid value (per-type)
     * falls back to DEFAULT_CYCLE_PHASES, so timing is identical to the old
     * hardcoded behavior until an admin changes it.
     */
    async getCyclePhases() {
        const now = Date.now();
        if (this._cyclePhasesCache && (now - this._cyclePhasesCacheAt) < 30000) {
            return this._cyclePhasesCache;
        }
        let result = DEFAULT_CYCLE_PHASES;
        try {
            const SystemConfig = mongoose.model('SystemConfig');
            const cfg = await SystemConfig.findOne({ key: 'main' }).select('cyclePhases').lean();
            const cp = cfg?.cyclePhases;
            if (cp) {
                const thirtyMin = { ...DEFAULT_CYCLE_PHASES.thirtyMin, ...(cp.thirtyMin || {}) };
                const fullDay   = { ...DEFAULT_CYCLE_PHASES.fullDay,   ...(cp.fullDay   || {}) };
                result = {
                    thirtyMin: validPhaseSet(thirtyMin) ? thirtyMin : DEFAULT_CYCLE_PHASES.thirtyMin,
                    fullDay:   validPhaseSet(fullDay)   ? fullDay   : DEFAULT_CYCLE_PHASES.fullDay,
                };
            }
        } catch { /* fall back to defaults */ }
        this._cyclePhasesCache = result;
        this._cyclePhasesCacheAt = now;
        return result;
    }

    /**
     * getCycleDurationMinutes — the admin-configured short-block duration
     * (Phase X X-5). Owned by SystemConfig.cycleDurationMinutes; must divide 60
     * evenly so blocks tile the hour and {type,startTime} stays unique. Any
     * unset/invalid value falls back to 30 (the historical hardcoded default),
     * so behavior is identical until an admin changes it.
     */
    async getCycleDurationMinutes() {
        try {
            const SystemConfig = mongoose.model('SystemConfig');
            const cfg = await SystemConfig.findOne({ key: 'main' }).select('cycleDurationMinutes').lean();
            const d = cfg?.cycleDurationMinutes;
            if (Number.isInteger(d) && d >= 10 && d <= 60 && 60 % d === 0) return d;
        } catch { /* fall through to default */ }
        return 30; // schema default / safe fallback
    }

    start() {
        console.log('🔄 Cycle Generator: Starting...');

        this.isInitialized = false;
        this.isRunning     = false;

        this.initializeCycles().then(() => {
            this.isInitialized = true;
            console.log('✅ Cycle Generator: Initialization complete');
        }).catch(e => {
            console.error('❌ CycleGenerator init error:', e);
            this.isInitialized = true; // unblock even on error
        });

        // ── CYCLE MANAGER (1 000 ms) ────────────────────────────────────────
        // Handles phase transitions, phantom equalizer, new-cycle creation.
        // No separate broadcast loop needed — all public state is pushed via
        // event-driven SSE: cycle_snapshot (connect), cycle_phase (transitions),
        // bet_placed (pools), new_cycle + cycle_result (lifecycle).
        // Timer is derived client-side from endTime, zero server push required.
        setInterval(async () => {
            if (!this.isInitialized) return;
            if (this.isRunning) return;
            this.isRunning = true;
            try {
                await this.manageCycles();
            } catch (e) {
                console.error('❌ CycleGenerator interval error:', e);
            } finally {
                this.isRunning = false;
            }
        }, 1000);

        console.log('✅ Cycle Generator: Intervals started (waiting for init...)');
    }

    async initializeCycles() {
        await this.ensureActive30MinCycle();
        await this.ensureActiveFullDayCycle();
        // Populate broadcast cache with currently-active (non-expired) cycles.
        // ensureActive*Cycle() above already force-expired any stale ones,
        // but guard on endTime here too in case any slip through.
        const nowMs = Date.now();
        const existing = await Cycle.find({ status: { $in: ['OPEN', 'MERGED', 'CLOSED'] } }).lean();
        for (const c of existing) {
            const endMs = new Date(c.endTime).getTime();
            if (endMs > nowMs - 60000) {  // allow 60s grace for cycles in CLOSED/celebration
                this.liveCycleCache[c.type] = c;
            }
        }
    }

    async manageCycles() {
        await this.ensureActive30MinCycle();
        await this.ensureActiveFullDayCycle();
        await this.updateCycleStatuses();
    }

    // ─── EMIT HELPERS ─────────────────────────────────────────────────────────

    // All users (public) — broadcasts over SSE (one-way stream, all clients)
    // SSE is cheaper than WS for broadcast data: no per-client handshake,
    // HTTP/2 multiplexes streams, browser reconnects automatically.
    emitPublic(event, data) {
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
        this.io?.to('admin-room').emit(event, data);
    }

    
    emitUser(userId, event, data) {
        this.io?.to(`user-${userId}`).emit(event, data);
    }

    // ─────────────────────────────────────────────────────────────────────────

    async updateCycleStatuses() {
        try {
            const now = Date.now();

            // Exclude RESULT_DECLARED — GameEngine handles those for payout
            const activeCycles = await Cycle.find({
                status: { $in: ['OPEN', 'MERGED', 'CLOSED'] }
            });

            // Admin-configured phase offsets (cached 30s). Read once per tick,
            // applied to every active cycle below.
            const phases = await this.getCyclePhases();

            for (const cycle of activeCycles) {
                const cycleEndMs = new Date(cycle.endTime).getTime();

                // ── STALE CYCLE FAST-PATH ─────────────────────────────────────
                // If a cycle is in active status but its endTime is already past
                // (server was down, cold start after a gap), skip the normal phase
                // logic and force-complete it immediately so ensureActive*Cycle()
                // can create the correct current cycle on the next tick.
                if (cycleEndMs <= now && cycle.status !== 'CLOSED') {
                    console.warn(`⚠️  updateCycleStatuses: force-closing stale ${cycle.type} cycle ${cycle.cycleId}`);
                    await Cycle.updateOne({ _id: cycle._id }, { status: 'CLOSED' });
                    cycle.status = 'CLOSED';
                }
                if (cycleEndMs <= now - 10000 && cycle.status === 'CLOSED') {
                    // endTime passed + 10s grace → declare result now
                    await this.completeCycle(cycle);
                    continue;
                }
                const is30Min   = cycle.type === '30_MIN';
                const isFullDay = cycle.type === 'FULL_DAY';

                let mergeTime, equalizerTime, betsClosedTime, fireworksTime;

                // Phase offsets from admin config (SystemConfig.cyclePhases),
                // seconds before endTime. Defaults preserve the historical
                // 30-min (3m/2m/30s/10s) and full-day (5m/2m/30s/10s) timings.
                const p = is30Min ? phases.thirtyMin : (isFullDay ? phases.fullDay : null);
                if (p) {
                    mergeTime      = cycleEndMs - (p.mergeBeforeEndSec     * 1000);
                    equalizerTime  = cycleEndMs - (p.equalizerBeforeEndSec * 1000);
                    betsClosedTime = cycleEndMs - (p.closeBeforeEndSec     * 1000);
                    fireworksTime  = cycleEndMs - (p.celebrateBeforeEndSec * 1000);
                }

                // ─── PHASE 1: MERGE ─────────────────────────────────────────
                if (now >= mergeTime && now < equalizerTime && cycle.status === 'OPEN') {
                    await Cycle.updateOne({ _id: cycle._id }, { status: 'MERGED' });
                    cycle.status = 'MERGED';
                    this.emitPublic('cycle_phase', {
                        cycleId: cycle.cycleId,
                        type:    cycle.type,
                        phase:   'MERGED',
                        message: is30Min ? 'Pools merging...' : 'Daily pools merging...',
                        timestamp: new Date()
                    });
                    console.log(`📊 Cycle ${cycle.cycleId} (${cycle.type}): MERGED`);
                }

                // ─── PHASE 2: PHANTOM EQUALIZER ─────────────────────────────
                // Runs silently server-side.
                // Users only see the resulting updated totals via cycle_update.
                if (now >= equalizerTime && now < betsClosedTime && !cycle.phantomBetsClosed) {
                    await this.runPhantomEqualizer(cycle);
                }

                // ─── PHASE 3: BETS CLOSED ───────────────────────────────────
                // BUG 4a FIX: was cycle.status === 'MERGED'. If server missed the MERGED
                // window (DB lag, slow tick), cycle is still OPEN here — Phase 3 was
                // silently skipped and cycle stayed OPEN forever.
                // Fix: allow OPEN or MERGED → both can transition to CLOSED.
                if (now >= betsClosedTime && now < fireworksTime && ['OPEN', 'MERGED'].includes(cycle.status)) {
                    await Cycle.updateOne({ _id: cycle._id }, { status: 'CLOSED' });
                    cycle.status = 'CLOSED';
                    this.emitPublic('cycle_phase', {
                        cycleId: cycle.cycleId,
                        type:    cycle.type,
                        phase:   'CLOSED',
                        message: is30Min
                            ? 'Bets closed! Calculating winner...'
                            : 'Daily bets closed! Calculating winner...',
                        timestamp: new Date()
                    });
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
                    continue; // ← CRITICAL: skip cache-update, cache was evicted inside completeCycle
                }

                // Only reached for cycles that did NOT complete this tick.
                // Refresh cache with latest values so 100ms broadcast is accurate.
                this.liveCycleCache[cycle.type] = cycle;
            }
        } catch (error) {
            console.error('❌ Error updating cycle statuses:', error);
        }
    }

    async completeCycle(cycle) {
        try {
            const realDelhi  = cycle.realDelhi  || 0;
            const realBombay = cycle.realBombay || 0;

            // Winner = minority real-bet side (platform profits from majority)
            let winner;
            if (realDelhi > realBombay) {
                winner = 'BOMBAY';
            } else if (realBombay > realDelhi) {
                winner = 'DELHI';
            } else {
                winner = Math.random() < 0.5 ? 'DELHI' : 'BOMBAY';
            }

            await Cycle.updateOne(
                { _id: cycle._id },
                { status: 'RESULT_DECLARED', winner, completedAt: new Date(), isSettled: 'PENDING' }
            );

            const cycleType      = cycle.type === '30_MIN' ? '30-MIN' : 'FULL-DAY';
            // FIX 2 — send combined totals (same numbers users were watching during betting)
            // Old code sent realDelhi/realBombay — users could infer phantom by comparing to totalDelhi
            const combinedDelhi  = cycle.totalDelhi  || 0;
            const combinedBombay = cycle.totalBombay || 0;

            // Public result — combined pool only
            this.emitPublic('cycle_result', {
                cycleId:   cycle.cycleId,
                type:      cycle.type,
                winner,
                delhiPool:  combinedDelhi,
                bombayPool: combinedBombay,
                message:   `${cycleType} Winner: ${winner}!`,
                timestamp: new Date()
            });

            // Admin result — full breakdown
            this.emitAdmin('admin_cycle_result', {
                cycleId:      cycle.cycleId,
                type:         cycle.type,
                winner,
                realDelhi,
                realBombay,
                phantomDelhi:  cycle.phantomDelhi  || 0,
                phantomBombay: cycle.phantomBombay || 0,
                totalDelhi:    combinedDelhi,
                totalBombay:   combinedBombay,
                timestamp:     new Date()
            });

            // Evict completed cycle from broadcast cache immediately
            delete this.liveCycleCache[cycle.type];
            console.log(`🏆 Cycle ${cycle.cycleId} (${cycleType}) RESULT_DECLARED — Winner: ${winner}`);
            console.log(`   Real bets: Delhi ₹${realDelhi} | Bombay ₹${realBombay}`);

            this.emitPublic('celebration', { cycleId: cycle.cycleId, type: cycle.type, winner });
            this.emitPublic('fireworks',   { cycleId: cycle.cycleId, type: cycle.type, winner, secondsLeft: 10, message: `${winner} wins!`, timestamp: new Date() });

            // Push updated cycle history to ALL clients after result.
            // This replaces the 5-minute HTTP polling interval in GameContext.
            // Small delay so the DB write is committed before we query it.
            setTimeout(async () => {
                try {
                    const cycles = await Cycle.find({ status: 'RESULT_DECLARED' })
                        .sort({ endTime: -1 }).limit(50).lean();
                    this.emitPublic('cycle_history', {
                        cycles: cycles.map(c => {
                            const delhiPool  = c.totalDelhi  || 0;
                            const bombayPool = c.totalBombay || 0;
                            return {
                                id: c.cycleId, type: c.type,
                                startTime: c.startTime, endTime: c.endTime,
                                winner: c.winner, status: c.status,
                                delhiPool, bombayPool,
                                totalDelhi: delhiPool, totalBombay: bombayPool,
                                totalPool: delhiPool + bombayPool,
                            };
                        })
                    });
                } catch (e) { /* non-critical — clients will re-request on next mount */ }
            }, 1500);

            // BUG 4b FIX: celebration lock was 12s, but completeCycle fires at endTime-10s.
            // endTime - 10s + 12s = endTime + 2s → new cycle appeared 2s AFTER timer hit 0.
            // User saw: timer → 00:00 → 2s blank → new cycle. Felt like a 5s gap.
            // Fix: lock = 10s so it expires exactly when the timer hits 00:00 (endTime).
            // New cycle is created at endTime with a 500ms DB-write buffer.
            this.celebrationLockUntil[cycle.type] = Date.now() + 10000;

            // Create next cycle exactly when celebration ends (timer = 00:00).
            // 10500ms = 10s celebration + 500ms buffer for DB write to complete.
            setTimeout(async () => {
                if (cycle.type === '30_MIN') {
                    console.log('🔄 Auto-creating next 30-MIN cycle...');
                    await this.ensureActive30MinCycle();
                } else if (cycle.type === 'FULL_DAY') {
                    console.log('🔄 Auto-creating next FULL-DAY cycle...');
                    await this.ensureActiveFullDayCycle();
                }
            }, 10500);

        } catch (error) {
            console.error('❌ Error completing cycle:', error);
        }
    }

    async runPhantomEqualizer(cycle) {
        try {
            const phantomDelhi  = cycle.phantomDelhi  || 0;
            const phantomBombay = cycle.phantomBombay || 0;

            if (phantomDelhi !== phantomBombay) {
                // Set both sides to the higher value — fully balanced
                const equalizedValue = Math.max(phantomDelhi, phantomBombay);

                await Cycle.updateOne(
                    { _id: cycle._id },
                    {
                        phantomDelhi:    equalizedValue,
                        phantomBombay:   equalizedValue,
                        totalDelhi:      (cycle.realDelhi  || 0) + equalizedValue,
                        totalBombay:     (cycle.realBombay || 0) + equalizedValue,
                        phantomBetsClosed: true,
                        phantomBalanced:   true
                    }
                );

                const cycleType = cycle.type === '30_MIN' ? '30-MIN' : 'FULL-DAY';

                // FIX 3 — phantom_equalized → ADMIN ROOM ONLY
                // Before: this.io.emit('phantom_equalized', ...) → all users saw phantom amounts
                // After:  this.emitAdmin('phantom_equalized', ...) → admins only
                this.emitAdmin('phantom_equalized', {
                    cycleId:       cycle.cycleId,
                    type:          cycle.type,
                    phantomDelhi:  equalizedValue,
                    phantomBombay: equalizedValue,
                    message:       `${cycleType} phantom pools balanced to ₹${equalizedValue}`,
                    timestamp:     new Date()
                });

                console.log(`⚖️  Phantom equalizer: ${cycle.cycleId} (${cycleType}) → ₹${equalizedValue} each side`);
            } else {
                // Already equal — just close phantom betting
                await Cycle.updateOne(
                    { _id: cycle._id },
                    { phantomBetsClosed: true, phantomBalanced: true }
                );
                console.log(`⚖️  Phantom equalizer: ${cycle.cycleId} — already balanced at ₹${phantomDelhi}`);
            }
        } catch (error) {
            console.error('❌ Phantom equalizer error:', error);
        }
    }

    async ensureActive30MinCycle() {
        try {
            // Celebration lock: do not create the next cycle while fireworks are running.
            // manageCycles() ticks every 1 s; without this guard a new OPEN cycle would
            // appear within 1 s of result declaration, making getCycleState return
            // winner=null to any user who loads the page mid-celebration.
            if (Date.now() < this.celebrationLockUntil['30_MIN']) return;

            const existing = await Cycle.findOne({
                type: '30_MIN',
                status: { $in: ['OPEN', 'MERGED', 'CLOSED'] }
            });

            if (existing) {
                const now = Date.now();
                const endMs = new Date(existing.endTime).getTime();
                if (endMs > now) {
                    // Healthy active cycle — nothing to do
                    return;
                }
                // ── STALE CYCLE RECOVERY ─────────────────────────────────────────
                // Server was down (deploy, crash, cold start) while this cycle was live.
                // endTime has already passed but status never advanced to RESULT_DECLARED.
                // Force-expire it so a fresh cycle can be created for the current block.
                console.warn(`⚠️  Stale 30-MIN cycle detected: ${existing.cycleId} (ended ${new Date(endMs).toISOString()}). Force-expiring.`);
                await Cycle.updateOne(
                    { _id: existing._id },
                    { status: 'RESULT_DECLARED', winner: 'DELHI', isSettled: 'PENDING',
                      completedAt: new Date(), _forceExpired: true }
                );
                delete this.liveCycleCache['30_MIN'];
                // Fall through — create the new current-block cycle below
            }

            const now           = new Date();
            const istTime       = new Date(now.getTime() + this.IST_OFFSET);
            const currentMinute = istTime.getUTCMinutes();
            const currentSecond = istTime.getUTCSeconds();

            // ── Cycle duration — admin-configurable (Phase X X-5, 2026-07-10) ─────
            // Was a hardcoded 30*60*1000. SystemConfig.cycleDurationMinutes owns
            // it now; must divide 60 evenly so blocks tile the hour (fallback 30
            // if unset/invalid). The '30_MIN' type label is unchanged — only the
            // window length is tunable.
            const durationMin = await this.getCycleDurationMinutes();

            // ── FIX: start at the CURRENT block boundary (now - elapsed) ──────────
            // OLD (buggy): minutesToAdd = 30 - currentMinute  → future boundary
            //   At 14:23 IST → startTime = 14:30  (7 min in the future)
            //   getCycleState at 14:23 queries startTime≈14:23 → no DB match → 404
            // NEW (correct): elapsed since block start → startTime = now − elapsed.
            // Generalized to any hour-dividing duration:
            //   floor(minute / d) * d  ⇒  {0,30} at d=30, {0,15,30,45} at d=15, …
            const blockStartMinute = Math.floor(currentMinute / durationMin) * durationMin;
            const elapsedMs        = ((currentMinute - blockStartMinute) * 60 + currentSecond) * 1000;
            const startTime        = new Date(now.getTime() - elapsedMs);
            startTime.setMilliseconds(0);
            const endTime = new Date(startTime.getTime() + durationMin * 60 * 1000);

            // FIX 5: Duplicate cycle prevention — use findOneAndUpdate with upsert
            // so that if two service instances or two rapid interval ticks both
            // reach this point simultaneously, only ONE document is created.
            // MongoDB's unique index on {type, startTime} (defined in models/cycle.model.js)
            // guarantees at most one cycle per type per time block.
            // On a duplicate-key error (code 11000) we silently abort — the
            // winning instance already created the cycle.
            let cycle;
            try {
                cycle = await Cycle.findOneAndUpdate(
                    { type: '30_MIN', startTime: startTime.getTime() },
                    {
                        $setOnInsert: {
                            cycleId:           `30MIN_${Date.now()}`,
                            type:              '30_MIN',
                            startTime:         startTime.getTime(),
                            endTime:           endTime.getTime(),
                            status:            'OPEN',
                            realDelhi:         0,
                            realBombay:        0,
                            totalDelhi:        0,
                            totalBombay:       0,
                            phantomDelhi:      0,
                            phantomBombay:     0,
                            phantomBetsClosed: false,
                            isSettled:         'PENDING'
                        }
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
            } catch (err) {
                if (err.code === 11000) {
                    // Another instance just created this cycle — not an error, skip silently.
                    return;
                }
                throw err;
            }
            // If the document already existed (no insert), skip broadcast.
            if (!cycle.__v && cycle.status !== 'OPEN') return;

            this.liveCycleCache['30_MIN'] = cycle;  // seed broadcast cache immediately
            console.log(`🆕 Created new 30-MIN cycle: ${cycle.cycleId}`);
            console.log(`   Start: ${startTime.toISOString()}`);
            console.log(`   End:   ${endTime.toISOString()}`);

            // BUG-DATE FIX: emit timestamps (ms) not Date objects.
            
            // (endTimeMs - nowMs) which returns NaN → broken countdown.
            const st30 = cycle.startTime instanceof Date ? cycle.startTime.getTime() : Number(cycle.startTime);
            const et30 = cycle.endTime   instanceof Date ? cycle.endTime.getTime()   : Number(cycle.endTime);
            const newCyclePayload30 = {
                cycleId:   cycle.cycleId,
                type:      '30_MIN',
                startTime: st30,
                endTime:   et30,
                status:    'OPEN',
                message:   'New 30-minute cycle started!',
                timestamp: Date.now()
            };
            this.emitPublic('new_cycle', newCyclePayload30);
            // Admin gets same payload so their panel updates cycleId state immediately.
            // Without this, admin keeps old cycleId in state → "cycle not found" on actions.
            this.emitAdmin('admin_new_cycle', newCyclePayload30);

            // Also push a fresh cycle_snapshot so any client that missed new_cycle
            // (brief disconnect, slow mobile) gets authoritative state immediately.
            const snapshot = await this.getCycleSnapshotData();
            this.emitPublic('cycle_snapshot', { cycles: snapshot, timestamp: Date.now() });
            this.emitAdmin('admin_cycle_snapshot', { cycles: snapshot, timestamp: Date.now() });

        } catch (error) {
            console.error('❌ Error ensuring 30-min cycle:', error);
        }
    }

    async ensureActiveFullDayCycle() {
        try {
            // Celebration lock — same reason as 30-MIN (see above)
            if (Date.now() < this.celebrationLockUntil['FULL_DAY']) return;

            const existing = await Cycle.findOne({
                type: 'FULL_DAY',
                status: { $in: ['OPEN', 'MERGED', 'CLOSED'] }
            });

            if (existing) {
                const nowMs = Date.now();
                const endMs = new Date(existing.endTime).getTime();
                if (endMs > nowMs) {
                    // Healthy active cycle — nothing to do
                    return;
                }
                // ── STALE CYCLE RECOVERY ─────────────────────────────────────────
                // Server was down while this FULL_DAY cycle was running.
                // This is the exact bug that showed "13 Feb 2026" with a frozen 00:00 timer:
                // the old cycle was still OPEN in DB so ensureActiveFullDayCycle returned
                // immediately and never created the current day's cycle.
                console.warn(`⚠️  Stale FULL_DAY cycle detected: ${existing.cycleId} (ended ${new Date(endMs).toISOString()}). Force-expiring.`);
                await Cycle.updateOne(
                    { _id: existing._id },
                    { status: 'RESULT_DECLARED', winner: 'DELHI', isSettled: 'PENDING',
                      completedAt: new Date(), _forceExpired: true }
                );
                delete this.liveCycleCache['FULL_DAY'];
                // Fall through — create today's cycle below
            }

            const now     = new Date();
            const istTime = new Date(now.getTime() + this.IST_OFFSET);

            // ── FIX: always start at the CURRENT period's 18:00 IST ──────────────
            // OLD (buggy): if (hours >= 18) startDate += 1  → tomorrow 18:00 (future!)
            //   At 20:00 IST → startTime = tomorrow 18:00  (22 h in the future)
            //   Frontend getCycleState at 20:00 queries today 18:00 → no DB match → 404
            // NEW (correct): current cycle always started on the most recent 18:00
            //   Before 18:00 IST → current cycle started YESTERDAY at 18:00
            //   After  18:00 IST → current cycle started TODAY    at 18:00
            let startIST = new Date(istTime);
            startIST.setUTCHours(18, 0, 0, 0);
            if (istTime.getUTCHours() < 18) {
                // We haven't reached today's 18:00 yet — cycle started yesterday
                startIST.setUTCDate(startIST.getUTCDate() - 1);
            }
            // else: at or past 18:00 IST today — cycle started today at 18:00
            const startTime = new Date(startIST.getTime() - this.IST_OFFSET);
            const endTime   = new Date(startTime.getTime() + 24 * 60 * 60 * 1000);

            // FIX 5: Duplicate prevention for FULL_DAY cycles — same pattern as 30_MIN
            let cycle;
            try {
                cycle = await Cycle.findOneAndUpdate(
                    { type: 'FULL_DAY', startTime: startTime.getTime() },
                    {
                        $setOnInsert: {
                            cycleId:           `FULLDAY_${Date.now()}`,
                            type:              'FULL_DAY',
                            startTime:         startTime.getTime(),
                            endTime:           endTime.getTime(),
                            status:            'OPEN',
                            realDelhi:         0,
                            realBombay:        0,
                            totalDelhi:        0,
                            totalBombay:       0,
                            phantomDelhi:      0,
                            phantomBombay:     0,
                            phantomBetsClosed: false,
                            isSettled:         'PENDING'
                        }
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
            } catch (err) {
                if (err.code === 11000) { return; }
                throw err;
            }
            if (!cycle.__v && cycle.status !== 'OPEN') return;

            const startIST2 = new Date(startTime.getTime() + this.IST_OFFSET);
            const endIST2   = new Date(endTime.getTime()   + this.IST_OFFSET);
            this.liveCycleCache['FULL_DAY'] = cycle;  // seed broadcast cache immediately
            console.log(`🆕 Created new FULL-DAY cycle: ${cycle.cycleId}`);
            console.log(`   Start IST: ${startIST2.toISOString()}`);
            console.log(`   End IST:   ${endIST2.toISOString()}`);

            // BUG-DATE FIX: emit timestamps (ms) not Date objects (same root cause as above)
            const stFD = cycle.startTime instanceof Date ? cycle.startTime.getTime() : Number(cycle.startTime);
            const etFD = cycle.endTime   instanceof Date ? cycle.endTime.getTime()   : Number(cycle.endTime);
            const newCyclePayloadFD = {
                cycleId:   cycle.cycleId,
                type:      'FULL_DAY',
                startTime: stFD,
                endTime:   etFD,
                status:    'OPEN',
                message:   'New 24-hour cycle started!',
                timestamp: Date.now()
            };
            this.emitPublic('new_cycle', newCyclePayloadFD);
            this.emitAdmin('admin_new_cycle', newCyclePayloadFD);

            // Push snapshot so all clients get fresh state without HTTP
            const snapshot = await this.getCycleSnapshotData();
            this.emitPublic('cycle_snapshot', { cycles: snapshot, timestamp: Date.now() });
            this.emitAdmin('admin_cycle_snapshot', { cycles: snapshot, timestamp: Date.now() });

        } catch (error) {
            console.error('❌ Error ensuring full-day cycle:', error);
        }
    }

    
    /**
     * Immediately refresh liveCycleCache for a single cycle type after a bet is placed.
     * Without this, broadcastLiveUpdates() would broadcast stale pool totals for up to
     * 1 second (the manageCycles() interval), overwriting the correct value that
     * bet_placed SSE just delivered to the frontend.
     */
    refreshCacheForCycle(cycleDoc) {
        if (!cycleDoc || !cycleDoc.type) return;
        this.liveCycleCache[cycleDoc.type] = cycleDoc;
    }

    async getCycleSnapshotData() {
        // FIX (2026-07-09): was '../models/index.js' which resolves to the
        // nonexistent domains/models/ — a latent runtime bug (dynamic import,
        // so node --check never caught it) that crashed every SSE
        // cycle_snapshot and cycle-ensure. Correct depth is ../../models/.
        const Cycle = (await import('../../models/index.js')).Cycle;
        const types = ['30_MIN', 'FULL_DAY'];
        const snapshot = {};

        for (const type of types) {
            // Primary: active cycle
            let cycle = await Cycle.findOne({
                type,
                status: { $in: ['OPEN', 'MERGED', 'CLOSED', 'RESULT_DECLARED'] }
            }).sort({ startTime: -1 }).lean();

            if (!cycle) continue;

            const now            = Date.now();
            const endTime        = new Date(cycle.endTime).getTime();
            const msLeft         = Math.max(0, endTime - now);
            const timeRemaining  = Math.max(0, Math.floor(msLeft / 1000));
            const timeRemainingMs = msLeft;
            const combinedDelhi  = (cycle.realDelhi  || 0) + (cycle.phantomDelhi  || 0);
            const combinedBombay = (cycle.realBombay || 0) + (cycle.phantomBombay || 0);

            snapshot[type] = {
                cycleId:         cycle.cycleId,
                type:            cycle.type,
                status:          cycle.status,
                startTime:       cycle.startTime instanceof Date
                                   ? cycle.startTime.getTime()
                                   : cycle.startTime,
                endTime:         endTime,
                // SNAPSHOT FIX: was only sending timeRemaining (seconds).
                // CycleControl reads timeRemainingMs first — missing it caused timer = 0 on load.
                timeRemaining,
                timeRemainingMs,
                totalDelhi:      combinedDelhi,
                totalBombay:     combinedBombay,
                delhiPool:       combinedDelhi,
                bombayPool:      combinedBombay,
                winner:          cycle.winner    || null,
                isSettled:       cycle.isSettled || 'PENDING',
                timestamp:       now,
            };
        }

        return snapshot;
    }

    
    async sendCycleSnapshot(socket) {
        try {
            const snapshot = await this.getCycleSnapshotData();
            socket.emit('cycle_snapshot', { cycles: snapshot, timestamp: Date.now() });
        } catch (err) {
            console.error('❌ sendCycleSnapshot error:', err);
        }
    }

    async getActiveCycles() {
        try {
            return await Cycle.find({
                status: { $in: ['OPEN', 'MERGED', 'CLOSED'] }
            }).select('cycleId type status startTime endTime realDelhi realBombay phantomDelhi phantomBombay');
        } catch (error) {
            console.error('❌ Error getting active cycles:', error);
            return [];
        }
    }
}

export default CycleGenerator;
