# BettingBazaar — UI/UX Design Brief (prompt for a design agent)

> Paste everything below the line into your design agent. It is written to be
> self-contained. It encodes both the **"must feel instant"** performance bar and
> the **visual direction** (1xBet-inspired light theme, Stake-inspired dark theme,
> BC.Game-inspired game discovery). Reference DNA only — do **not** clone any
> competitor's exact logo, wordmark, or trade dress.

---

## ROLE

You are a senior product designer + front-end engineer designing the UI/UX for
**BettingBazaar**, a mobile-first real-money gaming platform. Redesign the visual
system and interaction model so the app feels **instantaneous, fluid, and
premium** — never laggy, never "throttled." Deliver a themeable design system
(light + dark) and the key screens, implemented with the existing stack.

## PRODUCT CONTEXT (what you're designing)

BettingBazaar has three separate front-ends; this brief is primarily the **user
panel**, with the design system reused by the admin and merchant panels.

- **Core game** — "Delhi vs Bombay": a recurring timed cycle where users bet on
  one of two sides; a live countdown, two pools, and a result/celebration moment.
- **Game lobbies** — Casino, Crash & Instant, Sports, driven by a **Game Registry**
  (games are data: thumbnail, badge, RTP, category, provider, status). Grids +
  categories + search + filters, rendered generically.
- **Wallet** — deposit/withdraw (P2P merchant flow), balances (spendable vs
  winnings vs locked), transaction history.
- **Supporting** — Results/Winners, Profile/KYC, Invite/Referral, VIP, Gift codes,
  Auth (login/register/recover).

## TECH CONSTRAINTS (design *for* this — no rewrites)

- **React 18 + TypeScript + Vite 7**, **Tailwind CSS 3.4**, **react-router-dom 6**
  (HashRouter), **framer-motion 11** (already installed — use it), mobile-first
  **PWA** (installable, bottom-tab app-like shell).
- Output must be **Tailwind classes + a small design-token layer** (CSS variables),
  not a new CSS framework. Provide tokens as CSS custom properties themed by
  `:root` (light) and `[data-theme="dark"]` so theme switching is instant and
  flash-free.
- Existing brand accent is gold `#D4AF37`; side colors Delhi `#E53935` / Bombay
  `#1E88E5`. You may evolve these into proper token roles, but keep the two side
  colors semantically (they map to game data).
- Must degrade gracefully with `prefers-reduced-motion` and on low-end Android.

## ⚡ PRIME DIRECTIVE — PERCEIVED PERFORMANCE (this is the point of the redesign)

The user must feel **zero delay** tapping anything: page switches, tab changes,
button presses, and bet placement must feel **instantaneous and smooth**, and
clicks must feel **satisfying and responsive — never sluggish or throttled**.
Design and specify to these rules:

**Navigation & loading**
- **Persistent app shell**: header, wallet chip, bottom tab bar, and side nav
  **never unmount** on navigation. Only the content region swaps.
- **Route transitions** via `framer-motion` `AnimatePresence`: 150–220 ms, a
  subtle slide/fade (8–12 px), GPU-only (`transform`/`opacity`). No layout
  reflow, no full-page white flash.
- **Skeleton screens, never spinners**, for any async content (game grids,
  history, wallet). Skeletons must match the final layout so nothing shifts (zero
  CLS). Reserve image dimensions to prevent reflow.
- **Prefetch on intent**: preload a route's chunk + first data on
  `pointerenter` / `touchstart` of its nav item or card, so the destination is
  warm before the tap completes.
- **Optimistic UI**: bet placement, quick-stake changes, follow/like, and filter
  toggles update the UI immediately and reconcile with the server response;
  roll back visibly only on error.
- **Instant tab/filter switching**: category and filter changes are client-side
  and never round-trip to feel responsive; data hydrates behind an already-swapped
  view.

**Rendering budget (why the current app can feel heavy — fix these)**
- **Kill or defer the always-on WebGL/3D background.** A full-screen animated
  three.js scene mounted behind every page is the biggest cost. Replace the
  default with a cheap CSS gradient / static texture; if a 3D flourish is wanted,
  make it **lazy, paused off-screen, capped at ~30 fps, and off by default on
  mobile and under `prefers-reduced-motion`**.
- **Minimize `backdrop-filter: blur()`**. Heavy glassmorphism blur repaints every
  frame on scroll and tanks mobile FPS. Use it on **at most one** small, static
  surface (e.g. a sticky header), and prefer solid/translucent tokens elsewhere.
- **No unbounded infinite animations.** Limit looping animations (glow/shimmer/
  pulse) to a single focal element (e.g. the live winner card) and pause them when
  off-screen. Everything else animates only on interaction/state change.
- Target **60 fps** interactions; keep main-thread work off the tap path; virtualize
  long lists (history, big game grids).

**Tap feel (make clicks satisfying, not throttled)**
- Every interactive element responds within **<100 ms** with a visible state:
  a fast **press/scale** (0.96–0.98, 90–120 ms), color/elevation shift, and — where
  appropriate — light haptics on supported devices.
- Buttons never look "dead" while working: show an inline, in-place busy state
  (spinner inside the button / progress fill), never block the whole screen.
- Use `:active` + pointer feedback that fires on `pointerdown` (not just click) so
  it feels immediate. Debounce network, **not** visual feedback.

## 🎨 VISUAL DIRECTION — DUAL THEME

Deliver **one design system, two themes** switchable instantly via a token layer.
Both themes share layout, spacing, radius, and motion; only color roles change.

### Light theme — "1xBet DNA" (dense, information-rich, sportsbook-grade)
- **Feel**: bright, high-density, data-forward, trustworthy, European sportsbook.
- **Surface**: white `#FFFFFF` cards on a cool light-gray canvas (`#F2F4F7`/
  `#EAEDF2`); crisp 1px hairline borders (`#E2E6EC`); minimal shadows (flat,
  functional).
- **Primary**: a confident blue (`~#1E63E9`); **success/live/odds-up** green
  (`~#12A150`); **danger/odds-down** red (`~#E5342B`); amber for warnings.
- **Type**: compact, tight line-height, strong numeric emphasis (odds, stakes,
  balances). More rows per screen; tabbed sections; clear table/list density.
- **Layout cues**: sticky section tabs, left/right rails on desktop (nav / betslip),
  chip-style filters, sport/category icons, live badges.

### Dark theme — "Stake DNA" (minimal, premium, high-contrast, calm)
- **Feel**: sleek, modern, focused, "expensive," effortless.
- **Surface**: deep desaturated navy stack — canvas `#0F212E`, card `#1A2C38`,
  raised `#213743`; soft 1px borders (`rgba(255,255,255,.06)`); subtle depth via
  slightly lighter surfaces, not heavy shadows.
- **Primary**: a clean electric blue (`~#1475E1`) with a **wins/positive** neon
  green (`~#00E701`); keep the brand gold as a secondary accent for VIP/premium
  moments; Delhi/Bombay reds/blues for the core game.
- **Type**: generous hierarchy, high contrast, monospaced/tabular figures for money
  and odds. Roomier than light theme, big obvious CTAs.
- **Layout cues**: simple top bar + always-visible wallet, casino/sports toggle,
  clean edge-to-edge game grids, big rounded cards.

### Shared tokens (define both themes against these roles)
`--bg`, `--surface`, `--surface-raised`, `--border`, `--text`, `--text-muted`,
`--primary`, `--primary-contrast`, `--positive`, `--negative`, `--warning`,
`--accent` (gold), `--side-delhi`, `--side-bombay`, plus `--radius` (cards ~16px,
controls ~12px, chips full), an **8pt spacing scale**, a **type scale** (12/14/16/
20/28/40 with tabular-nums for money), and **2–3 elevation levels**. Deliver the
full token table for **both** themes with exact values and WCAG-AA contrast.

## 🖼️ GAME DISCOVERY / THUMBNAILS — "BC.Game DNA"

The lobbies must be a **fast, vibrant, scannable game grid** fed by the Game
Registry:
- **Game card**: 1:1 or 3:4 thumbnail with a hover/press **▶ Play** overlay,
  provider label, and up to one **badge** (Live / Hot / New / Jackpot / RTP).
  MAINTENANCE renders a locked state; INACTIVE is hidden. Reserve image size;
  lazy-load images; blur-up/placeholder while loading.
- **Category rails**: horizontally scrollable rows per category (Live Casino,
  Slots, Crash, Indian Games, BB Originals…) with a "see all" → full grid.
- **Discovery controls**: instant search, provider chips, tag filters (popular/
  new/jackpot), and a featured **hero** slot for the top game. All filtering is
  client-side and instantaneous.
- **Bento home**: a promo hero + the live cycle game + featured rails, app-like
  and thumb-reachable.

## COMPONENT SYSTEM (design all states: default / hover / active / focus / disabled / loading / error / empty)

Buttons (primary/secondary/ghost/danger + quick-stake chips), inputs & numeric
ststeppers (+10/+50/+100/½/2×), **bet card / betslip** (slide-up sheet on mobile,
sticky rail on desktop; one-tap place; optimistic), **wallet chip + wallet sheet**
(spendable/winnings/locked clearly separated), cards, tabs, bottom tab bar, top
bar, toasts/inline alerts, **skeletons**, empty states, modals/bottom-sheets,
data tables (admin), countdown timer, live pool/odds display with **flash-on-change**
(green up / red down), result/celebration moment.

## MOTION SPEC (satisfying, not decorative)

- Durations: micro 90–140 ms, transitions 160–220 ms, emphasis ≤320 ms. Easings:
  `ease-out` for enters, `ease-in` for exits, a gentle spring for press.
- Press: scale 0.97 + brightness/elevation shift on `pointerdown`.
- Route change: content slide-fade; shell static.
- Numbers (balances, pools, odds): quick count-up/flash on change.
- Bet placed: immediate chip-fly / pool bump + success pulse (optimistic).
- Celebration: one contained, GPU-cheap confetti/glow burst — not a full-screen
  WebGL scene.
- Everything respects `prefers-reduced-motion` (transitions collapse to instant
  cross-fades; loops disabled).

## RESPONSIVE & ACCESSIBILITY

- Mobile-first (360–430px primary), then tablet, then desktop (add rails, don't
  reflow the mobile IA). App-like bottom tabs on mobile; thumb-zone CTAs; safe-area
  insets.
- WCAG AA contrast in **both** themes; visible focus rings; 44px min hit targets;
  full keyboard nav; screen-reader labels on icon buttons; never rely on color
  alone (Delhi/Bombay also get labels/icons).
- Respect reduced-motion and data-saver.

## DELIVERABLES

1. **Token system** — CSS-variable tables for light + dark (all roles, exact
   values, contrast notes) + Tailwind theme-extend mapping.
2. **Component library** — every component above, all states, in both themes,
   as Tailwind/React specs (or high-fidelity mockups + the class recipes).
3. **Key screens** in both themes: Home, a game lobby (grid + rails + filters),
   the core cycle bet screen (countdown + pools + betslip), Wallet
   (deposit/withdraw + history), Results/Winners, Profile/KYC, Auth.
4. **Motion spec sheet** (durations/easings/triggers) mapped to framer-motion.
5. **Performance implementation notes**: the app-shell + `AnimatePresence`
   pattern, skeleton set, prefetch-on-intent hook, optimistic-update pattern, and
   the plan to replace/defer the WebGL background and reduce blur.
6. A **theme toggle** interaction (instant, persisted, no flash).

## EXPLICIT DO / DON'T (grounded in the current build)

**DO**: reuse framer-motion (already installed); keep routes code-split (already
are) but upgrade Suspense fallbacks to matched skeletons; make the shell
persistent; theme via CSS variables; prefetch on hover/touch; optimistic bets;
tabular numerals for money; test on a mid-range Android.

**DON'T**: mount a full-screen WebGL/three.js background on every page; stack
`backdrop-filter: blur` on many surfaces; run multiple infinite CSS animations at
once; use spinners as the primary loading state; block the whole screen on a
button action; introduce a new CSS framework or heavy animation library; clone any
competitor's exact branding.

**North star:** every interaction returns feedback in under ~100 ms, page-to-page
feels like one continuous surface, and the app reads as a premium, native-feeling
product — 1xBet's information density in light, Stake's calm precision in dark,
BC.Game's vibrant discovery for games.

---

## WORKING IN THIS REPO (for a repo-linked agent — read before editing)

**Do the work inside this existing app. Do NOT scaffold a new project.** The
stack is already React 18 + TypeScript + Vite 7 + Tailwind 3.4 + framer-motion 11.

**Three front-ends live here:**
- **User panel** (primary for this brief) — at the **repo root**: `App.tsx`,
  `pages/*.tsx`, `components/**`, `services/**`.
- **Admin panel** — `admin-panel/src/**` (reuse the design system/tokens).
- **Merchant panel** — `merchant-panel/src/**`.

**Key files to touch:**
- **Design tokens / global CSS**: `index.css` (CSS variables + base),
  `glassmorphism.css` (the current glass/blur system + button/card classes),
  `tailwind.config.js` (color tokens: `gold #D4AF37`, `delhi #E53935`,
  `bombay #1E88E5`; animations; utilities). Add the **light/dark token layer as
  CSS variables** here, themed by `:root` (light) and `[data-theme="dark"]`, and
  map Tailwind `theme.extend.colors` to the variables.
- **App shell / routing / transitions**: `App.tsx` (HashRouter, lazy routes,
  `Layout`, `AppShell`, `SystemGuard`). Header/Footer/nav:
  `components/Layout/Header.tsx`, `Footer.tsx`, `components/Game/GameCategoryStrip.tsx`.
- **Core game (home)**: `pages/GamePage.tsx` + `components/Game/**` (countdown,
  pools, bet card, celebration).
- **Game lobbies (already metadata-driven)**: `pages/CasinoPage.tsx`,
  `pages/CrashPage.tsx`. They fetch the catalogue from the **Game Registry** —
  `GET /api/game/games` and `GET /api/game/categories` (see `GAME_REGISTRY.md`).
  Keep those data contracts; restyle the cards/grids/filters only.
- **Wallet / account**: `pages/WalletPage.tsx`, `components/Modals/WalletModal.tsx`,
  `pages/ProfilePage.tsx`, `pages/ResultsPage.tsx`, auth in
  `components/Modals/AuthModal.tsx`.
- **Shared UI primitives**: `components/ui/**`, `components/Modals/**`.

**Already done — build on it, don't redo (perf pass, 2026-07-11):**
- WebGL 3D background (`components/SceneBackground.tsx`) is now **lazy +
  capability-gated** in `App.tsx` (desktop/fine-pointer/enough-RAM/no-reduced-motion);
  mobile gets a CSS gradient and never loads three.js.
- **`backdrop-filter: blur()` is disabled on ≤900px and reduced-motion** in
  `glassmorphism.css` (solid fallbacks). Keep new glass effects behind that same
  guard; don't reintroduce heavy blur on mobile.
- **framer-motion** route transition (160 ms opacity fade) + `PageSkeleton`
  Suspense fallbacks are wired in `App.tsx`, under `MotionConfig
  reducedMotion="user"`. Extend this pattern (e.g. persistent shell + exit
  transitions); don't add a second animation library.

**Constraints & verification:**
- Keep the `react-router` routes and the Game Registry / wallet API contracts.
- Mobile-first PWA; respect `prefers-reduced-motion`, safe-area insets
  (`--sat/--sab` already defined), and `touch-action: manipulation` (already set).
- **Verify with `npm run build` (Vite).** The user panel has ~95 **pre-existing**
  `tsc --noEmit` errors unrelated to design — gate on the Vite build, not `tsc`.
  Admin/merchant panels build with `npm run build` in their folders.
- Preview locally with `npm run dev`.
