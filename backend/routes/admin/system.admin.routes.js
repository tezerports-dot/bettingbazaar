// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** system.admin.routes.js — System config, token rates, withdrawal requests, error logs */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from './_adminShared.js';
import { setConfigField } from '../../domains/configuration/configVersioning.service.js';

const router = express.Router();

// Token rates removed 2026-07-08: conversion is fixed 1:1 (Phase 006
// flattening — see ENTERPRISE_DECISIONS.md). The GET/PUT /token-rates
// endpoints and rate validation that lived here are gone; rates are no
// longer admin-editable.

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

// ════════════════════════════════════════════════════════════════════════════
// ✅ FIX #8: MERCHANT MANAGEMENT ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

// Get merchant full profile — :merchantId is always Merchant._id.
// The merchants list guarantees this. No User._id fallback.
router.get('/system/config', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const config = await SystemConfig.findOne({ key: 'main' }).lean() || {};
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
        tokenBuyRate:          1, // fixed 1:1 conversion (Phase 006 flattening, 2026-07-08)
        tokenSellRate:         1, // fixed 1:1 conversion
        // Risk Platform rules (Phase 010) — schema defaults cited inline
        payoutFeePercent:      config.payoutFeePercent ?? 0,  // schema default: 0
        // Bet funding split (Phase A) — % of each stake from reserveBalance
        betReservePercent:     config.betReservePercent ?? 3, // schema default: 3
        // Winnings platform fee (Phase A) — % of gross 2x retained at settlement
        winningsFeePercent:    config.winningsFeePercent ?? 1, // schema default: 1
        // Cycle duration (Phase X X-5) — short-block betting window length
        cycleDurationMinutes:  config.cycleDurationMinutes ?? 30, // schema default: 30
        // Data retention (Phase X X-7) — months of operational data kept
        retentionMonths:       config.retentionMonths ?? 6, // schema default: 6
        riskRules: {
          enforceMultiplesOf10:     config.riskRules?.enforceMultiplesOf10     ?? true,  // schema default: true
          blockOppositeSideBetting: config.riskRules?.blockOppositeSideBetting ?? false, // schema default: false
          maxFundingOrdersPerHour:  config.riskRules?.maxFundingOrdersPerHour  ?? 0,     // schema default: 0
        },
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
    const actor = { userId: req.user._id, userName: req.user.username };

    const {
      minBet, maxBet, max30MinBet, maxFullDayBet,
      minDeposit, maxDeposit, minWithdrawal, maxWithdrawal, maxWinningsWithdrawal,
      kycRequired, registrationEnabled,
      maintenanceMode, maintenanceMessage,
      depositMethods, withdrawalMethods,
      webUrl, androidUrl, iosUrl, minVersion, latestVersion,
      payoutFeePercent, riskRules, betReservePercent, winningsFeePercent,
      cycleDurationMinutes, retentionMonths,
    } = req.body;

    if (cycleDurationMinutes !== undefined &&
        (!Number.isInteger(cycleDurationMinutes) || cycleDurationMinutes < 10 ||
         cycleDurationMinutes > 60 || 60 % cycleDurationMinutes !== 0)) {
      return res.status(400).json({ success: false, message: 'cycleDurationMinutes must be an integer that divides 60 evenly (10, 12, 15, 20, 30, or 60).' });
    }
    if (retentionMonths !== undefined &&
        (!Number.isInteger(retentionMonths) || retentionMonths < 1 || retentionMonths > 120)) {
      return res.status(400).json({ success: false, message: 'retentionMonths must be an integer between 1 and 120.' });
    }

    if (payoutFeePercent !== undefined &&
        (typeof payoutFeePercent !== 'number' || payoutFeePercent < 0 || payoutFeePercent > 100)) {
      return res.status(400).json({ success: false, message: 'payoutFeePercent must be a number between 0 and 100.' });
    }
    if (betReservePercent !== undefined &&
        (typeof betReservePercent !== 'number' || !Number.isFinite(betReservePercent) ||
         betReservePercent < 0 || betReservePercent > 100 ||
         Math.abs(betReservePercent * 100 - Math.round(betReservePercent * 100)) > 1e-9)) {
      return res.status(400).json({ success: false, message: 'betReservePercent must be a number between 0 and 100 with at most 2 decimals.' });
    }
    if (winningsFeePercent !== undefined &&
        (typeof winningsFeePercent !== 'number' || !Number.isFinite(winningsFeePercent) ||
         winningsFeePercent < 0 || winningsFeePercent > 100 ||
         Math.abs(winningsFeePercent * 100 - Math.round(winningsFeePercent * 100)) > 1e-9)) {
      return res.status(400).json({ success: false, message: 'winningsFeePercent must be a number between 0 and 100 with at most 2 decimals.' });
    }
    if (riskRules?.maxFundingOrdersPerHour !== undefined &&
        (!Number.isInteger(riskRules.maxFundingOrdersPerHour) || riskRules.maxFundingOrdersPerHour < 0)) {
      return res.status(400).json({ success: false, message: 'riskRules.maxFundingOrdersPerHour must be a non-negative integer.' });
    }

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
    // Risk Platform rules (Phase 010) — numbers owned here (Business Policy),
    // enforcement in domains/risk/riskValidation.service.js
    if (payoutFeePercent !== undefined) fieldWrites.push(['SystemConfig', 'payoutFeePercent', payoutFeePercent]);
    // Bet funding split (Phase A) — consumed by bet.routes.js via
    // riskValidation.computeBetFundingPlan
    if (betReservePercent !== undefined) fieldWrites.push(['SystemConfig', 'betReservePercent', betReservePercent]);
    // Winnings platform fee (Phase A) — consumed by markets/gameEngine.js via
    // riskValidation.computeWinningsPayout
    if (winningsFeePercent !== undefined) fieldWrites.push(['SystemConfig', 'winningsFeePercent', winningsFeePercent]);
    // Cycle duration (Phase X X-5) — consumed by cycleGenerator.ensureActive30MinCycle
    if (cycleDurationMinutes !== undefined) fieldWrites.push(['SystemConfig', 'cycleDurationMinutes', cycleDurationMinutes]);
    // Data retention (Phase X X-7) — consumed by operations/retention.service.js
    if (retentionMonths !== undefined) fieldWrites.push(['SystemConfig', 'retentionMonths', retentionMonths]);
    if (riskRules?.enforceMultiplesOf10     !== undefined) fieldWrites.push(['SystemConfig', 'riskRules.enforceMultiplesOf10', !!riskRules.enforceMultiplesOf10]);
    if (riskRules?.blockOppositeSideBetting !== undefined) fieldWrites.push(['SystemConfig', 'riskRules.blockOppositeSideBetting', !!riskRules.blockOppositeSideBetting]);
    if (riskRules?.maxFundingOrdersPerHour  !== undefined) fieldWrites.push(['SystemConfig', 'riskRules.maxFundingOrdersPerHour', riskRules.maxFundingOrdersPerHour]);

    for (const [modelName, path, value] of fieldWrites) {
      await setConfigField(modelName, path, value, actor, {
        justification: 'Admin bulk system config update via /system/config',
      });
    }

    if (global.io) {
      const updatedConfig = await SystemConfig.findOne({ key: 'main' }).lean() || {};
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
        tokenBuyRate:    1, // fixed 1:1 conversion (Phase 006 flattening, 2026-07-08)
        tokenSellRate:   1, // fixed 1:1 conversion
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
