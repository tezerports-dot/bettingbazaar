# Betting-Bazaar — FULL-PLATFORM Premium Redesign Prompt Pack
### Covers: user-panel (19 pages + 4 modals), admin-panel (34 routes + 12 shared components), merchant-panel (6 pages) — every layout, workflow, font, aspect ratio, device.

> **How to use:** Paste the phases into Claude (Claude Code / Claude Design) **one at a time, in order**.
> Each phase ends with a build + verification gate. Do not skip Phase 0 or Phase 6.
> Every fact below (file paths, routes, workflows, colors) was verified against the real repo — Claude doesn't need to rediscover them, only confirm.

---

## PHASE 0 — AUDIT & INVENTORY (paste first, wait for its report before continuing)

```
ROLE: You are a senior product designer + UI/UX architect + React engineer specializing
in premium betting/casino platforms and fintech back-office tools.

PROJECT: "Betting-Bazaar" — a real-money Delhi Bazaar vs Bombay Bazaar betting platform
(Indian market, ₹/UPI). Monorepo with THREE frontends you will redesign end-to-end:
  1. user-panel/     — player app (React 18 + Vite + TS + Tailwind darkMode:'class',
                       framer-motion ^11 installed, lucide-react, react-three-fiber)
  2. admin-panel/    — back office (React + Vite + TS + Tailwind, dark+gold theme,
                       sidebar Layout, shared components in src/components/)
  3. merchant-panel/ — payment-merchant console (React + Vite + TS + Tailwind,
                       currently a PLAIN gray/white utility UI, react-hot-toast)
Do NOT touch backend/, APIs, sockets, auth logic, or game logic. Visual/UX layer only.

HARD RULES (apply to every phase):
R1. Read docs/governance/04-GOVERNANCE.md BEFORE editing any file that carries the
    governance header. Brand colors must be CSS variables — never hex literals in
    components. user-panel already has --brand-primary/--brand-secondary/--brand-accent
    set at :root in src/index.css and overwritten live by a branding socket in
    App.tsx (~lines 118-120). EXTEND this token system; never break the live override.
R2. Preserve every existing workflow, route, API call, state machine, and user habit.
    Same product, premium skin. Delhi=red #E53935, Bombay=blue #1E88E5, gold #D4AF37.
R3. Every interactive element you touch must ship with ALL states defined:
    default / hover / focus-visible / active-press / loading / disabled / success /
    error — plus confirm-before-destructive for dangerous actions.
R4. Nothing may clip or overflow: audit every flex child for min-w-0, every table for
    an overflow-x-auto wrapper, every long string (usernames, UTRs, order IDs, mobile
    numbers) for truncate + title/tooltip, every fixed-height container for content
    growth, and every screen for horizontal scroll at 320px.
R5. Both themes (dark premium / light professional) must work on every component you
    create in user-panel; admin stays dark-first, merchant light-first (details in
    Phase 1) — but all share one token vocabulary.

TASK NOW (analysis only — no code yet):
1. Verify this route/component inventory against the repo and flag anything
   missing/renamed (this list was extracted from the actual App.tsx files):

   USER-PANEL routes (HashRouter, src/App.tsx):
   / (GamePage), /casino, /crash, /sports, /wallet, /invite, /vip, /gift-code,
   /recover-account, /profile, /history, /my-bets, /results, /promo, /rules, /faq,
   /support, /winners  (+ LeaderboardPage.tsx exists in src/pages — confirm whether
   routed; if orphaned, report it).
   Modals: AuthModal, WalletModal, KYCModal, ShareModal (src/components/Modals/).
   Game components: BettingCard, BetControls, CycleControl, GameCategoryStrip,
   LivePoolStats, LiveTicker, ResultsPanel (src/components/Game/).
   Layout: Header, Footer. UI: Modal, Toast, SafeImage, Show, ErrorBoundary.
   Plus SceneBackground.tsx (3D) and glassmorphism.css utilities.

   ADMIN-PANEL routes (src/App.tsx): /login, / (Dashboard), /live-cycles,
   /cycle-history, /profit-loss, /users, /users/balance-adjust, /merchants, /kyc,
   /queue-manager, /transactions, /payment-control, /disputes,
   /business-policy/deposit, /revenue, /operations, /reports, /merchant-platform,
   /content/faq, /content/slides, /content/support, /content/cdn, /branding,
   /app-assets, /sub-admins, /settings, /audit-logs, /error-logs, /account-recovery,
   /winners-manager, /chat-management, /game-providers, /games,
   /promotions/gift-codes, /promotions/announcements.
   Shared components: ConfirmDialog, DataTable, DateRangePicker, EmptyState,
   FileUpload, Layout (grouped sidebar w/ permissions), LoadingSpinner, Modal,
   SearchBar, StatCard, StatusBadge, UserAvatar. Note: UTRManager.tsx page exists
   but its nav item was removed — confirm route status before styling.

   MERCHANT-PANEL routes: / (LoginPage), /dashboard, /orders (OrderManagement),
   /history (HistoryViews), /profile (ProfileSettings). BulkPayouts.tsx exists but
   nav was removed (instant per-order payouts) — confirm route status.
   Components: CountdownTimer, OrderCard, Layout (white header + online/offline
   toggle + logout).

2. For EACH of the three panels, produce a short audit table:
   page/component → current visual state → UX problems found (clipping risks,
   missing states, inconsistent spacing/fonts, mobile issues) → planned upgrade.
3. List every file you plan to touch in Phases 1-5, grouped by phase.
4. Screenshot or describe the current GamePage, admin Dashboard, and merchant
   OrderManagement as the three "before" baselines.
Output the audit + plan and STOP. Wait for my approval before Phase 1.
```

---

## PHASE 1 — GLOBAL DESIGN SYSTEM (one token vocabulary for all three panels)

```
Implement the shared design system. No page redesigns yet — only foundations, applied
so that existing screens still render correctly.

1. DESIGN TOKENS (per panel, same vocabulary):
   Define on :root and :root[data-theme="light"] (user-panel), :root (admin, dark
   default), :root (merchant, light default + optional dark):
     --background --surface --card --card-elevated --foreground --muted
     --primary --primary-foreground --secondary --accent --border --ring
     --success --warning --danger --info
     --delhi:#E53935 --bombay:#1E88E5
     --radius-sm/-md/-lg/-xl  --shadow-sm/-md/-lg/-glow
     --space-1..--space-12 (4px base scale)
   In user-panel, MAP the existing --brand-primary/secondary/accent into
   --primary/--secondary/--accent (var chaining) so the admin branding socket keeps
   working. Wire every Tailwind config to read tokens (colors: {background:
   'var(--background)', ...}) so components use semantic classes, never hex.

   BRAND IDENTITY (unique — do not clone Stake/BC.Game/1xBet):
   "Royal Casino": deep navy + luxury gold + jewel chip accents (matches the real
   betting-bazaar.com logo: navy field, gold type, red/blue/green/black chips,
   roulette wheel, crown). References are for QUALITY only: Stake = dark contrast
   + card grids; BC.Game = fluid speed; 1xBet = information density done cleanly.
   USER DARK (default):  --background #070B14, --surface #0D1420, --card #111A2B,
     --card-elevated #16223A, --border rgba(212,175,55,.14), --foreground #EAF0FA,
     --muted #8B97AD, --primary gold #D4AF37, accents: green #22E39A / blue #3B82F6.
   USER LIGHT: --background #F5F7FB, --surface/#card #FFFFFF, --border #E3E8F0,
     --foreground #0D1420, --muted #5B6577, CTAs deep gold/navy. Trust + clarity.
   ADMIN (dark-first): keep the existing dark-900 #0B0E14 + gold-500 #D4AF37 scheme,
     tokenized. Restraint: no decorative gradients/glow in data areas — research
     shows back-office clarity beats ornament. Gold reserved for primary actions,
     active nav, and key numbers.
   MERCHANT (light-first): replace the unbranded gray/white with a professional
     branded light theme (white surfaces, navy text, gold primary CTA, green/red
     operational states) + a dark variant. It is an all-day operational tool:
     legibility and speed first.

2. TYPOGRAPHY SYSTEM (every font, every panel):
   - UI/body/data: Inter (already the stack) — self-hosted, weights 400/500/600/700/900.
   - Display (user-panel headings, game titles, VS banner, VIP): add ONE self-hosted
     display serif with a luxury feel (e.g. Cinzel or Marcellus via @fontsource);
     use sparingly: page titles, DELHI vs BOMBAY, jackpot/win moments.
   - Numbers: font-variant-numeric: tabular-nums on ALL money, odds, balances,
     countdowns, table amount columns (prevents jitter as values tick).
   - Fluid scale with clamp() as tokens:
     --text-xs .75rem; --text-sm .875rem; --text-base clamp(.9375rem,.9rem+.3vw,1rem);
     --text-lg clamp(1.05rem,1rem+.4vw,1.2rem); --text-xl clamp(1.2rem,1.1rem+.8vw,1.5rem);
     --text-2xl clamp(1.4rem,1.2rem+1.2vw,2rem); --text-display clamp(1.75rem,1.4rem+2vw,3rem).
   - Line length ≤ 72ch for prose (Rules/FAQ/Support); line-height 1.5 body, 1.2 display.
   - Minimum 16px on inputs (prevents iOS zoom-on-focus).

3. RESPONSIVE FOUNDATION (auto-adjust to every device):
   Breakpoints: 320 micro / 360-450 phone / 600-900 foldable+small tablet (explicit
   treatment — Galaxy Fold is 374px folded, 832px unfolded) / 768 tablet /
   1024 laptop / 1280-1440 desktop / 1600+ ultra-wide (cap content max-w, center).
   Rules: dvh not vh for full-height screens; safe-area insets already exist via
   --sat/--sab/--sal/--sar — apply them to all fixed headers/footers/bottom bars;
   44px minimum touch targets; no horizontal scroll at any width from 320px up;
   test landscape phones (short viewport) — sticky elements must not eat the screen;
   use CSS container queries for components that appear in different width contexts
   (StatCard, OrderCard, game cards).

4. ASPECT-RATIO SYSTEM (media never distorts or clips):
   aspect-video (16:9) promo banners/slides; aspect-[4/3] or 16:9 game thumbnails
   (pick one, enforce with object-cover + rounded); aspect-square avatars, chips,
   QR codes; logo containers use object-contain with fixed height, never stretch.
   Every <img> gets width/height or aspect class (no CLS), lazy loading below fold,
   and a skeleton shimmer placeholder (user-panel SafeImage is the hook point).

5. CORE COMPONENT LIBRARY (build once per panel, reuse everywhere):
   Button (primary/secondary/ghost/danger/gold-cta; all R3 states; ripple+press
   scale in user-panel, subtle in admin/merchant), Input/Select/Textarea (label,
   helper, error, disabled, prefix ₹), Card, Badge/StatusBadge, Tabs, Modal/Drawer
   (focus trap, ESC, scroll lock, mobile bottom-sheet variant), Toast (success/
   error/info, queued, safe-area aware), Skeleton (shimmer), EmptyState (icon +
   message + action), Tooltip, Pagination, ConfirmDialog (danger variant requires
   explicit confirm), ThemeToggle.
   THEME TOGGLE (user-panel now, merchant optional): persist localStorage('bb-theme'),
   apply before first paint in index.html or App bootstrap (no flash), toggle sets
   documentElement dataset.theme + 'dark' class, ~300ms transition, respect
   prefers-reduced-motion.

6. MOTION SYSTEM (framer-motion in user-panel; CSS transitions in admin/merchant):
   Tokens: --ease-out cubic-bezier(.16,1,.3,1); durations 150/250/400ms.
   Page transitions (fade+4px rise) via AnimatePresence; card hover lift (translateY
   -2px + shadow); button press scale .97; skeleton→content crossfade; number
   tick animation for balances. 60fps: transform/opacity only. Admin/merchant get
   FAST subtle motion only (150ms) — operators click hundreds of times a day.

VERIFY: run all three builds (npm --prefix user-panel run build, same for
admin-panel and merchant-panel). Boot each app; confirm zero visual regressions on
GamePage, admin Dashboard, merchant OrderManagement; confirm branding socket still
recolors user-panel live. Report results, then STOP for my approval.
```

---

## PHASE 2 — USER PANEL: every page, every modal, every component

```
Apply the Phase-1 system to the ENTIRE user-panel. Work top-down in this order.
For every page: both themes, all 7 breakpoints, skeleton loading, EmptyState for
no-data, error state with retry, and R3 button states. Bet actions stay reachable
in the bottom ~30% thumb zone on mobile; any core action ≤ 2 taps.

A. LAYOUT SHELL
A1. Header.tsx — sticky, glass/blur over content, logo (object-contain, never
    stretched), nav (Games/Casino/Sports/Wallet/Profile), live balance with
    tabular-nums + tick animation, ThemeToggle, auth state (login CTA vs avatar
    menu). Mobile: slim header + thumb-friendly menu; keep balance always visible.
A2. Footer.tsx — trust block: licensing/responsible-gaming/18+, payment icons,
    quick links, support entry. Mobile: consider a bottom tab bar (Game/Casino/
    Wallet/Profile) with safe-area padding; never overlap page CTAs.
A3. GameCategoryStrip — horizontal scroll chips with scroll-snap, active state,
    edge-fade masks so cut-off items signal scrollability (no hard clipping).

B. GAME PAGE (/) — THE CROWN JEWEL. PRESERVE, DON'T REPLACE.
   Composition stays exactly: Header → GameCategoryStrip → CycleControl →
   "DELHI BAZAAR VS BOMBAY BAZAAR" title + LivePoolStats → BettingCard →
   ResultsPanel → BetControls → Footer.
B1. BettingCard: KEEP split Delhi(red)/Bombay(blue) tap-to-bet card, gold VS badge,
    gold divider, winner particles/shimmer/glow, BETS CLOSED lock overlay, POOLS
    MERGED overlay, "You: ₹X" badges, states from GAME_CORE.BETTING_ALLOWED
    (OPEN/CLOSED/MERGED/RESULT_DECLARED) untouched. Upgrade only: richer gold
    borders/gradients, smoother framer-motion hover/tap (scale/lift), deeper
    premium shadows, crisper typography (display font for city names), better
    scaling 320→1600 (card max-width per breakpoint, height fluid, images
    object-cover with art-direction safe crop).
B2. BetControls: KEEP chip row (values from CHIP_VALUES[cycleType]; progression
    10→30→90→270→810), chip color meanings (red/green/blue/purple/black + gold rim),
    manual amount input, Ghost Mode (agents). Upgrade: 3D chip depth via layered
    shadows, selected chip lifts + gold glow ring, press = navigator.vibrate(50)
    (already there — keep), chips ≥48px touch, horizontal snap-scroll on 320px
    without clipping half a chip invisibly.
B3. CycleControl: 30-MIN / FULL-DAY switch as segmented control with animated
    active pill + countdown timer (tabular-nums, urgency color <60s).
B4. LivePoolStats + LiveTicker: live numbers tick smoothly (no layout shift),
    merged state hides pools per existing logic.
B5. ResultsPanel: result strip + expandable history; win = gold, loss = muted red;
    smooth expand animation.

C. MODALS (all use the new Modal: focus trap, ESC, scroll-lock, mobile bottom-sheet)
C1. AuthModal — login/register toggle, mobile+password, captcha, referral code
    (prefilled from sessionStorage). Upgrade: two-panel premium look, inline
    validation on blur, show/hide password, loading button state, error text under
    field not alert(), 16px inputs. KYC/fintech research: fewest fields visible,
    progressive disclosure, plain-language microcopy.
C2. WalletModal — KEEP the buy/sell tabs and the form→waiting→done state machine
    with live order status. Upgrade: balance summary card (deposit vs winnings),
    stepper UI for waiting state (created→paid→confirmed) with animated progress,
    UTR/order id copy button, clear error recovery (retry CTA). Money always
    tabular-nums with ₹ prefix.
C3. KYCModal — KEEP fields (name on Aadhaar, 12-digit Aadhaar, id-proof upload,
    selfie upload via presigned PUT). Upgrade per KYC drop-off research (70%
    abandon >3min): show "~90 seconds" time hint, 2-step progressive flow
    (details → uploads), drag/tap upload zones with image preview + replace,
    upload progress bar, success screen with "under review" status. Never lose
    entered data on error.
C4. ShareModal — native share when available, copy-link with "Copied ✓" feedback,
    referral code displayed big + QR (aspect-square).

D. REMAINING PAGES (apply system; each gets: hero/title, skeletons, empty, error)
D1. /casino + /crash — game-card grid (fixed aspect thumbnails, hover lift+glow,
    provider badge), category filter chips, skeleton grid while loading.
D2. /sports — 1xBet-style structured lists: league groups, match rows (teams,
    time, odds buttons with press states), collapsible sections, sticky league
    headers on mobile. Odds buttons: tabular-nums, flash on change.
D3. /wallet — balance overview cards (deposit/winnings split), deposit & withdraw
    CTAs (open WalletModal flows), transaction list with StatusBadge
    (pending/success/failed), filters, infinite scroll or pagination.
D4. /profile — avatar (aspect-square), account info, KYC status card with CTA to
    KYCModal, bank details, settings; logout with confirm.
D5. /history, /my-bets, /results — data lists: date-range filter, win/loss color
    coding, cycle badges (30-MIN/FULL-DAY), mobile = card rows not tables,
    desktop = table with overflow-x-auto wrapper; totals row.
D6. /vip — tier cards (bronze→gold→diamond) with progress bar to next tier,
    display font for tier names, gold treatment intensifies with tier.
D7. /invite — referral link copy, ShareModal trigger, commission stats cards,
    invited-users list.
D8. /gift-code — single-purpose form: big code input (auto-uppercase, monospace),
    redeem button with loading/success (confetti micro-moment) /error states.
D9. /promo + /winners — promo banner cards (aspect-video, object-cover), winners
    feed with amount highlights (this page is social proof — make wins feel real:
    avatar, game, amount in gold, relative time).
D10. /rules, /faq, /support — readable prose ≤72ch, FAQ accordions (smooth
    height animation, chevron rotate), support channels as cards (Telegram/chat),
    sticky section nav on desktop.
D11. /recover-account — calm, step-by-step, clear success/failure messaging.
D12. LeaderboardPage — if routed, rank table with top-3 podium treatment; if
    orphaned, report and skip.

E. LOADING EXPERIENCE (whole panel): route-level Suspense already exists
   (PageSkeleton) — upgrade it to per-page skeleton layouts (header bar + content
   blocks matching each page's real shape), shimmer animation, fade-in on ready.
   No blank screens, no spinner-only screens anywhere.

VERIFY: build + run; test GamePage full bet flow (chip→side→confirm→closed→merged→
result FX), wallet buy/sell to waiting step, KYC upload previews, auth login/
register, both themes × 320/390/768/1024/1440. List anything that clipped and fix
before reporting. STOP for approval.
```

---

## PHASE 3 — ADMIN PANEL: every page, every component, every workflow

```
Apply the system to the ENTIRE admin-panel. Dark-first, function-first: operators
live here 8h/day. Per dashboard research: restraint (no decorative glow in data
areas), scannable hierarchy, drill-downs, keyboard navigable, ARIA labeled.
Density: comfortable default + compact table mode toggle.

A. SHARED COMPONENTS FIRST (everything else inherits):
A1. Layout.tsx — grouped sidebar (core/people/payments/policy/enterprise/content/
    system) with: collapsible groups, active state (gold left rail), permission-
    filtered items (usePermission logic untouched), collapse-to-icons mode on
    laptop, mobile drawer with overlay, header bar with admin identity + logout
    confirm. Keep every existing menu item and path exactly.
A2. DataTable — THE workhorse. Sticky header, sortable columns (aria-sort),
    zebra option, row hover, cell truncation with tooltip, right-aligned
    tabular-nums money columns, StatusBadge integration, per-row actions menu,
    bulk-select with floating action bar, pagination (usePagination untouched),
    overflow-x-auto wrapper + sticky first column on mobile, loading skeleton
    rows, EmptyState integration. Column count never breaks 320px — horizontal
    scroll is the fallback, never squashed cells.
A3. StatCard — label, big tabular number, delta arrow (green/red), optional
    sparkline, skeleton state; container-query responsive.
A4. Modal + ConfirmDialog — focus trap; destructive actions (user block, balance
    adjust, cycle override, delete) require typed/explicit confirm with
    consequence text. SearchBar — debounced (useDebounce untouched), clear
    button, result count. DateRangePicker — presets (Today/7d/30d/custom).
    FileUpload — drag zone, preview, progress, error. StatusBadge — one
    consistent color map: pending=amber, success=green, failed=red, processing=
    blue, disputed=purple across ALL pages. LoadingSpinner → replace usages with
    skeletons where content shape is known. EmptyState, UserAvatar (aspect-square,
    fallback initials).

B. PAGES (34 routes — apply in groups; every page keeps its exact data + actions):
B1. Login — branded split screen (navy/gold brand panel + form), inline errors,
    loading state, no layout shift.
B2. Dashboard — KPI StatCards row (players, deposits, withdrawals, P&L, active
    cycles), trend charts, recent-activity feed, quick links. F-pattern: most
    critical top-left. Auto-refresh indicator.
B3. Live Cycles / Cycle History — live cycle cards with countdown + pool split
    (Delhi red vs Bombay blue bars), state badges (OPEN/CLOSED/MERGED/DECLARED),
    result-declare workflow behind ConfirmDialog; history = DataTable with
    date-range + outcome filters.
B4. Profit & Loss / Revenue Ledger / Reports / Operations Overview — financial
    tables with totals rows, export buttons (loading state), date-range presets,
    chart + table pairing; numbers right-aligned tabular-nums, negatives in red
    with minus sign (not just color — accessibility).
B5. Users / UsersList — DataTable with search, filters (status/KYC/balance),
    row → user detail drawer (balances, bets, KYC docs, actions: block/unblock
    with confirm). Balance Adjust — high-risk form: amount input with ₹, reason
    required, preview of before→after balance, double confirm.
B6. Merchants / MerchantPlatform / SubAdmins — list + detail pattern; permission
    matrix editor for sub-admins (checkbox grid, sticky headers).
B7. KYC Queue — review workflow: queue list → side-by-side document viewer
    (Aadhaar image + selfie, zoom/rotate, aspect-ratio-safe) + user data +
    approve/reject with reason (reject requires reason text). Keyboard: ←→
    navigate queue, A/R shortcuts with confirm.
B8. Queue Manager / QueueDashboard — live queue metrics, job states with
    color-coded badges, retry/clear actions behind confirm.
B9. Transactions / UTRManager / Payment Control — transaction DataTable (copyable
    UTR/order ids), status filters, dispute link; PaymentControlCenter = system
    toggles with clear ON/OFF states + change confirmations + audit note.
B10. Disputes — case list → case detail (timeline of events, evidence images,
     chat/notes, resolve with outcome + reason).
B11. Deposit Policy (business-policy) — policy form sections with clear
     save/dirty state ("unsaved changes" bar), validation, and effect preview.
B12. Content: FAQ / Slides / Support / CDN — CRUD lists with inline edit or modal
     edit, slide manager shows aspect-video previews with exact-pixel guidance,
     drag-to-reorder with keyboard alternative.
B13. Branding — the page that drives user-panel --brand-* vars live: color pickers
     with live preview swatch + contrast check (warn if primary fails 4.5:1 on
     dark card), logo upload with object-contain preview on both themes.
B14. App Assets / Game Providers / Games Manager — asset grids with aspect-ratio
     enforced thumbnails + upload states; provider/game toggles with instant
     feedback.
B15. Promotions: Gift Codes (generate form + codes table with copy + status) /
     Announcements (composer with preview-as-user card).
B16. Winners Manager (FakeWinnersManager) — entry CRUD with user-panel-style
     preview of how the entry renders in /winners.
B17. Settings / SystemSettings — grouped setting sections, each control with
     helper text, dirty-state save bar, dangerous settings visually separated.
B18. Audit Logs / Error Logs — dense monospace-friendly tables, level badges,
     expandable row detail (pretty-printed JSON, copy button), time filters,
     live-tail toggle for errors.
B19. Account Recovery / Chat Management — request queue with approve/deny + reason
     workflow; chat threads with clear unread states.

VERIFY: build; click through EVERY route in the sidebar; confirm permission-
filtered nav unchanged; test DataTable at 320px, 768px, 1440px; run one destructive
flow (confirm dialog) and one form dirty-state; keyboard-tab through Dashboard,
Users, KYC Queue. Report per-page status table. STOP for approval.
```

---

## PHASE 4 — MERCHANT PANEL: every page, operational speed first

```
Redesign merchant-panel from its plain gray/white utility UI into a branded
professional console (Phase-1 merchant light theme + dark variant). Merchants
work on PHONES a lot — treat it mobile-first with big touch targets. Keep
react-hot-toast (restyle it to tokens) and every API/workflow untouched.

M1. Layout — branded header (logo, panel name), the ONLINE/OFFLINE toggle is the
    merchant's most important control: make it a large, unmistakable switch
    (green pulsing dot when online, gray when offline) with confirm when going
    offline while orders are active; bottom tab nav on mobile (Dashboard/Orders/
    History/Profile) with safe-area padding; logout confirm.
M2. LoginPage — branded, minimal, inline errors, loading button.
M3. Dashboard — today's StatCards (orders, volume ₹, success rate, earnings),
    active-order alert banner if any order is waiting, recent orders list.
M4. OrderManagement — THE money screen. OrderCard redesign: order id (copy),
    amount ₹ huge tabular-nums, user reference, CountdownTimer as prominent
    urgency ring/bar (green >2min, amber <2min, red <30s pulsing), primary
    action buttons full-width thumb-reach (Accept/Mark Paid/Reject per existing
    states — do not rename or reorder the workflow), UTR input with paste
    button + validation, status timeline stepper. New-order arrival: subtle
    sound-free flash + toast; list auto-sorts by urgency. Empty state: "You're
    online — waiting for orders" with pulse.
M5. HistoryViews — filterable history (date presets, status), daily totals,
    mobile card rows / desktop table (overflow-safe), export if present.
M6. ProfileSettings — payment details (UPI/bank) with masked display + reveal,
    edit with confirm, KYC/status badges.
M7. BulkPayouts — if route still live, apply table + confirm patterns; if dead
    code, report and skip.

VERIFY: build; simulate order lifecycle end-to-end on a 390px viewport (new →
countdown → action → done) confirming zero layout shift and thumb reachability;
test online/offline toggle both directions; both themes if dark variant shipped.
Report and STOP.
```

---

## PHASE 5 — CROSS-PLATFORM POLISH & PERFORMANCE

```
1. Consistency sweep: one StatusBadge color map, one radius scale, one shadow
   scale, one focus-ring style across ALL THREE panels; money format ₹X,XX,XXX
   (Indian grouping) everywhere via one formatter; every timestamp same format +
   relative time where useful.
2. Performance: lazy-load all non-critical routes (user-panel already partial —
   complete it; add to admin/merchant), memoize hot lists (orders, tables,
   ticker), image lazy+decode async, preconnect CDN, font-display swap +
   preload the two font files, audit bundle for accidental duplicate deps.
   Target: user-panel LCP < 2.5s on mid-range Android, 60fps game FX.
3. Accessibility pass: visible focus rings everywhere, aria-labels on icon-only
   buttons, form labels tied to inputs, color never the only signal (badges get
   text, deltas get arrows), prefers-reduced-motion honored, contrast ≥4.5:1
   body text both themes (verify gold-on-navy and gold-on-white CTAs — darken
   gold text on light theme if needed).
4. Do-not-break check: branding socket recolor, auth flows, bet placement,
   wallet order flow, KYC upload, merchant order actions, admin permissions.
Report all Lighthouse/axe findings fixed vs deferred. STOP.
```

---

## PHASE 6 — FULL QA MATRIX (the "nothing clips, everything adjusts" gate)

```
Run this matrix and fix every failure before declaring done. Test with real
DevTools device emulation, both themes where applicable.

DEVICES (widths): 320 (iPhone SE-class), 360, 390 (iPhone 14/15), 412 (Pixel),
374 & 832 (Galaxy Fold folded/unfolded), 768 (iPad portrait), 820, 1024 (iPad
landscape/laptop), 1280, 1440, 1920. Plus: one landscape phone (844×390) — check
GamePage and merchant Orders specifically; iOS safe-area simulation (notch +
home indicator) on user-panel Header/Footer/bottom bars and merchant tab bar.

PER SCREEN check: (a) no horizontal scroll; (b) no text/number clipped or
overlapping; (c) no image distortion (aspect ratios hold); (d) touch targets
≥44px; (e) sticky elements never cover content or CTAs; (f) skeleton → content
without layout shift; (g) empty + error states render; (h) both themes clean.

WORKFLOW E2E (each must complete with correct button states at every step):
U1 register→login→place bet (chip→side)→see closed→merged→result FX
U2 wallet buy: amount→create→waiting stepper→(simulate)done; sell with max check
U3 KYC: details→uploads with preview→submit→pending status visible in profile
U4 gift code redeem success + failure; invite copy/share; theme toggle persists
   across reload with no flash
A1 admin login→dashboard→drill into Users→open detail→block/unblock (confirm)
A2 KYC queue: review docs→approve one→reject one with reason
A3 transactions: search by UTR→copy id→open dispute; declare a cycle result
   (confirm dialog); branding change → verify user-panel recolors live
A4 settings dirty-state bar; audit log expand row
M1 merchant login→go online→receive order→countdown states→complete order→
   history shows it→go offline (confirm)
Deliver: pass/fail table for every page × device class × theme, list of fixes
applied, and before/after screenshots of GamePage, admin Dashboard, merchant
Orders. Run all three production builds one final time.
```

---

## Research basis baked into these prompts (why each rule exists)
- **Betting UX:** dark-mode-first; ≤2 taps to bet; bet controls in bottom-30% thumb zone (+25% bet volume); 3–4 color palette; trust badges near money actions; micro-interactions + haptics on bet/cashout.
- **Back-office/dashboard:** restraint in data areas; drill-downs, filters ≤6–8 in a bar + "Filters (n)" badge on mobile; sortable/inline-editable tables; keyboard + ARIA; role-based views.
- **KYC/fintech flows:** 50–80% abandon started KYC, 70% abandon if >3 min → progressive 2-step flow, time hints ("~90 seconds"), mobile-first uploads, never lose entered data.
- **Typography/responsive 2025-26:** fluid clamp() type scale as tokens; explicit 600–900px foldable range (Fold: 374/832px); 45–75ch line length; container queries for reused cards; tabular-nums for live numbers.

## Repo facts the prompts rely on (verified 2026-07-20)
- user-panel: HashRouter; routes & files as listed; framer-motion ^11 present; `--brand-*` vars live-overwritten by branding socket (App.tsx ~118-120); GAME_CORE.BETTING_ALLOWED drives lock states; WalletModal machine form→waiting→done; KYCModal presigned PUT uploads; chips 10→30→90→270→810.
- admin-panel: 34 routes, permission-gated grouped sidebar, shared DataTable/StatCard/etc., dark-900 `#0B0E14` + gold-500 `#D4AF37` Tailwind theme, `.btn-*` component classes in globals.css.
- merchant-panel: 5 live routes (+BulkPayouts orphan?), plain light theme today, react-hot-toast, CountdownTimer + OrderCard + online/offline toggle are the core UX.
- Governance: docs/governance/04-GOVERNANCE.md — CSS-variable brand colors mandatory.
