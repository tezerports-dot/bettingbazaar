// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** cycles.admin.routes.js — Cycle phases, history, equalization, manage-cycle */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from './_adminShared.js';

const router = express.Router();

router.get('/cycles/phases', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { Cycle } = getModels();
    
    const now = Date.now();
    const activeCycles = await Cycle.find({
      status: { $in: ['OPEN', 'MERGED', 'CLOSED'] },
      endTime: { $gte: now }
    }).sort({ startTime: 1 });
    
    const cyclesWithPhases = activeCycles.map(cycle => {
      const is30Min = cycle.type === '30_MIN';
      
      // Calculate phase timestamps
      const mergeTime = is30Min 
        ? cycle.endTime - (3 * 60 * 1000)
        : cycle.endTime - (5 * 60 * 1000);
      
      const equalizerTime = is30Min
        ? cycle.endTime - (2 * 60 * 1000)
        : cycle.endTime - (2 * 60 * 1000);
      
      const betsClosedTime = is30Min
        ? cycle.endTime - (60 * 1000)
        : cycle.endTime - (60 * 1000);
      
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
        startTime: cycle.startTime,
        endTime: cycle.endTime,
        phases: {
          open: { start: cycle.startTime, end: mergeTime },
          merge: { start: mergeTime, end: equalizerTime },
          equalizer: { start: equalizerTime, end: betsClosedTime },
          closed: { start: betsClosedTime, end: cycle.endTime }
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
    });
    
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
    const { Cycle } = getModels();
    const { page = 1, limit = 50, type } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { status: { $in: ['RESULT_DECLARED', 'COMPLETED', 'CANCELLED'] } };
    if (type) query.type = type;

    const [cycles, total] = await Promise.all([
      Cycle.find(query)
        .sort({ endTime: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Cycle.countDocuments(query),
    ]);

    res.json({
      success: true,
      cycles: cycles.map(c => ({
        _id: c._id,
        cycleId: c.cycleId,
        type: c.type,
        status: c.status,
        startTime: c.startTime,
        endTime: c.endTime,
        winner: c.winner || null,
        realDelhi: c.realDelhi || 0,
        realBombay: c.realBombay || 0,
        phantomDelhi: c.phantomDelhi || 0,
        phantomBombay: c.phantomBombay || 0,
        totalDelhi: c.totalDelhi || 0,
        totalBombay: c.totalBombay || 0,
        isSettled: c.isSettled,
        totalPaidOut: c.totalPaidOut || 0,
        netProfit: c.netProfit || 0,
        winnerDeterminedBy: c.winnerDeterminedBy || 'AUTOMATIC',
        settledAt: c.settledAt || null,
      })),
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
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
    const { Cycle } = getModels();
    
    const cycle = await Cycle.findOne({ cycleId });
    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Cycle not found' });
    }
    
    // Run manual equalization
    const targetPhantom = Math.max(cycle.phantomDelhi || 0, cycle.phantomBombay || 0);
    
    cycle.phantomDelhi = targetPhantom;
    cycle.phantomBombay = targetPhantom;
    cycle.totalDelhi = (cycle.realDelhi || 0) + targetPhantom;
    cycle.totalBombay = (cycle.realBombay || 0) + targetPhantom;
    cycle.phantomBalanced = true;
    
    await cycle.save();
    
    // Emit real-time update
    global.io?.emit('phantom_equalized', {
      cycleId: cycle.cycleId,
      totalDelhi: cycle.totalDelhi,
      totalBombay: cycle.totalBombay
    });
    
    res.json({
      success: true,
      message: 'Phantom equalizer executed',
      cycle: {
        cycleId: cycle.cycleId,
        totalDelhi: cycle.totalDelhi,
        totalBombay: cycle.totalBombay,
        phantomDelhi: cycle.phantomDelhi,
        phantomBombay: cycle.phantomBombay
      }
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

router.post('/manage-cycle', authenticate, isAdmin, async (req, res) => {
  try {
    const { action, cycleId, payload } = req.body;
    const Cycle = mongoose.model('Cycle');

    const cycle = await Cycle.findOne({ cycleId });
    if (!cycle) return res.status(404).json({ success: false, message: 'Cycle not found' });

    switch (action?.toUpperCase()) {
      case 'PAUSE':
        cycle.isPaused = true;
        cycle.status   = 'PAUSED';
        await cycle.save();
        global.io?.emit('cycle_phase', { cycleId, phase: 'PAUSED', message: 'Cycle paused by admin' });
        break;
      case 'RESUME':
        cycle.isPaused = false;
        cycle.status   = 'OPEN';
        await cycle.save();
        global.io?.emit('cycle_phase', { cycleId, phase: 'OPEN', message: 'Cycle resumed by admin' });
        break;
      case 'CANCEL':
        cycle.status = 'CANCELLED';
        await cycle.save();
        global.io?.emit('cycle_phase', { cycleId, phase: 'CANCELLED', message: 'Cycle cancelled by admin' });
        break;
      case 'FORCE_RESULT':
        const winner = payload?.winner;
        if (!['DELHI', 'BOMBAY'].includes(winner)) {
          return res.status(400).json({ success: false, message: 'winner must be DELHI or BOMBAY' });
        }
        cycle.winner = winner;
        cycle.status = 'RESULT_DECLARED';
        await cycle.save();
        global.io?.emit('cycle_result', { cycleId, winner, forced: true });
        break;
      default:
        return res.status(400).json({ success: false, message: `Unknown action: ${action}` });
    }

    res.json({ success: true, message: `Action '${action}' applied to cycle ${cycleId}`, cycle });
  } catch (error) {
    console.error('Manage cycle error:', error);
    res.status(500).json({ success: false, message: 'Failed to manage cycle' });
  }
});

export default router;
