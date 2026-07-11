# BettingBazaar — Complete UI/UX Specification (Part II)

> Companion to `UI_UX_DESIGN_BRIEF.md` (read that first for the performance bar +
> dual-theme token system + repo map). This file is the **exhaustive surface
> inventory**: the visual language, every screen and element across all panels,
> each mapped to its backend source so **nothing is left out**, plus the
> Excel-grade reports spec, the public-chat spec, and the research notes.
> Reference DNA only — never clone a competitor's exact logo/wordmark.

---

## 1. VISUAL LANGUAGE — neon-futuristic + 3D depth (Stake calm × BC.Game vibrance)

Grounded in 2026 trends (see §9): **neon is glow through darkness** — the effect
lives in the *diffusion* ("light fog" bleeding into deep space), not flat bright
color. Build on true-dark canvases; let focal elements emit a soft, tactile glow.

- **Mood**: premium, exciting, effortless, "pleasant to the eyes" — Stake's calm
  precision as the base, BC.Game's vibrant discovery for game grids, and the
  **Winners page's futuristic neon** as the north star for the USER panel's
  celebratory/hero surfaces.
- **Depth (the "3D feeling")**: layered surfaces with 1px hairline borders + a
  faint inner top highlight (the glass edge), soft ambient shadows, and tasteful
  lift/parallax/tilt on interactive cards (≤6°, GPU-only, disabled under
  `prefers-reduced-motion`). Everything **rounded** — cards & thumbnails
  `radius 16–20px`, controls `12px`, chips/pills full.
- **Neon glow system** (use SPARINGLY — only focal CTAs, active nav, live/winner,
  positive money): layered `box-shadow`/`drop-shadow` glow tokens
  `--glow-primary`, `--glow-positive`, `--glow-accent`; a subtle radial "light
  fog" gradient behind heroes and the winner board.
- **Typography feel**: wide-set, high-contrast geometric/grotesk sans for a
  "spaceship dashboard" read; **tabular figures** for money/odds/timers; optional
  thin double-line/inline treatment for big hero numerals. Keep body highly legible.
- **Micro-animations reward attention** (hover glow, card lift, count-up, a
  contained confetti/glow burst on a win) — never overwhelming, always 60fps,
  always reduced-motion-safe.

### 🔒 PRESERVE — do NOT restyle the core cycle game's CARDS and CHIPS
The **Delhi vs Bombay** bet **cards** and the **betting chips** keep their current
theme and identity (their colors, the 3D chip look in `index.css` `.chip-3d` /
`glassmorphism.css` `.bet-chip`). You may improve their **polish** (performance,
press feel, micro-interaction) but must **not change their visual theme**.
Everything else in the app may be completely redesigned/replaced.

### Theming
Two themes off one semantic-token layer (see brief Part I): **dark = neon-futuristic
(user-panel default)**; **light = 1xBet-dense (admin default, data-forward)**.
Tokens are CSS variables themed by `:root` / `[data-theme]`; Tailwind maps to them.
Admin reports read best in light; user panel shines in dark neon.

---

## 2. TYPOGRAPHY · SIZING · DENSITY · SCROLL (global system)

- **Type scale**: reuse/extend the fluid `clamp()` scale already in
  `glassmorphism.css` (`--text-xs … --text-4xl`). Weights: display 800–900,
  headings 700, body 400–500, numerals **tabular-nums**.
- **Spacing**: strict **8pt grid** (4/8/12/16/24/32/48). Consistent radii scale
  (chips full · controls 12 · cards 16 · sheets 20 · modals 24).
- **Aspect ratios**: game thumbnails **3:4 portrait** (casino) or **16:9**
  (crash/hero); stat tiles **1:1 / 2:1**; keep them uniform so grids read as a
  system (consistent sizes = predictable, scannable browsing).
- **Hit targets** ≥44px; icon buttons get labels/aria.
- **Scroll**: momentum + `overscroll-behavior: contain` (already set), thin themed
  scrollbars (already set), **sticky section headers**, horizontal **snap** rails
  for categories, no nested-scroll traps, **virtualize** long lists (history,
  chat, transactions, big grids). One scroll container per view; the shell
  (header/tabs) stays fixed.

---

## 3. USER PANEL — every screen & element → backend

**Global shell** (`App.tsx`, `components/Layout/*`)
- **Header**: brand logo; **Wallet chip** (spendable / winnings / locked, tap →
  wallet sheet) ← `GET /api/v1/user/profile`; notifications bell ←
  notifications API; profile avatar → `/profile`; **theme toggle**; **Login/Register**
  CTA when logged-out (opens Auth modal). Live balance via `system_config` +
  wallet events (SSE/socket).
- **GameCategoryStrip** (`components/Game/GameCategoryStrip.tsx`): dynamic chips ←
  `GET /api/game/categories` (Game Registry). Provider-gated tabs (casino/crash/
  sports) appear only when a provider is enabled ← `GET /api/game/providers`.
- **Bottom tab bar** (mobile, app-like, thumb-zone): Home · Games · Wallet ·
  Bets · Profile. Safe-area aware.
- **Global states**: maintenance screen ← `SystemConfig.maintenanceMode`;
  version-update gate ← `minVersion/latestVersion`; toasts; skeletons; error
  boundary; offline banner.

**Home / Cycle Game** `/` (`pages/GamePage.tsx`, `components/Game/*`) — the live product
- Live **countdown** timer (server-authoritative endTime); two **pools**
  (Delhi/Bombay) with combined totals; **phase** states (OPEN → MERGED → CLOSED →
  RESULT/celebration) ← cycle SSE events; **🔒 PRESERVED bet cards + chips**;
  **quick-stake** chips (e.g. +10/+50/+100/½/2×) feeding stake; **Place Bet**
  (optimistic, min/max from `betLimits`) ← `POST /api/bet/place`; **my current
  bets** on this cycle; **live ticker** of recent bets; **winner/celebration FX**
  (neon, contained). Phantom users: ghost-bet control (admin-granted) ←
  `POST /api/bet/phantom`.

**Casino lobby** `/casino` (already metadata-driven)
- Featured **hero**; **category rails** (snap-scroll) ← `/api/game/categories`;
  **game grid** (BC.Game cards: 3:4 rounded thumbnail, provider label, one badge,
  RTP, MAINTENANCE=locked) ← `GET /api/game/games`; **search**; **provider
  chips**; **tag filters** (all client-side, instant); **launch** → fullscreen
  iframe ← `POST /api/game/launch` (reuses session/wallet spine).

**Crash & Instant** `/crash`: featured hero + grid ← `/api/game/games?category=crash`.
**Sports** `/sports`: provider-gated; event list + **betslip** (see §6 betslip pattern).

**Wallet** `/wallet` (`pages/WalletPage.tsx`, `components/Modals/WalletModal.tsx`)
- **Balances** breakdown (spendable / winnings / locked, with plain labels).
- **Deposit** flow ← `POST /api/payment/deposit` → merchant assignment: amount +
  method (UPI/BANK) chips, **assigned-merchant card** (name/UPI/QR/bank), **pay
  window countdown** (`orderExpiryMinutes`), **UTR** submit, **proof upload** (S3),
  order status (ASSIGNED→PAID→COMPLETED / DISPUTED / EXPIRED).
- **Withdraw** flow ← `POST /api/payment/withdrawal`: amount, bank details, **fee
  preview** (`payoutFeePercent`), min/max (`minWithdrawal/maxWithdrawal/
  maxWinningsWithdrawal`).
- **Transaction history**: filter + pagination ← `GET /api/admin/transactions`
  (user-scoped equivalent) / user endpoints; order cards; **raise dispute**.
- Instant-funding emphasis (payment friction = churn; see §9).

**Profile** `/profile` (`pages/ProfilePage.tsx`)
- Avatar **upload** (S3); **display name**; **Email** (validated) ←
  `PUT /api/user/:id/profile`; **change password**; **bank details**;
  **KYC** status + submit/resubmit (Aadhaar/PAN + selfie, rejection reason) ←
  KYC API; **phantom-access** badge; **balances + Net P&L**; **logout**.

**My Bets** `/my-bets`: dense personal bet rows (side, amount, status, payout).
**History** `/history`: global cycle history. **Results** `/results`: dense results.
**Winners** `/winners`: **neon winner board** (north-star aesthetic) ←
`GET /api/v1/winners` (status WON + payout + cycle context) + leaderboard.

**Invite / Referral** `/invite` (`routes/referral.routes.js`)
- Invite **code** + share; **referral tree** F1/F2/F3; **earnings** (total/today);
  reward rates display ← `ReferralConfig`. (Commission auto-credits on referral bets.)

**VIP** `/vip` (`routes/vip.routes.js`): tiers, progress bar, perks.
**Gift codes** `/gift-code` (`routes/giftcode.routes.js`): redeem input + history.

**Public Chat** `/chat` — ⚠️ **currently stubbed (renders null)**. Design & build it (see §7).

**Support** `/support`: support links (WhatsApp / Telegram username+group+channel /
email / help-center / terms / privacy) ← `SystemConfig.supportLinks`. **Rules**
`/rules`, **FAQ** `/faq` ← CMS, **Promo** `/promo`.

**Auth modal** (`components/Modals/AuthModal.tsx`): tabs Login / Register / Recover
Account ← auth + `routes/account-recovery.routes.js`; password rules; post-register
KYC prompt.

---

## 4. ADMIN PANEL — every screen → backend (Excel-grade tables; light default)

Nav groups already exist in `admin-panel/src/components/Layout.tsx`. Redesign each;
tables follow §5 (Excel-grade). Columns/actions + source per screen:

- **Dashboard** — KPI stat tiles (users, volume, revenue, live cycles) ← `/admin/stats`.
- **Live Cycles / Cycle History / Profit & Loss** ← cycles admin + analytics.
- **Users** — table (username, mobile, balances, KYC, blocked, warnings), actions
  (view, adjust balance, block, phantom-access grant) ← `users.admin.routes.js`.
- **Balance Adjust** — audited manual credit/debit form.
- **Merchants** — list + fund/deduct wallet + limits ← `merchant.admin.routes.js`.
- **KYC Queue** — review queue with document **preview**, approve/reject+reason ←
  `kyc.admin.routes.js`.
- **Queue Manager** — manual/forced order assignment console (merchant pool) ←
  `merchant.assignment.routes.js` + `queueManagerPool`.
- **Transactions** — Excel-grade ledger of all transactions (filter type/status,
  export) ← `system.admin.routes.js`.
- **Payment System** — provider/method enable, gateway config.
- **Disputes** — dispute queue, evidence, resolve ← `disputeResolution.admin.routes.js`.
- **Deposit Policy** — versioned split/reserve editor (create/schedule/approve/
  rollback/history) ← `depositPolicy.admin.routes.js`.
- **Revenue & Ledger** — double-entry **ledger console** (trial balance,
  distributable revenue, integrity flag), paginated postings, **bonus-pool fund**,
  regulatory **CSV export** ← `revenue.admin.routes.js`.
- **Operations** — platform overview (settlement/treasury/funding/risk/policy/
  merchant/comms/flags) + **config catalog** + retention run ←
  `operations.admin.routes.js`.
- **Reports** — financial / settlement / merchant reports + regulatory CSV; **all
  Excel-grade** (see §5) ← `reporting.admin.routes.js`.
- **Merchant Platform** — bonus policy editor, leaderboard, wallet ledgers, engine
  run ← `merchantPlatform.admin.routes.js`.
- **Game Registry** — games + categories CRUD (built) ← `gameRegistry.routes.js`.
- **Game Providers** — provider credentials/enable/test ← `gameProvider.routes.js`.
- **Account Recovery** — review recovery requests.
- **Winners Manager / Announcements / Gift Codes / FAQ Manager / Page Slides /
  Support Links / CDN Library** ← CMS/content admin routes.
- **Branding** — colors/logos/names/banners (live-applied) ← `branding.admin.routes.js`.
- **App Assets (PWA)** — icon/splash slot uploads (S3-backed) ← app-assets routes.
- **System Settings** — all business config (money rules, risk rules, cycle timing
  + phase editor, order expiry, auto-block, payout multiplier, limits, maintenance,
  KYC/registration toggles, app URLs/versions) ← `system.admin.routes.js`
  (see `BUSINESS_CONFIG_AUDIT.md`).
- **Sub-admins** — role/permission matrix ← `subadmins.admin.routes.js`.
- **Audit feed** — activity/audit stream (Excel-grade) ← `audit.admin.routes.js`.
- **UTR registry** — UTR uniqueness lookup ← `utr.admin.routes.js`.

---

## 5. REPORTS = EXCEL (data-grid spec — applies to every admin table)

Every admin list/report must read and behave like a **spreadsheet** (grounded in
AG-Grid/Syncfusion enterprise patterns, §9):

- **Sticky header row + pinned first column**; **zebra** rows; compact density
  toggle (comfortable/compact).
- **Sort** per column (multi-sort); **column filters** (text/number/date/enum);
  global search; **resizable + reorderable** columns; column show/hide.
- **Virtualized** rows (thousands without lag); server pagination fallback.
- **Cell formatting**: money right-aligned **tabular-nums** with currency; status
  as colored **pills**; dates ISO/local; integrity flags highlighted.
- **Footer/total row** (sums, counts); **grouping/subtotals** where useful.
- **Export**: CSV **and** Excel (`.xlsx`) with formatting preserved; **Print** view;
  copy-cell. (Revenue/Reports already emit regulatory CSV — surface a one-click
  export button on every grid.)
- **Saved views** (filters+columns) per admin; empty/loading skeleton states.
- Light theme for density; keep it calm (1xBet-grade information design) — not neon.

---

## 6. BETTING / BETSLIP / WALLET PATTERNS (grounded in sportsbook UX, §9)

- **Simplicity**: break dense info into chunks; progressive disclosure.
- **Sticky, thumb-friendly betslip** (slide-up sheet on mobile / rail on desktop)
  with **real-time preview**: stake, potential return, and (for provider games)
  cashout — before committing. Repositioning/optimizing the slip measurably lifts
  engagement.
- **One-tap place** with quick-stake chips; optimistic UI + clear rollback on error.
- **Instant wallet funding**: minimize deposit steps; show methods up front;
  surface the pay-window countdown; fast, obvious status. (Slow/complex payment =
  ~40% post-registration churn.)
- Odds/pools **flash green up / red down** on change; big clear CTAs.

---

## 7. PUBLIC CHAT (full spec — it is currently a stub that renders nothing)

Design and implement `/chat` (glass bubble classes already exist:
`.chat-bubble-sent/recv/system`):
- **Layout**: virtualized message list (auto-scroll, "jump to latest" pill), sticky
  composer (input + send + emoji), presence/online count, room/tab if multiple.
- **Message types**: user (sent/received bubbles with avatar+name+time), **system**
  (winner announcements, big-win callouts), pinned/announcement.
- **Send UX**: optimistic append; rate-limit feedback (cooldown chip); character
  limit; link/emoji; disabled state when logged-out (prompt to login).
- **Moderation (admin “Chat & Support”)**: delete message, mute/ban user, slow-mode,
  profanity filter, report flow, rules modal.
- **Safety/RG**: no sharing of personal payment info; responsible-gaming footer.
- Neon accents on system/win messages; keep it lightweight & fast.

---

## 8. BUTTON & INTERACTION INVENTORY (design all states)

States for **every** control: default / hover / **active(press)** / focus-visible /
disabled / loading / success / error.
- **Archetypes**: primary (neon-glow CTA), secondary (outline/glass), ghost/tertiary,
  destructive (red), icon button, quick-stake chip, toggle/switch, segmented tabs,
  dropdown/select, stepper (+/−), FAB (mobile), link.
- **Satisfying press** (fixes the "throttled" feel): feedback on `pointerdown`
  <100 ms — fast scale 0.97 + brightness/elevation shift + optional haptic; inline
  busy state inside the button (never a full-screen block); focal CTAs carry the
  neon glow, intensifying on hover.
- Inputs: numeric with steppers, currency mask, validation inline, clear affordance,
  large touch targets.
- Feedback: toasts (success/error/info), inline field errors, empty states with a
  clear next action, skeletons for every async region.

---

## 9. RESEARCH NOTES (2026) & SOURCES

- **Neon/futuristic**: the glow is in the *darkness + diffusion* ("light fog"),
  built on deep charcoal/navy/true-black; pairs with 3D depth, fluid gradients, and
  dark glassmorphism; wide-kerned high-contrast sans reads "spaceship dashboard."
- **Casino grids/thumbnails**: consistent card sizes make browsing predictable;
  thumbnails are miniature storefronts that drive click-through; dark + neon accents
  keep focus on content; micro-animations (hover, flip, small confetti) reward
  attention without overwhelming.
- **Enterprise data grids (reports)**: AG-Grid/Syncfusion-class features — Excel-like
  filtering, sticky rows/columns, sorting, grouping, virtualization, and Excel/PDF
  **export with formatting preserved** — are the baseline for data-rich admin tables.
- **Sportsbook UX**: simplicity + chunking; a sticky, thumb-friendly betslip with
  real-time stake/return/cashout preview (repositioning it lifted engagement ~20%);
  instant wallet funding (slow payments churn ~40% of new users); mobile-first,
  scale up to desktop.
- **Theming**: semantic **design tokens** (a name carries a role; value swaps per
  theme) are the 2025/26 standard for scalable light/dark systems; dark surfaces use
  dark-grays (#121212–#1C1C1C) not pure black; body contrast ≥4.5:1, large ≥3:1.

Sources: Stake/BC.Game reference DNA + these:
- Muzli — Dark Mode Design Systems (patterns/tokens/hierarchy)
- The Visual Communication Guy — Neon, Gradients & 3D Colors (UI/UX trends)
- Advise Graphics — Neon Graphic Design Trend 2026 style guide
- Medium (MustBeWebCode) — Dark Glassmorphism 2026
- St8.io — Casino Game Thumbnails design
- Caring Well — "Neon Velvet": online casino atmosphere
- AG Grid — Excel Export (React/JS) & Community vs Enterprise; Stéphanie Walter —
  designing complex data tables
- Prometteur / Medium (Adelina Butler) / The Unit — sports-betting app UX & betslip
- materialui.co / EDL / uinkits — design tokens & dark-mode systems 2025

(Full URLs shared in chat alongside this spec.)
