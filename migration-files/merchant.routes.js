// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import express   from 'express';
import { creditDeposit, refundOrder, creditWinnings, debitWinningsForWithdrawal } from '../services/walletAuthority.service.js';
import mongoose  from 'mongoose';
import bcrypt    from 'bcryptjs';
import jwt       from 'jsonwebtoken';
import { merchantAuth } from '../middleware/merchantAuth.js';
import { releaseUTR } from '../middleware/utrValidation.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from '../services/realtimeEmitters.js';
import { tryAssignMerchant, buildMerchantSnapshot, updateMerchantStatsOnComplete } from '../services/paymentProcessing.service.js';

const router     = express.Router();
const JWT_SECRET  = process.env.JWT_SECRET  || 'fallback-secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d'; // HIGH-05 fix: standardised to JWT_EXPIRES_IN

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const formatMerchant = (merchant, user = null) => ({
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
    bankDetails:          merchant.bankDetails,
    qrCodeUrl:            merchant.qrCodeUrl,
    limits:               merchant.limits,
    tokenBalance:         merchant.tokenBalance,
    earnings:             merchant.earnings,
    totalProcessedVolume: merchant.totalProcessedVolume,
    rating:               merchant.rating,
    createdAt:            merchant.createdAt,
});

// ─── AUTH: SIGNUP & LOGIN ─────────────────────────────────────────────────────


// ── Auto system message helper ────────────────────────────────────────────────
async function sendSystemMessage(orderId, message, io) {
    try {
        const ChatMessage = mongoose.model('ChatMessage');
        const chat = await ChatMessage.create({
            orderId, senderId: null, senderType: 'SYSTEM',
            senderName: 'System', message, isSystem: true, timestamp: new Date(),
        });
        if (io) {
            const oid = orderId.toString();
            const payload = { id: chat._id, orderId: oid, senderType: 'SYSTEM',
                senderName: 'System', message, isSystem: true, timestamp: chat.timestamp };
            io.to(`order_${oid}`).emit(`chat_${oid}`, payload);
        }
    } catch(e) { console.error('[SystemMsg]', e.message); }
}

router.post('/auth/signup', async (req, res) => {
    try {
        const { username, mobile, password, email, upiId, bankDetails } = req.body;
        if (!username || !mobile || !password) {
            return res.status(400).json({ success: false, message: 'username, mobile and password are required' });
        }

        const Merchant = mongoose.model('Merchant');
        const User     = mongoose.model('User');

        const existingUser = await User.findOne({ mobile });
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'Mobile number already registered' });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const user = await User.create({
            username,
            mobile,
            passwordHash,
            email:     email || undefined,
            status:    'ACTIVE',
            kycStatus: 'PENDING_SUBMISSION',
            isMerchant: true,
            roles:     ['merchant'],  // merchant accounts never get user panel access
        });

        // Merchant doc status = 'PENDING' (now valid per B1 schema fix)
        await Merchant.create({
            userId:       user._id,
            name:         username,
            username,
            mobile,
            email:        email || undefined,
            // FIX B1: Merchant.password must be set so merchantAuth middleware
            // can authenticate after admin approves. Without this, approved
            // merchants can never log in because Option A reads Merchant.password.
            password:     passwordHash,
            passwordHash: passwordHash,
            merchantApprovalStatus: 'PENDING',
            status:       'PENDING',
            isOnline:     false,
            tokenBalance: 0,
            upiId:        upiId     || undefined,
            bankDetails:  bankDetails ? {
                upiId:     upiId || undefined,
                bankName:  bankDetails.bankName  || undefined,
                accountNo: bankDetails.accountNo || undefined,
                ifsc:      bankDetails.ifsc       || undefined,
            } : undefined,
        });

        res.json({
            success:    true,
            message:    'Application submitted. An admin will review and approve your account.',
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

        // Query Merchant by mobile — with User-doc fallback for merchants
        // whose mobile was only stored on User (created before B6-c fix).
        const Merchant = mongoose.model('Merchant');
        const User = mongoose.model('User');
        let merchant = await Merchant.findOne({ mobile }).select('+password +passwordHash');
        if (!merchant) {
            // Fallback: find User by mobile, then get linked Merchant doc
            const user = await User.findOne({ mobile });
            if (user) {
                merchant = await Merchant.findOne({ userId: user._id }).select('+password +passwordHash');
                // Sync mobile onto Merchant doc so direct lookup works next time
                if (merchant && !merchant.mobile) {
                    merchant.mobile = mobile;
                    await merchant.save();
                }
            }
        }
        if (!merchant)
            return res.status(401).json({ success: false, message: 'No merchant account found for this mobile number' });

        const hash = merchant.password || merchant.passwordHash;
        if (!hash || !(await bcrypt.compare(password, hash)))
            return res.status(401).json({ success: false, message: 'Invalid credentials' });

        if (merchant.merchantApprovalStatus !== 'APPROVED' || merchant.status !== 'ACTIVE') {
            const msgs = { PENDING: 'Application pending approval.', REJECTED: 'Application rejected.',
                           SUSPENDED: 'Account suspended.' };
            return res.status(403).json({ success: false,
                message: msgs[merchant.status] || msgs[merchant.merchantApprovalStatus] || 'Account not active.' });
        }

        const token = jwt.sign(
            { merchantId: merchant._id, userId: merchant.userId, mobile: merchant.mobile, isMerchant: true, isAdmin: false },
            JWT_SECRET, { expiresIn: JWT_EXPIRES }
        );

        res.json({
            success: true, token,
            merchant: {
                _id: merchant._id, userId: merchant.userId,
                username: merchant.username, mobile: merchant.mobile, email: merchant.email,
                status: merchant.status, isOnline: merchant.isOnline,
                tokenBalance: merchant.tokenBalance || 0,
                acceptsDeposits: merchant.acceptsDeposits !== false,
                acceptsWithdrawals: merchant.acceptsWithdrawals !== false,
            },
        });
    } catch (error) {
        console.error('Merchant login error:', error);
        res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
    }
});

// ─── PROFILE ─────────────────────────────────────────────────────────────────

router.get('/profile', merchantAuth, async (req, res) => {
    try {
        const [merchant, rates] = await Promise.all([
            mongoose.model('Merchant').findById(req.merchantId).lean(),
            mongoose.model('TokenRates').findOne({ key: 'main' }).lean(),
        ]);
        if (!merchant) return res.status(404).json({ success: false, message: 'Merchant profile not found.' });
        const buyPrice  = rates?.buyRate  ?? 0;
        const sellPrice = rates?.sellRate ?? 0;
        res.json({
            success: true,
            merchant: {
                ...formatMerchant(merchant, req.user),
                prices: { buyPrice, sellPrice, profit: parseFloat((buyPrice - sellPrice).toFixed(4)) },
            },
        });
    } catch (err) {
        console.error('GET /merchant/profile error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
    }
});

// FIX B5-d: PUT /profile — update UPI/QR/bank details
router.put('/profile', merchantAuth, async (req, res) => {
    try {
        const { upiId, qrCodeUrl, bankDetails } = req.body;
        const update = {};

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

        const merchant = await mongoose.model('Merchant').findByIdAndUpdate(
            req.merchantId,
            { $set: update },
            { new: true }
        );

        res.json({ success: true, merchant: formatMerchant(merchant, req.user) });
    } catch (err) {
        console.error('PUT /merchant/profile error:', err);
        res.status(500).json({ success: false, message: 'Failed to update profile.' });
    }
});

router.put('/online-status', merchantAuth, async (req, res) => {
    try {
        const { isOnline } = req.body;
        if (typeof isOnline !== 'boolean') {
            return res.status(400).json({ success: false, message: 'isOnline must be a boolean.' });
        }
        const merchant = await mongoose.model('Merchant').findByIdAndUpdate(
            req.merchantId,
            { isOnline, lastOnlineToggle: new Date() },
            { new: true }
        );
        // Notify admin panel via SSE so merchant list shows green/red dot without refresh
        if (global.sseManager && merchant) {
            global.sseManager.broadcastToAdmins('merchant_status_changed', {
                merchantId: merchant._id,
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
        const merchant = await mongoose.model('Merchant').findByIdAndUpdate(req.merchantId, update, { new: true });
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
        const merchant = await mongoose.model('Merchant').findByIdAndUpdate(
            req.merchantId, { $set: update }, { new: true }
        );
        res.json({ success: true, merchant: formatMerchant(merchant, req.user) });
    } catch (err) {
        console.error('PUT /merchant/limits error:', err);
        res.status(500).json({ success: false, message: 'Failed to update limits.' });
    }
});
// ─── ORDERS ──────────────────────────────────────────────────────────────────

router.get('/orders', merchantAuth, async (req, res) => {
    try {
        const { status, type, limit = '50', skip = '0' } = req.query;
        const parsedLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
        const parsedSkip  = Math.max(parseInt(skip)  || 0, 0);

        const query = { merchantId: req.merchantId };
        if (status) query.status = status;
        if (type)   query.type   = type;

        const PaymentOrder = mongoose.model('PaymentOrder');
        const [orders, total] = await Promise.all([
            PaymentOrder.find(query).sort({ createdAt: -1 }).skip(parsedSkip).limit(parsedLimit).lean(),
            PaymentOrder.countDocuments(query),
        ]);

        res.json({ success: true, orders, pagination: { total, limit: parsedLimit, skip: parsedSkip } });
    } catch (err) {
        console.error('GET /merchant/orders error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch orders.' });
    }
});

router.post('/accept/:id', merchantAuth, async (req, res) => {
    try {
        const PaymentOrder = mongoose.model('PaymentOrder');
        const Merchant     = mongoose.model('Merchant');

        const order = await PaymentOrder.findById(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        if (order.merchantId && order.merchantId.toString() !== req.merchantId.toString()) {
            return res.status(403).json({ success: false, message: 'This order is assigned to a different merchant.' });
        }
        if (!['PENDING_QUEUE', 'ASSIGNED'].includes(order.status)) {
            return res.status(400).json({ success: false, message: `Order cannot be accepted in status: ${order.status}` });
        }

        const merchant = await Merchant.findById(req.merchantId);
        if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

        const now        = new Date();
        const expiresAt  = new Date(now.getTime() + 15 * 60 * 1000); // 15-min window starts on accept

        // Build full immutable merchantSnapshot (GOVERNANCE §1: assigned at accept)
        order.merchantId      = req.merchantId;
        order.status          = 'PROCESSING';
        order.processingAt    = now;
        order.expiresAt       = expiresAt;
        order.merchantSnapshot = {
            merchantId:    merchant._id,
            merchantName:  merchant.name || merchant.username || '',
            upiId:         merchant.bankDetails?.upiId             || '',
            qrCodeUrl:     merchant.qrCodeUrl                      || '',
            bankName:      merchant.bankDetails?.bankName           || '',
            accountNo:     merchant.bankDetails?.accountNo          || '',
            ifsc:          merchant.bankDetails?.ifsc               || '',
            accountHolder: merchant.bankDetails?.accountHolderName  || '',
            snapshotAt:    now,
            expiresAt,
        };

        // Update rolling avgResponseMinutes: EMA with α=0.2
        if (order.assignedAt) {
            const responseMinutes = (now - new Date(order.assignedAt)) / 60000;
            order.merchantResponseMinutes = responseMinutes;
            const oldAvg = merchant.avgResponseMinutes ?? 2; // schema default: 2
            const newAvg = (oldAvg * 0.8) + (responseMinutes * 0.2);
            await Merchant.findByIdAndUpdate(req.merchantId, { $set: { avgResponseMinutes: newAvg } });
        }

        await order.save();

        const io = global.io;
        const oid = order._id;
        const isDeposit = order.type === 'DEPOSIT';
        const kyc  = order.userKycSnapshot  || {};
        const bank = order.userBankDetails  || {};
        const kycLine = kyc.name ? `\n👤 User: ${kyc.name}  |  PAN: ${kyc.pan || 'N/A'}` : '';

        if (isDeposit) {
            await sendSystemMessage(oid,
                `✅ Order Accepted by Merchant\n` +
                `📋 Order: ${order.orderId}\n` +
                `💰 User must pay ₹${order.fiatAmount} to merchant UPI: ${merchant.bankDetails?.upiId || 'See payment details'}\n` +
                `⏱ Payment window: 15 minutes` +
                kycLine,
                io
            );
        } else {
            await sendSystemMessage(oid,
                `✅ Withdrawal Order Accepted\n` +
                `📋 Order: ${order.orderId}\n` +
                `💸 Merchant must send ₹${order.fiatAmount} to user's bank:\n` +
                `   🏦 ${bank.bankName || ''} | AC: ${bank.accountNumber || 'N/A'} | IFSC: ${bank.ifscCode || 'N/A'}\n` +
                `   Account Holder: ${bank.accountHolderName || kyc.name || 'N/A'}\n` +
                `   UPI ID: ${order.upiId || 'N/A'}` +
                kycLine,
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

        res.json({ success: true, order });
    } catch (err) {
        console.error('POST /merchant/accept/:id error:', err);
        res.status(500).json({ success: false, message: 'Failed to accept order.' });
    }
});

router.post('/confirm/:id', merchantAuth, async (req, res) => {
    try {
        const { proof, utrNumber } = req.body;
        const PaymentOrder = mongoose.model('PaymentOrder');
        const order = await PaymentOrder.findOne({ _id: req.params.id, merchantId: req.merchantId });
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

        if (proof)     order.proofScreenshot = proof;
        if (utrNumber) order.utrNumber       = utrNumber.trim();

        const { Merchant } = await import('../models/index.js').then(m => m).catch(() => ({}));
        const MerchantModel = Merchant || mongoose.model('Merchant');

        if (isDeposit) {
            // Step 1: attempt wallet credit BEFORE marking complete
            // GOVERNANCE §7: creditDeposit is wallet authority
            try {
                await creditDeposit(order.userId, order.tokenAmount, order._id.toString());
            } catch (walletErr) {
                console.error('[Merchant confirm] wallet credit failed — order NOT marked complete:', walletErr.message);
                return res.status(500).json({ success: false, message: 'Wallet credit failed. Please retry.' });
            }
            // Step 2: deduct merchant tokenBalance (Merchant gives tokens to user)
            await MerchantModel.findByIdAndUpdate(req.merchantId, { $inc: { tokenBalance: -order.tokenAmount } })
                .catch(e => console.error('[Merchant confirm] tokenBalance decrement failed:', e.message));

            order.status      = 'COMPLETED';
            order.completedAt = new Date();
        } else {
            // WITHDRAWAL confirm: merchant paid out fiat → auto-complete
            // GOVERNANCE §7: debitWinningsForWithdrawal is wallet authority
            // Note: tokens were already locked (escrowed) on order creation.
            // The escrow debit was already done by debitWinningsForWithdrawal at order creation.
            // No additional debit needed — winnings already moved to lockedBalance.
            // We just need to mark the order complete and clear the lock.
            // Merchant receives tokens (their balance increases)
            await MerchantModel.findByIdAndUpdate(req.merchantId, { $inc: { tokenBalance: order.tokenAmount } })
                .catch(e => console.error('[Merchant confirm] WITHDRAWAL tokenBalance increment failed:', e.message));

            order.status       = 'COMPLETED';
            order.completedAt  = new Date();
            order.escrowLocked = false;

            // Emit wallet update so user sees updated balance
            await emitWalletUpdate(order.userId);
        }

        await order.save();

        // Update merchant scoring stats
        await updateMerchantStatsOnComplete(req.merchantId, true).catch(() => {});

        // Notify merchant of updated score (GOVERNANCE §11: merchant_score_update)
        const freshMerchant = await MerchantModel.findById(req.merchantId).lean();
        if (freshMerchant) {
            emitMerchantUpdate(req.merchantId.toString(), 'merchant_score_update', {
                successRate: freshMerchant.successRate,
                avgResponse: freshMerchant.avgResponseMinutes,
            });
        }

        // Auto system message
        try {
            const io = global.io;
            const oid = order._id;
            if (isDeposit) {
                await sendSystemMessage(oid,
                    `✅ Payment Confirmed by Merchant\n` +
                    `📋 Token Purchase: ${order.tokenAmount} BB Tokens credited to your Deposit Balance\n` +
                    `💰 ₹${order.fiatAmount} received. Order COMPLETE.\n` +
                    `Your tokens are now available for betting!`,
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

        emitOrderUpdate(order.userId.toString(), 'order_completed', {
            orderId:   order.orderId,
            _id:       order._id,
            status:    'COMPLETED',
            server_ts: Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'COMPLETED', server_ts: Date.now() });

        res.json({ success: true, order });
    } catch (err) {
        console.error('POST /merchant/confirm/:id error:', err);
        res.status(500).json({ success: false, message: 'Failed to confirm payment.' });
    }
});

router.post('/reject/:id', merchantAuth, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ success: false, message: 'A rejection reason is required.' });

        const PaymentOrder = mongoose.model('PaymentOrder');
        const Merchant     = mongoose.model('Merchant');

        const order = await PaymentOrder.findOne({ _id: req.params.id, merchantId: req.merchantId });
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        // Only allowed if ASSIGNED (before user has paid) -- per spec Section 2C
        if (order.status !== 'ASSIGNED') {
            return res.status(400).json({ success: false, message: `Order can only be rejected in ASSIGNED status. Current: ${order.status}` });
        }

        // Decrement merchant activeOrderCount
        await Merchant.findByIdAndUpdate(req.merchantId, {
            $inc: { totalOrdersAll: 1, activeOrderCount: -1 },
        });

        // Release escrow if WITHDRAWAL
        if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
            try {
                await refundOrder(order.userId, order.tokenAmount, order._id.toString(), 'winningsBalance');
                order.escrowLocked = false;
            } catch (refundErr) {
                console.error('[merchant reject] winnings refund failed:', refundErr.message);
            }
        }

        // Try re-assignment to next-best merchant
        order.merchantId       = null;
        order.merchantSnapshot = null;
        order.expiresAt        = null;
        order.status           = 'PENDING_QUEUE';

        const reAssigned = await tryAssignMerchant(order);
        if (reAssigned) {
            await order.save();
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
            res.json({ success: true, message: 'Order rejected and re-assigned to another merchant.', order });
        } else {
            order.rejectedReason = reason;
            await order.save();
            emitOrderUpdate(order.userId.toString(), 'order_update', {
                orderId:   order.orderId,
                _id:       order._id,
                status:    'PENDING_QUEUE',
                message:   'Merchant rejected. Looking for another merchant…',
                server_ts: Date.now(),
            });
            emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'PENDING_QUEUE', server_ts: Date.now() });
            res.json({ success: true, message: 'Order rejected. Searching for next available merchant.', order });
        }

        try {
            const ChatMessage = mongoose.model('ChatMessage');
            await ChatMessage.create({
                orderId: order._id, senderId: req.merchantId, senderType: 'SYSTEM',
                message:
                    `❌ ORDER REJECTED BY MERCHANT\n` +
                    `Reason: ${reason}\n` +
                    (reAssigned
                        ? `✅ A new merchant has been assigned to your order.`
                        : `⏳ We are searching for another merchant.`),
                isSystem: true,
            });
        } catch (_) {}
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

        const PaymentOrder = mongoose.model('PaymentOrder');
        const order = await PaymentOrder.findOne({ _id: req.params.id, merchantId: req.merchantId });
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        if (!['PROCESSING', 'ASSIGNED'].includes(order.status)) {
            return res.status(400).json({ success: false, message: `Cannot raise dispute in ${order.status} status.` });
        }

        order.status          = 'DISPUTED';
        order.disputeReason   = reason.trim();
        order.disputeRaisedAt = new Date();
        order.disputeRaisedBy = 'merchant';
        order.updatedAt       = new Date();
        await order.save();

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

        res.json({ success: true, message: 'Dispute raised. Admin will review.', order });
    } catch (err) {
        console.error('POST /merchant/order/:id/dispute error:', err);
        res.status(500).json({ success: false, message: 'Failed to raise dispute.' });
    }
});



//


//

router.get('/chat/:id', merchantAuth, async (req, res) => {
    try {
        const PaymentOrder    = mongoose.model('PaymentOrder');
        const ChatMessage = mongoose.model('ChatMessage');

        // Allow lookup by MongoDB _id or by orderId string
        const order = await PaymentOrder.findOne({
            $or: [
                { _id: (req.params.id && /^[a-f\d]{24}$/i.test(req.params.id) ? req.params.id : null) },
                { orderId: req.params.id },
                { merchantId: req.merchantId, _id: req.params.id }
            ]
        });
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        // Verify merchant owns this order
        if (order.merchantId?.toString() !== req.merchantId.toString()) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        const messages = await ChatMessage.find({ orderId: order._id })
            .populate('senderId', 'username mobile')
            .sort({ timestamp: 1 })
            .limit(200)
            .lean();

        res.json({
            success: true,
            messages: messages.map(m => ({
                id:            m._id.toString(),
                orderId:       order.orderId || order._id.toString(),
                senderId:      m.senderId?._id?.toString() || m.senderId?.toString() || '',
                senderName:    m.senderId?.username || m.senderId?.mobile || (m.senderType === 'MERCHANT' ? 'Merchant' : m.senderType === 'SYSTEM' ? 'System' : 'User'),
                senderType:    m.senderType,
                text:          m.message,
                message:       m.message,
                attachmentUrl: m.attachmentUrl || null,
                isSystem:      m.isSystem || false,
                timestamp:     m.timestamp,
            })),
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

        const PaymentOrder    = mongoose.model('PaymentOrder');
        const ChatMessage = mongoose.model('ChatMessage');

        const order = await PaymentOrder.findOne({
            $or: [
                { _id: (req.params.id && /^[a-f\d]{24}$/i.test(req.params.id) ? req.params.id : null) },
                { orderId: req.params.id },
                { merchantId: req.merchantId, _id: req.params.id }
            ]
        });
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        if (order.merchantId?.toString() !== req.merchantId.toString()) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        const chat = await ChatMessage.create({
            orderId:       order._id,
            senderId:      req.userId,
            senderType:    'MERCHANT',
            message:       text.trim(),
            attachmentUrl: attachmentUrl || undefined,
            isSystem:      false,
            timestamp:     new Date(),
        });

        
        const merchantName = req.merchant?.username || req.merchant?.mobile || 'Merchant';
        const chatPayload = {
            id:            chat._id.toString(),
            orderId:       order.orderId || order._id.toString(),
            senderId:      req.userId?.toString() || '',
            senderName:    merchantName,
            senderType:    'MERCHANT',
            text:          chat.message,
            message:       chat.message,
            attachmentUrl: chat.attachmentUrl || null,
            isSystem:      false,
            timestamp:     chat.timestamp,
        };

        
        try {
            const io = global.io;
            if (io) {
                const oid = order.orderId || order._id.toString();
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

        const PaymentOrder = mongoose.model('PaymentOrder');
        const order = await PaymentOrder.findOne({ _id: req.params.id, merchantId: req.merchantId });
        if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

        if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
            return res.status(400).json({ success: false, message: 'Cannot red-flag a completed or cancelled order.' });
        }

        order.redFlagged   = true;
        order.redFlagReason = reason.trim();
        order.redFlaggedBy = req.userId;
        order.redFlaggedAt = new Date();
        // Automatically move to DISPUTED so admin queue picks it up
        order.status       = 'DISPUTED';
        order.disputeReason = `Red-flagged by merchant: ${reason.trim()}`;
        await order.save();

        
        try {
            const ChatMessage = mongoose.model('ChatMessage');
            await ChatMessage.create({
                orderId:    order._id,
                senderId:   req.userId,
                senderType: 'SYSTEM',
                message:    `⚠️ Order flagged by merchant: ${reason.trim()}. Admin has been notified.`,
                isSystem:   true,
                timestamp:  new Date(),
            });
        } catch (_) {}

        // Notify admins via SSE
        if (global.sseManager) {
            global.sseManager.broadcastToAdmins('order_red_flagged', {
                orderId:       order._id,
                orderStringId: order.orderId,
                reason:        reason.trim(),
                merchantId:    req.merchantId,
                flaggedAt:     order.redFlaggedAt,
                type:          order.type,
                fiatAmount:    order.fiatAmount,
            });
        }

        res.json({ success: true, message: 'Order has been red-flagged and escalated to admin.', order });
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
router.get('/bulk-payouts', merchantAuth, async (req, res) => {
    try {
        const { date } = req.query;
        const PaymentOrder = mongoose.model('PaymentOrder');

        // Default to today IST
        let targetDate;
        if (date) {
            targetDate = new Date(date);
        } else {
            const istOffset = 5.5 * 60 * 60 * 1000;
            const istNow    = new Date(Date.now() + istOffset);
            targetDate = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
        }
        const nextDay = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);

        const orders = await PaymentOrder.find({
            merchantId:    req.merchantId,
            type:          'WITHDRAWAL',
            status:        { $in: ['PAID', 'COMPLETED', 'ASSIGNED', 'PROCESSING'] },
            bulkPayoutDate: { $gte: targetDate, $lt: nextDay },
        }).sort({ createdAt: 1 }).lean();

        const totalFiat   = orders.reduce((s, o) => s + (o.fiatAmount || 0), 0);
        const totalTokens = orders.reduce((s, o) => s + (o.tokenAmount || 0), 0);

        res.json({
            success: true,
            date:    targetDate.toISOString().split('T')[0],
            orders,
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
router.get('/bulk-payouts/export', merchantAuth, async (req, res) => {
    try {
        const { date } = req.query;
        const PaymentOrder = mongoose.model('PaymentOrder');

        let targetDate;
        if (date) {
            targetDate = new Date(date);
        } else {
            const istOffset = 5.5 * 60 * 60 * 1000;
            const istNow    = new Date(Date.now() + istOffset);
            targetDate = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
        }
        const nextDay = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);

        const orders = await PaymentOrder.find({
            merchantId:    req.merchantId,
            type:          'WITHDRAWAL',
            status:        { $in: ['PAID', 'COMPLETED', 'ASSIGNED', 'PROCESSING'] },
            bulkPayoutDate: { $gte: targetDate, $lt: nextDay },
        }).sort({ createdAt: 1 }).lean();

        // Format rows for bank CSV upload
        // Standard Indian bank bulk transfer format
        const rows = orders.map((o, idx) => ({
            sNo:                idx + 1,
            orderId:            o.orderId,
            beneficiaryName:    o.userBankDetails?.accountHolderName || o.userKycSnapshot?.name || '',
            accountNumber:      o.userBankDetails?.accountNumber || '',
            ifscCode:           o.userBankDetails?.ifscCode || '',
            bankName:           o.userBankDetails?.bankName || '',
            amount:             o.fiatAmount || 0,
            tokenAmount:        o.tokenAmount || 0,
            panNumber:          o.userKycSnapshot?.pan || '',
            userMobile:         o.userPhone || '',
            remark:             `BB Token Sale ${o.orderId}`,
            status:             o.status,
            createdAt:          o.createdAt,
            bulkPayoutDate:     o.bulkPayoutDate,
            bulkPaidAt:         o.bulkPaidAt || null,
        }));

        const dateStr  = targetDate.toISOString().split('T')[0];
        const totalAmt = orders.reduce((s, o) => s + (o.fiatAmount || 0), 0);

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
router.post('/bulk-payouts/mark-paid', merchantAuth, async (req, res) => {
    try {
        const { orderIds, batchRef } = req.body;
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({ success: false, message: 'orderIds array is required.' });
        }

        const PaymentOrder  = mongoose.model('PaymentOrder');
        const paidAt    = new Date();
        const batchId   = batchRef || `BATCH_${Date.now()}`;

        const result = await PaymentOrder.updateMany(
            {
                _id:        { $in: orderIds },
                merchantId: req.merchantId,
                type:       'WITHDRAWAL',
                status:     { $in: ['PAID', 'ASSIGNED', 'PROCESSING'] },
            },
            {
                $set: {
                    status:        'COMPLETED',
                    bulkPaidAt:    paidAt,
                    bulkPayoutBatch: batchId,
                    completedAt:   paidAt,
                },
            }
        );

        // Notify admins
        if (global.sseManager) {
            global.sseManager.broadcastToAdmins('bulk_payout_completed', {
                merchantId: req.merchantId,
                batchId,
                count:      result.modifiedCount,
                paidAt,
            });
        }

        res.json({
            success:  true,
            message:  `${result.modifiedCount} orders marked as paid.`,
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
        const PaymentOrder  = mongoose.model('PaymentOrder');
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const baseMatch  = { merchantId: req.merchantId, status: { $in: ['PAID', 'COMPLETED'] } };
        const rangeMatch = { ...baseMatch };
        if (startDate || endDate) {
            rangeMatch.createdAt = {};
            if (startDate) rangeMatch.createdAt.$gte = new Date(startDate);
            if (endDate)   rangeMatch.createdAt.$lte = new Date(endDate);
        }

        const [todayStats, lifetimeStats] = await Promise.all([
            PaymentOrder.aggregate([
                { $match: { ...baseMatch, createdAt: { $gte: todayStart } } },
                { $group: { _id: '$type', totalFees: { $sum: '$merchantProfit' }, totalAmount: { $sum: '$fiatAmount' }, count: { $sum: 1 } } },
            ]),
            PaymentOrder.aggregate([
                { $match: rangeMatch },
                { $group: { _id: null, totalEarnings: { $sum: '$merchantProfit' }, totalVolume: { $sum: '$fiatAmount' }, totalOrders: { $sum: 1 } } },
            ]),
        ]);

        const todayDeposits    = todayStats.find(s => s._id === 'DEPOSIT')    || { totalFees: 0, totalAmount: 0, count: 0 };
        const todayWithdrawals = todayStats.find(s => s._id === 'WITHDRAWAL') || { totalFees: 0, totalAmount: 0, count: 0 };
        const lifetime         = lifetimeStats[0]                              || { totalEarnings: 0, totalVolume: 0, totalOrders: 0 };

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
        const PaymentOrder = mongoose.model('PaymentOrder');

        // Build last 7 days in IST
        const istOffset = 5.5 * 60 * 60 * 1000;
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const dayStart = new Date(Date.now() + istOffset - i * 86400000);
            dayStart.setUTCHours(0, 0, 0, 0);
            const dayEnd = new Date(dayStart.getTime() + 86400000);
            days.push({ label: dayStart.toISOString().split('T')[0], start: dayStart, end: dayEnd });
        }

        const agg = await PaymentOrder.aggregate([
            {
                $match: {
                    merchantId: req.merchantId,
                    status:     { $in: ['PAID', 'COMPLETED'] },
                    createdAt:  { $gte: days[0].start, $lt: days[days.length - 1].end },
                },
            },
            {
                $group: {
                    _id: {
                        $dateToString: {
                            format:   '%Y-%m-%d',
                            date:     '$createdAt',
                            timezone: '+05:30',
                        },
                    },
                    earnings: { $sum: '$merchantProfit' },
                    orders:   { $sum: 1 },
                },
            },
        ]);

        const byDate = Object.fromEntries(agg.map(r => [r._id, { earnings: r.earnings, orders: r.orders }]));

        const result = days.map(d => ({
            date:     d.label,
            earnings: byDate[d.label]?.earnings || 0,
            orders:   byDate[d.label]?.orders   || 0,
        }));

        res.json({ success: true, weekly: result });
    } catch (err) {
        console.error('GET /merchant/earnings/weekly error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch weekly earnings.' });
    }
});

router.get('/stats', merchantAuth, async (req, res) => {
    try {
        const PaymentOrder   = mongoose.model('PaymentOrder');
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const [pending, processing, completedToday, paidPendingReview] = await Promise.all([
            PaymentOrder.countDocuments({ merchantId: req.merchantId, status: 'PENDING_QUEUE' }),
            PaymentOrder.countDocuments({ merchantId: req.merchantId, status: 'PROCESSING'   }),
            PaymentOrder.countDocuments({ merchantId: req.merchantId, status: { $in: ['PAID', 'COMPLETED'] }, createdAt: { $gte: todayStart } }),
            // Count PAID orders awaiting merchant review (Section 17.2)
            PaymentOrder.countDocuments({ merchantId: req.merchantId, status: 'PAID' }),
        ]);

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
        const PaymentOrder    = mongoose.model('PaymentOrder');
        const User        = mongoose.model('User');
        const Merchant    = mongoose.model('Merchant');
        const WalletLedger = mongoose.model('WalletLedger');
        const Transaction  = mongoose.model('Transaction');
        const { id }      = req.params;

        // ── Idempotency: atomic status guard — only PAID orders can be approved ──
        // findOneAndUpdate with { status: 'PAID' } filter: concurrent approvals
        // both execute, but only the first returns non-null. Second → 409.
        const order = await PaymentOrder.findOneAndUpdate(
            { _id: id, status: 'PAID' },
            { $set: { status: 'COMPLETED', approvedBy: req.merchantId, approvedAt: new Date(), updatedAt: new Date() } },
            { ...withSession(session), new: true }
        );
        if (!order) {
            await abortOrEnd(session);
            // Either order not found, not PAID, or already approved (concurrent)
            const existing = await PaymentOrder.findById(id).lean();
            if (!existing) return res.status(404).json({ success: false, message: 'Order not found' });
            if (existing.status === 'COMPLETED') return res.status(409).json({ success: false, message: 'Order already approved' });
            return res.status(400).json({ success: false, message: `Cannot approve order in ${existing.status} status` });
        }

        // Ownership check — merchant can only approve their own orders
        if (order.merchantId?.toString() !== req.merchantId?.toString()) {
            await abortOrEnd(session);
            return res.status(403).json({ success: false, message: 'This order is not assigned to you' });
        }

        // ── Finding 5: Merchant inventory validation ───────────────────────────
        // ── Finding 4: Atomic inventory deduction with $gte guard ──────────────
        const updatedMerchant = await Merchant.findOneAndUpdate(
            { _id: req.merchantId, tokenBalance: { $gte: order.tokenAmount } },
            { $inc: { tokenBalance: -order.tokenAmount } },
            { ...withSession(session), new: true }
        );
        if (!updatedMerchant) {
            // Rollback status change
            await PaymentOrder.findByIdAndUpdate(id, { $set: { status: 'PAID', approvedBy: null, approvedAt: null } }, withSession(session));
            await abortOrEnd(session);
            return res.status(400).json({
                success: false,
                message: 'Merchant has insufficient token inventory to approve this order',
            });
        }

        // ── Token allocation: 90% depositBalance, 10% reserveBalance (Section 4) ─
        const depositCredit = Math.floor(order.tokenAmount * 0.90);
        const reserveCredit = Math.floor(order.tokenAmount * 0.10);
        // Spec 4.4: remainder (0 or 1 token) goes to depositBalance, never reserveBalance
        const remainder     = order.tokenAmount - depositCredit - reserveCredit;

        // ── Finding 4: Single atomic balance credit ────────────────────────────
        const updatedUser = await User.findOneAndUpdate(
            { _id: order.userId },
            {
                $inc: {
                    depositBalance: depositCredit + remainder,
                    reserveBalance: reserveCredit,
                },
            },
            { ...withSession(session), new: true }
        );

        // ── Ledger entries (Section 4.3) ───────────────────────────────────────
        const now = new Date();
        await WalletLedger.insertMany([
            {
                userId:        order.userId,
                type:          'CREDIT',
                field:         'depositBalance',
                amount:        depositCredit + remainder,
                balanceBefore: (updatedUser.depositBalance  || 0) - (depositCredit + remainder),
                balanceAfter:  updatedUser.depositBalance   || 0,
                reason:        'TOKEN_PURCHASE deposit allocation',
                refModel:      'PaymentOrder',
                refId:         order._id,
                txId:          `approve_dep_${order._id}`,
            },
            {
                userId:        order.userId,
                type:          'CREDIT',
                field:         'reserveBalance',
                amount:        reserveCredit,
                balanceBefore: (updatedUser.reserveBalance || 0) - reserveCredit,
                balanceAfter:  updatedUser.reserveBalance  || 0,
                reason:        'TOKEN_PURCHASE reserve allocation',
                refModel:      'PaymentOrder',
                refId:         order._id,
                txId:          `approve_res_${order._id}`,
            },
        ], { ...withSession(session), ordered: false });

        // Transaction record
        await Transaction.create([{
            userId:      order.userId,
            type:        'TOKEN_PURCHASE',
            amount:      order.tokenAmount,
            balanceType: 'DEPOSIT',
            status:      'SUCCESS',
            referenceId: order._id.toString(),
            description: `Token purchase approved: ${order.tokenAmount} tokens (${depositCredit + remainder} deposit + ${reserveCredit} reserve)`,
            timestamp:   now,
        }], withSession(session));

        // ── Mark UTR as RELEASED ───────────────────────────────────────────────
        await releaseUTR(order._id);

        await commitOrEnd(session);

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
            creditedDeposit:  depositCredit + remainder,
            creditedReserve:  reserveCredit,
            order,
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
        const PaymentOrder = mongoose.model('PaymentOrder');
        const User     = mongoose.model('User');
        const { id }   = req.params;
        const { reason } = req.body;

        const order = await PaymentOrder.findById(id);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        if (order.merchantId?.toString() !== req.merchantId?.toString()) {
            return res.status(403).json({ success: false, message: 'This order is not assigned to you' });
        }

        if (!['PAID', 'PROCESSING'].includes(order.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot reject order in ${order.status} status`,
            });
        }

        // ── Transition order to CANCELLED (with rejection metadata) ───────────
        order.status       = 'CANCELLED';
        order.rejectedBy   = req.merchantId;
        order.rejectedAt   = new Date();
        order.rejectedReason = reason || 'Rejected by merchant';
        order.cancelReason = 'MERCHANT_REJECTED';
        order.cancelledAt  = new Date();
        order.updatedAt    = new Date();
        await order.save();

        // ── Warning engine (Section 13.2) ──────────────────────────────────────
        const WARNING_THRESHOLD = 3;
        const updatedUser = await User.findOneAndUpdate(
            { _id: order.userId },
            { $inc: { warningCount: 1 } },
            { new: true }
        );

        const newCount = updatedUser?.warningCount || 0;

        // Auto-block at threshold
        if (newCount >= WARNING_THRESHOLD && !updatedUser.isBlocked) {
            await User.findByIdAndUpdate(order.userId, {
                $set: {
                    isBlocked:   true,
                    blockReason: 'Automatic block: 3 payment warnings.',
                    blockedAt:   new Date(),
                },
            });
        }

        // ── SSE: notify user (Finding 3) ──────────────────────────────────────
        emitOrderUpdate(order.userId.toString(), 'order_rejected', {
            orderId:      order.orderId,
            _id:          order._id,
            reason:       order.rejectedReason,
            warningCount: newCount,
            isBlocked:    newCount >= WARNING_THRESHOLD,
            server_ts:    Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'CANCELLED', server_ts: Date.now() });

        res.json({
            success: true,
            message: 'Order rejected.',
            warningCount: newCount,
            autoBlocked:  newCount >= WARNING_THRESHOLD,
        });
    } catch (error) {
        console.error('POST /merchant/orders/:id/reject error:', error);
        res.status(500).json({ success: false, message: 'Failed to reject order' });
    }
});

// safeSession helper for approve route (MongoDB transaction support)
async function safeSession() {
    try {
        const session = await mongoose.startSession();
        try { session.startTransaction(); return session; }
        catch (txErr) { await session.endSession().catch(() => {}); throw txErr; }
    } catch {
        console.warn('[merchant] MongoDB standalone – running without transaction session.');
        return null;
    }
}
async function commitOrEnd(s) { if (!s) return; try { await s.commitTransaction(); } finally { s.endSession(); } }
async function abortOrEnd(s)  { if (!s) return; try { await s.abortTransaction();  } finally { s.endSession(); } }
function withSession(s) { return s ? { session: s } : {}; }

export default router;
