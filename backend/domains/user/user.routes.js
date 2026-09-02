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
import { authenticate } from '../identity/auth.middleware.js';
import { getUserLedger } from '../wallet/walletAuthority.service.js';
// The withdrawal rate limiters (withdrawalLimiter, createSubnetLimiter,
// globalSurgeBreaker) and the alerting import were removed with the withdrawal
// routes on 2026-08-24 — they guarded only those. The live P2P withdrawal
// endpoint keeps its own copies of the same three in domains/payment/.
// Neither the public CDN service nor the private KYC document store is imported
// here any more: KYC submission was the last caller of both in this file, and a
// module that cannot reach them cannot accidentally publish or presign an
// identity document.
import { buildPublicKycData } from './kycPublicData.js';
// The one public projection of a cycle. Real/phantom pools reveal the winner,
// so every user-facing cycle response goes through here (cyclePublicView.js).
import { publicCycleView } from '../markets/cyclePublicView.js';
import { fetchCycleHistory } from '../markets/cycleHistory.service.js';

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
// Strips ALL real/phantom breakdown fields before sending to the user — the
// winner is the minority REAL side, so realDelhi/realBombay would reveal the
// result. Delegates to the single public projection so this file has exactly
// one definition of "what a user may see about a cycle", shared with the live
// broadcasts and guarded by cyclePublicView.test.js. Admin routes keep the raw
// fields.
// ─────────────────────────────────────────────────────────────────────────────
const sanitiseCycleForUser = publicCycleView;

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
    // The query, the cap and the projection all come from cycleHistory.service
    // — the same code behind the socket request, the SSE connect payload and
    // the post-result broadcast. This route used to be a fourth copy with its
    // own 200-row ceiling, which is why the History screen could not show the
    // 1,440-result window the analytics are specified over.
    //
    // `limit` is PER TYPE. Omitting `type` returns every type at a much lower
    // per-type cap; the deep window is for one board at a time.
    const { limit, type } = req.query;
    const { cycles } = await fetchCycleHistory({ types: type, limit });
    res.json({ success: true, cycles });
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

    if (req.user.userId.toString() !== userId) {
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
    if (req.user.userId.toString() !== id) {
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

    const publicKycData = buildPublicKycData(user);

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
        // KYC documents/PII are admin-only after submission; users get status
        // plus rejection reason only when they must resubmit.
        kycData:          publicKycData,
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
    if (req.user.userId.toString() !== userId) {
      await abortOrEnd(session);
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    /*
     * `username` is the ONLY thing a player may change about themselves.
     *
     * Everything else that identifies them is proved rather than typed: the
     * mobile comes from Telegram's contact share and the Aadhaar is verified in
     * bulk, so neither is editable here or anywhere else — see §1 of the
     * governance doc. `email` was removed on 2026-08-26 along with the channel
     * that was its only consumer.
     *
     * This stays an explicit allow-list rather than a `req.body` spread. A
     * spread here would let a caller set `kycStatus`, `mobile` or a balance,
     * and strict mode would not save us — those are all declared paths.
     */
    const { username } = req.body;
    const User    = mongoose.model('User');
    const updates = {};
    if (username) updates.username = username.trim();

    if (!Object.keys(updates).length) {
      await abortOrEnd(session);
      return res.status(400).json({ success: false, message: 'Nothing to update.' });
    }

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
// POST /api/user/:userId/kyc — REMOVED 2026-08-25
//
// Took an Aadhaar number plus two verified upload keys (an ID-proof scan and a
// selfie) and moved the user to PENDING_APPROVAL for a human reviewer.
//
// KYC is no longer submitted from the app at all. The Telegram bot asks for the
// Aadhaar NUMBER before the account exists — it is a precondition of signing up,
// not a later step a player can skip — and holds it encrypted
// (domains/identity/kycVerification.model.js). Verification runs in bulk
// against the issuing authority; approve/reject in the admin panel remains as
// the exception path.
//
// One-account-per-Aadhaar is enforced by the unique index on
// KycVerification.aadhaarHash rather than by the courtesy lookup this route
// did, so a race between two simultaneous signups is refused by the database
// instead of by whichever request read first.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/user/:userId/bank-details  (auth required, atomic)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/user/:userId/bank-details', authenticate, async (req, res) => {
  const session = await safeSession();
  try {
    const { userId } = req.params;
    if (req.user.userId.toString() !== userId) {
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
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/user/referrals — a referrer's own report
//
// Deliberately NOT on the wallet screen. Only the DISBURSED portion ever
// reaches the winnings wallet; the rest is a promise whose value depends on
// other people's KYC, and mixing an unrealised promise into a balance is how a
// player comes to believe they hold money they cannot withdraw.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user/referrals', authenticate, async (req, res) => {
  try {
    const { referralSummaryFor } = await import('../referral/referral.service.js');
    const summary = await referralSummaryFor(req.user.userId);
    return res.json({ success: true, ...summary });
  } catch (error) {
    console.error('Referral summary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load your referral report' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/user/bet-limits — what this wallet can actually stake right now
//
// Exists because "how much can I bet" is NOT deposit + winnings + reserve, and
// showing that sum is what made players attempt bets the engine then refused
// with "Insufficient balance. Available: ₹1000". Only `betReservePercent` of a
// stake may come from the reserve; the rest must come from deposit + winnings,
// and a reserve shortfall shifts to main while a main shortfall has nowhere to
// go.
//
// The ceiling is computed HERE, server-side, by computeMaxStake — the same
// expression bet.routes.js enforces with. Recomputing it in the panel would be
// a second copy of a money rule, and the first divergence would show a player a
// maximum that gets refused.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user/bet-limits', authenticate, async (req, res) => {
  try {
    const { computeMaxStake } = await import('../risk/riskValidation.service.js');
    const { getRiskRules } = await import('../risk/riskValidation.service.js');

    const User = mongoose.model('User');
    const user = await User.findById(req.user.userId)
      .select('depositBalance winningsBalance reserveBalance lockedBalance').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const deposit  = user.depositBalance  || 0;
    const winnings = user.winningsBalance || 0;
    const reserve  = user.reserveBalance  || 0;
    const { betReservePercent } = await getRiskRules();

    const { maxStake } = computeMaxStake({
      reservePercent: betReservePercent,
      availableDeposit: deposit, availableWinnings: winnings, availableReserve: reserve,
    });

    // Integer paise — the operands are stored floats and subtracting the exact
    // maxStake from their sum yields 793.8199999999999.
    const totalMinor = Math.round(deposit * 100) + Math.round(winnings * 100) + Math.round(reserve * 100);
    const reserveLocked = (totalMinor - Math.round(maxStake * 100)) / 100;

    return res.json({
      success: true,
      deposit, winnings, reserve,
      locked: user.lockedBalance || 0,
      total: totalMinor / 100,
      maxStake,
      reservePercent: betReservePercent,
      reserveLocked: reserveLocked > 0 ? reserveLocked : 0,
    });
  } catch (error) {
    console.error('Bet limits error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load bet limits' });
  }
});

router.get('/user/:userId/transactions', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user.userId.toString() !== userId) {
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
    /*
     * The FAQ model is the only store. A `SystemConfig({ key: 'faq' })`
     * fallback used to sit here and was unreachable: `SystemConfig.key`
     * defaults to 'main' and is unique, nothing has ever written another key,
     * and `value` is not a declared path on that schema — so the fallback read
     * a field that could not exist on a document that could not exist.
     *
     * It was also reachable only from a `catch` around `mongoose.model('FAQ')`,
     * which throws solely when the model is unregistered — a startup fault, not
     * a data condition. Swallowing that told the caller "no FAQs" instead.
     */
    const FAQ = mongoose.model('FAQ');
    const faqs = await FAQ.find({ isPublished: true }).sort({ category: 1, order: 1 }).lean();

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

// ── Withdrawals live in the P2P funding platform, not here ──────────────────
// A second, parallel withdrawal implementation used to sit at this spot:
// POST /v1/user/withdraw + GET /v1/user/withdrawals, backed by a
// `WithdrawalRequest` collection and its own admin approve/reject pair. It was
// removed on 2026-08-24 because it was BOTH redundant and unreachable-by-design:
//
//   - No client ever called it. Every panel uses the P2P path
//     (`POST /api/p2p/withdrawal/create` → fundingAuthority → PaymentOrder).
//   - No admin UI existed for its approve/reject routes, so a request created
//     here locked the player's winnings into a record no operator could see,
//     approve or reject — the money simply stopped existing for them.
//   - It duplicated the P2P escrow down to the wallet primitive: `lockWithdrawal`
//     and `debitWinningsForWithdrawal` performed the same movement.
//
// Keeping two withdrawal systems is how a reviewer ends up hardening the one
// nobody uses. The P2P path is the single one; see domains/payment/.


// ── WALLET LEDGER — user's personal transaction history ──────────────────────
// GET /api/v1/wallet/ledger  — append-only audit trail of every balance change
router.get('/v1/wallet/ledger', authenticate, async (req, res) => { // paginated
  try {
    const { page = 1, limit = 30 } = req.query;
    const result = await getUserLedger(req.user.userId, Number(page), Number(limit));
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
    const user = await User.findById(req.user.userId)
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
