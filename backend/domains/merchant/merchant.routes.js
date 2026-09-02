// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Merchant (BBEPS Phase 003 §3.3) — player-facing merchant registration/auth.
// Moved from backend/routes/merchant.routes.js on 2026-07-01 (BBEPS Phase 004 migration).


import express   from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '#db';
import { creditDeposit, creditReserve, refundWithdrawal, releaseWithdrawal } from '../wallet/walletAuthority.service.js';
// AQ-2/AQ-8: sign via the single JWT authority; hash via the password authority
// (argon2id + bcrypt verify-fallback). No direct bcrypt use remains here.
import { signToken } from '../identity/jwt.util.js';
import { hashPassword, verifyPassword } from '../identity/password.util.js';
import { merchantAuth } from '../../middleware/merchantAuth.js';
import { issueChallenge, verifyChallenge, CHALLENGE_AUDIENCE } from '../identity/twoFactorChallenge.js';
import { verifySecondFactor, SECOND_FACTOR_RESULT } from '../identity/verifySecondFactor.js';
import { twoFactorLimiter } from '../../middleware/security.js';
import {
  generateSecret, buildOtpauthUri, encryptSecret, decryptSecret,
  verifyToken, generateBackupCodes, hashBackupCode,
} from '../identity/totp.service.js';
import { releaseUTR } from '../../middleware/utrValidation.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import { tryAssignMerchant, buildMerchantSnapshot, updateMerchantStatsOnComplete } from '../payment/paymentProcessing.service.js';
// The order state machine. Every status change is a guarded transition, and
// where money moves the transition runs FIRST and gates it.
import {
  startOrder, markOrderPaid as markOrderPaidState, completeOrder,
  disputeOrder, cancelOrder as cancelOrderState, requeueOrder,
} from '../payment/orderLifecycle.service.js';
// Withdrawal settlement hold — confirm asserts payment, the worker settles it
// once the dispute window passes. See withdrawalHold.service.js.
import { holdMinutes } from '../payment/withdrawalHold.service.js';
// One rule for how a confirmed deposit splits across the user's two pockets.
import { depositCreditSplit } from '../payment/depositCredit.js';
import { debitMerchantTokens, creditMerchantTokens } from './merchantWallet.service.js';
import { getMerchantTokenBalance } from '#db/repositories/merchantWallets.js';
import { publish as publishDomainEvent, EVENTS as DOMAIN_EVENTS } from '../../services/eventBus.service.js';
import { getRiskRules } from '../risk/riskValidation.service.js';
// Order chat. Every write here named a model registered nowhere, so the thread
// echoed over the socket and never survived a reload.
import { listMessages, postMessage, postSystemMessage } from '#db/repositories/chat.js';
import { FLAGS, isEnabled } from '../../services/featureFlags.service.js';
import { rupeesToPaise } from '../../shared/money.js';
import { MONEY_PATHS } from '#db/moneyPaths.js';
import {
  DIRECTIONS as SETTLEMENT_DIRECTIONS, openSettlement,
} from '#db/repositories/merchantSettlements.js';

/** Is Postgres the source of truth for the merchant side of a settlement? */
import { buildBulkPayoutExportRows } from './bulkPayoutExport.js';
import { MERCHANT_CURRENCY, isTrc20Address, merchantTypeOf } from './merchantCurrency.js';
import { getSystemConfig } from '#db/repositories/config.js';

const router     = express.Router();
// JWT secret + expiry owned by jwt.util.js — removed a '|| fallback-secret'
// default here (AQ-1): a missing secret must fail-fast, never sign with a
// public string that would let anyone forge merchant tokens.

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function requireBulkPayoutsEnabled(req, res, next) {
    if (await isEnabled(FLAGS.MERCHANT_BULK_PAYOUTS)) return next();
    return res.status(403).json({ success: false, message: 'Merchant bulk payouts are not enabled.' });
}


function sanitizeMerchantOrder(order) {
    const plain = typeof order?.toObject === 'function' ? order.toObject() : { ...(order || {}) };
    delete plain.userPhone;
    delete plain.merchantSnapshot;
    if (plain.type === 'DEPOSIT') {
        // A deposit is money coming IN to the merchant — the user's payout
        // destinations (bank, UPI, TRC-20 wallet) are not needed and are not sent.
        delete plain.userBankDetails;
        delete plain.upiId;
        delete plain.userUsdtAddress;
    }
    return plain;
}

function sanitizeMerchantOrders(orders) {
    return orders.map((order) => sanitizeMerchantOrder(order));
}


const formatMerchant = (merchant, user = null) => {
    // A merchant settles on exactly one rail; the panel renders UPI/bank OR the
    // TRC-20 address from this, never both (domains/merchant/merchantCurrency.js).
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
        usdtWalletAddress:    merchant.usdtWalletAddress || '',
        qrCodeUrl:            merchant.qrCodeUrl,
        limits:               merchant.limits,
        minOrder:             merchant.minOrder,
        maxOrder:             merchant.maxOrder,
        tokenBalance:         merchant.tokenBalance,
        earnings:             merchant.earnings,
        totalProcessedVolume: merchant.totalProcessedVolume,
        // Performance figures the panel's dashboard/profile show; all are
        // maintained by merchantScoring.service.js — read-only here.
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
        const { username, mobile, password, email, upiId, bankDetails } = req.body;
        if (!username || !mobile || !password) {
            return res.status(400).json({ success: false, message: 'username, mobile and password are required' });
        }

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
        const created = await db.merchants.createMerchantAccount({
            userId: db.users.newUserId(),
            username, mobile,
            email: email || null,
            passwordHash: await hashPassword(password),
            bankDetails: bankDetails || upiId ? {
                upiId: upiId || bankDetails?.upiId || null,
                bankName: bankDetails?.bankName || null,
                accountNo: bankDetails?.accountNo || null,
                ifsc: bankDetails?.ifsc || null,
            } : null,
        });

        if (!created.ok) {
            // Named, because "signup failed" tells an applicant nothing they
            // can act on — and a payment credential already registered to
            // someone else is a different problem from a taken mobile.
            const message = created.reason === 'MOBILE_TAKEN'
                ? 'Mobile number already registered'
                : 'Those payment details are already registered to another merchant';
            return res.status(409).json({ success: false, message });
        }

        res.json({
            success: true,
            message: 'Application submitted. An admin will review and approve your account.',
        });
    } catch (error) {
        console.error('Merchant signup error:', error);
        res.status(500).json({ success: false, message: 'Signup failed. Please try again.' });
    }
});

router.post('/auth/login', async (req, res) => {
    try {
        const { mobile, password } = req.body;
        if (!mobile || !password) {
            return res.status(400).json({ success: false, message: 'mobile and password are required' });
        }

        // ── One lookup, no repair ────────────────────────────────────────
        // This used to try the merchant record, then fall back to the account,
        // then WRITE the mobile back onto the merchant record if it was
        // missing — data repair inside an authentication path, for a state
        // that signup can no longer produce. The mobile is a column with a
        // unique index now, and signup writes it in the same transaction as
        // the account, so there is one lookup and nothing to fix up.
        const merchant = await db.merchants.getMerchantByLogin(mobile);
        if (!merchant)
            return res.status(401).json({ success: false, message: 'No merchant account found for this mobile number' });

        // Credentials are read by a function that has to be asked for BY NAME,
        // so a hash cannot reach a response body by accident.
        const creds = await db.merchants.getMerchantCredentials(merchant.merchantId);
        const { valid: pwValid, needsRehash: pwNeedsRehash } = await verifyPassword(creds?.passwordHash, password);
        if (!pwValid)
            return res.status(401).json({ success: false, message: 'Invalid credentials' });

        // AQ-8: upgrade a legacy bcrypt hash to argon2id on a successful login.
        // Best-effort: a failed upgrade must not fail a login that has already
        // been authenticated.
        if (pwNeedsRehash) {
            try {
                await db.merchants.updateMerchant(merchant.merchantId, {
                    passwordHash: await hashPassword(password),
                });
            } catch (e) { console.error('[merchant-login] hash upgrade failed:', e.message); }
        }

        // The credential read is the authority on 2FA state, not the rendered
        // record — they come from the same row, but only one of them is the
        // one the challenge is issued against.
        merchant.twoFactorEnabled = creds?.twoFactorEnabled ?? false;

        if (merchant.merchantApprovalStatus !== 'APPROVED' || merchant.status !== 'ACTIVE') {
            const msgs = { PENDING: 'Application pending approval.', REJECTED: 'Application rejected.',
                           SUSPENDED: 'Account suspended.' };
            return res.status(403).json({ success: false,
                message: msgs[merchant.status] || msgs[merchant.merchantApprovalStatus] || 'Account not active.' });
        }

        // ── Second factor ────────────────────────────────────────────────
        // Password accepted, but for an enrolled merchant that is half the
        // login. Hand back a five-minute challenge instead of a session; only
        // /auth/login/2fa can turn it into one.
        if (merchant.twoFactorEnabled) {
            return res.status(200).json({
                success: false,             // deliberately not a logged-in success
                twoFactorRequired: true,
                challengeToken: issueChallenge({
                    id: merchant.merchantId, audience: CHALLENGE_AUDIENCE.MERCHANT,
                }),
                message: 'Enter the code from your authenticator app.',
            });
        }

        // Not yet enrolled. 2FA is mandatory for merchants, so rather than
        // refuse the login (which would lock out every existing merchant the
        // moment this deploys) the session is issued with a flag the panel
        // uses to force enrolment before anything else is reachable.
        return issueMerchantSession(merchant, res, { mustEnroll2FA: true });
    } catch (error) {
        console.error('Merchant login error:', error);
        res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
    }
});

/**
 * Mint the merchant session. Extracted so the password-only path and the
 * post-OTP path cannot grant different claims — same reasoning as
 * issueSession in routes.js.
 */
function issueMerchantSession(merchant, res, extra = {}) {
    const token = signToken(
        { merchantId: merchant._id, userId: merchant.userId, mobile: merchant.mobile, isMerchant: true, isAdmin: false }
    );
    return res.json({
        success: true, token, ...extra,
        merchant: {
            _id: merchant._id, userId: merchant.userId,
            username: merchant.username, mobile: merchant.mobile, email: merchant.email,
            status: merchant.status, isOnline: merchant.isOnline,
            tokenBalance: merchant.tokenBalance || 0,
            acceptsDeposits: merchant.acceptsDeposits !== false,
            acceptsWithdrawals: merchant.acceptsWithdrawals !== false,
            twoFactorEnabled: merchant.twoFactorEnabled || false,
        },
    });
}

/**
 * POST /api/merchant/auth/login/2fa — redeem a merchant challenge.
 *
 * Re-loads the merchant and re-applies the approval/status gate: the password
 * leg proved a password up to five minutes ago, and an admin may have
 * suspended the account since.
 */
router.post('/auth/login/2fa', twoFactorLimiter, async (req, res) => {
    try {
        const { challengeToken, code } = req.body;
        if (!challengeToken || !code)
            return res.status(400).json({ success: false, message: 'Challenge token and code are required' });

        const challenge = verifyChallenge(challengeToken, CHALLENGE_AUDIENCE.MERCHANT);
        if (!challenge)
            return res.status(401).json({ success: false, twoFactorExpired: true,
                message: 'Login session expired. Please sign in again.' });

        const merchant = await db.merchants.getMerchant(challenge.id)
            .select('+twoFactorSecret +twoFactorLastCounter +backupCodes');
        if (!merchant)
            return res.status(401).json({ success: false, message: 'Invalid credentials' });

        if (merchant.merchantApprovalStatus !== 'APPROVED' || merchant.status !== 'ACTIVE') {
            const msgs = { PENDING: 'Application pending approval.', REJECTED: 'Application rejected.',
                           SUSPENDED: 'Account suspended.' };
            return res.status(403).json({ success: false,
                message: msgs[merchant.status] || msgs[merchant.merchantApprovalStatus] || 'Account not active.' });
        }

        const verdict = await verifySecondFactor(merchant, code);
        if (!verdict.ok) {
            if (verdict.result === SECOND_FACTOR_RESULT.MALFORMED_SECRET) {
                console.error(`🚨 2FA secret undecryptable for merchant ${merchant._id} — check TOTP_ENCRYPTION_KEY`);
                return res.status(500).json({ success: false,
                    message: 'Two-factor verification is misconfigured on the server. Contact support.' });
            }
            return res.status(401).json({ success: false, message: 'Invalid authentication code' });
        }
        if (verdict.usedBackupCode) {
            console.warn(`🔐 Recovery code used for merchant ${merchant._id} — ${verdict.backupCodesRemaining} remaining`);
        }
        return issueMerchantSession(merchant, res);
    } catch (error) {
        console.error('Merchant 2FA login error:', error);
        res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
    }
});

// ─── 2FA ENROLMENT ───────────────────────────────────────────────────────────
// Merchants live in their own collection, so they cannot use /api/2fa (which
// is User-only). Same two-step handshake for the same reason: a secret that
// goes live before the merchant proves they scanned it locks them out of an
// account that moves real settlement money.

router.get('/2fa/status', merchantAuth, async (req, res) => {
    const m = req.merchant;
    res.json({
        success: true,
        enabled: !!m.twoFactorEnabled,
        mandatory: true,                    // every merchant, no exceptions
        enrolledAt: m.twoFactorEnrolledAt || null,
        backupCodesRemaining: (m.backupCodes || []).length,
    });
});

router.post('/2fa/setup', merchantAuth, twoFactorLimiter, async (req, res) => {
    try {
        const merchant = await db.merchants.getMerchant(req.merchantId).select('+twoFactorSecret');
        if (merchant.twoFactorEnabled)
            return res.status(400).json({ success: false,
                message: 'Two-factor authentication is already active. Disable it first to re-enrol.' });

        const secret = generateSecret();
        merchant.twoFactorPendingSecret = encryptSecret(secret);   // PENDING, not live
        await merchant.save();

        res.json({
            success: true,
            secret,                                                 // for manual entry
            otpauthUri: buildOtpauthUri({
                secret,
                label: `merchant:${merchant.mobile || merchant.username || merchant._id}`,
            }),
            message: 'Scan the QR with your authenticator, then submit a code to activate.',
        });
    } catch (e) {
        console.error('Merchant 2FA setup error:', e);
        res.status(500).json({ success: false, message: 'Could not start two-factor setup.' });
    }
});

router.post('/2fa/activate', merchantAuth, twoFactorLimiter, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ success: false, message: 'Code is required' });

        const merchant = await db.merchants.getMerchant(req.merchantId)
            .select('+twoFactorPendingSecret +twoFactorSecret +twoFactorLastCounter +backupCodes');
        if (!merchant.twoFactorPendingSecret)
            return res.status(400).json({ success: false, message: 'Start setup first.' });

        const pending = decryptSecret(merchant.twoFactorPendingSecret);
        const verdict = verifyToken({ secret: pending, token: String(code) });
        if (!verdict.valid)
            return res.status(400).json({ success: false, message: 'That code did not match. Check your authenticator and try again.' });

        // Only now does the secret become live.
        const codes = generateBackupCodes();
        merchant.twoFactorSecret = merchant.twoFactorPendingSecret;
        merchant.twoFactorPendingSecret = undefined;
        merchant.twoFactorEnabled = true;
        merchant.twoFactorEnrolledAt = new Date();
        merchant.twoFactorLastCounter = verdict.counter;   // the activation code is spent
        merchant.backupCodes = codes.map(hashBackupCode);
        await merchant.save();

        res.json({
            success: true,
            backupCodes: codes,     // shown exactly once — only hashes are stored
            message: 'Two-factor authentication is active. Save these recovery codes now; they will not be shown again.',
        });
    } catch (e) {
        console.error('Merchant 2FA activate error:', e);
        res.status(500).json({ success: false, message: 'Could not activate two-factor authentication.' });
    }
});

// NOTE: there is deliberately no merchant /2fa/disable. 2FA is mandatory for
// accounts that settle money, so self-service removal would be a hole in the
// policy rather than a convenience. A merchant who loses their handset uses a
// recovery code; if those are gone too, an admin re-enrols them out of band.

// ─── PROFILE ─────────────────────────────────────────────────────────────────

router.get('/profile', merchantAuth, async (req, res) => {
    try {
        const merchant = await db.merchants.getMerchant(req.merchantId);
        if (!merchant) return res.status(404).json({ success: false, message: 'Merchant profile not found.' });
        // Fixed 1:1 internal conversion (Phase 006 flattening, 2026-07-08):
        // no buy/sell spread. Shape kept for merchant-panel compatibility;
        // merchant earnings move to the future Merchant Performance Bonus.
        res.json({
            success: true,
            merchant: {
                ...formatMerchant(merchant, req.user),
                prices: { buyPrice: 1, sellPrice: 1, profit: 0 },
            },
        });
    } catch (err) {
        console.error('GET /merchant/profile error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
    }
});

// FIX B5-d: PUT /profile — merchant edits their own settlement credentials.
// Rail-exclusive (2026-07-27): an INR merchant may edit UPI/QR/bank and NOT the
// USDT address; a USDT merchant may edit only the TRC-20 address. Enforced here
// and not merely hidden in the panel, so a hand-crafted request cannot leave a
// merchant holding credentials for a rail they do not settle on. Only the admin
// (PUT /merchants/:id/capabilities) can change which rail a merchant is on.
router.put('/profile', merchantAuth, async (req, res) => {
    try {
        const { upiId, qrCodeUrl, bankDetails, usdtWalletAddress } = req.body;

        const current = await db.merchants.getMerchant(req.merchantId);
        if (!current) return res.status(404).json({ success: false, message: 'Merchant profile not found.' });

        const isUsdt  = merchantTypeOf(current) === MERCHANT_CURRENCY.USDT;
        const railName = isUsdt ? 'USDT' : 'INR';
        const update  = {};

        const wantsInrFields  = upiId !== undefined || qrCodeUrl !== undefined || bankDetails !== undefined;
        const wantsUsdtFields = usdtWalletAddress !== undefined;

        if (isUsdt && wantsInrFields) {
            return res.status(400).json({ success: false, message: `This is a ${railName} merchant account — UPI, QR and bank details do not apply. Update the USDT wallet address instead.` });
        }
        if (!isUsdt && wantsUsdtFields) {
            return res.status(400).json({ success: false, message: `This is a ${railName} merchant account — a USDT wallet address does not apply. Update UPI/bank details instead.` });
        }

        if (wantsUsdtFields) {
            const address = String(usdtWalletAddress || '').trim();
            if (!isTrc20Address(address)) {
                return res.status(400).json({ success: false, message: 'Enter a valid TRC-20 (Tron) address — 34 characters starting with "T". USDT sent to a wrong address cannot be recovered.' });
            }
            update.usdtWalletAddress = address;
        }

        if (upiId !== undefined) {
            update['bankDetails.upiId'] = upiId;
        }
        if (qrCodeUrl !== undefined) {
            update.qrCodeUrl = qrCodeUrl;
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
            if (e.code === '23514') {
                return res.status(400).json({ success: false, message: 'Those payment details are not in a valid format.' });
            }
            throw e;
        }

        res.json({ success: true, merchant: formatMerchant(merchant, req.user) });
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
        res.json({ success: true, merchant: formatMerchant(merchant, req.user) });
    } catch (err) {
        console.error('PUT /merchant/online-status error:', err);
        res.status(500).json({ success: false, message: 'Failed to update online status.' });
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
        res.json({ success: true, merchant: formatMerchant(merchant, req.user) });
    } catch (err) {
        console.error('PUT /merchant/preferences error:', err);
        res.status(500).json({ success: false, message: 'Failed to update preferences.' });
    }
});


// PUT /api/merchant/limits — merchant sets their own Merchant.limits (min/maxDeposit, min/maxWithdraw)
// SEPARATE from User.merchantLimits (admin queue cap) and SystemConfig (platform limits)
router.put('/limits', merchantAuth, async (req, res) => {
    try {
        const { minDeposit, maxDeposit, minWithdraw, maxWithdraw } = req.body;
        const update = {};
        if (minDeposit  !== undefined) update['limits.minDeposit']  = Number(minDeposit);
        if (maxDeposit  !== undefined) update['limits.maxDeposit']  = Number(maxDeposit);
        if (minWithdraw !== undefined) update['limits.minWithdraw'] = Number(minWithdraw);
        if (maxWithdraw !== undefined) update['limits.maxWithdraw'] = Number(maxWithdraw);
        if (!Object.keys(update).length)
            return res.status(400).json({ success: false, message: 'No valid limit fields provided.' });

        // Rupees in, integer paise stored — the limits are compared against
        // order amounts, and an order amount is paise. The row also refuses a
        // range that excludes every amount (min above max), which the document
        // schema did not check at all.
        let merchant;
        try {
            merchant = await db.merchants.updateMerchant(req.merchantId, update);
        } catch (e) {
            if (e.code === '23514') {
                return res.status(400).json({
                    success: false,
                    message: 'Those limits exclude every amount — the minimum cannot be above the maximum.',
                });
            }
            throw e;
        }
        res.json({ success: true, merchant: formatMerchant(merchant, req.user) });
    } catch (err) {
        console.error('PUT /merchant/limits error:', err);
        res.status(500).json({ success: false, message: 'Failed to update limits.' });
    }
});

// ─── MERCHANT → ADMIN TOKEN PURCHASE ORDERS ─────────────────────────────────
router.get('/admin-token-orders', merchantAuth, async (req, res) => {
    try {
        const orders = await db.paymentConfig.listTokenOrders({ merchantId: req.merchantId, limit: 30 });
        res.json({ success: true, orders });
    } catch (err) {
        console.error('GET /merchant/admin-token-orders error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch admin token orders.' });
    }
});

router.post('/admin-token-orders', merchantAuth, async (req, res) => {
    try {
        const tokenAmount = Number(req.body.tokenAmount);
        const usdtTxHash = String(req.body.usdtTxHash || '').trim();
        const [cfg, merchant] = await Promise.all([
            getSystemConfig(),
            db.merchants.getMerchant(req.merchantId),
        ]);
        if (!merchant || merchant.status !== 'ACTIVE' || merchant.merchantApprovalStatus !== 'APPROVED') {
            return res.status(403).json({ success: false, message: 'Only approved active merchants can buy admin tokens.' });
        }
        if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Token amount must be greater than zero.' });
        }
        const configuredUsdtRate = cfg?.usdtPricing?.merchantAdminBuyInr;
        const usdtRate = configuredUsdtRate === undefined ? 1 : configuredUsdtRate; // schema default: SystemConfig.usdtPricing.merchantAdminBuyInr = 1
        if (!Number.isFinite(usdtRate) || usdtRate < 0.01) {
            return res.status(500).json({ success: false, message: 'Admin USDT buy rate is misconfigured.' });
        }
        // Merchants pay USDT in whole multiples of 10. If the configured INR/USDT
        // rate produces a fractional/non-multiple quote, round UP so the platform
        // never undercharges the merchant for admin tokens.
        const exactUsdtCents = Math.ceil((tokenAmount / usdtRate) * 100 - 1e-9);
        const usdtAmount = Math.ceil(exactUsdtCents / 1000) * 10;
        const minPurchaseUsdt = cfg?.merchantOrderLimits?.minAdminTokenPurchaseUsdt ?? 100;
        const maxPurchaseUsdt = cfg?.merchantOrderLimits?.maxAdminTokenPurchaseUsdt ?? 0;
        if (!Number.isFinite(usdtAmount) || usdtAmount < minPurchaseUsdt || (maxPurchaseUsdt > 0 && usdtAmount > maxPurchaseUsdt)) {
            const maxText = maxPurchaseUsdt > 0 ? ` and at most ${maxPurchaseUsdt} USDT` : '';
            return res.status(400).json({ success: false, message: `Admin token purchase must be at least ${minPurchaseUsdt} USDT${maxText}.` });
        }
        // ONE REQUEST PER DAY, decided by a unique index rather than by a
        // lookup for today's request followed by an insert. That check-then-act
        // shape is a rate limit that stops nobody who clicks twice: both
        // requests pass the check, both insert.
        const created = await db.paymentConfig.createTokenOrder({
            orderId: `MAT_${randomBytes(12).toString('hex')}`,
            merchantId: req.merchantId,
            tokenAmountRupees: tokenAmount,
            usdtRate,
            usdtAmount,
            usdtTxHash: usdtTxHash || null,
        }).catch((e) => {
            if (e.code === '23505') return { ok: false, reason: 'ALREADY_REQUESTED_TODAY' };
            throw e;
        });

        if (!created.ok) {
            return res.status(429).json({
                success: false,
                message: 'Only one admin token purchase request is allowed per day.',
            });
        }
        res.json({ success: true, order: created.order });
    } catch (err) {
        console.error('POST /merchant/admin-token-orders error:', err);
        res.status(500).json({ success: false, message: 'Failed to create admin token order.' });
    }
});

// ─── ORDERS ──────────────────────────────────────────────────────────────────

router.get('/orders', merchantAuth, async (req, res) => {
    try {
        const { status, type, limit = '50', skip = '0' } = req.query;
        const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
        const parsedSkip  = Math.max(parseInt(skip)  || 0, 0);

        // The open withdrawal pool (unassigned sell orders any merchant may pick
        // up) must be filtered to this merchant's own rail — a USDT merchant has
        // no way to pay out an INR withdrawal and vice-versa (2026-07-27).
        // Orders written before `currency` existed have no field at all, so the
        // The merchant's own orders PLUS the open withdrawal pool on their
        // rail. The rail filter is not cosmetic: an INR merchant claiming a
        // USDT order cannot settle it, and the player waits for a payment that
        // will never come.
        const { orders, total } = await db.orders.merchantVisibleOrders({
            merchantId: req.merchantId,
            rail: merchantTypeOf(req.merchant),
            state: status || null,
            orderType: type || null,
            limit: parsedLimit,
            offset: parsedSkip,
        });

        res.json({ success: true, orders: sanitizeMerchantOrders(orders), pagination: { total, limit: parsedLimit, skip: parsedSkip } });
    } catch (err) {
        console.error('GET /merchant/orders error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch orders.' });
    }
});

router.post('/accept/:id', merchantAuth, async (req, res) => {
    try {
        const order = await db.orders.getOrderRecord(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        if (order.merchantId && order.merchantId.toString() !== req.merchantId.toString()) {
            return res.status(403).json({ success: false, message: 'This order is assigned to a different merchant.' });
        }
        if (!['PENDING_QUEUE', 'ASSIGNED'].includes(order.status)) {
            return res.status(400).json({ success: false, message: `Order cannot be accepted in status: ${order.status}` });
        }

        const merchant = await db.merchants.getMerchant(req.merchantId);
        if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

        // Rail check (2026-07-27). Assignment already matches currency, but an
        // order can also be claimed from the open withdrawal pool — so the rail
        // is re-checked at the point the merchant actually takes the order.
        const merchantRail = merchantTypeOf(merchant);
        const orderRail    = order.currency || MERCHANT_CURRENCY.INR; // schema default: 'INR'
        if (orderRail !== merchantRail) {
            return res.status(400).json({ success: false, message: `This is a ${orderRail} order and you settle in ${merchantRail}.` });
        }
        if (merchantRail === MERCHANT_CURRENCY.USDT && !merchant.usdtWalletAddress) {
            return res.status(400).json({ success: false, message: 'Add your TRC-20 wallet address in Profile before taking USDT orders.' });
        }

        if (order.type === 'DEPOSIT') {
            // From the WALLET, not the merchant record. This gate admits an
            // order the merchant then has to fund; deciding it from a stored
            // copy is how one came to be accepted that could not be served.
            const availableTokens = await getMerchantTokenBalance(merchant.merchantId);
            if (merchant.acceptsDeposits === false || availableTokens < order.tokenAmount) {
                return res.status(400).json({ success: false, message: 'Merchant has insufficient token balance or deposit capability for this buy order.' });
            }
        } else if (merchant.acceptsWithdrawals === false) {
            return res.status(400).json({ success: false, message: 'Merchant is not enabled for sell orders.' });
        }

        const cfg = await getSystemConfig();
        const typeLimit = order.type === 'DEPOSIT'
            ? (merchant.maxConcurrentDepositOrders ?? cfg?.merchantOrderLimits?.maxConcurrentDepositOrders ?? 1)
            : (merchant.maxConcurrentWithdrawalOrders ?? cfg?.merchantOrderLimits?.maxConcurrentWithdrawalOrders ?? 1);
        // DERIVED from the orders themselves. The merchant record used to carry
        // an `activeOrderCount` incremented on accept and decremented on
        // finish; a crash between the two throttled that merchant permanently,
        // with nothing able to correct it because nothing else knew the number.
        const counts = await db.merchants.getActiveOrderCounts([req.merchantId]);
        const active = counts.get(String(req.merchantId));
        const activeForType = order.type === 'DEPOSIT' ? active.deposit : active.withdrawal;
        if (activeForType >= typeLimit) {
            return res.status(400).json({ success: false, message: `Merchant has reached ${order.type} active order limit (${typeLimit}).` });
        }

        const wasAssigned = Boolean(order.assignedAt);
        const now        = new Date();
        const expiresAt  = new Date(now.getTime() + 15 * 60 * 1000); // 15-min window starts on accept

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
            set: {
                merchantId:       req.merchantId,
                assignedAt:       order.assignedAt || now,
                processingAt:     now,
                expiresAt,
                merchantSnapshot: buildMerchantSnapshot(merchant, expiresAt),
                ...(responseMinutes === null ? {} : { merchantResponseMinutes: responseMinutes }),
            },
        });
        if (!accepted.ok || accepted.idempotent) {
            // Two merchants racing the same queued order both used to pass the
            // status read above and both used to save; the second overwrote the
            // first's merchantId and snapshot, so the user was shown one
            // merchant's payment details while the other held the order.
            return res.status(409).json({
                success: false,
                message: `Order is ${accepted.status ?? 'missing'} and cannot be accepted.`,
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
        const payAmount   = isUsdtOrder ? `${order.fiatAmount} USDT` : `₹${order.fiatAmount}`;

        if (isDeposit) {
            const payTo = isUsdtOrder
                ? `merchant USDT address (TRC-20): ${merchant.usdtWalletAddress || 'See payment details'}`
                : `merchant UPI: ${merchant.bankDetails?.upiId || 'See payment details'}`;
            await sendSystemMessage(oid,
                `✅ Order Accepted by Merchant\n` +
                `📋 Order: ${order.orderId}\n` +
                `💰 User must pay ${payAmount} to ${payTo}\n` +
                `⏱ Payment window: 15 minutes`,
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
                `   Account Holder: ${bank.accountHolderName || 'N/A'}\n` +
                `   UPI ID: ${order.upiId || 'N/A'}`,
                io
            );
        }

        // Notify user of PROCESSING status with updated snapshot and timer
        emitOrderUpdate(order.userId.toString(), 'order_update', {
            orderId:          order.orderId,
            _id:              order._id,
            status:           'PROCESSING',
            merchantSnapshot: order.merchantSnapshot,
            expiresAt:        order.expiresAt,
            server_ts:        Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'PROCESSING', server_ts: Date.now() });

        res.json({ success: true, order: sanitizeMerchantOrder(order) });
    } catch (err) {
        console.error('POST /merchant/accept/:id error:', err);
        res.status(500).json({ success: false, message: 'Failed to accept order.' });
    }
});

router.post('/confirm/:id', merchantAuth, async (req, res) => {
    try {
        const { proof, utrNumber } = req.body;
        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        const isDeposit = order.type === 'DEPOSIT';

        if (isDeposit) {
            // DEPOSIT confirm: must be in PAID status with valid UTR
            if (order.status !== 'PAID') {
                return res.status(400).json({ success: false, message: `Deposit can only be confirmed in PAID status. Current: ${order.status}` });
            }
            if (!utrNumber || utrNumber.trim().length < 12) {
                return res.status(400).json({ success: false, message: 'UTR number (minimum 12 characters) is required to confirm a deposit.' });
            }
            if (!proof && !order.proofScreenshot) {
                return res.status(400).json({ success: false, message: 'Payment proof screenshot is required.' });
            }
        } else {
            // WITHDRAWAL confirm: must be in PROCESSING status
            if (!['PROCESSING', 'ASSIGNED'].includes(order.status)) {
                return res.status(400).json({ success: false, message: `Withdrawal can only be confirmed in PROCESSING/ASSIGNED status. Current: ${order.status}` });
            }
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
        // Which target this is depends on the branch: a deposit completes, a
        // withdrawal under hold only reaches PAID (asserted, not settled), and a
        // withdrawal with the hold disabled completes inline.
        const holdFor = isDeposit ? 0 : await holdMinutes();
        const carried = {
            ...(proof     ? { proofScreenshot: proof }          : {}),
            ...(utrNumber ? { utrNumber: utrNumber.trim() }     : {}),
        };

        let moved;
        if (isDeposit) {
            moved = await completeOrder(order._id, {
                expectFrom: 'PAID',
                set: { ...carried, completedAt: new Date() },
            });
        } else if (holdFor > 0) {
            moved = await markOrderPaidState(order._id, {
                expectFrom: ['PROCESSING', 'ASSIGNED'],
                set: {
                    ...carried,
                    merchantCreditStatus:    'HELD',
                    merchantCreditHoldUntil: new Date(Date.now() + holdFor * 60 * 1000),
                    escrowLocked:            true,
                },
            });
        } else {
            moved = await completeOrder(order._id, {
                expectFrom: 'PROCESSING',
                set: {
                    ...carried, completedAt: new Date(),
                    merchantCreditStatus: 'RELEASED', escrowLocked: false,
                },
            });
        }
        if (!moved.ok) {
            return res.status(409).json({
                success: false,
                message: `Order is ${moved.status ?? 'missing'} and cannot be confirmed.`,
            });
        }
        if (moved.idempotent) {
            // A previous delivery already confirmed this order, and the money
            // moved with it. Re-running the wallet calls would be harmless (they
            // are keyed) but not re-running them is clearer about what happened.
            return res.json({ success: true, message: 'Order already confirmed', order: sanitizeMerchantOrder(moved.order ?? order) });
        }
        Object.assign(order, moved.order);

        if (isDeposit) {
            // AUDIT FIX F-1 (2026-07-09): tokens must be TRANSFERRED from the
            // merchant, never minted. Previously the user was credited first
            // and the merchant debit was best-effort (allowOverdraft + swallowed
            // error) — so an under-funded merchant confirm minted tokens into
            // existence. Correct order (mirrors the approve path): debit the
            // merchant FIRST with a hard $gte guard; only if that succeeds do we
            // credit the user. If the user credit then fails, refund the merchant
            // (idempotent) so no tokens are burned either.
            //
            // Step 1: debit merchant inventory — hard-fail if insufficient.
            const { merchant: debited } = await debitMerchantTokens({
                merchantId: req.merchantId, amount: order.tokenAmount,
                reason: `Deposit ${order.orderId} confirmed — tokens dispensed to user`,
                refModel: 'PaymentOrder', refId: order.orderId,
                txId: `mw_dep_deduct_${order.orderId}`,
            });
            if (!debited) {
                return res.status(400).json({ success: false, message: 'Insufficient token inventory to confirm this deposit. Top up your merchant wallet.' });
            }
            // Step 2: credit the user — apply the DepositPolicy deposit/reserve
            // split (Phase X fix X-1/X-2, 2026-07-10). This path previously
            // credited the FULL tokenAmount to depositBalance with NO reserve
            // split, so real deposits NEVER funded reserveBalance — leaving
            // DepositPolicy + the Phase A betReservePercent split dormant in
            // production, and making the derived ledger (which always posts
            // order.reserveAllocation) disagree with the actual wallet.
            // depositAllocation/reserveAllocation are computed by the
            // paymentOrder pre-save hook from the active DepositPolicy (logged
            // 90/10 fallback if none configured). Both credits are idempotent
            // via their canonical keys (dep_complete_/reserve_credit_<orderId>).
            //
            // The `?? order.tokenAmount` this used to carry never fired: a
            // hydrated Mongoose document applies the schema default, so a legacy
            // order reads 0 rather than undefined — while the same order read
            // `.lean()` reads undefined and DOES fire it. domains/payment/
            // depositCredit.js states the rule once so the answer stops
            // depending on how the order was fetched.
            const { depositCredit, reserveCredit } = depositCreditSplit(order);
            try {
                if (depositCredit > 0) await creditDeposit(order.userId, depositCredit, order.orderId);
                if (reserveCredit > 0) await creditReserve(order.userId, reserveCredit, order.orderId);
            } catch (walletErr) {
                console.error('[Merchant confirm] user credit failed — refunding merchant:', walletErr.message);
                await creditMerchantTokens({
                    merchantId: req.merchantId, amount: order.tokenAmount,
                    reason: `Deposit ${order.orderId} confirm reversed — user credit failed`,
                    refModel: 'PaymentOrder', refId: order.orderId,
                    txId: `mw_dep_refund_${order.orderId}`,
                }).catch(e => console.error('[Merchant confirm] CRITICAL: merchant refund failed, manual reconcile needed:', e.message));
                return res.status(500).json({ success: false, message: 'Wallet credit failed. Please retry.' });
            }
        } else {
            // ── WITHDRAWAL confirm: an ASSERTION, not a settlement ─────────────
            // The merchant is claiming they sent the player fiat. Nothing proves
            // it yet, so nothing settles yet.
            //
            // This branch used to consume the player's locked stake AND credit
            // the merchant in the same request. A merchant who pressed confirm
            // without sending the money therefore held spendable tokens
            // instantly, and could convert them through a buy order before the
            // player noticed nothing arrived — with the player's stake already
            // gone, the platform ate the loss and the dispute process arrived
            // after the value had left.
            //
            // Both sides now freeze for SystemConfig.withdrawalHoldMinutes.
            // Until it expires no value has moved: the player's stake stays
            // locked exactly as it has since order creation, and the merchant's
            // tokens do not exist. A dispute inside the window is a reversal of
            // something still held (withdrawalHold.reverseHold), not a clawback.
            // See domains/payment/withdrawalHold.service.js.
            //
            // The status, the HELD marker and the hold deadline were written by
            // the transition above — this branch is now only the side effects
            // that follow it.
            if (holdFor > 0) {
                // Record what the platform now OWES this merchant, in a pocket
                // they cannot spend. On Mongo the tokens simply do not exist
                // during the hold, so nothing shows the liability; opening the
                // settlement here makes it visible and gives the sweeper a real
                // state machine to advance. Idempotent on the order's key, and
                // fire-and-forget: the hold itself must not fail because the
                // settlement could not be opened — settleHold opens it lazily.
                // Unconditional. This was `if (settlementOnPostgres())`, and that
                // resolver was deleted with the rest of the two-store machinery
                // — so the guard threw a ReferenceError and the merchant's
                // confirm 500'd after the withdrawal had already been held.
                await openSettlement({
                    settlementId: `ms_${order.orderId}`, merchantId: req.merchantId,
                    orderId: order.orderId, direction: SETTLEMENT_DIRECTIONS.WITHDRAWAL,
                    amountPaise: rupeesToPaise(order.tokenAmount),
                    reason: `Withdrawal ${order.orderId} held pending settlement`,
                }).catch(e => console.error('[Merchant confirm] settlement open failed:', e.message));
            } else {
                // Hold disabled by admin — settle inline, the pre-2026-07-30
                // behaviour. Same canonical txIds, so an order can never be
                // credited twice across the two paths.
                await releaseWithdrawal(order.userId, order.tokenAmount, order.orderId);
                await creditMerchantTokens({
                    merchantId: req.merchantId, amount: order.tokenAmount,
                    reason: `Withdrawal ${order.orderId} confirmed — tokens received from user`,
                    refModel: 'PaymentOrder', refId: order.orderId,
                    txId: `mw_wd_credit_${order.orderId}`,
                }).catch(e => console.error('[Merchant confirm] WITHDRAWAL tokenBalance increment failed:', e.message));
            }

            // Emit wallet update so user sees updated balance
            await emitWalletUpdate(order.userId);
        }

        // Funding event (Phase 009): lets the ledger reconciler pick this
        // completion up within seconds. Non-blocking — never affects the flow.
        try { publishDomainEvent(DOMAIN_EVENTS.PAYMENT_ORDER_COMPLETED, { orderId: order._id, type: order.type }); } catch (_) {}

        // Update merchant scoring stats
        await updateMerchantStatsOnComplete(req.merchantId, true).catch(() => {});

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
                    `💰 ₹${order.fiatAmount} received. Order COMPLETE.\n` +
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
                    `UTR / Ref: ${utrNumber || order.utrNumber || 'Provided separately'}\n` +
                    `📋 Token Sale: ₹${order.fiatAmount} to your bank account\n\n` +
                    `⏳ Settling in about ${mins} minute(s).\n` +
                    `If the money has NOT reached your account by then, raise a dispute on this order — ` +
                    `your tokens are still held and will be returned to you.`,
                    io
                );
            } else {
                await sendSystemMessage(oid,
                    `💸 Merchant has sent your payout\n` +
                    `UTR / Ref: ${utrNumber || order.utrNumber || 'Provided separately'}\n` +
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
            emitOrderUpdate(order.userId.toString(), 'order_update', {
                orderId: order.orderId, _id: order._id, status: order.status,
                merchantCreditStatus: 'HELD',
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

        res.json({ success: true, order: sanitizeMerchantOrder(order) });
    } catch (err) {
        console.error('POST /merchant/confirm/:id error:', err);
        res.status(500).json({ success: false, message: 'Failed to confirm payment.' });
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
            set: { merchantId: null, merchantSnapshot: null, expiresAt: null, rejectedReason: reason },
        });
        if (!requeued.ok) {
            return res.status(409).json({
                success: false,
                message: `Order can only be rejected in ASSIGNED status. Current: ${requeued.status ?? 'missing'}`,
            });
        }
        Object.assign(order, requeued.order);

        // The lifetime counter moves; there is no active count to decrement.
        // It is derived from the orders, so requeuing one IS the decrement —
        // and a merchant who lost the race cannot decrement a count they still
        // hold, because there is no count to get wrong.
        await db.merchants.recordCompletedOrder(req.merchantId, {
            direction: order.type, amountRupees: 0, earningsRupees: 0, disputed: false,
        });

        // Release escrow if WITHDRAWAL
        if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
            try {
                await refundWithdrawal(order.userId, order.tokenAmount, order.orderId);
                order.escrowLocked = false;
            } catch (refundErr) {
                console.error('[merchant reject] winnings refund failed:', refundErr.message);
            }
        }

        // Try re-assignment to next-best merchant
        const reAssigned = await tryAssignMerchant(order);
        if (reAssigned) {
            emitAdminUpdate('queue_order_update', {
                orderId: order._id, status: order.status, server_ts: Date.now(),
            });
            emitOrderUpdate(order.userId.toString(), 'order_assigned', {
                orderId:          order.orderId,
                _id:              order._id,
                status:           order.status,
                merchantSnapshot: order.merchantSnapshot,
                expiresAt:        order.expiresAt,
                server_ts:        Date.now(),
            });
            res.json({ success: true, message: 'Order rejected and re-assigned to another merchant.', order: sanitizeMerchantOrder(order) });
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
            res.json({ success: true, message: 'Order rejected. Searching for next available merchant.', order: sanitizeMerchantOrder(order) });
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

// ─── POST /api/merchant/order/:id/dispute — merchant raises dispute ────────────────────────────────────
router.post('/order/:id/dispute', merchantAuth, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason?.trim()) return res.status(400).json({ success: false, message: 'A reason is required.' });

        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        // ASSIGNED is deliberately absent: the rule table admits a dispute from
        // PROCESSING, PAID or COMPLETED only, and an order nobody has started
        // working on has nothing to dispute yet. This route accepted ASSIGNED
        // and Postgres would have refused it — the disagreement no
        // reconciliation can tell apart from real drift.
        const disputed = await disputeOrder(order._id, {
            expectFrom: 'PROCESSING',
            set: {
                disputeReason:   reason.trim(),
                disputeRaisedAt: new Date(),
                disputeRaisedBy: 'merchant',
                updatedAt:       new Date(),
            },
        });
        if (!disputed.ok) {
            return res.status(409).json({ success: false, message: `Cannot raise dispute in ${disputed.status ?? 'unknown'} status.` });
        }
        Object.assign(order, disputed.order);

        // Notify admin SSE (GOVERNANCE §11: order_disputed)
        emitAdminUpdate('order_disputed', {
            orderId:   order._id,
            raisedBy:  'merchant',
            reason:    reason.trim(),
            server_ts: Date.now(),
        });
        emitOrderUpdate(order.userId.toString(), 'order_update', {
            orderId:   order.orderId,
            _id:       order._id,
            status:    'DISPUTED',
            server_ts: Date.now(),
        });

        res.json({ success: true, message: 'Dispute raised. Admin will review.', order: sanitizeMerchantOrder(order) });
    } catch (err) {
        console.error('POST /merchant/order/:id/dispute error:', err);
        res.status(500).json({ success: false, message: 'Failed to raise dispute.' });
    }
});



//


//

router.get('/chat/:id', merchantAuth, async (req, res) => {
    try {
        // ONE lookup, with ownership in the WHERE clause.
        //
        // This used to search by document id OR order id OR both, then compare
        // the merchant afterwards — a fetch-then-compare, which has already
        // loaded the row (including the player's bank details) before deciding
        // whether the caller was allowed to see it. There is one id now, and
        // the ownership is part of the query.
        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        const messages = await listMessages(order._id, { limit: 200 });

        res.json({
            success: true,
            // The thread is stored against the order's id; the panel labels each
            // message with the human-facing orderId, which is a different string.
            messages: messages.map(m => ({ ...m, orderId: order.orderId })),
        });
    } catch (err) {
        console.error('GET /merchant/chat/:id error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch chat.' });
    }
});

router.post('/chat/:id', merchantAuth, async (req, res) => {
    try {
        const { text, attachmentUrl } = req.body;
        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, message: 'Message text is required.' });
        }

        // ONE lookup, with ownership in the WHERE clause.
        //
        // This used to search by document id OR order id OR both, then compare
        // the merchant afterwards — a fetch-then-compare, which has already
        // loaded the row (including the player's bank details) before deciding
        // whether the caller was allowed to see it. There is one id now, and
        // the ownership is part of the query.
        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        const chat = await postMessage({
            orderId:       order.orderId,
            senderId:      req.userId,
            senderType:    'MERCHANT',
            message:       text.trim(),
            attachmentUrl: attachmentUrl || null,
            isSystem:      false,
        });


        // The stored message, relabelled with the human-facing orderId — the
        // panel joins on that, not on the order document's id.
        const chatPayload = { ...chat, orderId: order.orderId };

        
        try {
            const io = global.io;
            if (io) {
                const oid = order.orderId || order.orderId;
                io.to(`order_${oid}`).emit(`chat_${oid}`, chatPayload);
                if (order.userId) {
                    io.to(`user-${order.userId}`).emit('new_chat_message', chatPayload);
                }
            }
        } catch (_) {}

        res.json({ success: true, message: chatPayload });
    } catch (err) {
        console.error('POST /merchant/chat/:id error:', err);
        res.status(500).json({ success: false, message: 'Failed to send message.' });
    }
});

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

        // The red flag and the DISPUTED move land in ONE update. Writing the
        // flag separately would leave an order flagged but not disputed if the
        // second write failed, which is the state the admin queue cannot see.
        const flagged = await disputeOrder(order._id, {
            set: {
                redFlagged:     true,
                redFlagReason:  reason.trim(),
                redFlaggedBy:   req.userId,
                redFlaggedAt:   new Date(),
                disputeReason:  `Red-flagged by merchant: ${reason.trim()}`,
            },
        });
        if (!flagged.ok) {
            return res.status(409).json({
                success: false,
                message: `Cannot red-flag an order that is ${flagged.status ?? 'missing'}.`,
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

        res.json({ success: true, message: 'Order has been red-flagged and escalated to admin.', order: sanitizeMerchantOrder(order) });
    } catch (err) {
        console.error('POST /merchant/orders/:id/red-flag error:', err);
        res.status(500).json({ success: false, message: 'Failed to red-flag order.' });
    }
});

// ─── BULK PAYOUTS (FIX B5-c) ─────────────────────────────────────────────────
//
// Token sell (WITHDRAWAL) orders grouped by bulkPayoutDate.
// Merchant downloads CSV/Excel to process bank transfers, then marks batch paid.
//

// GET /api/merchant/bulk-payouts?date=YYYY-MM-DD
// Returns all WITHDRAWAL orders for a given day's bulk payout batch.
router.get('/bulk-payouts', merchantAuth, requireBulkPayoutsEnabled, async (req, res) => {
    try {
        const { date } = req.query;

        // `bulk_payout_date` is a DATE, so the batch is a day rather than a
        // timestamp range each call site computes for itself — three of them
        // built their own IST midnight, and a difference of one in any would
        // have paid a different set of orders.
        const payoutDate = date || await db.orders.istToday();
        const orders = await db.orders.bulkPayoutBatch({
            merchantId: req.merchantId, payoutDate,
        });

        const totalFiat   = orders.reduce((s, o) => s + (o.fiatAmount || 0), 0);
        const totalTokens = orders.reduce((s, o) => s + (o.tokenAmount || 0), 0);

        res.json({
            success: true,
            // The date the batch was actually read for. This said
            // `targetDate.toISOString()` and `targetDate` did not exist — the
            // handler threw a ReferenceError after doing all its work.
            date:    payoutDate,
            orders: sanitizeMerchantOrders(orders),
            summary: {
                count:       orders.length,
                totalFiat,
                totalTokens,
            },
        });
    } catch (err) {
        console.error('GET /merchant/bulk-payouts error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch bulk payouts.' });
    }
});

// GET /api/merchant/bulk-payouts/export?date=YYYY-MM-DD
// Returns CSV-formatted JSON rows for bank upload (NEFT/IMPS/RTGS batch file).
router.get('/bulk-payouts/export', merchantAuth, requireBulkPayoutsEnabled, async (req, res) => {
    try {
        const { date } = req.query;

        const payoutDate = date || await db.orders.istToday();
        const orders = await db.orders.bulkPayoutBatch({
            merchantId: req.merchantId, payoutDate,
        });

        // Format rows for bank CSV upload
        // Standard Indian bank bulk transfer format
        const rows = buildBulkPayoutExportRows(orders);

        const dateStr  = payoutDate;
        const totalAmt = orders.reduce((s, o) => s + (o.amount || 0), 0);

        res.json({
            success:   true,
            date:      dateStr,
            filename:  `bulk_payout_${dateStr}.csv`,
            rows,
            summary: {
                count:      rows.length,
                totalAmount: totalAmt,
            },
        });
    } catch (err) {
        console.error('GET /merchant/bulk-payouts/export error:', err);
        res.status(500).json({ success: false, message: 'Failed to export bulk payouts.' });
    }
});

// POST /api/merchant/bulk-payouts/mark-paid
// Mark a batch of withdrawal orders as bulk-paid.
// Body: { orderIds: string[], batchRef?: string }
router.post('/bulk-payouts/mark-paid', merchantAuth, requireBulkPayoutsEnabled, async (req, res) => {
    try {
        const { orderIds, batchRef } = req.body;
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({ success: false, message: 'orderIds array is required.' });
        }

        const paidAt  = new Date();
        const batchId = batchRef || `BATCH_${Date.now()}`;

        // The eligibility is in the WHERE clause of ONE statement: this
        // merchant's withdrawals, in a state a payout may close. An order that
        // moved between the read and the write matches nothing rather than
        // being closed from a state it has already left.
        const result = await db.orders.bulkCompleteWithdrawals({
            orderIds, merchantId: req.merchantId, batchId, paidAt,
        });

        // Notify admins
        if (global.sseManager) {
            global.sseManager.broadcastToAdmins('bulk_payout_completed', {
                merchantId: req.merchantId,
                batchId,
                count:      result.completed,
                paidAt,
            });
        }

        res.json({
            success:  true,
            message:  `${result.completed} orders marked as paid.`,
            batchId,
            count:    result.modifiedCount,
        });
    } catch (err) {
        console.error('POST /merchant/bulk-payouts/mark-paid error:', err);
        res.status(500).json({ success: false, message: 'Failed to mark orders as paid.' });
    }
});

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
                today: {
                    deposits:    { totalFees: todayDeposits.totalFees,    totalAmount: todayDeposits.totalAmount,    count: todayDeposits.count },
                    withdrawals: { totalFees: todayWithdrawals.totalFees, totalAmount: todayWithdrawals.totalAmount, count: todayWithdrawals.count },
                },
                lifetime: {
                    totalEarnings: lifetime.totalEarnings,
                    totalVolume:   lifetime.totalVolume,
                    totalOrders:   lifetime.totalOrders,
                },
                pending: req.merchant.earnings || 0,
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/merchant/orders/:id/approve
// Merchant approves a PAID deposit order. Runs token allocation (90/10 split).
// Spec Section 11.1 / 4.2 / Finding 4 (atomic) / Finding 5 (inventory guard)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/orders/:id/approve', merchantAuth, async (req, res) => {
    const session = await safeSession();
    try {
        // WalletLedger no longer needed here — the wallet authority writes its
        // own ledger entries now (Phase X X-3, 2026-07-10).
        const { id }      = req.params;

        // ── The order of operations, and why it changed ──────────────────
        //
        // This used to COMPLETE the order, then debit the merchant, and — when
        // the merchant could not fund it — walk the order backwards from
        // COMPLETED to PAID. Its own comment called that "compensation, not a
        // transition — deliberately outside the state machine", which is an
        // accurate description of a write nothing guards.
        //
        // The constraint is the merchant's inventory, so the inventory is
        // checked FIRST. That is the order the /confirm path on this same route
        // already used: debit the merchant under a hard guard, and only once it
        // succeeds does anything else happen. A failure now leaves the order
        // exactly where it was, with nothing to undo.
        const pending = await db.orders.getMerchantOrder(id, req.merchantId);
        if (!pending) return res.status(404).json({ success: false, message: 'Order not found, or not assigned to you' });
        if (pending.status !== 'PAID') {
            return res.status(400).json({ success: false, message: `Cannot approve order in ${pending.status} status` });
        }

        // Step 1: the merchant's tokens. Idempotent on a canonical txId, so a
        // retried approval debits once — and hard-guarded, so an under-funded
        // merchant is refused rather than overdrawn.
        const { merchant: updatedMerchant } = await debitMerchantTokens({
            merchantId: req.merchantId, amount: pending.tokenAmount,
            reason: `Deposit ${pending.orderId} approved — tokens dispensed to user`,
            refModel: 'PaymentOrder', refId: pending.orderId,
            txId: `mw_dep_deduct_${pending.orderId}`, session,
        });
        if (!updatedMerchant) {
            await abortOrEnd(session);
            return res.status(400).json({
                success: false,
                message: 'Merchant has insufficient token inventory to approve this order',
            });
        }

        // Step 2: the transition, guarded on PAID. Two approvals racing both
        // reach here; only one moves the order, and the other's debit was
        // idempotent, so nothing is double-spent either way.
        const approved = await completeOrder(id, {
            expectFrom: 'PAID',
            set: { approvedBy: req.merchantId, approvedAt: new Date() },
            session,
        });
        if (!approved.ok || approved.idempotent) {
            await abortOrEnd(session);
            if (approved.reason === 'not_found') return res.status(404).json({ success: false, message: 'Order not found' });
            if (approved.idempotent) return res.status(409).json({ success: false, message: 'Order already approved' });
            return res.status(400).json({ success: false, message: `Cannot approve order in ${approved.status} status` });
        }
        const order = approved.order;

        // ── Token allocation (Section 4) ────────────────────────────────────────
        // Uses the split already locked in at order creation
        // (paymentOrder.model.js pre-save hook), driven by the active
        // DepositPolicy — NOT recomputed here. This route previously had its
        // own independent hardcoded 90/10, a second write path to the same
        // value the model's pre-save hook already computes; removed per
        // docs/governance/04-GOVERNANCE.md §2 ("No second write path to a value with a
        // designated single-writer service"). depositAllocation already
        // includes the floor() remainder (Spec 4.4: remainder goes to
        // deposit, never reserve — see the pre-save hook).
        //
        // Read through the shared rule rather than off the order directly: an
        // order with no recorded split (one predating the fields, or a type the
        // pre-save hook never ran for) reads 0/0 here, and crediting 0 while the
        // merchant is debited the full tokenAmount BURNS tokens as surely as the
        // other direction creates them. depositCredit.js falls back to the whole
        // amount into `depositBalance`, which is where it went before the split
        // existed.
        const { depositCredit, reserveCredit } = depositCreditSplit(order);

        // ── User balance credit — via the wallet authority (Phase X fix X-3,
        // 2026-07-10). This route previously credited via a raw $inc + a
        // hand-written WalletLedger, bypassing walletAuthority (§7) and — more
        // importantly — with NO idempotency key: the ONLY double-credit defense
        // was the PAID→COMPLETED status guard, and safeSession() silently
        // degrades non-atomic on standalone Mongo. creditDeposit/creditReserve
        // are idempotent on canonical keys (so this is now mutually idempotent
        // with the /confirm path — an order credits at most once total) and
        // run atomically under the route session on a replica set. Closes
        // Known Open Item #6.
        if (depositCredit > 0) await creditDeposit(order.userId, depositCredit, order.orderId, session);
        if (reserveCredit > 0) await creditReserve(order.userId, reserveCredit, order.orderId, session);
        const updatedUser = await db.users.getUser(order.userId);

        // No separate transaction row. `creditDeposit` and `creditReserve`
        // each write their own append-only ledger entry inside the movement, so
        // a second hand-written record here would be a duplicate that can
        // disagree with the one the money actually made — and it is the ledger
        // that reconciliation is computed from.

        // ── Mark UTR as RELEASED ───────────────────────────────────────────────
        await releaseUTR(order.orderId);

        await commitOrEnd(session);

        // Funding event (Phase 009): nudges the ledger reconciler immediately.
        try { publishDomainEvent(DOMAIN_EVENTS.PAYMENT_ORDER_COMPLETED, { orderId: order._id, type: order.type }); } catch (_) {}

        // ── SSE: notify user of new balances (Finding 3) ──────────────────────
        emitOrderUpdate(order.userId.toString(), 'order_completed', {
            orderId:        order.orderId,
            _id:            order._id,
            status:         'COMPLETED',
            depositBalance:  updatedUser.depositBalance  || 0,
            winningsBalance: updatedUser.winningsBalance || 0,
            reserveBalance:  updatedUser.reserveBalance  || 0,
            server_ts:       Date.now(),
        });
        await emitWalletUpdate(order.userId, updatedUser);
        emitAdminUpdate('order_completed', { orderId: order._id, server_ts: Date.now() });

        res.json({
            success: true,
            message: 'Order approved. Tokens credited to user.',
            creditedDeposit:  depositCredit,
            creditedReserve:  reserveCredit,
            order: sanitizeMerchantOrder(order),
        });
    } catch (error) {
        await abortOrEnd(session);
        console.error('POST /merchant/orders/:id/approve error:', error);
        res.status(500).json({ success: false, message: 'Failed to approve order' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/merchant/orders/:id/reject
// Merchant rejects a PAID/PROCESSING order.
// Spec Section 11.2 / 13
// ─────────────────────────────────────────────────────────────────────────────
router.post('/orders/:id/reject', merchantAuth, async (req, res) => {
    try {
        const { id }   = req.params;
        const { reason } = req.body;

        const order = await db.orders.getOrderRecord(id);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        if (order.merchantId?.toString() !== req.merchantId?.toString()) {
            return res.status(403).json({ success: false, message: 'This order is not assigned to you' });
        }

        // ── Transition order to CANCELLED (with rejection metadata) ───────────
        // The guard is the transition. Everything after this point — the user's
        // warning count, the payment flag, the auto-block — is a consequence of
        // the rejection, and a merchant retrying a failed request used to run
        // all of it a second time and increment the warning count again.
        const rejected = await cancelOrderState(order.orderId, {
            expectFrom: ['PAID', 'PROCESSING'],
            set: {
                rejectedBy:     req.merchantId,
                rejectedAt:     new Date(),
                rejectedReason: reason || 'Rejected by merchant',
                cancelReason:   'MERCHANT_REJECTED',
                cancelledAt:    new Date(),
                updatedAt:      new Date(),
            },
        });
        if (!rejected.ok || rejected.idempotent) {
            return res.status(409).json({
                success: false,
                message: `Cannot reject order in ${rejected.status ?? 'unknown'} status`,
            });
        }
        Object.assign(order, rejected.order);

        // ── Warning engine + payment-complaint flag (Section 13.2; owner
        //    directive 2026-07-14) ──────────────────────────────────────────────
        // A merchant rejecting a PAID/PROCESSING order IS "the merchant complains
        // the payment failed / wasn't received". Beyond the hidden warningCount,
        // set an EXPLICIT paymentFlagged marker so support/admin can see and filter
        // the user immediately. Auto-block threshold stays admin-owned
        // (SystemConfig.riskRules.maxWarnings; 0 = never). Both mutations are one
        // atomic $inc/$set so a flag can never be lost between two writes.
        // The auto-block threshold stays admin-owned (riskRules.maxWarnings;
        // 0 = never). The increment, the flag AND the block are ONE statement:
        // it was two, and a failure between them left a player one warning past
        // the limit and not blocked, with nothing to re-check it — the count
        // only moves again when a new warning arrives.
        const { maxWarnings } = await getRiskRules();
        const flagReason = (reason && reason.trim()) || 'Merchant reported payment not received / failed';
        const flagged = await db.users.flagPaymentWarning(order.userId, {
            reason: flagReason, maxWarnings,
        });

        const updatedUser  = flagged?.user ?? null;
        const newCount     = flagged?.warningCount ?? 0;
        const hitThreshold = flagged?.autoBlocked ?? false;

        // ── SSE: notify user (Finding 3) ──────────────────────────────────────
        emitOrderUpdate(order.userId.toString(), 'order_rejected', {
            orderId:      order.orderId,
            _id:          order.orderId,
            reason:       order.rejectedReason,
            warningCount: newCount,
            isBlocked:    hitThreshold,
            server_ts:    Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'CANCELLED', server_ts: Date.now() });
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
            message: 'Order rejected.',
            warningCount: newCount,
            paymentFlagged: true,
            autoBlocked:  hitThreshold,
        });
    } catch (error) {
        console.error('POST /merchant/orders/:id/reject error:', error);
        res.status(500).json({ success: false, message: 'Failed to reject order' });
    }
});

/**
 * The session helpers, now no-ops.
 *
 * `safeSession` opened a document-store transaction and, on a standalone
 * server, logged a warning and returned null — so the "atomic" approve path
 * ran NON-atomically in exactly the deployment most likely to be a single
 * node, and the code above it could not tell the difference.
 *
 * Every money movement on this route is its own PostgreSQL transaction with a
 * deterministic idempotency key, which is what makes a retry safe without an
 * enclosing session. There is nothing left to open, commit or abort. The names
 * survive because a dozen call sites thread `session` through, and passing a
 * no-op is clearer than a sweep that deletes an argument from each of them.
 */
const safeSession = async () => null;
const commitOrEnd = async () => {};
const abortOrEnd  = async () => {};
const withSession = () => ({});

export default router;
