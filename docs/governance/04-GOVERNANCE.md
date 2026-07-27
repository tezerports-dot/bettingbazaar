# GOVERNANCE.md — Betting Bazaar Monorepo
<!-- AUTO-HEADER: Every AI session and human developer must read this file before editing any
     file in this repository. This is not optional — it is the contractual ground truth for
     all architectural decisions. See §0 for the mandatory pre-edit checklist. -->

**Status:** This document supersedes the pre-existing `ARCHITECTURE.md` wherever the two
disagree. During this audit, three specific claims in `ARCHITECTURE.md` were checked against
the actual code and found incorrect (P2P state machine names; "private channels are SSE-only"
as a universal claim; "single `setToken()` call site"). Until `ARCHITECTURE.md` is corrected
or retired, treat this file as authoritative for anything it covers.

**Authority chain (updated 2026-07-02, approved):** The Betting Bazaar Enterprise Platform
Specification (BBEPS) is now the senior authority for this repository. Where BBEPS and this
document disagree, BBEPS wins. This document remains binding as the implementation-level
ruleset that enforces BBEPS against this specific codebase.

This document is binding for all future changes to the repository, human or AI-assisted.

---

## 0. Mandatory Pre-Edit Checklist (AI and Human)

Before editing **any** file in this repository, you must:

1. Read this entire document to the end.
2. Identify which section governs the change you are making.
3. Confirm the change does not violate any rule in §§1–14.
4. If the change introduces a new authority, add it to §1.
5. If the change removes a file, confirm it is not imported anywhere (verify with grep).
6. If the change adds a real-time event, check §11 for the canonical event-name list.
7. If the change touches branding, read §3 and §12 in full before writing a single line.
8. If the change is to the backend wallet, read §7 before writing a single line.

**For AI sessions specifically:** You cannot assume your context window contains the complete
current state of the codebase. Always verify target text exists before generating a patch.
Verify with the exact string, not a paraphrase. If you cannot verify, say so and ask.

---

## 1. Allowed Authorities

Each value below has exactly one allowed owner. Nothing else in the codebase may store,
compute, or default this value independently.

| Value | Allowed Owner |
|---|---|
| Token buy/sell rates | **REMOVED 2026-07-08** — token conversion is fixed 1:1 (1 BB token = ₹1), not configurable. The `TokenRates` model, its admin endpoints (`/api/admin/token-rates`), and the admin UI page are gone; public rate endpoints remain but return constant 1/1/0 for client compatibility. Do not reintroduce configurable rates — see §20 (Decision Log) 2026-07-08. |
| Deposit/reserve wallet split, reserve usage rules (per currency) | `DepositPolicy` model (`domains/configuration/depositPolicy.model.js`) — whole-document versioned, written only via `depositPolicy.service.js`. **Corrected 2026-07-08:** `merchantCommissionPercent`/`commissionFundingSource` were removed — merchant incentive pay is cycle-completion-triggered (Merchant Performance Bonus), not deposit-triggered, and does not belong on this policy. See the "Merchant earnings model" line below. |
| Bet min/max (per cycle type) | `SystemConfig.betLimits` |
| Deposit/withdrawal limits (platform-wide) | `SystemConfig` |
| Per-merchant order min/max | `Merchant.minOrder` / `Merchant.maxOrder` (edited per-merchant from admin) |
| Merchant settlement rail (INR-only vs USDT-only) | `Merchant.acceptedCurrencies` — **exactly one** entry, `["INR"]` or `["USDT"]` (schema validator, 2026-07-27). An INR merchant settles by UPI + bank; a USDT merchant settles by TRC-20 address; never both. Vocabulary + TRC-20 format check live in `domains/merchant/merchantCurrency.js` (`MERCHANT_CURRENCIES`, `isTrc20Address`, `merchantTypeOf`) — do not re-declare the rail strings or a second address regex. `Merchant.merchantType` is a **derived read-only virtual** over this field, never a second stored copy. Admin writes it via `PUT /api/admin/merchants/:id/capabilities` (`merchantType` or `acceptedCurrencies`); consumers: `merchantScoring.selectBestMerchant` (assignment), `POST /api/merchant/accept/:id` (claim guard), `GET /api/merchant/orders` (open-pool filter), `PUT /api/merchant/profile` (which credentials are editable), the merchant panel and the admin Merchants → Limits tab. |
| Which rail an order settles on | `PaymentOrder.currency` — enum `MERCHANT_CURRENCIES`, schema default `'INR'`. Matched against the merchant's rail at assignment and at accept. `PaymentOrder.userUsdtAddress` is the USDT-rail counterpart of `userBankDetails` (withdrawal payout destination). |
| Merchant token capacity (buy orders) | `Merchant.tokenBalance` (current wallet) |
| Merchant token capacity (sell orders) | Lifetime initial top-up (tracked in merchant wallet history) |
| Referral commission rates | `CommissionLevel.f1Rate` only — F2/F3 not implemented (H-03) |
| Merchant earnings model | **The buy/sell spread is retired (2026-07-08, fixed 1:1 conversion)** — new orders carry `merchantProfit: 0`. `Merchant.commissionRate` remains retired; the interim `DepositPolicy.merchantCommissionPercent` mechanism was removed 2026-07-08 before ever being consumed. The go-forward mechanism is the **Merchant Performance Bonus**: triggered by completed buy+sell cycles (matched volume = `min(deposit, withdrawal)` per merchant), a % of that matched volume, funded from platform revenue, NEVER deducted from users/deposits/withdrawals. **Built** (Phase 008, 2026-07-09): engine `domains/merchant/merchantBonus.service.js` + `MerchantBonusPolicy` (Business Policy, the `bonusPercent`/`enabled` authority) + admin routes (`/api/admin/merchant-bonus-policy`, pool funding) + `MerchantPlatform` admin UI + the 10-min `bonus-engine` cron. Ships **dormant** — the policy is disabled and the `MERCHANT_BONUS_POOL` unfunded until an admin sets `bonusPercent`, enables it, and funds the pool from distributable revenue. See §20 (Decision Log) 2026-07-09 Phase 008. Do not reintroduce `Merchant.commissionRate`, a rate spread, or a deposit-triggered commission. |
| Sub-admin permission keys | `User.subAdminPermissions` schema — frontend imports from `utils/permissions.ts` |
| Chat rules (cooldown, length, banned words) | Chat config document via `/api/chat/config` |
| Branding (colors, logo, names, banners) | `Branding` document — **see §3 and §12** |
| Banner/promo URLs | `Branding` document (tricksTipsBannerUrl, rulesPageImageUrl, etc.) |
| Social/support links | `SupportLinks` document — **NOT Branding** (H-04 fix) |
| Homepage/banner content order | `PromoContent.priority` field |
| Wallet balance mutations (user) | `walletAuthority.service.js` exclusively |
| Merchant token balance mutations | `merchantWallet.service.js` exclusively (Merchant Platform, Phase 008) — writes `MerchantWalletLedger`, idempotent txIds |
| Money movement in/out of the ecosystem (deposits, withdrawals, providers) | `fundingAuthority.service.js` (Funding Platform, Phase 009) — routes call requestDeposit/requestWithdrawal; providers live in `providerRegistry.js`. Never owns accounting (R&S derives ledger entries from completed orders). |
| USDT buy-only pricing (user↔merchant buy and merchant↔admin buy) | `SystemConfig.usdtPricing` — buy-only rates. `userMerchantBuyInr` is for the future user/merchant USDT buy rail; `merchantAdminBuyInr` is consumed by the merchant admin-token purchase workflow. No USDT sell rail exists for users or merchants. |
| Merchant Performance Bonus percentage/threshold/enablement | `MerchantBonusPolicy` (Business Policy Platform) — engine in `domains/merchant/merchantBonus.service.js` READS it, owns no numbers |
| User-facing notifications (all channels) | `domains/communication/communication.service.js` `notify()` (Communication Platform, Phase 012) — channels are adapters in `channelRegistry.js`; never call `Notification.create` directly |
| Transaction/bet validation + operational rules (positive/numeric/multiples-of-10, limits enforcement, reserve-split rounding, opposite-side restriction, velocity limits, payout-fee arithmetic) | `domains/risk/riskValidation.service.js` (Risk Platform, Phase 010) — the ONLY place validation logic lives. Routes/services call `assessFundingOrder`/`assessBet`/`computeReserveSplit`; no inline validation of these rules anywhere else. Configurable numbers/toggles stay in `SystemConfig.riskRules` / `payoutFeePercent` / `betLimits` (Business Policy). |
| Settlement ledger / accounting events (completed bets & payouts, platform revenue, reserve deductions, payout fees, merchant bonus funding) | `AccountingEvent` model (`domains/revenue/accountingEvent.model.js`), written ONLY via `revenueSettlement.service.js` (Revenue & Settlement Platform, Phase 007). Append-only double-entry, integer paise, unique idempotency keys; balances always derived from postings, never stored. This is the ACCOUNTING authority — it never mutates wallet balances (walletAuthority keeps §7) and owns no configurable percentages (Business Policy Platform keeps those). |
| P2P order lifecycle state | `P2POrder.status` enum: `PENDING_QUEUE, ASSIGNED, PROCESSING, PAID, COMPLETED, DISPUTED, CANCELLED, FAILED` |
| Dispute resolution | `P2POrder` embedded fields — resolved. `Dispute` model removed. (I-01) |
| Cycle timing | `domains/markets/cycleGenerator.service.js` computes (Markets Platform, Phase 011 — formerly domains/game/); `GAME_CORE.ts` mirrors for display math only |
| Game catalogue (games, categories, display/launch metadata) | `Game` + `GameCategory` (`domains/gameRegistry/`) — the SOLE source of the game catalogue (2026-07-11). Frontends render from `GET /api/game/games` + `/categories`; NO hardcoded game arrays anywhere (the ex-`GAME_CATALOGUE`/`CRASH_GAMES` are removed). References `GameProvider` by key and reuses the casino launch/session/wallet/`GameTransaction` spine — owns no provider logic and no money movement. |
| Trading vocabulary (market sides, position/settlement statuses) | `domains/trading/tradingModels.js` — products and Risk import from it; no re-declared side/status strings |
| Product settlement integration | Products persist SOURCE RECORDS only; `revenueSettlement.service.js` derives ledger entries (see tradingModels.js contract). No product writes accounting. |
| Auth tokens | One storage key per app (`auth_token` / `merchantToken` / `admin-auth`) |
| Routes/navigation | One `ADMIN_ROUTES`/`ROUTES` constants module per panel |
| Real-time event names | Backend constants module — see §11 |
| Daily check-in reward amounts | **Removed** — check-in feature deleted (I-02) |
| App version | `package.json` only — read via `import.meta.env.VITE_APP_VERSION` |

---

## 2. Forbidden Patterns

- **No frontend hardcoded business value that has a backend config equivalent.**
  `constants.ts.MIN_BET` is the canonical example — removed in M-03. `sysConfig.minBet` is the
  runtime authority. A `??` fallback must equal the schema default, never an independent number.
- **No admin-editable field without a real consumer.** If a value can be changed via an admin
  API/UI but nothing reads it to alter actual behavior, that is a violation. Current instances:
  all fixed in this patch. Any new admin setting must include, in the same PR, the frontend
  consumer that reads it and changes real behavior.
- **No shadow model/collection duplicating another's responsibility.** `Dispute` model removed;
  social links in Branding removed (H-04). `SupportLinks` is the sole social-link authority.
- **No frontend enum/constant mirror with zero consumers.**
- **No second write path to a value with a designated single-writer service.**
  Wallet writes: `walletAuthority.service.js` only. (Token rates are no longer writable at all — fixed 1:1 since 2026-07-08.)
- **No real-time event emitted under more than one name for the same logical state change.**
- **No private real-time channel without a verified backend registration route.**
- **No version literal in any component source file.** Version lives in `package.json` and
  is injected at build time via `VITE_APP_VERSION`. (L-03, H-07)

---

## 3. No-Hardcode Rules

- Any number representing a business rule must originate from a DB-backed config document.
  A `??` fallback is permitted as a loading placeholder only if its value equals the schema
  default — verified by a code comment citing the schema field and default value.
- **Any color, font, logo path, or app name shown to end users must originate from `Branding`,
  injected as a CSS variable (`--brand-primary`, `--brand-secondary`, `--brand-accent`) or via
  the `app_branding` localStorage key.** Never typed as a hex literal in a component file.
  This rule is currently being remediated (C-03). The 126 instances of `#D4AF37` in 29 files
  must be converted to `var(--brand-primary)` using the script at
  `scripts/apply-brand-variables.sh`.
- Any route path string must originate from the route-constants module.
- Any permission key, status enum, or event name must originate from a shared module.

---

## 4. No-Duplicate Rules

- Before adding a constant, enum, or config field, search the codebase. Extend the existing one.
- Before adding an admin-editable setting, confirm a real consumer reads it in the same PR.
- Before adding a real-time event, grep existing event names for typo variants.
- Frontend enum mirrors of backend enums require a code comment citing the exact backend
  file and field, plus an entry in §1.

---

## 5. Configuration Ownership Rules

- `SystemConfig` owns platform-wide operational limits.
- `Merchant.minOrder` / `Merchant.maxOrder` own per-merchant order caps. Admin edits these
  via the merchant Limits tab. They are NOT hardcoded defaults — each merchant has their own.
- Every config field exposed via an admin PUT route must have its default in exactly one place
  (the Mongoose schema `default:`). Every server-side fallback must match that default.
  **Citation required:** add a code comment like `// schema default: 500` next to every `??` or
  `||` fallback value. If you don't know the schema default, look it up before writing the code.
- Config cached client-side must document its staleness window in a code comment at the cache
  definition. `GameProviderContext`'s 5-minute TTL is documented per M-02.

---

## 6. Workflow Ownership Rules

- A workflow (KYC approval, merchant approval, dispute resolution, order lifecycle) has exactly
  one state field per logical question.
- **Dispute resolution: RESOLVED.** `P2POrder` embedded fields (`disputeStatus`, `disputeReason`,
  `disputeResolvedAt`) are the single authority. The `Dispute` model was removed. (I-01)
- Cron jobs must be verified to run against the collection the real workflow populates.

---

## 7. Balance Ownership Rules

- All wallet balance reads/writes go through `walletAuthority.service.js`.
- No route handler performs a raw `$inc`, `$set`, or read-then-write on a balance field.
- Settlement math (`gameEngine.js`) computes amounts; it calls the wallet authority service.
- **F1 referral commission only:** F2/F3 commission config fields were removed from the schema.
  `gameEngine.js` pays F1 only. Admin UI shows F1 config only. (H-03)

---

## 8. Route Ownership Rules

- Each frontend has exactly one route-constants module:
  - User panel: `user-panel/src/constants.ts` → add `ROUTES` export as needed
  - Admin panel: `admin-panel/src/utils/constants.ts` → `ADMIN_ROUTES` object (L-02)
  - Merchant panel: `merchant-panel/src/constants.ts` → `ROUTES` object
- All `<Route>` tables, nav menus, and route guards import path strings from it.

---

## 9. Admin Ownership Rules

- Every field on an admin settings page must, in the same feature, wire to a real consumer.
- Admin panel **applies its own branding** — `App.tsx` subscribes to `branding` socket events
  and sets `--brand-primary`, `document.title`, and `localStorage.app_branding`. (C-02)
- Admin-facing dashboard statistics must read from the collection the workflow actually writes to.

---

## 10. Exception Handling Rules

- A genuine UI-only convenience value (chip denominations, display-only countdown) is allowed
  to remain a frontend constant **provided:** (a) it is never used for server-side validation,
  and (b) it is labeled in a comment as intentionally UI-only, citing this section.
- A temporary TODO duplicating a value during an in-progress migration is allowed for the
  shortest practical window, tracked in an issue, removed in the same change that completes it.
- Display-only timing mirrors (`GAME_CORE.ts`) are allowed when actual gating is server-side.

---

## 11. Real-Time Event Registry

All socket.io events emitted by the backend are listed below. **One name per logical change.**
Any new event must be added here in the same PR that introduces it.

| Event name | Direction | Payload | Notes |
|---|---|---|---|
| `branding` | server→client | Branding document fields | On connect and after PUT /branding |
| `branding_updated` | server→client | `{ branding, timestamp }` | After admin saves branding |
| `system_config` | server→client | SystemConfig fields | On connect and after PUT /system/config |
| `new_cycle` | server→client | Cycle snapshot | When cycleGenerator starts a new cycle |
| `cycle_update` | server→client | Cycle snapshot | Periodic tick / phase change |
| `cycle_result` | server→client | `{ winner, cycleId }` | When result is declared |
| `order_update` | server→client | P2POrder snapshot | After any P2POrder status change |
| `new_order` | server→merchant | P2POrder snapshot | When a new order enters queue |
| `chat_message` | bidirectional | ChatMessage | P2P chat messages |
| `withdrawal_approved` | server→user | `{ requestId, amount }` | After admin approves |
| `withdrawal_rejected` | server→user | `{ requestId, amount, reason }` | After admin rejects |
| `merchant_limits_updated` | server→admin | `{ merchantId, limits }` | After admin updates limits |
| `queue_order_update` | server→admin | PaymentOrder snapshot | Via private /api/sse/admin/events |
| `kyc_update` | server→admin | KYC submission data | Via private /api/sse/admin/events |
| `admin_new_cycle` | server→admin | Cycle snapshot | Via private /api/sse/admin/events |
| `admin_cycle_result` | server→admin | `{ winner, cycleId }` | Via private /api/sse/admin/events |
| `queue_snapshot` | server→admin | Pending orders array | On connect to admin SSE |
| `merchant_status_changed` | server→admin | `{ merchantId, status }` | Via private /api/sse/admin/events |
| `merchant_orders_snapshot` | server→merchant | Active orders array | On connect to merchant SSE |
| `new_order` | server→merchant | PaymentOrder snapshot | Via private /api/sse/merchant/events |
| `merchant_stats` | server→merchant | Balance/earnings snapshot | Via private /api/sse/merchant/events |
| `deposit_policy_updated` | server→admin | `{ currency, policy }` | After PUT/approve/rollback on `/api/admin/deposit-policy/:currency` |

**Merchant panel `SOCKET_EVENTS.ORDER_UPDATE` must equal `'order_update'`** (H-02 fix). The
constant in `merchant-panel/src/constants.ts` is the canonical value — do not use string
literals in OrderManagement.tsx or any other merchant file.

---

## 12. Branding Pipeline — Cross-Panel Authority

This section is the canonical answer to GAP-1 (the 3-way broken chain). Every panel follows
the same bootstrap sequence:

**Backend (single source of truth):**
1. `Branding` MongoDB document (key=`'main'`) holds all branding fields.
2. `sendBranding()` in `socketHandlers.js` reads the `Branding` document and pushes the full
   payload on every client connect. It is the **sole constructor** of the branding socket payload.
   It must **never** emit hardcoded filenames or colors.
3. `PUT /api/admin/branding` saves **all** Branding schema fields via `$set` spread, then
   re-emits `branding_updated` with the full document so all panels update live.

**All three frontends (user, admin, merchant):**
1. On `branding` socket event: store payload in `localStorage.app_branding`.
2. Apply `--brand-primary` (and `--brand-secondary`, `--brand-accent`) as CSS variables on
   `document.documentElement`.
3. Set `document.title` to the appropriate panel name field
   (`userPanelName` / `adminPanelName` / `merchantPanelName`).
4. On `branding_updated` socket event: repeat steps 1–3 with `event.branding`.

**Admin panel additionally:**
- `Layout.tsx` reads `adminPanelName` from `localStorage.app_branding` for the sidebar header.
- `Login.tsx` reads version from `VITE_APP_VERSION` (built from `package.json`), not a literal.

**Logo URL construction:**
```
cdnBase = branding.cdnBaseUrl.replace(/\/+$/, '')
logo    = branding.logo.startsWith('http')
          ? branding.logo
          : cdnBase + '/' + branding.logo.replace(/^\/+/, '')
```
Never concatenate `cdnBase + '/' + logo` without normalising both sides (C-07 fix).

**Branding fields that must have real consumers (GOVERNANCE §2):**

| Field | Consumer |
|---|---|
| `logo` | Header.tsx, ShareModal.tsx, admin Layout.tsx |
| `icon` | `public/manifest.json` (PWA, manual or build step) |
| `favicon` | `<link rel="icon">` in `index.html` (injected at runtime or build) |
| `primaryColor` | `--brand-primary` CSS variable |
| `secondaryColor` | `--brand-secondary` CSS variable |
| `accentColor` | `--brand-accent` CSS variable |
| `userPanelName` | `document.title` in user panel, App.tsx |
| `adminPanelName` | `document.title` in admin panel, admin Login.tsx, Layout.tsx |
| `merchantPanelName` | `document.title` in merchant panel |
| `homePopupImageUrl` | GameContext.tsx or HomePage modal (implement consumer) |
| `homePopupEnabled` | Same — gate display on this boolean |
| `tricksTipsBannerUrl` | PromoPage.tsx banner (C-06 fix) |
| `rulesPageImageUrl` | RulesPage.tsx banner (C-06 fix) |
| `depositPageBannerUrl` | WalletModal.tsx buy-tokens section |
| `withdrawalPageBannerUrl` | WalletModal.tsx sell-tokens section |
| `loginPageBannerUrl` | AuthModal.tsx or Login page background |
| `registerPageBannerUrl` | AuthModal.tsx register tab |
| `betCardDelhiImageUrl` | redesign `GameScreen` DELHI bet-card background (resolved via `getAssetUrl`) |
| `betCardBombayImageUrl` | redesign `GameScreen` BOMBAY bet-card background (resolved via `getAssetUrl`) |

---

## 13. Dead Artifact Policy (GAP-3)

**No committed artifact may describe a pending fix that is not yet applied.**

Rules:
1. Patch files (`.patch`) must be applied and deleted before merge. Never commit patch files
   to `main`. If a patch is pending, it lives in a branch or PR — not in the repo root.
2. Fix scripts (`apply-changes.sh`, any `*.sh` that applies code changes) must be applied
   and deleted before merge. One-off scripts are not repository assets.
3. Migration scripts (`backend/migrations/*.js`, `backend/scripts/migrate-*.js`) must be
   deleted after confirmed successful application in all environments. If a migration has not
   yet been applied, it must carry a comment: `// STATUS: PENDING — do not run until [env] is ready`.
   If applied everywhere: delete it. There is no in-between state.
4. `TODO` comments citing a specific fix (e.g., `// FIX-7:`) must be resolved in the same PR
   that introduces the fix. Permanent TODO comments are not allowed in production code.
5. This rule is enforced by adding a pre-commit hook check (see `scripts/check-dead-artifacts.sh`).

Applied to this patch:
- `apply-changes.sh` → **deleted** (H-05)
- `0003-fix-p2pchat.patch` → **deleted** (H-05)
- `backend/migrations/001*.js` and `002*.js` → marked APPLIED, must be deleted after prod confirm
- `backend/scripts/migrate-wallet-system.js` → marked APPLIED, must be deleted after prod confirm

---

## 14. Monorepo Structure and Future Split Readiness (GAP-2)

This is currently a monorepo with three frontends (`user-panel/`, `admin-panel/`, `merchant-panel/`)
and one backend (`backend/`). The governance below ensures any future separation into three
independent deployable repos is achievable without re-architecting.

**Cross-panel authority rules (how each panel bootstraps shared values):**

All shared configuration originates from the backend API/WebSocket — never from shared source
files copied between panels. This ensures a future split (where each panel is its own repo)
requires no governance changes:

| Shared value | Backend authority | Panel bootstraps via |
|---|---|---|
| Branding | `Branding` model | Socket `branding` event → `localStorage.app_branding` |
| System config | `SystemConfig` model | Socket `system_config` event |
| Token rates | Fixed 1:1 constant (2026-07-08) — no model | Socket `system_config` event (reports constant 1/1) |
| Support links | `SupportLinks` model | REST `GET /api/content/support-links` |
| Permission keys | `User.subAdminPermissions` | JWT payload on login |
| Routes | Each panel's own `constants.ts` | Import-time constant |

**What each panel owns independently (safe to split):**
- Its own `package.json`, `vite.config.ts`, `tailwind.config.js`
- Its own route constants (`ADMIN_ROUTES`, `ROUTES`)
- Its own auth token storage key (`admin-auth`, `auth_token`, `merchantToken`)
- Its own `VITE_APP_VERSION` (from its own `package.json`)

**What must NOT be shared between panels as source-level imports:**
- No panel imports a TypeScript file from another panel's `src/` directory.
- No panel imports from `backend/` Node.js source files.
- Shared types (if needed) live in a future `packages/shared-types/` package — not in any panel's `src/`.

**Split procedure (when needed):**
1. Copy each panel directory to its own repo.
2. Copy `backend/` to its own repo.
3. Update `VITE_API_URL` env vars to point to the deployed backend.
4. No governance changes required — cross-panel authority already flows through the backend.

---

## 15. File Header Requirement (Additional)

Every source file in this repository must include, within the first 10 lines, a reference
to this governance document so that any AI session or developer that opens the file in
isolation is immediately directed to read it.

Preferred format (adapt to language):
```
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
```

For files created before this rule was introduced: the requirement applies on first edit.
An AI that opens a file without this header must add it before making other changes.

This requirement exists because AI sessions frequently receive a single file as context
without the surrounding codebase. The header is the safety net that prevents architectural
drift when GOVERNANCE.md is not in the prompt.

---

## 16. Platform Currency & Reproducibility Rules (owner-approved 2026-07-13)

Adopted from ARCHITECTURE_AUDIT_2026.md §7 (proposals P-1…P-4), all four approved
by the owner on 2026-07-13. Enforcement items are queued as AQ-5/AQ-7 in that audit.

1. **Runtime currency (P-1).** Production runs only supported LTS runtimes and
   supported major versions of security-load-bearing dependencies (web framework,
   auth libraries, database drivers). An EOL runtime or framework in production is
   a launch/operate **blocker**, not a backlog item. CI must pin and prove the same
   versions production runs — a CI matrix that tests a version production doesn't
   use satisfies nothing.
2. **Reproducible deploys (P-2).** Production builds install from the committed
   lockfile (`npm ci`). A deploy pipeline that resolves dependency ranges at build
   time (`npm install` against semver ranges) is invalid — production must run
   exactly what CI tested.
3. **Audit cadence (P-3).** The subsystem-by-subsystem comparison in
   ARCHITECTURE_AUDIT_2026.md is re-run quarterly, or immediately upon any
   major-version EOL announcement affecting the stack. Findings are appended to
   that file's changelog; the A–F verdict framework in its header is the method.
4. **Research artifacts are committed (P-4).** Any research, plan, or numbered
   queue that gates implementation work is committed to the repository in the same
   session that produces it. Conversation context and session containers are
   ephemeral; the repo is the only durable medium. (Adopted after a prior session's
   implementation list was lost with its container — only its commits survived.)

---

## Appendix: Issue Resolution Log

| Issue | Status | Fix |
|---|---|---|
| C-01 | Fixed | PUT /branding saves all 18+ fields via $set spread |
| C-02 | Fixed | Admin App.tsx subscribes to branding events; Layout/Login use branding |
| C-03 | Partial | Key game components fixed; full 29-file sweep via apply-brand-variables.sh |
| C-04 | Fixed | sendBranding() reads DB; hardcoded asset dict removed |
| C-05 | Fixed | tokenBuyRate/tokenSellRate removed from SystemSettings |
| C-06 | Fixed | PromoPage, RulesPage read banner URLs from branding |
| C-07 | Fixed | Header.tsx CDN URL normalises both sides to avoid double-slash |
| H-01 | Fixed | 19 missing fields added to brandingSchema |
| H-02 | Fixed | SOCKET_EVENTS.ORDER_UPDATE = 'order_update' |
| H-03 | Fixed | F1-only notices added; F2/F3 UI removed |
| H-04 | Fixed | Social links removed from Branding; SupportLinks is sole authority |
| H-05 | Fixed | apply-changes.sh and 0003-fix-p2pchat.patch deleted |
| H-06 | Fixed | ShareModal reads logo from branding |
| H-07 | Fixed | Login.tsx uses VITE_APP_NAME/VITE_APP_VERSION |
| H-08 | Fixed | Migration files marked APPLIED |
| M-01 | Fixed | MerchantsList limitsForm defaults match schema; admin edits per-merchant |
| M-02 | Fixed | GameProviderContext staleness comment added |
| M-03 | Fixed | MIN_BET removed from constants.ts |
| M-04 | Fixed | sendSystemConfig fallbacks cite schema defaults |
| M-05 | Fixed | WalletPage imports normalizeTransaction |
| L-01 | Fixed | realBackend.ts imports from GAME_CORE |
| L-02 | Fixed | admin-panel/src/utils/constants.ts populated with ADMIN_ROUTES |
| L-03 | Fixed | Version literals removed; package.json is authority |
| I-01 | Fixed | GOVERNANCE §6 updated — P2POrder embedded fields are dispute authority |
| I-02 | Fixed | Check-in rewards deleted from entire repo |
| GAP-1 | Fixed | See §12 for complete branding pipeline |
| GAP-2 | Fixed | See §14 for cross-panel authority and split-readiness rules |
| GAP-3 | Fixed | See §13 for dead artifact policy |
| Additional | Fixed | See §15 for file header requirement |

---

# Part II — Architecture, Portability, Capabilities, Decisions & Operations

> **Consolidated 2026-07-22.** The former `PORTABILITY.md`, `HYBRID_ARCHITECTURE.md`,
> `CAPABILITY_MATRIX_2026.md`, `ENTERPRISE_DECISIONS.md`, and `SRE.md` now live here as
> §§17–21 (content compacted, not changed in substance). External references to those
> filenames were repointed to this document. `platform/capabilities.yaml` remains the
> **machine-readable, CI-verified** capability source of truth (`npm run verify:capabilities`);
> §19 is the human-readable companion.

---

## 17. Portability (hosting / server / database / CDN)

**Goal:** move to any host/DB/CDN with **no code change** — all infra via env vars, never hardcoded.

Portable today (audited): a scan of `backend/**` found **zero** hardcoded platform URLs or container paths.

| Concern | Env var(s) | Swap to |
|---|---|---|
| Database | `MONGODB_URI`, `MONGO_MAX/MIN_POOL_SIZE` | Atlas, self-hosted Mongo, DocumentDB, any MongoDB-wire host |
| Cache / lock / rate-limit | `REDIS_URL` | Railway, Elasticache, Upstash, self-hosted, or **none** (in-memory fallback) |
| Object storage | `S3_ENDPOINT/REGION/BUCKET_NAME/ACCESS_KEY/SECRET_KEY` | any S3-compatible (S3, R2, B2, iDrive, Vultr, MinIO) |
| CDN | `CDN_URL` | any CDN in front of the bucket |
| Public URL / CORS | `APP_BASE_URL`, `ALLOWED_ORIGINS` | any domain |
| Email | `SMTP_*` | any SMTP provider |
| Port | `PORT` (default 8080) | whatever the platform assigns |

- **Frontends are origin-agnostic:** call `VITE_API_URL` if set, else same-origin `/api` (single-service deploy needs no frontend URL config).
- **Any container host:** the `Dockerfile` starts `node backend/server.js` — no platform SDK, no `.env` at boot (env injected). Runs on ECS/Fargate, Cloud Run, Azure, DO, Fly, Render, k8s, bare VM.
- **Observability is portable:** structured JSON logs to stdout; any system ingests them.
- **Migrate:** provision Mongo (+ optional Redis + S3 bucket + CDN) → set `.env.example` vars → `docker build`/buildpack → point DNS + set `APP_BASE_URL`/`ALLOWED_ORIGINS`. Railway files (`railway.json`, `nixpacks.toml`, `Procfile`, `Caddyfile`) are optional convenience; the Dockerfile is the neutral path.
- **⚠️ One honest limit — the DB ENGINE.** The app is built on **MongoDB via Mongoose** (200+ models, aggregation pipelines, ledger document shape, transactions). Any MongoDB *host* is a config swap; swapping the *engine* to SQL is a **data-layer rewrite** (would need a repository/DAL abstraction — none exists today). Deliberate, recorded.
- **Resolved caveats:** app-asset uploads write to S3 when configured (multi-instance correct); SSE/socket fan-out uses a Redis pub/sub bridge (`startup/realtimeBridge.js`, graceful no-op without Redis).

---

## 18. Hybrid Architecture — modular monolith → selected microservices, for 1M DAU

**Today: a modular monolith.** 26 bounded domains under `backend/domains/`, boundaries CI-enforced by dependency-cruiser. One process, one deploy — the right shape now (most "microservices at 1M DAU" failures split too early).

**Target: hybrid.** Keep the monolith core; extract a *small number* of services only on a **measured trigger** (independent scaling, failure isolation, or a different runtime profile). Method: **strangler-fig, seams-first** — the seams are built and **dormant** until an env var flips them (same pattern as the Postgres money DB and S3 storage).

**Seams built now (dormant):**

| Seam | File | Dormant until |
|---|---|---|
| Service topology (local vs remote resolver) | `backend/gateway/serviceTopology.js` | `SERVICE_<NAME>_URL` set |
| Consistent hashing (ring, ~1/N remap) | `backend/gateway/consistentHash.js` | a service scales horizontally |
| Inter-service auth (short-lived HS256 `iss`/`aud` tokens) | `backend/gateway/serviceAuth.js` | a domain goes remote; `SERVICE_JWT_SECRET` |
| Event backbone (forwards domain events to a log) | `backend/services/eventBackbone.js` + `backbone/kafkaDriver.js` | `KAFKA_BROKERS` set |
| RAG service (first split candidate) | `backend/domains/support/*` | `ANTHROPIC_API_KEY` + embeddings + pgvector |

**API gateway — two meanings, both explicit.** (a) The **application edge** is already in-process (`server.js`: Helmet, CORS, compression, correlation IDs, metrics, tiered rate-limiting, load-shed, OWASP filter, service registry, `/api/v1/` versioned routes) + the new `serviceTopology` resolver. (b) The **infrastructure edge** at 1M DAU is a dedicated **Envoy / Kong / APISIX** in front (TLS, global rate-limit, LB) — **infra-owned**; the app exposes `/health/live`, `/health/ready`, `/metrics`, versioned routes. Protocols: **public REST/JSON stays**; **internal service-to-service = gRPC** once services exist (proto contracts written at extraction, not speculatively).

**Do we need Kafka? — not yet; seam is ready.** The monolith is covered by the in-process `eventBus`, Redis pub/sub (cross-instance realtime), and BullMQ (durable jobs). Kafka earns its cost only at: 2+ independent services needing the same stream · replay · throughput/retention beyond Redis · CQRS/event-sourcing. Turning it on is `KAFKA_BROKERS=...` + the existing driver — no call-site changes.

**Inter-service security.** Inside the monolith the process boundary *is* the trust boundary — do not add service-auth ceremony to in-process calls. When a domain goes remote: app-identity service tokens (built, `serviceAuth.js`) + mTLS (mesh/Envoy, infra) + default-deny network policies (infra) + rotated `SERVICE_JWT_SECRET` (infra).

**Hybrid database (Mongo + Postgres).** MongoDB = high-velocity flexible data (cycles, realtime, sessions, logs, content), **authoritative today**. PostgreSQL = financial integrity (wallets, ledger, payment orders, KYC): strong ACID, integer paise, partitioning. Sync = **dual-write** (`postgres/dualWrite.js`) + **continuous reconciliation** (`reconcile.js`). Postgres is a verified **shadow** first, **authoritative for money last**, owner-gated (`postgres/DATA_ROLLBACK_PLAN.md`). pgvector rides the same Postgres for RAG. CDC (Debezium) is a later option; dual-write + reconcile is the right choice while PG is a shadow. Redis stays the cache + lock + rate-limit + queue layer.

**HA / resilience — app vs infra.** **App (done):** health/readiness/drain, load-shed/bulkhead, backoff+jitter, tiered + per-subnet rate limiting + surge breaker, consistent-hash primitive, Prometheus + Grafana-as-code. **Infra (Bucket C):** reverse proxy w/ dynamic upstreams + geo-routing, multi-region/multi-provider + DNS failover, managed WAF (`owaspFilter` is the app-side complement), IaC, encrypted cross-region backups. The app is HA-*ready* (stateless, Redis-backed shared state); multi-region/WAF/DNS are operational programs the app integrates with.

**Extraction order (on measured triggers):** 1) `support` (RAG) — stateless, zero money risk, the rehearsal; 2) `markets` — CPU-heavy engine + realtime; 3) `payment`/`merchant` — high throughput; 4) `wallet` — **last** (strongest consistency). `identity` stays central.

**Capacity sketch (1M DAU):** ~30–70k concurrent at peak → ~6–20k RPS. A horizontally-scaled stateless monolith + Redis shared state + Mongo/PG read replicas + pooling handles this behind a load balancer **before** any split is mandatory. The first thing to hurt is hot datastore paths, not the web tier — hence the money-DB partitioning framework + pool monitoring. **Scale the monolith horizontally first; extract on measured triggers.**

**Activation env-vars (all off by default):** `DATABASE_URL`+`VOYAGE_API_KEY` (RAG retrieval), `ANTHROPIC_API_KEY` (RAG generation), `KAFKA_BROKERS` (event backbone), `SERVICE_<NAME>_URL` (remote service), `SERVICE_JWT_SECRET` (mesh signing).

---

## 19. Capability Matrix (human-readable; **authoritative source = `platform/capabilities.yaml`**)

`platform/capabilities.yaml` (70 capabilities: id / bucket / owner / status / deps / evidence / verification / docs) is checked on every build by `scripts/verify-capabilities.mjs` so a claimed capability can't rot. **Bucket model:** **A** = build fully now · **B** = built + configurable, activated when infra exists · **C** = infra/ops-owned (app provides integration points) · *decision* = recorded architecture decision.

**Scoreboard (live — `platform/capabilities.yaml`, verified by `npm run verify:capabilities`):** **74 capabilities** — full **48** · partial **10** · architecture-ready **9** · absent **4** · recorded-decision **3**. **Zero capabilities are absent-and-unaccounted-for** — every partial/absent has a recommended upgrade + priority; the high-priority ones are all **owner/infra-gated** (Postgres cutover, PITR), not code gaps. Legend: **full** meets the 2026 enterprise standard · **architecture-ready** built + configurable, dormant until infra exists · **partial** works but has an owner/infra/volume-gated gap · **decision** a recorded architecture choice · **absent** not implemented. (Run the verifier for the exact live counts — this line is a snapshot.)

**FULL (representative evidence):** enterprise-architecture layering, governance framework, DDD boundaries (CI-enforced), centralized config, dependency validation + drift detection, append-only ledger (app + PG trigger), dual-write (dormant) + reconciliation engine, rollback strategy, connection pooling (+ `bb_pg_pool_connections`), Redis cache/locks/queue/rate-limit, central security config, security headers/cookies/CSP/HSTS, authorization matrix, audit logging, Caddy hardening + reverse proxy, central network config, load balancing (k8s HPA), health endpoints, Prometheus histogram metrics, Grafana-as-code, correlation IDs, structured logging + alerting, Docker + k8s readiness, CI/CD (PG18/Redis8, `npm ci`, audit + secret-scan + SBOM + 3 panel builds), blue/green + rolling, DR platform + SRE, cloud-agnostic provider layer, storage/email/SMS abstraction, feature flags, background job platform.

**PARTIAL / ABSENT (all accounted, gated):**
- **Owner/infra-gated (high):** PostgreSQL-as-SoT + integer-money-at-rest (item 7/9 — dormant, resolved by the cutover), Point-in-Time Recovery (enable Atlas/WAL).
- **Owner/infra-gated (medium):** read replicas (+ lag gauge), Redis HA (Sentinel/Cluster URL), WAF (front with Cloudflare), DNS failover (wire health-watch to provider), secret rotation automation (vault — pairs with secret-management), backup restore automation, Mongo multi-doc atomicity (run as replica set).
- **Volume-gated:** partitioning (apply RANGE-by-month with preserved global-uniqueness when millions/month).
- **Recorded decisions:** CDC/Debezium (reconciliation already proves correctness), Redis sessions (JWT+blacklist gives revocation), geo-routing (single region), OpenTelemetry SDK (adopt at 2nd-service trigger; W3C `traceparent` interop already shipped), IaC Terraform (manifests are the reproducibility layer on Railway), Helm / policy-as-code (only under k8s).
- **ABSENT (low/medium, no registry pipeline yet):** artifact signing (Cosign), SLSA provenance, replica-lag monitoring — all add when an image registry / read replica exists.

> **Governance consolidation note:** present-state, completed-work, backlog, and future-capability tracking live in this matrix + `capabilities.yaml`. Do not recreate standalone phase-status / execution-queue / future-capability markdown files unless a separate document is required for an active audit or regulatory handoff.

---

## 20. Enterprise Decision Log (the "why", newest first)

Architecture decisions that aren't obvious from code alone. Dates are stable anchors — **code comments cite these dates**, so keep them.

**2026-07-27 — A merchant settles on exactly ONE rail: INR-only or USDT-only.** `Merchant.acceptedCurrencies` was a free subset of `["INR","USDT"]`; it is now schema-validated to exactly one entry. Rationale: a merchant holds one set of payment credentials and one operational routine, and "both rails" was never a state anyone configured or the panel could render coherently — a single rail makes every downstream question ("which credentials do we snapshot onto this order?", "which orders may this merchant claim?", "what currency do we show?") have one answer. Kept as the existing array field rather than a new scalar so the assignment query and admin route keep working unchanged (GOVERNANCE §4); `merchantType` is a derived virtual for panels, never stored. Enforcement is layered, not cosmetic: `PaymentOrder.currency` (new, default `'INR'`) is matched in `selectBestMerchant` — previously `paymentProcessing` never passed the argument, so **every** order fell through to the `'INR'` default and a USDT order would have been routed to an INR merchant — re-checked when a merchant accepts, and used to filter the open withdrawal pool. `PUT /api/merchant/profile` now refuses the other rail's fields rather than silently ignoring them, and the admin capabilities route clears the old rail's credentials on a switch so they cannot be snapshotted onto a later order. Two defects fixed in passing: `Merchant.usdtWalletAddress` carried `uppercase: true`, which silently corrupts base58 Tron addresses (USDT sent to a corrupted address is unrecoverable), and the merchant accept route re-implemented `buildMerchantSnapshot` inline, so the USDT address would have been dropped on that path. Vocabulary is centralised in `domains/merchant/merchantCurrency.js`.

**2026-07-22 — Winner tie-breaker stays `Math.random` (owner-accepted).** When a cycle's DELHI/BOMBAY pools are exactly equal, the winner tie-break is `Math.random() < 0.5` (`domains/markets/cycleGenerator.service.js`). This is a deliberate, owner-accepted exception to the security-review guidance "use a CSPRNG for outcome-determining code / tie-breakers" (`SECURITY_CODE_REVIEW_CHECKLIST.md` §4): it fires only on an exact-tie edge case, decides a 50/50 with no attacker-exploitable bias worth a CSPRNG, and the owner has chosen to keep it. A future review flagging this line should treat it as **accepted**, not a defect — do not change it to `crypto` without an explicit owner decision reversing this.

**2026-07-10 — Phases B–F: duplicate-txId gate; env-gated integrations.** Wallet idempotency is the **WalletLedger unique txId index inside the money transaction**, not the `checkIdempotent` pre-read (two concurrent calls both pass the pre-read); the losing writer resolves `{ idempotent: true }` instead of erroring. Forced by the F-2 settle-under-concurrency test (first CI run double-credited 198 for a 99 payout because the index build wasn't awaited and a dup-key abort was treated as an error); `setup.js` now awaits `Model.init()`. Same pattern in `releaseLockedStake` + all six wallet money movers. **Integrations are activation-gated on config, never stubbed:** EMAIL is a full SMTP impl whose `active` flag derives from env; SMS/PUSH/USDT/payment-gateway stay declared-inactive (each needs a provider *decision*, not just keys).

**2026-07-10 — Phase A: bet-funding split & winnings fee.** **Precision = PAISE (integer paise; percents as integer basis points; floats never in the math, only storage)** — whole-token math can't express a ₹10 bet drawing 9.7/0.3. Drain rule: emptying a bucket returns the stored value verbatim so the atomic `$gte` can't spuriously fail on float error. Split stored as `betReservePercent` only (main = 100−reserve derived — one degree of freedom; DepositPolicy keeps two fields because it's whole-doc versioned). `winningsFeePercent` defaults to **1** (owner-specified core rule; 0 restores flat 2x). Fee → PLATFORM_REVENUE via `Cycle.netProfit` (no separate WINNINGS_FEES leg); itemized on the cycle (`totalPlatformFees`, `winningsFeePercentUsed`, snapshotted at settle). Fee percent read **once per settlement**. Correction recorded: the 2026-07-09 integration suite had never passed in CI until Phase A step 0 fixed it — CI run #10 (6797c81) is the first green run in repo history.

**2026-07-09 — Phase 012: Communication / Operations / Reporting.** `notify()` is the single user-messaging path over a channel-adapter registry (IN_APP live; EMAIL/SMS/PUSH declared) and never throws into business flows. Operations stays orchestration-only (owns no data; the config catalog is the "no hardcoded values" enforcement index). Reporting is DERIVED/read-only, never re-computes money — the regulatory export emits one CSV row per journal posting.

**2026-07-09 — Phase 011: Product Platforms + accepted four-tier architecture (future work EXTENDS, never restructures).** Tiers: **Core Enterprise** (Business Policy, Operations, Revenue & Settlement, Funding, Merchant, Risk) · **Product** (Sportsbook, Casino, Games, Markets, Odds, Event) · **Customer** (Communication, Wallet, Rewards, KYC) · **Enterprise Services** (Reporting, Analytics, Notification, Treasury, Configuration, Audit, Integration). Real consolidation done: `game/`+`betting/` → `domains/markets/`; provider model/routes → `domains/casino/`; shared `trading/tradingModels.js` (canonical sides/statuses + the settlement-integration contract: products persist source records, R&S derives ledger entries, wallets only via authorities). Sportsbook/Games/Event/Odds are **declared** (boundary READMEs + default-false flags), not faked.

**2026-07-09 — Phase 010: Risk Platform.** `domains/risk/riskValidation.service.js` is the single authority for operational rules + transaction validation (inline checks removed from bet/funding paths → `assessBet`/`assessFundingOrder`/`computeReserveSplit`). Numbers/toggles live in Business Policy; Risk only reads/enforces. Defaults: `enforceMultiplesOf10=true` (live change by owner directive), `blockOppositeSideBetting=false`, `maxFundingOrdersPerHour=0`, `payoutFeePercent=0` (when set, Risk computes at withdrawal, floored paise, posted to PAYOUT_FEES by R&S). AML/fraud/device-risk/responsible-gaming are **declared, not stubbed** (no fake placeholders).

**2026-07-09 — Phase 009: Funding Platform.** `domains/funding/` is the only authority for money entering/leaving; an **authority boundary** over existing P2P machinery, not a file move (`paymentProcessing.service.js` stays in `domains/payment/` behind the `MANUAL_P2P_INR` adapter). Deposits/withdrawals enter only via `fundingAuthority.requestDeposit/requestWithdrawal`; future rails are `providerRegistry.js` adapters. The zero-importer `eventBus` is now wired (PAYMENT_ORDER_CREATED/COMPLETED → a Funding subscriber nudges the R&S reconciler; 60s cron stays as the idempotent safety net). Funding never owns accounting, never mutates balances.

**2026-07-09 — Phase 008: Merchant Platform.** Single authority for merchant lifecycle. **Merchant Performance Bonus** shipped: "completed buy→sell cycle" = matched volume `min(deposit fiat, withdrawal fiat)` per merchant; bonus applies to newly-matched volume above a ledger-derived high-water mark (nothing stored that can drift); issuance = two idempotent ops on one deterministic key (ledger event pool→MERCHANT_FUNDS capped at pool, then wallet credit; crash heals next run); never partial-issues; percent/threshold/enablement live ONLY in `MerchantBonusPolicy`, shipped **disabled**. `merchantWallet.service.js` is the single writer of `Merchant.tokenBalance` (seven raw `$inc` sites rerouted preserving semantics; one canonical txId per op).

**2026-07-09 — Phase 007: Revenue & Settlement Platform (single financial authority).** Owns completed bets/payouts, platform revenue, settlement ledger, reserve deductions, payout fees, accounting events, merchant-bonus funding. `walletAuthority` stays the sole balance writer; R&S is the ACCOUNTING view (never mutates balances), owns no configurable percentages. **Ledger design (standard fintech double-entry):** append-only `AccountingEvent` (mutation throws; corrections are new reversing entries); each entry = signed integer paise postings summing to **exactly zero** (service + schema invariant); globally-unique `idempotencyKey` (dup = silent no-op); **balances always derived from postings**, never stored; closed chart of accounts (EXTERNAL_FIAT, USER_FUNDS, PLATFORM_RESERVE, PLATFORM_REVENUE, PAYOUT_FEES, MERCHANT_BONUS_POOL). **Producer model = DERIVED, not inline:** a reconciliation worker anti-joins completed source records against existing entries and records what's missing, idempotently (one writer, no risk to live money, self-healing, free backfill; ~60s lag acceptable). Pre-1:1 orders balance via a PLATFORM_REVENUE residual leg.

**2026-07-08 — buyRate/sellRate flattened to fixed 1:1; TokenRates removed.** Token conversion is a fixed **1:1 constant** (1 BB token = ₹1) across the stack. `TokenRates` model + admin endpoints (`/api/admin/token-rates`) + admin page + all rate reads are gone; new orders carry `rateUsed:1`, `fiatAmount===tokenAmount`, `merchantProfit:0`. Executed in five independently-green slices. Compatibility: public rate endpoints keep their shapes but return constant 1/1/0 (old clients degrade to identity); historical orders keep real `rateUsed`; `'TokenRates'` stays in the `ConfigVersion` enum for audit validity but is removed from `MODEL_BY_KEY` (no new version writable); the dead `tokenrates` collection is left in place (a DB op, not code). **Merchant earnings consequence:** with the spread gone and `merchantCommissionPercent` removed, merchants earn nothing per order until the Merchant Performance Bonus engine — the accepted interim state.

**2026-07-08 — Correction: merchant incentive removed from DepositPolicy; it's cycle-completion-triggered, not deposit-triggered.** `DepositPolicy.merchantCommissionPercent` + `commissionFundingSource` (added 2026-07-07) removed entirely; `DepositPolicy` now governs only the deposit/reserve split + reserve-usage rules for one incoming deposit. The replacement (**Merchant Performance Bonus**, not yet built) is triggered by a completed buy+sell cycle, a % of cycle volume on a future Merchant/Business Policy, a **platform-funded operating expense never deducted from users/deposits/withdrawals**. Named distinctly from the retired `Merchant.commissionRate` and yesterday's `merchantCommissionPercent` so three mechanisms aren't conflated. Safe to remove outright — no `DepositPolicy` doc ever existed in the live DB; `merchantCommissionPercent` was already dead (no reader). §1 updated to match.

**2026-07-07 — Platform-oriented architecture (formalized).** New code is organized under named platforms (Business Policy, Operations, Revenue & Settlement, Merchant, Funding, Risk, Sportsbook, Casino, Communication) rather than isolated features. Scope of the decision: naming + folder/nav placement for **new** work; existing code moves to its platform home **opportunistically** (when touched for another reason), never as a dedicated reshuffle (that would be the "expand scope into an unrelated migration" pattern §-forbidden).

**2026-07-07 — DepositPolicy: whole-document versioning, not field-level.** Deposit%/reserve%/reserve-usage rules are versioned together as ONE document per version (not independent fields via `configVersioning`) because they describe one coherent decision ("what happens to an incoming deposit"); field-level versioning would let them drift out of sync mid-change. Exactly one version is ACTIVE per currency at any moment. Named `DepositPolicy` (matches future siblings `WithdrawalPolicy`/`SettlementPolicy`), not "Allocation Policy". *(Superseded sub-decisions on `commissionFundingSource`/`merchantCommissionPercent` — see the 2026-07-08 correction above; the "platform-funded, never user-deducted" rule survives, now owned by the Merchant Performance Bonus mechanism.)*

**2026-07-07 — Fixed the live 90/10 hardcode in `merchant.routes.js` (not just the model).** The inline route handler in POST `/orders/:id/approve` was the live path and recomputed its own ratio, ignoring the stored `depositAllocation`/`reserveAllocation`; fixed to consume the stored fields (dead `approveDeposit()` helper removed). Follow-up 2026-07-10: those wallet writes now route through `walletAuthority.service.js` rather than raw `$inc`.

---

## 21. SRE & Operations

Grounded in what the repo exposes: Prometheus metrics (`services/metrics.service.js`), the alert webhook (`alerting.service.js`), `/health/live`+`/health/ready` probes, and the Grafana dashboard (`deploy/grafana/`).

**SLOs (rolling 28d; error budget = 100%−SLO):**

| SLO | Target | Source |
|---|---|---|
| API availability (`/health/ready` 200) | 99.9% | uptime monitor (budget 40m19s/28d) |
| p99 latency, non-settlement GET | < 400 ms | `http_request_duration_seconds` |
| p99 latency, `POST /api/bet` | < 800 ms | same, route-labeled |
| Settlement success | ≥ 99.95% | `bb_settlement_runs_total{outcome}` |
| Ledger integrity | 100% (hard) | revenue `integrityOk` / `bb_ledger_reconcile_errors_total`==0 |
| Money-DB drift (PG live) | 0 rows (hard) | `bb_pg_drift_rows`==0, `bb_pg_trial_balance_ok`==1 |

**Hard SLOs** (ledger integrity, money-DB drift) have a **zero** error budget — any breach is a P1, never "spend the budget."

**Error-budget policy:** >25% ship normally · <25% freeze non-critical releases · exhausted → reliability/security only · hard-SLO breach → stop deploys, open P1, reconcile the ledger first.

**Golden signals:** Latency (`http_request_duration_seconds` buckets; alert p99 > SLO 10m) · Traffic (`_count` rate) · Errors (5xx rate from `status` label; alert >1% 5m) · Saturation (`bb_requests_shed_total`, `bb_pg_pool_connections{state="waiting"}`, event-loop lag). Money-path alerts wire to the webhook (10-min cooldown): ledger-reconcile, settlement-tick, and (PG live) `pg-drift`. Point `SystemConfig.alertWebhookUrl` at PagerDuty/Slack.

**Incident runbooks** (P1 = money incorrect or platform down · P2 = degraded · P3 = minor). First 5 min: check `/health/ready` per instance + Grafana; identify blast radius; if a deploy is implicated, **roll back first**, diagnose after.
- **Ledger integrity (P1):** do NOT hand-mutate balances. Pull the failing event via `GET /api/admin/revenue/ledger`; ledger is append-only (corrections are new offsetting entries); reconciler is idempotent; escalate to the money-domain owner.
- **Settlement failures (P1/P2):** idempotent + crash-resumable; a failed tick retries next cycle. If persistent, check Mongo connectivity + the cycle lock (`settlementConcurrency.integration.test.js` documents invariants).
- **Money-DB drift (P1, PG live):** `npm run reconcile:pg -- --hours 168` for detail; do NOT flip authority while drifting; `DATA_ROLLBACK_PLAN.md` has the per-phase fallback.
- **Overload (P2):** the edge sheds to protect the event loop — scale out (k8s replicas/Railway instances), raise the admin load-shed ceiling if headroom, check for a hot query. Rate-limit counters are Redis-shared, so scaling is safe.
- **Redis down (P2, self-mitigating):** rate-limit degrades to per-instance, cache to in-memory, realtime to single-instance (all by design). Restore Redis; no data loss (money is in Mongo/PG).

**Capacity planning:** app tier is stateless → scale horizontally (k8s HPA on CPU: api **3→30** @ 65%, realtime **2→40** @ 60% — `deploy/k8s/deployment.yaml`). Inputs: RPS (`_count` rate), event-loop lag, pool waiting. **DB connections are the first ceiling:** keep `instances × (MONGO_MAX_POOL_SIZE + PG_POOL_SIZE) ≤` the DB tier's connection budget. Review headroom monthly + before campaigns; load-test before raising the instance ceiling.

**Rollback:** Railway → redeploy previous deployment (or revert the merge on `main`). k8s → `kubectl rollout undo deployment/bettingbazaar` or flip the blue/green Service selector. Deploys are boot-safe: `validateEnv` fails fast on missing secrets, so a misconfigured rollout refuses to start.

**On-call quick reference:** dashboards `deploy/grafana/bettingbazaar-dashboard.json` · scrape `GET /metrics` (Bearer `METRICS_TOKEN` if set) · health `/health/live` (process) + `/health/ready` (deps+drain) · alert sink `SystemConfig.alertWebhookUrl` / `ALERT_WEBHOOK_URL` · DR `docs/governance/DISASTER_RECOVERY.md` · money rollback `backend/postgres/DATA_ROLLBACK_PLAN.md`.
