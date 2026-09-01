// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { Cycle } from '../../models/index.js';
import { fetchCycleHistory } from './cycleHistory.service.js';
// Fallback phase offsets when SystemConfig is missing or fails validPhaseSet.
// Imported, never restated — see the header on DEFAULT_CYCLE_PHASES.
import { DEFAULT_CYCLE_PHASES } from '../configuration/systemConfig.model.js';
import mongoose from 'mongoose';
// Derived cycle pools (FLAGS.DERIVED_CYCLE_POOLS, default off) — see
// cyclePool.service.js for why the running total is the scaling ceiling.
import { derivedPoolsEnabled, refreshRealPools } from './cyclePool.service.js';
// Public cycle payloads must never carry real/phantom pools (they reveal the
// minority-side winner). assertPublicCycleSafe throws if one slips in.
import { assertPublicCycleSafe } from './cyclePublicView.js';
// One vocabulary for cycle types — labels, which config keys hold each type's
// phases and stake limits, and which types tile the hour. See cycleTypes.js for
// why this is a module and not a set of ternaries.
import {
  CYCLE_TYPES, CYCLE_TYPE_VALUES, INTERVAL_CYCLE_TYPES,
  isCycleType, cycleMeta, cycleLabel, phasesFor,
} from './cycleTypes.js';
// The cycle's Postgres row: the thing the money path locks. See cyclePg.js.
import { ensureCycle } from '../../postgres/cyclePg.js';

// ── CYCLE PHASE OFFSETS (Business Config Audit, 2026-07-11) ───────────────────
// Seconds BEFORE a cycle's endTime that each phase fires. Previously hardcoded
// inline in updateCycleStatuses(). Now admin-editable via SystemConfig.cyclePhases;
// these are the historical defaults AND the safe fallback used whenever config is
// unset or fails the ordering invariant. Invariant: merge > equalizer > close >
// celebrate > 0 (each phase strictly earlier than the next, all within the block).
//
// Keys here are the `phasesKey` values in cycleTypes.js. The 1-minute block's
// margins are seconds rather than minutes, which is the whole point of it.
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
        // Built from the type registry, so a new type cannot be left out of the
        // lock and start its next block mid-celebration.
        this.celebrationLockUntil = Object.fromEntries(CYCLE_TYPE_VALUES.map(t => [t, 0]));
        // In-memory cache of active cycles — updated by manageCycles() every 1s,
        // read by broadcastLiveUpdates() in the same tick with zero DB hits.
        this.liveCycleCache = {};  // { [cycleType]: cycleDoc } — see CYCLE_TYPE_VALUES
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
                // Merged and validated per key, so one bad admin value falls back
                // to that type's defaults without disturbing the others.
                result = Object.fromEntries(
                    Object.keys(DEFAULT_CYCLE_PHASES).map((key) => {
                        const merged = { ...DEFAULT_CYCLE_PHASES[key], ...(cp[key] || {}) };
                        return [key, validPhaseSet(merged) ? merged : DEFAULT_CYCLE_PHASES[key]];
                    }),
                );
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
        // Every interval type, from the registry — so adding one to cycleTypes.js
        // is genuinely all it takes, rather than one edit here and another that
        // gets forgotten in manageCycles().
        for (const type of INTERVAL_CYCLE_TYPES) await this.ensureIntervalCycle(type);
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
        for (const type of INTERVAL_CYCLE_TYPES) await this.ensureIntervalCycle(type);
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
                // A type the registry does not know cannot be phased safely, and
                // throwing here would abandon every OTHER cycle in this tick —
                // including one waiting to be settled. Skip it loudly instead.
                if (!isCycleType(cycle.type)) {
                    console.error(`❌ updateCycleStatuses: unknown cycle type '${cycle.type}' on ${cycle.cycleId} — skipping`);
                    continue;
                }
                const meta = cycleMeta(cycle.type);

                let mergeTime, equalizerTime, betsClosedTime, fireworksTime;

                // Phase offsets from admin config (SystemConfig.cyclePhases),
                // seconds before endTime, resolved through the type registry.
                // Defaults preserve the historical 30-min (3m/2m/30s/10s) and
                // full-day (5m/2m/30s/10s) timings, and give the 1-min block
                // 12s/9s/5s/3s.
                //
                // An unrecognised type yields no offsets and therefore no phase
                // transitions at all — deliberately inert rather than guessed,
                // since guessing here would close betting or declare a winner at
                // an arbitrary moment.
                const p = phasesFor(cycle.type, phases);
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
                        message: meta.mergeMessage,
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
                        message: meta.closeMessage,
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
            const derived = await derivedPoolsEnabled();
            const exactPools = await refreshRealPools(cycle.cycleId, { exact: true }).catch((e) => {
                console.error(`[Cycle] exact pool refresh failed for ${cycle.cycleId}:`, e.message);
                return null;
            });
            if (derived && !exactPools) {
                console.error(`[Cycle] ⛔ Refusing to settle ${cycle.cycleId} on unverified pools — retrying next tick.`);
                return;
            }
            const realDelhi  = exactPools ? exactPools.realDelhi  : (cycle.realDelhi  || 0);
            const realBombay = exactPools ? exactPools.realBombay : (cycle.realBombay || 0);

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

            const cycleType      = cycleLabel(cycle.type);
            // FIX 2 — send combined totals (same numbers users were watching during betting)
            // Old code sent realDelhi/realBombay — users could infer phantom by comparing to totalDelhi
            //
            // Recomputed from the exact pools rather than read off `cycle`: the
            // refresh above rewrote realDelhi/totalDelhi in the database, but
            // this in-memory document was loaded before that and still carries
            // the pre-refresh totals. Publishing those would announce a final
            // result that disagrees with the settled cycle.
            const combinedDelhi  = exactPools
                ? realDelhi  + (cycle.phantomDelhi  || 0)
                : (cycle.totalDelhi  || 0);
            const combinedBombay = exactPools
                ? realBombay + (cycle.phantomBombay || 0)
                : (cycle.totalBombay || 0);

            // Public result — combined pool only, guarded against a real/phantom
            // field being added here later.
            this.emitPublic('cycle_result', assertPublicCycleSafe({
                cycleId:   cycle.cycleId,
                type:      cycle.type,
                winner,
                delhiPool:  combinedDelhi,
                bombayPool: combinedBombay,
                message:   `${cycleType} Winner: ${winner}!`,
                timestamp: new Date()
            }));

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

            // Celebration length is this type's celebrate offset: the window
            // between the result being declared and endTime. Hardcoding 10 here
            // would tell a 1-minute client to celebrate for 10s of a 60s block
            // and leave it counting down through the next cycle's betting.
            const celebrateSec = (await this.getCyclePhases())?.[cycleMeta(cycle.type).phasesKey]
                ?.celebrateBeforeEndSec ?? 10;

            this.emitPublic('celebration', { cycleId: cycle.cycleId, type: cycle.type, winner });
            this.emitPublic('fireworks',   { cycleId: cycle.cycleId, type: cycle.type, winner, secondsLeft: celebrateSec, message: `${winner} wins!`, timestamp: new Date() });

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
                    this.emitPublic('cycle_history', await fetchCycleHistory({ types: cycle.type }));
                } catch (e) { /* non-critical — clients will re-request on next mount */ }
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
            this.celebrationLockUntil[cycle.type] = Date.now() + celebrateSec * 1000;

            // Create the next cycle as celebration ends (timer = 00:00), plus a
            // 500ms buffer for the DB write to land.
            setTimeout(async () => {
                console.log(`🔄 Auto-creating next ${cycleType} cycle...`);
                await this.ensureActiveCycle(cycle.type);
            }, celebrateSec * 1000 + 500);

        } catch (error) {
            console.error('❌ Error completing cycle:', error);
        }
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
            // Guard on phantomBetsClosed rather than a snapshot comparison:
            // makes the write idempotent if two ticks overlap. `new: false`
            // returns the PRE-image — the exact document the pipeline ran
            // against — so the equalized figure and the "was it already
            // balanced?" decision come from what the write actually saw, in
            // one round trip and with no second read to go stale.
            const before = await Cycle.findOneAndUpdate(
                { _id: cycle._id, phantomBetsClosed: false },
                [
                    // Stage 1 — both phantom sides go to the higher of the two.
                    // Every expression in a $set stage is evaluated against the
                    // stage's INPUT, so both fields see the original pair.
                    { $set: { phantomDelhi:  { $max: ['$phantomDelhi', '$phantomBombay'] },
                              phantomBombay: { $max: ['$phantomDelhi', '$phantomBombay'] } } },
                    // Stage 2 — restore total = real + phantom against the
                    // equalized values from stage 1. realDelhi and realBombay
                    // are READ here and never written: real money belongs to
                    // the bet routes' $inc alone.
                    { $set: { totalDelhi:  { $add: ['$realDelhi',  '$phantomDelhi'] },
                              totalBombay: { $add: ['$realBombay', '$phantomBombay'] },
                              phantomBetsClosed: true,
                              phantomBalanced:   true } },
                ],
                { new: false }
            );

            // Another tick already closed phantom betting — nothing to announce.
            if (!before) return;

            const priorDelhi  = before.phantomDelhi  || 0;
            const priorBombay = before.phantomBombay || 0;
            const equalizedValue = Math.max(priorDelhi, priorBombay);
            const cycleType = cycleLabel(cycle.type);

            if (priorDelhi === priorBombay) {
                // Nothing to balance — the write only closed phantom betting.
                console.log(`⚖️  Phantom equalizer: ${cycle.cycleId} — already balanced at ₹${equalizedValue}`);
                return;
            }

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
        } catch (error) {
            console.error('❌ Phantom equalizer error:', error);
        }
    }

    /**
     * ensureActiveCycle — create/refresh the live cycle of one type.
     *
     * The dispatcher every caller should use. Interval types (the ones whose
     * blocks tile the hour) share one implementation; FULL_DAY is anchored to a
     * calendar date and keeps its own.
     */
    async ensureActiveCycle(type) {
        if (type === CYCLE_TYPES.FULL_DAY) return this.ensureActiveFullDayCycle();
        return this.ensureIntervalCycle(type);
    }

    /**
     * ensureIntervalCycle — the creation path shared by every hour-tiling type.
     *
     * ── Why this is parameterised and not copied ───────────────────────────
     * This was `ensureActive30MinCycle`, ~130 lines of celebration-lock check,
     * stale-cycle recovery, block anchoring, upsert-with-unique-index, and four
     * broadcasts. Adding the 1-minute block by copying it would have produced a
     * third near-identical body (`ensureActiveFullDayCycle` is already the
     * second), and the copies drift: every one of the numbered bug fixes in the
     * comments below would have needed applying three times, by someone who
     * first had to notice there were three.
     *
     * The only things that actually differ per type are the block length, the
     * cycleId prefix and the announcement text — all of which live in
     * cycleTypes.js. Everything else, including every fix below, is identical
     * by construction now.
     */
    async ensureIntervalCycle(type) {
        const meta = cycleMeta(type);
        const label = meta.label;
        try {
            // Celebration lock: do not create the next cycle while fireworks are running.
            // manageCycles() ticks every 1 s; without this guard a new OPEN cycle would
            // appear within 1 s of result declaration, making getCycleState return
            // winner=null to any user who loads the page mid-celebration.
            if (Date.now() < this.celebrationLockUntil[type]) return;

            const existing = await Cycle.findOne({
                type,
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
                console.warn(`⚠️  Stale ${label} cycle detected: ${existing.cycleId} (ended ${new Date(endMs).toISOString()}). Force-expiring.`);
                await Cycle.updateOne(
                    { _id: existing._id },
                    { status: 'RESULT_DECLARED', winner: 'DELHI', isSettled: 'PENDING',
                      completedAt: new Date(), _forceExpired: true }
                );
                delete this.liveCycleCache[type];
                // Fall through — create the new current-block cycle below
            }

            const now           = new Date();
            const istTime       = new Date(now.getTime() + this.IST_OFFSET);
            const currentMinute = istTime.getUTCMinutes();
            const currentSecond = istTime.getUTCSeconds();

            // ── Block length ──────────────────────────────────────────────────────
            // Fixed for types that declare one (the 1-minute block); otherwise
            // admin-configurable via SystemConfig.cycleDurationMinutes, which must
            // divide 60 evenly so blocks tile the hour (fallback 30 if unset or
            // invalid). The type LABEL never changes when that value does.
            const durationMin = meta.fixedDurationMin ?? await this.getCycleDurationMinutes();

            // ── FIX: start at the CURRENT block boundary (now - elapsed) ──────────
            // OLD (buggy): minutesToAdd = 30 - currentMinute  → future boundary
            //   At 14:23 IST → startTime = 14:30  (7 min in the future)
            //   getCycleState at 14:23 queries startTime≈14:23 → no DB match → 404
            // NEW (correct): elapsed since block start → startTime = now − elapsed.
            // Generalized to any hour-dividing duration:
            //   floor(minute / d) * d  ⇒  {0,30} at d=30, {0,15,30,45} at d=15,
            //   and every minute at d=1.
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
                    { type, startTime: startTime.getTime() },
                    {
                        $setOnInsert: {
                            cycleId:           `${meta.idPrefix}_${Date.now()}`,
                            type,
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

            // ── The cycle's PostgreSQL row ───────────────────────────────────
            // `betPg.placeBet` takes this row's SHARED lock and refuses when
            // there is none, so the row is not a mirror: without it every stake
            // on this cycle is rejected as `cycle_not_found`. Awaited and
            // allowed to throw for exactly that reason — a silent failure here
            // is a board that takes no bets, and finding that out from a player
            // is worse than finding it out from a crash.
            await ensureCycle({
                cycleId:   cycle.cycleId,
                type:      cycle.type,
                startTime: cycle.startTime instanceof Date ? cycle.startTime.getTime() : Number(cycle.startTime),
                endTime:   cycle.endTime   instanceof Date ? cycle.endTime.getTime()   : Number(cycle.endTime),
                status:    cycle.status || 'OPEN',
            });

            this.liveCycleCache[type] = cycle;  // seed broadcast cache immediately
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
                startTime: startMs,
                endTime:   endMs,
                status:    'OPEN',
                message:   meta.newCycleMessage,
                timestamp: Date.now()
            };
            this.emitPublic('new_cycle', newCyclePayload);
            // Admin gets same payload so their panel updates cycleId state immediately.
            // Without this, admin keeps old cycleId in state → "cycle not found" on actions.
            this.emitAdmin('admin_new_cycle', newCyclePayload);

            // Also push a fresh cycle_snapshot so any client that missed new_cycle
            // (brief disconnect, slow mobile) gets authoritative state immediately.
            const snapshot = await this.getCycleSnapshotData();
            this.emitPublic('cycle_snapshot', { cycles: snapshot, timestamp: Date.now() });
            this.emitAdmin('admin_cycle_snapshot', { cycles: snapshot, timestamp: Date.now() });

        } catch (error) {
            console.error(`❌ Error ensuring ${label} cycle:`, error);
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

            // ── The cycle's PostgreSQL row ───────────────────────────────────
            // `betPg.placeBet` takes this row's SHARED lock and refuses when
            // there is none, so the row is not a mirror: without it every stake
            // on this cycle is rejected as `cycle_not_found`. Awaited and
            // allowed to throw for exactly that reason — a silent failure here
            // is a board that takes no bets, and finding that out from a player
            // is worse than finding it out from a crash.
            await ensureCycle({
                cycleId:   cycle.cycleId,
                type:      cycle.type,
                startTime: cycle.startTime instanceof Date ? cycle.startTime.getTime() : Number(cycle.startTime),
                endTime:   cycle.endTime   instanceof Date ? cycle.endTime.getTime()   : Number(cycle.endTime),
                status:    cycle.status || 'OPEN',
            });

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
        // Every known type — a snapshot that omits one leaves clients with no
        // authoritative state for that tab until the next new_cycle fires.
        const types = CYCLE_TYPE_VALUES;
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

            // Wrapped: this is the live state pushed to every connecting client,
            // so it is the highest-value place to prove no real/phantom pool
            // leaks. It carries timing fields publicCycleView does not, so it is
            // hand-built and guarded rather than produced by the serializer.
            snapshot[type] = assertPublicCycleSafe({
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
            });
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
