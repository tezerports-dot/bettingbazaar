# Betting Bazaar — Complete UI/UX Product Blueprint

> **Designer hand-off / AI design prompt source.** This is the single source file for redesigning the currently implemented **Player**, **Merchant**, and **Admin** panels. It is intentionally structured for direct upload/paste into Claude, FigJam, Figma Make, or another AI-assisted design workflow. A native `.fig` binary cannot be generated safely outside Figma; import this document as the product specification, or paste its sections into Figma Make to generate editable frames.  
> **Scope:** actual repository state, not aspirational marketing copy. Every current page, shell, modal, realtime behavior, logo location, and backend route is mapped below. Items that have backend support but lack a clearly exposed first-class screen are explicitly identified as **GAP / DESIGN REQUIRED**.

---

## 0. Delivery instructions for the designer

### Required output
Create three connected desktop + mobile design systems in one Figma project:
1. **Player App** — mobile-first, `390 × 844` primary, desktop `1440 × 1024` secondary.
2. **Merchant Console** — responsive desktop-first, `1440 × 1024`, mobile operational fallback.
3. **Admin Console** — desktop-first, `1440 × 1024`, compact/tablet fallback.

For every frame, include **default, loading, empty, validation error, server error, success, disabled, permission denied, and offline/reconnecting** states. Link every CTA to the workflow listed in this file. Use semantic components/variants, not detached screenshots.

### Non-negotiable rules
- Never expose secrets, auth tokens, PAN/bank details, KYC documents, or raw UTR values in a non-authorized view.
- Financial actions need an explicit review/confirmation state and an immutable reference/order ID success state.
- Account/device/auth and payment failures must explain the safe next action without leaking sensitive details.
- Respect `prefers-reduced-motion`; motion must never hide status, countdown, error, or a required confirmation.
- All design decisions must support keyboard focus, 44px touch targets, visible focus rings, readable contrast, and screen-reader names.
- Realtime data is authoritative. Never make a mock timer, pool, balance, or payment state look final when it is awaiting server confirmation.

---

## 1. Source map and information architecture

| Product | Current entry/routing source | Current primary shell | Auth model |
|---|---|---|---|
| Player | `user-panel/src/App.tsx` | Header + game category strip + scrollable content + Footer; Game page owns its game shell | Player PASETO/session |
| Merchant | `merchant-panel/src/App.tsx` | White header + left sidebar + main work area | Merchant authentication |
| Admin | `admin-panel/src/App.tsx` | Dark fixed sidebar + top header + permissions-filtered navigation | Admin, sub-admin, queue-manager |

### Route conventions
- Player uses a **HashRouter**: prototype routes as `#/wallet`, `#/profile`, etc.
- Admin uses a **HashRouter**: prototype routes as `#/users`, `#/settings`, etc.
- Merchant uses browser routes under `/merchant`: prototype paths as `/merchant/dashboard`, etc.
- API path strings in this document are backend-relative. Add the actual deployed API origin through the existing client configuration; do not hardcode a host in designs.

---

## 2. Shared brand, tokens, assets, and component rules

### Current visual direction to retain unless intentionally redesigned
| Token / behavior | Current evidence | Design guidance |
|---|---|---|
| Player base | `#0B0E14`/`#090C12` dark arena, deep navy panels | Keep immersive dark canvas; do not use pure black for all surfaces. |
| Player accent | Gold `#D4AF37`, hover gold `#F5C77A` / `#B8860B` | Reserve gold for primary action, selected state, winnings, and important emphasis. |
| Player surfaces | Slate `#0F172A`, `#1E293B`, white 5–10% overlays | Use 12–18px rounded cards and clear elevation hierarchy. |
| Admin | dark sidebar/surfaces, gold active navigation | Dense operational data UI; use tables, chips, saved filters, drawers. |
| Merchant | white/gray surfaces, blue selection, green online status | Task-oriented payment workstation; make order urgency dominant. |
| Typography | Inter on player; current panels use Tailwind defaults | Use Inter or a documented approved equivalent; tabular numerals for money/time/IDs. |
| Logo assets | `backend/app-assets/logo.png`, `backend/app-assets/logo-header.png`; player also references `/app-assets/logo.png` then `/logo.png` fallback | Make a **Logo / full**, **Logo / header**, **Logo / compact mark**, and light/dark placement variants. Never substitute text where the logo asset is configured. |
| Live layers | footer is z-40; game chat modal must remain z-50 | Modal/drawer layer system: base 0; sticky nav 40; modal 50; auth emergency dialog 200. |

### Shared component inventory
Create reusable variants for: `AppLogo`, `Avatar`, `StatusBadge`, `RiskBadge`, `MoneyValue`, `ReferenceId`, `PrimaryButton`, `SecondaryButton`, `DangerButton`, `IconButton`, `TextInput`, `MoneyInput`, `PasswordInput`, `OTP/CaptchaInput`, `Search`, `DateRange`, `Select`, `Combobox`, `Tabs`, `SegmentedControl`, `Toast`, `Banner`, `EmptyState`, `ErrorState`, `LoadingSkeleton`, `DataTable`, `Pagination`, `SideDrawer`, `ConfirmDialog`, `BottomSheet`, `Dialog`, `ChatThread`, `FileUploader`, `KycDocumentCard`, `Timeline`, `AuditTrail`, `RealtimeIndicator`, and `PermissionGate`.

### Universal status vocabulary
Use a consistent chip system: `OPEN / ACTIVE` green; `PENDING / QUEUED` amber; `PROCESSING` blue; `COMPLETED / APPROVED` green; `REJECTED / FAILED / BLOCKED` red; `CANCELLED / EXPIRED` gray; `RESULT DECLARED` purple/gold. Always pair color with text/icon.

---

## 3. Player application — complete frame map

### 3.1 Player shell
**Frame: `PLAYER / Shell / Default`**
- Header: brand/logo left; wallet balance shortcut, profile/auth entry, notification/utility affordance if available.
- Category strip: game/category navigation below header.
- Main content: scrollable route content. Footer is fixed/sticky only where the current layout calls for it and must remain below chat modal.
- Background: low-contrast gold/blue radial gradient; capability-gated 3D background on high-capability desktop only; static gradient otherwise.
- Global modals: Auth, Wallet, KYC, Share, error boundary, maintenance, update required.

### 3.2 Player routes and page specifications
| Route | Current page/component | Required sections and CTAs | Primary backend/realtime contract |
|---|---|---|---|
| `#/` | `GamePage` | game header; current cycle countdown/status; Delhi/Bombay cards; amount/chip controls; place bet; live pool stats; result/history; chat trigger; wallet/auth gate | `POST /api/bet/place`; cycle snapshot/new cycle/result/bet events; authenticated player state |
| `#/casino` | `CasinoPage` | provider/category rail; game cards; launch game; unavailable/maintenance card | `GET /api/game/providers`, `GET /api/game/games`, `POST /api/game/launch` |
| `#/crash` | `CrashPage` | crash round visual, stake/cashout controls, history, responsible-gaming status | Design integration gap: verify provider/game contract before production interaction |
| `#/sports` | `SportsPage` | sport/event filters, odds cards, bet-slip placeholder or launch state | Design integration gap: verify provider/game contract before production interaction |
| `#/wallet` | `WalletPage` | total/deposit/winnings balances, add funds, withdraw, transaction ledger, order links, bank setup CTA | profile, payment order, wallet ledger, withdrawals endpoints |
| `#/invite` | `InvitePage` | referral code, share/copy, team, commissions, referral application status | `/api/referral/me`, `/team`, `/commissions`, `/apply` |
| `#/vip` | `VIPPage` | current tier/progress, benefits, VIP configuration disclosure | `/api/vip/config`, `/api/vip/my`, `/api/bonuses/my` |
| `#/gift-code` | `GiftCodePage` | code input, redeem CTA, success summary, redemption error | `POST /api/giftcode/redeem` |
| `#/recover-account` | `AccountRecoveryPage` | PAN check, recovery request, status polling, safe recovery explanation | `/api/auth/check-pan`, `/recover`, `/recover/status` |
| `#/profile` | `ProfilePage` | profile fields, avatar upload, bank/UPI details, KYC CTA/status, password/session actions where supported | profile, KYC, bank, upload endpoints |
| `#/history` | `HistoryPage` | payment/order timeline, filters, order detail, proof/chat/dispute links | `/api/payment/orders`, `/api/payment/order/:id`, status endpoints |
| `#/my-bets` | `MyBetsPage` | bet list, cycle/side/amount/status filters, reference IDs | `GET /api/user/:userId/bets` |
| `#/results` | `ResultsPage` | result timeline/table, cycle filter, winner/pool summary | cycle history + winners sources |
| `#/winners` | `WinnersPage` | winner leaderboard/list, period selector, winner cards | `/api/v1/winners`, `/api/leaderboard/:period` |
| `#/promo` | `PromoPage` | announcements, campaign slides/cards, CTA deep links | `/api/announcements`, promo content endpoint |
| `#/rules` | `RulesPage` | game/risk/responsible-gaming content, expandable sections | static/configured content |
| `#/faq` | `FaqPage` | searchable accordion FAQ, support CTA | `/api/v1/content/faq` |
| `#/support` | `SupportPage` | support links, AI support question flow, order support escalation | `/api/v1/content/support-links`, `/api/support/ask` |
| `#/chat` | currently null placeholder | **GAP / DESIGN REQUIRED:** define public/community or order-chat landing; do not present a dead navigation route | backend has user/merchant order-chat + upload contracts |

### 3.3 Player modal specifications
| Modal | Trigger | States / fields | Actions / API |
|---|---|---|---|
| Auth | protected CTA/header | login: mobile, password, math captcha; register: username, mobile, password, optional referral, captcha; lockout/rate-limit state; recovery link | `/api/v1/auth/login`, `/register`, `/logout`, `/me` |
| Wallet | wallet CTA / game funding CTA | balance strip; Add Funds/Withdraw tabs; amount; 1:1 token/₹ preview; saved bank details; queued/complete/failed order state | deposit create; withdrawal create; order polling |
| KYC | profile/withdraw eligibility | requirement explainer; document type; upload progress; submitted/reviewed/rejected states | user KYC + upload URL endpoints |
| Share | referral/winner/promo CTA | native share, copy link, QR/visual fallback, success toast | referral data; client share APIs |
| Place bet confirmation | recommended addition before irrevocable submission | cycle, side, amount, balances, risk notice, confirm/cancel; idempotent pending state | `POST /api/bet/place` |
| Payment order detail | history/wallet | timeline, assigned merchant state, chat/proof/dispute CTA, reference ID | payment order, upload, dispute endpoints |
| Bank details | wallet/profile | UPI or bank account fields, validation, masked confirmation | profile bank-details endpoint |
| Global maintenance/update | system configuration | branded logo, explanatory message, no unsafe CTA; update/restart CTA only when required | system config/realtime |

### 3.4 Player primary workflows
1. **Guest → authenticated player → first bet:** choose side → auth modal → successful login → return to original cycle/side/amount → optional wallet funding → review bet → submit → optimistic *pending* only → server confirmation → live pool updates.
2. **Add funds:** Wallet → Add Funds → amount → create payment order → queued → merchant assigned/accepted → chat/proof as available → completed → balance refresh and receipt.
3. **Withdraw winnings:** Wallet → Withdraw → validate saved bank details and winnings balance → review → create withdrawal → queued/processing → completion or rejected explanation.
4. **Account recovery:** auth modal link → PAN check → recovery form → submitted → status screen → approved/rejected communication.
5. **KYC:** profile/wallet eligibility prompt → consent + document selection → upload → submission receipt → review status → resolve rejection with actionable reason.

---

## 4. Merchant console — complete frame map

### 4.1 Merchant shell
**Frame: `MERCHANT / Shell / Dashboard`**
- Current look: white header, white 256px sidebar, gray page backdrop, blue active nav, green online availability indicator.
- Header: `BB Token Merchant` logo/text location, online/offline toggle, merchant user/profile trigger, logout.
- Sidebar: Dashboard, Orders, History, Profile; status card “Available for Orders”.
- Realtime: show connected/reconnecting/last-updated status; orders must update without manual refresh.

### 4.2 Merchant routes and operations
| Route | Frame requirements | Key CTA/workflow | Backend contract |
|---|---|---|---|
| `/merchant/` | Login | credentials, forgot/help, error/rate limit, secure loading | `/api/merchant/auth/login` |
| `/merchant/dashboard` | KPI dashboard | available/active/completed order counts; earnings; capacity; online toggle | `/profile`, `/stats`, `/earnings`, SSE |
| `/merchant/orders` | Active order workspace | filter tabs; urgency/status; Accept, Confirm, Reject, Red Flag, open chat, proof upload; details drawer | merchant orders, accept/confirm/reject/dispute/red-flag/chat/upload endpoints |
| `/merchant/history` | Historical orders/earnings | filters, downloadable/export-ready view, order details, earnings periods | orders, earnings, weekly earnings, bulk payout history endpoints |
| `/merchant/profile` | Merchant profile/settings | profile edit, QR upload, online state, preferences, limits; read-only authority explanation | profile, online-status, preferences, limits, QR upload |

### 4.3 Merchant required dialogs/drawers
- **Accept order confirmation:** order amount, payment method, expiry/countdown, SLA, accept/cancel.
- **Confirm payment completion:** show proof/merchant confirmation checklist; destructive/irreversible warning; reference ID.
- **Reject order:** required reason select + optional note; confirm.
- **Red-flag / dispute:** severity, reason, evidence attachments, confirmation; visibly explain downstream review.
- **Order chat:** immutable header with order ID, amount, status and countdown; message composer; image upload; attachment/error/loading states; no payment credentials in public transcript.
- **Bulk payout:** backend still supports read/export/mark-paid endpoints, but current route is intentionally removed. Treat as **GAP / admin-approved feature candidate**, not a visible default navigation item.

---

## 5. Admin console — complete frame map

### 5.1 Admin shell and role model
**Frame: `ADMIN / Shell / Expanded sidebar`**
- Current look: dark `dark-900` canvas, `dark-800` sidebar/header, gold active item, grouped menu, 64px top bar.
- Sidebar expanded/collapsed variants; logo/full wordmark when expanded, compact brand mark when collapsed.
- Roles: **Super Admin**, **Sub-Admin**, **Queue Manager**. Navigation must hide unavailable features; denied direct URLs show an Access Denied state (not a deceptive empty page).
- Each operational page requires: title, breadcrumb, global search where relevant, filters, saved-view affordance, realtime/last-sync status, export if backend supports it, empty/loading/error states, and an audit-detail path for sensitive changes.

### 5.2 Admin route inventory
| Route | Current page | Purpose and mandatory UI |
|---|---|---|
| `#/login` | Login | credential entry, error/rate limit/locked session states |
| `#/` | Dashboard | cross-platform KPIs, urgent queue, cycle and payment health |
| `#/live-cycles` | LiveCycles | live cycle cards/table; phase, timers, pools, equalize/manage actions with confirmations |
| `#/cycle-history` | CycleHistory | historical cycles, outcome/pools, drill-down/export |
| `#/profit-loss` | ProfitLoss | financial summary, time range, charts/table |
| `#/users` | UsersList | searchable user table, detail drawer, role/block/transactions actions |
| `#/users/balance-adjust` | BalanceAdjustment | strongly audited adjustment form, review/confirm, immutable receipt |
| `#/merchants` | MerchantsList | merchant directory, approval/suspension, limits/capabilities/funding/detail tabs |
| `#/kyc` | KYCQueue | document queue, user detail, approve/reject with mandatory reason |
| `#/transactions` | TransactionsList | transaction table, filters, order/ledger detail |
| `#/queue-manager` | QueueDashboard | assignment queue, available merchants, pending orders, manual assign/reassign |
| `#/payment-control` | PaymentControlCenter | gateway configuration/test, withdrawal approval/rejection, health/controls |
| `#/disputes` | DisputeManager | dispute list, chat/evidence, resolve/escalate timeline |
| `#/business-policy/deposit` | DepositPolicy | currency policy editor, version history, approve/rollback confirmation |
| `#/revenue` | RevenueLedger | revenue summary/ledger, bonus pool funding confirmation |
| `#/operations` | OperationsOverview | operations health, config catalog, retention run confirmation |
| `#/reports` | Reports | report filters, generate/download CSV, export states |
| `#/merchant-platform` | MerchantPlatform | merchant leaderboard/performance/wallet ledger/bonus engine |
| `#/games` | GamesManager | games/categories CRUD, safety confirmation on delete |
| `#/game-providers` | GameProviders | provider CRUD, test connection, transaction monitor |
| `#/account-recovery` | AccountRecoveryAdmin | recovery queue, approve/reject, KYC document linking |
| `#/winners-manager` | FakeWinnersManager | fake-winner CRUD, preview, delete confirmation |
| `#/chat-management` | currently mapped to SupportLinks | **GAP / naming mismatch:** design a support operations workspace or rename route; backend provides support knowledge-base/document routes |
| `#/promotions/announcements` | AnnouncementsPage | announcement list/editor/publish/delete |
| `#/promotions/gift-codes` | GiftCodes | code generator/list/redemptions/delete |
| `#/content/faq` | FAQManager | FAQ CRUD/order/preview |
| `#/content/slides` | ContentSlideManager | slide CRUD/order/preview/target location |
| `#/content/support` | SupportLinks | support link CRUD/order/preview |
| `#/content/cdn` | CDNManager | CDN assets/library, URL validation, usage preview |
| `#/branding` | BrandingSettings | names, palette, logos/images, CDN upload/confirm; live preview per panel |
| `#/app-assets` | AppAssetsPage | PWA/static asset upload/list/delete with safe replacement preview |
| `#/sub-admins` | SubAdminsList | invite/create, permission matrix, revoke/delete confirmation |
| `#/settings` | SystemSettings | system config editor; maintenance/version/money/risk changes must have review + audit note |
| `#/audit-logs` | AuditLogs | immutable audit table, actor/action/time/filter/detail drawer |
| `#/error-logs` | ErrorLogs | client/server error reporting list, filters, clear confirmation |

### 5.3 Admin destructive / regulated action pattern
Every approve, reject, delete, fund, deduct, balance-adjust, block, suspend, equalize, rollback, policy change, and configuration save must use:
1. concise consequence statement,
2. object identity + masked sensitive data,
3. required reason/note where backend supports it,
4. optional typed confirmation for high-impact operations,
5. submitting state that prevents duplicate click,
6. success toast with reference ID and “View audit record”,
7. recoverable error state without losing form input.

---

## 6. Cross-panel connected workflows

### Payment order lifecycle
`PLAYER wallet` → create deposit/withdrawal order → `ADMIN queue` optionally assigns/reassigns → `MERCHANT orders` accepts → user/merchant chat and proof upload → merchant confirms or rejects → user sees status/balance → admin resolves dispute if needed.  
Design the same status labels, order ID, amount, expiry, participants, audit timeline, and evidence list in every participant’s view. Each role sees only authorized PII/actions.

### Branding lifecycle
`ADMIN Branding/App Assets` → upload URL or asset upload → confirmation → updated branding event → Player, Merchant, and Admin apply colors/names/logo.  
Design a three-panel preview in Admin Branding and a safe fallback brand state when an asset fails to load.

### Realtime lifecycle
- Player: cycle snapshot, new cycle, bet placement, result/phase, payouts, balances, branding, system config.
- Merchant: order, chat, assignment, branding notifications.
- Admin: operational updates, branding, queue/payment/cycle changes.
Show a subtle “Live” state, a reconnecting banner after disconnect, and a non-blocking “data may be delayed” state; never silently show stale critical financial data as current.

---

## 7. Backend capability → frontend coverage and design gaps

| Backend capability | Current exposure | Required design decision |
|---|---|---|
| Public bootstrap `/api/app/bootstrap` | no clearly visible player settings/about screen | **GAP:** add “App & safety”/About screen or use only bootstrap initialization; document official origin and app links without exposing unsafe fallbacks. |
| Game launch/provider wallet | Casino page exists | Ensure launch loading/error/return-to-lobby and provider wallet status are designed. |
| Crash and sports | pages exist but endpoint coupling is not obvious from client route inventory | **GAP:** create contract-specific bet-slip/round states only after backend provider contract is confirmed. |
| Player order chat and uploads | wallet says chat opens, `#/chat` is null | **GAP (high):** build an order chat page/drawer and payment-proof upload journey. |
| Support knowledge base / admin documents | admin `chat-management` points to support links | **GAP:** build knowledge-base ingestion/document-management UI, status and delete confirmation. |
| Referral admin configuration/stats | player invite exists; no obvious admin route | **GAP:** add Admin → Promotions → Referrals (configuration, stats, commissions). |
| VIP admin configuration | player VIP exists; no obvious admin route | **GAP:** add Admin → Promotions → VIP configuration. |
| Withdrawal request approvals | backend exists; admin payment control should surface it | Verify Payment Control Center includes request detail, approve/reject reason, receipt. |
| UTR registry | UTR page/navigation intentionally removed | Do not restore without product decision; retain backend capability as an internal audit/anti-fraud integration candidate. |
| Merchant token orders / funding | merchant/admin endpoints exist | **GAP:** add clearly governed funding/token order views if operationally active; otherwise hide behind capability flags. |
| Operational outbox | backend durable processing state exists | **GAP (admin-only):** add a reconciliation/outbox monitor only if operations need manual recovery; never expose to player/merchant. |
| Reports exports | admin Reports exists | Specify report generation, CSV download progress, no-data state, and permission gate. |

---

## 8. Endpoint catalog (authoritative source-location inventory)

**How to use:** the exact endpoint base is determined by `backend/server.js` mounts. The source file and raw route call are preserved below so engineering/design can resolve any ambiguity without inventing API behavior. Authentication middleware in source determines whether a screen is public, player-authenticated, merchant-authenticated, or admin/permission-gated.

- `backend/routes/sse.routes.js:70` — `router.get('/events', async (req, res) => {`
- `backend/routes/sse.routes.js:128` — `router.get('/merchant/events', async (req, res) => {`
- `backend/routes/sse.routes.js:196` — `router.get('/admin/events', async (req, res) => {`
- `backend/routes/sse.routes.js:240` — `router.get('/stats', (req, res) => {`
- `backend/routes/winners.routes.js:26` — `router.get('/v1/winners', async (req, res) => {`
- `backend/routes/winners.routes.js:94` — `router.get('/admin/fake-winners', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/winners.routes.js:103` — `router.post('/admin/fake-winners', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/winners.routes.js:121` — `router.put('/admin/fake-winners/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/winners.routes.js:136` — `router.delete('/admin/fake-winners/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/account-recovery.routes.js:75` — `router.post('/auth/check-pan', async (req, res) => {`
- `backend/routes/account-recovery.routes.js:112` — `router.post('/auth/recover', async (req, res) => {`
- `backend/routes/account-recovery.routes.js:175` — `router.get('/auth/recover/status', async (req, res) => {`
- `backend/routes/account-recovery.routes.js:198` — `router.get('/admin/account-recovery', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/account-recovery.routes.js:223` — `router.post('/admin/account-recovery/:id/approve', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/account-recovery.routes.js:293` — `router.post('/admin/account-recovery/:id/reject', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/account-recovery.routes.js:328` — `router.post('/admin/kyc/link-documents', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/giftcode.routes.js:9` — `router.post('/redeem', authenticate, async (req, res) => {`
- `backend/routes/giftcode.routes.js:62` — `router.get('/admin/giftcodes', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/giftcode.routes.js:71` — `router.post('/admin/giftcodes', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/giftcode.routes.js:85` — `router.delete('/admin/giftcodes/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/giftcode.routes.js:94` — `router.get('/admin/giftcodes/:id/redemptions', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/referral.routes.js:18` — `router.get('/me', authenticate, async (req, res) => {`
- `backend/routes/referral.routes.js:50` — `router.get('/team', authenticate, async (req, res) => {`
- `backend/routes/referral.routes.js:81` — `router.get('/commissions', authenticate, async (req, res) => {`
- `backend/routes/referral.routes.js:101` — `router.get('/admin/referral/config', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/referral.routes.js:113` — `router.put('/admin/referral/config', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/referral.routes.js:133` — `router.get('/admin/referral/stats', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/referral.routes.js:156` — `router.post('/apply', authenticate, async (req, res) => {`
- `backend/routes/upload.routes.js:26` — `router.post('/user/chat/:orderId/upload-url', authenticate, async (req, res) => {`
- `backend/routes/upload.routes.js:65` — `router.post('/user/chat/:orderId/confirm-upload', authenticate, async (req, res) => {`
- `backend/routes/upload.routes.js:112` — `router.post('/merchant/chat/:orderId/upload-url', merchantAuth, async (req, res) => {`
- `backend/routes/upload.routes.js:151` — `router.post('/merchant/chat/:orderId/confirm-upload', merchantAuth, async (req, res) => {`
- `backend/routes/upload.routes.js:199` — `router.post('/user/payment-proof/:orderId/upload-url', authenticate, async (req, res) => {`
- `backend/routes/upload.routes.js:246` — `router.post('/user/payment-proof/:orderId/confirm-upload', authenticate, async (req, res) => {`
- `backend/routes/upload.routes.js:278` — `router.post('/user/kyc/:docType/upload-url', authenticate, async (req, res) => {`
- `backend/routes/upload.routes.js:299` — `router.post('/user/profile/picture/upload-url', authenticate, async (req, res) => {`
- `backend/routes/upload.routes.js:321` — `router.post('/user/profile/picture/confirm-upload', authenticate, async (req, res) => {`
- `backend/routes/upload.routes.js:339` — `router.post('/merchant/qr/upload-url', merchantAuth, async (req, res) => {`
- `backend/routes/retention.routes.js:13` — `router.get('/leaderboard/:period', async (req, res) => {`
- `backend/routes/retention.routes.js:25` — `router.post('/leaderboard/rebuild', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/retention.routes.js:92` — `router.get('/announcements', async (req, res) => {`
- `backend/routes/retention.routes.js:101` — `router.get('/admin/announcements', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/retention.routes.js:109` — `router.post('/admin/announcements', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/retention.routes.js:120` — `router.put('/admin/announcements/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/retention.routes.js:133` — `router.delete('/admin/announcements/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/retention.routes.js:141` — `router.get('/bonuses/my', authenticate, async (req, res) => {`
- `backend/routes/retention.routes.js:155` — `router.get('/vip/config', async (req, res) => {`
- `backend/routes/retention.routes.js:170` — `router.get('/vip/my', authenticate, async (req, res) => {`
- `backend/routes/retention.routes.js:182` — `router.put('/admin/vip/config', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/retention.routes.js:191` — `router.post('/admin/balance-adjust', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/retention.routes.js:218` — `router.get('/admin/balance-adjustments', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/app-bootstrap.routes.js:14` — `router.get('/bootstrap', (req, res) => {`
- `backend/routes/admin/kyc.admin.routes.js:7` — `router.get('/kyc/queue', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {`
- `backend/routes/admin/kyc.admin.routes.js:28` — `router.post('/kyc/:userId/approve', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {`
- `backend/routes/admin/kyc.admin.routes.js:84` — `router.post('/kyc/:userId/reject', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {`
- `backend/routes/admin/audit.admin.routes.js:8` — `router.get('/audit-logs', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/utr.admin.routes.js:16` — `router.get('/utr-registry', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/utr.admin.routes.js:42` — `router.get('/utr-registry/:utr', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/utr.admin.routes.js:61` — `router.put('/utr-registry/:utr/flag', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/utr.admin.routes.js:79` — `router.get('/utr/flagged', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/utr.admin.routes.js:99` — `router.get('/utr/stats', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/utr.admin.routes.js:110` — `router.get('/utr/user-history/:userId', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/utr.admin.routes.js:125` — `router.post('/utr/resolve/:orderId', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:14` — `router.post('/users/:userId/adjust-balance', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:47` — `router.get('/users', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:94` — `router.get('/users/:userId', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:120` — `router.put('/users/:userId/roles', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:148` — `router.put('/users/:userId/block', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:173` — `router.put('/users/:userId/unblock', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:224` — `router.delete('/users/:userId', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:255` — `router.get('/phantom-agents', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:271` — `router.post('/users/:userId/phantom-access', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:305` — `router.get('/analytics/phantom-stats', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:343` — `router.get('/queue-managers', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:359` — `router.post('/users/:userId/queue-manager', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/users.admin.routes.js:388` — `router.get('/users/:userId/transactions', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/cycles.admin.routes.js:7` — `router.get('/cycles/phases', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/cycles.admin.routes.js:79` — `router.get('/cycles/history', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/cycles.admin.routes.js:133` — `router.post('/cycles/:cycleId/equalize', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/cycles.admin.routes.js:187` — `router.post('/manage-cycle', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/subadmins.admin.routes.js:9` — `router.get('/sub-admins', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/subadmins.admin.routes.js:24` — `router.post('/sub-admins', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/subadmins.admin.routes.js:55` — `router.put('/sub-admins/:subAdminId/permissions', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/subadmins.admin.routes.js:76` — `router.delete('/sub-admins/:subAdminId', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:41` — `router.get('/branding', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:58` — `router.put('/branding', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:141` — `router.post('/branding/images', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:173` — `router.get('/branding/images', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:193` — `router.delete('/branding/images/:imageId', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:221` — `router.post('/branding/cdn-url', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:248` — `router.post('/branding/upload-url', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:275` — `router.post('/branding/confirm-upload', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:319` — `router.get('/app-assets', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/branding.admin.routes.js:361` — `router.post('/app-assets/upload',`
- `backend/routes/admin/branding.admin.routes.js:410` — `router.delete('/app-assets/:name', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:49` — `router.get('/transactions', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:88` — `router.get('/system/config', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:168` — `router.put('/system/config', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:378` — `router.get('/download/android', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:389` — `router.get('/download/ios', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:400` — `router.get('/download/links', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:414` — `router.get('/withdrawal-requests', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:428` — `router.post('/withdrawal-requests/:id/approve', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:446` — `router.post('/withdrawal-requests/:id/reject', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:470` — `router.get('/error-reports', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/admin/system.admin.routes.js:481` — `router.delete('/error-reports', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/payment-config.routes.js:10` — `router.get('/config', async (req, res) => {`
- `backend/routes/payment-config.routes.js:24` — `router.get('/admin/config', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/routes/payment-config.routes.js:42` — `router.put('/admin/config', authenticate, isAdmin, async (req, res) => {`
- `backend/routes/payment-config.routes.js:62` — `router.post('/admin/test-gateway', authenticate, isAdmin, async (req, res) => {`
- `backend/routes.js:112` — `router.post('/login', loginHandler)`
- `backend/routes.js:115` — `router.get('/me', async (req, res) => {`
- `backend/routes.js:158` — `router.post('/register', registerLimiter, async (req, res) => {`
- `backend/routes.js:216` — `router.post('/logout', async (req, res) => {`
- `backend/routes.js:234` — `router.get('/health', (_, res) => res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() }))`
- `backend/domains/revenue/revenue.admin.routes.js:25` — `router.get('/revenue/summary', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/revenue/revenue.admin.routes.js:56` — `router.get('/revenue/ledger', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/revenue/revenue.admin.routes.js:77` — `router.post('/revenue/bonus-pool/fund', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/markets/bet.routes.js:45` — `router.post('/place', unauthenticatedBetIpLimiter, authenticate, betLimiter, async (req, res) => {`
- `backend/domains/markets/bet.routes.js:390` — `router.post('/phantom', authenticate, async (req, res) => {`
- `backend/domains/analytics/analytics.admin.routes.js:13` — `router.get('/analytics/trends', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/analytics/analytics.admin.routes.js:26` — `router.get('/analytics/dashboard', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/analytics/analytics.admin.routes.js:147` — `router.get('/analytics/financials', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/analytics/analytics.admin.routes.js:229` — `router.get('/stats', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/analytics/analytics.admin.routes.js:284` — `router.get('/analytics/deposit-dashboard', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/analytics/analytics.admin.routes.js:342` — `router.get('/analytics/withdrawal-dashboard', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/analytics/analytics.admin.routes.js:400` — `router.get('/analytics/merchant-funding', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:8` — `router.get('/content/faq', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:66` — `router.post('/content/faq', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:83` — `router.put('/content/faq/:faqId', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:95` — `router.delete('/content/faq/:faqId', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:112` — `router.get('/content/support-links', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:145` — `router.put('/content/support-links', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:194` — `router.get('/promo', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:210` — `router.post('/promo', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:231` — `router.put('/promo/:id', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/cms/content.admin.routes.js:246` — `router.delete('/promo/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/operations/operations.admin.routes.js:28` — `router.get('/operations/overview', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/operations/operations.admin.routes.js:99` — `router.get('/operations/config-catalog', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/operations/operations.admin.routes.js:141` — `router.post('/operations/retention/run', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/disputes/disputeResolution.admin.routes.js:9` — `router.get('/dispute-orders', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {`
- `backend/domains/disputes/disputeResolution.admin.routes.js:60` — `router.get('/dispute-orders/:orderId', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {`
- `backend/domains/disputes/disputeResolution.admin.routes.js:75` — `router.get('/dispute-orders/:orderId/chat', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {`
- `backend/domains/disputes/disputeResolution.admin.routes.js:88` — `router.post('/dispute-orders/:orderId/chat', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {`
- `backend/domains/disputes/disputeResolution.admin.routes.js:130` — `router.post('/dispute-orders/:orderId/resolve', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/disputes/disputeResolution.admin.routes.js:235` — `router.post('/dispute-orders/:orderId/escalate', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {`
- `backend/domains/communication/communication.admin.routes.js:15` — `router.get('/communication/channels', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/communication/communication.admin.routes.js:21` — `router.get('/communication/audit-feed', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/communication/communication.admin.routes.js:44` — `router.get('/communication/admin-activity', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/reporting/reporting.admin.routes.js:25` — `router.get('/reports/financial', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/reporting/reporting.admin.routes.js:35` — `router.get('/reports/settlement', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/reporting/reporting.admin.routes.js:45` — `router.get('/reports/merchants', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/reporting/reporting.admin.routes.js:56` — `router.get('/reports/ledger-export', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:70` — `router.post('/auth/signup', async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:133` — `router.post('/auth/login', async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:204` — `router.get('/profile', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:225` — `router.put('/profile', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:260` — `router.put('/online-status', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:288` — `router.put('/preferences', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:308` — `router.put('/limits', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:329` — `router.get('/admin-token-orders', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:340` — `router.post('/admin-token-orders', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:380` — `router.get('/orders', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:407` — `router.post('/accept/:id', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:525` — `router.post('/confirm/:id', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:692` — `router.post('/reject/:id', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:778` — `router.post('/order/:id/dispute', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:826` — `router.get('/chat/:id', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:873` — `router.post('/chat/:id', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:946` — `router.post('/orders/:id/red-flag', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:1011` — `router.get('/bulk-payouts', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:1055` — `router.get('/bulk-payouts/export', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:1119` — `router.post('/bulk-payouts/mark-paid', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:1171` — `router.get('/earnings', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:1223` — `router.get('/earnings/weekly', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:1275` — `router.get('/stats', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:1301` — `router.post('/orders/:id/approve', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchant.routes.js:1436` — `router.post('/orders/:id/reject', merchantAuth, async (req, res) => {`
- `backend/domains/merchant/merchantPlatform.admin.routes.js:17` — `router.get('/merchant-platform/leaderboard', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/merchant/merchantPlatform.admin.routes.js:31` — `router.get('/merchant-platform/:merchantId/funding-stats', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/merchant/merchantPlatform.admin.routes.js:43` — `router.get('/merchant-platform/:merchantId/performance-history', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/merchant/merchantPlatform.admin.routes.js:55` — `router.get('/merchant-platform/:merchantId/wallet-ledger', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/merchant/merchantPlatform.admin.routes.js:69` — `router.post('/merchant-platform/bonus-engine/run', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.assignment.routes.js:48` — `router.post('/payment-orders/:id/assign', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.assignment.routes.js:131` — `router.post('/payment-orders/:id/reassign', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {`
- `backend/domains/merchant/merchant.assignment.routes.js:219` — `router.get('/queue/available-merchants', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {`
- `backend/domains/merchant/merchant.assignment.routes.js:282` — `router.get('/queue/merchant-pool', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {`
- `backend/domains/merchant/merchant.assignment.routes.js:315` — `router.put('/queue/merchant-pool', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {`
- `backend/domains/merchant/merchant.assignment.routes.js:378` — `router.get('/queue/eligible-merchants', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {`
- `backend/domains/merchant/merchant.assignment.routes.js:400` — `router.get('/queue/pending-orders', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {`
- `backend/domains/merchant/merchant.assignment.routes.js:428` — `router.post('/queue/assign/:orderId', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {`
- `backend/domains/merchant/merchant.assignment.routes.js:507` — `router.put('/merchants/:merchantId/scoring', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:36` — `router.get('/merchants', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:105` — `router.get('/merchants/:merchantId', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:119` — `router.put('/merchants/:merchantId/suspend', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:151` — `router.put('/merchants/:merchantId/activate', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:175` — `router.put('/merchants/:merchantId/limits', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:221` — `router.put('/merchants/:merchantId/capabilities', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:281` — `router.get('/merchants/:merchantId/earnings', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:311` — `router.get('/merchants/:merchantId/profile', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:340` — `router.put('/merchants/:merchantId/approve', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:378` — `router.put('/merchants/:merchantId/reject', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:407` — `router.post('/merchants/create', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:432` — `router.get('/merchants/:merchantId/transactions', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:475` — `router.post('/merchants/:merchantId/fund', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:545` — `router.get('/merchant-token-orders', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:558` — `router.post('/merchant-token-orders/:orderId/approve', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:590` — `router.post('/merchant-token-orders/:orderId/reject', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:614` — `router.post('/merchants/:merchantId/deduct', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:688` — `router.put('/merchants/:merchantId/panel-url', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/merchant/merchant.admin.routes.js:741` — `router.get('/merchants/:merchantId/profit-engine', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/support/support.admin.routes.js:25` — `router.get('/support/status', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/support/support.admin.routes.js:30` — `router.post('/support/ingest/knowledge-base', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/support/support.admin.routes.js:35` — `router.post('/support/ingest', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/support/support.admin.routes.js:53` — `router.get('/support/documents', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/support/support.admin.routes.js:58` — `router.delete('/support/documents/:docId', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/support/support.routes.js:31` — `router.get('/status', async (req, res) => {`
- `backend/domains/support/support.routes.js:39` — `router.post('/ask', authenticate, askLimiter, async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:39` — `router.get('/games', async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:65` — `router.get('/categories', async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:93` — `router.get('/admin/games', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:121` — `router.post('/admin/games', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:145` — `router.put('/admin/games/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:168` — `router.delete('/admin/games/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:183` — `router.get('/admin/categories', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:194` — `router.post('/admin/categories', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:212` — `router.put('/admin/categories/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/gameRegistry/gameRegistry.routes.js:226` — `router.delete('/admin/categories/:id', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/user/user.routes.js:111` — `router.get('/cycles/active', async (req, res) => {`
- `backend/domains/user/user.routes.js:130` — `router.get('/cycles/:cycleId', async (req, res) => {`
- `backend/domains/user/user.routes.js:147` — `router.get('/v1/game/cycle/:type/:startTime', async (req, res) => {`
- `backend/domains/user/user.routes.js:183` — `router.get('/v1/game/cycles/history', async (req, res) => {`
- `backend/domains/user/user.routes.js:237` — `router.get('/user/:userId/bets', authenticate, async (req, res) => {`
- `backend/domains/user/user.routes.js:288` — `router.get('/v1/user/:id/data', authenticate, async (req, res) => {`
- `backend/domains/user/user.routes.js:373` — `router.put('/user/:userId/profile', authenticate, async (req, res) => {`
- `backend/domains/user/user.routes.js:412` — `router.post('/user/:userId/kyc', authenticate, async (req, res) => {`
- `backend/domains/user/user.routes.js:467` — `router.put('/user/:userId/bank-details', authenticate, async (req, res) => {`
- `backend/domains/user/user.routes.js:502` — `router.get('/user/:userId/transactions', authenticate, async (req, res) => {`
- `backend/domains/user/user.routes.js:552` — `router.get('/v1/system/config', async (req, res) => {`
- `backend/domains/user/user.routes.js:593` — `router.get('/v1/system/time', (req, res) => {`
- `backend/domains/user/user.routes.js:605` — `router.get('/v1/content/promo/:location', async (req, res) => {`
- `backend/domains/user/user.routes.js:622` — `router.get('/v1/content/faq', async (req, res) => {`
- `backend/domains/user/user.routes.js:656` — `router.get('/v1/content/support-links', async (req, res) => {`
- `backend/domains/user/user.routes.js:692` — `router.get('/v1/content/ai-analysis', async (req, res) => {`
- `backend/domains/user/user.routes.js:766` — `router.get('/v1/branding', async (req, res) => {`
- `backend/domains/user/user.routes.js:812` — `router.post('/v1/user/withdraw', withdrawalLimiter, createSubnetLimiter('withdrawal'), globalSurgeBreaker('withdrawal'), authenticate, async (req, res) => {`
- `backend/domains/user/user.routes.js:874` — `router.get('/v1/user/withdrawals', authenticate, async (req, res) => {`
- `backend/domains/user/user.routes.js:886` — `router.get('/v1/wallet/ledger', authenticate, async (req, res) => { // paginated`
- `backend/domains/user/user.routes.js:901` — `router.get('/v1/tokens/rate', async (req, res) => {`
- `backend/domains/user/user.routes.js:925` — `router.get('/v1/token/rates', async (req, res) => {`
- `backend/domains/user/user.routes.js:949` — `router.get('/v1/user/profile', authenticate, async (req, res) => {`
- `backend/domains/payment/paymentOrder.routes.js:16` — `router.get('/payment-queue', authenticate, hasPermission('canViewTransactions'), async (req, res) => {`
- `backend/domains/payment/paymentOrder.routes.js:55` — `router.post('/payment-orders/:orderId/action', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {`
- `backend/domains/payment/paymentOrder.routes.js:100` — `router.post('/payment-orders/:orderId/resolve', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {`
- `backend/domains/payment/payment.routes.js:40` — `router.post('/deposit/create', authenticate, async (req, res) => {`
- `backend/domains/payment/payment.routes.js:47` — `router.post('/withdrawal/create', authenticate, withdrawalLimiter, createSubnetLimiter('withdrawal'), globalSurgeBreaker('withdrawal'), async (req, res) => {`
- `backend/domains/payment/payment.routes.js:54` — `router.post('/order/:orderId/mark-paid', authenticate, async (req, res) => {`
- `backend/domains/payment/payment.routes.js:64` — `router.post('/deposit/:orderId/confirm', paymentActorAuth, async (req, res) => {`
- `backend/domains/payment/payment.routes.js:99` — `router.get('/orders', authenticate, async (req, res) => {`
- `backend/domains/payment/payment.routes.js:116` — `router.get('/order/:orderId', authenticate, async (req, res) => {`
- `backend/domains/payment/payment.routes.js:128` — `router.get('/rates', async (req, res) => {`
- `backend/domains/payment/payment.routes.js:132` — `router.post('/order/cancel', authenticate, async (req, res) => {`
- `backend/domains/payment/payment.routes.js:141` — `router.get('/order/:orderId/status', authenticate, async (req, res) => {`
- `backend/domains/payment/payment.routes.js:163` — `router.post('/order/:orderId/dispute', authenticate, async (req, res) => {`
- `backend/domains/payment/payment.routes.js:203` — `router.post('/order/:orderId/status', authenticate, async (req, res) => {`
- `backend/domains/casino/gameProvider.routes.js:81` — `router.get('/providers', async (req, res) => {`
- `backend/domains/casino/gameProvider.routes.js:103` — `router.post('/launch', authenticate, async (req, res) => {`
- `backend/domains/casino/gameProvider.routes.js:232` — `router.post('/wallet/:providerKey', async (req, res) => {`
- `backend/domains/casino/gameProvider.routes.js:301` — `router.get('/admin/game-providers', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/casino/gameProvider.routes.js:320` — `router.put('/admin/game-providers/:key', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/casino/gameProvider.routes.js:336` — `router.post('/admin/game-providers/:key/test', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/casino/gameProvider.routes.js:359` — `router.get('/admin/game-transactions', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/casino/gameProvider.routes.js:379` — `router.post('/admin/game-providers', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/casino/gameProvider.routes.js:403` — `router.delete('/admin/game-providers/:key', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/configuration/merchantBonusPolicy.admin.routes.js:18` — `router.get('/merchant-bonus-policy', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/configuration/merchantBonusPolicy.admin.routes.js:30` — `router.get('/merchant-bonus-policy/history', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/configuration/merchantBonusPolicy.admin.routes.js:42` — `router.put('/merchant-bonus-policy', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/configuration/merchantBonusPolicy.admin.routes.js:76` — `router.post('/merchant-bonus-policy/version/:versionId/rollback', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/configuration/depositPolicy.admin.routes.js:31` — `router.get('/deposit-policy/:currency', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/configuration/depositPolicy.admin.routes.js:47` — `router.get('/deposit-policy/:currency/history', authenticate, isAdminOrSubAdmin, async (req, res) => {`
- `backend/domains/configuration/depositPolicy.admin.routes.js:62` — `router.put('/deposit-policy/:currency', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/configuration/depositPolicy.admin.routes.js:124` — `router.post('/deposit-policy/version/:versionId/approve', authenticate, isAdmin, async (req, res) => {`
- `backend/domains/configuration/depositPolicy.admin.routes.js:159` — `router.post('/deposit-policy/version/:versionId/rollback', authenticate, isAdmin, async (req, res) => {`

---

## 9. API-to-UI interaction rules

### Request states
For every mutating endpoint: `idle → validate locally → submitting → success | recoverable error | auth expired | rate limited`. Disable only the action that is in flight; retain other safe navigation. Use an idempotency/reference label in financial flows where available.

### File upload pattern
For user chat, merchant chat, payment proof, KYC, profile picture, merchant QR, branding, and app assets: design `select → file validation → upload URL request → upload progress → confirm upload → preview → remove/retry`. Include type/size errors, expired URL, connectivity failure, and sensitive-document privacy language.

### Tables
Admin and merchant tables need column visibility, sortable columns where meaningful, filter chips, date range, pagination/loading skeleton, empty-state CTA, reference ID copy, row click to detail drawer, and no-data/export behavior.

### Money and time
- Render INR/token values with Indian grouping and tabular figures.
- Never round a server-provided exact financial value in an audit/detail view.
- Label deposit versus winnings balance distinctly.
- Display timezone consistently (recommend IST in player/merchant operational views; show explicit timezone in admin reports).
- Use server-driven cycle timestamps/countdowns; an offline client should show a delayed/reconnecting state rather than fabricate time.

---

## 10. Figma file structure and handoff checklist

### Recommended Figma pages
1. `00 Cover + product map`
2. `01 Foundations` (color, type, spacing, elevation, iconography, logo usage)
3. `02 Components` (all variants and states)
4. `03 Player / Core game + wallet`
5. `04 Player / Account + content`
6. `05 Merchant / Orders + profile`
7. `06 Admin / Operations + data tables`
8. `07 Admin / Settings + content + branding`
9. `08 Workflows + prototypes`
10. `09 Edge states + accessibility`
11. `10 Backend capability gaps`

### Prototype links to build
- Player: guest bet → login → wallet → deposit order → history; profile → KYC; invite → share; recovery.
- Merchant: login → online → accept order → chat → confirm/reject/red-flag → history.
- Admin: login → queue assignment → merchant/order detail → dispute resolution; branding edit → panel preview; policy edit → review → audit.

### Handoff acceptance checklist
- [ ] Every route in Sections 3–5 has a frame and mobile/desktop breakpoint as applicable.
- [ ] Every modal/drawer in Sections 3.3 and 4.3 has all states.
- [ ] Every destructive/financial CTA uses Section 5.3 confirmation pattern.
- [ ] Every backend-only capability in Section 7 has a decision: designed, intentionally hidden, or deferred.
- [ ] Logo locations use supplied asset variants and preserve accessible alternative text.
- [ ] Component names, variants, and tokens are documented; no one-off color/spacing values.
- [ ] Realtime/offline/error/loading states are represented for cycles, orders, balances, and admin queues.
- [ ] Prototype annotations identify endpoint and source route for each API-driven action.

---

## 11. Repository source references used to compile this blueprint

- Player routes/shell: `user-panel/src/App.tsx`, `user-panel/src/components/Layout/Header.tsx`, `user-panel/src/components/Layout/Footer.tsx`, `user-panel/src/components/Modals/*.tsx`, `user-panel/src/pages/*.tsx`, `user-panel/src/index.css`.
- Merchant routes/shell: `merchant-panel/src/App.tsx`, `merchant-panel/src/components/Layout.tsx`, `merchant-panel/src/pages/*.tsx`, `merchant-panel/src/services/api.ts`.
- Admin routes/shell/permissions: `admin-panel/src/App.tsx`, `admin-panel/src/components/Layout.tsx`, `admin-panel/src/Pages/**/*.tsx`, `admin-panel/src/services/api.ts`.
- API mounting and realtime: `backend/server.js`, `backend/routes/sse.routes.js`.
- API route contracts: all `backend/**/*.routes.js` and `backend/routes.js` entries listed in Section 8.
- Brand assets: `backend/app-assets/logo.png`, `backend/app-assets/logo-header.png`.

---

## 12. Premium Operations & Experience Layer (mandatory for all new frames)

### Global command palette and search
Every shell exposes **⌘K / Ctrl+K** plus a visible Search button. The palette searches pages, users, orders, transactions, games, merchants, settings, reports, and recent/favorite locations. It includes instant results, recent searches, saved searches, suggestions, keyboard arrows, Enter to open, Escape to close, and a personalized no-results recovery state. Admin operators must be able to open any permitted operational page without menu navigation.

### Notification center
Every shell has a persistent notification inbox with unread badge, `Today`, `Yesterday`, `This week`, and `Support` filters, **Mark all read**, deep-link CTA, and a read/unread visual state. Player notifications cover winnings, deposits, withdrawals and promotions; merchant notifications cover new orders, timeouts and disputes; admin notifications cover failures, merchant offline, queue spikes and alert thresholds.

### Realtime contract
Replace a generic Live label with one of: `🟢 Connected · Updated 2 sec ago · 42ms`, `🟠 Reconnecting… · Last update 1m ago`, or `🔴 Offline · Data may be delayed`. Display it near every live operational surface. Use latency only as an informational indicator; do not imply a failed financial action solely from high latency.

### Search, loading, empty, and error recovery
- Large collections require instant search, suggestion/recent/saved search choices, keyboard navigation, and a designed no-results state.
- Never use a spinner as the primary page-loading state. Use layout-matching skeletons, shimmer cards, placeholder tables, and chart shells.
- Every empty state must include illustration, headline, explanatory sentence, and a primary CTA. Example Wallet: **“No transactions yet”** / “Deposit funds to start playing.” / **Deposit**.
- Every error must state what happened, likely reason, whether retry is appropriate, whether to wait, and when to contact support. Preserve safe form input on recoverable errors.

### Information architecture normalization
| Current wording | Product navigation wording |
|---|---|
| GamePage | Home / Live Game |
| History + My Bets + Results | Activity (tabs: Transactions, Bets, Results) |
| Promo | Promotions |
| Support + FAQ + Rules | Help Center |
| Wallet + History | Wallet (Transactions tab) |
| Chat Management | Support Operations |
| Winners Manager | Leaderboard Manager |
| Merchant Platform | Merchant Insights |
| Payment Control Center | Payments Hub |

Keep legacy paths for compatibility; normalize labels and group related destinations in navigation.

### Financial and account experience
Wallet must separately show **Available balance**, **Pending balance**, **Locked funds**, **Bonus balance**, **Withdrawal eligibility**, deposit order progress, and a transaction timeline. Profiles expose an Activity Timeline (login, deposit, withdrawal, bet, KYC, dispute and messages). Player session controls show current device, other devices, and Logout Other Sessions. Merchant/Admin sessions show recent login time, masked IP, browser, country, device and terminate action.

### Player progression and premium content
VIP is a premium experience with tier-progress animation that respects reduced motion, benefit comparison, rewards, upcoming unlocks, VIP history, and exclusive events. Referral shows the funnel **Invited → Registered → Deposited → Playing → Commission earned**. Optional gamification includes daily streak, achievement badges, mission/season progress and personal statistics; it must never obscure a wager, balance, risk notice, or financial workflow.

### Merchant mobile workflow
At mobile widths the merchant console prioritizes a sticky, thumb-friendly action bar: **Accept**, **Reject**, **Chat**, **Upload proof**, **Complete**. Order cards prioritize countdown/timeout risk, amount, state, and assigned player context. Include pinned orders, notes, priority timers, quick approve/reject with confirmation, bulk-safe actions, and documented keyboard shortcuts on desktop.

### Admin productivity and charts
Admin supports command palette, favorites, recent pages, saved dashboards, custom/resizable widgets, quick filters, split-view list/detail workflows, bulk editing, and saved searches. Specify chart usage: area for balance/revenue trends; bars for category comparisons; lines for time-series; heatmaps for operational density; donut for state distribution; leaderboard for rank; realtime sparkline for live metrics; calendar heatmap for daily behavior.

### Activity, order, and chat timeline patterns
Order tracking follows **Created → Assigned → Merchant Accepted → Proof Uploaded → Confirmed → Completed**, with timestamps and exceptions. Chat requires typing indicator, delivery/read receipts, grouped messages, attachment/image preview, upload progress, quick replies, pinned notices, and an immutable order header. All profile views use the same activity timeline grammar.

### Responsive, accessibility, and brand rules
- Desktop: persistent sidebars, dense tables, inline filters, detailed charts. Tablet: rail/sidebar collapse, 2-column cards, simplified charts. Mobile: tables become cards, filters move to drawers, sticky bottom actions appear for high-frequency tasks, and no critical CTA is below a browser/WebView safe area.
- Test the semantic color set in color-blind, high-contrast, large-text, reduced-motion, and reduced-transparency modes. Publish shortcut documentation in every command palette/help surface.
- Design-system documentation must include component anatomy, Do/Don’t examples, spacing rules, animation rules, elevation/border/blur usage, voice and tone, icon guidelines, and illustration guidelines.
- Brand identity extends beyond logo/color: use geometric deep-navy background patterns, restrained 3D/glass objects, clear motion hierarchy, inclusive non-stock photography guidance, and optional mascot usage only in promotional/onboarding contexts.

### Onboarding checklists
Player: Welcome → Verify → Deposit → Place first bet → Claim bonus. Merchant: Complete profile → Upload QR → Go online → Accept first order. Admin: guided setup checklist for branding, payment configuration, merchant capacity, roles, and monitoring. Each checklist is dismissible, resumable, and does not block regulated actions.
