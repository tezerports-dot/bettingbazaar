// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
import mongoose from 'mongoose';
import { withdrawalLimiter } from '../../middleware/security.js';
// Item 12: per-subnet backstop against IP rotation on withdrawal creation.
import { createSubnetLimiter, globalSurgeBreaker } from '../../middleware/ipDefense.js';
import { authenticate } from '../identity/auth.middleware.js';
import { lockWithdrawal, getUserLedger } from '../wallet/walletAuthority.service.js';
import cdnService from '../../services/cdn.service.js';
import { hashAadhaar, hashAadhaarCandidates } from '../identity/aadhaarHash.util.js';

const router = express.Router();

function normalizeSubmittedAadhaar(raw) {
  const value = String(raw || '').trim();
  if (!/^[\d -]+$/.test(value)) return null;
  const normalized = value.replace(/[ -]/g, '');
  return /^\d{12}$/.test(normalized) ? normalized : null;
}

function maskAadhaar(normalized) {
  return `XXXX-XXXX-${normalized.slice(-4)}`;
}

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
        'username mobile email depositBalance winningsBalance lockedBalance kycStatus kycData bankDetails profilePic joinedAt lastLogin roles isAdmin phantomAccess'
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
        email:            user.email || '',
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

    const { username, email } = req.body;
    const User    = mongoose.model('User');
    const updates = {};
    if (username)   updates.username   = username.trim();
    // Optional contact email (Phase E) — the EMAIL notification channel delivers
    // only to users who set one. Accept a valid address, or '' to clear it.
    if (email !== undefined) {
      const trimmed = String(email).trim().toLowerCase();
      if (trimmed !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        await abortOrEnd(session);
        return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
      }
      updates.email = trimmed;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true, session }).lean();
    await commitOrEnd(session);

    res.json({ success: true, user: { id: updatedUser._id, username: updatedUser.username, profilePic: updatedUser.profilePic, email: updatedUser.email || '' } });
  } catch (error) {
    await abortOrEnd(session);
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/user/:userId/kyc  (auth required, atomic)
// Requires verified upload file keys; user-supplied document URLs are rejected.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/user/:userId/kyc', authenticate, async (req, res) => {
  const session = await safeSession();
  try {
    const { userId } = req.params;
    if (req.user._id.toString() !== userId) {
      await abortOrEnd(session);
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { nameOnAadhaar, aadhaarNumber, idProofKey, idProofCdnUrl, photoKey, photoCdnUrl } = req.body;
    const normalizedNameOnAadhaar = String(nameOnAadhaar || '').trim().toUpperCase();
    const normalizedAadhaarNumber = normalizeSubmittedAadhaar(aadhaarNumber);
    if (!normalizedNameOnAadhaar || !normalizedAadhaarNumber || !idProofKey || !photoKey) {
      await abortOrEnd(session);
      return res.status(400).json({ success: false, message: 'All KYC fields and uploaded document file keys are required' });
    }

    const [idProof, photo] = await Promise.all([
      cdnService.verifyUploadedObject({
        fileKey: idProofKey, cdnUrl: idProofCdnUrl || undefined,
        expectedUserId: req.user._id.toString(), expectedCategory: 'kyc/id-proof'
      }),
      cdnService.verifyUploadedObject({
        fileKey: photoKey, cdnUrl: photoCdnUrl || undefined,
        expectedUserId: req.user._id.toString(), expectedCategory: 'kyc/selfie'
      }),
    ]);

    const User = mongoose.model('User');
    const aadhaarHash = hashAadhaar(normalizedAadhaarNumber);
    const existingAadhaar = await User.findOne({
      _id: { $ne: userId },
      aadhaarHash: { $in: hashAadhaarCandidates(normalizedAadhaarNumber) }
    }).session(session).select('_id').lean();
    if (existingAadhaar) {
      await abortOrEnd(session);
      return res.status(409).json({ success: false, message: 'Aadhaar already linked to another account' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        kycStatus: 'PENDING_APPROVAL',
        kycData: {
          nameOnAadhaar: normalizedNameOnAadhaar,
          aadhaarNumber: maskAadhaar(normalizedAadhaarNumber),
          idProofUrl: idProof.cdnUrl,
          photoUrl: photo.cdnUrl,
          submittedAt: new Date(),
          rejectionReason: ''
        },
        aadhaarHash
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
    const config = await SystemConfig.findOne({ key: 'main' }).lean();

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
        // Fixed 1:1 conversion (Phase 006 flattening, 2026-07-08)
        tokenBuyRate:     1,
        tokenSellRate:    1,
        // Admin-owned (Business Config Audit 2026-07-11) — was hardcoded 2.
        payoutMultiplier: config?.payoutMultiplier ?? 2,
        maintenanceMode:  config?.maintenanceMode  || false,
        maintenanceMessage: config?.maintenanceMessage || '',
        // Footer navigation (2026-07-13) — schema default: the historical five tabs
        footerPages:      config?.footerPages?.length ? config.footerPages : ['home', 'results', 'winners', 'promo', 'profile'],
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
        whatsapp:           raw.whatsapp           || '',
        telegram:           raw.telegram           || '',
        telegramUsername:   raw.telegramUsername   || '',
        telegramGroupUrl:   raw.telegramGroupUrl   || '',
        telegramChannelUrl: raw.telegramChannelUrl || '',
        instagram:          raw.instagram          || '',
        youtube:            raw.youtube            || '',
        email:              raw.email              || '',
        phone:              raw.phone              || '',
        helpCenterUrl:      raw.helpCenterUrl      || '',
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
router.post('/v1/user/withdraw', withdrawalLimiter, createSubnetLimiter('withdrawal'), globalSurgeBreaker('withdrawal'), authenticate, async (req, res) => {
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
// GET /api/v1/tokens/rate  — public token exchange rates.
// Fixed 1:1 internal conversion (Phase 006 flattening, 2026-07-08): 1 BB
// token = ₹1, no buy/sell spread. Response shape kept for client compat.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/tokens/rate', async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
    res.json({
      success:        true,
      buyRate:        1,
      sellRate:       1,
      ratesConfigured: true, // rates are no longer configurable — always 1:1
      minExchange:    config?.minWithdrawal ?? 500  /* schema default — was incorrectly 100 (GOVERNANCE.md M-5) */,
      maxExchange:    config?.maxWithdrawal ?? 50000,
      currency:       'INR',
      updatedAt:      null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/token/rates  — canonical alias used by WalletModal + WalletPage
// (WalletModal calls /api/v1/token/rates; old route was /v1/tokens/rate)
// Both return the same fixed 1:1 values.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/token/rates', async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
    res.json({
      success:  true,
      rates: { buyRate: 1, sellRate: 1, updatedAt: null },
      minExchange: config?.minWithdrawal ?? 500  /* schema default — was incorrectly 100 (GOVERNANCE.md M-5) */,
      maxExchange: config?.maxWithdrawal ?? 50000,
      // Flat fields for back-compat
      buyRate:  1,
      sellRate: 1,
    });
  } catch (err) {
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
      .select('username mobile email depositBalance winningsBalance lockedBalance kycStatus bankDetails profilePic joinedAt')
      .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({
      success: true,
      user: {
        id:               user._id,
        username:         user.username,
        mobile:           user.mobile,
        email:            user.email || '',
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
