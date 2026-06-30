// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** system.admin.routes.js — System config, token rates, withdrawal requests, error logs */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from './_adminShared.js';

const router = express.Router();

router.get('/transactions', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { Transaction } = getModels();
    const { type, status, page = 1, limit = 50 } = req.query;
    
    const filter = {};
    if (type && type !== 'all') filter.type = type;
    if (status && status !== 'all') filter.status = status;

    const transactions = await Transaction.find(filter)
      .populate('userId', 'username mobile')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Transaction.countDocuments(filter);

    res.json({
      success: true,
      transactions,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
});

// Get merchants — source of truth is the Merchant collection.
// _id in every response is Merchant._id. No User._id is ever used as a merchant identifier.
router.get('/token-rates', authenticate, isAdmin, async (req, res) => {
  try {
    const TokenRates = mongoose.model('TokenRates');
    const rates = await TokenRates.findOne({ key: 'main' });

    // Return null data if admin has never set rates — do NOT auto-create with fake values
    if (!rates) {
      return res.json({
        success: true,
        data: null,
        message: 'No rates configured yet. Use PUT /admin/token-rates to set them.'
      });
    }

    // MED-06 FIX: normalized to {rates:{}} shape (was {data:{}} — mismatched PUT response shape)
    res.json({
      success: true,
      rates: {
        buyRate:                rates.buyRate,
        sellRate:               rates.sellRate,
        merchantProfitPerToken: rates.buyRate - rates.sellRate,
        updatedAt:              rates.updatedAt
      }
    });
  } catch (error) {
    console.error('Get rates error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch rates' });
  }
});

// Update token rates
router.put('/token-rates', authenticate, isAdmin, async (req, res) => {
  try {
    const { buyRate, sellRate } = req.body;
    const TokenRates = mongoose.model('TokenRates');
    const EnhancedAuditLog = mongoose.model('EnhancedAuditLog');
    
    if (!buyRate || !sellRate || buyRate <= 0 || sellRate <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Buy and sell rates must be positive numbers'
      });
    }
    
    if (buyRate <= sellRate) {
      return res.status(400).json({
        success: false,
        message: 'Buy rate must be higher than sell rate (merchant profit)'
      });
    }
    
    const oldRates = await TokenRates.findOne({ key: 'main' });
    
    const rates = await TokenRates.findOneAndUpdate(
      { key: 'main' },
      {
        buyRate: parseFloat(buyRate),
        sellRate: parseFloat(sellRate),
        updatedAt: new Date(),
        updatedBy: req.user._id
      },
      { new: true, upsert: true }
    );
    
    await EnhancedAuditLog.create({
      performedBy: req.user._id,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'UPDATE_TOKEN_RATES',
      category: 'FINANCIAL',
      details: {
        oldBuyRate: oldRates?.buyRate,
        newBuyRate: buyRate,
        oldSellRate: oldRates?.sellRate,
        newSellRate: sellRate,
        merchantProfit: buyRate - sellRate
      },
      success: true
    });
    
    console.log(`✅ Token rates updated: Buy ₹${buyRate}, Sell ₹${sellRate}`);
    
    res.json({
      success: true,
      message: 'Token rates updated successfully',
      rates: {
        buyRate: rates.buyRate,
        sellRate: rates.sellRate,
        merchantProfitPerToken: rates.buyRate - rates.sellRate
      }
    });
  } catch (error) {
    console.error('Update rates error:', error);
    res.status(500).json({ success: false, message: 'Failed to update rates' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ✅ FIX #8: MERCHANT MANAGEMENT ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

// Get merchant full profile — :merchantId is always Merchant._id.
// The merchants list guarantees this. No User._id fallback.
router.get('/system/config', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const TokenRates   = mongoose.model('TokenRates');
    // Read from the actual SystemConfig schema fields (betLimits, maintenanceMode, etc.)
    // NOT from config.value which does not exist in the schema.
    const config = await SystemConfig.findOne({ key: 'main' }).lean() || {};
    const rates  = await TokenRates.findOne({ key: 'main' }).lean() || {};
    res.json({
      success: true,
      config: {
        // Bet limits — stored under betLimits in schema, NOT config.value
        minBet:                config.betLimits?.thirtyMin?.min   || 10,
        maxBet:                config.betLimits?.thirtyMin?.max   || 100000,
        max30MinBet:           config.betLimits?.thirtyMin?.max   || 100000,
        maxFullDayBet:         config.betLimits?.fullDay?.max     || 500000,
        // Deposit/withdrawal limits — stored as top-level fields on SystemConfig
        minDeposit:            config.minDeposit            || 100,
        maxDeposit:            config.maxDeposit            || 50000,
        minWithdrawal:         config.minWithdrawal         || 500,
        maxWithdrawal:         config.maxWithdrawal         || 50000,
        maxWinningsWithdrawal: config.maxWinningsWithdrawal || 500000,
        // Token rates — stored in TokenRates collection
        tokenBuyRate:          rates.buyRate                ?? 1,
        tokenSellRate:         rates.sellRate               ?? 1,
        kycRequired:           config.kycRequired           !== false,
        registrationEnabled:   config.registrationEnabled   !== false,
        maintenanceMode:       config.maintenanceMode       || false,
        maintenanceMessage:    config.maintenanceMessage    || '',
        depositMethods:        config.depositMethods        || ['UPI', 'BANK_TRANSFER'],
        withdrawalMethods:     config.withdrawalMethods     || ['UPI', 'BANK_TRANSFER'],
        // App distribution — admin sets these, ShareModal + SystemGuard read them
        webUrl:        config.webUrl        || '',
        androidUrl:    config.androidUrl    || '',
        iosUrl:        config.iosUrl        || '',
        minVersion:    config.minVersion    || '1.0.0',
        latestVersion: config.latestVersion || '1.0.0',
      }
    });
  } catch (error) {
    console.error('Get system config error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch system config' });
  }
});

router.put('/system/config', authenticate, isAdmin, async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const TokenRates   = mongoose.model('TokenRates');

    // Map admin panel field names → actual SystemConfig schema paths (betLimits, top-level fields)
    // and TokenRates (buyRate, sellRate stored in separate collection).
    const {
      minBet, maxBet, max30MinBet, maxFullDayBet,
      minDeposit, maxDeposit, minWithdrawal, maxWithdrawal, maxWinningsWithdrawal,
      tokenBuyRate, tokenSellRate,
      kycRequired, registrationEnabled,
      maintenanceMode, maintenanceMessage,
      depositMethods, withdrawalMethods,
      webUrl, androidUrl, iosUrl, minVersion, latestVersion,
    } = req.body;

    // Build SystemConfig $set using real schema paths
    const scSet = { updatedAt: new Date() };
    if (minBet          !== undefined) scSet['betLimits.thirtyMin.min'] = minBet;
    if (maxBet          !== undefined) scSet['betLimits.thirtyMin.max'] = maxBet;
    if (max30MinBet     !== undefined) scSet['betLimits.thirtyMin.max'] = max30MinBet;
    if (maxFullDayBet   !== undefined) scSet['betLimits.fullDay.max']   = maxFullDayBet;
    if (minDeposit            !== undefined) scSet.minDeposit            = minDeposit;
    if (maxDeposit            !== undefined) scSet.maxDeposit            = maxDeposit;
    if (minWithdrawal         !== undefined) scSet.minWithdrawal         = minWithdrawal;
    if (maxWithdrawal         !== undefined) scSet.maxWithdrawal         = maxWithdrawal;
    if (maxWinningsWithdrawal !== undefined) scSet.maxWinningsWithdrawal = maxWinningsWithdrawal;
    if (kycRequired           !== undefined) scSet.kycRequired           = kycRequired;
    if (registrationEnabled   !== undefined) scSet.registrationEnabled   = registrationEnabled;
    if (maintenanceMode       !== undefined) scSet.maintenanceMode       = maintenanceMode;
    if (maintenanceMessage    !== undefined) scSet.maintenanceMessage    = maintenanceMessage;
    if (depositMethods        !== undefined) scSet.depositMethods        = depositMethods;
    if (withdrawalMethods     !== undefined) scSet.withdrawalMethods     = withdrawalMethods;
    if (webUrl        !== undefined) scSet.webUrl        = webUrl;
    if (androidUrl    !== undefined) scSet.androidUrl    = androidUrl;
    if (iosUrl        !== undefined) scSet.iosUrl        = iosUrl;
    if (minVersion    !== undefined) scSet.minVersion    = minVersion;
    if (latestVersion !== undefined) scSet.latestVersion = latestVersion;

    await SystemConfig.findOneAndUpdate(
      { key: 'main' },
      { $set: scSet },
      { upsert: true, new: true }
    );

    // Token rates are in a separate collection — update if provided
    if (tokenBuyRate !== undefined || tokenSellRate !== undefined) {
      const ratesSet = {};
      if (tokenBuyRate  !== undefined) ratesSet.buyRate  = tokenBuyRate;
      if (tokenSellRate !== undefined) ratesSet.sellRate = tokenSellRate;
      await TokenRates.findOneAndUpdate(
        { key: 'main' },
        { $set: ratesSet },
        { upsert: true, new: true }
      );
      console.log(`✅ Token rates updated: Buy ₹${tokenBuyRate ?? '(unchanged)'}, Sell ₹${tokenSellRate ?? '(unchanged)'}`);
    }

    
    // so the user panel SystemGuard and WalletModal pick up new limits instantly
    if (global.io) {
      const updatedConfig = await SystemConfig.findOne({ key: 'main' }).lean() || {};
      const updatedRates  = await TokenRates.findOne({ key: 'main' }).lean()   || {};
      const broadcastPayload = {
        minBet:          updatedConfig.betLimits?.thirtyMin?.min   || 10,
        maxBet:          updatedConfig.betLimits?.thirtyMin?.max   || 100000,
        maxFullDayBet:   updatedConfig.betLimits?.fullDay?.max     || 500000,
        minDeposit:      updatedConfig.minDeposit            || 100,
        maxDeposit:      updatedConfig.maxDeposit            || 50000,
        minWithdrawal:   updatedConfig.minWithdrawal         || 500,
        maxWithdrawal:   updatedConfig.maxWithdrawal         || 50000,
        maintenanceMode: updatedConfig.maintenanceMode       || false,
        maintenanceMessage: updatedConfig.maintenanceMessage || '',
        tokenBuyRate:    updatedRates.buyRate                ?? 1,
        tokenSellRate:   updatedRates.sellRate               ?? 1,
        webUrl:        updatedConfig.webUrl        || '',
        androidUrl:    updatedConfig.androidUrl    || '',
        iosUrl:        updatedConfig.iosUrl        || '',
        minVersion:    updatedConfig.minVersion    || '1.0.0',
        latestVersion: updatedConfig.latestVersion || '1.0.0',
      };
      global.cachedSystemConfig = broadcastPayload;
      global.io.emit('system_config', broadcastPayload);
      if (global.sseManager) global.sseManager.broadcast('system_config', broadcastPayload);
    }

    res.json({ success: true, message: 'System config updated' });
  } catch (error) {
    console.error('Update system config error:', error);
    res.status(500).json({ success: false, message: 'Failed to update system config' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🎮 FIX (Audit #29) — ADMIN MANAGE CYCLE
 * Frontend admin panel calls: POST /api/admin/manage-cycle
 * ════════════════════════════════════════════════════════════════════════════
 */
// AUDIT: /download/android and /download/ios were REMOVED from here.
// They exist in server.js at GET /api/download/android and /api/download/ios.
// Having them in both places was duplicate code with two different mount paths
// (/api/admin/download/... vs /api/download/...) — server.js versions are canonical.

// ─── DOWNLOAD LINK ADMIN ROUTES ──────────────────────────────────────────────
// These sit at /api/admin/download/* and require admin auth — they're used by
// the SystemSettings page "Test Link" buttons so admin can verify APK/iOS URLs
// before saving. The public (no-auth) redirects live in server.js at /api/download/*.

// GET /api/admin/download/android — admin test redirect for Android APK
router.get('/download/android', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
    if (config?.androidUrl) return res.redirect(302, config.androidUrl);
    res.status(404).json({ success: false, message: 'Android APK URL not set. Add it in System Settings → App Distribution.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to fetch download link.' });
  }
});

// GET /api/admin/download/ios — admin test redirect for iOS App Store / PWA link
router.get('/download/ios', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
    if (config?.iosUrl) return res.redirect(302, config.iosUrl);
    res.status(404).json({ success: false, message: 'iOS URL not set. Add it in System Settings → App Distribution.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to fetch download link.' });
  }
});

// GET /api/admin/download/links — returns both URLs as JSON so SystemSettings can
// display them without following a redirect.
router.get('/download/links', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
    res.json({
      success: true,
      androidUrl: config?.androidUrl || '',
      iosUrl:     config?.iosUrl     || '',
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to fetch download links.' });
  }
});

router.get('/withdrawal-requests', authenticate, isAdmin, async (req, res) => {
  try {
    const WithdrawalRequest = mongoose.model('WithdrawalRequest');
    const User = mongoose.model('User');
    const { status = 'PENDING', page = 1 } = req.query;
    const requests = await WithdrawalRequest.find({ status })
      .sort({ createdAt: -1 }).skip((page - 1) * 20).limit(20).lean();
    const userIds = requests.map(r => r.userId);
    const users = await User.find({ _id: { $in: userIds } }).select('username mobile').lean();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));
    res.json({ success: true, requests: requests.map(r => ({ ...r, user: userMap[String(r.userId)] })) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/withdrawal-requests/:id/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const { note } = req.body;
    const WithdrawalRequest = mongoose.model('WithdrawalRequest');
    const User = mongoose.model('User');
    const wr = await WithdrawalRequest.findById(req.params.id);
    if (!wr) return res.status(404).json({ success: false, message: 'Request not found' });
    if (wr.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Request is not pending' });

    // Release locked balance via WalletAuthority (writes WalletLedger, idempotent)
    await releaseWithdrawal(String(wr.userId), wr.amount, String(wr._id));
    await WithdrawalRequest.findByIdAndUpdate(wr._id, {
      status: 'APPROVED', adminNote: note, processedBy: req.user._id, processedAt: new Date()
    });
    if (global.io) global.io.to(`user-${wr.userId}`).emit('withdrawal_approved', { requestId: wr._id, amount: wr.amount });
    res.json({ success: true, message: 'Withdrawal approved' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/withdrawal-requests/:id/reject', authenticate, isAdmin, async (req, res) => {
  try {
    const { note } = req.body;
    const WithdrawalRequest = mongoose.model('WithdrawalRequest');
    const wr = await WithdrawalRequest.findById(req.params.id);
    if (!wr) return res.status(404).json({ success: false, message: 'Request not found' });
    if (wr.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Request is not pending' });

    // Refund locked balance → winningsBalance via WalletAuthority (writes WalletLedger, idempotent)
    await refundWithdrawal(String(wr.userId), wr.amount, String(wr._id));
    await WithdrawalRequest.findByIdAndUpdate(wr._id, {
      status: 'REJECTED', adminNote: note, processedBy: req.user._id, processedAt: new Date()
    });
    if (global.io) global.io.to(`user-${wr.userId}`).emit('withdrawal_rejected', { requestId: wr._id, amount: wr.amount, reason: note });
    res.json({ success: true, message: 'Withdrawal rejected and balance restored' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📊 FIX (Audit #26) — STATS ALIAS
 * Frontend calls: GET /api/admin/stats
 * Real route: GET /api/admin/analytics/dashboard
 * ════════════════════════════════════════════════════════════════════════════
 */
// GET /api/admin/stats
// Alias for analytics/dashboard — some older admin panel versions call /stats.
// AUDIT FIX: was using next('route') + req.url rewrite which Express ignores (routes
// are matched once at mount time, not on req.url change). Now runs the same query
// as analytics/dashboard directly so it never falls through to 404.
router.get('/stats', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { getDashboardStats } = await import('../../services/admin.service.js');
    const stats = await getDashboardStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

router.get('/error-reports', authenticate, isAdmin, async (req, res) => {
  try {
    const FrontendErrorReport = mongoose.model('FrontendErrorReport');
    const reports = await FrontendErrorReport.find({}).sort({ ts: -1 }).limit(200).lean();
    res.json({ success: true, reports });
  } catch (err) {
    console.error('[error-reports] list failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch error reports' });
  }
});

router.delete('/error-reports', authenticate, isAdmin, async (req, res) => {
  try {
    const FrontendErrorReport = mongoose.model('FrontendErrorReport');
    await FrontendErrorReport.deleteMany({});
    res.json({ success: true, message: 'All error reports cleared' });
  } catch (err) {
    console.error('[error-reports] clear failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to clear error reports' });
  }
});

// =============================================================================
// APP-ASSETS upload routes
// POST /api/admin/app-assets/upload  — upload a logo/icon/splash as base64 JSON
// GET  /api/admin/app-assets         — list all slots with public URLs
// DELETE /api/admin/app-assets/:name — delete a specific asset
// Assets served at /app-assets/:filename via server.js express.static
// =============================================================================

import path_node from 'path';
import fs_node from 'fs';
import { releaseWithdrawal, refundWithdrawal } from '../../services/walletAuthority.service.js';

const ASSET_SLOTS = {
  'logo.png':           { label: 'App Logo (Loading & Share)',   w: 512,  h: 512,  hint: 'Square PNG, transparent bg. Loading screen + share modal.' },
  'logo-header.png':    { label: 'Header Banner Logo',           w: 600,  h: 120,  hint: 'Wide PNG, transparent bg. Shown in app header center.' },
  'icon-192.png':       { label: 'PWA Icon 192x192',             w: 192,  h: 192,  hint: 'Square PNG. Android home screen shortcut.' },
  'icon-512.png':       { label: 'PWA Icon 512x512 (Maskable)',  w: 512,  h: 512,  hint: 'Square PNG with safe zone. Splash + app store.' },
  'icon-apple-180.png': { label: 'Apple Touch Icon 180x180',     w: 180,  h: 180,  hint: 'Square PNG. iPhone home screen.' },
  'favicon-32.png':     { label: 'Favicon 32x32',                w: 32,   h: 32,   hint: 'Square PNG. Browser tab.' },
  'splash.png':         { label: 'PWA Splash Screen',            w: 1242, h: 2688, hint: 'Portrait PNG. PWA loading splash.' },
};

const appAssetsDir_r = path_node.join(path_node.dirname(new URL(import.meta.url).pathname), '../app-assets');
fs_node.mkdirSync(appAssetsDir_r, { recursive: true });

export default router;
