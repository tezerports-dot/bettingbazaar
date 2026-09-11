// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** system.admin.routes.js — System config, token rates, withdrawal requests, error logs */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from './_adminShared.js';
import {
  INR_TOKEN_RATE, isSaneUsdtRate, USDT_RATE_MIN_INR, USDT_RATE_MAX_INR,
} from '../../domains/configuration/tokenRates.js';
import { setConfigFields } from '../../domains/configuration/configVersioning.service.js';
import { getSystemConfig } from '#db/repositories/config.js';
// The declaration of what a setting IS — its default and its bounds. Read here
// so this route neither restates a default nor keeps its own list of fields.
import { SYSTEM_CONFIG_SPEC } from '#db/spec/config.spec.js';
import { db } from '#db';
import { MAX_MERGE_BEFORE_END_SEC } from '../../domains/markets/cycleTypes.js';
import { respondError } from '../../shared/httpError.js';

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
// flattening — see CLAUDE.md). The GET/PUT /token-rates
// endpoints and rate validation that lived here are gone; rates are no
// longer admin-editable.

router.get('/transactions', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { type, field, page = 1, limit = 50 } = req.query;

    // The wallet ledger IS the transaction list. `type` filters by direction
    // (CREDIT / DEBIT) and `field` by pocket, which is the vocabulary the rows
    // actually carry — the collection this replaced had its own type and status
    // enums, and nothing has written a row to it since the money moved.
    const ledger = await db.wallets.platformLedger({
      txType: type && type !== 'all' ? String(type).toUpperCase() : null,
      field:  field && field !== 'all' ? String(field) : null,
      page, limit,
    });

    res.json({
      success: true,
      transactions: ledger.entries,
      pagination: {
        total: ledger.total, page: ledger.page,
        limit: ledger.limit, pages: ledger.pages,
      },
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
    const config = await getSystemConfig();
    res.json({
      success: true,
      config: {
        // ── Every setting the spec declares, at its live value ──────────────
        // `getSystemConfig()` already fills every declared key from the spec's
        // own default, so spreading it means a setting is SERVED the moment it
        // is declared — the same rule the PUT follows. Written out field by
        // field, the response carried neither `withdrawalHoldMinutes` nor
        // `loadShedding` nor any of the eight `ipDefense` fields, so an admin
        // screen could not have shown them even if the PUT had taken them.
        //
        // `minted` is stripped for the same reason the PUT skips it: it is the
        // running issuance total, not a setting, and a number on a settings
        // page is a number somebody will type over (F-022).
        //
        // Five groups used to be REBUILT here key by key over the spread, each
        // with its own `??` restating a schema default. Every restatement
        // matched, so none of them was wrong — but a rebuild is a SHRINK: the
        // `cyclePhases` block named `thirtyMin` and `fullDay` only, so the
        // one-minute board's four phase offsets were declared, defaulted,
        // consumed by the engine, and invisible to the admin panel. §18.2 asks
        // for one declaration read by both consumers; a rebuild is a second
        // list that goes stale the next time a board is added.
        ...config,
        adminTokenSupply: { cap: config.adminTokenSupply?.cap ?? 10000000000 }, // schema default: 10,000,000,000
        // The legacy flat names the panels ask for, over the nested owners
        // above. These are aliases, not second owners — each one reads the
        // value it renames.
        minBet:                config.betLimits?.thirtyMin?.min   || 10,
        maxBet:                config.betLimits?.thirtyMin?.max   || 100000,
        max30MinBet:           config.betLimits?.thirtyMin?.max   || 100000,
        maxFullDayBet:         config.betLimits?.fullDay?.max     || 500000,
        minDeposit:            config.minDeposit            || 500,  // schema default: 500
        maxDeposit:            config.maxDeposit            || 50000,
        minWithdrawal:         config.minWithdrawal         || 500,
        maxWithdrawal:         config.maxWithdrawal         || 50000,
        maxWinningsWithdrawal: config.maxWinningsWithdrawal || 500000,
        // The INR peg, from its one owner. It was a literal here and in the
        // response below, a third and fourth declaration of a rule that already
        // had two.
        tokenBuyRate:          INR_TOKEN_RATE,
        tokenSellRate:         INR_TOKEN_RATE,
        // Risk Platform rules (Phase 010) — schema defaults cited inline
        payoutFeePercent:      config.payoutFeePercent ?? 0,  // schema default: 0
        // Bet funding split (Phase A) — % of each stake from reserveBalance
        betReservePercent:     config.betReservePercent ?? 1, // schema default: 1
        // Winnings platform fee (Phase A) — % of gross 2x retained at settlement
        winningsFeePercent:    config.winningsFeePercent ?? 1, // schema default: 1
        // Cycle duration (Phase X X-5) — short-block betting window length
        cycleDurationMinutes:  config.cycleDurationMinutes ?? 30, // schema default: 30
        // Data retention (Phase X X-7) — months of operational data kept
        retentionMonths:       config.retentionMonths ?? 6, // schema default: 6
        // Business Config Audit (2026-07-11) — formerly-hardcoded business values
        payoutMultiplier:      config.payoutMultiplier ?? 2,   // schema default: 2 (2x)
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
    const actor = { userId: req.user.userId, userName: req.user.username };

    const {
      minBet, maxBet, max30MinBet, maxFullDayBet,
      minDeposit, maxDeposit, minWithdrawal, maxWithdrawal, maxWinningsWithdrawal,
      kycRequired, registrationEnabled,
      maintenanceMode, maintenanceMessage,
      depositMethods, withdrawalMethods,
      webUrl, androidUrl, iosUrl, minVersion, latestVersion,
      payoutFeePercent, usdtPricing, merchantOrderLimits, riskRules, betReservePercent, winningsFeePercent,
      cycleDurationMinutes, retentionMonths,
      payoutMultiplier, cyclePhases,
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
    if (usdtPricing !== undefined) {
      const userMerchantBuy = usdtPricing.userMerchantBuyInr;
      const merchantAdminBuy = usdtPricing.merchantAdminBuyInr;
      if ((userMerchantBuy !== undefined && (typeof userMerchantBuy !== 'number' || !Number.isFinite(userMerchantBuy) || userMerchantBuy < 0)) ||
          (merchantAdminBuy !== undefined && (typeof merchantAdminBuy !== 'number' || !Number.isFinite(merchantAdminBuy) || merchantAdminBuy <= 0))) {
        return res.status(400).json({ success: false, message: 'USDT buy rates must be non-negative; merchant/admin buy rate must be greater than zero.' });
      }
      // ── A misplaced decimal here is a rail somebody drains ────────────────
      // `userMerchantBuyInr` prices EVERY USDT purchase, and the sizes are
      // large: 10,000 typed for 100 sells 500,000 tokens for 50 USDT, and the
      // first player to notice does not stop at one. 0 stays legal — it is the
      // schema default and the way to say "not set", which the rail refuses
      // outright rather than guessing at.
      //
      // The band comes from `tokenRates.js`, the one owner of what a USDT rate
      // means. A second copy of those numbers here would be a bound that
      // disagrees with the one the pricing path enforces.
      if (userMerchantBuy !== undefined && userMerchantBuy !== 0 && !isSaneUsdtRate(userMerchantBuy)) {
        return res.status(400).json({
          success: false,
          message: `A USDT rate must be between ₹${USDT_RATE_MIN_INR} and ₹${USDT_RATE_MAX_INR} per USDT, or 0 to leave it unset. `
            + `Got ₹${userMerchantBuy} — check for a misplaced decimal.`,
        });
      }
    }
    if (merchantOrderLimits !== undefined) {
      if (!merchantOrderLimits || typeof merchantOrderLimits !== 'object' || Array.isArray(merchantOrderLimits)) {
        return res.status(400).json({ success: false, message: 'merchantOrderLimits must be an object.' });
      }
      const currentConfig = await getSystemConfig();
      const validateUsdtLimitPair = (label, minKey, maxKey) => {
        const minUsdt = merchantOrderLimits[minKey];
        const maxUsdt = merchantOrderLimits[maxKey];
        const effectiveMinUsdt = minUsdt ?? currentConfig?.merchantOrderLimits?.[minKey] ?? 100;
        const effectiveMaxUsdt = maxUsdt ?? currentConfig?.merchantOrderLimits?.[maxKey] ?? 0;
        const invalidProvided =
          (minUsdt !== undefined && (typeof minUsdt !== 'number' || !Number.isFinite(minUsdt))) ||
          (maxUsdt !== undefined && (typeof maxUsdt !== 'number' || !Number.isFinite(maxUsdt)));
        const invalidEffective =
          effectiveMinUsdt < 100 || effectiveMinUsdt % 10 !== 0 ||
          effectiveMaxUsdt < 0 || effectiveMaxUsdt % 10 !== 0 ||
          (effectiveMaxUsdt !== 0 && effectiveMaxUsdt < effectiveMinUsdt);
        if (invalidProvided || invalidEffective) {
          return `${label} USDT limits require min >= 100, min/max multiples of 10, and max either 0 (unlimited) or >= min.`;
        }
        return null;
      };
      const limitError =
        validateUsdtLimitPair('User token purchase', 'minUserTokenPurchaseUsdt', 'maxUserTokenPurchaseUsdt') ||
        validateUsdtLimitPair('Merchant admin-token', 'minAdminTokenPurchaseUsdt', 'maxAdminTokenPurchaseUsdt');
      if (limitError) {
        return res.status(400).json({ success: false, message: limitError });
      }
    }
    if (riskRules?.maxFundingOrdersPerHour !== undefined &&
        (!Number.isInteger(riskRules.maxFundingOrdersPerHour) || riskRules.maxFundingOrdersPerHour < 0)) {
      return res.status(400).json({ success: false, message: 'riskRules.maxFundingOrdersPerHour must be a non-negative integer.' });
    }
    // 0 disables it; 60 is one per second, past which the window stops meaning
    // anything. Bounds match the spec so the route refuses before the write does.
    if (riskRules?.maxDepositOrdersPerMinute !== undefined &&
        (!Number.isInteger(riskRules.maxDepositOrdersPerMinute)
         || riskRules.maxDepositOrdersPerMinute < 0 || riskRules.maxDepositOrdersPerMinute > 60)) {
      return res.status(400).json({ success: false, message: 'riskRules.maxDepositOrdersPerMinute must be a whole number between 0 and 60 (0 = off).' });
    }
    // ── Business Config Audit fields ──────────────────────────────────────────
    if (riskRules?.maxWarnings !== undefined &&
        (!Number.isInteger(riskRules.maxWarnings) || riskRules.maxWarnings < 0)) {
      return res.status(400).json({ success: false, message: 'riskRules.maxWarnings must be a non-negative integer (0 = never mark for review).' });
    }
    if (payoutMultiplier !== undefined &&
        (!Number.isInteger(payoutMultiplier) || payoutMultiplier < 1 || payoutMultiplier > 10)) {
      return res.status(400).json({ success: false, message: 'payoutMultiplier must be an integer between 1 and 10.' });
    }
    // Every declared board, not two of three. The ceiling on each one's
    // earliest phase is a property of the BOARD and lives on its META entry;
    // it was two literals here, and the one-minute board — the 60-second block
    // where an oversized merge is easiest to enter — had no check at all
    // because its phases were not admin-reachable.
    for (const phasesKey of Object.keys(SYSTEM_CONFIG_SPEC.fields.cyclePhases?.fields ?? {})) {
      if (cyclePhases?.[phasesKey] === undefined) continue;
      const maxMerge = MAX_MERGE_BEFORE_END_SEC[phasesKey];
      if (maxMerge === undefined) {
        // A board declared in the spec with no META entry cannot be validated,
        // and §18.1 says an unknown type fails loudly rather than defaulting.
        return res.status(400).json({ success: false, message: `cyclePhases.${phasesKey} has no declared block length; it cannot be validated.` });
      }
      const err = validateCyclePhaseSet(phasesKey, cyclePhases[phasesKey], maxMerge);
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

    // ── Every OTHER setting the spec declares, accepted by declaration ──────
    // This pass runs FIRST and the bespoke block below overwrites anything it
    // touches (a later entry for the same path wins), so nothing here can
    // bypass a validator or a normalisation that already exists. What it does
    // is stop a DECLARED setting from being unreachable just because nobody
    // added a line: `withdrawalHoldMinutes`, both `loadShedding` ceilings and
    // all eight `ipDefense` fields were read by live middleware and writable by
    // no route at all — two of them under a comment that called them
    // "admin-editable". See F-022.
    //
    // `internal` fields are skipped: `adminTokenSupply.minted` is the running
    // issuance total checked against the 10B cap, and an operator who could set
    // it to 0 could re-authorise the whole supply.
    //
    // The spec still validates every value and its bounds when the write is
    // applied, so an undeclared key or an out-of-range number is refused with
    // its path named, not silently stored.
    const collectDeclared = (node, body, path = []) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      for (const [key, decl] of Object.entries(node.fields ?? {})) {
        const value = body[key];
        if (value === undefined) continue;
        if (decl.type === 'group') { collectDeclared(decl, value, [...path, key]); continue; }
        if (decl.internal) continue;
        fieldWrites.push(['SystemConfig', [...path, key].join('.'), value]);
      }
    };
    collectDeclared(SYSTEM_CONFIG_SPEC, req.body);

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
    if (usdtPricing?.userMerchantBuyInr  !== undefined) fieldWrites.push(['SystemConfig', 'usdtPricing.userMerchantBuyInr', usdtPricing.userMerchantBuyInr]);
    if (usdtPricing?.merchantAdminBuyInr !== undefined) fieldWrites.push(['SystemConfig', 'usdtPricing.merchantAdminBuyInr', usdtPricing.merchantAdminBuyInr]);
    // ── EVERY declared limit is writable, derived from the SPEC ─────────────
    // Four of these were hand-listed and the rest were not, so an operator
    // could see `maxConsecutiveRejections` on the settings screen and could not
    // change it — and every limit added since (the response window, the two
    // unpaid-order caps, the cool-off) arrived unwritable for the same reason.
    // A hand list is a second declaration of what the group contains, and it is
    // always the older one.
    //
    // Derived from `SYSTEM_CONFIG_SPEC` instead, so a field is editable the
    // moment it is declared — the §28 rule, applied to a route: derive what a
    // thing accepts from the thing it is about. `applyConfig` validates each
    // value against that same spec's bounds on the way in, so nothing here has
    // to restate them either.
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
    if (riskRules?.maxDepositOrdersPerMinute !== undefined) fieldWrites.push(['SystemConfig', 'riskRules.maxDepositOrdersPerMinute', riskRules.maxDepositOrdersPerMinute]);
    // Business Config Audit (2026-07-11) — formerly-hardcoded values, now admin-owned
    // Review threshold — consumed by users.admin.routes GET /users/flagged to
    // mark a flagged player for review. It does NOT block: a merchant rejection
    // passes 0 deliberately, so nothing a merchant can reach closes an account.
    if (riskRules?.maxWarnings !== undefined) fieldWrites.push(['SystemConfig', 'riskRules.maxWarnings', riskRules.maxWarnings]);
    // Payout multiplier — consumed by markets/gameEngine.js via riskValidation.computeWinningsPayout
    if (payoutMultiplier   !== undefined) fieldWrites.push(['SystemConfig', 'payoutMultiplier', payoutMultiplier]);
    // The payment order window is NOT here. It moved to
    // payment_mode_policies.processing_window_seconds, because the two
    // settlement rails have different timelines by design and one global number
    // cannot express that. Edited at POST /api/admin/payment-mode.
    // Cycle phase offsets — consumed (cached) by markets/cycleGenerator.getCyclePhases.
    // Written per-type as a whole validated subdocument.
    // Validated above, board by board; written the same way. Only the four
    // declared offsets are carried across, so a stray key in the body cannot
    // ride along into the document.
    for (const phasesKey of Object.keys(SYSTEM_CONFIG_SPEC.fields.cyclePhases?.fields ?? {})) {
      if (cyclePhases?.[phasesKey] === undefined) continue;
      fieldWrites.push(['SystemConfig', `cyclePhases.${phasesKey}`, {
        mergeBeforeEndSec:     cyclePhases[phasesKey].mergeBeforeEndSec,
        equalizerBeforeEndSec: cyclePhases[phasesKey].equalizerBeforeEndSec,
        closeBeforeEndSec:     cyclePhases[phasesKey].closeBeforeEndSec,
        celebrateBeforeEndSec: cyclePhases[phasesKey].celebrateBeforeEndSec,
      }]);
    }
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

    // ONE transaction for the whole save. Written one field at a time, an
    // out-of-range value committed everything before it and abandoned
    // everything after it — the admin was told the save failed and reloaded
    // into a form half-changed, with nothing saying which half (§21). The spec
    // now validates the whole patch before anything is written.
    const byModel = new Map();
    for (const [modelName, path, value] of fieldWrites) {
      if (!byModel.has(modelName)) byModel.set(modelName, []);
      byModel.get(modelName).push([path, value]);
    }
    for (const [modelName, entries] of byModel) {
      await setConfigFields(modelName, entries, actor, {
        justification: 'Admin bulk system config update via /system/config',
      });
    }

    if (global.io) {
      const updatedConfig = await getSystemConfig();
      const broadcastPayload = {
        minBet:          updatedConfig.betLimits?.thirtyMin?.min   || 10,
        maxBet:          updatedConfig.betLimits?.thirtyMin?.max   || 100000,
        maxFullDayBet:   updatedConfig.betLimits?.fullDay?.max     || 500000,
        minDeposit:      updatedConfig.minDeposit            || 500,  // schema default: 500
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
        tokenBuyRate:    INR_TOKEN_RATE,
        tokenSellRate:   INR_TOKEN_RATE,
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
    // `respondError` routes on the PRESENCE of `err.status` (§2). A spec
    // violation carries 400 and names the field and its bound, which is the
    // only form of this message an operator can act on; anything else is still
    // logged in full and answered with nothing.
    return respondError(res, error, 'PUT /admin/system/config', {
      message: 'Failed to update system config',
    });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🎮 FIX (Audit #29) — ADMIN MANAGE CYCLE
 * Frontend admin panel calls: POST /api/admin/manage-cycle
 * ════════════════════════════════════════════════════════════════════════════
 */
/*
 * REMOVED — the three /api/admin/download/* routes.
 *
 * The AUDIT note that used to sit here said /download/android and
 * /download/ios "were REMOVED from here ... server.js versions are canonical".
 * They had not been. The note described an intention; the routes were still
 * mounted, and a comment claiming a deletion that did not happen is worse than
 * no comment, because the next reader trusts it.
 *
 * server.js serves GET /api/download/android and /api/download/ios, PUBLIC and
 * unauthenticated, which is the only way they can work: a browser following a
 * download link carries no admin token, so the authenticated copies here would
 * have 401'd every real click.
 *
 * /download/links was a third read of androidUrl and iosUrl. SystemSettings
 * already loads both from the system-config endpoint and edits them under App
 * Distribution, so this returned a stale second opinion about two fields that
 * already had an owner. §1 — one owner per value.
 */

// ── Withdrawal approvals live in the P2P order flow, not here ───────────────
// GET/POST /withdrawal-requests{,/:id/approve,/:id/reject} were removed on
// 2026-08-24 together with the parallel withdrawal system they served (see the
// note in domains/user/user.routes.js). No admin panel screen ever called them,
// so they could not approve or reject anything an operator could actually see.
// Withdrawals are PaymentOrders, reviewed through the merchant/admin order
// screens; the wallet side is domains/payment/withdrawalHold.service.js.


// NOTE: GET /stats is intentionally not registered here. The canonical
// admin stats endpoint is owned by domains/analytics/analytics.admin.routes.js
// and is mounted before this router. The previous system alias imported a
// non-exported getDashboardStats helper, so keeping it here created a latent
// runtime failure if route order changed.

router.get('/error-reports', authenticate, isAdmin, async (req, res) => {
  try {
    const reports = await db.operations.listFrontendErrors({ limit: 200 });
    res.json({ success: true, reports });
  } catch (err) {
    console.error('[error-reports] list failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch error reports' });
  }
});

router.delete('/error-reports', authenticate, isAdmin, async (req, res) => {
  try {
    // The count is reported. "All error reports cleared" for a delete that
    // removed nothing looks the same as one that removed nine hundred, so an
    // admin could not tell a clear from a no-op against an empty table.
    const cleared = await db.operations.clearFrontendErrors();
    res.json({ success: true, cleared, message: `${cleared} error report(s) cleared` });
  } catch (err) {
    console.error('[error-reports] clear failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to clear error reports' });
  }
});

// NOTE: the app-asset upload routes + ASSET_SLOTS that used to be declared here
// were dead in this module (the actual routes live in branding.admin.routes.js,
// which now owns those consts and an S3-backed implementation). Removed
// 2026-07-11 per §13 (no dead artifacts). The wallet-authority import that sat
// here went with the withdrawal-request routes on 2026-08-24, same rule.

export default router;
