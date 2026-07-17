// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** system.admin.routes.js — System config, token rates, withdrawal requests, error logs */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from './_adminShared.js';
import { setConfigField } from '../../domains/configuration/configVersioning.service.js';

const router = express.Router();

// ── Cycle-phase validation (Business Config Audit) ────────────────────────────
// A phase set is {merge,equalizer,close,celebrate}BeforeEndSec (seconds before a
// cycle's end). Enforce the state-machine invariant merge>equalizer>close>
// celebrate>=0 and that merge fits inside the block. maxMerge caps the earliest
// phase: 600s for 30-min-type blocks (< the 10-min minimum duration so it fits
// any admin-chosen duration), larger for the full-day block. Returns an error
// string, or null when valid.
function validateCyclePhaseSet(label, p, maxMerge) {
  if (!p || typeof p !== 'object') return `cyclePhases.${label} must be an object with all four offsets.`;
  const fields = ['mergeBeforeEndSec', 'equalizerBeforeEndSec', 'closeBeforeEndSec', 'celebrateBeforeEndSec'];
  for (const f of fields) {
    const v = p[f];
    if (!Number.isInteger(v) || v < 0 || v > 86400) {
      return `cyclePhases.${label}.${f} must be an integer between 0 and 86400 seconds.`;
    }
  }
  const { mergeBeforeEndSec: m, equalizerBeforeEndSec: e, closeBeforeEndSec: c, celebrateBeforeEndSec: fr } = p;
  if (!(m > e && e > c && c > fr)) {
    return `cyclePhases.${label} offsets must strictly decrease: merge > equalizer > close > celebrate.`;
  }
  if (m >= maxMerge) {
    return `cyclePhases.${label}.mergeBeforeEndSec must be less than ${maxMerge}s so the phase fits inside the block.`;
  }
  return null;
}

// ── Footer navigation validation (2026-07-13) ─────────────────────────────────
// The complete set of user-panel pages an admin may place in the footer bar.
// MUST mirror the PAGE_CATALOG in components/Layout/Footer.tsx — the frontend
// owns route strings/icons (display), this list owns what's selectable.
const FOOTER_PAGE_KEYS = [
  'home', 'results', 'winners', 'promo', 'profile', 'wallet', 'invite', 'vip',
  'gift-code', 'my-bets', 'history', 'rules', 'faq', 'support',
  'casino', 'crash', 'sports',
];

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
        // Business Config Audit (2026-07-11) — formerly-hardcoded business values
        payoutMultiplier:      config.payoutMultiplier ?? 2,   // schema default: 2 (2x)
        orderExpiryMinutes:    config.orderExpiryMinutes ?? 15, // schema default: 15
        cyclePhases: {
          thirtyMin: {
            mergeBeforeEndSec:     config.cyclePhases?.thirtyMin?.mergeBeforeEndSec     ?? 180,
            equalizerBeforeEndSec: config.cyclePhases?.thirtyMin?.equalizerBeforeEndSec ?? 120,
            closeBeforeEndSec:     config.cyclePhases?.thirtyMin?.closeBeforeEndSec     ?? 30,
            celebrateBeforeEndSec: config.cyclePhases?.thirtyMin?.celebrateBeforeEndSec ?? 10,
          },
          fullDay: {
            mergeBeforeEndSec:     config.cyclePhases?.fullDay?.mergeBeforeEndSec     ?? 300,
            equalizerBeforeEndSec: config.cyclePhases?.fullDay?.equalizerBeforeEndSec ?? 120,
            closeBeforeEndSec:     config.cyclePhases?.fullDay?.closeBeforeEndSec     ?? 30,
            celebrateBeforeEndSec: config.cyclePhases?.fullDay?.celebrateBeforeEndSec ?? 10,
          },
        },
        riskRules: {
          enforceMultiplesOf10:     config.riskRules?.enforceMultiplesOf10     ?? true,  // schema default: true
          blockOppositeSideBetting: config.riskRules?.blockOppositeSideBetting ?? false, // schema default: false
          maxFundingOrdersPerHour:  config.riskRules?.maxFundingOrdersPerHour  ?? 0,     // schema default: 0
          maxWarnings:              config.riskRules?.maxWarnings              ?? 3,     // schema default: 3 (0 = never)
        },
        tlsFingerprintDefense: {
          enabled:        config.tlsFingerprintDefense?.enabled        ?? true,
          logOnly:        config.tlsFingerprintDefense?.logOnly        ?? true,
          requireJa3Hash: config.tlsFingerprintDefense?.requireJa3Hash ?? false,
          blockJa3Hashes: config.tlsFingerprintDefense?.blockJa3Hashes || [],
        },
        kycRequired:           config.kycRequired           !== false,
        registrationEnabled:   config.registrationEnabled   !== false,
        maintenanceMode:       config.maintenanceMode       || false,
        maintenanceMessage:    config.maintenanceMessage    || '',
        depositMethods:        config.depositMethods        || ['UPI', 'BANK_TRANSFER'],
        withdrawalMethods:     config.withdrawalMethods     || ['UPI', 'BANK_TRANSFER'],
        // Footer navigation (2026-07-13) — schema default: the historical five tabs
        // Normalize legacy "chat" entries before sending to frontend
        footerPages:           (() => {
          const raw = config.footerPages?.length ? config.footerPages : ['home', 'results', 'winners', 'promo', 'profile'];
          const normalized = raw.filter(k => FOOTER_PAGE_KEYS.includes(k));
          return normalized.length >= 2 ? normalized : ['home', 'results', 'winners', 'promo', 'profile'];
        })(),
        // Operational alert webhook (2026-07-13) — '' = alerting off
        alertWebhookUrl:       config.alertWebhookUrl || '',
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
      payoutMultiplier, orderExpiryMinutes, cyclePhases,
      footerPages, alertWebhookUrl, tlsFingerprintDefense,
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
    // ── Business Config Audit fields ──────────────────────────────────────────
    if (riskRules?.maxWarnings !== undefined &&
        (!Number.isInteger(riskRules.maxWarnings) || riskRules.maxWarnings < 0)) {
      return res.status(400).json({ success: false, message: 'riskRules.maxWarnings must be a non-negative integer (0 = never auto-block).' });
    }
    if (payoutMultiplier !== undefined &&
        (!Number.isInteger(payoutMultiplier) || payoutMultiplier < 1 || payoutMultiplier > 10)) {
      return res.status(400).json({ success: false, message: 'payoutMultiplier must be an integer between 1 and 10.' });
    }
    if (orderExpiryMinutes !== undefined &&
        (!Number.isInteger(orderExpiryMinutes) || orderExpiryMinutes < 1 || orderExpiryMinutes > 1440)) {
      return res.status(400).json({ success: false, message: 'orderExpiryMinutes must be an integer between 1 and 1440.' });
    }
    if (cyclePhases?.thirtyMin !== undefined) {
      const err = validateCyclePhaseSet('thirtyMin', cyclePhases.thirtyMin, 600);
      if (err) return res.status(400).json({ success: false, message: err });
    }
    if (cyclePhases?.fullDay !== undefined) {
      const err = validateCyclePhaseSet('fullDay', cyclePhases.fullDay, 3600);
      if (err) return res.status(400).json({ success: false, message: err });
    }
    if (footerPages !== undefined) {
      if (!Array.isArray(footerPages) || footerPages.length < 2 || footerPages.length > 5) {
        return res.status(400).json({ success: false, message: 'footerPages must be an array of 2 to 5 page keys.' });
      }
      // Normalize legacy "chat" entries before validation
      const normalized = footerPages.filter(k => FOOTER_PAGE_KEYS.includes(k));
      if (normalized.length < 2) {
        return res.status(400).json({ success: false, message: 'footerPages must contain at least 2 valid page keys after removing unsupported entries.' });
      }
      if (new Set(normalized).size !== normalized.length) {
        return res.status(400).json({ success: false, message: 'footerPages must not contain duplicates.' });
      }
    }
    if (alertWebhookUrl !== undefined &&
        (typeof alertWebhookUrl !== 'string' ||
         (alertWebhookUrl !== '' && !/^https:\/\/.+/.test(alertWebhookUrl)))) {
      return res.status(400).json({ success: false, message: 'alertWebhookUrl must be an https:// URL, or empty to disable alerting.' });
    }

    if (tlsFingerprintDefense !== undefined) {
      const hashes = tlsFingerprintDefense.blockJa3Hashes;
      if (hashes !== undefined && (!Array.isArray(hashes) || hashes.some(h => !/^[a-f0-9]{32}$/i.test(String(h || '').trim())))) {
        return res.status(400).json({ success: false, message: 'tlsFingerprintDefense.blockJa3Hashes must contain only 32-character hex JA3 hashes.' });
      }
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
    // Business Config Audit (2026-07-11) — formerly-hardcoded values, now admin-owned
    // Auto-block threshold — consumed by merchant.routes.js reject handler
    if (riskRules?.maxWarnings !== undefined) fieldWrites.push(['SystemConfig', 'riskRules.maxWarnings', riskRules.maxWarnings]);
    // Payout multiplier — consumed by markets/gameEngine.js via riskValidation.computeWinningsPayout
    if (payoutMultiplier   !== undefined) fieldWrites.push(['SystemConfig', 'payoutMultiplier', payoutMultiplier]);
    // Payment order window — consumed by payment/paymentProcessing.tryAssignMerchant
    if (orderExpiryMinutes !== undefined) fieldWrites.push(['SystemConfig', 'orderExpiryMinutes', orderExpiryMinutes]);
    // Cycle phase offsets — consumed (cached) by markets/cycleGenerator.getCyclePhases.
    // Written per-type as a whole validated subdocument.
    if (cyclePhases?.thirtyMin !== undefined) fieldWrites.push(['SystemConfig', 'cyclePhases.thirtyMin', {
      mergeBeforeEndSec:     cyclePhases.thirtyMin.mergeBeforeEndSec,
      equalizerBeforeEndSec: cyclePhases.thirtyMin.equalizerBeforeEndSec,
      closeBeforeEndSec:     cyclePhases.thirtyMin.closeBeforeEndSec,
      celebrateBeforeEndSec: cyclePhases.thirtyMin.celebrateBeforeEndSec,
    }]);
    if (cyclePhases?.fullDay !== undefined) fieldWrites.push(['SystemConfig', 'cyclePhases.fullDay', {
      mergeBeforeEndSec:     cyclePhases.fullDay.mergeBeforeEndSec,
      equalizerBeforeEndSec: cyclePhases.fullDay.equalizerBeforeEndSec,
      closeBeforeEndSec:     cyclePhases.fullDay.closeBeforeEndSec,
      celebrateBeforeEndSec: cyclePhases.fullDay.celebrateBeforeEndSec,
    }]);
    // Footer navigation (2026-07-13) — consumed by the user panel Footer via system_config
    if (footerPages !== undefined) {
      // Normalize legacy "chat" entries before persisting
      const normalized = footerPages.filter(k => FOOTER_PAGE_KEYS.includes(k));
      fieldWrites.push(['SystemConfig', 'footerPages', normalized.length >= 2 ? normalized : ['home', 'results', 'winners', 'promo', 'profile']]);
    }
    // Operational alert webhook (2026-07-13) — consumed by services/alerting.service.js
    if (alertWebhookUrl !== undefined) fieldWrites.push(['SystemConfig', 'alertWebhookUrl', alertWebhookUrl]);
    if (tlsFingerprintDefense?.enabled !== undefined) fieldWrites.push(['SystemConfig', 'tlsFingerprintDefense.enabled', !!tlsFingerprintDefense.enabled]);
    if (tlsFingerprintDefense?.logOnly !== undefined) fieldWrites.push(['SystemConfig', 'tlsFingerprintDefense.logOnly', !!tlsFingerprintDefense.logOnly]);
    if (tlsFingerprintDefense?.requireJa3Hash !== undefined) fieldWrites.push(['SystemConfig', 'tlsFingerprintDefense.requireJa3Hash', !!tlsFingerprintDefense.requireJa3Hash]);
    if (tlsFingerprintDefense?.blockJa3Hashes !== undefined) fieldWrites.push(['SystemConfig', 'tlsFingerprintDefense.blockJa3Hashes', [...new Set(tlsFingerprintDefense.blockJa3Hashes.map(h => String(h).trim().toLowerCase()))]]);

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
        footerPages:     (() => {
          const raw = updatedConfig.footerPages?.length ? updatedConfig.footerPages : ['home', 'results', 'winners', 'promo', 'profile'];
          const normalized = raw.filter(k => FOOTER_PAGE_KEYS.includes(k));
          return normalized.length >= 2 ? normalized : ['home', 'results', 'winners', 'promo', 'profile'];
        })(),
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


// NOTE: GET /stats is intentionally not registered here. The canonical
// admin stats endpoint is owned by domains/analytics/analytics.admin.routes.js
// and is mounted before this router. The previous system alias imported a
// non-exported getDashboardStats helper, so keeping it here created a latent
// runtime failure if route order changed.

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

// Withdrawal approve/reject (above) delegate balance movement to the wallet
// authority. NOTE: the app-asset upload routes + ASSET_SLOTS that used to be
// declared here were dead in this module (the actual routes live in
// branding.admin.routes.js, which now owns those consts and an S3-backed
// implementation). Removed 2026-07-11 per §13 (no dead artifacts).
import { releaseWithdrawal, refundWithdrawal } from '../../domains/wallet/walletAuthority.service.js';

export default router;
