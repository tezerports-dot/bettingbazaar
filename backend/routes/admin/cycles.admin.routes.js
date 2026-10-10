// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** cycles.admin.routes.js — Cycle phases, history, equalization, manage-cycle */
import {
  authenticate, express, hasPermission,
} from './_adminShared.js';
import { db } from '#db';
import { allBoards } from '../../domains/markets/cycleTypes.js';
import { voidCancelledCycle } from '#db/repositories/settlements.js';
import { sendAlert } from '../../services/alerting.service.js';
import { emitCyclePhase, emitCycleResult } from '../../domains/notification/realtimeEmitters.js';

const router = express.Router();

router.get('/cycles/phases', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    const now = Date.now();
    // Cycles AND their pools in one statement. Reading the pools per cycle was
    // two round trips each, and each one saw the database at its own instant —
    // so two rows on the same board could disagree about a bet placed while the
    // page loaded. PAUSED is included: a paused cycle is still live, and the
    // board that shows an operator what is running must show it.
    const activeCycles = await db.markets.activeCyclesWithPools();
    
    // Phase offsets come from the SAME board rows the generator acts on.
    // Hardcoding them here once drew phase boundaries the engine did not act on.
    const byKey = new Map((await allBoards()).map((b) => [b.key, b]));

    const cyclesWithPhases = activeCycles.map(cycle => {
      // A cycle whose board cannot be read is skipped rather than defaulted:
      // this endpoint draws the whole live-cycle board, and one stray row must
      // not 500 the screen an operator watches the platform through.
      const board = byKey.get(cycle.type);
      if (!board) return null;
      const p = board.phases;

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
        audience: cycle.audience,
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
router.get('/cycles/history', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
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
        audience: c.audience,
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
router.post('/cycles/:cycleId/equalize', authenticate, hasPermission('canManageCycles'), async (req, res) => {
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
router.post('/manage-cycle', authenticate, hasPermission('canManageCycles'), async (req, res) => {
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
        emitCyclePhase({ cycleId, type: result.cycle.type, audience: result.cycle.audience, phase: 'PAUSED' });
        break;

      case 'RESUME':
        result = await db.markets.setPaused(cycleId, false);
        if (!result.ok) return refuse(result);
        // The phase is whatever the row settled on, not an assumed OPEN: a
        // cycle resumed past its window comes back CLOSED and the clients need
        // to hear that, or they will offer a bet the server refuses.
        emitCyclePhase({ cycleId, type: result.cycle.type, audience: result.cycle.audience, phase: result.cycle.status });
        break;

      case 'CANCEL': {
        result = await db.markets.cancelCycle(cycleId, { by: req.user.userId });
        if (!result.ok) return refuse(result);
        emitCyclePhase({ cycleId, type: result.cycle.type, audience: result.cycle.audience, phase: 'CANCELLED' });
        // Return every stake NOW, so the players see their money back. The
        // cancel has committed, so a failure here must not become a 500 (§21):
        // the engine's recovery sweep finishes whatever this does not.
        const voiding = await voidCancelledCycle(cycleId, { actor: `admin:${req.user.userId}` })
          .catch((e) => ({ ok: false, reason: e.message }));
        if (!voiding.ok || voiding.refused?.length) {
          sendAlert('settlement-error', 'Stakes on a cancelled cycle were not all returned', {
            cycleId, reason: voiding.reason ?? null, refused: voiding.refused?.slice(0, 10) ?? [],
          }).catch(() => {});
        }
        result = { ...result, stakesReturned: voiding.voided ?? 0, stakesPending: !voiding.ok || voiding.refused?.length > 0 };
        break;
      }

      case 'FORCE_RESULT': {
        const winner = payload?.winner;
        if (!['DELHI', 'BOMBAY'].includes(winner)) {
          return res.status(400).json({ success: false, message: 'winner must be DELHI or BOMBAY' });
        }
        // The same function the engine declares through, so there is one owner
        // of "this cycle has a result" — and one guard refusing a second one.
        result = await db.markets.declareWinner(cycleId, winner, { by: `admin:${req.user.userId}` });
        if (!result.ok) return refuse(result);
        // Disclosed in the board rules ("exceptional situations"); `f: 1` on the wire.
        emitCycleResult({ cycleId, type: result.cycle.type, audience: result.cycle.audience, winner, forced: true });
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
      message: result.stakesPending
        ? `Cycle ${cycleId} cancelled. ${result.stakesReturned} stake(s) returned; the rest are still being returned and will be within 5 minutes.`
        : result.stakesReturned !== undefined
          ? `Cycle ${cycleId} cancelled. ${result.stakesReturned} stake(s) returned to players.`
          : `Action '${action}' applied to cycle ${cycleId}`,
      cycle: result.cycle,
      ...(result.stakesReturned !== undefined ? { stakesReturned: result.stakesReturned } : {}),
    });
  } catch (error) {
    console.error('Manage cycle error:', error);
    res.status(500).json({ success: false, message: 'Failed to manage cycle' });
  }
});

export default router;
