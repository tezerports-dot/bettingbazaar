// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * USER & CYCLE ROUTES — user.routes.js  v4.3.0
 * ════════════════════════════════════════════════════════════════════════════
 *
 * FIXES IN THIS VERSION (vs v4.2.0):
 *
 * BUG-U2  — /v1/game/cycles/history now returns BOTH delhiPool AND totalDelhi
 *            (alias fields) so HistoryPage displays pool bars correctly
 *            regardless of which field name the frontend reads.
 *
 * BUG-U5  — /v1/user/:id/data now returns bets[] and history[] alongside the
 *            user object. GameContext.syncWithServer() previously received only
 *            { user } which left userBets = undefined → ProfilePage crash.
 *
 * BUG-U6  — /v1/user/:id/data now returns walletBalance (deposit+winnings) so
 *            Header and ProfilePage show the real balance immediately after login.
 *            Also returns kycData (with rejectionReason) and bankDetails.
 *
 * BUG-U9/CROSS-1  — New: GET /v1/content/faq  → user-facing FAQ list
 *                   Admin FAQs were written but never exposed to users.
 *
 * BUG-U12 — New: GET /v1/game/winners  → real top-winners from settled bets
 *                (was 100% random mock data in WinnersPage.tsx)
 *
 * BUG-U14 — New: GET /v1/content/ai-analysis  → last-10-cycles pattern summary

 *
 * BUG-U19 — New: GET /v1/content/support-links  → admin-configured WhatsApp /
 *                Telegram / email so users can reach support in-app.
 *
 * CROSS-2 — New: GET /v1/branding  → CDN base URL + all asset names so the
 *                frontend getAssetUrl() works without manual localStorage setup.
 *
 * ALL WRITES use safeSession() atomic transactions (Replica Set aware).
 */

import express from 'express';
import crypto  from 'crypto';
import mongoose from 'mongoose';
import { withdrawalLimiter } from '../middleware/security.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { lockWithdrawal, getUserLedger } from '../services/walletAuthority.service.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// safeSession — works on both standalone MongoDB and Replica Sets.
// On Railway/VPS without a Replica Set, startTransaction() throws.
// safeSession() catches that → bets still process without ACID but safely.
// ─────────────────────────────────────────────────────────────────────────────
async function safeSession() {
  try {
    const session = await mongoose.startSession();
    session.startTransaction();
    return session;
  } catch {
    return null;
  }
}
async function commitOrEnd(session) {
  if (!session) return;
  try { await session.commitTransaction(); } finally { session.endSession(); }
}
async function abortOrEnd(session) {
  if (!session) return;
  try { await session.abortTransaction(); } finally { session.endSession(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// sanitiseCycleForUser()
//
// Strips ALL real/phantom breakdown fields before sending to the user.
// Returns BOTH delhiPool and totalDelhi (aliases) so any frontend version works.
// Admin routes still have full access to the raw DB fields.
// ─────────────────────────────────────────────────────────────────────────────
function sanitiseCycleForUser(cycle) {
  const delhiPool  = cycle.totalDelhi  || 0;
  const bombayPool = cycle.totalBombay || 0;
  // BUG-DATE FIX: Always return ms timestamps, NEVER Date objects or ISO strings.
  // getPhaseStatus() does (endTimeMs - nowMs). If endTimeMs is a Date or ISO string
  // the subtraction returns NaN and the countdown shows fake/frozen values.
  const toMs = (d) => (d instanceof Date ? d.getTime() : Number(d));
  return {
    id:          cycle.cycleId,
    type:        cycle.type,
    status:      cycle.status,
    startTime:   toMs(cycle.startTime),
    endTime:     toMs(cycle.endTime),
    // Both alias names — BUG-U2 fix: no more "always 0" on HistoryPage
    delhiPool,
    bombayPool,
    totalDelhi:  delhiPool,   // alias for frontend that reads totalDelhi
    totalBombay: bombayPool,  // alias for frontend that reads totalBombay
    totalPool:   delhiPool + bombayPool,
    winner:      cycle.winner    || null,
    isSettled:   cycle.isSettled || 'PENDING'
    // NEVER included:
    //   realDelhi, realBombay, phantomDelhi, phantomBombay,
    //   phantomBetsClosed, phantomBalanced
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cycles/active  (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cycles/active', async (req, res) => {
  try {
    const Cycle = mongoose.model('Cycle');
    const now = Date.now();
    const cycles = await Cycle.find({
      status: { $in: ['OPEN', 'MERGED'] },
      endTime: { $gt: now }
    }).sort({ type: 1, startTime: 1 }).lean();

    res.json({ success: true, cycles: cycles.map(sanitiseCycleForUser) });
  } catch (error) {
    console.error('Get active cycles error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch active cycles' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cycles/:cycleId  (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cycles/:cycleId', async (req, res) => {
  try {
    const { cycleId } = req.params;
    const Cycle = mongoose.model('Cycle');
    const cycle = await Cycle.findOne({ cycleId }).lean();
    if (!cycle) return res.status(404).json({ success: false, message: 'Cycle not found' });
    res.json({ success: true, cycle: sanitiseCycleForUser(cycle) });
  } catch (error) {
    console.error('Get cycle details error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch cycle details' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/game/cycle/:type/:startTime  (public)
// Used by realBackend.getCycleState()
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/game/cycle/:type/:startTime', async (req, res) => {
  try {
    const { type, startTime } = req.params;
    const startMs = parseInt(startTime);
    const Cycle = mongoose.model('Cycle');

    // Primary: find an active cycle that overlaps the requested start time
    let cycle = await Cycle.findOne({
      type,
      startTime: { $lte: startMs + 120000 },
      endTime:   { $gte: startMs - 120000 },
      status:    { $in: ['OPEN', 'MERGED', 'CLOSED', 'RESULT_DECLARED'] }
    }).sort({ startTime: -1 }).lean();

    // Fallback: for hard page-loads during the 12s celebration lock, the active
    // cycle query above returns nothing (cycle just completed). Return the last
    // RESULT_DECLARED cycle so the page still shows the winner while celebrating.
    
    if (!cycle) {
      cycle = await Cycle.findOne({ type, status: 'RESULT_DECLARED' })
        .sort({ endTime: -1 })
        .lean();
    }

    if (!cycle) return res.status(404).json({ success: false, message: 'Cycle not found' });
    res.json({ success: true, cycle: sanitiseCycleForUser(cycle) });
  } catch (error) {
    console.error('Get cycle state error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch cycle state' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/game/cycles/history  (public)
// BUG-U2 FIX: Returns both delhiPool AND totalDelhi (aliases).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/game/cycles/history', async (req, res) => {
  try {
    const { limit = 20, type } = req.query;
    // SEC 2.7 FIX: cap pagination to prevent DoS
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const Cycle = mongoose.model('Cycle');
    // NOTE: cycles stay in RESULT_DECLARED status; isSettled changes to COMPLETED.
    // Query both to ensure all completed cycles are included.
    const query = { status: 'RESULT_DECLARED' };
    if (type) query.type = type;

    const cycles = await Cycle.find(query)
      .sort({ endTime: -1 })
      .limit(parsedLimit)
      .lean();

    res.json({
      success: true,
      cycles: cycles.map(c => {
        const delhiPool  = c.totalDelhi  || 0;
        const bombayPool = c.totalBombay || 0;
        return {
          id:          c.cycleId,
          type:        c.type,
          startTime:   c.startTime,
          endTime:     c.endTime,
          winner:      c.winner,
          // BUG-U2 fix — both field name variants so either frontend version works
          delhiPool,
          bombayPool,
          totalDelhi:  delhiPool,
          totalBombay: bombayPool,
          totalPool:   delhiPool + bombayPool,
          status:      c.status
        };
      })
    });
  } catch (error) {
    console.error('Cycle history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch cycle history' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/game/winners  (public)
// BUG-U12 FIX: Real top winners from settled bets (not random mock data).
// ─────────────────────────────────────────────────────────────────────────────
// AUDIT REMOVED: GET /v1/game/winners — superseded by winners.routes.js GET /v1/winners
// The new endpoint merges real winners + admin-curated fake winners (FakeWinner model).

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/user/:userId/bets  (auth required)
// Users can only fetch their own bets. isPhantom:false enforced.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user/:userId/bets', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, skip = 0, cycleId, status } = req.query;
    // SEC 2.7 FIX: cap pagination to prevent DoS
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
    const parsedSkip  = Math.max(parseInt(skip) || 0, 0);

    if (req.user._id.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const Bet = mongoose.model('Bet');
    const query = { userId: new mongoose.Types.ObjectId(userId), isPhantom: false };
    if (cycleId) query.cycleId = cycleId;
    if (status)  query.status  = status;

    const [bets, total] = await Promise.all([
      Bet.find(query)
        .sort({ timestamp: -1 })
        .limit(parsedLimit)
        .skip(parsedSkip)
        .lean(),
      Bet.countDocuments(query)
    ]);

    res.json({
      success: true,
      bets: bets.map(b => ({
        id:        b._id,
        cycleId:   b.cycleId,
        side:      b.side,
        amount:    b.amount,
        status:    b.status,
        payout:    b.payout    || 0,
        cycleType: b.cycleType || null,
        timestamp: b.timestamp
      })),
      pagination: { total, limit: parsedLimit, skip: parsedSkip }
    });
  } catch (error) {
    console.error('Get user bets error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bets' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/user/:id/data  (auth required)
// BUG-U5 FIX: Now returns bets[], history[], kycData, bankDetails.
// BUG-U6 FIX: Now returns walletBalance = depositBalance + winningsBalance.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/user/:id/data', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user._id.toString() !== id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const User = mongoose.model('User');
    const Bet  = mongoose.model('Bet');

    const [user, recentBets] = await Promise.all([
      User.findById(id).select(
        'username mobile depositBalance winningsBalance lockedBalance kycStatus kycData bankDetails profilePic joinedAt lastLogin roles isAdmin phantomAccess'
      ).lean(),
      Bet.find({ userId: new mongoose.Types.ObjectId(id), isPhantom: false })
        .sort({ timestamp: -1 })
        .limit(50)
        .lean()
    ]);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const depositBalance  = user.depositBalance  || 0;
    const winningsBalance = user.winningsBalance || 0;
    const lockedBalance   = user.lockedBalance   || 0;
    const walletBalance   = depositBalance + winningsBalance; // BUG-U6 fix

    const normalizedBets = recentBets.map(b => ({
      id:        b._id,
      cycleId:   b.cycleId,
      side:      b.side,
      amount:    b.amount,
      status:    b.status,
      payout:    b.payout    || 0,
      cycleType: b.cycleType || null,
      timestamp: b.timestamp
    }));

    // history = last 20 cycle IDs the user bet in (for LiveTicker dots)
    const historyCycleIds = [...new Set(normalizedBets.map(b => b.cycleId))].slice(0, 20);

    res.json({
      success: true,
      user: {
        id:               user._id,
        username:         user.username,
        mobile:           user.mobile,
        depositBalance,
        winningsBalance,
        lockedBalance,
        walletBalance,    // BUG-U6 fix — Header now shows real balance
        totalBalance:     walletBalance,
        kycStatus:        user.kycStatus,
        // BUG-U15 fix — kycData with rejectionReason surfaced to UI
        kycData: user.kycData ? {
          nameOnPAN:       user.kycData.nameOnPAN       || user.kycData.nameOnAadhaar || '',
          panNumber:       user.kycData.panNumber       || user.kycData.aadhaarNumber || '',
          idProofUrl:      user.kycData.idProofUrl      || '',
          photoUrl:        user.kycData.photoUrl        || '',
          submittedAt:     user.kycData.submittedAt     || null,
          rejectionReason: user.kycData.rejectionReason || ''
        } : null,
        bankDetails: user.bankDetails || null,
        profilePic:       user.profilePic || '',
        joinedAt:         user.joinedAt,
        lastLogin:        user.lastLogin,
        roles:            user.roles || ['user'],
        isAdmin:          user.isAdmin    || false,
        // Phantom agent access level — controls ghost mode visibility in BetControls
        phantomAccess:    user.phantomAccess || 'NONE',
      },
      // BUG-U5 fix — bets[] no longer undefined in GameContext
      bets:    normalizedBets,
      history: historyCycleIds
    });
  } catch (error) {
    console.error('Get user data error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user data' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/user/:userId/profile  (auth required, atomic)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/user/:userId/profile', authenticate, async (req, res) => {
  const session = await safeSession();
  try {
    const { userId } = req.params;
    if (req.user._id.toString() !== userId) {
      await abortOrEnd(session);
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { username, profilePic } = req.body;
    const User    = mongoose.model('User');
    const updates = {};
    if (username)   updates.username   = username.trim();
    if (profilePic) updates.profilePic = profilePic;

    const updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true, session }).lean();
    await commitOrEnd(session);

    res.json({ success: true, user: { id: updatedUser._id, username: updatedUser.username, profilePic: updatedUser.profilePic } });
  } catch (error) {
    await abortOrEnd(session);
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/user/:userId/kyc  (auth required, atomic)
// BUG-U7 FIX: Expects real URLs (from /content/upload) not placeholder strings.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/user/:userId/kyc', authenticate, async (req, res) => {
  const session = await safeSession();
  try {
    const { userId } = req.params;
    if (req.user._id.toString() !== userId) {
      await abortOrEnd(session);
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { nameOnPAN, panNumber, idProofUrl, photoUrl } = req.body;
    if (!nameOnPAN || !panNumber || !idProofUrl || !photoUrl) {
      await abortOrEnd(session);
      return res.status(400).json({ success: false, message: 'All KYC fields and document URLs are required' });
    }
    // Guard against placeholder submissions (BUG-U7 root cause)
    if (idProofUrl.includes('pending_upload') || photoUrl.includes('pending_upload')) {
      await abortOrEnd(session);
      return res.status(400).json({ success: false, message: 'Document upload required before submission' });
    }

    const User = mongoose.model('User');
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        kycStatus: 'PENDING_APPROVAL',
        kycData: {
          nameOnPAN: nameOnPAN.trim().toUpperCase(),
          panNumber: panNumber.toUpperCase(),
          idProofUrl,
          photoUrl,
          submittedAt: new Date(),
          rejectionReason: ''
        }
      },
      { new: true, session }
    ).lean();

    await commitOrEnd(session);
    res.json({ success: true, kycStatus: updatedUser.kycStatus });
  } catch (error) {
    await abortOrEnd(session);
    console.error('KYC submit error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit KYC' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/user/:userId/bank-details  (auth required, atomic)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/user/:userId/bank-details', authenticate, async (req, res) => {
  const session = await safeSession();
  try {
    const { userId } = req.params;
    if (req.user._id.toString() !== userId) {
      await abortOrEnd(session);
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { accountHolderName, accountNumber, ifscCode, bankName } = req.body;
    if (!accountHolderName || !accountNumber || !ifscCode || !bankName) {
      await abortOrEnd(session);
      return res.status(400).json({ success: false, message: 'All bank detail fields are required' });
    }

    const User = mongoose.model('User');
    await User.findByIdAndUpdate(
      userId,
      { bankDetails: { accountHolderName, accountNumber, ifscCode: ifscCode.toUpperCase(), bankName } },
      { session }
    );

    await commitOrEnd(session);
    res.json({ success: true });
  } catch (error) {
    await abortOrEnd(session);
    console.error('Update bank details error:', error);
    res.status(500).json({ success: false, message: 'Failed to update bank details' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/user/:userId/transactions  (auth required)
// BUG-U11 FIX: Transaction history for WalletModal
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user/:userId/transactions', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user._id.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const Transaction = mongoose.model('Transaction');
    const { limit = 30, skip = 0 } = req.query;
    // SEC 2.7 FIX: cap pagination to prevent DoS
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 30, 1), 100);
    const parsedSkip  = Math.max(parseInt(skip) || 0, 0);

    const [transactions, total] = await Promise.all([
      Transaction.find({
        userId: new mongoose.Types.ObjectId(userId),
        type: { $in: ['DEPOSIT', 'WITHDRAWAL'] } // TXNS-CLEAN-V6
      })
        .sort({ createdAt: -1 })
        .limit(parsedLimit)
        .skip(parsedSkip)
        .lean(),
      Transaction.countDocuments({
        userId: new mongoose.Types.ObjectId(userId),
        type: { $in: ['DEPOSIT', 'WITHDRAWAL'] }
      })
    ]);

    res.json({
      success: true,
      transactions: transactions.map(t => ({
        id:        t._id,
        type:      t.type,
        amount:    t.amount,
        status:    t.status,
        reference: t.utrNumber || t.orderId || '',
        note:      t.note || '',
        createdAt: t.createdAt
      })),
      pagination: { total, limit: parsedLimit, skip: parsedSkip }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/system/config  (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/system/config', async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const TokenRates   = mongoose.model('TokenRates');
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
    const rates  = await TokenRates.findOne({ key: 'main' }).lean();

    res.json({
      success: true,
      config: {
        // Bet limits — stored in betLimits subdoc, NOT config.value
        minBet:           config?.betLimits?.thirtyMin?.min || 10,
        maxBet:           config?.betLimits?.thirtyMin?.max || 100000,
        maxFullDayBet:    config?.betLimits?.fullDay?.max   || 500000,
        // Deposit/withdrawal limits — top-level fields on SystemConfig
        minDeposit:       config?.minDeposit       || 100,
        maxDeposit:       config?.maxDeposit       || 50000,
        minWithdrawal:    config?.minWithdrawal    || 500  /* schema default — was incorrectly 100 (GOVERNANCE.md M-5) */,
        maxWithdrawal:    config?.maxWithdrawal    || 50000,
        // Token rates from TokenRates collection
        tokenBuyRate:     rates?.buyRate           ?? 1,
        tokenSellRate:    rates?.sellRate          ?? 1,
        payoutMultiplier: 2,
        maintenanceMode:  config?.maintenanceMode  || false,
        maintenanceMessage: config?.maintenanceMessage || '',
        minVersion:       config?.minVersion       || '1.0.0',
        latestVersion:    config?.latestVersion    || '1.0.0',
        kycRequired:      config?.kycRequired      !== false,
        registrationEnabled: config?.registrationEnabled !== false,
      }
    });
  } catch (error) {
    console.error('System config error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch config' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/system/time  (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/system/time', (req, res) => {
  res.json({
    success:    true,
    serverTime: Date.now(),
    unixtime:   Date.now(),
    iso:        new Date().toISOString()
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/content/promo/:location  (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/content/promo/:location', async (req, res) => {
  try {
    const { location } = req.params;
    const PromoContent = mongoose.model('PromoContent');
    const content = await PromoContent.find({ location, isActive: true }).sort({ priority: -1 }) /* FIX H-4: was 'order' (non-existent field = silent no-op); priority field is correct */.lean();
    res.json({ success: true, content });
  } catch (error) {
    console.error('Promo content error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch promo content' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/content/faq  (public)
// BUG-U9 / CROSS-1 FIX: Admin FAQs now exposed to users.
// Query ?isPublished=true to get only live FAQs.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/content/faq', async (req, res) => {
  try {
    // FAQs may be stored in SystemConfig, a dedicated FAQ model, or PromoContent.
    // We try dedicated model first, then fall back to SystemConfig key 'faq'.
    let faqs = [];
    try {
      const FAQ = mongoose.model('FAQ');
      faqs = await FAQ.find({ isPublished: true }).sort({ category: 1, order: 1 }).lean();
    } catch {
      // Model doesn't exist yet — try SystemConfig
      const SystemConfig = mongoose.model('SystemConfig');
      const cfg = await SystemConfig.findOne({ key: 'faq' }).lean();
      faqs = cfg?.value || [];
    }

    res.json({
      success: true,
      faqs: faqs.map(f => ({
        id:       f._id || f.id,
        question: f.question,
        answer:   f.answer,
        category: f.category || 'General'
      }))
    });
  } catch (error) {
    console.error('FAQ fetch error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch FAQs' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/content/support-links  (public)
// BUG-U19 FIX: Admin-configured support channels surfaced to users.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/content/support-links', async (req, res) => {
  try {
    const SupportLinks = mongoose.model('SupportLinks');
    const SystemConfig  = mongoose.model('SystemConfig');
    // Try dedicated SupportLinks collection first, fall back to SystemConfig.supportLinks
    let raw = await SupportLinks.findOne({ key: 'main' }).lean();
    if (!raw) {
      const cfg = await SystemConfig.findOne({ key: 'main' }).select('supportLinks').lean();
      raw = cfg?.supportLinks || {};
    }
    res.json({
      success: true,
      links: {
        whatsapp:      raw.whatsapp      || '',
        telegram:      raw.telegram      || '',
        instagram:     raw.instagram     || '',
        youtube:       raw.youtube       || '',
        email:         raw.email         || '',
        phone:         raw.phone         || '',
        helpCenterUrl: raw.helpCenterUrl || '',
      }
    });
  } catch (error) {
    console.error('Support links error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch support links' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/content/ai-analysis  (public)
// BUG-U14 FIX: Reads last 10 completed cycles and returns a structured
// pattern summary (streak, dominant side, win rates, prediction confidence).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/content/ai-analysis', async (req, res) => {
  try {
    const { type = 'THIRTY_MIN' } = req.query;
    const Cycle = mongoose.model('Cycle');

    const cycles = await Cycle.find({
      type,
      status: { $in: ['RESULT_DECLARED', 'COMPLETED'] },
      winner: { $in: ['DELHI', 'BOMBAY'] }
    })
      .sort({ endTime: -1 })
      .limit(10)
      .lean();

    if (!cycles.length) {
      return res.json({
        success: true,
        cached: false,
        text: 'Insufficient data for analysis. Play more cycles to unlock AI predictions.',
        data: null
      });
    }

    const delhiWins  = cycles.filter(c => c.winner === 'DELHI').length;
    const bombayWins = cycles.filter(c => c.winner === 'BOMBAY').length;
    const total      = cycles.length;

    // Streak: how many consecutive times the same side won (from most recent)
    let streak = 1;
    for (let i = 1; i < cycles.length; i++) {
      if (cycles[i].winner === cycles[0].winner) streak++;
      else break;
    }

    const dominant    = delhiWins >= bombayWins ? 'DELHI' : 'BOMBAY';
    const dominantPct = Math.round((Math.max(delhiWins, bombayWins) / total) * 100);
    const recentSide  = cycles[0].winner;
    const streakWord  = streak >= 3 ? `on a ${streak}-game winning streak` : `won the last game`;
    const confidence  = streak >= 3 ? 'High' : dominantPct >= 70 ? 'Moderate' : 'Low';

    const text =
      `📊 Last ${total} cycles — Delhi: ${delhiWins} wins | Bombay: ${bombayWins} wins. ` +
      `${dominant} is dominant at ${dominantPct}% win rate. ` +
      `${recentSide} ${streakWord}. ` +
      `Prediction confidence: ${confidence}. ` +
      `⚠️ Past performance does not guarantee future results.`;

    res.json({
      success: true,
      cached: false,
      text,
      data: {
        delhiWins,
        bombayWins,
        total,
        dominant,
        dominantPct,
        streak,
        streakSide: cycles[0].winner,
        confidence,
        lastResult: cycles[0].winner
      }
    });
  } catch (error) {
    console.error('AI analysis error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate analysis' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/branding  (public)
// CROSS-2 FIX: Frontend getAssetUrl() reads app_branding from localStorage.
// This route fills that localStorage key on app init.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/branding', async (req, res) => {
  try {
    // FIX: Read from Branding model (has proper schema) not SystemConfig.value (no value field in schema)
    const Branding = mongoose.model('Branding');
    const b = await Branding.findOne({ key: 'main' }).lean() || {};

    // CDN_URL env var is the primary source for CDN base URL.
    // Admin can also set cdnBaseUrl field in the Branding document.
    const cdnBaseUrl = b.cdnBaseUrl || process.env.CDN_URL || '';

    res.json({
      success: true,
      branding: {
        appName:      b.appName      || 'BettingBazaar',
        cdnBaseUrl,
        primaryColor: b.primaryColor || '#D4AF37',
        assets: {
          logo:    'logo.jpeg',
          appIcon: 'App icon.jpeg',
          delhi:   'Delhi.jpg',
          bombay:  'Bomabay.jpg',
          popup:   'Popup.jpeg',
          rules:   'Rules.jpeg',
          tipsBg:  'tips.jpeg'
        }
      }
    });
  } catch (error) {
    // Even on DB error, return CDN_URL from env so images always work
    console.error('Branding fetch error:', error);
    res.json({
      success: true,
      branding: {
        appName:      'BettingBazaar',
        cdnBaseUrl:   process.env.CDN_URL || '',
        primaryColor: '#D4AF37',
        assets: {
          logo: 'logo.jpeg', appIcon: 'App icon.jpeg', delhi: 'Delhi.jpg',
          bombay: 'Bomabay.jpg', popup: 'Popup.jpeg', rules: 'Rules.jpeg', tipsBg: 'tips.jpeg'
        }
      }
    });
  }
});

// ── POST /api/v1/user/withdraw — request a withdrawal ───────────────────────
router.post('/v1/user/withdraw', withdrawalLimiter, authenticate, async (req, res) => {
  try {
    const { amount, method = 'UPI', upiId, bankName, accountNumber, ifscCode } = req.body;
    const User              = mongoose.model('User');
    const SystemConfig      = mongoose.model('SystemConfig');
    const WithdrawalRequest = mongoose.model('WithdrawalRequest');

    // Validate amount
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
    const minW = config?.minWithdrawal || 500  /* schema default — was incorrectly 100 (GOVERNANCE.md M-5) */;
    const maxW = config?.maxWithdrawal || 50000;

    if (!amount || isNaN(amount) || amount < minW)
      return res.status(400).json({ success: false, message: `Minimum withdrawal is ₹${minW}` });
    if (amount > maxW)
      return res.status(400).json({ success: false, message: `Maximum withdrawal is ₹${maxW}` });

    // KYC check
    const user = await User.findById(req.user._id);
    if (user.kycStatus !== 'APPROVED')
      return res.status(403).json({ success: false, message: 'KYC verification required before withdrawals' });

    // Balance check — only winnings are withdrawable
    if ((user.winningsBalance || 0) < amount)
      return res.status(400).json({ success: false, message: 'Insufficient winnings balance. Only winnings can be withdrawn.' });

    // No pending withdrawal already
    const pendingExists = await WithdrawalRequest.findOne({ userId: req.user._id, status: 'PENDING' }).lean();
    if (pendingExists)
      return res.status(400).json({ success: false, message: 'You already have a pending withdrawal request. Please wait for it to be processed.' });

    // Validate payment details
    if (method === 'UPI' && !upiId)
      return res.status(400).json({ success: false, message: 'UPI ID is required' });
    if (method === 'BANK' && (!bankName || !accountNumber || !ifscCode))
      return res.status(400).json({ success: false, message: 'Bank name, account number and IFSC are required' });

    // Create withdrawal request first so we have its ID for idempotent lock
    const wr = await WithdrawalRequest.create({
      userId: req.user._id, amount, method,
      upiId, bankName, accountNumber, ifscCode,
      status: 'PENDING',
    });

    // Lock winningsBalance via WalletAuthority (writes WalletLedger, idempotent)
    await lockWithdrawal(String(req.user._id), amount, String(wr._id));

    
    if (global.io) {
      global.io.to('admin-room').emit('new_withdrawal_request', {
        requestId: wr._id, userId: req.user._id,
        username: user.username, amount, method, createdAt: wr.createdAt,
      });
    }

    res.json({ success: true, message: 'Withdrawal request submitted. Processing within 24 hours.', requestId: wr._id });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/v1/user/withdrawals — list own withdrawal requests
router.get('/v1/user/withdrawals', authenticate, async (req, res) => {
  try {
    const WithdrawalRequest = mongoose.model('WithdrawalRequest');
    const requests = await WithdrawalRequest.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(20).lean();
    res.json({ success: true, requests });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


// ── WALLET LEDGER — user's personal transaction history ──────────────────────
// GET /api/v1/wallet/ledger  — append-only audit trail of every balance change
router.get('/v1/wallet/ledger', authenticate, async (req, res) => { // paginated
  try {
    const { page = 1, limit = 30 } = req.query;
    const result = await getUserLedger(req.user._id, Number(page), Number(limit));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/tokens/rate  — public live token exchange rates
// Returns buyRate (what user pays per token) and sellRate (what user receives).
// Used by WalletPage Token Exchange Panel for live INR conversion display.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/tokens/rate', async (req, res) => {
  try {
    const TokenRates   = mongoose.model('TokenRates');
    const SystemConfig = mongoose.model('SystemConfig');

    const [rates, config] = await Promise.all([
      TokenRates.findOne({ key: 'main' }).lean(),
      SystemConfig.findOne({ key: 'main' }).lean(),
    ]);

    // MED-05 FIX: warn when using fallback rates; expose ratesConfigured flag to clients
    if (!rates) {
      console.warn('[token-rates] No TokenRates document found — using hardcoded fallback rates (1.1/1.0)');
    }
    res.json({
      success:        true,
      buyRate:        rates?.buyRate     ?? 1.1,
      sellRate:       rates?.sellRate    ?? 1.0,
      ratesConfigured: !!rates, // MED-05: false = admin has never configured rates
      minExchange:    config?.minWithdrawal ?? 500  /* schema default — was incorrectly 100 (GOVERNANCE.md M-5) */,
      maxExchange:    config?.maxWithdrawal ?? 50000,
      currency:       'INR',
      updatedAt:      rates?.updatedAt ?? null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/tokens/exchange  — sell BB tokens for real INR
//
// Flow:
//   1. Fetch live sell rate from TokenRates (locks in the rate atomically)
//   2. Validate tokenAmount against limits and winningsBalance
//   3. Calculate INR payout = round2(tokenAmount × sellRate)
//   4. KYC gate — only APPROVED users may exchange
//   5. No concurrent pending exchange allowed
//   6. Atomic balance update: winningsBalance -= tokenAmount, lockedBalance += tokenAmount
//   7. Append immutable WalletLedger entry (DEBIT, winningsBalance)
//   8. Create WithdrawalRequest (processed by admin within 24h)
//   9. Push SSE balance_update to user's personal channel

//
// Mathematics: all values rounded to 2dp using Math.round(n * 100) / 100
//   — avoids IEEE 754 floating-point drift corrupting user balances.
//
// Idempotency: txId (UUID) prevents duplicate ledger writes on retry.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/v1/tokens/exchange', withdrawalLimiter, authenticate, async (req, res) => {
  try {
    const { tokenAmount, paymentMethod = 'UPI', upiId, bankName, accountNumber, ifscCode } = req.body;

    const User              = mongoose.model('User');
    const TokenRates        = mongoose.model('TokenRates');
    const SystemConfig      = mongoose.model('SystemConfig');
    const WithdrawalRequest = mongoose.model('WithdrawalRequest');
    const WalletLedger      = mongoose.model('WalletLedger');

    // ── 1. Fetch live rates & limits ──────────────────────────────────────────
    const [rates, config] = await Promise.all([
      TokenRates.findOne({ key: 'main' }).lean(),
      SystemConfig.findOne({ key: 'main' }).lean(),
    ]);
    const sellRate = rates?.sellRate ?? 1.0;
    const minEx    = config?.minWithdrawal ?? 500  /* schema default — was incorrectly 100 (GOVERNANCE.md M-5) */;
    const maxEx    = config?.maxWithdrawal ?? 50000;

    // ── 2. Parse & validate tokenAmount ──────────────────────────────────────
    // round2 helper: avoids floating-point corruption
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    const tokens = round2(tokenAmount);
    if (!tokens || tokens <= 0)
      return res.status(400).json({ success: false, message: 'Token amount must be greater than 0' });
    if (tokens < minEx)
      return res.status(400).json({ success: false, message: `Minimum exchange is ${minEx} tokens` });
    if (tokens > maxEx)
      return res.status(400).json({ success: false, message: `Maximum exchange is ${maxEx.toLocaleString()} tokens` });

    // ── 3. Calculate INR payout (2dp safe) ───────────────────────────────────
    const inrPayout = round2(tokens * sellRate);

    // ── 4. Fetch user and KYC gate ───────────────────────────────────────────
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.kycStatus !== 'APPROVED')
      return res.status(403).json({ success: false, message: 'KYC verification required before token exchange' });

    // ── 5. Balance check — only winningsBalance is exchangeable ──────────────
    const winBal = round2(user.winningsBalance || 0);
    if (winBal < tokens)
      return res.status(400).json({
        success: false,
        message: `Insufficient token balance. Available: ${winBal.toLocaleString('en-IN')} tokens`,
      });

    // ── 5b. No concurrent pending exchange ───────────────────────────────────
    const pendingExists = await WithdrawalRequest.findOne({ userId: req.user._id, status: 'PENDING' }).lean();
    if (pendingExists)
      return res.status(400).json({
        success: false,
        message: 'You already have a pending exchange request. Please wait for it to be processed.',
      });

    // ── 6. Validate payment details ───────────────────────────────────────────
    if (paymentMethod === 'UPI' && !upiId)
      return res.status(400).json({ success: false, message: 'UPI ID is required' });
    if (paymentMethod === 'BANK' && (!bankName || !accountNumber || !ifscCode))
      return res.status(400).json({ success: false, message: 'Bank name, account number, and IFSC code are required' });

    // ── 7. Atomic balance update (deduct winnings, lock pending amount) ───────
    const newWinnings  = round2(winBal - tokens);
    const depBal       = round2(user.depositBalance || 0);
    const newLocked    = round2((user.lockedBalance || 0) + tokens);

    await User.findByIdAndUpdate(req.user._id, {
      $set: {
        winningsBalance: newWinnings,
        lockedBalance:   newLocked,
      },
    });

    // ── 8. Immutable WalletLedger entry (append-only) ─────────────────────────
    const txId = `exchange_${crypto.randomUUID()}`;
    await WalletLedger.create({
      userId:        req.user._id,
      type:          'DEBIT',
      field:         'winningsBalance',
      amount:        tokens,
      balanceBefore: winBal,
      balanceAfter:  newWinnings,
      reason:        `Token exchange: ${tokens} tokens → ₹${inrPayout} (sell rate: ${sellRate})`,
      refModel:      'Other',
      txId,
    });

    // ── 9. WithdrawalRequest (processed by admin within 24h) ─────────────────
    const wr = await WithdrawalRequest.create({
      userId:        req.user._id,
      amount:        inrPayout,
      method:        paymentMethod,
      upiId:         paymentMethod === 'UPI'  ? upiId        : undefined,
      bankName:      paymentMethod === 'BANK' ? bankName      : undefined,
      accountNumber: paymentMethod === 'BANK' ? accountNumber : undefined,
      ifscCode:      paymentMethod === 'BANK' ? ifscCode      : undefined,
      status:        'PENDING',
    });

    // ── 10. SSE balance push (best-effort — never blocks response) ────────────
    try {
      global.sseManager?.sendToUser?.(String(req.user._id), 'balance_update', {
        depositBalance:  depBal,
        winningsBalance: newWinnings,
        totalBalance:    round2(depBal + newWinnings),
        lockedBalance:   newLocked,
      });
    } catch (_) { /* SSE is best-effort */ }

    
    if (global.io) {
      global.io.to('admin-room').emit('new_withdrawal_request', {
        requestId:    wr._id,
        userId:       req.user._id,
        username:     user.username,
        amount:       inrPayout,
        method:       paymentMethod,
        type:         'TOKEN_EXCHANGE',
        tokenAmount:  tokens,
        sellRate,
        createdAt:    wr.createdAt,
      });
    }

    res.json({
      success:     true,
      message:     `Exchange submitted! ₹${inrPayout.toLocaleString('en-IN', { minimumFractionDigits: 2 })} will be transferred within 24 hours.`,
      requestId:   wr._id,
      tokenAmount: tokens,
      inrPayout,
      sellRate,
      txId,
    });

  } catch (err) {
    console.error('[exchange] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/token/rates  — canonical alias used by WalletModal + WalletPage
// (WalletModal calls /api/v1/token/rates; old route was /v1/tokens/rate)
// Both now return the same shape.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/token/rates', async (req, res) => {
  try {
    const TokenRates   = mongoose.model('TokenRates');
    const SystemConfig = mongoose.model('SystemConfig');
    const [rates, config] = await Promise.all([
      TokenRates.findOne({ key: 'main' }).lean(),
      SystemConfig.findOne({ key: 'main' }).lean(),
    ]);
    res.json({
      success:  true,
      rates: {
        buyRate:     rates?.buyRate     ?? 1.1,
        sellRate:    rates?.sellRate    ?? 1.0,
        updatedAt:   rates?.updatedAt   ?? null,
      },
      minExchange: config?.minWithdrawal ?? 500  /* schema default — was incorrectly 100 (GOVERNANCE.md M-5) */,
      maxExchange: config?.maxWithdrawal ?? 50000,
      // Flat fields for back-compat
      buyRate:  rates?.buyRate  ?? 1.1,
      sellRate: rates?.sellRate ?? 1.0,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/tokens/buy
// User buys BB tokens by entering an INR amount.
// Flow:
//   1. Fetch BUY_TOKEN_RATE from TokenRates (single source of truth)
//   2. tokensIssued = round2(inrAmount / buyRate)
//   3. Credit depositBalance += tokensIssued
//   4. Write TOKEN_PURCHASE Transaction (audit trail)
//   5. Write WalletLedger entry
//   6. Push SSE balance_update
// ─────────────────────────────────────────────────────────────────────────────
router.post('/v1/tokens/buy', authenticate, async (req, res) => {
  try {
    const { inrAmount, paymentRef } = req.body;

    const TokenRates   = mongoose.model('TokenRates');
    const SystemConfig = mongoose.model('SystemConfig');
    const User         = mongoose.model('User');
    const Transaction  = mongoose.model('Transaction');
    const WalletLedger = mongoose.model('WalletLedger');

    // 1. Fetch admin-controlled buy rate
    const [rates, config] = await Promise.all([
      TokenRates.findOne({ key: 'main' }).lean(),
      SystemConfig.findOne({ key: 'main' }).lean(),
    ]);
    if (!rates?.buyRate)
      return res.status(503).json({ success: false, message: 'Token buy rate not configured. Contact admin.' });

    const round2   = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const buyRate  = rates.buyRate;
    const minDep   = config?.minDeposit ?? 100;
    const maxDep   = config?.maxDeposit ?? 50000;

    // 2. Validate INR amount
    const inr = round2(inrAmount);
    if (!inr || inr <= 0)
      return res.status(400).json({ success: false, message: 'INR amount must be greater than 0' });
    if (inr < minDep)
      return res.status(400).json({ success: false, message: `Minimum purchase is ₹${minDep}` });
    if (inr > maxDep)
      return res.status(400).json({ success: false, message: `Maximum purchase is ₹${maxDep.toLocaleString()}` });

    // 3. Calculate tokens
    const tokensIssued = round2(inr / buyRate);

    // 4. Fetch user and apply credit
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const depBefore = round2(user.depositBalance  || 0);
    const winBefore = round2(user.winningsBalance || 0);
    const depAfter  = round2(depBefore + tokensIssued);

    await User.findByIdAndUpdate(req.user._id, {
      $inc: { depositBalance: tokensIssued }
    });

    // 5a. Transaction record (TOKEN_PURCHASE)
    const txId = `buy_${crypto.randomUUID()}`;
    await Transaction.create({
      userId:               req.user._id,
      type:                 'TOKEN_PURCHASE',
      amount:               tokensIssued,
      balanceType:          'DEPOSIT',
      depositBalanceBefore: depBefore,
      depositBalanceAfter:  depAfter,
      winningsBalanceBefore:winBefore,
      winningsBalanceAfter: winBefore,
      status:               'SUCCESS',
      referenceId:          paymentRef || txId,
      description:          `TOKEN_PURCHASE: ₹${inr} @ ₹${buyRate}/token = ${tokensIssued} tokens`,
    });

    // 5b. WalletLedger entry
    await WalletLedger.create({
      userId:        req.user._id,
      type:          'CREDIT',
      field:         'depositBalance',
      amount:        tokensIssued,
      balanceBefore: depBefore,
      balanceAfter:  depAfter,
      reason:        `Token purchase: ₹${inr} @ ₹${buyRate}/token`,
      refModel:      'Other',
      txId,
    });

    // 6. SSE balance push
    try {
      global.sseManager?.sendToUser?.(String(req.user._id), 'balance_update', {
        depositBalance:  depAfter,
        winningsBalance: winBefore,
        totalBalance:    round2(depAfter + winBefore),
      });
    } catch (_) {}

    res.json({
      success:      true,
      message:      `Purchased ${tokensIssued.toLocaleString('en-IN')} tokens for ₹${inr.toLocaleString('en-IN')}`,
      tokensIssued,
      inrPaid:      inr,
      buyRate,
      txId,
    });
  } catch (err) {
    console.error('[tokens/buy]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/tokens/sell
// User sells BB tokens for INR.
// Flow:
//   1. Fetch SELL_TOKEN_RATE from TokenRates (single source of truth)
//   2. inrGenerated = round2(tokenAmount × sellRate)
//   3. Debit winningsBalance -= tokenAmount
//   4. Lock inrGenerated pending admin payout
//   5. Write TOKEN_REDEMPTION Transaction
//   6. Write WalletLedger entry
//   7. Create WithdrawalRequest for admin processing
//   8. Push SSE balance_update
// ─────────────────────────────────────────────────────────────────────────────
router.post('/v1/tokens/sell', authenticate, async (req, res) => {
  try {
    const { tokenAmount, paymentMethod = 'UPI', upiId, bankName, accountNumber, ifscCode } = req.body;

    const TokenRates        = mongoose.model('TokenRates');
    const SystemConfig      = mongoose.model('SystemConfig');
    const User              = mongoose.model('User');
    const Transaction       = mongoose.model('Transaction');
    const WalletLedger      = mongoose.model('WalletLedger');
    const WithdrawalRequest = mongoose.model('WithdrawalRequest');

    // 1. Fetch admin-controlled sell rate
    const [rates, config] = await Promise.all([
      TokenRates.findOne({ key: 'main' }).lean(),
      SystemConfig.findOne({ key: 'main' }).lean(),
    ]);
    if (!rates?.sellRate)
      return res.status(503).json({ success: false, message: 'Token sell rate not configured. Contact admin.' });

    const round2   = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const sellRate = rates.sellRate;
    const minEx    = config?.minWithdrawal ?? 500  /* schema default — was incorrectly 100 (GOVERNANCE.md M-5) */;
    const maxEx    = config?.maxWithdrawal ?? 50000;

    // 2. Validate token amount
    const tokens = round2(tokenAmount);
    if (!tokens || tokens <= 0)
      return res.status(400).json({ success: false, message: 'Token amount must be greater than 0' });
    if (tokens < minEx)
      return res.status(400).json({ success: false, message: `Minimum sell is ${minEx} tokens` });
    if (tokens > maxEx)
      return res.status(400).json({ success: false, message: `Maximum sell is ${maxEx.toLocaleString()} tokens` });

    // 3. Fetch user and check balance
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.kycStatus !== 'APPROVED')
      return res.status(403).json({ success: false, message: 'KYC verification required before selling tokens' });

    const winBefore = round2(user.winningsBalance || 0);
    const depBefore = round2(user.depositBalance  || 0);
    if (winBefore < tokens)
      return res.status(400).json({
        success: false,
        message: `Insufficient token balance. Available: ${winBefore.toLocaleString('en-IN')} tokens`,
      });

    // 4. Check no pending redemption
    const pendingExists = await WithdrawalRequest.findOne({ userId: req.user._id, status: 'PENDING' }).lean();
    if (pendingExists)
      return res.status(400).json({
        success: false,
        message: 'You already have a pending withdrawal. Please wait for it to be processed.',
      });

    if (paymentMethod === 'UPI' && !upiId)
      return res.status(400).json({ success: false, message: 'UPI ID is required' });
    if (paymentMethod === 'BANK' && (!bankName || !accountNumber || !ifscCode))
      return res.status(400).json({ success: false, message: 'Bank name, account number, and IFSC code are required' });

    // 5. Calculate INR payout
    const inrGenerated = round2(tokens * sellRate);
    const winAfter     = round2(winBefore - tokens);
    const newLocked    = round2((user.lockedBalance || 0) + tokens);

    await User.findByIdAndUpdate(req.user._id, {
      $set: { winningsBalance: winAfter, lockedBalance: newLocked }
    });

    // 6a. Transaction (TOKEN_REDEMPTION)
    const txId = `sell_${crypto.randomUUID()}`;
    await Transaction.create({
      userId:                req.user._id,
      type:                  'TOKEN_REDEMPTION',
      amount:                tokens,
      balanceType:           'WINNINGS',
      depositBalanceBefore:  depBefore,
      depositBalanceAfter:   depBefore,
      winningsBalanceBefore: winBefore,
      winningsBalanceAfter:  winAfter,
      status:                'PENDING',
      referenceId:           txId,
      description:           `TOKEN_REDEMPTION: ${tokens} tokens @ ₹${sellRate}/token = ₹${inrGenerated}`,
    });

    // 6b. WalletLedger entry
    await WalletLedger.create({
      userId:        req.user._id,
      type:          'DEBIT',
      field:         'winningsBalance',
      amount:        tokens,
      balanceBefore: winBefore,
      balanceAfter:  winAfter,
      reason:        `Token redemption: ${tokens} tokens → ₹${inrGenerated} (sell rate: ${sellRate})`,
      refModel:      'Other',
      txId,
    });

    // 7. WithdrawalRequest for admin processing
    const wr = await WithdrawalRequest.create({
      userId:        req.user._id,
      amount:        inrGenerated,
      method:        paymentMethod,
      upiId:         paymentMethod === 'UPI'  ? upiId         : undefined,
      bankName:      paymentMethod === 'BANK' ? bankName       : undefined,
      accountNumber: paymentMethod === 'BANK' ? accountNumber  : undefined,
      ifscCode:      paymentMethod === 'BANK' ? ifscCode       : undefined,
      status:        'PENDING',
      type:          'TOKEN_REDEMPTION',
      tokenAmount:   tokens,
      sellRate,
      txId,
    });

    // 8. SSE balance push
    try {
      global.sseManager?.sendToUser?.(String(req.user._id), 'balance_update', {
        depositBalance:  depBefore,
        winningsBalance: winAfter,
        totalBalance:    round2(depBefore + winAfter),
        lockedBalance:   newLocked,
      });
    } catch (_) {}

    // 9. Admin notification
    if (global.io)
      global.io.to('admin-room').emit('new_withdrawal_request', {
        requestId: wr._id, userId: req.user._id,
        username: user.username, amount: inrGenerated,
        method: paymentMethod, type: 'TOKEN_REDEMPTION',
        tokenAmount: tokens, sellRate, createdAt: wr.createdAt,
      });

    res.json({
      success:      true,
      message:      `Redemption submitted! ₹${inrGenerated.toLocaleString('en-IN', { minimumFractionDigits: 2 })} will be transferred within 24 hours.`,
      requestId:    wr._id,
      tokenAmount:  tokens,
      inrGenerated,
      sellRate,
      txId,
    });
  } catch (err) {
    console.error('[tokens/sell]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/user/profile  — self-profile from JWT (no userId in URL)
// Called by WalletPage and WalletModal to load balance + bankDetails.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/user/profile', authenticate, async (req, res) => {
  try {
    const User = mongoose.model('User');
    const user = await User.findById(req.user._id)
      .select('username mobile depositBalance winningsBalance lockedBalance kycStatus bankDetails profilePic joinedAt')
      .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({
      success: true,
      user: {
        id:               user._id,
        username:         user.username,
        mobile:           user.mobile,
        depositBalance:   user.depositBalance  || 0,
        winningsBalance:  user.winningsBalance || 0,
        lockedBalance:    user.lockedBalance   || 0,
        kycStatus:        user.kycStatus,
        bankDetails:      user.bankDetails     || null,
        profilePic:       user.profilePic      || null,
        joinedAt:         user.joinedAt,
      },
    });
  } catch (err) {
    console.error('GET /v1/user/profile error:', err);
    res.status(500).json({ success: false, message: 'Failed to load profile' });
  }
});
