// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Domain: Merchant (BBEPS Phase 003 §3.3) — player-facing merchant registration/auth.
// Moved from backend/routes/merchant.routes.js on 2026-07-01 (BBEPS Phase 004 migration).


import express   from 'express';
import { db } from '#db';
// AQ-8: hash via the password authority (argon2id + bcrypt verify-fallback).
import { hashPassword } from '../identity/password.util.js';
import { merchantAuth } from '../../middleware/merchantAuth.js';
// The merchant sign-in door: routes.js's handlers with this door's limits (§33).
import { doorRoute } from '../identity/loginDoors.js';
import { openChallenge } from '../identity/telegramChallenge.service.js';
import { miniAppBot } from '../telegram/telegramClient.js';
import { telegramStatus, telegramRelink, telegramTwoFactor } from '../identity/accountTelegram.js';
import { normalisePhone, isValidMobile } from '../identity/signupFields.js';
import { releaseUTR } from '../../middleware/utrValidation.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import {
    tryAssignMerchant, buildMerchantSnapshot, updateMerchantStatsOnComplete,
} from '../payment/paymentProcessing.service.js';
// The order state machine. Every status change is a guarded transition, and
// where money moves the transition runs FIRST and gates it.
import {
  startOrder, markOrderPaid as markOrderPaidState, completeOrder,
  disputeOrder, rejectOrder as rejectOrderState, requeueOrder,
} from '../payment/orderLifecycle.service.js';
// Withdrawal settlement hold — confirm asserts payment, the worker settles it
// once the dispute window passes. See withdrawalHold.service.js.
import { holdMinutes } from '../payment/withdrawalHold.service.js';
import { rejectedBuyDisputeMinutes, unpaidRejectRefusal } from '../payment/rejectedBuyWindow.service.js';
// A push to the PLAYER's socket goes through the player projection, like every
// other thing a player receives.
import { toPlayerOrderView } from '../payment/playerOrderView.js';
// One rule for how a confirmed deposit splits across the user's two pockets.
import { moveDepositMoney } from '../payment/depositCredit.js';
import { publish as publishDomainEvent, EVENTS as DOMAIN_EVENTS } from '../../services/eventBus.service.js';
// Order chat. Every write here named a model registered nowhere, so the thread
// echoed over the socket and never survived a reload.
// Only the order's own timeline now — the record a dispute is decided from.
// listMessages/postMessage went with the merchant order chat above.
import { postSystemMessage } from '#db/repositories/chat.js';
// Every external payment reference — a UTR, a chain transaction hash — is
// claimed through ONE registry, so the same payment cannot be presented twice.
import { claimPaymentReference, referenceSpecFor } from '../payment/paymentReference.js';
import cdnService from '../../services/cdn.service.js';
import { respondError } from '../../shared/httpError.js';

/** Is Postgres the source of truth for the merchant side of a settlement? */
import {
  MERCHANT_CURRENCY, merchantTypeOf, formatOrderFiat,
  USDT_CHAINS, USDT_CHAIN_SPEC, isUsdtAddress, usdtAddressFor, usdtChainsHeldBy,
} from './merchantCurrency.js';
import { toMerchantOrderView, toMerchantOrderViews } from './merchantOrderView.js';
import { railOf, routingSettings, PAYMENT_MODES } from '#db/repositories/teamRouting.js';
// What a cash buy's ATM link may be (Step 2d).
import { checkCashLink } from '../payment/cashLink.js';
import { isAccountMobileRefusal, ACCOUNT_IS_A_MOBILE_MESSAGE } from '../payment/payoutAccount.js';
import { NAME_IS_A_MOBILE_MESSAGE } from '../identity/mobileInText.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { recordMerchantRefusal, REFUSAL } from './merchantRefusal.service.js';
import { assertStaffPassword } from '../identity/passwordPolicy.js';

const router     = express.Router();

/**
 * What a member is told when an admin handed the order to somebody else between
 * their read and their action: every member transition below pins the member
 * (`expectMerchant`), so nothing was changed (security review, 2026-10-03).
 */
const NO_LONGER_YOURS = 'This order has been moved to another member, so nothing was changed. Refresh your orders.';
// JWT secret + expiry owned by jwt.util.js — removed a '|| fallback-secret'
// default here (AQ-1): a missing secret must fail-fast, never sign with a
// public string that would let anyone forge merchant tokens.

// ─── HELPERS ─────────────────────────────────────────────────────────────────





/**
 * The merchant's own view of their account. A member holds no tokens — their
 * team's pool does (§3.10) — so there is no balance here; the Team page shows
 * the pool.
 */
const formatMerchant = async (merchant, user = null) => {
    // A merchant settles on exactly one rail; the panel renders the bank account
    // OR the USDT addresses from this, never both (domains/merchant/merchantCurrency.js).
    // merchantTypeOf() is used rather than the `merchantType` virtual so lean()
    // documents (which carry no virtuals) format identically to hydrated ones.
    const merchantType = merchantTypeOf(merchant);
    return {
        id:                   merchant._id,
        _id:                  merchant._id,
        userId:               merchant.userId,
        name:                 merchant.name,
        username:             user?.username || merchant.username,
        mobile:               user?.mobile   || merchant.mobile,
        email:                merchant.email,
        status:               merchant.status,
        isOnline:             merchant.isOnline,
        acceptsDeposits:      merchant.acceptsDeposits,
        acceptsWithdrawals:   merchant.acceptsWithdrawals,
        merchantType,
        acceptedCurrencies:   merchant.acceptedCurrencies,
        bankDetails:          merchant.bankDetails,
        // One per chain, and the list of chains they can actually be paid on
        // — which is what decides whether any USDT order reaches them.
        usdtAddressTrc20:     merchant.usdtAddressTrc20 || '',
        usdtAddressBep20:     merchant.usdtAddressBep20 || '',
        usdtChains:           usdtChainsHeldBy(merchant),
        limits:               merchant.limits,
        // Whether the platform has stopped sending them new buy orders (three
        // unpaid in a row, §2). A merchant was never told: the Dashboard read
        // "Online · Accepting orders" while no order could reach them. Only the
        // TIME is sent — the stored reason is written for an admin.
        assignmentPausedAt:   merchant.assignmentPausedAt ?? null,
        // A CASH member's Ready: at the machine and able to take a buy. Each
        // buy assigned to them switches it off (§3.10, 2c).
        cashReady:            merchant.cashReady === true,
        earnings:             merchant.earnings,
        totalProcessedVolume: merchant.totalProcessedVolume,
        // Performance figures the panel's dashboard/profile show; all are
        // maintained by the order lifecycle — read-only here.
        totalDepositsProcessed:    merchant.totalDepositsProcessed,
        totalDepositAmount:        merchant.totalDepositAmount,
        totalWithdrawalsProcessed: merchant.totalWithdrawalsProcessed,
        totalWithdrawalAmount:     merchant.totalWithdrawalAmount,
        successRate:               merchant.successRate,
        avgResponseMinutes:        merchant.avgResponseMinutes,
        disputeRate:               merchant.disputeRate,
        totalOrdersCompleted:      merchant.totalOrdersCompleted,
        rating:               merchant.rating,
        createdAt:            merchant.createdAt,
    };
};

// ─── AUTH: SIGNUP & LOGIN ─────────────────────────────────────────────────────


// ── Auto system message helper ────────────────────────────────────────────────
async function sendSystemMessage(orderId, message, io) {
    // postSystemMessage swallows-and-logs its own failure: the order really did
    // change state whether or not the note about it landed. It returns null in
    // that case, and there is then nothing to broadcast.
    const chat = await postSystemMessage(orderId, message);
    if (chat && io) {
        const oid = String(orderId);
        io.to(`order_${oid}`).emit(`chat_${oid}`, { ...chat, orderId: oid });
    }
}

router.post('/auth/signup', async (req, res) => {
    try {
        const { username, password, email, bankDetails } = req.body;
        if (!username || !req.body?.mobile || !password) {
            return res.status(400).json({ success: false, code: 'FIELDS_REQUIRED', message: 'username, mobile and password are required' });
        }
        // The mobile Telegram will verify: ten digits, as the player form takes
        // it, because the link's phone must EQUAL it (telegram_link_phone_is_mobile).
        if (!isValidMobile(req.body.mobile)) {
            return res.status(400).json({ success: false, code: 'MOBILE_INVALID',
                message: 'Enter your 10-digit mobile number — the one on your Telegram account — without +91.' });
        }
        const mobile = normalisePhone(req.body.mobile);

        // ONE TRANSACTION for the account, the merchant record and the wallet.
        //
        // This used to be two unrelated writes. A failure on the second left an
        // account flagged as a merchant with no merchant record behind it: an
        // applicant who could never log in, whose mobile was now taken, and who
        // could not reapply. The login path had grown a repair for the
        // neighbouring case — data repair inside an authentication path.
        //
        // The mobile's uniqueness is decided by the index, not by a prior
        // lookup: two applications on the same number arriving together both
        // pass a check, and only one INSERT can win.
        // A merchant holds platform float and sees the account a payout pays.
        // Same floor as a sub-admin, for the same reason: no second factor is
        // required of them either, so the password is the whole credential.
        try {
            assertStaffPassword(password, { mobile, username }, 'merchant');
        } catch (e) {
            return res.status(e.status || 400).json({ success: false, code: e.code, message: e.message });
        }

        const created = await db.merchants.createMerchantAccount({
            userId: db.users.newUserId(),
            username, mobile,
            email: email || null,
            passwordHash: await hashPassword(password),
            // A bank account, never a UPI handle (§2, §24): one sent is not kept.
            bankDetails: bankDetails ? {
                bankName: bankDetails?.bankName || null,
                accountNo: bankDetails?.accountNo || null,
                ifsc: bankDetails?.ifsc || null,
            } : null,
        });

        if (!created.ok && created.reason === 'ACCOUNT_IS_A_MOBILE') {
            return res.status(400).json({ success: false, code: 'ACCOUNT_IS_A_MOBILE', message: ACCOUNT_IS_A_MOBILE_MESSAGE });
        }
        if (!created.ok && created.reason === 'NAME_IS_A_MOBILE') {
            return res.status(400).json({ success: false, code: 'NAME_IS_A_MOBILE', message: NAME_IS_A_MOBILE_MESSAGE });
        }
        if (!created.ok) {
            // Named, because "signup failed" tells an applicant nothing they
            // can act on — and a payment credential already registered to
            // someone else is a different problem from a taken mobile.
            const message = created.reason === 'MOBILE_TAKEN'
                ? 'Mobile number already registered'
                : 'Those payment details are already registered to another merchant';
            return res.status(409).json({ success: false,
                code: created.reason === 'MOBILE_TAKEN' ? 'MOBILE_TAKEN' : 'CREDENTIALS_TAKEN', message });
        }

        // ── The Telegram step (Step 3) ─────────────────────────────────────
        // Verification and approval are independent: the applicant verifies
        // their mobile now, while the application waits, and signing in needs
        // both. No bot is the platform's state: they verify at their first
        // sign-in once one exists.
        const bot = await miniAppBot();
        const opened = bot
            ? await openChallenge({ purpose: 'VERIFY', door: 'MERCHANT', userId: created.userId, req })
            : null;
        res.json({
            success: true,
            verificationRequired: true,
            verificationAvailable: Boolean(opened),
            challengeToken: opened?.challengeToken ?? null,
            telegram: opened?.telegram ?? null,
            message: 'Application submitted. Verify your mobile number in Telegram now; an admin will review and approve your account.',
        });
    } catch (error) {
        console.error('Merchant signup error:', error);
        res.status(500).json({ success: false, message: 'Signup failed. Please try again.' });
    }
});

// ── The merchant sign-in door (§33): routes.js's handlers, this door's limits.
// The read is the merchant's LOGIN row (`users`, account_type MERCHANT) by
// mobile; signing in by merchant username is gone (Step 3: "the same way").
router.post('/auth/login', ...doorRoute('MERCHANT', 'login'));
router.post('/auth/login/2fa', ...doorRoute('MERCHANT', 'twoFactor'));
router.post('/auth/login/telegram', ...doorRoute('MERCHANT', 'telegram'));
router.post('/auth/login/telegram/complete', ...doorRoute('MERCHANT', 'telegramComplete'));

// ── The merchant's own Telegram link (accountTelegram.js) ──────────────────
// `merchantAuth` leaves the login row's id on `req.userId`.
router.get('/telegram', merchantAuth, telegramStatus);
router.post('/telegram/relink', merchantAuth, telegramRelink);
router.put('/telegram/two-factor', merchantAuth, telegramTwoFactor);

// ─── PROFILE ─────────────────────────────────────────────────────────────────

router.get('/profile', merchantAuth, async (req, res) => {
    try {
        const merchant = await db.merchants.getMerchant(req.merchantId);
        if (!merchant) return res.status(404).json({ success: false, message: 'Merchant profile not found.' });
        // Fixed 1:1 internal conversion (Phase 006 flattening, 2026-07-08):
        // no buy/sell spread. Shape kept for merchant-panel compatibility;
        // merchant earnings are team commission (2e, teamCommission.js).
        res.json({
            success: true,
            merchant: {
                ...(await formatMerchant(merchant, req.user)),
                prices: { buyPrice: 1, sellPrice: 1, profit: 0 },
            },
        });
    } catch (err) {
        console.error('GET /merchant/profile error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
    }
});

// FIX B5-d: PUT /profile — merchant edits their own settlement credentials.
// Rail-exclusive (2026-07-27): an INR merchant may edit the bank account and
// NOT the USDT addresses; a USDT merchant may edit only those. Enforced here
// and not merely hidden in the panel, so a hand-crafted request cannot leave a
// merchant holding credentials for a rail they do not settle on. Only the admin
// (PUT /merchants/:id/capabilities) can change which rail a merchant is on.
//
// There is no UPI handle to edit, so `upiId` is not read from the body: a
// UPI_BANK buy is paid into the member's bank account and nobody is shown a
// handle (§2 "How each rail is paid", §24).
//
// A USDT merchant holds an address PER CHAIN and may hold one, the other, or
// both — the chains are separate networks and an address on one cannot receive
// on the other. Holding both means orders on both chains are offered to them;
// holding neither means they are offered none, which is why clearing the last
// one is refused with a sentence rather than accepted silently.
router.put('/profile', merchantAuth, async (req, res) => {
    try {
        const { bankDetails, usdtAddressTrc20, usdtAddressBep20 } = req.body;
        const submittedAddresses = { TRC20: usdtAddressTrc20, BEP20: usdtAddressBep20 };

        const current = await db.merchants.getMerchant(req.merchantId);
        if (!current) return res.status(404).json({ success: false, message: 'Merchant profile not found.' });

        const isUsdt  = merchantTypeOf(current) === MERCHANT_CURRENCY.USDT;
        const railName = isUsdt ? 'USDT' : 'INR';
        const update  = {};

        const wantsInrFields  = bankDetails !== undefined;
        const wantsUsdtFields = USDT_CHAINS.some((chain) => submittedAddresses[chain] !== undefined);

        if (isUsdt && wantsInrFields) {
            return res.status(400).json({ success: false, message: `This is a ${railName} merchant account — bank details do not apply. Update the USDT wallet addresses instead.` });
        }
        if (!isUsdt && wantsUsdtFields) {
            return res.status(400).json({ success: false, message: `This is a ${railName} merchant account — a USDT wallet address does not apply. Update the bank details instead.` });
        }

        if (wantsUsdtFields) {
            // What the merchant will hold AFTER this write: the submitted value
            // where one was sent, the stored value where it was not. Validating
            // the submitted fields alone cannot answer "will they still be
            // reachable on some chain", and clearing the only address a
            // merchant has is exactly the edit that must be refused.
            const after = {};
            for (const chain of USDT_CHAINS) {
                const spec = USDT_CHAIN_SPEC[chain];
                const submitted = submittedAddresses[chain];
                if (submitted === undefined) {
                    after[chain] = usdtAddressFor(current, chain);
                    continue;
                }
                const address = String(submitted ?? '').trim();
                // Empty CLEARS that chain — a merchant who stops serving one
                // network needs a way to say so, and a blank field is how a
                // panel says it.
                if (!address) { after[chain] = null; update[spec.field] = null; continue; }
                if (!isUsdtAddress(chain, address)) {
                    return res.status(400).json({
                        success: false,
                        message: `That is not a valid ${spec.label} address. USDT sent to a wrong address cannot be recovered.`,
                    });
                }
                after[chain] = address;
                update[spec.field] = address;
            }
            if (!USDT_CHAINS.some((chain) => after[chain])) {
                return res.status(400).json({
                    success: false,
                    message: 'Keep at least one wallet address. With none, no order can be assigned to you.',
                });
            }
        }

        if (bankDetails) {
            if (bankDetails.accountHolderName !== undefined) update['bankDetails.accountHolderName'] = bankDetails.accountHolderName;
            if (bankDetails.bankName  !== undefined) update['bankDetails.bankName']  = bankDetails.bankName;
            if (bankDetails.accountNo !== undefined) update['bankDetails.accountNo'] = bankDetails.accountNo;
            if (bankDetails.ifsc      !== undefined) update['bankDetails.ifsc']      = bankDetails.ifsc;
        }

        if (!Object.keys(update).length) {
            return res.status(400).json({ success: false, message: 'No valid profile fields provided.' });
        }

        // The TRC-20 format and the credential uniqueness are CHECK constraints
        // and unique indexes on the row, so they hold on this path without a
        // `runValidators` flag to remember — which is the point of moving them
        // into the table. A collision comes back as 23505.
        let merchant;
        try {
            merchant = await db.merchants.updateMerchant(req.merchantId, update);
        } catch (e) {
            if (e.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'Those payment details are already registered to another merchant. Money sent to them would reach the wrong account.',
                });
            }
            if (isAccountMobileRefusal(e)) {
                return res.status(400).json({ success: false, code: 'ACCOUNT_IS_A_MOBILE', message: ACCOUNT_IS_A_MOBILE_MESSAGE });
            }
            if (e.code === '23514') {
                return res.status(400).json({ success: false, message: 'Those payment details are not in a valid format.' });
            }
            throw e;
        }

        res.json({ success: true, merchant: await formatMerchant(merchant, req.user) });
    } catch (err) {
        console.error('PUT /merchant/profile error:', err);
        if (err?.name === 'ValidationError') {
            return res.status(400).json({ success: false, message: err.message });
        }
        res.status(500).json({ success: false, message: 'Failed to update profile.' });
    }
});

router.put('/online-status', merchantAuth, async (req, res) => {
    try {
        const { isOnline } = req.body;
        if (typeof isOnline !== 'boolean') {
            return res.status(400).json({ success: false, message: 'isOnline must be a boolean.' });
        }
        // The flag and its timestamp move in ONE statement, so two rapid
        // toggles cannot interleave into "online, with the timestamp of going
        // offline" — which is what the assignment score reads.
        const merchant = await db.merchants.setOnline(req.merchantId, isOnline);
        // Notify admin panel via SSE so merchant list shows green/red dot without refresh
        if (global.sseManager && merchant) {
            global.sseManager.broadcastToAdmins('merchant_status_changed', {
                merchantId: merchant.merchantId,
                userId:     merchant.userId,
                isOnline,
                name:       merchant.username || merchant.name || '',
                updatedAt:  new Date(),
            });
        }
        res.json({ success: true, merchant: await formatMerchant(merchant, req.user) });
    } catch (err) {
        console.error('PUT /merchant/online-status error:', err);
        res.status(500).json({ success: false, message: 'Failed to update online status.' });
    }
});

/**
 * PUT /api/merchant/cash-ready — a CASH member says they are at the machine.
 *
 * A cash buy needs a member standing at an ATM, so routing offers one only to a
 * member who has pressed Ready, and the assignment that hands them one switches
 * it off again in the same transaction (`teamRouting.assignToTeam`): they are
 * busy at the machine with that buy, and press Ready again when free. Refused
 * for anybody who is not an approved member of a CASH team — Ready means
 * nothing on the other rails.
 */
router.put('/cash-ready', merchantAuth, async (req, res) => {
    try {
        const { ready } = req.body || {};
        if (typeof ready !== 'boolean') {
            return res.status(400).json({ success: false, message: 'ready must be true or false.' });
        }
        const set = await db.teamRouting.setCashReady(req.merchantId, ready);
        if (!set.ok) {
            return res.status(409).json({
                success: false, code: set.reason,
                message: 'Ready is only for members of a cash team. Ask your supervisor to add you to one.',
            });
        }
        res.json({ success: true, ready: set.ready });
    } catch (err) {
        return respondError(res, err, 'PUT /merchant/cash-ready', { message: 'Failed to update Ready.' });
    }
});

router.put('/preferences', merchantAuth, async (req, res) => {
    try {
        const { acceptsDeposits, acceptsWithdrawals } = req.body;
        const update = {};
        if (typeof acceptsDeposits    === 'boolean') update.acceptsDeposits    = acceptsDeposits;
        if (typeof acceptsWithdrawals === 'boolean') update.acceptsWithdrawals = acceptsWithdrawals;
        if (!Object.keys(update).length) {
            return res.status(400).json({ success: false, message: 'No valid preference fields provided.' });
        }
        const merchant = await db.merchants.updateMerchant(req.merchantId, update);
        res.json({ success: true, merchant: await formatMerchant(merchant, req.user) });
    } catch (err) {
        console.error('PUT /merchant/preferences error:', err);
        res.status(500).json({ success: false, message: 'Failed to update preferences.' });
    }
});
/*
 * REMOVED — PUT /api/merchant/limits.
 *
 * A merchant does not set their own caps. Limits follow from what the merchant
 * has put up — their security deposit, or the tokens they bought from the
 * platform to trade with — so the admin sets them:
 * PUT /api/admin/merchants/:merchantId/limits.
 *
 * It was also writing the wrong fields. This route set
 * `limits.minDeposit`/`maxDeposit`/`minWithdraw`/`maxWithdraw`, and NOTHING
 * reads those for any decision. So a merchant could set their limits, be told
 * it saved, and be offered exactly the same orders as before.
 *
 * ── And the fields it pointed at instead were no better ────────────────────
 * This comment used to end "merchant assignment filters on `minOrder` and
 * `maxOrder`". **It did not.** `assignmentCandidates` never named either
 * column; the only filter on them was in the admin's available-merchants LIST,
 * a screen. A comment stating the intent while the code had drifted from it,
 * and it read as authoritative enough to be believed twice.
 *
 * Both columns are gone now, and nothing replaced them, because the two things
 * they were trying to express already have owners: an order's CEILING is what
 * the team's pool holds, enforced by the hold taken the moment an order is
 * assigned (§3.10), and the SIZE is the platform's — one of the fixed order
 * sizes the admin has on offer (`SystemConfig.orderSizes`, Step 2d), the same
 * for everyone.
 */
// ─── ORDERS ──────────────────────────────────────────────────────────────────

router.get('/orders', merchantAuth, async (req, res) => {
    try {
        const { status, type, limit = '50', skip = '0' } = req.query;
        const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
        const parsedSkip  = Math.max(parseInt(skip)  || 0, 0);

        // Only the member's own orders: there is no open pool (§3.10, 2c).
        const { orders, total } = await db.orders.merchantVisibleOrders({
            merchantId: req.merchantId,
            state: status || null,
            orderType: type || null,
            limit: parsedLimit,
            offset: parsedSkip,
        });

        res.json({ success: true, orders: toMerchantOrderViews(orders), pagination: { total, limit: parsedLimit, skip: parsedSkip } });
    } catch (err) {
        console.error('GET /merchant/orders error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch orders.' });
    }
});

router.post('/accept/:id', merchantAuth, async (req, res) => {
    try {
        const order = await db.orders.getOrderRecord(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        // ── An order is ASSIGNED, never CLAIMED ─────────────────────────────
        // Every order, both directions, reaches a member through team routing
        // (`db.teamRouting.assignToTeam`), which checked the rail, the chain,
        // the member's cap and — on a buy — held the tokens in the team's pool
        // in the same transaction. There is no open pool to claim from, so the
        // only order a member may accept is one already theirs.
        if (!order.merchantId || String(order.merchantId) !== String(req.merchantId)) {
            return res.status(403).json({ success: false, message: 'This order is not assigned to you.' });
        }
        if (order.status !== 'ASSIGNED') {
            return res.status(400).json({ success: false, message: `Order cannot be accepted in status: ${order.status}` });
        }

        const merchant = await db.merchants.getMerchant(req.merchantId);
        if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });
        const merchantRail = order.currency || MERCHANT_CURRENCY.INR; // schema default: 'INR'

        // The CHAIN, re-checked where the member takes it: routing required an
        // address on the order's chain, but a member can remove one from their
        // profile in between, and USDT sent to no address is gone.
        if (merchantRail === MERCHANT_CURRENCY.USDT) {
            const spec = USDT_CHAIN_SPEC[order.usdtChain];
            if (!spec) {
                return res.status(400).json({ success: false, message: 'This USDT order names no chain and cannot be served.' });
            }
            if (!usdtAddressFor(merchant, order.usdtChain)) {
                return res.status(400).json({
                    success: false,
                    message: `This order pays on ${spec.label}. Add that address in Profile before taking it.`,
                });
            }
        }

        // The window is the order's own rail's (`teamRouting.processingWindowSeconds`).
        const windowSeconds = routingSettings(await getSystemConfig()).processingWindowSeconds[railOf(order)];

        const now        = new Date();
        const expiresAt  = new Date(now.getTime() + windowSeconds * 1000); // the window starts on accept

        // Build full immutable merchantSnapshot (GOVERNANCE §1: assigned at accept)
        // via the Payment domain's single builder — this route used to re-implement
        // it inline, which is how the USDT address would have been missed on the
        // accept path while assignment carried it (GOVERNANCE §4).
        // Rolling avgResponseMinutes: EMA with α=0.2. Computed before the
        // transition, applied after it — a merchant who lost the accept race
        // should not have their response time recorded for an order they did
        // not get.
        const responseMinutes = order.assignedAt ? (now - new Date(order.assignedAt)) / 60000 : null;

        const accepted = await startOrder(order.orderId, {
            expectMerchant: req.merchantId,
            set: {
                merchantId:       req.merchantId,
                assignedAt:       order.assignedAt || now,
                processingAt:     now,
                expiresAt,
                // What the player is shown to pay is built from this snapshot
                // (`playerOrderView`): the member's bank account on a bank
                // buy, the order's chain address on USDT. A cash buy's QR is
                // not in it; the member scans that onto the order.
                merchantSnapshot: buildMerchantSnapshot(merchant, expiresAt, order),
                ...(responseMinutes === null ? {} : { merchantResponseMinutes: responseMinutes }),
            },
        });
        if (!accepted.ok || accepted.idempotent) {
            // A double-tap, or the order expired between the read and the move.
            return res.status(409).json({
                success: false,
                message: accepted.reason === 'merchant_changed'
                    ? NO_LONGER_YOURS : `Order is ${accepted.status ?? 'missing'} and cannot be accepted.`,
            });
        }
        Object.assign(order, accepted.order);

        if (responseMinutes !== null) {
            // Rolling average, EMA with α=0.2. Applied AFTER the transition —
            // a merchant who lost the accept race must not have their response
            // time recorded for an order they did not get.
            const oldAvg = merchant.avgResponseMinutes ?? 2;
            await db.merchants.updateMerchant(req.merchantId, {
                avgResponseMinutes: (oldAvg * 0.8) + (responseMinutes * 0.2),
            });
        }
        // No counter to increment. The active order count is derived from the
        // orders, so accepting one IS the increment.

        const io = global.io;
        const oid = order.orderId;
        const isDeposit = order.type === 'DEPOSIT';
        const bank = order.userBankDetails  || {};

        // Both rails describe the same two steps; only the destination differs.
        const isUsdtOrder = merchantRail === MERCHANT_CURRENCY.USDT;
        const payAmount   = formatOrderFiat(order);

        if (isDeposit) {
            // The timeline is read by the player, so it names where to pay the
            // way their screen does, never the member's UPI handle (usually
            // their mobile number; owner, 2026-10-03).
            const payTo = isUsdtOrder
                ? `merchant USDT address on ${USDT_CHAIN_SPEC[order.usdtChain]?.label ?? 'the order chain'}: `
                  + `${usdtAddressFor(merchant, order.usdtChain) || 'See payment details'}`
                : order.paymentMode === PAYMENT_MODES.CASH_ATM
                    ? 'the cash machine QR the member scans'
                    : 'the member\'s bank account shown on the order, by bank transfer';
            await sendSystemMessage(oid,
                `✅ Order Accepted by Merchant\n` +
                `📋 Order: ${order.orderId}\n` +
                `💰 User must pay ${payAmount} to ${payTo}\n` +
                `⏱ Payment window: ${Math.round(windowSeconds / 60)} minutes`,
                io
            );
        } else if (isUsdtOrder) {
            await sendSystemMessage(oid,
                `✅ Withdrawal Order Accepted\n` +
                `📋 Order: ${order.orderId}\n` +
                `💸 Merchant must send ${payAmount} to the user's wallet:\n` +
                `   🔗 TRC-20: ${order.userUsdtAddress || 'N/A'}`,
                io
            );
        } else {
            await sendSystemMessage(oid,
                `✅ Withdrawal Order Accepted\n` +
                `📋 Order: ${order.orderId}\n` +
                `💸 Merchant must send ${payAmount} to user's bank:\n` +
                `   🏦 ${bank.bankName || ''} | AC: ${bank.accountNumber || 'N/A'} | IFSC: ${bank.ifscCode || 'N/A'}\n` +
                `   Account Holder: ${bank.accountHolderName || 'N/A'}`,
                io
            );
        }

        // Notify user of PROCESSING status with the payment link and the timer.
        // This pushed the whole `merchantSnapshot` — the merchant's handle, their
        // QR and their bank account — to the PLAYER's socket. `payTo` is the one
        // shape a player receives: a link, an opaque reference, a deadline.
        emitOrderUpdate(order.userId.toString(), 'order_update', {
            orderId:          order.orderId,
            _id:              order._id,
            status:           'PROCESSING',
            payTo:            toPlayerOrderView(order).payTo ?? null,
            expiresAt:        order.expiresAt,
            server_ts:        Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'PROCESSING', server_ts: Date.now() });

        res.json({ success: true, order: toMerchantOrderView(order) });
    } catch (err) {
        console.error('POST /merchant/accept/:id error:', err);
        res.status(500).json({ success: false, message: 'Failed to accept order.' });
    }
});

router.post('/confirm/:id', merchantAuth, async (req, res) => {
    try {
        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        const isDeposit = order.type === 'DEPOSIT';

        if (isDeposit) {
            // DEPOSIT confirm: must be PAID, and the player's reference must be
            // on the order — READ FROM THE ROW, never from this request body.
            //
            // ── Why the body is not asked, and must not be ──────────────────
            // The reference belongs to the PLAYER. They submit it at mark-paid,
            // where `claimPaymentReference` binds it to this order in
            // `utr_registry` for good (§27). The merchant's job is to match it
            // against their own bank statement and press confirm — not to
            // restate it.
            //
            // This route used to take `utrNumber` from the body and write it
            // over the stored value. A merchant sending a different string
            // therefore left the order carrying a reference `utr_registry` had
            // never claimed, while the claim still pointed at the player's
            // original — one payment with two references, the exact thing §27
            // exists to make impossible, and the merchant's string free to be
            // spent again on another order. The panel happened to echo the
            // stored value back, so it never showed; a panel is not the guard.
            if (order.status !== 'PAID') {
                return res.status(400).json({ success: false, message: `Deposit can only be confirmed in PAID status. Current: ${order.status}` });
            }
            if (!String(order.utrNumber ?? '').trim()) {
                return res.status(400).json({ success: false, message: 'This order has no payment reference from the user yet.' });
            }
            // ── NO payment-proof check ──────────────────────────────────────
            // There used to be one: `if (!proof && !order.proofScreenshot)`.
            // Payment-proof COLLECTION was removed platform-wide — the presign
            // route is gone, `mark-paid` takes the reference alone, and no
            // player screen has an upload — so `order.proofScreenshot` is NULL
            // on every order created since, and nothing can ever supply one.
            //
            // The consumer outlived its producer, and the result was total:
            // EVERY deposit confirm answered "Payment proof screenshot is
            // required." The player had already sent real money and been told
            // "Awaiting merchant review"; the merchant's panel pre-empted the
            // refusal with a toast blaming the player for not uploading proof
            // they were never asked for. The only exits were the 30-minute
            // unanswered-PAID sweep into DISPUTED, or the player disputing.
            // Found by running a deposit, not by reading one: both handlers
            // pass their own tests, and it is the PAIR that was broken (§28).
        } else {
            // WITHDRAWAL confirm: must be in PROCESSING status
            if (!['PROCESSING', 'ASSIGNED'].includes(order.status)) {
                return res.status(400).json({ success: false, message: `Withdrawal can only be confirmed in PROCESSING/ASSIGNED status. Current: ${order.status}` });
            }
        }

        // ── The reference sits on the side that PAID ────────────────────────
        // A buy and a sell are mirror images, and the reference follows the
        // money rather than the order:
        //
        //   BUY   the PLAYER pays the merchant. Their UTR arrives at mark-paid
        //         and is claimed against the order there. The merchant restates
        //         nothing — the branch above reads it off the row.
        //   SELL  the MERCHANT pays the player, out of their own bank account.
        //         The reference for that transfer exists only on their receipt,
        //         so it is theirs to give and there is nobody else who could.
        //
        // Asked on EVERY rail. A sell is paid by bank transfer to the player's
        // account whether a cash team or a UPI/bank team serves it (owner,
        // 2026-10-03), so a cash-team payout has a bank UTR like any other. The
        // CDM slip that used to stand in for it went with the cash-machine
        // payout (Step 2d).
        //
        // CLAIMED, not merely stored. A merchant's payout reference is a real
        // bank transfer exactly as a player's is, so the same registry decides
        // whether it has been spent — otherwise one transfer could be presented
        // as proof of two payouts (§27). `claimPaymentReference` throws rather
        // than returning a flag, and it runs BEFORE the transition so a refusal
        // leaves the order untouched.
        let payoutReference = null;
        if (!isDeposit) {
            const submitted = String(req.body?.utrNumber ?? '').trim();
            if (!submitted) {
                return res.status(400).json({
                    success: false,
                    code: 'PAYOUT_REFERENCE_REQUIRED',
                    message: 'Enter the UTR your bank gave this transfer. It is what a dispute is matched against.',
                });
            }
            // The order's OWN rule, so a USDT payout is held to a chain hash and
            // an INR one to a bank UTR, rather than one length check for both.
            const claimed = await claimPaymentReference({
                reference: submitted,
                orderId: order.orderId,
                userId: order.userId,
                amountRupees: order.tokenAmount,
                spec: referenceSpecFor(order),
            });
            payoutReference = claimed.reference;
        }

        // THE TRANSITION IS THE GATE, and it runs before the money.
        //
        // Every branch below moves value — a merchant debit and a user credit on
        // deposits, a stake release and a merchant credit on withdrawals — and
        // all of it used to run BEFORE the status was set, guarded only by the
        // `order.status` read above. A merchant double-tapping confirm put two
        // debits in flight; only the canonical txIds on the wallet calls stopped
        // the second one, which means the protection lived in a different domain
        // from the decision. Now exactly one caller matches a row, and only that
        // caller goes on to move money.
        //
        // Which target this is depends on the branch: a deposit completes, and
        // a withdrawal only reaches PAID (asserted, not settled) and is held for
        // at least an hour — the player's window to dispute (2c+).
        const holdFor = isDeposit ? 0 : await holdMinutes();

        // ── DEPOSIT: the money moves BEFORE the status, through the one owner ──
        //
        // This route used to run `completeOrder` FIRST — "the transition is the
        // gate" — and debit the merchant after it. The refusal therefore landed
        // AFTER the status had committed, and an under-funded merchant pressing
        // confirm left the order reading COMPLETED with the player never
        // credited. The player had already sent real money (PAID is what that
        // state means), the order showed as SUCCESS in their history, nothing
        // swept it (`expireOrders` skips COMPLETED), and they could not even
        // raise it: the dispute route refuses anything that is not PAID. §21,
        // exactly — a write that follows a commit and is allowed to fail.
        // Proven in backend/tests/routes/depositConfirmUnderfundedPg.test.js.
        //
        // `moveDepositMoney` is the ordering that survives a failure at any
        // point: every movement is keyed on the order id, so a refusal or a
        // crash leaves a PAID order the next confirm replays as no-ops. That is
        // also why it carries no compensating refund and this no longer does —
        // there is nothing to unwind when nothing has been declared finished.
        //
        // Double-tap is still handled, just by the thing that was always doing
        // it: the canonical `pool_buy_paid_<orderId>` / `dep_complete_<orderId>`
        // keys, plus `completeOrder`'s own idempotency below.
        let deposited = null;
        if (isDeposit) {
            // ── The pool's hold IS the payment, and `moveDepositMoney` takes it ──
            // Spent once, from the team pool, keyed on the order (§2).
            // `requireState`: asked under the order's lock, so a buy the player
            // disputed (or an admin decided) since it was read is not paid out
            // underneath them (security review, 2026-10-03).
            deposited = await moveDepositMoney(order, { releaseUTR, requireState: 'PAID' });
            if (!deposited.ok && deposited.reason === 'order_state') {
                return res.status(409).json({
                    success: false,
                    message: 'This buy changed while you were confirming it (it may have been disputed), so nothing was credited. Refresh to see where it stands.',
                });
            }
            if (!deposited.ok) {
                // Reported to the operator and to the player by
                // `moveDepositMoney` itself (F-015). The order stays PAID, so it
                // is retryable AND still disputable.
                return res.status(409).json({
                    success: false,
                    message: 'Your team\'s token pool cannot cover this buy right now, so nothing was credited. '
                        + 'The order stays paid; your supervisor has been told, and you can confirm again once it is funded.',
                });
            }
        }

        let moved;
        if (isDeposit) {
            moved = await completeOrder(order._id, {
                expectFrom: 'PAID',
                expectMerchant: req.merchantId,
                set: { completedAt: new Date() },
            });
        } else {
            // ── Always a HOLD ───────────────────────────────────────────────────
            // There was a "hold disabled" path that completed the order inline.
            // The window is now at least an hour (owner, 2026-10-02), so every
            // confirm holds and the sweep settles — money first, COMPLETED after.
            moved = await markOrderPaidState(order._id, {
                expectFrom: ['PROCESSING', 'ASSIGNED'],
                expectMerchant: req.merchantId,
                set: {
                    ...(payoutReference ? { utrNumber: payoutReference } : {}),
                    merchantCreditStatus:    'HELD',
                    merchantCreditHoldUntil: new Date(Date.now() + holdFor * 60 * 1000),
                    escrowLocked:            true,
                },
            });
        }
        if (!moved.ok) {
            return res.status(409).json({
                success: false,
                message: moved.reason === 'merchant_changed'
                    ? NO_LONGER_YOURS : `Order is ${moved.status ?? 'missing'} and cannot be confirmed.`,
            });
        }
        if (moved.idempotent) {
            // A previous delivery already confirmed this order, and the money
            // moved with it. Re-running the wallet calls would be harmless (they
            // are keyed) but not re-running them is clearer about what happened.
            return res.json({ success: true, message: 'Order already confirmed', order: toMerchantOrderView(moved.order ?? order) });
        }
        Object.assign(order, moved.order);

        // The deposit's money already moved, above, before the transition.
        if (!isDeposit) {
            // ── WITHDRAWAL confirm: an ASSERTION, not a settlement ─────────────
            // The merchant is claiming they sent the player fiat. Nothing proves
            // it yet, so nothing settles yet.
            //
            // Crediting the pool in this request would let a member who pressed
            // confirm without sending the money put spendable tokens in their
            // team's pool at once, and the next buy could spend them before the
            // player noticed nothing arrived.
            //
            // Both sides now freeze for SystemConfig.withdrawalHoldMinutes.
            // Until it expires no value has moved: the player's stake stays
            // locked exactly as it has since order creation, and the team's
            // pool has not been credited. A dispute inside the window is a
            // reversal of something still held (withdrawalHold.endWithdrawal),
            // not a clawback. See domains/payment/withdrawalHold.service.js.
            //
            // The status, the HELD marker and the hold deadline were written by
            // the transition above — this branch is now only the side effects
            // that follow it.
            //
            // Emit wallet update so user sees updated balance
            await emitWalletUpdate(order.userId);
        }

        // Funding event (Phase 009): lets the ledger reconciler pick this
        // completion up within seconds. Non-blocking — never affects the flow.
        try { publishDomainEvent(DOMAIN_EVENTS.PAYMENT_ORDER_COMPLETED, { orderId: order._id, type: order.type }); } catch (_) {}

        // Update merchant scoring stats. The direction and amount travel with
        // it: they feed the merchant's processed volume and their per-rail
        // counts, and passing neither meant every completed order was recorded
        // as a zero-value deposit — a merchant's volume never moved.
        await updateMerchantStatsOnComplete(req.merchantId, true, {
            direction: order.type,
            amountRupees: order.tokenAmount,
            earningsRupees: order.merchantProfit || 0,
        }).catch(() => {});

        // Notify merchant of updated score (GOVERNANCE §11: merchant_score_update)
        const freshMerchant = await db.merchants.getMerchant(req.merchantId);
        if (freshMerchant) {
            emitMerchantUpdate(req.merchantId.toString(), 'merchant_score_update', {
                successRate: freshMerchant.successRate,
                avgResponse: freshMerchant.avgResponseMinutes,
            });
        }

        // Auto system message
        try {
            const io = global.io;
            const oid = order.orderId;
            if (isDeposit) {
                await sendSystemMessage(oid,
                    `✅ Payment Confirmed by Merchant\n` +
                    `📋 Token Purchase: ${order.tokenAmount} BB Tokens credited to your Deposit Balance\n` +
                    // NOT `₹${order.fiatAmount}`: on a USDT purchase that is a
                    // USDT figure, and this line told the player their 500 USDT
                    // was ₹500.
                    `💰 ${formatOrderFiat(order)} received. Order COMPLETE.\n` +
                    `Your tokens are now available for betting!`,
                    io
                );
            } else if (order.merchantCreditStatus === 'HELD') {
                // The player is the only party who can tell us whether the money
                // actually arrived, so the message has to say plainly that this
                // is a claim under review and that saying nothing settles it.
                // Announcing "COMPLETED" here — as this did before the hold —
                // would train players to ignore the one notification the whole
                // anti-fraud window depends on them reading.
                const mins = Math.max(1, Math.round((order.merchantCreditHoldUntil - Date.now()) / 60000));
                await sendSystemMessage(oid,
                    `💸 Merchant has marked your payout as sent\n` +
                    `UTR / Ref: ${order.utrNumber || 'Provided separately'}\n` +
                    `📋 Token Sale: ₹${order.fiatAmount} to your bank account\n\n` +
                    `⏳ Settling in about ${mins} minute(s).\n` +
                    `If the money has NOT reached your account by then, raise a dispute on this order — ` +
                    `your tokens are still held and will be returned to you.`,
                    io
                );
            } else {
                await sendSystemMessage(oid,
                    `💸 Merchant has sent your payout\n` +
                    `UTR / Ref: ${order.utrNumber || 'Provided separately'}\n` +
                    `📋 Token Sale: ₹${order.fiatAmount} sent to your bank account\n` +
                    `Order COMPLETED. Tokens have been deducted from your balance.`,
                    io
                );
            }
        } catch(_) {}

        // A held withdrawal is NOT completed — emitting order_completed here would
        // flip the player's UI to "done" while their tokens are still frozen and
        // the dispute window is open, which is the one moment they most need an
        // accurate status. The settlement worker emits order_completed when it
        // actually settles.
        if (order.merchantCreditStatus === 'HELD') {
            // In the PLAYER's terms. This carried `merchantCreditStatus: 'HELD'`
            // — the merchant's credit standing with the platform, which is not
            // this player's business and tells them nothing their own order
            // does not. What they need is that it is holding and when it
            // settles, so that is what goes.
            emitOrderUpdate(order.userId.toString(), 'order_update', {
                orderId: order.orderId, _id: order._id, status: order.status,
                escrowStatus: 'HELD',
                settlesAt: order.merchantCreditHoldUntil,
                server_ts: Date.now(),
            });
            emitAdminUpdate('queue_order_update', {
                orderId: order._id, status: order.status, merchantCreditStatus: 'HELD', server_ts: Date.now(),
            });
        } else {
            emitOrderUpdate(order.userId.toString(), 'order_completed', {
                orderId:   order.orderId,
                _id:       order._id,
                status:    'COMPLETED',
                server_ts: Date.now(),
            });
            emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'COMPLETED', server_ts: Date.now() });
        }

        res.json({ success: true, order: toMerchantOrderView(order) });
    } catch (err) {
        // `respondError`, not a flat 500. This handler now throws CALLER errors:
        // `claimPaymentReference` refuses a malformed reference with 400 and an
        // already-spent one with 409, and the message it carries is the only
        // thing telling the merchant what to type instead — "this UTR was
        // already used on order WD_…" rather than "Failed to confirm payment."
        //
        // §21, in the sentence that section spends a paragraph on: the refusal
        // is the caller's, so it carries its status at the throw, and a catch
        // that flattens everything to 500 swallows the one sentence that was
        // worth sending. Routed on the PRESENCE of `err.status`, never its
        // value, so a genuine fault still logs in full and answers with nothing.
        return respondError(res, err, 'POST /merchant/confirm/:id', {
            message: 'Failed to confirm payment.',
            // WHICH payout already holds the reference. Support answering
            // "it says already used" needs it, and looking it up again is a
            // query that can return something different from the one that
            // refused the claim.
            passthrough: ['originalOrderId'],
        });
    }
});

router.post('/reject/:id', merchantAuth, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ success: false, message: 'A rejection reason is required.' });


        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        // Only allowed if ASSIGNED (before user has paid) -- per spec Section 2C
        if (order.status !== 'ASSIGNED') {
            return res.status(400).json({ success: false, message: `Order can only be rejected in ASSIGNED status. Current: ${order.status}` });
        }

        // THE REQUEUE IS THE GATE, and it runs first.
        //
        // This is the transition that made PENDING_QUEUE a state the rule table
        // has to be able to enter — see docs/ORDERS_REQUEUE_CYCLE.md. It also
        // has to be COMMITTED before tryAssignMerchant runs, not just set on the
        // in-memory document: that function now performs its own guarded
        // PENDING_QUEUE→ASSIGNED update, so an unsaved requeue would leave the
        // database still reading ASSIGNED and the reassignment would match no
        // row. The old code relied on tryAssignMerchant's trailing save() to
        // persist both at once, which is also why a failed reassignment left the
        // order's requeue unsaved unless the else-branch happened to save it.
        const requeued = await requeueOrder(order.orderId, {
            expectMerchant: req.merchantId,
            set: { merchantId: null, merchantSnapshot: null, expiresAt: null, rejectedReason: reason },
            // ── The pool's hold comes off IN the requeue's own transaction ──
            // This member's team held the player's tokens from the moment the
            // order was theirs. Released in the same commit that puts the order
            // back in the queue, so it is never found queued while still holding
            // a team's tokens, and the next assignment can hold afresh. The team
            // is cleared too: the next one is decided by routing.
            within: async (client) => {
                await db.teamPools.detachFromTeamWithin(client, order.orderId, {
                    actor: `merchant:${req.merchantId}`, reason: `Declined by the member: ${reason}`,
                });
            },
        });
        if (!requeued.ok) {
            return res.status(409).json({
                success: false,
                message: requeued.reason === 'merchant_changed'
                    ? NO_LONGER_YOURS : `Order can only be rejected in ASSIGNED status. Current: ${requeued.status ?? 'missing'}`,
            });
        }
        Object.assign(order, requeued.order);

        // A refusal, through the one owner. It records the pair — so this order
        // never returns to this merchant, and this merchant never sees this
        // PLAYER again — advances the consecutive streak, and suspends at the
        // cap. An EXPIRED assignment lands in the same function and counts the
        // same, which is what stops a merchant refusing without limit simply by
        // never pressing this button.
        //
        // Called BEFORE the reassignment below, so that reassignment already
        // sees the bar.
        await recordMerchantRefusal({
            orderId: order.orderId,
            merchantId: req.merchantId,
            userId: String(order.userId),
            reason,
            kind: REFUSAL.DECLINED,
        });

        // The lifetime counter moves; there is no active count to decrement.
        // It is derived from the orders, so requeuing one IS the decrement —
        // and a merchant who lost the race cannot decrement a count they still
        // hold, because there is no count to get wrong.
        await db.merchants.recordCompletedOrder(req.merchantId, {
            direction: order.type, amountRupees: 0, earningsRupees: 0, disputed: false,
        });

        // A declined SELL keeps the player's stake LOCKED: the order is back in
        // the queue and will be offered to another member. Refunding it here
        // (as this once did) left a queued withdrawal with no stake behind it,
        // so the next member to serve it paid out tokens the player still held.

        // Offered straight to the next eligible member; if nobody is free the
        // assignment sweep keeps offering it until it expires.
        const reAssigned = await tryAssignMerchant(order);
        if (reAssigned) {
            emitAdminUpdate('queue_order_update', {
                orderId: order._id, status: order.status, server_ts: Date.now(),
            });
            emitOrderUpdate(order.userId.toString(), 'order_assigned', {
                orderId:          order.orderId,
                _id:              order._id,
                status:           order.status,
                payTo:            toPlayerOrderView(order).payTo ?? null,
                expiresAt:        order.expiresAt,
                server_ts:        Date.now(),
            });
            res.json({ success: true, message: 'Order rejected and re-assigned to another merchant.', order: toMerchantOrderView(order) });
        } else {
            // rejectedReason was written with the requeue, so there is nothing
            // left to save — the order is already committed in PENDING_QUEUE.
            emitOrderUpdate(order.userId.toString(), 'order_update', {
                orderId:   order.orderId,
                _id:       order._id,
                status:    'PENDING_QUEUE',
                message:   'Merchant rejected. Looking for another merchant…',
                server_ts: Date.now(),
            });
            emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'PENDING_QUEUE', server_ts: Date.now() });
            res.json({ success: true, message: 'Order rejected. Searching for next available merchant.', order: toMerchantOrderView(order) });
        }

        await postSystemMessage(
            order._id,
            `❌ ORDER REJECTED BY MERCHANT\n` +
            `Reason: ${reason}\n` +
            (reAssigned
                ? `✅ A new merchant has been assigned to your order.`
                : `⏳ We are searching for another merchant.`),
            { senderId: req.merchantId },
        );
    } catch (err) {
        console.error('POST /merchant/reject/:id error:', err);
        res.status(500).json({ success: false, message: 'Failed to reject order.' });
    }
});

// ─── The merchant dispute route was DELETED 2026-09-10 ───────────────────────
//
// A dispute is the PLAYER's instrument and nobody else's. A merchant has two
// answers available to them and they are both already here:
//
//   POST /reject/:id        decline before payment — back to the queue
//   POST /reject-paid/:id   the player says they paid and the money did not
//                           arrive — reason of 10+ characters and a proof image
//
// Both say "this transaction failed, and here is why", which is the whole of
// what a merchant is entitled to assert. Raising a DISPUTE is different: it is
// the instrument for the party who is OWED, and on this platform that is always
// the player — a merchant who is short simply does not confirm.
//
// Leaving both meant the merchant could move an order to DISPUTED themselves,
// including from COMPLETED, which parks a settled order in the admin queue on
// one side's say-so. `ALLOWED_FROM` still admits DISPUTED from PROCESSING, PAID
// and COMPLETED — correctly, because those are the states a PLAYER disputes
// from, and the rule table describes the transition rather than who may ask for
// it. Who may ask is a route's job, and there is now one route that does.
// ─── ORDER CHAT — REMOVED ────────────────────────────────────────────────────
//
// `GET|POST /api/merchant/chat/:id` are gone, with the four upload presigns
// that fed them (see routes/upload.routes.js).
//
// There is no merchant-to-user order chat, by design. A player submits a UTR
// as proof of payment; the merchant matches it against their own bank
// statement and confirms or rejects. The two never negotiate — a private
// channel between the party holding the money and the party owed it is where
// an off-platform settlement gets agreed.
//
// The only conversation is the DISPUTE chat, between the player and an admin
// or sub-admin. `postSystemMessage` below stays: it writes the order's own
// timeline, which is the record that dispute is decided from.
//

// ─── RED FLAG (FIX B5-b) ─────────────────────────────────────────────────────
//
// Merchant flags a suspicious order (third-party account, fraud, etc.)
// Sets redFlagged fields on PaymentOrder and notifies admins via SSE.
//

router.post('/orders/:id/red-flag', merchantAuth, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !reason.trim()) {
            return res.status(400).json({ success: false, message: 'A reason is required to red-flag an order.' });
        }

        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
            return res.status(400).json({ success: false, message: 'Cannot red-flag a completed or cancelled order.' });
        }
        if (order.status === 'REJECTED') {
            return res.status(400).json({ success: false, message: 'You rejected this buy, so it is the player\'s to dispute until their window closes. Contact support if something else is wrong.' });
        }

        // The red flag and the DISPUTED move land in ONE update. Writing the
        // flag separately would leave an order flagged but not disputed if the
        // second write failed, which is the state the admin queue cannot see.
        // Not from REJECTED: a buy the member rejected is the player's to
        // dispute, inside their window. A member flagging their own rejection
        // would turn it into a dispute the player never raised (security
        // review, 2026-10-03). `disputeRaisedBy: 'merchant'` says whose report
        // this is, so a decision on it suspends nobody (disputeOutcome.service.js).
        const flagged = await disputeOrder(order._id, {
            expectFrom: ['PROCESSING', 'PAID'],
            expectMerchant: req.merchantId,
            set: {
                redFlagged:      true,
                redFlagReason:   reason.trim(),
                redFlaggedBy:    req.userId,
                redFlaggedAt:    new Date(),
                disputeReason:   `Red-flagged by merchant: ${reason.trim()}`,
                disputeRaisedAt: new Date(),
                disputeRaisedBy: 'merchant',
            },
        });
        if (!flagged.ok) {
            return res.status(409).json({
                success: false,
                message: flagged.reason === 'merchant_changed'
                    ? NO_LONGER_YOURS : `Cannot red-flag an order that is ${flagged.status ?? 'missing'}.`,
            });
        }
        Object.assign(order, flagged.order);

        
        await postSystemMessage(
            order._id,
            `⚠️ Order flagged by merchant: ${reason.trim()}. Admin has been notified.`,
            { senderId: req.userId },
        );

        // Notify admins via SSE
        if (global.sseManager) {
            global.sseManager.broadcastToAdmins('order_red_flagged', {
                orderId:       order.orderId,
                orderStringId: order.orderId,
                reason:        reason.trim(),
                merchantId:    req.merchantId,
                flaggedAt:     order.redFlaggedAt,
                type:          order.type,
                fiatAmount:    order.fiatAmount,
            });
        }

        res.json({ success: true, message: 'Order has been red-flagged and escalated to admin.', order: toMerchantOrderView(order) });
    } catch (err) {
        console.error('POST /merchant/orders/:id/red-flag error:', err);
        res.status(500).json({ success: false, message: 'Failed to red-flag order.' });
    }
});

// ─── CASH LINK (Step 2d) ─────────────────────────────────────────────────────
//
// A cash buy is paid through the ATM. The member picks the order amount on a
// machine that offers UPI cash withdrawal and scans the QR it shows; the link
// decoded from it is what the player pays, and the machine hands the member the
// cash. The member's panel decodes the QR from the camera (or a photo of it);
// typing a link is not offered, and the server holds whatever arrives to the
// shape of a real one (`checkCashLink`) before a player is shown it.
//
// A second scan REPLACES the first until the player says they paid: the member
// may have picked the wrong amount, or the machine timed out and showed a new
// QR. After that the link is what was paid, and `setCashLink` moves nothing.

router.post('/orders/:id/cash-link', merchantAuth, async (req, res) => {
    try {
        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
        if (order.type !== 'DEPOSIT' || order.paymentMode !== PAYMENT_MODES.CASH_ATM) {
            return res.status(400).json({ success: false, code: 'NOT_A_CASH_BUY', message: 'Only a cash buy is paid through a cash machine\'s QR.' });
        }
        if (order.status === 'ASSIGNED') {
            // The player is shown the QR only once the member has accepted
            // (`playerOrderView`), so the scan waits for the accept too.
            return res.status(409).json({
                success: false,
                code: 'ACCEPT_FIRST',
                message: 'Accept the order first, then scan the machine\'s QR.',
            });
        }
        if (order.status !== 'PROCESSING') {
            return res.status(409).json({
                success: false,
                code: 'CASH_LINK_CLOSED',
                message: order.status === 'PAID'
                    ? 'The player has already said they paid this QR, so it can no longer be changed.'
                    : `This order is ${order.status}, so there is nothing to scan for.`,
            });
        }

        // Throws 400 INVALID_CASH_LINK naming what is wrong with the scan.
        const link = checkCashLink(req.body?.link, order.fiatAmount);

        const updated = await db.orders.setCashLink(order.orderId, req.merchantId, link);
        if (!updated) {
            // Every condition was in the UPDATE's WHERE; read the row to say
            // which one moved between the check above and the write.
            const now = await db.orders.getOrderRecord(order.orderId);
            const moved = !now || String(now.merchantId) !== String(req.merchantId);
            return res.status(409).json({
                success: false,
                code: moved ? 'merchant_changed' : 'CASH_LINK_CLOSED',
                message: moved ? NO_LONGER_YOURS : `This order is ${now.status} now, so the QR was not changed.`,
            });
        }

        await postSystemMessage(
            updated.orderId,
            `🏧 The member scanned the cash machine's QR for ${formatOrderFiat(updated)}. The player can pay it now.`,
            { senderId: req.userId },
        );

        // The player's screen turns "waiting for the member" into the Pay
        // button. `payTo` only, the one shape a player receives.
        emitOrderUpdate(String(updated.userId), 'order_update', {
            orderId:   updated.orderId,
            _id:       updated.orderId,
            status:    updated.status,
            payTo:     toPlayerOrderView(updated).payTo ?? null,
            expiresAt: updated.expiresAt,
            server_ts: Date.now(),
        });
        emitMerchantUpdate(String(req.merchantId), 'order_update', {
            orderId: updated.orderId, cashLinkAt: updated.cashLinkAt, server_ts: Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: updated.orderId, status: updated.status, server_ts: Date.now() });

        res.json({ success: true, order: toMerchantOrderView(updated) });
    } catch (err) {
        return respondError(res, err, 'POST /merchant/orders/:id/cash-link', { message: 'Failed to attach the cash machine QR.' });
    }
});

// Merchant BULK PAYOUTS was here — three routes, removed 2026-09-10 at the
// owner's decision. It is not a feature that was working and got dropped:
//
//   NOTHING in production ever wrote `bulk_payout_date`. The batch query
//   filtered on it, so `GET /bulk-payouts` and `/bulk-payouts/export` returned
//   an empty batch for every merchant on every day the platform has run, and
//   no panel called either of them to notice. Only `mark-paid` had coverage,
//   and it takes explicit order ids rather than reading the batch.
//
// The columns, the repository readers, the CSV builder, the feature flag and
// the `bulk_payout_completed` event go with it.
//
// A merchant closes payouts one at a time through `/confirm/:id`, which is the
// path that takes the withdrawal hold, writes the transition and moves the
// escrow flags.

// ─── EARNINGS & STATS ────────────────────────────────────────────────────────

router.get('/earnings', merchantAuth, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        // ONE statement for both windows. It was two aggregations issued
        // together, so "today" and "lifetime" could describe the database at
        // different instants — and a merchant watching during a settlement saw
        // today's figure outrun the lifetime one it is part of.
        const earnings = await db.stats.merchantEarnings(req.merchantId, {
            from: startDate ? new Date(startDate) : null,
            to: endDate ? new Date(endDate) : null,
        });
        const todayDeposits    = earnings.today.deposits;
        const todayWithdrawals = earnings.today.withdrawals;
        const lifetime         = earnings.lifetime;

        res.json({
            success: true,
            earnings: {
                // `todayEarned` is a NUMBER at the top level, and `today` keeps
                // the per-direction counts under it.
                //
                // The panel's `Earnings` interface declared `today: number` and
                // rendered `formatMoneyCompact(earnings.today, rail)` — against
                // an OBJECT. `Number({deposits, withdrawals})` is NaN, `|| 0`
                // makes it 0, and the "Today's earnings" tile was structurally
                // zero for every merchant on every rail. §23: TypeScript could
                // not catch it because the interface was the thing that was
                // wrong. The shapes agree now, and the panel reads a field that
                // is a number where it treats it as one.
                todayEarned: earnings.today.earned,
                today: {
                    // No `totalFees`. Commission is paid on MATCHED volume
                    // within a variety (§26), so there is no per-direction
                    // share of it to report — reporting one would be inventing
                    // an attribution the engine does not make.
                    deposits:    { totalAmount: todayDeposits.totalAmount,    count: todayDeposits.count },
                    withdrawals: { totalAmount: todayWithdrawals.totalAmount, count: todayWithdrawals.count },
                },
                lifetime: {
                    totalEarnings: lifetime.totalEarnings,
                    totalVolume:   lifetime.totalVolume,
                    totalOrders:   lifetime.totalOrders,
                },
                // `merchants.earnings_paise`, which is also never written —
                // the same dead column in a different table. It read as
                // "commission owed but not yet paid", a state the engine does
                // not have: it issues the ledger event and the wallet credit in
                // one pass, or it skips the merchant entirely (§26.6, never
                // partial-issue). Removed rather than reported as a permanent
                // zero that an operator would read as "nothing outstanding".
            },
        });
    } catch (err) {
        console.error('GET /merchant/earnings error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch earnings.' });
    }
});

// GET /api/merchant/earnings/weekly — Real 7-day daily breakdown for dashboard chart
router.get('/earnings/weekly', merchantAuth, async (req, res) => {
    try {

        // The days are generated by the DATABASE and left-joined, so a day
        // with no orders comes back as a zero rather than being absent — a
        // chart that silently drops empty days draws a week that looks busier
        // than it was. The bucketing is in the query, in the merchant's own
        // timezone, rather than seven ranges built in JavaScript.
        const result = (await db.stats.merchantDailyEarnings(req.merchantId, { days: 7 }))
            .map((d) => ({ date: d.label, earnings: d.earnings, orders: d.orders }));

        res.json({ success: true, weekly: result });
    } catch (err) {
        console.error('GET /merchant/earnings/weekly error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch weekly earnings.' });
    }
});

router.get('/stats', merchantAuth, async (req, res) => {
    try {
        // ONE pass over one snapshot. Four separate counts could disagree —
        // an order moving from PROCESSING to PAID between two of them is
        // counted in both, or in neither, and the merchant's dashboard adds up
        // to the wrong number.
        const q = await db.stats.merchantQueueCounts(req.merchantId);
        const pending = q.pending;
        const processing = q.processing;
        const completedToday = q.completed_today;
        const paidPendingReview = (await db.orders.findOrders({
            merchantId: req.merchantId, state: 'PAID', limit: 1,
        })).total;

        res.json({ success: true, stats: { pending, processing, completedToday, paidPendingReview } });
    } catch (err) {
        console.error('GET /merchant/stats error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
    }
});

// `POST /api/merchant/orders/:id/approve` was here: a SECOND path that
// completed a PAID deposit, dispensed the merchant's tokens and credited the
// player. `/confirm/:id` above already does all of that, and does it better —
// it writes the settlement inline, requires and claims the UTR the player
// submitted, reads the deposit policy, and takes the withdrawal hold.
//
// Two writers of one outcome is a §5 violation whatever their guards, and
// these had already diverged. Nothing in the merchant panel called it: only an
// exported `approveOrder` helper nothing rendered, which is why the
// ui-coverage gate saw the route as reached — an exported caller is a caller
// to a scanner, and is not a button.
//
// Deleting it also removed the last user of the no-op `safeSession` /
// `commitOrEnd` / `abortOrEnd` stubs, so code that read as a transaction and
// was not is gone rather than made honest.
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/merchant/orders/:id/reject — "payment not received"
// The member says the payment the player CLAIMED never arrived: a PAID buy
// only (owner, 2026-10-07). `unpaidRejectRefusal` words every refusal.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/orders/:id/reject', merchantAuth, async (req, res) => {
    try {
        const { id }   = req.params;
        const { reason, proofFileKey, proofCdnUrl } = req.body;

        const order = await db.orders.getOrderRecord(id);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        if (order.merchantId?.toString() !== req.merchantId?.toString()) {
            return res.status(403).json({ success: false, message: 'This order is not assigned to you' });
        }

        // ── May this be said at all, before what it needs ────────────────────
        // A BUY, and one the player has tapped Paid on. "The player's money
        // never arrived" is a statement about a buy: a sell cancelled here
        // would end with the player's stake still locked and nothing scheduled
        // to return it; a member who cannot pay a sell declines it before
        // paying (POST /reject/:id) instead. And before the Paid tap there is
        // no claimed payment to deny (owner, 2026-10-07): this took a
        // PROCESSING buy too, and warned and flagged a player who had said
        // nothing yet. The member is told to wait for the tap (400).
        //
        // Asked BEFORE the reason and the proof (§32 S34): a member must not
        // write an accusation and upload evidence to be told it cannot be
        // made yet. Asked AFTER ownership, so a stranger learns nothing about
        // where somebody else's buy stands. A snapshot that only words the
        // answer: the rule is REJECTED's one edge in the state machine, from
        // PAID, in the transition's WHERE below (trap 18).
        const refused = unpaidRejectRefusal(order);
        if (refused) {
            return res.status(refused.status).json({ success: false, code: refused.code, message: refused.message });
        }

        // ── The accusation carries its evidence ──────────────────────────────
        // Rejecting a PAID order says the player's money never arrived. It
        // warns and flags their account and puts them in front of an admin, so
        // neither half is optional: `reason` used to fall back to "Rejected by
        // merchant", which told the player, support and the admin console
        // nothing about why they had been flagged.
        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({
                success: false,
                message: 'A rejection reason of at least 10 characters is required — it is what the player is shown.',
            });
        }
        if (!proofFileKey?.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Proof is required: upload a screenshot or photo showing the payment did not arrive.',
            });
        }

        // Bound to THIS merchant and THIS order. Without the check a merchant
        // could name a key they never uploaded, or one staged against a
        // different order, and the stored proof would point at somebody else's
        // evidence.
        let verifiedProof;
        try {
            verifiedProof = await cdnService.verifyUploadedObject({
                fileKey: proofFileKey.trim(),
                cdnUrl: proofCdnUrl || undefined,
                expectedUserId: String(req.merchantId),
                expectedOrderId: order.orderId,
                expectedCategory: 'merchant-reject-proof',
            });
        } catch (e) {
            return res.status(400).json({ success: false, message: `Proof could not be verified: ${e.message}` });
        }

        // ── Transition order to REJECTED, and open the player's window ────────
        // The guard is the transition. Everything after this point — the
        // user's warning count and the payment flag — is a consequence of the
        // rejection, and a merchant retrying a failed request used to run all
        // of it a second time and increment the warning count again.
        //
        // ── The tokens stay in ESCROW (2c+, owner 2026-10-02) ─────────────────
        // This CANCELLED the buy and gave the team its tokens back at once, on
        // the member's word alone. Now the buy waits in REJECTED with its pool
        // hold intact, and the player has `rejectedBuyDisputeMinutes` (default
        // 15) to say they paid. No dispute: the window sweep cancels it and the
        // hold goes back to the pool. A dispute: the hold stays until the
        // dispute manager decides. The deadline is written by the DATABASE
        // clock in the same transaction, so the sweep, the dispute route and
        // the screen all read one instant.
        //
        // No `expectFrom`: the rule table's one edge into REJECTED is PAID,
        // applied in the UPDATE's WHERE under the row lock, so a buy that moved
        // on since the read above (confirmed, disputed, expired) is refused by
        // the database, and one not yet PAID never matches at all. It said
        // `['PAID', 'PROCESSING']`, which is how an unpaid buy got through.
        const windowMinutes = await rejectedBuyDisputeMinutes();
        const rejected = await rejectOrderState(order.orderId, {
            expectMerchant: req.merchantId,
            set: {
                rejectedBy:     req.merchantId,
                rejectedAt:     new Date(),
                rejectedReason: reason.trim(),
                rejectionProofUrl: verifiedProof.cdnUrl,
                // `updatedAt` was here and `setOrderFields` refuses it — the
                // column is maintained by the write itself, not by callers — so
                // this route threw on EVERY call and 500'd. No screen called it,
                // so nothing noticed that the endpoint had never once worked.
            },
            within: async (client, moved) => ({
                ...moved,
                disputeWindowUntil: await db.orders.openRejectedBuyWindowWithin(client, order.orderId, windowMinutes),
            }),
        });
        if (!rejected.ok || rejected.idempotent) {
            if (rejected.reason === 'merchant_changed') {
                return res.status(409).json({ success: false, message: NO_LONGER_YOURS });
            }
            if (rejected.reason === 'pool_paid') {
                return res.status(409).json({
                    success: false,
                    message: 'The team\'s tokens for this buy were already paid to the player, so it can only be completed.',
                });
            }
            // The database's answer, worded by the same function as the read
            // above: a buy not yet PAID is "not yet" (400) whichever of the two
            // caught it, and one past PAID is a conflict (409).
            const why = unpaidRejectRefusal({ type: order.type, status: rejected.status }) ?? {
                status: 409, code: 'NOT_REJECTABLE', message: `Cannot reject order in ${rejected.status ?? 'unknown'} status`,
            };
            return res.status(why.status).json({ success: false, code: why.code, message: why.message });
        }
        Object.assign(order, rejected.order);
        const disputeUntil = order.disputeWindowUntil;

        // ── Warning and flag — but NOT a block ───────────────────────────────
        // A merchant rejecting a PAID order IS "the merchant says the payment
        // never arrived". It raises the player's warning count and sets the
        // explicit `paymentFlagged` marker, so support and the admin console can
        // see and filter that player immediately.
        //
        // It does NOT block them, and that is deliberate (owner decision
        // 2026-09-07). `maxWarnings` is passed as 0 — "never block from here" —
        // so no code path reachable by a merchant can close a player's
        // account.
        //
        // Why: a rejection is one merchant's unreviewed word. The same merchant
        // looking at the same missing payment can instead raise a DISPUTE, which
        // an admin rules on and which touches the player's account not at all.
        // Nothing steered that choice, and the harsher of the two was the easier
        // to reach — it closes the order immediately instead of waiting on an
        // admin. At the default threshold of three, two honest mistakes and one
        // bad actor locked a player out of their own balance: `is_blocked`
        // refuses them at `authenticate`, so they could not see their wallet,
        // their orders, or the notice explaining why.
        //
        // The block is now an admin decision about a FLAGGED player, taken with
        // the reason and the proof image in front of them. The threshold itself
        // is untouched and still governs every other path that warns.
        //
        // The increment and the flag remain ONE statement: they were two, and a
        // failure between them left a player warned with no flag for anyone to
        // act on.
        const flagReason = reason.trim();
        const flagged = await db.users.flagPaymentWarning(order.userId, {
            reason: flagReason,
            // 0 = never block from here. Deliberately NOT the risk rules'
            // `maxWarnings`: that setting now decides when a flagged player is
            // marked for review on GET /api/admin/users/flagged, which is the
            // only place a block is decided.
            maxWarnings: 0,
        });

        const updatedUser  = flagged?.user ?? null;
        const newCount     = flagged?.warningCount ?? 0;
        const hitThreshold = flagged?.autoBlocked ?? false;

        // ── SSE: notify user (Finding 3) ──────────────────────────────────────
        // `disputeUntil` is what the player's pop-up counts down to: the one
        // thing they can do about a rejection is dispute it before then.
        emitOrderUpdate(order.userId.toString(), 'order_rejected', {
            orderId:      order.orderId,
            _id:          order.orderId,
            status:       'REJECTED',
            reason:       order.rejectedReason,
            disputeUntil,
            warningCount: newCount,
            isBlocked:    hitThreshold,
            server_ts:    Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'REJECTED', server_ts: Date.now() });
        // Explicit flag event so the admin console can surface the flagged user.
        emitAdminUpdate('user_flagged', {
            userId:          order.userId,
            orderId:         order.orderId,
            reason:          flagReason,
            warningCount:    newCount,
            paymentFlagCount: updatedUser?.paymentFlagCount || 0,
            autoBlocked:     hitThreshold,
            server_ts:       Date.now(),
        });

        res.json({
            success: true,
            message: 'Order rejected. The player can dispute it until the window closes; the tokens stay held until then.',
            disputeUntil,
            warningCount: newCount,
            paymentFlagged: true,
            autoBlocked:  hitThreshold,
        });
    } catch (error) {
        console.error('POST /merchant/orders/:id/reject error:', error);
        res.status(500).json({ success: false, message: 'Failed to reject order' });
    }
});



export default router;
