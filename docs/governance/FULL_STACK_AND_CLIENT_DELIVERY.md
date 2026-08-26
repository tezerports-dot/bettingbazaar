# Full Stack & Client Delivery Map

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

**What this document is.** One page that answers two questions end to end:

1. **What is the stack, exactly?** Every layer, every runtime, every datastore,
   every transport, for the backend and all three panels.
2. **How does each of the three panels reach a user?** Website, PWA, and Android
   app — what exists today, what does not, and what each remaining target costs.

**What it is not.** It does not restate rules (that is `04-GOVERNANCE.md` §§0–16),
capability status (`platform/capabilities.yaml` + §19), launch gates
(`LAUNCH_READINESS.md`), or UI design specification (`design/BettingBazaar_UIUX_Product_Blueprint.md`).
It cross-references those rather than duplicating them, per the §19 consolidation note.

**Verified against the tree on 2026-07-29.** Every claim below points at a file
you can open. Where something is *not* built, it says so — a stated capability
that does not exist is worse than a missing one (§20, 2026-07-27).

---

## Table of contents

- [Part 1 — The stack as built](#part-1--the-stack-as-built)
- [Part 2 — The three panels](#part-2--the-three-panels)
- [Part 3 — Client delivery: website, PWA, Android](#part-3--client-delivery-website-pwa-android)
- [Part 4 — Complete feature inventory](#part-4--complete-feature-inventory)
- [Part 5 — Dormant capabilities and feature flags](#part-5--dormant-capabilities-and-feature-flags)
- [Part 6 — Open gaps and decisions the plan needs](#part-6--open-gaps-and-decisions-the-plan-needs)
- [Part 7 — Suggested build order](#part-7--suggested-build-order)

---

# Part 1 — The stack as built

## 1.1 Topology

```text
                    ┌──────────────────────────────────────────────┐
   Android APK/AAB  │  Capacitor 8 shell (user panel only)         │
   com.bettingbazaar.app  webDir: dist — assets bundled in package │
                    └───────────────────┬──────────────────────────┘
   Desktop / mobile browser             │
   ┌────────────────────────────────────┼───────────────────────────┐
   │  /            user panel  (PWA, HashRouter, SW + manifest)     │
   │  /admin/      admin panel (HashRouter, no PWA)                 │
   │  /merchant/   merchant panel (BrowserRouter, no PWA)           │
   └────────────────────────────────────┬───────────────────────────┘
                                        │  HTTPS  ·  WSS  ·  SSE
                    ┌───────────────────▼──────────────────────────┐
                    │  Edge: Caddy (Caddyfile) / HAProxy L4 /      │
                    │  k8s Service + Ingress. TLS, HSTS, CSP.      │
                    └───────────────────┬──────────────────────────┘
                    ┌───────────────────▼──────────────────────────┐
                    │  Node 22 LTS · Express 5 · modular monolith  │
                    │  backend/server.js — one process, 3 runtime  │
                    │  roles (api | realtime | scheduler)          │
                    │  26 bounded domains, dependency-cruiser CI   │
                    └──┬────────┬─────────┬──────────┬─────────────┘
                       │        │         │          │
                MongoDB 7   PostgreSQL 18  Redis 8   S3-compatible
                (authorit-  (money shadow  (cache,   (KYC docs,
                 ative)      + pgvector)   locks,     proofs,
                                           rate-lim,  branding,
                                           pub/sub,   app assets)
                                           BullMQ)
                       │
                 Kafka (dormant — KAFKA_BROKERS)
```

## 1.2 Runtime and language versions

| Layer | Version | Pinned where |
|---|---|---|
| Node | **22 LTS** (`engines: >=22`) | `package.json`, `Dockerfile`, CI |
| Web framework | **Express 5.2** | root `package.json` |
| ODM | Mongoose 8 | root `package.json` |
| SQL driver | `pg` 8 | root `package.json` |
| React | **19.2.8** — all three panels | each panel's `package.json` |
| Router | **`react-router` v8** (single package; `react-router-dom` removed) | all three panels |
| Bundler | Vite — user 7.3, admin 8.1, merchant 8.1 | each panel |
| CSS | Tailwind 3.4 + PostCSS, CSS custom properties for branding | each panel |
| Native shell | **Capacitor 8.4** (Android only) | `user-panel/package.json` |
| Android toolchain | JDK 21 (Temurin), Gradle wrapper | `.github/workflows/android-release.yml` |
| Test runner | Vitest 4 (unit / integration / pg suites) | `vitest*.config.ts` |
| E2E | Playwright | `playwright.config.ts`, `e2e/` |

Governance §16 P-1 makes an EOL runtime a **launch blocker**, not a backlog item,
and P-2 requires `npm ci` from the committed lockfile in every environment.

## 1.3 Backend layers

`backend/server.js` composes the whole edge in-process, in this order:

| Order | Layer | File |
|---|---|---|
| 1 | Ambiguous-framing rejection (request smuggling) | `middleware/headerNormalization.js` |
| 2 | PROXY protocol v2 metadata (optional L4) | `network/proxyProtocolV2.js` |
| 3 | Compression, Helmet (CSP/HSTS), canonical-host 301 | `config/security.config.js`, `config/network.config.js` |
| 4 | CORS allow-list | `ALLOWED_ORIGINS` |
| 5 | Body parsing — 1 MB default, 8 MB scoped to app-asset upload | `JSON_BODY_LIMIT` |
| 6 | Mongo operator sanitisation (Express-5 safe) | `middleware/mongoSanitize.js` |
| 7 | Correlation IDs (W3C `traceparent` interop) | `middleware/requestContext.js` |
| 8 | TLS/JA3 fingerprint policy (admin-configured) | `middleware/tlsFingerprintDefense.js` |
| 9 | Structured request log + Prometheus histogram | `services/logger.js`, `services/metrics.service.js` |
| 10 | Load shed / bulkhead (in-flight + event-loop-lag ceiling) | `middleware/loadShed.js` |
| 11 | Tiered rate limits → per-subnet → global surge breaker | `middleware/security.js`, `ipDefense.js` |
| 12 | OWASP request filter (app-side WAF complement) | `middleware/owaspFilter.js` |
| 13 | Routers (auth, admin, bet, user, merchant, payment, support, …) | `backend/routes*`, `backend/domains/*` |
| 14 | SPA static + fallbacks for `/`, `/admin`, `/merchant` | `server.js` |
| 15 | Error handler | `middleware/errorHandler.js` |

**Runtime roles.** `BB_RUNTIME_ROLE` splits one image into three behaviours
(`startup/runtimeRole.js`): `api` serves HTTP only, `realtime` owns SSE/WebSocket
clients, `scheduler` owns the cron + game-cycle producers. `deploy/k8s/deployment.yaml`
runs them as separate Deployments with independent HPAs (api 3→30, realtime 2→40).

**Graceful drain.** SIGTERM flips readiness to 503 first, waits `SHUTDOWN_DRAIN_MS`
for the LB to notice, then closes the listener, drains in-flight work, closes
BullMQ/Kafka/PG/worker-pool/Mongo/Redis, with a hard deadline backstop for SSE
connections that never end on their own.

## 1.4 Domain map (26 bounded contexts)

Boundaries are enforced in CI by `npm run check:deps` (`.dependency-cruiser.cjs`).
The four-tier arrangement was accepted 2026-07-09 (§20, Phase 011) — **future work
extends these tiers, never restructures them**.

| Tier | Domains |
|---|---|
| **Core Enterprise** | `configuration` (Business Policy) · `operations` · `revenue` (Revenue & Settlement) · `funding` · `merchant` · `risk` |
| **Product** | `markets` (the Delhi/Bombay cycle market) · `casino` · `gameRegistry` · `sportsbook`* · `games`* · `event`* · `odds`* |
| **Customer** | `communication` · `wallet` · `user` · `identity` |
| **Enterprise Services** | `reporting` · `analytics` · `notification` · `cms` · `disputes` · `settlement` · `support` (RAG) · `trading` (shared vocabulary) |

\* **Declared, not implemented** — a boundary README + a default-false flag, with
no placeholder code. This is deliberate (repo rule since Phase 003).

**Single-writer authorities** (§1 of `04-GOVERNANCE.md`, the rule that matters most):

| Value | Sole writer |
|---|---|
| User wallet balances (incl. bet stake lock) | `domains/wallet/walletAuthority.service.js` |
| Merchant token balance | `domains/merchant/merchantWallet.service.js` |
| Accounting / settlement ledger | `domains/revenue/revenueSettlement.service.js` |
| Money entering/leaving the ecosystem | `domains/funding/fundingAuthority.service.js` |
| All transaction/bet validation rules | `domains/risk/riskValidation.service.js` |
| All user-facing notifications | `domains/communication/communication.service.js` `notify()` |
| Which store owns each money path | `postgres/moneyAuthority.js` |

## 1.5 Data stores

| Store | Role | Authoritative today |
|---|---|---|
| **MongoDB 7** (replica set required) | Everything: users, cycles, bets, orders, content, logs, and money | **Yes, for every path** |
| **PostgreSQL 18** | Financial integrity — wallets, ledger, orders, KYC in integer paise, append-only + conserve-to-zero DB triggers, RANGE partitioning ready. Also hosts **pgvector** for RAG. | **No — verified shadow** |
| **Redis 8** | Cache · distributed locks (cron leader) · rate-limit counters · realtime pub/sub fan-out · BullMQ job queue | n/a |
| **S3-compatible** | Payment proofs, P2P chat attachments, branding images, app assets. Presigned direct-to-bucket uploads. **No identity documents** — KYC is an Aadhaar number. | n/a |

**Money precision is integer paise everywhere** (`backend/shared/money.js`);
percentages are integer basis points; floats appear only in storage, never in math.

**The Postgres cutover is deliberately not done.** Every money mutation dual-writes
(`postgres/dualWrite.js`), a leader-locked 5-minute cron reconciles both directions,
and `postgres/reverseMirror.js` gives the rollback path zero RPO. Flipping authority
is an owner-gated production sequence, not a code change —
`LAUNCH_READINESS.md` §E and `backend/postgres/DATA_ROLLBACK_PLAN.md` own it.

## 1.6 Realtime — three transports, one namespace

45 event names, registered in `04-GOVERNANCE.md` §11. **One name per logical change**,
unique across all three transports.

| Transport | Audience | Entry point |
|---|---|---|
| **socket.io** (WebSocket only, no polling) | Public browser clients — cycle state, pools, branding, system config, balances | `startup/socketHandlers.js` |
| **SSE** | Authenticated private streams — `/api/sse/admin/events`, `/api/sse/merchant/events` | `routes/sse.routes.js`, `domains/notification/sseManager.service.js` |
| **Emitters** | Routing layer that picks the right room/stream per recipient | `domains/notification/realtimeEmitters.js` |

Cross-instance fan-out rides Redis pub/sub (`startup/realtimeBridge.js`) and
degrades to single-instance without Redis. SSE has per-client backpressure
(`SSE_MAX_BUFFERED_BYTES`) that disconnects a client rather than growing a buffer
without bound.

## 1.7 Security stack

| Control | Implementation |
|---|---|
| Session tokens | **PASETO v4.public / Ed25519** — no alg-swap, no `none`; `iss`/`aud` stamped; rotatable verify-key set; instant revocation via `TokenBlacklist` |
| Passwords | **Argon2id** (19 MiB, t=2, p=1) with transparent bcrypt→argon2 upgrade on login |
| **Two-factor (TOTP)** | **Built and enforced** — mandatory for admin + sub-admin, optional for players, available for merchants. Two-step enrolment (pending → activate), one-time recovery codes stored as hashes, secrets AES-256-GCM encrypted at rest under `TOTP_ENCRYPTION_KEY`. QR/OTP UI in all three panels. |
| Payment order integrity | HMAC-signed orders, rotatable secret (`middleware/order-crypto-access.js`) |
| Aadhaar handling | Dedicated HMAC for dedup only; never reversible; never in URLs, storage, telemetry or logs |
| Boot gate | Production refuses to start on a missing/weak secret or unverified money-DB TLS (`startup/validateEnv.js`) |
| Rate limiting | Tiered, **failure-counting** login limits + per-subnet + surge breaker; Redis-shared. Full table: `RATE_LIMITS.md` |
| Authorization | 6 role tiers, ~270 handlers scanned, ownership checks in-handler. `AUTHORIZATION_MATRIX.md` — result: no holes found |
| Audit | `EnhancedAuditLog` across every privileged route; append-only accounting ledger |
| Supply chain | `npm audit` gate at HIGH, CycloneDX SBOM artifact, gitleaks secret scan, CodeQL default setup |

**Not built, called out deliberately:** no CAPTCHA / bot-mitigation challenge
anywhere. Rate limiting is the only automated-abuse control
(`LAUNCH_READINESS.md` §F).

## 1.8 Build, CI and deploy

**CI** (`.github/workflows/ci.yml`) — 5 jobs on every push/PR to `main`:

1. `test` — unit (no DB) + **real Postgres 18** money-path suite + integration
   against in-memory MongoDB 7 + **real Redis 8**.
2. `audit` — `npm audit --audit-level=high`, blocking.
3. `sbom` — CycloneDX for production deps, 90-day artifact.
4. `secret-scan` — gitleaks (report-only today).
5. `typecheck-build` — backend syntax, **dependency-cruiser architecture check**,
   **capability-registry verification**, then typecheck + build for all three panels
   (user panel additionally runs its own unit tests, because origin failover is
   logic worth catching a regression in).

**Container** — 3-stage `Dockerfile`: `mongodump` binaries extracted to their own
stage so no apt/keyring/wget survives into the image; panel builds in a builder
stage; runtime is prod deps + backend + three `dist/` folders, running as the
non-root `node` user with a readiness-based `HEALTHCHECK`.

**Deploy targets** — Railway (`railway.json`, `nixpacks.toml`, `Procfile`), Docker
Compose (`deploy/docker-compose.yml`), Kubernetes (`deploy/k8s/deployment.yaml` with
role split, HPA, PDB, topology spread, `readOnlyRootFilesystem`), Caddy
(`Caddyfile`), HAProxy L4 passthrough (`deploy/haproxy/`). Grafana dashboard is
committed as code (`deploy/grafana/`).

---

# Part 2 — The three panels

| | **User panel** | **Admin panel** | **Merchant panel** |
|---|---|---|---|
| Path | `/` | `/admin/` | `/merchant/` |
| Vite `base` | `/` | `/admin/` | `/merchant/` |
| **Router** | **HashRouter** | **HashRouter** | **BrowserRouter** `basename="/merchant"` |
| Resulting URL | `example.com/#/wallet` | `example.com/admin/#/users` | `example.com/merchant/orders` |
| Auth storage key | `auth_token` | `admin-auth` | `merchantToken` |
| Realtime | socket.io | socket.io + SSE (`/api/sse/admin/events`) | SSE (`/api/sse/merchant/events`) |
| Routes | 18 + merchant redirect | 35 | 5 |
| State | React Context (`GameContext`, `GameProviderContext`) | Zustand | React Context (`AuthContext`, `ThemeContext`) |
| Data fetching | `services/realBackend.ts` behind `backend.interface.ts` | axios + `services/api.ts` | `services/api.ts` |
| Extra libs | framer-motion, lucide, qrcode, socket.io-client | recharts, react-hook-form + zod, react-dropzone, react-hot-toast, date-fns | react-hot-toast, lucide, qrcode |
| Sourcemaps | `hidden` | `hidden` | default |
| **PWA** | ✅ manifest + service worker + icons | ❌ none | ❌ none |
| **Android** | ✅ Capacitor shell | ❌ none | ❌ none |
| 2FA UI | ✅ | ✅ (`TwoFactorSetup.tsx`, `OtpAuthQr.tsx`) | ✅ (`TwoFactorEnrol.tsx`) |

**Cross-panel rule (§14):** no panel imports source from another panel or from
`backend/`. Every shared value arrives over the API or a socket event — branding,
system config, permission keys, support links. That is what makes the three panels
splittable into separate repos with no governance change.

### 2.1 User panel

`user-panel/src/App.tsx` — `HashRouter`, 18 routes, lazy-loaded beyond the core
game page:

`/` (GamePage) · `/casino` · `/crash` · `/sports` · `/wallet` · `/invite` · `/vip` ·
`/gift-code` · `/recover-account` · `/profile` · `/history` · `/my-bets` · `/results` ·
`/promo` · `/rules` · `/faq` · `/support` · `/winners` · `/merchant/*` → external redirect

Notable client services:

- `services/realBackend.ts` — the concrete backend, behind `backend.interface.ts`
  so a mock can be swapped in.
- `services/originFailover.ts` — probes `/health/live` across a static, build-time
  candidate list (`VITE_API_URL` + `VITE_API_FALLBACK_URLS`) and remembers the
  winner for 30 minutes. Fails over on **transport** errors only, never on an HTTP
  status, and never mid-request — a money POST is never replayed against a second
  origin. Takes no client IP/geo/ISP as input.
- `services/nativeLifecycle.ts` — rebuilds the socket on every Android foreground
  transition, because a resumed WebView can report `connected` over a dead socket
  for tens of seconds while the cycle screen renders stale pools.
- `services/paymentStateMachine.ts` — client-side order lifecycle.
- `redesign/` — the current visual shell (`RedesignShell`, `GameScreen`, theme).

**Orphan:** `pages/LeaderboardPage.tsx` exists but is never imported or routed.

### 2.2 Admin panel

`admin-panel/src/App.tsx` — `HashRouter`, 35 routes, every one wrapped in a
permission guard (`hooks/usePermission.ts`, `utils/permissions.ts`). Route strings
come from the single `ADMIN_ROUTES` module (§8). Applies branding to itself from the
`branding` socket event (§9/§12). Shared operational components: `DataTable`,
`CommandPalette`, `DateRangePicker`, `ConfirmDialog`, `StatCard`, `StatusBadge`,
`FileUpload`, `Modal`, `EmptyState`.

### 2.3 Merchant panel

`merchant-panel/src/main.tsx` — `BrowserRouter basename="/merchant"`, 5 routes
(`/`, `/dashboard`, `/orders`, `/history`, `/profile`). Rebuilt on design tokens in
2026-07-27 and is the **only panel already at zero hardcoded brand hex values** (§3).
Light/dark theme via `ThemeContext` + `theme.ts` applied before first paint.
Order state lives in `hooks/useOrders.ts` fed by `services/sse.ts`.

---

# Part 3 — Client delivery: website, PWA, Android

## 3.1 Where each panel stands today

| | Responsive website | Installable PWA | Android app | iOS app |
|---|---|---|---|---|
| **User** | ✅ shipped | ✅ shipped | ✅ shipped (Capacitor 8, CI-signed) | ❌ not started |
| **Merchant** | ✅ shipped (responsive, `useViewport`) | ❌ no manifest / SW / icons | ❌ | ❌ |
| **Admin** | ✅ shipped (desktop-first, tablet fallback) | ❌ no manifest / SW / icons | ❌ | ❌ |

The backend already advertises both mobile targets: `GET /api/download/android`
and `/api/download/ios` 302 to `SystemConfig.androidUrl` / `iosUrl`, and
`GET /api/app/bootstrap` returns the official origin, allow-list, package IDs and
a compliance block for a native shell to verify **before** opening its WebView
(`NATIVE_APP_DISTRIBUTION_POLICY.md`). The iOS half of that contract has no client.

## 3.2 The routing decision that gates everything else

Two of three panels use `HashRouter`. This is the single highest-leverage decision
in the whole client plan, because it constrains all three delivery targets at once:

| Consequence | Website | PWA | Android |
|---|---|---|---|
| Deep links (`/wallet`, share links, campaign URLs) | Broken — every URL is `/#/…`, so the path the server sees is always `/` | Manifest `shortcuts` and `start_url` into a specific screen do not work cleanly | App Links / intent filters cannot target a route |
| SEO / crawlability | Hash fragments are never sent to the server; no per-page indexing | — | — |
| Service worker navigation caching | Every navigation looks like `/`, so a network-first HTML strategy caches one document for the whole app | Same | n/a (SW disabled in the shell) |
| Analytics per screen | Requires manual hash-change instrumentation | Same | Same |

The merchant panel already proves the alternative works in this exact deployment:
`BrowserRouter basename="/merchant"` + Vite `base: '/merchant/'` + the existing
`app.get('/merchant/*splat')` SPA fallback in `server.js`. The user and admin panels
have equivalent fallbacks already mounted (`/{*splat}` and `/admin/*splat`), so the
server side of the migration is **already done** — the change is per-panel:
`HashRouter` → `BrowserRouter`, plus a sweep of any `#/`-prefixed link literals.

**Recommendation:** move the user panel to `BrowserRouter` before investing further
in PWA depth, deep links, or Play Store presence. Move the admin panel opportunistically
— it is an internal tool, so it benefits least.

## 3.3 Website (responsive web)

**Shipped and working.** The three panels are served by the same Node process from
`backend/server.js`, with deliberate isolation: user-panel static assets are never
served under `/admin` or `/merchant`, because the user panel's
`glassmorphism.css` declares a full-screen `.glass-overlay` that swallowed every
click in the other two panels when it leaked (§14).

Frontends are **origin-agnostic**: they call `VITE_API_URL` when set, otherwise the
same origin's `/api`. A single-service deploy needs no frontend URL configuration at all.

Multi-domain redundancy is configured, not hypothetical: `DOMAINS` lists every
hostname serving the same app, `CANONICAL_HOST` optionally 301s the rest to one
canonical host for SEO, and the redirect keys **only** on the requested `Host`
header — never on who the client is.

**Website work still open:**

- `user-panel/index.html` carries a large stale `<script type="importmap">` listing
  backend packages (`express`, `mongoose`, `multer`, `redis`, `jsonwebtoken`, …) and
  `react-router-dom@7`, which the repo removed in the v8 migration. Nothing imports
  it; it is dead weight in the served HTML and actively misleading. Delete it.
- The same file sets `Cache-Control: no-cache, no-store, must-revalidate` via
  `<meta http-equiv>`, which pulls against the service worker's network-first HTML
  strategy. Pick one; the SW already handles freshness via a per-build cache name.
- No per-panel SEO surface (title/description/OG tags are static). Only relevant for
  the user panel; admin and merchant should stay `noindex`.

## 3.4 PWA

### What exists (user panel only)

| Piece | File | Behaviour |
|---|---|---|
| Manifest | `user-panel/public/manifest.json` | `standalone`, portrait, `#0B0E14`, `en-IN`, 192/512/maskable-512 icons, categories `entertainment`/`games` |
| Icons | `user-panel/public/app-assets/` | 192, 512, maskable-512, apple-180, favicon-32 — generated by `scripts/generate-pwa-icons.mjs` |
| iOS meta | `index.html` | `apple-mobile-web-app-*`, apple-touch-icon |
| Service worker | `user-panel/public/service-worker.js` | HTML network-first · hashed assets cache-first · images stale-while-revalidate · **`/api`, `/socket.io`, `ws:`/`wss:` never intercepted** |
| Cache busting | `vite.config.ts` `inject-sw-build-id` plugin | Rewrites `__BUILD_ID__` at `closeBundle`, so cache names change every deploy |
| Update flow | `src/index.tsx` + SW `activate` | Reload **only** when a new worker replaced one that was already driving the page — guarded at both ends so neither side alone can resurrect the first-visit reload loop (§20, 2026-07-28) |
| Native suppression | `src/index.tsx` | SW registration skipped entirely inside the Capacitor shell |

### What the PWA still needs (user panel)

- `id` field in the manifest (stable app identity across `start_url` changes).
- `screenshots` (required for the richer install UI on Android Chrome).
- `shortcuts` — blocked on the `BrowserRouter` migration above.
- `related_applications` + `prefer_related_applications` once the Play listing is
  live, so the browser can point installed users at the native app.
- A real offline experience. Today the SW falls back to a cached shell and returns
  a plain-text `Offline` 503 for anything it has never seen. For a money app the
  correct offline state is an explicit branded "you are offline, balances and cycle
  data may be stale" screen — never a stale balance rendered as current
  (design blueprint §0 non-negotiables).
- Install prompt handling (`beforeinstallprompt`) — currently unhandled, so the
  install affordance is entirely browser-driven.

### What admin and merchant need to become PWAs

Neither has a manifest, a service worker, or icons. The work per panel:

1. `public/manifest.json` scoped to the panel (`scope: "/merchant/"`,
   `start_url: "/merchant/dashboard"`) + `<link rel="manifest">` in `index.html`.
2. Icon set — generate from `Branding.icon` so the §12 branding pipeline stays the
   single source of truth rather than committing a second brand asset.
3. A service worker **scoped to the panel path**, registered with
   `{ scope: '/merchant/' }`. The user panel's SW is scoped to `/` and would
   otherwise claim these panels' pages.
4. Decide the caching posture per panel — see the warning below.

> **⚠️ Caching posture for admin and merchant is a policy decision, not a default.**
> The merchant panel is a payment workstation: an order card served from cache
> after a state change is a merchant confirming a payment against stale data. The
> admin panel shows balances, queues and ledgers. For both, the defensible strategy
> is **shell-only caching** (app shell + hashed assets) with **no data caching and
> no offline data fallback** — install for the icon, the standalone window and the
> faster cold start, not for offline use. Record whichever posture is chosen in
> `04-GOVERNANCE.md` §20.

Merchant is the stronger candidate of the two: merchants work on phones, orders
carry expiry countdowns, and a home-screen icon with a standalone window is a real
workflow improvement. Admin is desktop-first and gains least.

## 3.5 Android

### What is built (user panel)

A **Capacitor 8 shell**, `appId: com.bettingbazaar.app`, at `user-panel/android/`.
The platform folder is **committed on purpose** — the manifest, signing config,
network policy and Gradle wrapper are all hand-edited there. Never delete and
re-add the platform; run `npx cap sync android`.

| Decision | Value | Why |
|---|---|---|
| Web assets | **Bundled** (`webDir: 'dist'`), no `server.url` | A `server.url` pointing at production makes it a repackaged website, which stores treat as such. Bundled assets start offline-capable and instantly; only the API is remote. |
| `androidScheme` | `https` | A secure context is required for `crypto.subtle` and the storage APIs the auth layer uses |
| `allowBackup` / `dataExtractionRules` | **off** (both pre-12 and 12+) | The default copies WebView storage — which holds the live session token — into the user's Google Drive, and clones a logged-in session on device transfer |
| `usesCleartextTraffic` + `network_security_config` | TLS only | Enforced by the OS, so app code cannot weaken it |
| Service worker | not registered | The WebView already resolves these assets locally; the app updates through Play |
| R8 / `minifyEnabled` | **off** | Capacitor resolves plugins reflectively; shrinking needs exactly-right keep rules or the build compiles and fails on hardware. Keep rules are written in `proguard-rules.pro` — enabling it later is one line plus a device smoke test |
| Permissions | `INTERNET` only | Nothing else is needed |
| Plugins | `@capacitor/app`, `splash-screen`, `status-bar` | Lifecycle + chrome |

**The trap this design exists around, stated plainly:** inside the shell
`window.location` is `https://localhost`, so `realBackend.ts` matches its `isLocal`
branch and resolves the API to `http://localhost:8080/api` — **the handset itself**.
Nothing throws. The APK installs, opens, renders, and reaches nothing.
`npm run build:native` therefore runs `scripts/assert-native-env.mjs`, which refuses
to build without an absolute `https` `VITE_API_URL` and rejects `localhost` and a
trailing `/api`.

**Release pipeline** (`.github/workflows/android-release.yml`) — triggered by
`workflow_dispatch` with a version name, or by pushing an `android-v*` tag:

1. Node 22 + JDK 21 + Android SDK + Gradle.
2. `npm run build:native` with `VITE_API_URL` from the `ANDROID_API_URL` repo variable.
3. `npx cap sync android`.
4. Decode `ANDROID_KEYSTORE_BASE64` to `$RUNNER_TEMP` (outside the workspace, so no
   later step or artifact can pick it up).
5. `versionCode` = `github.run_number` — monotonic and never reused, which is Play's
   only hard requirement.
6. `assembleRelease bundleRelease` → signed **APK** (sideload / direct download) and
   **AAB** (Play upload).
7. **Verify the APK is not debug-signed** via `apksigner`, and fail if it is — a
   debug-signed build installs fine on a test handset and is only rejected at upload
   time, far too late.
8. Upload artifacts (90 days), then `rm` the keystore unconditionally.

Required config: secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`; variables `ANDROID_API_URL`,
`ANDROID_MERCHANT_PANEL_URL`. Full walkthrough: `ANDROID_RELEASE_SETUP.md`.

> **Back up the upload keystore somewhere you will still have in five years.**
> Losing it means you can never update the installed app — Play identifies an app by
> its signing key, and a new key is a new app. Enrol in Play App Signing.
> The same permanence applies to `TOTP_ENCRYPTION_KEY`: it has no `_PREVIOUS_`
> counterpart, and rotating it forces every enrolled user to re-enrol.

**No bundled VPN or proxy — recorded decision** (§20, 2026-07-28). Availability
against a blocked or failing *origin* is handled at the origin and DNS layer:
multi-domain redundancy, an Anycast/CDN edge, and the client-side origin failover
above. Shipping a circumvention transport inside a real-money gambling client would
place bets from where the platform is not licensed to accept them, and would get the
package removed from any store.

### Android work still open (user panel)

- **Not yet published.** The workflow produces artifacts; no Play listing, no
  internal-testing track, no store metadata (screenshots, description, content
  rating, data-safety form, gambling-app declaration) exists in the repo.
  Google Play requires an explicit gambling licence declaration per country.
- **Update-required gate.** `SystemConfig` carries `androidUrl`; there is no minimum
  supported version check, so an old APK with a removed API contract has no forced
  path to update. The design blueprint calls for a global "update required" modal —
  it needs a backend version floor to key on.
- **Push notifications.** `FLAGS.PUSH_NOTIFICATIONS` is declared and the PUSH channel
  adapter is registered but inactive. No FCM integration, no `@capacitor/push-notifications`.
  This is the biggest retention feature the native app currently does not have over
  the PWA.
- **Deep links / App Links.** No `intent-filter` beyond `LAUNCHER`. Blocked on the
  `BrowserRouter` migration.
- **Biometric unlock.** A natural fit for a money app with 2FA already in place;
  not started.
- **Play Integrity / attestation.** Not integrated.
- **iOS.** No Capacitor iOS platform, despite `/api/download/ios` and
  `NATIVE_APP_DISTRIBUTION_POLICY.md` naming it as a target. Adding it is
  `npx cap add ios` plus the same class of hardening decisions made for Android
  (keychain/backup policy, ATS, secure context) — but Apple's real-money gaming
  review requires a licence in every listed territory *before* submission.

### Merchant and admin as Android apps

Neither exists. Ranked by value:

1. **Merchant — strong case.** Order countdowns, a foregrounded workstation, and
   push notification for a newly assigned order are exactly what the native shell
   is good at. It would be a second Capacitor project (its own `appId`,
   `webDir: ../merchant-panel/dist`) reusing this repo's proven release workflow.
   It needs the same `VITE_API_URL` guard the user panel has.
2. **Admin — weak case.** Dense tables, exports and multi-column layouts. A PWA
   install is the right ceiling; a native shell buys almost nothing.

## 3.6 Concerns shared by every client

| Concern | Where it lives | Status |
|---|---|---|
| Branding (colors, names, logos, banners) | `branding` / `branding_updated` socket events → `localStorage.app_branding` → CSS variables + `document.title` (§12) | ✅ all three panels |
| System config (limits, maintenance) | `system_config` socket event | ✅ |
| Auth token storage | One key per app: `auth_token` / `admin-auth` / `merchantToken` (§1) | ✅ |
| 2FA UX | QR enrolment + OTP step | ✅ all three panels |
| Origin failover | `VITE_API_URL` + `VITE_API_FALLBACK_URLS` | ✅ user panel only — admin and merchant have no equivalent |
| Reconnect / stale-data banner | Design blueprint §6 requires a "Live" state, a reconnecting banner and a non-blocking "data may be delayed" state | ⚠️ partial — verify per panel |
| Version literal | `VITE_APP_VERSION` from each panel's own `package.json`; never typed in a component (§2) | ✅ |
| Brand hex sweep (C-03) | 93 remaining `#D4AF37` literals across 25 files in user + admin panels; merchant is at zero | ⚠️ open |

---

# Part 4 — Complete feature inventory

The screen-level reference is `design/BettingBazaar_UIUX_Product_Blueprint.md`
(the UI/UX blueprint) alongside `platform/capabilities.yaml` (the machine-checked
capability inventory). What follows is the feature inventory with delivery-target
availability. (An older `design/visual-mapping/views/UI_PAGE_REGISTRY.js` map was
removed in the 2026-08-18 cleanup — it was planning-only and read by no code; the
inventory below is now the maintained list.)

It currently holds **59 entries** — 18 player, 6 merchant, 35 admin — while its own
header comment still says "Exact 60-view … mapping". Correct the comment (or the
missing entry) on the next pass; a registry §4 tells you to grep before adding a
screen should not disagree with itself about its own size.

**Availability legend:** W = website · P = PWA · A = Android app.
Anything in the user panel is W+P+A today; merchant and admin are W only.

## 4.1 Player features (18 routes + 8 modals)

| Feature | Route | Primary API | Realtime |
|---|---|---|---|
| **Cycle market** (Delhi vs Bombay) — countdown, side cards, chip/amount controls, live pools, results, chat trigger | `/` | `POST /api/bet/place` | `new_cycle`, `cycle_snapshot`, `cycle_result`, `bet_placed`, `phantom_equalized`, `payout_complete` |
| Casino lobby — provider/category rails, metadata-driven cards, launch | `/casino` | `GET /api/game/providers`, `/games`, `POST /api/game/launch` | — |
| Crash arena | `/crash` | `POST /api/game/launch` | provider-gated |
| Sportsbook | `/sports` | `GET /api/game/games` | provider-gated |
| **Wallet** — total/deposit/winnings split, add funds, withdraw, ledger, order links, bank setup | `/wallet` | `/api/v1/user/profile`, `/api/payment/orders`, `/api/v1/wallet/ledger` | `user_balance_update`, `order_*` |
| Referral / invite — code, share, team, commissions (**F1 only**) | `/invite` | `/api/referral/me`, `/team`, `/commissions`, `/apply` | — |
| VIP — tier, progress, benefits | `/vip` | `/api/vip/config`, `/api/vip/my`, `/api/bonuses/my` | — |
| Gift code redemption | `/gift-code` | `POST /api/giftcode/redeem` | — |
| **Account recovery** — REMOVED 2026-08-25. There is no in-app recovery screen and no `/api/auth/check-aadhaar`, `/recover` or `/recover/status`. Recovery runs entirely in a SECOND Telegram bot and requires the same mobile AND the same Aadhaar to match. | — | — | — |
| Profile — username, avatar, bank/UPI, KYC status, sign-out. **No password, no email** — the only editable field is the username; Aadhaar and mobile are proved, not typed. | `/profile` | profile, bank, avatar-upload endpoints | `kyc_update` |
| Transaction / order history — timeline, filters, proof & dispute links | `/history` | `/api/payment/orders`, `/order/:id` | `order_update` |
| My bets — list, cycle/side/amount/status filters | `/my-bets` | `GET /api/user/:userId/bets` | `bet_placed` |
| Results — cycle timeline, winner/pool summary | `/results` | `/api/v1/game/cycles/history` | `cycle_result` |
| Winners / leaderboard | `/winners` | `/api/v1/winners`, `/api/leaderboard/:period` | — |
| Promotions & announcements | `/promo` | `/api/announcements` | `promo_data` |
| Rules | `/rules` | `/api/v1/system/config` | `system_config` |
| FAQ | `/faq` | `/api/v1/content/faq` | — |
| **Support** — links + AI assistant | `/support` | `/api/v1/content/support-links`, `POST /api/support/ask` | `support_reply` |

**Modals:** Auth (**no form** — one "Sign in with Telegram" action; players have
no password, no OTP and no captcha) · Channel gate (mandatory join prompt, not
dismissible) · Wallet (add funds / withdraw, 1:1 token preview, saved bank) ·
KYC (**status only** — nothing to submit; the bot took the Aadhaar before the
account existed) · Share (native share, copy, QR) · Place-bet confirmation ·
Payment-order detail (timeline, merchant, proof, dispute) · Bank details ·
Global maintenance / update-required.

**Deliberately not exposed:** there is **no player↔merchant chat page**. Payment
proof is a non-chat attachment workflow; all conversation routes through Support or
the admin Dispute Manager, with their own authorization (design blueprint §7).

## 4.2 Merchant features (5 routes)

| Feature | Route | API |
|---|---|---|
| Login (+ 2FA OTP step) | `/merchant/` | `/api/merchant/auth/login`, `/login/2fa` |
| Dashboard — available/active/completed counts, earnings, capacity, online toggle | `/merchant/dashboard` | `/profile`, `/stats`, `/earnings` + SSE |
| **Order workspace** — filter tabs, urgency, Accept / Confirm / Reject / Red Flag, order chat, proof upload, detail drawer | `/merchant/orders` | `/orders`, `/accept/:id`, `/confirm/:id`, `/reject/:id`, `/orders/:id/red-flag`, `/chat/:id`, upload URLs |
| History — orders, earnings periods, weekly earnings, export-ready views | `/merchant/history` | `/orders`, `/earnings`, `/earnings/weekly` |
| Profile — profile edit, QR upload, online state, preferences, limits, 2FA enrolment | `/merchant/profile` | `/profile`, `/online-status`, `/preferences`, `/api/merchant/2fa/*` |

**Merchant realtime (SSE):** `merchant_orders_snapshot` on connect, then `new_order`,
`order_assigned`, `order_paid`, `order_update`, `order_completed`, `order_rejected`,
`order_expired`, `merchant_score_update`, `merchant_config_updated`.

**Settlement rail (§1, 2026-07-27):** a merchant settles on **exactly one** rail —
INR (UPI + bank) or USDT (TRC-20), never both. `Merchant.acceptedCurrencies` holds
exactly one entry, enforced by a schema validator; `merchantType` is a derived
read-only virtual. The rail is matched at assignment, re-checked at accept, filters
the open withdrawal pool, and decides which credentials `PUT /profile` will accept.

**Flag-gated:** bulk payouts (`/api/merchant/bulk-payouts`, `/export`, `/mark-paid`)
require both `merchantAuth` **and** `isEnabled('MERCHANT_BULK_PAYOUTS')`, and are
hidden from default navigation until Payments Operations approves the rollout.

## 4.3 Admin features (35 routes)

**Cycles & game**

| Feature | Route |
|---|---|
| Dashboard — cross-platform KPIs, urgent queue, cycle/payment health | `/admin/#/` |
| Live cycles — phase, timers, pools, equalize, manage | `/admin/#/live-cycles` |
| Cycle history — outcomes, pools, drill-down, export | `/admin/#/cycle-history` |
| Game registry — games + categories CRUD | `/admin/#/games` |
| Game providers — CRUD, test connection, transaction monitor | `/admin/#/game-providers` |

**Money & finance**

| Feature | Route |
|---|---|
| Profit & loss | `/admin/#/profit-loss` |
| Transactions | `/admin/#/transactions` |
| Balance adjustment (audited, immutable receipt) | `/admin/#/users/balance-adjust` |
| Payment control centre — gateway config/test, withdrawal approve/reject | `/admin/#/payment-control` |
| Deposit policy (versioned, per currency) | `/admin/#/business-policy/deposit` |
| Revenue ledger + bonus-pool funding | `/admin/#/revenue` |
| Reports — financial, settlement, merchant, regulatory CSV export | `/admin/#/reports` |
| UTR registry | **backend only — navigation intentionally removed** |

**People & queues**

| Feature | Route |
|---|---|
| Users — search, detail, roles, block/unblock, phantom access, transactions | `/admin/#/users` |
| Merchants — directory, approval/suspension, limits, capabilities, funding | `/admin/#/merchants` |
| KYC queue — verification state, approve/reject with mandatory reason (the exception path; the bulk import decides the rest) | `/admin/#/kyc` |
| Bulk KYC — audited Aadhaar export, YES/NO import | `/admin/#/kyc/bulk` |
| Telegram setup — replace the sign-in bot or channel without a deploy | `/admin/#/telegram` |
| Referral programme — fund the payout queue in joining order | `/admin/#/referrals` |
| Queue manager — assignment queue, available merchants, manual assign/reassign | `/admin/#/queue-manager` |
| Disputes — list, chat/evidence, resolve/escalate | `/admin/#/disputes` |
| Sub-admins — invite/create, permission matrix, revoke | `/admin/#/sub-admins` |

**Merchant platform**

| Feature | Route |
|---|---|
| Merchant platform — leaderboard, performance, wallet ledger, bonus engine | `/admin/#/merchant-platform` |
| Operations overview — settlement/treasury/funding/risk/policy/merchant health, config catalog, retention run | `/admin/#/operations` |

**Content, promo & branding**

| Feature | Route |
|---|---|
| Announcements | `/admin/#/promotions/announcements` |
| Gift codes — generator, list, redemptions | `/admin/#/promotions/gift-codes` |
| FAQ manager | `/admin/#/content/faq` |
| Content slides | `/admin/#/content/slides` |
| Support links | `/admin/#/content/support` |
| CDN library | `/admin/#/content/cdn` |
| Branding — names, palette, logos, banners, live three-panel preview | `/admin/#/branding` |
| **App assets** — PWA/static asset upload with safe replacement preview | `/admin/#/app-assets` |
| Fake winners manager | `/admin/#/winners-manager` |
| Support operations — RAG knowledge-base ingestion and document management | `/admin/#/chat-management` |

**System**

| Feature | Route |
|---|---|
| System settings — bet limits, deposit/withdrawal limits, risk rules, maintenance, alert webhook, TLS policy, load-shed ceiling, Android/iOS URLs | `/admin/#/settings` |
| Audit logs — immutable, actor/action/time filters | `/admin/#/audit-logs` |
| Error logs — client crash reports from `POST /api/internal/error-report` | `/admin/#/error-logs` |

Every approve / reject / delete / fund / deduct / adjust / block / equalize /
rollback / policy-save follows the seven-step destructive-action pattern in the
design blueprint §5.3, ending in a success toast with a reference ID and a
"view audit record" path.

**`/admin/#/app-assets` is the branding hook for the PWA.** `Branding.icon` is
declared as the manifest icon consumer in §12, so any new panel manifest should be
generated from this pipeline rather than from committed brand files.

---

# Part 5 — Dormant capabilities and feature flags

Everything here is **built or seamed and switched off** — turning one on is
configuration, not new architecture.

| Flag (`FEATURE_<NAME>`) | Default | What it gates |
|---|---|---|
| `LIVE_CASINO` | off | Third-party casino expansion |
| `SPORTSBOOK` | off | Sportsbook product domain (declared) |
| `GAMES_PLATFORM` | off | In-house games beyond the cycle market |
| `EVENT_FEEDS` | off | Fixtures / results / live data ingestion |
| `ODDS_ENGINE` | off | Dynamic pricing (cycle market stays fixed 2×) |
| `PUBLIC_CHAT` | off | Public chat |
| `MULTI_CURRENCY` | off | Multi-currency |
| `CRYPTO_PAYMENTS` | off | Crypto rails |
| `INTERNATIONAL_GATEWAY` | off | International payment gateway |
| `MERCHANT_BULK_PAYOUTS` | off | Merchant bulk payout workspace |
| **`PUSH_NOTIFICATIONS`** | off | Push channel — **the Android app's biggest missing feature** |
| `KAFKA_EVENT_BUS` | off | External event backbone |
| `READ_REPLICA` | off | Read-replica routing |
| `MULTI_TENANT` | off | Per-tenant flag resolution |
| `MAINTENANCE_MODE` | off | Maintenance mode |
| `REDIS_RATE_LIMITER` | **on** | Redis-shared rate limit counters |
| `WAF_FILTER` | **on** | OWASP request filter |

**Env-activated seams** (`04-GOVERNANCE.md` §18):

| Activate with | Turns on |
|---|---|
| `VOYAGE_API_KEY` + `DATABASE_URL` (pgvector) | RAG retrieval |
| `ANTHROPIC_API_KEY` | RAG generation — the support assistant |
| `KAFKA_BROKERS` | Event backbone |
| `SERVICE_<NAME>_URL` | Resolves that domain to a remote service |
| `SERVICE_JWT_SECRET` | Inter-service auth signing |
| `MONEY_AUTHORITY_{WALLET,LEDGER,ORDERS,KYC}` | Per-path Postgres cutover — **owner-gated, boot-refused if out of order** |

**Extraction order when a measured trigger arrives:** `support` (RAG — stateless,
zero money risk, the rehearsal) → `markets` → `payment`/`merchant` → `wallet`
(**last**, strongest consistency). `identity` stays central.

---

# Part 6 — Open gaps and decisions the plan needs

Ordered by how much they block the Android/PWA/website plan.

### Blocking the client plan

1. **`HashRouter` on the user panel.** Blocks deep links, App Links, manifest
   shortcuts, SEO and per-screen analytics simultaneously. The server-side SPA
   fallbacks already exist; the merchant panel already proves the pattern.
   → migrate to `BrowserRouter`.
2. **No PWA for merchant or admin.** No manifest, SW or icons. Needs a caching-posture
   decision first (see §3.4) — shell-only is the defensible default for both.
3. **Push notifications not built.** `FLAGS.PUSH_NOTIFICATIONS` off, PUSH channel
   adapter declared-inactive, no FCM. The single largest capability gap between the
   native app and the PWA.
4. **Play Store presence.** The signed AAB is produced by CI but there is no listing,
   testing track, or store metadata — and Play requires an explicit per-country
   gambling licence declaration.
5. **No iOS client** despite `/api/download/ios` and the distribution policy naming it.
6. **No forced-update mechanism.** `SystemConfig.androidUrl` exists; a minimum
   supported version floor does not.

### Documentation drift (fix in the same pass)

7. **`README.md` "Security" and `LAUNCH_READINESS.md` §F both state that 2FA is not
   implemented anywhere.** That is now **false** — TOTP 2FA is built, enforced for
   admins and sub-admins, optional for players, available for merchants, with
   enrolment UI in all three panels (`domains/identity/`, `twoFactor.routes.js`,
   `verifySecondFactor.js`, `RATE_LIMITS.md` already describes the OTP tier).
   Both documents predate commits `84e26b2` / `100a4de` / `6b5cced`. The §20 rule
   cuts both ways: a control that exists but is documented as missing invites
   someone to "add" it and collide with the real implementation.
8. **Stale `importmap` and cache-control meta in `user-panel/index.html`** (§3.3).
9. **Orphan `user-panel/src/pages/LeaderboardPage.tsx`** — defined, never routed.

### Standing platform gaps (already tracked, repeated for completeness)

10. **No load test has been run.** `LAUNCH_READINESS.md` §D marks it a launch
    blocker; `LATENCY.md` explains precisely which numbers are unknown and which
    three existing metrics answer part of the question. Client scale planning
    (how many concurrent SSE/WebSocket connections the fleet holds) depends on it.
11. **No CAPTCHA / bot mitigation** anywhere (§F).
12. **Postgres money cutover not performed** — correct and deliberate (§E).
13. **C-03 brand-token sweep** — 93 `#D4AF37` literals across 25 files.
14. **Compliance is a hard gate** — licence, AML/KYC programme, third-party pen test
    (§G). No amount of engineering readiness substitutes for it, and both app stores
    check it before the code.

---

# Part 7 — Suggested build order

Each step is independently shippable and leaves the tree green.

| # | Work | Why here |
|---|---|---|
| 1 | Correct the 2FA claims in `README.md` + `LAUNCH_READINESS.md` §F; delete the stale importmap and the conflicting cache-control meta; route or delete `LeaderboardPage` | Cheap, removes active misinformation, unblocks accurate planning |
| 2 | User panel `HashRouter` → `BrowserRouter` (+ link-literal sweep, verify the `/{*splat}` fallback and origin failover still behave) | Gates deep links, App Links, shortcuts, SEO, analytics — everything downstream |
| 3 | Manifest polish: `id`, `screenshots`, `shortcuts`, branded offline screen, `beforeinstallprompt` handling | Turns the existing PWA into an installable product rather than a technicality |
| 4 | Merchant PWA — manifest + panel-scoped SW (shell-only caching), icons from `Branding.icon`, decision recorded in §20 | Highest-value second client; merchants work on phones |
| 5 | Push notifications — FCM + `@capacitor/push-notifications`, activate the PUSH channel adapter behind `FLAGS.PUSH_NOTIFICATIONS`, wire `notify()` | The retention feature the native app is missing; benefits PWA on Android too |
| 6 | Forced-update floor in `SystemConfig` + the update-required modal the blueprint specifies | Required before a Play listing can be maintained safely |
| 7 | Play Store listing, internal testing track, data-safety + gambling declarations | Depends on 5 and 6, and on the licence (§G) |
| 8 | Merchant Android shell — second Capacitor project reusing the release workflow | Only worth it after 4 and 5 prove the demand |
| 9 | Admin PWA (shell-only) | Lowest value; do it when convenient |
| 10 | iOS — `npx cap add ios` + the equivalent hardening decisions | Gated on licences in every listed territory |

**Not on this list, deliberately:** admin native app (a PWA install is the right
ceiling), and any bundled VPN/proxy transport (§20, 2026-07-28 — recorded decision,
do not revisit without an explicit owner reversal).

---

**Related reading:** `04-GOVERNANCE.md` (rules §§0–16; architecture §§17–21) ·
`LAUNCH_READINESS.md` · `ENV.md` · `RATE_LIMITS.md` · `LATENCY.md` ·
`ANDROID_RELEASE_SETUP.md` · `NATIVE_APP_DISTRIBUTION_POLICY.md` ·
`design/BettingBazaar_UIUX_Product_Blueprint.md` · `platform/capabilities.yaml`
