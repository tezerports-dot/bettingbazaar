// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/configSpec.js — what every configuration setting IS.
 *
 * One declaration per setting: its default, its type, and its bounds. This is
 * the whole of the configuration contract, and it is enforced on WRITE by
 * `configPg.js`.
 *
 * ── Why this file exists rather than a column per setting ───────────────────
 * Configuration changes shape when the business changes. A column per toggle
 * turns "the owner wants a new limit" into a schema migration, and the settings
 * live in JSONB instead. What replaces the column constraints is this spec.
 *
 * It is STRICTLY STRONGER than the schema it replaces, in two ways that both
 * cost real bugs:
 *
 *   1. AN UNDECLARED KEY IS REFUSED. The document model silently discarded a
 *      write to a path it did not declare, so a misspelled setting reported
 *      success and changed nothing — for as long as nobody checked the value
 *      it was supposed to have changed.
 *
 *   2. BOUNDS ARE ENFORCED ON EVERY WRITE. Mongoose `min`/`max` on a nested
 *      path is validated on a document save and SKIPPED ENTIRELY by an update
 *      operator, which is what the admin routes use. A payout fee of 900% or a
 *      negative reserve percentage was accepted by every one of them. Both feed
 *      money arithmetic.
 *
 * A default declared here is the value a fresh install starts from AND the
 * value a reader falls back to when the key is absent — one constant, not two.
 */

/**
 * Cycle phase offsets, in seconds BEFORE a cycle's end, per type.
 *
 * ── This is the only copy ──────────────────────────────────────────────────
 * These numbers were declared three times: as schema defaults, again in
 * `cycleGenerator.service.js` as its fallback, and again in
 * `routes/admin/cycles.admin.routes.js` to draw the phase timeline. Three
 * copies of one constant, and this one had ALREADY DRIFTED: the admin route
 * said the 30-minute block closed betting 60s before the end while the
 * generator closed it at 30s, so the panel drew a boundary the engine did not
 * honour.
 *
 * The invariant every set must satisfy: merge > equalizer > close >
 * celebrate >= 0, and merge < the cycle's duration.
 */
export const DEFAULT_CYCLE_PHASES = Object.freeze({
  // 1-minute block: merge 12s before the end, equalize at 9s, close betting at
  // 5s, declare at 3s, celebrate 3s→0. Betting is open for 55 of 60 seconds.
  // The close→celebrate window is only 2s wide and the status tick runs at 1s,
  // so a slow tick can miss the CLOSED transition; the phase logic tolerates
  // that by letting a still-OPEN cycle complete directly rather than stalling.
  oneMin:    Object.freeze({ mergeBeforeEndSec: 12,  equalizerBeforeEndSec: 9,   closeBeforeEndSec: 5,  celebrateBeforeEndSec: 3 }),
  thirtyMin: Object.freeze({ mergeBeforeEndSec: 180, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 }),
  // Full-day merges earlier than the 30-minute block by default.
  fullDay:   Object.freeze({ mergeBeforeEndSec: 300, equalizerBeforeEndSec: 120, closeBeforeEndSec: 30, celebrateBeforeEndSec: 10 }),
});

/** A number setting: `n(default, min, max)`. Bounds are inclusive. */
const n = (def, min = null, max = null) => ({ type: 'number', default: def, min, max });
/** A boolean setting. */
const b = (def) => ({ type: 'boolean', default: def });
/** A string setting. */
const s = (def = '') => ({ type: 'string', default: def });
/** An array-of-strings setting. */
const sa = (def = []) => ({ type: 'string[]', default: def });
/** A nested group of settings. */
const group = (fields) => ({ type: 'group', fields });

const phaseGroup = (d) => group({
  mergeBeforeEndSec:     n(d.mergeBeforeEndSec, 0),
  equalizerBeforeEndSec: n(d.equalizerBeforeEndSec, 0),
  closeBeforeEndSec:     n(d.closeBeforeEndSec, 0),
  celebrateBeforeEndSec: n(d.celebrateBeforeEndSec, 0),
});

const surgeGroup = () => group({
  // 0 = OFF, and that is the default: a ceiling set before the owner knows the
  // endpoint's normal baseline sheds legitimate traffic.
  windowSec: n(60, 1), max: n(0, 0),
});

/**
 * The system configuration — one document, key 'main'.
 *
 * Every setting the platform reads at runtime. Grouped exactly as the callers
 * index into it (`cfg.riskRules.maxWarnings`), because renaming a path is a
 * change to 200 call sites and none of them are the point of this migration.
 */
export const SYSTEM_CONFIG_SPEC = group({
  latestVersion: s('1.0.0'),
  minVersion:    s('1.0.0'),
  maintenanceMode:    b(false),
  maintenanceMessage: s(''),
  androidUrl: s(''), iosUrl: s(''), webUrl: s(''),

  supportLinks: group({
    whatsapp: s(''),
    telegram: s(''),              // legacy single field, kept for back-compat
    telegramUsername:   s(''),
    telegramGroupUrl:   s(''),
    telegramChannelUrl: s(''),
    email: s(''), helpCenterUrl: s(''), termsUrl: s(''), privacyUrl: s(''),
  }),

  // The 1-minute block shares the 30-minute stake bounds and chip ladder — same
  // game, shorter window. Declared explicitly rather than falling through, so
  // raising one block's ceiling cannot silently raise the other's.
  betLimits: group({
    oneMin:    group({ min: n(10, 0),  max: n(100000, 0) }),
    thirtyMin: group({ min: n(10, 0),  max: n(100000, 0) }),
    fullDay:   group({ min: n(100, 0), max: n(500000, 0) }),
  }),

  minDeposit:            n(100, 0),
  maxDeposit:            n(50000, 0),
  minWithdrawal:         n(500, 0),
  maxWithdrawal:         n(50000, 0),
  maxWinningsWithdrawal: n(500000, 0),

  // Minted merchant inventory may never exceed the cap.
  adminTokenSupply: group({ cap: n(10000000000, 0), minted: n(0, 0) }),

  // Platform defaults for per-type merchant concurrency; a merchant's own
  // override lives on the merchant row.
  merchantOrderLimits: group({
    maxConcurrentDepositOrders:    n(1, 1, 10),
    maxConcurrentWithdrawalOrders: n(1, 1, 10),
    minAdminTokenPurchase:     n(50000, 1),
    minUserTokenPurchaseUsdt:  n(100, 100),
    maxUserTokenPurchaseUsdt:  n(0, 0),      // 0 = unlimited
    minAdminTokenPurchaseUsdt: n(100, 100),
    maxAdminTokenPurchaseUsdt: n(0, 0),      // 0 = unlimited
  }),

  riskRules: group({
    enforceMultiplesOf10:     b(true),
    blockOppositeSideBetting: b(false),
    maxFundingOrdersPerHour:  n(0, 0),       // 0 = off
    maxWarnings:              n(3, 0),       // 0 = never auto-block
  }),

  // ── The four that feed money arithmetic ───────────────────────────────────
  // Every one of these was writable out of range through an update operator,
  // because Mongoose skips min/max there. They are bounded on write now.
  payoutFeePercent:      n(0, 0, 100),
  betReservePercent:     n(1, 0, 100),
  winningsFeePercent:    n(1, 0, 100),
  payoutMultiplier:      n(2, 1, 10),

  // Minutes a confirmed WITHDRAWAL stays frozen before the player's locked
  // stake is consumed and the merchant's tokens become spendable. 0 disables
  // the hold — a deliberate escape hatch, not a recommendation: at 0 a
  // dishonest merchant holds liquid tokens the instant they press confirm.
  // Capped at 24h because the player is waiting on money they have given up.
  withdrawalHoldMinutes: n(60, 0, 1440),

  usdtPricing: group({
    userMerchantBuyInr:  n(0, 0),
    merchantAdminBuyInr: n(1, 0.01),
  }),

  // MUST divide 60 evenly so blocks tile the hour cleanly. The type label
  // '30_MIN' is a fixed identifier and does NOT rename when this changes.
  cycleDurationMinutes: n(30, 10, 60),
  orderExpiryMinutes:   n(15, 1, 1440),
  retentionMonths:      n(6, 1, 120),

  cyclePhases: group({
    oneMin:    phaseGroup(DEFAULT_CYCLE_PHASES.oneMin),
    thirtyMin: phaseGroup(DEFAULT_CYCLE_PHASES.thirtyMin),
    fullDay:   phaseGroup(DEFAULT_CYCLE_PHASES.fullDay),
  }),

  footerPages: sa(['home', 'results', 'winners', 'promo', 'profile']),
  alertWebhookUrl: s(''),

  loadShedding: group({
    enabled:           b(true),
    maxInFlight:       n(300, 0),   // 0 = unbounded
    maxEventLoopLagMs: n(0, 0),     // 0 = lag shedding off
  }),

  ipDefense: group({
    enabled:          b(true),
    subnetMultiplier: n(8, 1),
    surge: group({ auth: surgeGroup(), withdrawal: surgeGroup(), funding: surgeGroup() }),
  }),

  tlsFingerprintDefense: group({
    enabled:        b(true),
    logOnly:        b(true),
    requireJa3Hash: b(false),
    blockJa3Hashes: sa([]),
  }),

  kycRequired:         b(true),
  registrationEnabled: b(true),
  depositMethods:      sa(['UPI', 'BANK_TRANSFER']),
  withdrawalMethods:   sa(['UPI', 'BANK_TRANSFER']),

  // Curated 3–5 merchants eligible for MANUAL assignment. Bounds the manual
  // endpoints so they never draw from the full pool automatic assignment uses.
  // Empty = not yet configured, and the endpoints refuse until an admin sets it.
  queueManagerPool: sa([]),
});

/** Branding — colours, logos, the platform's name. */
export const BRANDING_SPEC = group({
  platformName: s('Betting Bazaar'),
  logoUrl: s(''), faviconUrl: s(''), splashUrl: s(''),
  primaryColor: s('#0EA5E9'), secondaryColor: s('#111827'), accentColor: s('#F59E0B'),
  loginBannerUrl: s(''), homeBannerUrl: s(''),
  footerText: s(''), tagline: s(''),
});

/** Support links surfaced on the user Support page. */
export const SUPPORT_LINKS_SPEC = group({
  whatsapp: s(''), telegram: s(''), telegramUsername: s(''),
  telegramGroupUrl: s(''), telegramChannelUrl: s(''),
  email: s(''), helpCenterUrl: s(''), termsUrl: s(''), privacyUrl: s(''),
});

/**
 * The deposit policy — what a deposit is split into.
 *
 * The reserve share is money arithmetic: it decides how much of every deposit
 * lands in a pocket the player cannot withdraw. Bounded on write.
 */
export const DEPOSIT_POLICY_SPEC = group({
  enabled: b(false),
  reservePercent: n(0, 0, 100),
  minDepositForSplit: n(0, 0),
  note: s(''),
});

/** Merchant bonus policy — the spread a merchant earns per completed order. */
export const MERCHANT_BONUS_POLICY_SPEC = group({
  enabled: b(false),
  depositBonusPercent:    n(0, 0, 100),
  withdrawalBonusPercent: n(0, 0, 100),
  minOrderForBonus: n(0, 0),
  maxBonusPerOrder: n(0, 0),
  note: s(''),
});

/** Chat room configuration — the public room's rules. */
export const CHAT_ROOM_CONFIG_SPEC = group({
  enabled: b(true),
  slowModeSeconds: n(3, 0, 3600),
  maxMessageLength: n(280, 1, 4000),
  minAccountAgeMinutes: n(0, 0),
  bannedWords: sa([]),
  pinnedMessage: s(''),
});

/** Daily check-in rewards. */
export const CHECKIN_CONFIG_SPEC = group({
  enabled: b(true),
  // Reward per consecutive day, index 0 = day 1. Rupees.
  dayRewards: { type: 'number[]', default: [5, 10, 15, 20, 25, 30, 50] },
  resetOnMiss: b(true),
  maxStreak: n(7, 1, 365),
});

/** Every scope this store serves, and the spec that governs it. */
export const SCOPES = Object.freeze({
  system:               SYSTEM_CONFIG_SPEC,
  branding:             BRANDING_SPEC,
  supportLinks:         SUPPORT_LINKS_SPEC,
  depositPolicy:        DEPOSIT_POLICY_SPEC,
  merchantBonusPolicy:  MERCHANT_BONUS_POLICY_SPEC,
  chatRoomConfig:       CHAT_ROOM_CONFIG_SPEC,
  checkInConfig:        CHECKIN_CONFIG_SPEC,
});
