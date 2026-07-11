# Production Readiness — Owner Checklist & Integration Setup

---

## 🚦 LAUNCH VERDICT (2026-07-10, after Phase X)

**Are we ready to launch to market? Not yet — but the software is close, and
what's left is mostly NOT code.**

**Engineering: strong.** The money core is double-entry, integer-paise,
idempotent, and now concurrency- and crash-resume-proven in CI; the reserve
economy actually runs (the deposit path was silently not funding reserve —
fixed); settlement/withdrawal/bonus flows are integration-tested; rate limiting
and background jobs are multi-instance-safe; there are correlation IDs +
structured logs; a data-retention policy; a clean authorization matrix (no
holes found); and the codebase is genuinely portable (Docker + all-env config,
runs on any host / any Mongo provider / any S3-compatible storage / any CDN).
72 unit + ~34 integration tests green on every push.

**Hard blockers before a public launch (owner-owned, not code):**
1. **Licensing** — real-money betting is a licensed activity; operating
   unlicensed is illegal in most jurisdictions. This is the #1 gate.
2. **Rotate all secrets** — they were exposed in chat (see §A1).
3. **Responsible gaming + geo-blocking** — self-exclusion, deposit/loss limits,
   cool-offs are NOT built and are usually license-mandated (§A2).
4. **External pentest** on staging (§A3) and a **load test** at target scale (§A4).
5. **A real staging soak** — run an actual deposit → bet → settle → withdraw
   end-to-end (the reserve-funding change alters live balance behavior; verify it
   on real infra before real money).

**Scale caveat:** a single-instance launch is fine now. Before running >1
backend instance, add the SSE/socket Redis pub-sub bridge (background jobs are
already leader-locked; app-asset uploads should move to S3).

**Bottom line:** engineering-wise this is materially past a typical build —
close to launch-grade. But **do not take real money from the public until the
licensing + responsible-gaming + secret-rotation + pentest items above are
done**, and you've soaked a full money cycle on staging. For a licensed,
single-instance beta after those, it's viable.

---


**Purpose:** everything that stands between the current build and a real
public launch, split into (A) things only the owner can do, and (B) how to
activate each dormant integration. Code-side items that could be done in-repo
are DONE (see PHASE_STATUS.md); nothing below is a code gap — each item needs
credentials, money, or a legal process.

Created 2026-07-10 (Phases E/F). Keep updated as items close.

---

## A. OWNER ACTIONS — blocking before launch

### A1. Rotate every secret (CRITICAL — was exposed in chat during testing)
In the Railway dashboard, generate fresh values for:
`JWT_SECRET`, `SESSION_SECRET`, `CSRF_SECRET`, `ENCRYPTION_KEY`,
`ORDER_HMAC_SECRET`, `MONGODB_URI` (rotate the Atlas DB user password),
`REDIS_URL` (rotate if the provider allows), `S3_ACCESS_KEY`,
`S3_SECRET_KEY`, and change `DEFAULT_ADMIN_PASSWORD` to a strong unique
value. Rotating `JWT_SECRET` logs every user out once — do it in a
maintenance window.

### A2. Licensing & compliance (real-money betting is a licensed activity)
- Obtain a gaming license for the target jurisdiction(s); geo-block
  everywhere else.
- KYC/AML program: the KYC flow exists (Aadhaar/PAN + admin review);
  a compliance officer and written AML policy do not.
- Responsible gaming: self-exclusion, deposit/loss limits, cool-offs are
  NOT built — most licenses require them (queued as Risk Platform
  capabilities, deliberately not stubbed).

### A3. External security validation
- Commission a penetration test against a STAGING copy (never prod data).
- Then consider a private bug-bounty. In-repo hardening already done:
  bcrypt 12 everywhere, IDOR checks, admin auth-gating, rate limiting
  (Redis-shared), append-only ledgers, idempotent money flows, CI-proven
  settlement concurrency safety.

### A4. Load testing
Run k6/Artillery against staging: bet placement bursts, settlement of a
cycle with thousands of bets, SSE fan-out. Tune `MONGO_MAX_POOL_SIZE` /
`MONGO_MIN_POOL_SIZE` (now env vars) against the Atlas tier's connection
budget when adding instances.

### A5. Data & ops hygiene
- Enable Atlas continuous backups + test a restore once.
- Drop the orphaned `tokenrates` Mongo collection during a maintenance
  window (nothing reads it since the 1:1 flattening).
- Set up uptime monitoring + log-based alerting on: `Ledger integrity`
  (revenue summary `integrityOk:false`), settlement errors, Redis
  disconnects (rate-limit fallback warnings).

---

## B. DORMANT INTEGRATIONS — how to activate each

All of these are real adapters behind registries — activation is
configuration, not a rewrite. **Never paste credentials into chat; set them
as Railway env vars.**

### B1. Email (Communication Platform) — READY, needs SMTP creds
Set env: `SMTP_HOST`, `SMTP_PORT` (587, or 465 for TLS), `SMTP_USER`,
`SMTP_PASS`, `SMTP_FROM` (e.g. `"Betting Bazaar <no-reply@yourdomain>"`).
The EMAIL channel then reports ACTIVE in /operations and delivers real
mail. Works with any SMTP provider (SES, Postmark, Brevo, ...). Users need
an email on file (`User.email`, optional — a profile-page field is queued
UI work).

### B2. SMS (Communication Platform) — needs a provider decision
Pick an Indian-DLT-compliant gateway (MSG91, Kaleyra, Twilio). Then
implement `send()` in `backend/domains/communication/channelRegistry.js`
against that provider's API (mirror the EMAIL adapter pattern) with env
credentials. DLT template registration is a legal prerequisite in India.

### B3. Web/App push (Communication Platform) — needs VAPID keys
Generate a VAPID key pair, add a service-worker push handler in the user
panel, implement the PUSH adapter (web-push npm package), gate on
`FEATURE_PUSH_NOTIFICATIONS`.

### B4. USDT deposits (Funding Platform, USDT_TRC20 adapter declared)
Needs: a TRON API source (TronGrid key or self-hosted node), a treasury
address-management scheme (per-order deposit addresses or memo-based), a
confirmation watcher, and hot/cold wallet policy. Then implement the
adapter in `backend/domains/funding/providerRegistry.js`. The admin USDT
rate config ships with that work (`SUPPORTED_CURRENCIES` already includes
USDT end-to-end in DepositPolicy).

### B5. Payment gateway (optional, non-P2P deposits)
`PaymentGatewayConfig` scaffolding exists. Pick a gateway that accepts
this business category, implement the PAYMENT_GATEWAY adapter + webhook
verification.

### B6. Telegram bot (optional)
Decide the product purpose first (W-4): support handoff vs. notifications
vs. community. Support links (username/group/channel) are already
admin-configurable and shown on the Support page without a bot.

---

## C. STATUS SNAPSHOT (what's already production-grade in-repo)

- Money core: double-entry append-only ledger (integer paise, idempotency
  keys, conservation checked in CI), single-writer wallet authorities,
  paise-exact bet funding split + winnings fee (admin-editable), F-1/F-2
  fixed, settlement proven under concurrency and crash-resume in CI.
- Scale: Redis-shared rate limiting (F-3), User hot-path indexes, pool
  sizing via env, stateless app tier (JWT; SSE/socket state is
  per-connection).
- Verification: 72 unit tests + 9 integration suites (real Mongo
  replica set + real Redis) green in CI on every push.
- Operability: /operations overview + config catalog, /revenue ledger
  console, /reports with regulatory CSV export, full audit trails.

Known intentional gaps: horizontal SSE/socket fan-out is per-instance
(needs a Redis pub/sub bridge before >1 instance serves live traffic —
flagged in EXECUTION_QUEUE.md), responsible-gaming controls (A2), and the
declared-inactive integrations above.
