// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * operations.admin.routes.js — OPERATIONS PLATFORM (BBEPS Phase 012).
 *
 * ORCHESTRATION-ONLY, OWNS NO DATA (locked decision, 2026-07-03): every
 * number below is read live from the platform that owns it. This is the
 * enterprise control center's API: one overview for monitoring
 * (settlement / treasury / funding / risk / merchant), and the config
 * catalog — the index of every configurable business value and the owning
 * authority + endpoint that edits it. Nothing is configured HERE; this
 * surface points at the platform that configures it.
 */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { runRetention } from './retention.service.js';
import { getTrialBalance, getDistributableRevenueMinor } from '../revenue/revenueSettlement.service.js';
import { ACCOUNTS, toRupees } from '../revenue/chartOfAccounts.js';
import { listProviders } from '../funding/providerRegistry.js';
import { getRiskRules } from '../risk/riskValidation.service.js';
import { getActivePolicy } from '../configuration/depositPolicy.service.js';
import { getActiveBonusPolicy } from '../configuration/merchantBonusPolicy.service.js';
import { getMerchantLeaderboard } from '../merchant/merchantAnalytics.service.js';
import { listChannels } from '../communication/communication.service.js';
import { FLAGS, isEnabled } from '../../services/featureFlags.service.js';

const router = express.Router();

// GET /api/admin/operations/overview — the enterprise dashboard payload.
router.get('/operations/overview', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const [trial, distributableMinor, depositPolicy, bonusPolicy, riskRules,
           topMerchants, pendingOrders, openDisputes] = await Promise.all([
      getTrialBalance(),
      getDistributableRevenueMinor(),
      getActivePolicy('INR'),
      getActiveBonusPolicy(),
      getRiskRules(),
      getMerchantLeaderboard({ days: 7, limit: 5 }),
      db.orders.orderCounts(),
    ]);

    const bal = code => toRupees(trial.accounts[code]?.reportedMinor ?? 0);

    res.json({
      success: true,
      overview: {
        // ── Settlement monitoring (Revenue & Settlement Platform) ─────────
        settlement: {
          ledgerIntegrityOk: trial.integrityOk,
          platformRevenue: bal(ACCOUNTS.PLATFORM_REVENUE.code),
          distributableRevenue: toRupees(distributableMinor),
          payoutFees: bal(ACCOUNTS.PAYOUT_FEES.code),
        },
        // ── Treasury monitoring (derived account balances) ────────────────
        treasury: {
          externalFiat: bal(ACCOUNTS.EXTERNAL_FIAT.code),
          userFundsLiability: bal(ACCOUNTS.USER_FUNDS.code),
          platformReserve: bal(ACCOUNTS.PLATFORM_RESERVE.code),
          merchantBonusPool: bal(ACCOUNTS.MERCHANT_BONUS_POOL.code),
          merchantFundsLiability: bal(ACCOUNTS.MERCHANT_FUNDS.code),
        },
        // ── Funding monitoring (Funding Platform) ─────────────────────────
        funding: {
          providers: listProviders(),
          openOrders: pendingOrders,
          disputedOrders: openDisputes,
        },
        // ── Risk monitoring (Risk Platform / Business Policy numbers) ─────
        risk: riskRules,
        // ── Policy management (Business Policy Platform) ──────────────────
        policies: {
          depositPolicy: depositPolicy
            ? { version: depositPolicy.version, deposit: depositPolicy.depositAllocationPercent, reserve: depositPolicy.reserveAllocationPercent }
            : null,
          merchantBonusPolicy: bonusPolicy
            ? { version: bonusPolicy.version, enabled: bonusPolicy.enabled, bonusPercent: bonusPolicy.bonusPercent }
            : null,
        },
        // ── Merchant operations (Merchant Platform) ───────────────────────
        merchants: { top7d: topMerchants },
        // ── Communication + product flags ─────────────────────────────────
        communication: { channels: listChannels() },
        productFlags: Object.fromEntries(
          await Promise.all(['LIVE_CASINO', 'SPORTSBOOK', 'GAMES_PLATFORM', 'EVENT_FEEDS', 'ODDS_ENGINE']
            .map(async f => [f, await isEnabled(FLAGS[f])]))),
      },
    });
  } catch (error) {
    console.error('Operations overview error:', error);
    res.status(500).json({ success: false, message: 'Failed to build operations overview' });
  }
});

// GET /api/admin/operations/config-catalog — every configurable business
// value, its owning authority, and the endpoint that edits it. THE index
// enforcing "no hardcoded percentages/limits/providers/rules": if a value
// isn't in this catalog, it isn't configurable and must not exist as a
// business constant in code (docs/governance/04-GOVERNANCE.md §2/§3).
router.get('/operations/config-catalog', authenticate, isAdminOrSubAdmin, async (req, res) => {
  res.json({ success: true, catalog: [
    { value: 'Deposit/reserve split + reserve usage rules (per currency)', owner: 'Business Policy — DepositPolicy', edit: 'PUT /api/admin/deposit-policy/:currency' },
    { value: 'Merchant Performance Bonus (enabled, %, min matched volume)', owner: 'Business Policy — MerchantBonusPolicy', edit: 'PUT /api/admin/merchant-bonus-policy' },
    { value: 'Bet limits (per cycle type)', owner: 'Business Policy — SystemConfig.betLimits', edit: 'PUT /api/admin/system/config' },
    { value: 'Deposit/withdrawal min/max', owner: 'Business Policy — SystemConfig', edit: 'PUT /api/admin/system/config' },
    { value: 'Payout fee %', owner: 'Business Policy — SystemConfig.payoutFeePercent (enforced by Risk, recorded by R&S)', edit: 'PUT /api/admin/system/config' },
    { value: 'Risk rules (multiples-of-10, opposite-side block, velocity/hour, auto-block warnings)', owner: 'Business Policy — SystemConfig.riskRules incl. maxWarnings (enforced by Risk; auto-block in merchant reject)', edit: 'PUT /api/admin/system/config' },
    // Phase A (2026-07-10): the two core betting money rules, now configurable.
    { value: 'Bet funding split — reserve % of each stake', owner: 'Business Policy — SystemConfig.betReservePercent (arithmetic in Risk computeBetFundingPlan)', edit: 'PUT /api/admin/system/config' },
    { value: 'Winnings platform fee % (settlement)', owner: 'Business Policy — SystemConfig.winningsFeePercent (arithmetic in Risk computeWinningsPayout, paid by gameEngine)', edit: 'PUT /api/admin/system/config' },
    // Business Config Audit (2026-07-11): payout multiplier is now a real config
    // knob (was hardcoded 2x in gameEngine); the winnings fee % remains separate.
    { value: 'Payout multiplier (winning bet pays stake × N, before fee)', owner: 'Business Policy — SystemConfig.payoutMultiplier (arithmetic in Risk computeWinningsPayout, paid by gameEngine)', edit: 'PUT /api/admin/system/config' },
    // Business Config Audit (2026-07-11): payment order window, was hardcoded 15m.
    { value: 'Payment order expiry (minutes to pay assigned merchant)', owner: 'Business Policy — SystemConfig.orderExpiryMinutes (read by payment/paymentProcessing)', edit: 'PUT /api/admin/system/config' },
    // Business Config Audit (2026-07-11): cycle phase timings, were hardcoded.
    { value: 'Cycle phase timings (merge/equalizer/close/celebrate offsets, per type)', owner: 'Business Policy — SystemConfig.cyclePhases (read cached by markets/cycleGenerator)', edit: 'PUT /api/admin/system/config' },
    // Phase X X-5: short-block cycle duration, previously hardcoded.
    { value: 'Cycle duration (short-block betting window, minutes)', owner: 'Business Policy — SystemConfig.cycleDurationMinutes (read by markets/cycleGenerator)', edit: 'PUT /api/admin/system/config' },
    // Phase X X-7: operational-data retention window.
    { value: 'Data retention (months of settled bets/cycles/error-reports kept)', owner: 'Business Policy — SystemConfig.retentionMonths (read by operations/retention.service)', edit: 'PUT /api/admin/system/config' },
    { value: 'Merchant bonus pool funding', owner: 'Revenue & Settlement (from distributable revenue only)', edit: 'POST /api/admin/revenue/bonus-pool/fund' },
    { value: 'Per-merchant order limits + wallet top-ups', owner: 'Merchant Platform', edit: 'PUT /api/admin/merchants/:id (limits) / POST /api/admin/merchants/:id/fund' },
    { value: 'Funding providers (P2P / USDT / gateways)', owner: 'Funding Platform — providerRegistry adapters', edit: 'code adapter + registry entry (activation is a deploy, not a constant)' },
    { value: 'Casino game providers (Evolution, Pragmatic, ...)', owner: 'Casino Platform — GameProvider documents', edit: 'PUT /api/admin/game-providers/:key' },
    { value: 'Communication channels', owner: 'Communication Platform — channelRegistry adapters', edit: 'code adapter (activation gated by config/flags)' },
    { value: 'Product feature flags', owner: 'featureFlags.service.js (env FEATURE_* / runtime override / CDN hydrate)', edit: 'environment or hydrateFromConfig' },
    { value: 'Maintenance mode/message, KYC required, registration, app URLs/versions', owner: 'Business Policy — SystemConfig', edit: 'PUT /api/admin/system/config' },
    // Footer navigation (2026-07-13): which pages appear in the user panel's bottom bar.
    { value: 'User-panel footer navigation tabs (2–5 pages, ordered)', owner: 'Business Policy — SystemConfig.footerPages (read by user panel Footer via system_config)', edit: 'PUT /api/admin/system/config' },
    // Operational alerting (2026-07-13): where money-critical failure alerts go.
    { value: 'Operational alert webhook URL (ledger/settlement failures)', owner: 'Business Policy — SystemConfig.alertWebhookUrl (read by services/alerting.service.js; env ALERT_WEBHOOK_URL bootstrap fallback)', edit: 'PUT /api/admin/system/config' },
    { value: 'Branding (colors, logos, names, banners)', owner: 'Branding document (§3/§12)', edit: 'PUT /api/admin/branding' },
    { value: 'Chat rules, support links, promo content', owner: 'CMS domain documents', edit: 'respective /api/admin content endpoints' },
  ]});
});

// POST /api/admin/operations/retention/run — prune operational data now.
// Body: { dryRun?: boolean, months?: number }. dryRun (default true) only
// COUNTS; pass dryRun:false to actually delete. Admin-only. Financial/audit/
// user data is never reachable from the retention service (X-7).
router.post('/operations/retention/run', authenticate, isAdmin, async (req, res) => {
  try {
    const dryRun = req.body?.dryRun !== false; // default to a safe preview
    const months = req.body?.months;
    const outcome = await runRetention({ months, dryRun });
    res.json({ success: true, ...outcome });
  } catch (error) {
    console.error('Retention run error:', error);
    res.status(500).json({ success: false, message: 'Failed to run retention' });
  }
});

export default router;
