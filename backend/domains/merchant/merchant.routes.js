// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
import {
  twoFactorLimiter, loginPaceLimiter,
  // Supplying a cash link and submitting a CDM slip both shipped with no limit.
  // Neither is a login route, so no auth tier covered them; both write to a
  // queue an admin and other merchants read.
  cashLinkSupplyLimiter, cdmReceiptLimiter,
} from '../../middleware/security.js';
import {
  generateSecret, buildOtpauthUri, encryptSecret, decryptSecret,
  verifyToken, generateBackupCodes, hashBackupCode,
} from '../identity/totp.service.js';
import { releaseUTR } from '../../middleware/utrValidation.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import {
    tryAssignMerchant, buildMerchantSnapshot, updateMerchantStatsOnComplete,
    // A supplied link is handed straight to whoever is waiting for it.
    matchWaitingOrdersToLinks,
} from '../payment/paymentProcessing.service.js';
// The order state machine. Every status change is a guarded transition, and
// where money moves the transition runs FIRST and gates it.
import {
  startOrder, markOrderPaid as markOrderPaidState, completeOrder,
  disputeOrder, cancelOrder as cancelOrderState, requeueOrder,
} from '../payment/orderLifecycle.service.js';
// Withdrawal settlement hold — confirm asserts payment, the worker settles it
// once the dispute window passes. See withdrawalHold.service.js.
import { holdMinutes } from '../payment/withdrawalHold.service.js';
// A push to the PLAYER's socket goes through the player projection, like every
// other thing a player receives.
import { toPlayerOrderView } from '../payment/playerOrderView.js';
// One rule for how a confirmed deposit splits across the user's two pockets.
import { moveDepositMoney } from '../payment/depositCredit.js';
import {
  holdForOrder as holdDepositTokens,
  dispenseForOrder as dispenseDepositHold,
  releaseForOrder as releaseDepositHold,
} from './depositEscrow.service.js';
import { debitMerchantTokens, creditMerchantTokens } from './merchantWallet.service.js';
import { publish as publishDomainEvent, EVENTS as DOMAIN_EVENTS } from '../../services/eventBus.service.js';
// Order chat. Every write here named a model registered nowhere, so the thread
// echoed over the socket and never survived a reload.
// Only the order's own timeline now — the record a dispute is decided from.
// listMessages/postMessage went with the merchant order chat above.
import { postSystemMessage } from '#db/repositories/chat.js';
// Every external payment reference — a UTR, a chain transaction hash, a CDM
// slip's bank id — is claimed through ONE registry, so the same payment cannot
// be presented twice.
import {
  claimPaymentReference, CDM_REFERENCE_SPEC, MERCHANT_TOKEN_REFERENCE_SPEC,
} from '../payment/paymentReference.js';
import cdnService from '../../services/cdn.service.js';
import { adminToMerchantUsdtRate } from '../configuration/tokenRates.js';
import { rupeesToPaise } from '../../shared/money.js';
import { MONEY_PATHS } from '#db/moneyPaths.js';
import {
  DIRECTIONS as SETTLEMENT_DIRECTIONS, openSettlement,
} from '#db/repositories/merchantSettlements.js';

/** Is Postgres the source of truth for the merchant side of a settlement? */
import {
  MERCHANT_CURRENCY, merchantTypeOf, formatOrderFiat,
  USDT_CHAINS, USDT_CHAIN_SPEC, isUsdtAddress, usdtAddressFor, usdtChainsHeldBy,
} from './merchantCurrency.js';
import { toMerchantOrderView, toMerchantOrderViews } from './merchantOrderView.js';
import { getActivePolicy as getPaymentModePolicy, modeCopy, publicTimers } from '../configuration/paymentMode.service.js';
import { supplyCashLink, suppliersWithHeadroom } from './cashLink.service.js';
import { PAYMENT_MODES } from '#db/repositories/paymentModePolicy.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { recordMerchantRefusal, REFUSAL } from './merchantRefusal.service.js';
import { assertCdnAssetUrl } from '../../shared/storedUrl.js';
import { assertStaffPassword } from '../identity/passwordPolicy.js';

const router     = express.Router();
// JWT secret + expiry owned by jwt.util.js — removed a '|| fallback-secret'
// default here (AQ-1): a missing secret must fail-fast, never sign with a
// public string that would let anyone forge merchant tokens.

// ─── HELPERS ─────────────────────────────────────────────────────────────────





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
        // One per chain, and the list of chains they can actually be paid on
        // — which is what decides whether any USDT order reaches them.
        usdtAddressTrc20:     merchant.usdtAddressTrc20 || '',
        usdtAddressBep20:     merchant.usdtAddressBep20 || '',
        usdtChains:           usdtChainsHeldBy(merchant),
        limits:               merchant.limits,
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
router.post('/auth/login/2fa', loginPaceLimiter, twoFactorLimiter, async (req, res) => {
    try {
        const { challengeToken, code } = req.body;
        if (!challengeToken || !code)
            return res.status(400).json({ success: false, message: 'Challenge token and code are required' });

        const challenge = verifyChallenge(challengeToken, CHALLENGE_AUDIENCE.MERCHANT);
        if (!challenge)
            return res.status(401).json({ success: false, twoFactorExpired: true,
                message: 'Login session expired. Please sign in again.' });

        // Credentials, not the ordinary record: the 2FA columns are excluded
        // from the general read, so passing the plain merchant here would look
        // exactly like "not enrolled" and let a 2FA account in without one.
        const merchant = await db.merchants.getMerchant(challenge.id);
        const creds = await db.merchants.getMerchantCredentials(challenge.id);
        if (!merchant || !creds)
            return res.status(401).json({ success: false, message: 'Invalid credentials' });

        if (merchant.merchantApprovalStatus !== 'APPROVED' || merchant.status !== 'ACTIVE') {
            const msgs = { PENDING: 'Application pending approval.', REJECTED: 'Application rejected.',
                           SUSPENDED: 'Account suspended.' };
            return res.status(403).json({ success: false,
                message: msgs[merchant.status] || msgs[merchant.merchantApprovalStatus] || 'Account not active.' });
        }

        const verdict = await verifySecondFactor(creds, code, {
            spendCounter: (counter) => db.merchants.spendTwoFactorCounter(challenge.id, counter),
            consumeBackupCode: (arg) => db.merchants.consumeTwoFactorBackupCode(challenge.id, arg),
        });
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
        const creds = await db.merchants.getMerchantCredentials(req.merchantId);
        if (!creds)
            return res.status(404).json({ success: false, message: 'Merchant not found' });
        if (creds.twoFactorEnabled)
            return res.status(400).json({ success: false,
                message: 'Two-factor authentication is already active. Disable it first to re-enrol.' });

        const secret = generateSecret();
        // PENDING, not live: the secret only becomes the account's second factor
        // once the merchant proves they can generate a code from it.
        const merchant = await db.merchants.updateMerchant(req.merchantId, {
            twoFactorPendingSecret: encryptSecret(secret),
        });

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

        const creds = await db.merchants.getMerchantCredentials(req.merchantId);
        if (!creds?.twoFactorPendingSecret)
            return res.status(400).json({ success: false, message: 'Start setup first.' });

        const pending = decryptSecret(creds.twoFactorPendingSecret);
        const verdict = verifyToken({ secret: pending, token: String(code) });
        if (!verdict.valid)
            return res.status(400).json({ success: false, message: 'That code did not match. Check your authenticator and try again.' });

        // Only now does the secret become live — and all of it in ONE update,
        // so the account is never found enrolled with no recovery codes, or
        // with a live secret whose activation code has not been spent.
        const codes = generateBackupCodes();
        await db.merchants.updateMerchant(req.merchantId, {
            twoFactorSecret: creds.twoFactorPendingSecret,
            twoFactorPendingSecret: null,
            twoFactorEnabled: true,
            twoFactorEnrolledAt: new Date(),
            twoFactorLastCounter: verdict.counter,   // the activation code is spent
            backupCodes: codes.map(hashBackupCode),
        });

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

/**
 * GET /api/merchant/payment-mode — which settlement rail this merchant is on.
 *
 * Read on panel load, and it is this — not the notification and not the socket
 * push — that actually guarantees a merchant knows their workflow. A merchant
 * with no linked player account has no inbox, and a merchant whose socket
 * dropped missed the broadcast; both still load the panel.
 *
 * Carries the timers the merchant is held to, and NOT the policy's authorship:
 * who switched the rail and why is an admin surface.
 */
router.get('/payment-mode', merchantAuth, async (req, res) => {
    try {
        const policy = await getPaymentModePolicy();
        res.json({
            success: true,
            activeMode: policy?.activeMode ?? null,
            version: policy?.version ?? null,
            ...modeCopy(policy?.activeMode),
            timers: publicTimers(policy),
        });
    } catch (err) {
        console.error('GET /merchant/payment-mode error:', err);
        res.status(500).json({ success: false, message: 'Failed to read the settlement rail.' });
    }
});

/**
 * GET /api/merchant/cash-links/current — what this merchant is holding, and
 * whether it is worth going to a machine.
 *
 * Read on the cash-rail screen. The "waiting" figure is the merchant's OWN
 * denomination and nothing else: a ₹500 merchant seeing the ₹10,000 backlog
 * learns nothing and is tempted by an order they cannot take.
 *
 * `worthGoing` is computed by the SAME function the broadcast uses. Two
 * implementations of "can this merchant serve one" would put a different
 * answer on the screen than in the notification.
 */
/**
 * POST /api/merchant/orders/:id/cdm-receipt — the evidence for a cash payout.
 *
 * On the cash rail a SELL is settled by depositing cash at a CDM into the
 * player's bank account. The merchant's confirm already completed the order —
 * the player is not held up waiting for paperwork — and this is the evidence
 * that follows.
 *
 * ── Write-only, and this route is the write half ───────────────────────────
 * Once submitted, NEITHER the merchant who uploaded it nor the player can read
 * it back. Only an admin or a disputes manager can, through
 * `GET /api/admin/orders/:orderId/cdm-receipt`.
 *
 * That is enforced in the data layer, not here: `toOrder` does not map these
 * columns, so no projection built on it can carry them. This handler writes
 * them and never reads them back in its own response.
 *
 * The consequence for the merchant is real and worth stating: they cannot check
 * what they uploaded afterwards. So the proof is verified against THIS merchant
 * and THIS order before it is stored, and the response confirms exactly what
 * was accepted — that confirmation is the only look they get.
 */
router.post('/orders/:id/cdm-receipt', merchantAuth, cdmReceiptLimiter, async (req, res) => {
    try {
        const { transactionId, receiptFileKey, receiptCdnUrl } = req.body || {};

        if (!transactionId || !String(transactionId).trim()) {
            return res.status(400).json({
                success: false, reason: 'TRANSACTION_ID_REQUIRED',
                message: CDM_REFERENCE_SPEC.hint,
            });
        }
        if (!receiptFileKey) {
            return res.status(400).json({
                success: false, reason: 'RECEIPT_REQUIRED',
                message: 'A photo of the CDM receipt is required. A transaction id with no image is an assertion with no evidence.',
            });
        }

        // SCOPED to the merchant making the request. An unscoped read here let
        // ANY merchant attach their slip to ANY payout — claiming somebody
        // else's cash deposit and, with it, the evidence a dispute is decided
        // on. It was scoped when this handler was written and lost in a later
        // edit; the suite caught it, which is why the assertion is a 404 on
        // another merchant's order rather than a happy-path check.
        const order = await db.orders.getMerchantOrder(req.params.id, req.merchantId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
        if (order.type !== 'WITHDRAWAL') {
            return res.status(400).json({
                success: false, reason: 'NOT_A_WITHDRAWAL',
                message: 'A CDM receipt belongs to a payout, not a purchase.',
            });
        }
        if (order.paymentMode !== PAYMENT_MODES.CASH_ATM) {
            return res.status(400).json({
                success: false, reason: 'WRONG_RAIL',
                message: 'This order was created on the UPI rail and is not settled at a CDM.',
            });
        }

        // ── The bank reference is CLAIMED, not merely recorded ───────────
        // A CDM slip's transaction id is a bank's reference for one real cash
        // deposit, exactly as a UTR is for one real transfer. It used to be
        // written into a column with nothing stopping the same id appearing on
        // a second payout — one deposit presented as two, with every check
        // green. It goes through the same registry as every other reference,
        // and a duplicate is refused by name.
        //
        // Before the receipt is verified or stored, so a refused id leaves
        // nothing behind.
        try {
            await claimPaymentReference({
                reference: transactionId,
                orderId: order.orderId,
                amountRupees: order.fiatAmount,
                spec: CDM_REFERENCE_SPEC,
            });
        } catch (e) {
            return res.status(e.status || 400).json({
                success: false, reason: e.code || 'INVALID_REFERENCE',
                message: e.message, originalOrderId: e.originalOrderId ?? null,
            });
        }

        // Bound to THIS merchant and THIS order — without it a merchant could
        // name a key they never uploaded, or one staged against a different
        // order, and the stored evidence would point at somebody else's.
        let verified;
        try {
            verified = await cdnService.verifyUploadedObject({
                fileKey: String(receiptFileKey).trim(),
                cdnUrl: receiptCdnUrl || undefined,
                expectedUserId: String(req.merchantId),
                expectedOrderId: order.orderId,
                expectedCategory: 'cdm-receipt',
            });
        } catch (e) {
            return res.status(400).json({ success: false, message: `Receipt could not be verified: ${e.message}` });
        }

        const submittedAt = new Date();
        await db.orders.setOrderFields(order.orderId, {
            cdmTransactionId: String(transactionId).trim(),
            cdmReceiptUrl: verified.cdnUrl,
            cdmReceiptAt: submittedAt,
        });

        await db.audit.recordDetailed({
            performedBy: req.merchantId, performedByRole: 'merchant',
            action: 'CDM_RECEIPT_SUBMITTED', category: 'MERCHANT',
            targetType: 'PaymentOrder', targetId: order.orderId,
            // The URL is NOT recorded here. An audit row is read by more people
            // than the receipt is, and putting it in one would be a second way
            // to reach the thing this route exists to keep narrow.
            details: { transactionId: String(transactionId).trim(), submittedAt },
        });

        res.json({
            success: true,
            // The only look the merchant gets. Echoed deliberately, because
            // they cannot open it again to check what they sent.
            submitted: { transactionId: String(transactionId).trim(), submittedAt },
            message: 'Receipt recorded. It is visible only to an admin or a disputes manager from now on.',
        });
    } catch (err) {
        console.error('POST /merchant/orders/:id/cdm-receipt error:', err);
        res.status(500).json({ success: false, message: 'Failed to record the CDM receipt.' });
    }
});

/**
 * GET /api/merchant/cdm-receipts/outstanding — the slips this merchant owes.
 *
 * The confirm completes the order and the receipt is chased afterwards, which
 * is the right order for the PLAYER — they are not held up waiting for
 * paperwork. The cost is that the moment to submit passes: an upload that
 * failed, an app closed at the machine, a slip not yet in hand, and the order
 * is gone from every screen the merchant has.
 *
 * This is the way back to it. `GET /api/admin/orders/cdm-receipts/missing`
 * asks the same question from the other side — who is not evidencing their
 * payouts — so without this route that admin queue fills with items the only
 * person who can clear them cannot reach.
 *
 * ── Why this does not go through `toMerchantOrderView` ─────────────────────
 * It is not an order. It is three columns — which payout, how much cash, when
 * it completed — chosen in the query itself, and the player is deliberately
 * not among them. Passing an order shape through here would mean assembling
 * one first, and the safest identity is the one never read.
 *
 * `cdm_receipt_url` is read only as IS NULL. A merchant learns THAT they still
 * owe a receipt; they never learn what a submitted one says. The slip becomes
 * unreadable to its own uploader the moment it is stored, and that is the
 * whole point of the feature.
 */
router.get('/cdm-receipts/outstanding', merchantAuth, async (req, res) => {
    try {
        const outstanding = await db.orders.merchantWithdrawalsMissingCdmReceipt(req.merchantId);
        res.json({ success: true, outstanding });
    } catch (err) {
        console.error('GET /merchant/cdm-receipts/outstanding error:', err);
        res.status(500).json({ success: false, message: 'Failed to list the receipts you still owe.' });
    }
});

router.get('/cash-links/current', merchantAuth, async (req, res) => {
    try {
        const denominationPaise = req.merchant?.cashDenominationPaise ?? null;
        if (denominationPaise === null) {
            return res.json({
                success: true, approved: false, denomination: null,
                live: null, waiting: 0, worthGoing: false,
                message: 'You are not approved for the ATM cash rail.',
            });
        }

        const [live, waiting, suppliers] = await Promise.all([
            db.cashLinks.getLiveLinkFor(req.merchantId),
            db.cashLinks.countOrdersAwaitingLink(denominationPaise),
            suppliersWithHeadroom(denominationPaise),
        ]);

        res.json({
            success: true,
            approved: true,
            denomination: denominationPaise / 100,
            denominationPaise,
            // Their own link only. Another merchant's link is another
            // merchant's business, and it is a claim on their notes.
            live: live && {
                linkId: live.linkId,
                paymentLink: live.paymentLink,
                expiresAt: live.expiresAt,
            },
            waiting,
            worthGoing: waiting > 0 && suppliers.includes(String(req.merchantId)),
        });
    } catch (err) {
        console.error('GET /merchant/cash-links/current error:', err);
        res.status(500).json({ success: false, message: 'Failed to read the cash link queue.' });
    }
});

/**
 * POST /api/merchant/cash-links — supply the link the ATM just produced.
 *
 * The merchant sends only the link. The amount comes from their approval and
 * the lifetime from the policy: a client that supplies its own denomination
 * can claim to be serving ₹10,000 orders from a ₹500 machine, and a client
 * that supplies its own expiry can keep a link alive as long as it likes.
 */
router.post('/cash-links', merchantAuth, cashLinkSupplyLimiter, async (req, res) => {
    try {
        const { paymentLink } = req.body || {};
        const result = await supplyCashLink({
            merchantId: req.merchantId,
            merchant: req.merchant,
            paymentLink,
        });
        if (!result.ok) {
            // Neither of these is the caller's mistake — they have a link
            // waiting, or they are already working an order — so both are a 409
            // the panel can render as state rather than as an error.
            const status = ['LINK_ALREADY_LIVE', 'ALREADY_SERVING'].includes(result.reason) ? 409 : 400;
            return res.status(status).json({ success: false, reason: result.reason, message: result.message });
        }

        // ── Hand it straight to somebody who is waiting ────────────────────
        // A link lives about two minutes, so the difference between matching
        // now and matching on the next sweep is a real slice of the window the
        // player has to reach the machine. The cron is still the guarantee —
        // this is the latency.
        //
        // AWAITED, not fired and forgotten. The merchant's next question is
        // "may I supply another?", and the answer depends on whether this link
        // has just been taken — so leaving the match in flight makes their own
        // next request race it. Deterministic beats marginally faster on a path
        // where the alternative is a merchant told two different things about
        // the same state.
        //
        // Still not fatal: the link IS supplied whatever happens here, and
        // telling a merchant their supply failed when it did not would send
        // them away from a machine they are standing at.
        try {
            await matchWaitingOrdersToLinks();
        } catch (e) {
            console.error('[cash-links] supply-time match failed:', e.message);
        }

        res.json({
            success: true,
            link: {
                linkId: result.link.linkId,
                paymentLink: result.link.paymentLink,
                expiresAt: result.link.expiresAt,
            },
        });
    } catch (err) {
        console.error('POST /merchant/cash-links error:', err);
        res.status(500).json({ success: false, message: 'Failed to supply the cash link.' });
    }
});

/**
 * DELETE /api/merchant/cash-links/:linkId — withdraw a link they can no longer
 * honour, so it is not handed to a player who would find nothing.
 *
 * Scoped to the caller. A merchant cancelling another merchant's link would be
 * removing supply that is not theirs.
 */
router.delete('/cash-links/:linkId', merchantAuth, async (req, res) => {
    try {
        const cancelled = await db.cashLinks.cancelLink(req.params.linkId, req.merchantId);
        if (!cancelled) {
            return res.status(404).json({
                success: false,
                message: 'No live link of yours with that id — it may have been taken or expired already.',
            });
        }
        res.json({ success: true, linkId: cancelled.linkId });
    } catch (err) {
        console.error('DELETE /merchant/cash-links/:linkId error:', err);
        res.status(500).json({ success: false, message: 'Failed to cancel the cash link.' });
    }
});

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
// USDT addresses; a USDT merchant may edit only those. Enforced here and not
// merely hidden in the panel, so a hand-crafted request cannot leave a merchant
// holding credentials for a rail they do not settle on. Only the admin
// (PUT /merchants/:id/capabilities) can change which rail a merchant is on.
//
// A USDT merchant holds an address PER CHAIN and may hold one, the other, or
// both — the chains are separate networks and an address on one cannot receive
// on the other. Holding both means orders on both chains are offered to them;
// holding neither means they are offered none, which is why clearing the last
// one is refused with a sentence rather than accepted silently.
router.put('/profile', merchantAuth, async (req, res) => {
    try {
        const { upiId, bankDetails, usdtAddressTrc20, usdtAddressBep20 } = req.body;
        const submittedAddresses = { TRC20: usdtAddressTrc20, BEP20: usdtAddressBep20 };

        const current = await db.merchants.getMerchant(req.merchantId);
        if (!current) return res.status(404).json({ success: false, message: 'Merchant profile not found.' });

        const isUsdt  = merchantTypeOf(current) === MERCHANT_CURRENCY.USDT;
        const railName = isUsdt ? 'USDT' : 'INR';
        const update  = {};

        const wantsInrFields  = upiId !== undefined || bankDetails !== undefined;
        const wantsUsdtFields = USDT_CHAINS.some((chain) => submittedAddresses[chain] !== undefined);

        if (isUsdt && wantsInrFields) {
            return res.status(400).json({ success: false, message: `This is a ${railName} merchant account — UPI, QR and bank details do not apply. Update the USDT wallet addresses instead.` });
        }
        if (!isUsdt && wantsUsdtFields) {
            return res.status(400).json({ success: false, message: `This is a ${railName} merchant account — a USDT wallet address does not apply. Update UPI/bank details instead.` });
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

        if (upiId !== undefined) {
            update['bankDetails.upiId'] = upiId;
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
 * they were trying to express already have owners: a merchant's CEILING is the
 * tokens they hold, enforced by the deposit escrow that reserves them the
 * moment an order becomes theirs (F-018), and the FLOOR is the platform's —
 * `SystemConfig.minDeposit` / `minWithdrawal`, 500 tokens, the same for
 * everyone.
 */
/**
 * What a merchant must send, in USDT, for `tokenAmount` platform tokens.
 *
 * ── Why this is a function and not two copies ──────────────────────────────
 * The merchant has to send the USDT BEFORE the request exists: the row refuses
 * an APPROVED purchase with no transaction hash on it
 * (`merchant_token_orders_approved_has_hash`), and the one-per-day unique index
 * means a request filed without a hash cannot be replaced with one that has it.
 * So the panel needs the figure in advance, which means a second reader of the
 * same arithmetic — and CLAUDE.md §5 is explicit about what happens to a value
 * assembled in two places. One function, two callers.
 *
 * Returns `{ ok: false, message }` rather than throwing, because both callers
 * answer a refusal the same way: tell the merchant, in the vocabulary of the
 * rail they are on (§25).
 */
function quoteAdminTokenPurchase(cfg, tokenAmount) {
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
        return { ok: false, status: 400, message: 'Token amount must be greater than zero.' };
    }
    // Through the one owner — see domains/configuration/tokenRates.js. The
    // `=== undefined ? 1` fallback this replaced was a second statement of the
    // default, in a different form from the schema's.
    const usdtRate = adminToMerchantUsdtRate(cfg);
    if (!Number.isFinite(usdtRate) || usdtRate < 0.01) {
        return { ok: false, status: 500, message: 'Admin USDT buy rate is misconfigured.' };
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
        return {
            ok: false, status: 400,
            message: `Admin token purchase must be at least ${minPurchaseUsdt} USDT${maxText}.`,
            usdtRate, usdtAmount, minPurchaseUsdt, maxPurchaseUsdt,
        };
    }
    return { ok: true, usdtRate, usdtAmount, minPurchaseUsdt, maxPurchaseUsdt };
}

/**
 * The quote, before the request exists. Read-only and writes nothing.
 *
 * A refusal comes back as 200 with `ok: false` and the reason, because this is
 * a merchant typing into a field: the bounds are what they need to see while
 * they are still choosing an amount, and an error status would have the panel
 * render a failure where the answer is "not that amount".
 */
router.get('/admin-token-orders/quote', merchantAuth, async (req, res) => {
    try {
        const cfg = await getSystemConfig();
        const tokenAmount = Number(req.query.tokenAmount);
        const quote = quoteAdminTokenPurchase(cfg, tokenAmount);
        res.json({ success: true, tokenAmount, quote });
    } catch (err) {
        console.error('GET /merchant/admin-token-orders/quote error:', err);
        res.status(500).json({ success: false, message: 'Failed to price an admin token purchase.' });
    }
});

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
        // The same quote the panel previewed through /admin-token-orders/quote,
        // from the same function. It is recomputed here rather than accepted
        // from the request: a price a caller supplies is a price a caller can
        // choose.
        const quote = quoteAdminTokenPurchase(cfg, tokenAmount);
        if (!quote.ok) return res.status(quote.status).json({ success: false, message: quote.message });
        const { usdtRate, usdtAmount } = quote;
        // ONE REQUEST PER DAY, decided by a unique index rather than by a
        // lookup for today's request followed by an insert. That check-then-act
        // shape is a rate limit that stops nobody who clicks twice: both
        // requests pass the check, both insert.
        // ── And the merchant's own payment reference ─────────────────────
        // A merchant buying platform tokens pays the platform in USDT and gives
        // the transaction hash. Recorded, and never claimed — so one payment
        // could fund two token purchases, which is the same defect as a reused
        // UTR pointed at the platform's own inventory.
        //
        // ── The hash is REQUIRED, and the row is why ─────────────────────
        // `merchant_token_orders_approved_has_hash` refuses an APPROVED
        // purchase that has a `usdt_amount` and no transaction on it, and every
        // purchase created here has one. So a request filed without a hash can
        // never be approved — and the approve path mints and credits BEFORE it
        // writes the status, so what actually happened was: the merchant is
        // paid, the CHECK rejects the status write, the handler 500s, and the
        // order sits PENDING with the tokens already delivered. The one-per-day
        // index then locks the merchant out of filing a corrected one.
        //
        // Accepting it optionally was the defect. A merchant sends the USDT
        // first (the panel prices it through /admin-token-orders/quote) and
        // names the transaction here, which is also the only thing that makes
        // the payment claimable: one payment, one purchase (§27).
        const tokenOrderId = `MAT_${randomBytes(12).toString('hex')}`;
        if (!usdtTxHash) {
            return res.status(400).json({
                success: false, code: 'REFERENCE_REQUIRED',
                message: MERCHANT_TOKEN_REFERENCE_SPEC.hint,
            });
        }
        try {
            await claimPaymentReference({
                reference: usdtTxHash, orderId: tokenOrderId,
                userId: req.merchantId, amountRupees: tokenAmount,
                spec: MERCHANT_TOKEN_REFERENCE_SPEC,
            });
        } catch (e) {
            return res.status(e.status || 400).json({
                success: false, code: e.code || 'INVALID_REFERENCE',
                message: e.message, originalOrderId: e.originalOrderId ?? null,
            });
        }

        const created = await db.paymentConfig.createTokenOrder({
            orderId: tokenOrderId,
            merchantId: req.merchantId,
            tokenAmountRupees: tokenAmount,
            usdtRate,
            usdtAmount,
            usdtTxHash,
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

        if (order.merchantId && order.merchantId.toString() !== req.merchantId.toString()) {
            return res.status(403).json({ success: false, message: 'This order is assigned to a different merchant.' });
        }
        if (!['PENDING_QUEUE', 'ASSIGNED'].includes(order.status)) {
            return res.status(400).json({ success: false, message: `Order cannot be accepted in status: ${order.status}` });
        }
        // ── A BUY is ASSIGNED, never CLAIMED ────────────────────────────────
        // There is no open pool for buy orders and there never was one: every
        // buy goes through `tryAssignMerchant`, which ranks the eligible
        // merchants and hands the order to one of them. This handler
        // nevertheless admitted a PENDING_QUEUE deposit, which made an
        // unassigned buy claimable first-come by anyone who knew its id — the
        // only surface on the buy side where two merchants could race for one
        // order.
        //
        // Nothing needs that. A merchant with capacity is offered work by the
        // queue; making them compete for it rewards whoever polls hardest, and
        // it defeats the ranking that exists so the biggest holder takes the
        // biggest order. The sell pool is different and stays: a withdrawal
        // nobody is free for waits in the open rather than burning retries, and
        // that is a deliberate choice recorded in `selectBestMerchant`.
        //
        // So a buy may only be accepted by the merchant it was ASSIGNED to.
        if (order.type === 'DEPOSIT' && order.status === 'PENDING_QUEUE') {
            return res.status(409).json({
                success: false,
                message: 'Buy orders are assigned automatically. This one has not been assigned to you.',
            });
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
        // The CHAIN, not just the rail. A merchant holding only a TRC-20
        // address cannot receive a BEP-20 payment: the networks are separate
        // and the tokens would be gone. The assignment query already excludes
        // them, but an order can also be claimed from the open pool, so it is
        // re-checked where the merchant actually takes it.
        if (merchantRail === MERCHANT_CURRENCY.USDT) {
            const chain = order.usdtChain;
            const spec = USDT_CHAIN_SPEC[chain];
            if (!spec) {
                return res.status(400).json({ success: false, message: 'This USDT order names no chain and cannot be served.' });
            }
            if (!usdtAddressFor(merchant, chain)) {
                return res.status(400).json({
                    success: false,
                    message: `This order pays on ${spec.label}. Add that address in Profile before taking it.`,
                });
            }
        }

        if (order.type === 'DEPOSIT') {
            // From the WALLET, not the merchant record. This gate admits an
            // order the merchant then has to fund; deciding it from a stored
            // copy is how one came to be accepted that could not be served.
            if (merchant.acceptsDeposits === false) {
                return res.status(400).json({ success: false, message: 'Merchant is not enabled for buy orders.' });
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
        // The count includes ASSIGNED orders, and THIS order — when it was
        // assigned to this merchant rather than taken from the open pool — is
        // one of them. Accepting it does not add to the merchant's plate, it
        // moves an order already on it from ASSIGNED to PROCESSING, so it must
        // not be counted against the ceiling for accepting it. Without this a
        // merchant at the default limit of 1 could be ASSIGNED an order and then
        // be refused when they tried to accept it — the one order they had was
        // the one blocking them.
        const alreadyMine = order.merchantId
            && String(order.merchantId) === String(req.merchantId)
            && ['ASSIGNED', 'PROCESSING', 'PAID'].includes(order.status);
        const effectiveActive = activeForType - (alreadyMine ? 1 : 0);
        if (effectiveActive >= typeLimit) {
            return res.status(400).json({ success: false, message: `Merchant has reached ${order.type} active order limit (${typeLimit}).` });
        }

        // ── The HOLD is the check, and it is taken LAST ─────────────────────
        // This was a balance read followed, in a later statement, by the accept
        // — a snapshot, so two merchants claiming from the open pool in the
        // same instant both passed it. Taking the hold IS asking the question:
        // its refusal lives in the reserve leg's own
        // `UPDATE … WHERE available_paise + $n >= 0` under the merchant's row
        // lock, so the second claimant is refused by the database.
        //
        // Placed after every cheaper refusal above so that none of them has a
        // hold to unwind — the only thing that can fail after this point is the
        // transition itself, and that has exactly one release, below.
        //
        // One call covers both doors. An order already ASSIGNED to this
        // merchant is already held by them and comes back `idempotent`, not
        // charged a second time; one claimed from the open pool takes its hold
        // here.
        let heldFresh = false;
        if (order.type === 'DEPOSIT') {
            const held = await holdDepositTokens(order, merchant.merchantId, {
                actor: `merchant:${req.merchantId}`,
            });
            if (!held.ok) {
                // 409 when somebody else took it, 400 when this merchant cannot
                // fund it. The distinction is not cosmetic: losing a race for an
                // order is a CONFLICT and the merchant should try the next one,
                // while an inventory shortfall is theirs to act on by topping
                // up. Collapsing both into 400 also silently changed what the
                // panel sees for the ordinary case of two merchants claiming
                // the same order at once, which is the common event here.
                const conflict = held.reason === 'held_by_another';
                return res.status(conflict ? 409 : 400).json({
                    success: false,
                    message: conflict
                        ? 'Another merchant is already serving this buy order.'
                        : 'Your available token balance cannot cover this buy order. Top up, or finish an order you are already serving.',
                });
            }
            // Only a hold TAKEN here may be released here. An order that was
            // already this merchant's arrives holding its tokens from
            // assignment, and releasing that on a lost accept race would strip
            // a live order of its funding.
            heldFresh = !held.idempotent;
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
                // The ORDER is passed so the snapshot carries a per-order
                // payment link. Without it the link is null and the player's
                // screen has nothing to render — the panel no longer builds one
                // from the merchant's handle, because it is no longer given it.
                merchantSnapshot: buildMerchantSnapshot(merchant, expiresAt, order),
                ...(responseMinutes === null ? {} : { merchantResponseMinutes: responseMinutes }),
            },
        });
        if ((!accepted.ok || accepted.idempotent) && heldFresh) {
            // The accept did not take, so the tokens this call held have nothing
            // to hold for. Released immediately rather than left to the sweep:
            // the next claimant wants them now, and the sweep exists for the
            // paths that forget, not as the ordinary way a hold ends.
            await releaseDepositHold(order, {
                actor: `merchant:${req.merchantId}`,
                reason: 'Accept did not take',
            });
        }
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
        const payAmount   = formatOrderFiat(order);

        if (isDeposit) {
            const payTo = isUsdtOrder
                ? `merchant USDT address on ${USDT_CHAIN_SPEC[order.usdtChain]?.label ?? 'the order chain'}: `
                  + `${usdtAddressFor(merchant, order.usdtChain) || 'See payment details'}`
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
        // it: the canonical `mw_dep_deduct_<orderId>` / `dep_complete_<orderId>`
        // keys, plus `completeOrder`'s own idempotency below.
        let deposited = null;
        if (isDeposit) {
            // ── The hold is CONSUMED here, before the wallet debit ──────────
            // The tokens were moved `available → reserved` when this order
            // became this merchant's. `moveDepositMoney` debits `available`,
            // so with the hold still standing the merchant is charged twice:
            // once by the hold they cannot spend and once by the debit. The
            // dispense (`reserved -a`) is what turns the hold INTO the payment.
            //
            // Before the debit and not after, for the §21 reason: if the debit
            // fails the order stays PAID and retryable with the tokens already
            // out of `reserved` and back in `available`, which is where the
            // retry needs them. The other order strands the retry against its
            // own hold.
            const dispensed = await dispenseDepositHold(order, { actor: `merchant:${req.merchantId}` });
            if (!dispensed.ok) {
                return res.status(409).json({
                    success: false,
                    message: 'This order\'s token hold could not be released for payment. Try again in a moment.',
                });
            }
            deposited = await moveDepositMoney(order, {
                debitMerchantTokens, creditDeposit, creditReserve, releaseUTR,
            });
            if (!deposited.ok) {
                // Reported to the operator and to the player by
                // `moveDepositMoney` itself (F-015). The order stays PAID, so it
                // is retryable AND still disputable.
                return res.status(400).json({ success: false, message: 'Insufficient token inventory to confirm this deposit. Top up your merchant wallet.' });
            }
        }

        let moved;
        if (isDeposit) {
            moved = await completeOrder(order._id, {
                expectFrom: 'PAID',
                set: { completedAt: new Date() },
            });
        } else if (holdFor > 0) {
            moved = await markOrderPaidState(order._id, {
                expectFrom: ['PROCESSING', 'ASSIGNED'],
                set: {
                    merchantCreditStatus:    'HELD',
                    merchantCreditHoldUntil: new Date(Date.now() + holdFor * 60 * 1000),
                    escrowLocked:            true,
                },
            });
        } else {
            moved = await completeOrder(order._id, {
                expectFrom: 'PROCESSING',
                set: {
                    completedAt: new Date(),
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
            return res.json({ success: true, message: 'Order already confirmed', order: toMerchantOrderView(moved.order ?? order) });
        }
        Object.assign(order, moved.order);

        // The deposit's money already moved, above, before the transition.
        if (!isDeposit) {
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
                // they cannot spend. Without this row the tokens simply do not
                // exist during the hold and nothing shows the liability;
                // opening the settlement here makes it visible and gives the
                // sweeper a real state machine to advance. Idempotent on the order's key, and
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

        // ── The hold comes off BEFORE anything tries to take a new one ──────
        // This merchant held the player's tokens from the moment the order was
        // theirs. They have declined, so the tokens are theirs again.
        //
        // The ordering is load-bearing, not tidiness: the reassignment further
        // down calls `tryAssignMerchant`, which takes a hold of its own, and
        // `merchant_settlements_one_live_deposit` permits exactly one live hold
        // per order. Release after reassignment and the new merchant's hold is
        // refused as `held_by_another` — the order would be reassigned with
        // nobody's tokens behind it, and the FIRST merchant's still locked.
        //
        // Looked up by ORDER, not by merchant, which is why it still works here:
        // `requeueOrder` has just set `merchantId` to null, and a release keyed
        // on the merchant would have had nothing to look with.
        if (order.type === 'DEPOSIT') {
            await releaseDepositHold(order, {
                actor: `merchant:${req.merchantId}`,
                reason: `Rejected by the merchant: ${reason}`,
            });
        }

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

        res.json({ success: true, message: 'Order has been red-flagged and escalated to admin.', order: toMerchantOrderView(order) });
    } catch (err) {
        console.error('POST /merchant/orders/:id/red-flag error:', err);
        res.status(500).json({ success: false, message: 'Failed to red-flag order.' });
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
// the `bulk_payout_completed` event go with it. `withdrawal_batch_ref` STAYS —
// that is the withdrawal SPLITTER's label (a payout too large for one
// denomination becomes several orders) and two admin screens read it. The two
// are unrelated despite both being called a batch.
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
// POST /api/merchant/orders/:id/reject
// Merchant rejects a PAID/PROCESSING order.
// Spec Section 11.2 / 13
// ─────────────────────────────────────────────────────────────────────────────
router.post('/orders/:id/reject', merchantAuth, async (req, res) => {
    try {
        const { id }   = req.params;
        const { reason, proofFileKey, proofCdnUrl } = req.body;

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

        const order = await db.orders.getOrderRecord(id);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        if (order.merchantId?.toString() !== req.merchantId?.toString()) {
            return res.status(403).json({ success: false, message: 'This order is not assigned to you' });
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

        // ── Transition order to CANCELLED (with rejection metadata) ───────────
        // The guard is the transition. Everything after this point — the
        // user's warning count and the payment flag — is a consequence of the
        // rejection, and a merchant retrying a failed request used to run all
        // of it a second time and increment the warning count again.
        const rejected = await cancelOrderState(order.orderId, {
            expectFrom: ['PAID', 'PROCESSING'],
            set: {
                rejectedBy:     req.merchantId,
                rejectedAt:     new Date(),
                rejectedReason: reason.trim(),
                rejectionProofUrl: verifiedProof.cdnUrl,
                cancelReason:   'MERCHANT_REJECTED',
                cancelledAt:    new Date(),
                // `updatedAt` was here and `setOrderFields` refuses it — the
                // column is maintained by the write itself, not by callers — so
                // this route threw on EVERY call and 500'd. No screen called it,
                // so nothing noticed that the endpoint had never once worked.
            },
        });
        if (!rejected.ok || rejected.idempotent) {
            return res.status(409).json({
                success: false,
                message: `Cannot reject order in ${rejected.status ?? 'unknown'} status`,
            });
        }
        Object.assign(order, rejected.order);

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



export default router;
