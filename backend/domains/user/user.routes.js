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
 */

import express from 'express';
import { db } from '#db';
import { authenticate } from '../identity/auth.middleware.js';
import { getUserLedger, getBalances } from '../wallet/walletAuthority.service.js';
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
import { getSystemConfig } from '#db/repositories/config.js';

const router = express.Router();


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
    // `end_time > now()` as well as the status. A cycle whose generator died
    // still reads OPEN, and offering it takes bets on a round that will never
    // settle — the exact failure that let the engine look healthy while
    // nothing was being resolved.
    const cycles = await db.markets.listActiveCycles();
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
    const cycle = await db.markets.getCycle(cycleId);
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
    const startMs = parseInt(startTime, 10);

    // The tolerance and the celebration-window fallback both live in the
    // repository now: a page loading on a cycle boundary must still find the
    // round it is showing, and during the celebration the current cycle has
    // completed while the next has not opened — returning nothing there blanks
    // the page mid-animation.
    const cycle = await db.markets.getCycleAt(type, startMs);

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

    // Phantom bets are house liquidity placed under a managed account. They
    // are excluded by DEFAULT in the repository — showing a player wagers they
    // never made is not a display bug, it is a dispute.
    const { bets, total } = await db.bets.listUserBets(userId, {
      cycleId: cycleId || null,
      status: status || null,
      limit: parsedLimit,
    });

    res.json({
      success: true,
      bets,
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


    // The balances come from the WALLET, not the account. The accounts table
    // has no balance columns — they live in `wallets`, behind the row lock
    // every movement takes — so reading them off the account returns undefined
    // for all of them and shows the player zero.
    const [user, balances, recentBets] = await Promise.all([
      db.users.getUser(id),
      getBalances(String(id)),
      db.bets.listUserBets(id, { limit: 50 }),
    ]);

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const depositBalance  = balances.depositBalance  || 0;
    const winningsBalance = balances.winningsBalance || 0;
    const lockedBalance   = balances.lockedBalance   || 0;
    const walletBalance   = depositBalance + winningsBalance;

    const normalizedBets = recentBets.bets;

    // history = last 20 cycle IDs the user bet in (for LiveTicker dots)
    const historyCycleIds = [...new Set(normalizedBets.map(b => b.cycleId))].slice(0, 20);

    const publicKycData = buildPublicKycData(user);

    res.json({
      success: true,
      user: {
        id:               user.userId,
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
  try {
    const { userId } = req.params;
    if (req.user.userId.toString() !== userId) {
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
    const updates = {};
    if (username) updates.username = username.trim();

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'Nothing to update.' });
    }

    const updatedUser = await db.users.updateUser(userId, updates);

    res.json({ success: true, user: { id: updatedUser.userId, username: updatedUser.username, profilePic: updatedUser.profilePic } });
  } catch (error) {
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
  try {
    const { userId } = req.params;
    if (req.user.userId.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { accountHolderName, accountNumber, ifscCode, bankName } = req.body;
    if (!accountHolderName || !accountNumber || !ifscCode || !bankName) {
      return res.status(400).json({ success: false, message: 'All bank detail fields are required' });
    }

    // The IFSC is uppercased once, here. A code stored in two cases is two
    // different bank accounts as far as any comparison is concerned, and a
    // withdrawal is paid to whichever spelling the panel last wrote.
    await db.users.updateUser(userId, {
      bankDetails: {
        accountHolderName, accountNumber,
        ifscCode: String(ifscCode).toUpperCase(), bankName,
      },
    });

    res.json({ success: true });
  } catch (error) {
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

    // From the WALLET. This computes the maximum stake the panel OFFERS, so a
    // balance read that comes back empty does not merely display wrong — it
    // shows the player a ceiling of zero and they cannot bet at all.
    const balances = await getBalances(String(req.user.userId));

    const deposit  = balances.depositBalance  || 0;
    const winnings = balances.winningsBalance || 0;
    const reserve  = balances.reserveBalance  || 0;
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
      locked: balances.lockedBalance || 0,
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

    const { limit = 30, skip = 0 } = req.query;
    // SEC 2.7 FIX: cap pagination to prevent DoS
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 30, 1), 100);
    const parsedSkip  = Math.max(parseInt(skip) || 0, 0);

    // The player's funding history comes from their ORDERS, which is where a
    // deposit or a withdrawal actually lives. The separate transaction
    // collection this read was a projection written alongside them, and a
    // projection of one store by another is a second record that can disagree
    // with the first — it is deleted.
    const { orders, total } = await db.orders.findOrders({
      userId,
      states: null,
      limit: parsedLimit,
    });

    res.json({
      success: true,
      transactions: orders.map((o) => ({
        id:        o.orderId,
        type:      o.type,
        amount:    o.tokenAmount,
        status:    o.status,
        reference: o.utr || o.orderId || '',
        note:      o.cancelReason || o.rejectedReason || '',
        createdAt: o.createdAt,
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
    const config = await getSystemConfig();

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
    // PUBLISHED and active, not merely active. A draft with `isActive` left
    // on was reaching the home page — the two flags mean different things and
    // the query only checked one of them.
    const content = await db.content.listLivePromos(location);
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
     * One owner. A config-document fallback used to sit here and was
     * unreachable twice over: it read a key nothing had ever written, off a
     * field that was not declared — and it was reachable only from a `catch`
     * that fired on a startup fault rather than on any data condition.
     * Swallowing that told the caller "no FAQs" instead of failing.
     */
    const faqs = await db.content.listFaqs({ publishedOnly: true });

    res.json({
      success: true,
      faqs: faqs.map(f => ({
        id:       f.faqId,
        question: f.question,
        answer:   f.answer,
        category: f.category || 'General',
      })),
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
    // ONE source. There were two — a dedicated collection and a nested field
    // on the system config — with a fallback from the first to the second, so
    // whichever an admin last edited was whichever the page happened to show.
    // Both are the `supportLinks` configuration scope now, and every key it
    // declares reads as its default when nothing has been set.
    const { key, version, updatedAt, updatedBy, ...links } = await db.config.getConfig('supportLinks');
    // No per-field `|| ''`: `getConfig` already filled every declared key with
    // its default, and the list those fallbacks re-stated had drifted — it
    // omitted `termsUrl` and `privacyUrl`, so two links an admin could set were
    // dropped on the way out.
    res.json({ success: true, links });
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
    // Filtered on the WINNER, not the status: a cycle whose result is in is
    // what this reads, and a status filter would miss a declared cycle whose
    // settlement is still running.
    const cycles = await db.markets.recentResults(type, { limit: 10 });

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
    // Branding is a configuration scope, so every key reads as its declared
    // default when nothing has been set — no `|| {}` and no per-field fallback
    // scattered through the response below.
    const b = await db.config.getConfig('branding');

    // The environment variable is the BOOTSTRAP value; an admin setting one
    // here overrides it without a redeploy.
    const cdnBaseUrl = b.cdnBaseUrl || process.env.CDN_URL || '';

    res.json({
      success: true,
      branding: {
        appName:      b.appName,
        cdnBaseUrl,
        primaryColor: b.primaryColor,
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
    const config = await getSystemConfig();
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
    const config = await getSystemConfig();
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
    // The wallet page reads this for the balance it shows. From `wallets`, not
    // the account — the accounts table has no balance columns.
    const [user, balances] = await Promise.all([
      db.users.getUser(req.user.userId),
      getBalances(String(req.user.userId)),
    ]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({
      success: true,
      user: {
        id:               user.userId,
        username:         user.username,
        mobile:           user.mobile,
        depositBalance:   balances.depositBalance  || 0,
        winningsBalance:  balances.winningsBalance || 0,
        lockedBalance:    balances.lockedBalance   || 0,
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
