// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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

 *
 * BUG-U19 — New: GET /v1/content/support-links  → admin-configured WhatsApp /
 *                Telegram / email so users can reach support in-app.
 *
 * GET /v1/branding and the two token-rate routes were deleted 2026-10-01: no
 * client called them. Branding reaches every panel through `sendBranding()`
 * (socket) and the public SSE stream (§13); token conversion is a fixed 1:1.
 *
 */

import express from 'express';
import { db } from '#db';
import { authenticatePlayer } from '../identity/auth.middleware.js';
import { paiseToRupees } from '../../shared/money.js';
import { toPlayerLedgerEntry } from '../wallet/playerLedgerView.js';
import { getUserLedger, getBalances } from '../wallet/walletAuthority.service.js';
// The withdrawal rate limiters (withdrawalLimiter, createSubnetLimiter,
// globalSurgeBreaker) and the alerting import were removed with the withdrawal
// routes on 2026-08-24 — they guarded only those. The live P2P withdrawal
// endpoint keeps its own copies of the same three in domains/payment/.
// Neither the public CDN service nor the private KYC document store is imported
// here any more: KYC submission was the last caller of both in this file, and a
// module that cannot reach them cannot accidentally publish or presign an
// identity document.
// The one public projection of a cycle. Real/phantom pools reveal the winner,
// so every user-facing cycle response goes through here (cyclePublicView.js).
import { publicCycleView } from '../markets/cyclePublicView.js';
import { fetchCycleHistory } from '../markets/cycleHistory.service.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { systemConfigPayload } from '../configuration/systemConfigPayload.js';
import { serverError, respondError, refusal } from '../../shared/httpError.js';
import { isAccountMobileRefusal, ACCOUNT_IS_A_MOBILE_MESSAGE } from '../payment/payoutAccount.js';

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
// GET /api/v1/user/:id/data  (auth required)
// BUG-U5 FIX: Now returns bets[], history[], kycData, bankDetails.
// BUG-U6 FIX: Now returns walletBalance = depositBalance + winningsBalance.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/user/:id/data', authenticatePlayer, async (req, res) => {
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
router.put('/user/:userId/profile', authenticatePlayer, async (req, res) => {
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
router.put('/user/:userId/bank-details', authenticatePlayer, async (req, res) => {
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
    // The member who pays a sell is shown this account, so one whose number
    // is the player's mobile is refused by the row (§24, Step 2d).
    if (isAccountMobileRefusal(error)) {
      return res.status(400).json({ success: false, code: 'ACCOUNT_IS_A_MOBILE', message: ACCOUNT_IS_A_MOBILE_MESSAGE });
    }
    console.error('Update bank details error:', error);
    res.status(500).json({ success: false, message: 'Failed to update bank details' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/user/referrals — a referrer's own report
//
// Deliberately NOT on the wallet screen. Only the DISBURSED portion ever
// reaches the winnings wallet; the rest is a promise whose value depends on
// other people's KYC, and mixing an unrealised promise into a balance is how a
// player comes to believe they hold money they cannot withdraw.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user/referrals', authenticatePlayer, async (req, res) => {
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
// GET /api/user/general — the GENERAL (promotional) profile: the profile in
// use, the balance, and each referral bonus with its 10× turnover progress
// (owner, 2026-10-08; `db.promo`). Amounts in rupees, like every player route.
//
// PUT /api/user/play-profile { profile: 'VIP' | 'GENERAL' } — switch profile.
// The panel switches to VIP when the player opens Deposit.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user/general', authenticatePlayer, async (req, res) => {
  try {
    const s = await db.promo.promoSummary(req.user.userId);
    return res.json({
      success: true,
      profile: s.profile,
      promoBalance: paiseToRupees(s.promoBalancePaise),
      outstandingTurnover: paiseToRupees(s.outstandingTurnoverPaise),
      turnoverMultiplier: s.turnoverMultiplier,
      grants: s.grants.map((g) => ({
        grantId: g.grantId,
        source: g.source,
        amount: paiseToRupees(g.amountPaise),
        requiredTurnover: paiseToRupees(g.requiredTurnoverPaise),
        turnover: paiseToRupees(g.turnoverPaise),
        completedAt: g.completedAt,
        unlocked: paiseToRupees(g.unlockedPaise),
        createdAt: g.createdAt,
      })),
    });
  } catch (error) {
    return respondError(res, error, 'GET /api/user/general', { message: 'Failed to load your General balance' });
  }
});

router.put('/user/play-profile', authenticatePlayer, async (req, res) => {
  try {
    const r = await db.promo.setPlayProfile(req.user.userId, String(req.body?.profile ?? ''));
    if (!r.ok) throw refusal(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    return res.json({ success: true, profile: r.profile });
  } catch (error) {
    return respondError(res, error, 'PUT /api/user/play-profile', { message: 'Could not switch profile' });
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
router.get('/user/bet-limits', authenticatePlayer, async (req, res) => {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/system/config  (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/system/config', async (req, res) => {
  try {
    // One owner for this payload — see domains/configuration/systemConfigPayload.js.
    // The literal that used to sit here was a copy of the socket's, written with
    // `||` where that one used `??`, so an operator who set a limit to 0 ("no
    // minimum") was served the default over HTTP and the real 0 over the socket.
    res.json({ success: true, config: systemConfigPayload(await getSystemConfig()) });
  } catch (error) {
    console.error('System config error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch config' });
  }
});

// `GET /api/v1/content/promo/:location` was removed 2026-10-01. No client
// called it: the player app asks over the socket (`request_promo` →
// `promo_data`, socketHandlers.js), which reads the same `listLivePromos` and
// also upper-cases the location this route did not. Two doors to one read is a
// second one to keep correct for nobody.

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
router.get('/v1/wallet/ledger', authenticatePlayer, async (req, res) => { // paginated
  try {
    const { page = 1, limit = 30 } = req.query;
    const result = await getUserLedger(req.user.userId, Number(page), Number(limit));
    // The player's view of each entry: an admin adjustment's note and the
    // staff id in it are for the audit trail, not the player (playerLedgerView).
    res.json({ success: true, ...result, entries: result.entries.map(toPlayerLedgerEntry) });
  } catch (err) {
    return serverError(res, err, 'GET /v1/wallet/ledger');
  }
});

// ── Notification inbox ──────────────────────────────────────────────────────
/**
 * The read side of a table the platform was already writing to.
 *
 * `notify()` persists a row on real events — an admin blocking or unblocking an
 * account is the live one — and the IN_APP channel's comment described it as
 * going to "the existing bell-icon inbox all three panels already read". No
 * panel read it. There was no route to read it THROUGH. So a player was blocked,
 * the system carefully recorded the explanation meant for them, and they could
 * never see it: they simply found themselves locked out.
 *
 * Ownership is in the WHERE clause of every one of these, not in a check
 * afterwards — `listNotifications`, `unreadCount` and `markRead` all take the
 * user id and scope by it, so a caller cannot read or acknowledge somebody
 * else's notification even by id.
 */
router.get('/user/notifications', authenticatePlayer, async (req, res) => {
  try {
    const unreadOnly = String(req.query.unreadOnly || '') === 'true';
    // The repository clamps this to 1..200; parsing here keeps a bad query
    // string from reaching it as NaN.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const [notifications, unread] = await Promise.all([
      db.engagement.listNotifications(String(req.user.userId), { unreadOnly, limit }),
      db.engagement.unreadCount(String(req.user.userId)),
    ]);
    res.json({ success: true, notifications, unreadCount: unread });
  } catch (err) {
    console.error('GET /user/notifications error:', err);
    res.status(500).json({ success: false, message: 'Failed to load notifications' });
  }
});

/**
 * Just the badge number.
 *
 * Separate from the list because a bell icon polls this and rendering the inbox
 * is the rarer act — asking for fifty rows to show one integer is the kind of
 * read that looks free until there are players.
 */
router.get('/user/notifications/unread-count', authenticatePlayer, async (req, res) => {
  try {
    res.json({ success: true, unreadCount: await db.engagement.unreadCount(String(req.user.userId)) });
  } catch (err) {
    console.error('GET /user/notifications/unread-count error:', err);
    res.status(500).json({ success: false, message: 'Failed to load unread count' });
  }
});

/**
 * Acknowledge. `ids` marks those; omitting it marks everything unread.
 *
 * Returns how many rows actually changed, so a caller can tell "marked four"
 * from "those were already read" — and so an id belonging to somebody else
 * reports 0 rather than succeeding silently.
 */
router.post('/user/notifications/read', authenticatePlayer, async (req, res) => {
  try {
    const raw = req.body?.ids;
    if (raw !== undefined && !Array.isArray(raw)) {
      return res.status(400).json({ success: false, message: 'ids must be an array when provided' });
    }
    const ids = Array.isArray(raw)
      ? raw.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : null;
    // An array that contained nothing usable marks nothing, and needs no guard
    // here to do it: `markRead` takes the ids branch for ANY array — `[]`
    // included — so the statement becomes `id = ANY('{}')` and matches no row.
    // Only a null `ids` means "everything unread". An early return for the
    // empty case would be a second place stating the same rule.
    const marked = await db.engagement.markRead(String(req.user.userId), { ids });
    res.json({ success: true, marked });
  } catch (err) {
    console.error('POST /user/notifications/read error:', err);
    res.status(500).json({ success: false, message: 'Failed to mark notifications read' });
  }
});

export default router;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/user/profile  — self-profile from JWT (no userId in URL)
// Called by WalletPage and WalletModal to load balance + bankDetails.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/v1/user/profile', authenticatePlayer, async (req, res) => {
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
