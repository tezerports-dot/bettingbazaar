# Betting Bazaar — high-frequency prediction market

Bet on Delhi vs Bombay in real time, with a P2P merchant settlement network and
algorithmic game cycles. The player app is a React SPA; there is no 3D renderer
in it (the three.js dependency was removed 2026-07-27 — nothing imported it).

## 🚀 Going Live (For No-Coders)

**Start here: [`docs/GO_LIVE_RUNBOOK.md`](docs/GO_LIVE_RUNBOOK.md)** — the ordered,
do-this-then-that guide to launching on a Shinjiru dedicated server with
PostgreSQL as the money authority and the built-in manual (merchant) payment
system. It sequences the deep guides for you:

- **Build the server:** [`deploy/VPS_UBUNTU_SETUP.md`](deploy/VPS_UBUNTU_SETUP.md)
  — one Ubuntu box: Node 22, MongoDB 7 (replica set), PostgreSQL 18, Redis,
  MinIO, PM2, NGINX + TLS.
- **Every environment variable:** [`docs/governance/ENV.md`](docs/governance/ENV.md)
  and the annotated `.env.example`.
- **The Android app / APK:** [`docs/governance/ANDROID_RELEASE_SETUP.md`](docs/governance/ANDROID_RELEASE_SETUP.md).

The stack self-hosts every datastore (no MongoDB Atlas, no Railway) — the app
boot-gate refuses to start on an incomplete or insecure config, which is
deliberate. Read the runbook's Phase 0 before you rent anything.

### Local Development
1. Open your Chromebook Terminal.
2. `cd betting-bazaar`
3. `npm ci --legacy-peer-deps`
4. `npm run install:panels`
5. `npm run dev` (user-panel preview)
6. `npm run build:user` (user-panel production build)
7. `npm run start:local` (backend start)

## 📁 Project Structure
* `/user-panel`: Customer-facing React/Vite application.
* `/admin-panel`: Admin React/Vite application.
* `/merchant-panel`: Merchant React/Vite application.
* `/backend`: Node.js/Express API and bounded domain services for the modular monolith.
* `/docs/governance`: Single governance hub for enterprise decisions, authorization, SRE, disaster recovery, retention, launch checks, and the monolith-to-microservices migration plan.
* `/design`: UI/UX blueprint and the `visual-mapping/` screen sketch — reference material, not build targets.
* `/platform`: Capability inventory used by governance verification.
* `/deploy`: Deployment notes and environment-specific runbooks (k8s, Compose, Grafana, HAProxy).
* `/e2e`, `/scripts`, `/tools`: Playwright specs, maintenance scripts, and developer tooling.

Each panel owns its `package.json` and lockfile and installs its own React
stack; the repository root holds **backend dependencies only** (GOVERNANCE §14).
Do not add frontend packages to the root — the backend image installs it.

## 🏢 Enterprise & Launch Readiness
Centralized governance now lives in `docs/governance/README.md`. Start there before launch review or contractor handoff. The current architecture is intentionally a modular monolith with documented seams for a future monolith + microservices transition; see `docs/governance/04-GOVERNANCE.md` §18 for the migration plan and §19 for the capability matrix / remaining launch/hardening work.

## 🛡️ Security

Implemented and verifiable in the codebase:

* **PASETO Ed25519 auth** with instant revocation and rotatable signing keys
  (`domains/identity/paseto.util.js`) — no alg-swap or `none` algorithm.
* **Argon2id password hashing** with a bcrypt verify-fallback for legacy rows
  (`domains/identity/password.util.js`).
* **Boot gate** that refuses to start in production on a missing or weak secret,
  or on unverified money-database TLS (`startup/validateEnv.js`).
* **HMAC-bound payment orders** — order integrity is cryptographically signed
  (`middleware/order-crypto-access.js`), with rotatable secrets.
* **Append-only double-entry ledger** in integer paise, DB-enforced, balances
  always derived from postings (`domains/revenue/`, `postgres/schema.sql`).
* **P2P escrow status tracking** on every payment order.
* **Tiered + per-subnet rate limiting**, surge breaker, load-shed and an
  application-side OWASP filter (`middleware/security.js`, `ipDefense.js`).
* **Admin action audit logging** (`EnhancedAuditLog`) across privileged routes.
* **TOTP two-factor authentication** — **mandatory** for admins and sub-admins,
  optional for players, available for merchants. Two-step enrolment (a pending
  secret only becomes live once a code from the authenticator verifies, so nobody
  can lock themselves out of an entry they never scanned), one-time recovery
  codes stored only as hashes, and secrets encrypted at rest with AES-256-GCM
  under a dedicated `TOTP_ENCRYPTION_KEY` (`domains/identity/totp.service.js`,
  `twoFactor.routes.js`, `verifySecondFactor.js`). Enrolment and OTP UI ship in
  all three panels. Second-factor submissions have their own tighter rate-limit
  tier — see `docs/governance/RATE_LIMITS.md`.

**Not implemented — do not assume these exist** (see
`docs/governance/LAUNCH_READINESS.md` §F):

* **No CAPTCHA / bot-mitigation challenge** on any form. Rate limiting is the only
  automated-abuse control today.

---
**Maintained by AI Studio Production Pipeline**
