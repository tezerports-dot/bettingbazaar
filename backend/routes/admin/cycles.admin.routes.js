// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** cycles.admin.routes.js — Cycle phases, history, equalization, manage-cycle */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from './_adminShared.js';
import { db } from '#db';
import { isCycleType, phasesFor } from '../../domains/markets/cycleTypes.js';
import { DEFAULT_CYCLE_PHASES } from '../../domains/configuration/systemConfig.model.js';
import { getSystemConfig } from '#db/repositories/config.js';

const router = express.Router();

router.get('/cycles/phases', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const now = Date.now();
    // Cycles AND their pools in one statement. Reading the pools per cycle was
    // two round trips each, and each one saw the database at its own instant —
    // so two rows on the same board could disagree about a bet placed while the
    // page loaded. PAUSED is included: a paused cycle is still live, and the
    // board that shows an operator what is running must show it.
    const activeCycles = await db.markets.activeCyclesWithPools();
    
    // Phase offsets come from the SAME admin config the generator acts on
    // (SystemConfig.cyclePhases, resolved per type through the registry).
    //
    // These were hardcoded here as 3min/2min/1min-or-5min, which was wrong in
    // two directions at once: it had already drifted from the generator's own
    // defaults (which close bets at 30s, not 60s), so this screen reported a
    // phase boundary the engine did not act on; and for any type it did not
    // know it fell through to the full-day arm, which for a 1-minute cycle
    // puts "merge" five minutes before a block that lasts sixty seconds.
    // Reading the config is the only version that cannot drift.
    const cfg = await getSystemConfig();

    const cyclesWithPhases = activeCycles.map(cycle => {
      // An unrecognised type is skipped rather than defaulted. `phasesFor`
      // throws on one, and this endpoint draws the whole live-cycle board —
      // one stray row must not 500 the screen an operator watches the platform
      // through.
      if (!isCycleType(cycle.type)) return null;
      const p = phasesFor(cycle.type, cfg?.cyclePhases)
        || phasesFor(cycle.type, DEFAULT_CYCLE_PHASES);

      // Epoch millis, because the phase arithmetic below subtracts seconds
      // from them. The rows carry Date objects; subtracting a number from a
      // Date works by coercion but adding one back gives a string, and the
      // response's phase boundaries would have gone out as concatenated text.
      const endMs   = new Date(cycle.endTime).getTime();
      const startMs = new Date(cycle.startTime).getTime();

      const mergeTime      = endMs - (p.mergeBeforeEndSec     * 1000);
      const equalizerTime  = endMs - (p.equalizerBeforeEndSec * 1000);
      const betsClosedTime = endMs - (p.closeBeforeEndSec     * 1000);
      
      // Determine current phase
      let currentPhase = 'OPEN';
      if (now >= betsClosedTime) currentPhase = 'CLOSED';
      else if (now >= equalizerTime) currentPhase = 'PHANTOM_EQUALIZING';
      else if (now >= mergeTime) currentPhase = 'MERGED';
      
      return {
        cycleId: cycle.cycleId,
        type: cycle.type,
        status: cycle.status,
        currentPhase,
        startTime: startMs,
        endTime: endMs,
        phases: {
          open: { start: startMs, end: mergeTime },
          merge: { start: mergeTime, end: equalizerTime },
          equalizer: { start: equalizerTime, end: betsClosedTime },
          closed: { start: betsClosedTime, end: endMs }
        },
        pools: {
          totalDelhi: cycle.totalDelhi,
          totalBombay: cycle.totalBombay,
          realDelhi: cycle.realDelhi,
          realBombay: cycle.realBombay,
          phantomDelhi: cycle.phantomDelhi,
          phantomBombay: cycle.phantomBombay
        },
        phantomBalanced: cycle.phantomBalanced
      };
    }).filter(Boolean);
    
    res.json({
      success: true,
      cycles: cyclesWithPhases
    });
  } catch (error) {
    console.error('Get cycle phases error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch cycle phases' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/cycles/history
// Returns settled/completed cycles for the admin cycle history page.
// Includes full real/phantom breakdown (admin-only data).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cycles/history', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, type } = req.query;
    // The page and its total come from one statement, so the pagination an
    // admin clicks through matches the rows in front of them.
    const history = await db.markets.cycleHistory({
      cycleType: type || null, page, limit,
    });

    res.json({
      success: true,
      cycles: history.cycles.map((c) => ({
        _id: c.cycleId,
        cycleId: c.cycleId,
        type: c.type,
        status: c.status,
        startTime: c.startTime,
        endTime: c.endTime,
        winner: c.winner,
        // Real pools are DERIVED from the bets — the columns the old response
        // read (`realDelhi`, `totalDelhi`) were never on the cycle row, so
        // every one of them fell through to its `|| 0` and the admin history
        // showed zero volume on every settled cycle the platform had run.
        realDelhi: c.realDelhi, realBombay: c.realBombay,
        phantomDelhi: c.phantomDelhi, phantomBombay: c.phantomBombay,
        totalDelhi: c.totalDelhi, totalBombay: c.totalBombay,
        isSettled: c.isSettled,
        totalPaidOut: c.totalPaidOut,
        netProfit: c.netProfit,
        winnerDeterminedBy: c.winnerDeterminedBy || 'AUTOMATIC',
        settledAt: c.settledAt,
      })),
      pagination: {
        total: history.total, page: history.page,
        limit: history.limit, pages: history.pages,
      },
    });
  } catch (error) {
    console.error('Get cycle history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch cycle history' });
  }
});

// Manual phantom equalizer trigger (emergency use)
router.post('/cycles/:cycleId/equalize', authenticate, isAdmin, async (req, res) => {
  try {
    const { cycleId } = req.params;
    // The levelling arithmetic runs IN the statement. The handler this replaced
    // read both phantom pools, took their max in JavaScript and saved both
    // back, so a phantom bet landing in between was silently overwritten.
    const result = await db.markets.equalizePhantomPools(cycleId);

    if (!result.ok) {
      return result.reason === 'NOT_FOUND'
        ? res.status(404).json({ success: false, message: 'Cycle not found' })
        : res.status(409).json({
          success: false,
          message: `Cycle already has a result (${result.winner}) — its pools are final`,
        });
    }

    const { cycle } = result;
    global.io?.emit('phantom_equalized', {
      cycleId: cycle.cycleId,
      totalDelhi: cycle.totalDelhi,
      totalBombay: cycle.totalBombay,
    });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByRole: 'admin',
      action: 'CYCLE_PHANTOM_EQUALIZED', category: 'MARKETS',
      targetType: 'Cycle', targetId: String(cycleId),
      details: { phantomDelhi: cycle.phantomDelhi, phantomBombay: cycle.phantomBombay },
    });

    res.json({
      success: true,
      message: 'Phantom equalizer executed',
      cycle: {
        cycleId: cycle.cycleId,
        totalDelhi: cycle.totalDelhi, totalBombay: cycle.totalBombay,
        phantomDelhi: cycle.phantomDelhi, phantomBombay: cycle.phantomBombay,
      },
    });
  } catch (error) {
    console.error('Manual equalize error:', error);
    res.status(500).json({ success: false, message: 'Failed to equalize phantom bets' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ✅ FIX #4: TOKEN RATE MANAGEMENT ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

// HIGH-04 FIX: GET /token-rates removed from cycles.admin.routes.js.
// The canonical version lives in system.admin.routes.js and is mounted first.
// This duplicate was shadowing the system version (wrong response shape).
// Removed to eliminate the route conflict.

/**
 * Admin cycle control: pause, resume, cancel, force a result.
 *
 * ── Every branch moved two fields with a read-modify-write ─────────────────
 * The handler this replaced loaded the cycle, mutated it in JavaScript and
 * saved it back. Three defects came out of that shape and none of them are
 * here:
 *
 *   • RESUME set status to OPEN unconditionally, so resuming a cycle past its
 *     betting window REOPENED it — bets accepted after close, on a round whose
 *     result was about to be declared.
 *   • CANCEL and FORCE_RESULT did not check whether the cycle had already
 *     settled, so an admin could cancel a round whose payouts were already in
 *     players' wallets, or declare a second, different winner over one.
 *   • FORCE_RESULT assigned `winner` and `status` as two statements in a
 *     document that was then saved — trap 3. The winner must be written with
 *     the status or before it; a cycle that is RESULT_DECLARED with no winner
 *     is offered to settlement and settles nothing.
 *
 * Each action is now one guarded UPDATE that either applies in full or reports
 * why it could not.
 */
router.post('/manage-cycle', authenticate, isAdmin, async (req, res) => {
  try {
    const { action, cycleId, payload } = req.body;
    if (!cycleId) return res.status(400).json({ success: false, message: 'cycleId is required' });

    const refuse = (result) => {
      const status = result.reason === 'NOT_FOUND' ? 404 : 409;
      const message = {
        NOT_FOUND: 'Cycle not found',
        NOT_PAUSABLE: `Cycle is ${result.status} and cannot be paused or resumed`,
        ALREADY_CANCELLED: 'Cycle is already cancelled',
        ALREADY_DECLARED: `Cycle already has a result: ${result.winner}`,
      }[result.reason] ?? 'Cycle cannot accept that action';
      return res.status(status).json({ success: false, message });
    };

    let result;
    switch (action?.toUpperCase()) {
      case 'PAUSE':
        result = await db.markets.setPaused(cycleId, true);
        if (!result.ok) return refuse(result);
        global.io?.emit('cycle_phase', { cycleId, phase: 'PAUSED', message: 'Cycle paused by admin' });
        break;

      case 'RESUME':
        result = await db.markets.setPaused(cycleId, false);
        if (!result.ok) return refuse(result);
        // The phase is whatever the row settled on, not an assumed OPEN: a
        // cycle resumed past its window comes back CLOSED and the clients need
        // to hear that, or they will offer a bet the server refuses.
        global.io?.emit('cycle_phase', {
          cycleId, phase: result.cycle.status,
          message: `Cycle resumed by admin (${result.cycle.status})`,
        });
        break;

      case 'CANCEL':
        result = await db.markets.cancelCycle(cycleId, { by: req.user.userId });
        if (!result.ok) return refuse(result);
        global.io?.emit('cycle_phase', { cycleId, phase: 'CANCELLED', message: 'Cycle cancelled by admin' });
        break;

      case 'FORCE_RESULT': {
        const winner = payload?.winner;
        if (!['DELHI', 'BOMBAY'].includes(winner)) {
          return res.status(400).json({ success: false, message: 'winner must be DELHI or BOMBAY' });
        }
        // The same function the engine declares through, so there is one owner
        // of "this cycle has a result" — and one guard refusing a second one.
        result = await db.markets.declareWinner(cycleId, winner, { by: `admin:${req.user.userId}` });
        if (!result.ok) return refuse(result);
        global.io?.emit('cycle_result', { cycleId, winner, forced: true });
        break;
      }

      default:
        return res.status(400).json({ success: false, message: `Unknown action: ${action}` });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByRole: req.user.isAdmin ? 'admin' : 'subadmin',
      action: `CYCLE_${action.toUpperCase()}`, category: 'MARKETS',
      targetType: 'Cycle', targetId: String(cycleId),
      details: { winner: payload?.winner ?? null, status: result.cycle.status },
    });

    res.json({
      success: true,
      message: `Action '${action}' applied to cycle ${cycleId}`,
      cycle: result.cycle,
    });
  } catch (error) {
    console.error('Manage cycle error:', error);
    res.status(500).json({ success: false, message: 'Failed to manage cycle' });
  }
});

export default router;
