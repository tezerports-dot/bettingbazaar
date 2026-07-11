# Business Configuration Audit (2026-07-11)

**The question.** Is this an enterprise-admin-configurable platform, or are
business decisions baked into code? A repository is enterprise-admin
configurable only if **business decisions are stored in configuration rather
than code** — and if every such value has an admin UI, persists to the DB, is
read at runtime, has no silent hardcoded fallback, and is auditable.

**Verdict: PASS.** Every business rule flows from configuration. This audit
found four business values that were still hardcoded, moved them into
`SystemConfig`, wired their consumers to read them, exposed them in the admin
API + UI, and added them to the config catalog. What remains hardcoded is
strictly non-business plumbing (page sizes, HTTP codes, route strings, enum
labels, UI cosmetics) — hardcoding those is correct.

---

## 1. What this audit changed (the four that were still hardcoded)

| Value | Was | Now (config) | Consumer rewired to read it |
|---|---|---|---|
| **Payout multiplier** | `× 2` literal in `gameEngine.js` | `SystemConfig.payoutMultiplier` (default 2) | `gameEngine` → `Risk.computeWinningsPayout({multiplier})` |
| **Payment order expiry** | `15 * 60 * 1000` in `paymentProcessing.service.js` | `SystemConfig.orderExpiryMinutes` (default 15) | `paymentProcessing.tryAssignMerchant` (cached-read helper) |
| **Auto-block warning threshold** | `WARNING_THRESHOLD = 3` in `merchant.routes.js` | `SystemConfig.riskRules.maxWarnings` (default 3, `0` = never) | merchant reject handler via `getRiskRules()` |
| **Cycle phase timings** | inline `endTime − 3m/2m/30s/10s` in `cycleGenerator.service.js` | `SystemConfig.cyclePhases.{thirtyMin,fullDay}` | `cycleGenerator.updateCycleStatuses` (30s-cached read) |

Two correctness fixes fell out of the audit:

- **Stale claim corrected.** The config catalog asserted "`SystemConfig.payoutMultiplier`
  never existed — the 2× payout is a fixed product rule." That is no longer
  true; the catalog now lists `payoutMultiplier` as a real, admin-owned knob.
- **User-panel drift fixed.** The user game-config response hardcoded
  `payoutMultiplier: 2` even though it already loads `SystemConfig`; it now
  returns `config.payoutMultiplier`. (`GAME_CORE.ts`'s `MULTIPLIER` constant is
  a documented display/offline mirror — the server value is authoritative and is
  pushed to clients in the `system_config` event.)

Tests added: unit tests proving `computeWinningsPayout` honours a non-default
multiplier (net + fee == gross across multipliers 1–10); a gameEngine
integration test proving a config `payoutMultiplier: 3` pays 3× at settlement.

---

## 2. The full rule → config → UI → DB → runtime → audit chain

Every row is: a business decision, the config field that owns it, where an admin
edits it, where it persists, and the runtime authority that reads it. "No
hardcoded fallback" means the only fallback is the schema default (which *is* the
config), never an independently chosen business number.

### Betting & settlement (Markets + Risk)
| Rule | Config field | Admin UI | Runtime reader |
|---|---|---|---|
| Bet min/max (per cycle type) | `SystemConfig.betLimits.{thirtyMin,fullDay}.{min,max}` | System Settings | `bet.routes.js` via Risk |
| Payout multiplier | `SystemConfig.payoutMultiplier` | System Settings | `gameEngine` → `Risk.computeWinningsPayout` |
| Winnings platform fee % | `SystemConfig.winningsFeePercent` | System Settings | `gameEngine` → `Risk.computeWinningsPayout` |
| Bet funding reserve split % | `SystemConfig.betReservePercent` | System Settings | `bet.routes.js` → `Risk.computeBetFundingPlan` |
| Cycle duration (window length) | `SystemConfig.cycleDurationMinutes` | System Settings | `cycleGenerator` |
| Cycle phase timings | `SystemConfig.cyclePhases.*` | System Settings | `cycleGenerator` (cached) |
| Multiples-of-10 enforcement | `SystemConfig.riskRules.enforceMultiplesOf10` | System Settings | `Risk` validators |
| Opposite-side bet block | `SystemConfig.riskRules.blockOppositeSideBetting` | System Settings | `Risk` (bet placement) |

### Funding, withdrawals & risk
| Rule | Config field | Admin UI | Runtime reader |
|---|---|---|---|
| Deposit min/max | `SystemConfig.minDeposit`, `maxDeposit` | System Settings | funding/payment creation via Risk |
| Withdrawal min/max, winnings cap | `SystemConfig.minWithdrawal`, `maxWithdrawal`, `maxWinningsWithdrawal` | System Settings | withdrawal creation via Risk |
| Withdrawal payout fee % | `SystemConfig.payoutFeePercent` | System Settings | `Risk.computePayoutFeeMinor` → ledger |
| Funding velocity (orders/hr) | `SystemConfig.riskRules.maxFundingOrdersPerHour` | System Settings | `Risk.assessFundingOrder` |
| Payment order expiry | `SystemConfig.orderExpiryMinutes` | System Settings | `paymentProcessing.tryAssignMerchant` |
| Auto-block warning threshold | `SystemConfig.riskRules.maxWarnings` | System Settings | merchant reject handler |
| Deposit/reserve split + reserve usage (per currency) | `DepositPolicy` (versioned) | Business Policy → Deposit Policy | `paymentOrder` pre-save + approve path |
| Enabled deposit/withdrawal methods | `SystemConfig.depositMethods`, `withdrawalMethods` | System Settings | funding UI + validation |
| Funding providers (P2P/USDT/gateway) | `providerRegistry` adapters + `PaymentGatewayConfig` | code adapter + registry | `fundingAuthority` |

### Merchant, referral & bonuses
| Rule | Config field | Admin UI | Runtime reader |
|---|---|---|---|
| Merchant performance bonus (on/%/min volume) | `MerchantBonusPolicy` (versioned) | Merchant Platform | bonus engine |
| Per-merchant order limits | `Merchant.maxConcurrentOrders` | Merchants list | `merchantScoring` assignment |
| Manual-assign merchant pool (queue sizing) | `SystemConfig.queueManagerPool` | Queue admin | queue manual-assign routes |
| Referral commission rates / min bet / on-off | `ReferralConfig.{f1Rate,f2Rate,f3Rate,minBetForCommission,commissionEnabled}` | `PUT /api/referral/config` | referral commission on bet |
| Merchant bonus pool funding | Revenue & Settlement (distributable only) | Revenue console | `issueMerchantBonus` |

### Platform, lifecycle & content
| Rule | Config field | Admin UI | Runtime reader |
|---|---|---|---|
| Maintenance mode / message | `SystemConfig.maintenanceMode`, `maintenanceMessage` | System Settings | maintenance middleware |
| KYC required, registration open | `SystemConfig.kycRequired`, `registrationEnabled` | System Settings | auth / KYC gate |
| App URLs + min/latest version | `SystemConfig.webUrl/androidUrl/iosUrl/minVersion/latestVersion` | System Settings | version gate / download |
| Data retention window | `SystemConfig.retentionMonths` | System Settings | `retention.service` |
| Product feature flags | `FEATURE_*` env / runtime override / CDN hydrate | featureFlags service | flag checks |
| Branding (colors/logos/names/banners) | `Branding` document | Branding admin | all panels |
| App assets (PWA icons/logos/splash) | `AppAsset` + S3/disk | Branding → App Assets | PWA manifest / clients |
| Support links, chat rules, promos | CMS documents | content admin endpoints | user surfaces |

**Token pricing** is intentionally **not** a rate knob: buy/sell were flattened
to a fixed 1:1 conversion by an explicit product decision (Phase 006, see
`ENTERPRISE_DECISIONS.md`). This is a governed decision recorded in the catalog,
not an unmanaged hardcode.

---

## 3. The 7-point checklist, answered

1. **Every business rule comes from config** — ✅ See §2. The four remaining
   hardcodes were moved this pass.
2. **Every config has an admin UI** — ✅ `SystemConfig` values are on the System
   Settings page (money rules, risk rules, cycle timing incl. the new phase
   editor, order expiry, auto-block threshold, payout multiplier); policy docs
   have their own editors; branding/CMS have theirs.
3. **Every admin UI writes to the DB** — ✅ `SystemConfig` writes go through
   `setConfigField` (versioned) → `SystemConfig` document. Policy docs use their
   own versioned services. No settings page writes to memory-only state.
4. **Every service reads centralized config** — ✅ Settlement, funding,
   withdrawal, bet placement, cycle generation, merchant assignment, retention,
   and the merchant auto-block all read their numbers from `SystemConfig`/policy
   docs at runtime — not from module constants.
5. **No duplicated config** — ✅ Each value has one owning authority.
   `getRiskRules()` is the single reader for the risk-owned numbers;
   `getCyclePhases()`/`getCycleDurationMinutes()` are the single readers for
   cycle timing. Display mirrors (`GAME_CORE.ts`, socket payloads) are explicitly
   labelled as mirrors of the server value, not second sources of truth.
6. **No silent hardcoded fallback** — ✅ Every fallback in the readers is the
   schema default (i.e. the config's own default), commented as such, per
   governance §5 ("every server-side fallback must literally match the schema
   default"). There are no independently chosen business numbers hiding in
   `?? <n>` fallbacks.
7. **All changes auditable** — ✅ `setConfigField` records a `ConfigVersion`
   (previousValue, newValue, who, when, justification) for every change, with
   history/rollback. The new fields (incl. the whole-subdocument `cyclePhases`
   writes) go through the same path.

---

## 4. What is deliberately hardcoded — and why that's correct

These are **not** business decisions; hardcoding them is the right call and
keeping them out of admin config avoids fake configurability:

- **Pagination sizes / batch sizes** (`PAGE_SIZE`, settlement `BATCH_SIZE`) —
  performance tuning, not policy.
- **Debounce/throttle intervals, cron tick periods** — implementation cadence.
  (Business-meaningful *durations* like the order-expiry window and cycle phase
  timings ARE config; the 1s status-tick and 60s reconciler intervals are not.)
- **HTTP status codes, route strings, event names** — protocol/wiring.
- **Enum labels** (`'30_MIN'`, `'FULL_DAY'`, side names, order statuses) — stable
  identifiers shared across models/UI/results; renaming them is a code change by
  definition, and the *cycle length* is separately configurable from the label.
- **UI colors/icons/spacing in code** — cosmetic; brand-level colors/logos are
  separately configurable via the Branding document.
- **Idempotency-key formats, ledger account codes, validation regexes** —
  correctness invariants, not tunables.
- **Fixed 1:1 token conversion** — a governed product decision (documented),
  deliberately not a rate knob.

---

## 5. Phantom bets & the phantom manager — placement verified

(Raised alongside this audit.) The phantom system is correctly placed and
internally consistent, and its one timing knob is now config-driven:

- **Access is admin-granted.** `User.phantomAccess ∈ {NONE,30_MIN,FULL_DAY,BOTH}`
  (default NONE), set only via `POST /api/admin/users/:id/phantom-access`
  (`isAdmin`).
- **Placement is house-only and moves no money.** `POST /api/bet/phantom`
  refuses anyone without matching `phantomAccess`, writes `isPhantom: true` with
  zero balance deduction, and updates only the `phantomDelhi/phantomBombay` pool
  counters (and the combined totals shown to users).
- **Phantom bets never pay.** Every settlement query in `gameEngine.js` filters
  `isPhantom: false` — winner selection, loss marking, and WON aggregation all
  exclude phantom rows, so a phantom bet structurally cannot be credited.
- **The equalizer is display-only.** `cycleGenerator.runPhantomEqualizer` fires
  in the equalizer phase and sets both phantom pools to their `max()` so the
  public combined view looks balanced (admins see the true split via
  admin-only events); it runs once per cycle (`phantomBetsClosed` guard). **That
  equalizer moment is `cyclePhases.*.equalizerBeforeEndSec`** — so this audit
  also made the phantom-manager timing admin-configurable, where before it was
  the hardcoded "2 minutes before end."

---

## 6. How to verify (single source of truth)

`GET /api/admin/operations/config-catalog` returns every configurable business
value, its owning authority, and the exact endpoint that edits it. Governance
treats that catalog as the enforcement index: **if a value isn't in the catalog,
it must not exist as a business constant in code.** The four values added this
pass are now in it.
