// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** system.admin.routes.js — System config, token rates, withdrawal requests, error logs */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from './_adminShared.js';
import { setConfigField } from '../../domains/configuration/configVersioning.service.js';

const router = express.Router();

// ── Shared validation, used by BOTH /token-rates and /system/config below ────
// CONSOLIDATED 2026-07-03: these two endpoints previously validated buyRate >
// sellRate independently — /system/config didn't check it at all, meaning an
// admin could set an invalid (or even loss-making) rate pair through that path
// while the dedicated /token-rates endpoint correctly blocked it. Single
// function now, called from both places, so they can't diverge again.
// Checks against whichever value ISN'T being changed too — if only one of the
// two fields is submitted, the resulting pair is still validated, not just the
// field present in this particular request.
async function validateAndResolveRates(newBuyRate, newSellRate) {
  if (newBuyRate === undefined && newSellRate === undefined) return null;
  const TokenRates = mongoose.model('TokenRates');
  const current = await TokenRates.findOne({ key: 'main' }).lean() || {};
  const finalBuy  = newBuyRate  !== undefined ? parseFloat(newBuyRate)  : current.buyRate;
  const finalSell = newSellRate !== undefined ? parseFloat(newSellRate) : current.sellRate;
  if (!finalBuy || !finalSell || finalBuy <= 0 || finalSell <= 0) {
    throw new Error('Buy and sell rates must be positive numbers');
  }
  // RELAXED 2026-07-08: buyRate === sellRate now ALLOWED (first step toward
  // fixed 1:1 conversion — see ENTERPRISE_DECISIONS.md). buyRate < sellRate
  // (a merchant loss) is still rejected.
  if (finalBuy < finalSell) {
    throw new Error('Buy rate cannot be lower than sell rate (that would mean a merchant loss)');
  }
  return { finalBuy, finalSell };
}

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

    if (!rates) {
      return res.json({
        success: true,
        data: null,
        message: 'No rates configured yet. Use PUT /admin/token-rates to set them.'
      });
    }

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

    if (buyRate === undefined || sellRate === undefined) {
      return res.status(400).json({ success: false, message: 'buyRate and sellRate are required' });
    }

    let resolved;
    try {
      resolved = await validateAndResolveRates(buyRate, sellRate);
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    const oldRates = await TokenRates.findOne({ key: 'main' });
    const actor = { userId: req.user._id, userName: req.user.username };

    await setConfigField('TokenRates', 'buyRate', resolved.finalBuy, actor, {
      justification: 'Admin token rate update via dedicated /token-rates endpoint',
    });
    await setConfigField('TokenRates', 'sellRate', resolved.finalSell, actor, {
      justification: 'Admin token rate update via dedicated /token-rates endpoint',
    });

    const rates = await TokenRates.findOne({ key: 'main' });

    await EnhancedAuditLog.create({
      performedBy: req.user._id,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'UPDATE_TOKEN_RATES',
      category: 'FINANCIAL',
      details: {
        oldBuyRate: oldRates?.buyRate,
        newBuyRate: resolved.finalBuy,
        oldSellRate: oldRates?.sellRate,
        newSellRate: resolved.finalSell,
        merchantProfit: resolved.finalBuy - resolved.finalSell
      },
      success: true
    });

    console.log(`✅ Token rates updated: Buy ₹${resolved.finalBuy}, Sell ₹${resolved.finalSell}`);

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
    const config = await SystemConfig.findOne({ key: 'main' }).lean() || {};
    const rates  = await TokenRates.findOne({ key: 'main' }).lean() || {};
    res.json({
      success: true,
      config: {
        minBet:                config.betLimits?.thirtyMin?.min   || 10,
        maxBet:                config.betLimits?.thirtyMin?.max   || 100000,
        max30MinBet:           config.betLimits?.thirtyMin?.max   || 100000,
        maxFullDayBet:         config.betLimits?.fullDay?.max     || 500000,
        minDeposit:            config.minDeposit            || 100,
        maxDeposit:            config.maxDeposit            || 50000,
        minWithdrawal:         config.minWithdrawal         || 500,
        maxWithdrawal:         config.maxWithdrawal         || 50000,
        maxWinningsWithdrawal: config.maxWinningsWithdrawal || 500000,
        tokenBuyRate:          rates.buyRate                ?? 1,
        tokenSellRate:         rates.sellRate               ?? 1,
        kycRequired:           config.kycRequired           !== false,
        registrationEnabled:   config.registrationEnabled   !== false,
        maintenanceMode:       config.maintenanceMode       || false,
        maintenanceMessage:    config.maintenanceMessage    || '',
        depositMethods:        config.depositMethods        || ['UPI', 'BANK_TRANSFER'],
        withdrawalMethods:     config.withdrawalMethods     || ['UPI', 'BANK_TRANSFER'],
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
    const actor = { userId: req.user._id, userName: req.user.username };

    const {
      minBet, maxBet, max30MinBet, maxFullDayBet,
      minDeposit, maxDeposit, minWithdrawal, maxWithdrawal, maxWinningsWithdrawal,
      tokenBuyRate, tokenSellRate,
      kycRequired, registrationEnabled,
      maintenanceMode, maintenanceMessage,
      depositMethods, withdrawalMethods,
      webUrl, androidUrl, iosUrl, minVersion, latestVersion,
    } = req.body;

    const fieldWrites = [];
    if (minBet          !== undefined) fieldWrites.push(['SystemConfig', 'betLimits.thirtyMin.min', minBet]);
    if (maxBet          !== undefined) fieldWrites.push(['SystemConfig', 'betLimits.thirtyMin.max', maxBet]);
    if (max30MinBet     !== undefined) fieldWrites.push(['SystemConfig', 'betLimits.thirtyMin.max', max30MinBet]);
    if (maxFullDayBet   !== undefined) fieldWrites.push(['SystemConfig', 'betLimits.fullDay.max', maxFullDayBet]);
    if (minDeposit            !== undefined) fieldWrites.push(['SystemConfig', 'minDeposit', minDeposit]);
    if (maxDeposit            !== undefined) fieldWrites.push(['SystemConfig', 'maxDeposit', maxDeposit]);
    if (minWithdrawal         !== undefined) fieldWrites.push(['SystemConfig', 'minWithdrawal', minWithdrawal]);
    if (maxWithdrawal         !== undefined) fieldWrites.push(['SystemConfig', 'maxWithdrawal', maxWithdrawal]);
    if (maxWinningsWithdrawal !== undefined) fieldWrites.push(['SystemConfig', 'maxWinningsWithdrawal', maxWinningsWithdrawal]);
    if (kycRequired           !== undefined) fieldWrites.push(['SystemConfig', 'kycRequired', kycRequired]);
    if (registrationEnabled   !== undefined) fieldWrites.push(['SystemConfig', 'registrationEnabled', registrationEnabled]);
    if (maintenanceMode       !== undefined) fieldWrites.push(['SystemConfig', 'maintenanceMode', maintenanceMode]);
    if (maintenanceMessage    !== undefined) fieldWrites.push(['SystemConfig', 'maintenanceMessage', maintenanceMessage]);
    if (depositMethods        !== undefined) fieldWrites.push(['SystemConfig', 'depositMethods', depositMethods]);
    if (withdrawalMethods     !== undefined) fieldWrites.push(['SystemConfig', 'withdrawalMethods', withdrawalMethods]);
    if (webUrl        !== undefined) fieldWrites.push(['SystemConfig', 'webUrl', webUrl]);
    if (androidUrl    !== undefined) fieldWrites.push(['SystemConfig', 'androidUrl', androidUrl]);
    if (iosUrl        !== undefined) fieldWrites.push(['SystemConfig', 'iosUrl', iosUrl]);
    if (minVersion    !== undefined) fieldWrites.push(['SystemConfig', 'minVersion', minVersion]);
    if (latestVersion !== undefined) fieldWrites.push(['SystemConfig', 'latestVersion', latestVersion]);

    for (const [modelName, path, value] of fieldWrites) {
      await setConfigField(modelName, path, value, actor, {
        justification: 'Admin bulk system config update via /system/config',
      });
    }

    if (tokenBuyRate !== undefined || tokenSellRate !== undefined) {
      let resolved;
      try {
        resolved = await validateAndResolveRates(tokenBuyRate, tokenSellRate);
      } catch (validationError) {
        return res.status(400).json({ success: false, message: validationError.message });
      }
      if (tokenBuyRate  !== undefined) await setConfigField('TokenRates', 'buyRate',  resolved.finalBuy,  actor, { justification: 'Admin bulk system config update via /system/config' });
      if (tokenSellRate !== undefined) await setConfigField('TokenRates', 'sellRate', resolved.finalSell, actor, { justification: 'Admin bulk system config update via /system/config' });
      console.log(`✅ Token rates updated: Buy ₹${resolved.finalBuy}, Sell ₹${resolved.finalSell}`);
    }

    
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
// =============================================================================

import path_node from 'path';
import fs_node from 'fs';
import { releaseWithdrawal, refundWithdrawal } from '../../domains/wallet/walletAuthority.service.js';

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
