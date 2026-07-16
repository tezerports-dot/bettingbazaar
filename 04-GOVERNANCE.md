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
| Token buy/sell rates | **REMOVED 2026-07-08** — token conversion is fixed 1:1 (1 BB token = ₹1), not configurable. The `TokenRates` model, its admin endpoints (`/api/admin/token-rates`), and the admin UI page are gone; public rate endpoints remain but return constant 1/1/0 for client compatibility. Do not reintroduce configurable rates — see ENTERPRISE_DECISIONS.md 2026-07-08. |
| Deposit/reserve wallet split, reserve usage rules (per currency) | `DepositPolicy` model (`domains/configuration/depositPolicy.model.js`) — whole-document versioned, written only via `depositPolicy.service.js`. **Corrected 2026-07-08:** `merchantCommissionPercent`/`commissionFundingSource` were removed — merchant incentive pay is cycle-completion-triggered (Merchant Performance Bonus), not deposit-triggered, and does not belong on this policy. See the "Merchant earnings model" line below. |
| Bet min/max (per cycle type) | `SystemConfig.betLimits` |
| Deposit/withdrawal limits (platform-wide) | `SystemConfig` |
| Per-merchant order min/max | `Merchant.minOrder` / `Merchant.maxOrder` (edited per-merchant from admin) |
| Merchant token capacity (buy orders) | `Merchant.tokenBalance` (current wallet) |
| Merchant token capacity (sell orders) | Lifetime initial top-up (tracked in merchant wallet history) |
| Referral commission rates | `CommissionLevel.f1Rate` only — F2/F3 not implemented (H-03) |
| Merchant earnings model | **The buy/sell spread is retired (2026-07-08, fixed 1:1 conversion)** — new orders carry `merchantProfit: 0`. `Merchant.commissionRate` remains retired; the interim `DepositPolicy.merchantCommissionPercent` mechanism was removed 2026-07-08 before ever being consumed. The go-forward mechanism is the **Merchant Performance Bonus**: triggered by completed buy+sell cycles, a % of cycle volume, funded from platform revenue, NEVER deducted from users/deposits/withdrawals. Not yet built — see EXECUTION_QUEUE.md and ENTERPRISE_DECISIONS.md 2026-07-08. Do not reintroduce `Merchant.commissionRate`, a rate spread, or a deposit-triggered commission. |
| Sub-admin permission keys | `User.subAdminPermissions` schema — frontend imports from `utils/permissions.ts` |
| Chat rules (cooldown, length, banned words) | Chat config document via `/api/chat/config` |
| Branding (colors, logo, names, banners) | `Branding` document — **see §3 and §12** |
| Banner/promo URLs | `Branding` document (tricksTipsBannerUrl, rulesPageImageUrl, etc.) |
| Social/support links | `SupportLinks` document — **NOT Branding** (H-04 fix) |
| Homepage/banner content order | `PromoContent.priority` field |
| Wallet balance mutations (user) | `walletAuthority.service.js` exclusively |
| Merchant token balance mutations | `merchantWallet.service.js` exclusively (Merchant Platform, Phase 008) — writes `MerchantWalletLedger`, idempotent txIds |
| Money movement in/out of the ecosystem (deposits, withdrawals, providers) | `fundingAuthority.service.js` (Funding Platform, Phase 009) — routes call requestDeposit/requestWithdrawal; providers live in `providerRegistry.js`. Never owns accounting (R&S derives ledger entries from completed orders). |
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
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
