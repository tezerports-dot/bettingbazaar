// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';

const systemConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  latestVersion: { type: String, default: '1.0.0' },
  minVersion: { type: String, default: '1.0.0' },
  maintenanceMode: { type: Boolean, default: false },
  maintenanceMessage: String,
  androidUrl: String,
  iosUrl: String,
  webUrl: String,
  // cdnImages field removed — superseded by the dedicated CDNImage collection.
  // branding.admin.routes.js line ~92 and audit.admin.routes.js line ~54
  // document the historical reason. Zero reads/writes outside the schema itself.
  // ✅ FIX: Support links object used in admin content routes
  supportLinks: {
    whatsapp: String,
    telegram: String,            // legacy single field (kept for back-compat)
    // Structured Telegram config (Phase-audit 2026-07-09) — all admin-editable
    // via PUT /api/admin/content/support-links, read by the user Support page.
    telegramUsername: String,    // e.g. @BettingBazaarSupport
    telegramGroupUrl: String,    // community group invite link
    telegramChannelUrl: String,  // announcements channel link
    email: String,
    helpCenterUrl: String,
    termsUrl: String,
    privacyUrl: String
  },
  // ── BET LIMITS (v5.0) — admin-controlled, read by bet.routes.js ──────────
  // Previously hardcoded as 10 / 100 (minBet) with no server-side maxBet.
  // Both values now come from DB so admin changes take effect immediately.
  betLimits: {
    thirtyMin: {
      min: { type: Number, default: 10 },
      max: { type: Number, default: 100000 }
    },
    fullDay: {
      min: { type: Number, default: 100 },
      max: { type: Number, default: 500000 }
    }
  },
  // ── DEPOSIT / WITHDRAWAL LIMITS — admin-controlled ───────────────────────
  minDeposit:            { type: Number, default: 100 },
  maxDeposit:            { type: Number, default: 50000 },
  minWithdrawal:         { type: Number, default: 500 },
  maxWithdrawal:         { type: Number, default: 50000 },
  maxWinningsWithdrawal: { type: Number, default: 500000 },
  // ── RISK PLATFORM RULES (BBEPS Phase 010) ─────────────────────────────────
  // Business Policy owns these numbers/toggles; domains/risk/
  // riskValidation.service.js is the enforcement authority that reads them.
  riskRules: {
    // Multiples-of-10 for buy/sell/bet amounts (2026-07-09 owner directive).
    enforceMultiplesOf10:     { type: Boolean, default: true },
    // Block betting both sides of one cycle (wash-bet prevention). Default
    // false = pre-Phase-010 behavior until an admin enables it.
    blockOppositeSideBetting: { type: Boolean, default: false },
    // Funding-order velocity limit per user per hour. 0 = off.
    maxFundingOrdersPerHour:  { type: Number, default: 0, min: 0 },
    // Auto-block a user after this many payment warnings (merchant rejects /
    // dispute losses). Was hardcoded 3 in merchant.routes.js. 0 = never
    // auto-block.
    maxWarnings:              { type: Number, default: 3, min: 0 },
  },
  // Payout fee % charged on withdrawals (0 = no fee, the default — behavior
  // unchanged until an admin sets it). Enforced by the Risk Platform,
  // recorded by the Revenue & Settlement Platform (PAYOUT_FEES account).
  payoutFeePercent: { type: Number, default: 0, min: 0, max: 100 },

  // ── CYCLE TIMING (Phase X X-5, 2026-07-10) ────────────────────────────────
  // Duration (minutes) of the recurring short market block — previously the
  // hardcoded 30*60*1000 in cycleGenerator.service.js. Admin-editable so the
  // betting-window length is not a code constant. MUST divide 60 evenly
  // (10/12/15/20/30/60) so blocks tile the hour cleanly and the {type,startTime}
  // uniqueness holds. NOTE: the cycle-type ENUM label '30_MIN' is a fixed
  // identifier used across models/UI/results — it does NOT rename when this
  // value changes; only the actual window length does. Read in the generator's
  // endTime math + block anchoring; the client timer already derives from
  // the server-provided endTime, so no client change is needed.
  cycleDurationMinutes: { type: Number, default: 30, min: 10, max: 60 },

  // ── DATA RETENTION (Phase X X-7, 2026-07-10) ──────────────────────────────
  // How many months of high-volume OPERATIONAL data (settled bets, completed
  // cycles, frontend error reports) to keep before the retention worker prunes
  // it. Financial/audit/user data is NEVER pruned (kept forever — see
  // RETENTION_POLICY.md). A hard 30-day safety floor applies regardless of
  // this value. Read by domains/operations/retention.service.js.
  retentionMonths: { type: Number, default: 6, min: 1, max: 120 },

  // ── BUSINESS CONFIG AUDIT (2026-07-11) — values that were hardcoded ───────
  // Payout multiplier: a winning bet pays stake × this (minus winningsFeePercent).
  // Default 2 = the historical 2x. Read by markets/gameEngine.js via Risk.
  payoutMultiplier: { type: Number, default: 2, min: 1, max: 10 },
  // Payment order window: minutes a user has to pay the assigned merchant
  // before the order auto-expires and refunds. Was hardcoded 15 in
  // paymentProcessing.service.js. Read there now.
  orderExpiryMinutes: { type: Number, default: 15, min: 1, max: 1440 },
  // Cycle phase timings — seconds BEFORE a cycle's end that each phase fires.
  // Was hardcoded in cycleGenerator.service.js. merge > equalizer > close >
  // celebrate > 0, and merge must be < the cycle duration. Read (cached) by
  // the generator. Full-day merges earlier than 30-min by default.
  cyclePhases: {
    thirtyMin: {
      mergeBeforeEndSec:     { type: Number, default: 180 },
      equalizerBeforeEndSec: { type: Number, default: 120 },
      closeBeforeEndSec:     { type: Number, default: 30 },
      celebrateBeforeEndSec: { type: Number, default: 10 },
    },
    fullDay: {
      mergeBeforeEndSec:     { type: Number, default: 300 },
      equalizerBeforeEndSec: { type: Number, default: 120 },
      closeBeforeEndSec:     { type: Number, default: 30 },
      celebrateBeforeEndSec: { type: Number, default: 10 },
    },
  },

  // ── BET FUNDING SPLIT (Phase A, 2026-07-10) ───────────────────────────────
  // % of every bet stake funded from reserveBalance; the remainder comes from
  // depositBalance first, then winningsBalance (fallbacks per owner spec §6).
  // Default 3 = the historical 97/3 split, now paise-exact and admin-editable
  // (was hardcoded Math.round(amount*0.97)/(amount*0.03) in bet.routes.js).
  // Read by bet.routes.js; arithmetic in riskValidation.computeBetFundingPlan.
  // Used at basis-point precision (max 2 decimals).
  betReservePercent: { type: Number, default: 3, min: 0, max: 100 },

  // ── WINNINGS PLATFORM FEE (Phase A, 2026-07-10) ──────────────────────────
  // % platform fee on gross winnings at cycle settlement (owner spec §6:
  // bet 100 → win 200 → fee ~2 → 198 net to winningsBalance). Default 1 per
  // the Phase A directive — this IS the intended business rule, previously
  // missing (flat 2x). Winners are credited NET; the retained fee stays in
  // Cycle.netProfit and flows to PLATFORM_REVENUE via BET_CYCLE_SETTLED.
  // Read by markets/gameEngine.js; arithmetic in
  // riskValidation.computeWinningsPayout. Basis-point precision (max 2 dp).
  winningsFeePercent: { type: Number, default: 1, min: 0, max: 100 },

  // ── FOOTER NAVIGATION (2026-07-13) — admin-editable page tabs ─────────────
  // Which pages appear in the user panel's bottom footer bar, in order. Keys
  // reference the frontend's page catalog (route strings/icons stay in code per
  // BUSINESS_CONFIG_AUDIT.md §4 — the SELECTION/order is the business decision,
  // so it lives here). Default = the historical five tabs, so behavior is
  // unchanged until an admin edits it. Validated against FOOTER_PAGE_KEYS in
  // system.admin.routes.js (2–5 distinct keys). Delivered to the user panel in
  // the system_config payload (socket + SSE + GET config) — applies live.
  footerPages: {
    type: [String],
    default: ['home', 'results', 'winners', 'promo', 'profile'],
  },

  // ── OPERATIONAL ALERT WEBHOOK (plan item 38, 2026-07-13) ──────────────────
  // Where money-critical failure alerts POST (Slack-compatible {text} JSON):
  // ledger reconciliation failures, settlement errors. Admin-editable so the
  // channel can be rotated without redeploy; env ALERT_WEBHOOK_URL is the
  // bootstrap fallback. Empty = alerting off. Read by services/alerting.service.js.
  alertWebhookUrl: { type: String, default: '' },

  // ── FEATURE FLAGS ─────────────────────────────────────────────────────────
  kycRequired:         { type: Boolean, default: true },
  registrationEnabled: { type: Boolean, default: true },
  depositMethods:      { type: [String], default: ['UPI', 'BANK_TRANSFER'] },
  withdrawalMethods:   { type: [String], default: ['UPI', 'BANK_TRANSFER'] },
  // ── QUEUE MANAGER MERCHANT POOL (BBEPS Phase 007 §7.4 "Exception Queue") ──
  // Curated set of 3–5 merchants eligible for MANUAL/FORCED order assignment.
  // Bounds queue.admin.routes.js's manual-assign endpoints so they never draw
  // from the full merchant pool merchantScoring.service.js uses for automatic
  // assignment — manual overrides stay confined to pre-vetted merchants only.
  // Empty array = not yet configured (manual assignment endpoints will refuse
  // to return candidates until an admin/queue_manager sets one via
  // PUT /api/admin/queue/merchant-pool).
  queueManagerPool: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Merchant' }],
    default: [],
  },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
});

// TokenRates model removed 2026-07-08 — token conversion is fixed 1:1
// (Phase 006 flattening, see ENTERPRISE_DECISIONS.md). The old `tokenrates`
// Mongo collection may still hold historical data; nothing reads or writes
// it anymore.

export const SystemConfig = mongoose.model('SystemConfig', systemConfigSchema);
