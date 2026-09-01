# Launch Readiness — "app is ready" vs "infra/ops you must do"

**Purpose:** one page that separates what the **application code** already
guarantees (verified in this repo + CI) from the **infrastructure, operations,
and compliance** work that is *not* code and must be done by the operator before
a real-money launch. Nothing here is aspirational — every ✅ points at something
real in the repo; every 🟡 / ⛔ is an owner action.

> ⚠️ **Compliance is a hard gate, not a checklist item.** Real-money betting
> needs a gambling/gaming licence, AML/KYC for your jurisdiction, and a
> professional third-party security audit + penetration test. No amount of
> engineering readiness substitutes for it. See `DEPLOYMENT.md`.

**Legend:** ✅ done in code (CI-verified) · 🟡 owner/infra action · ⛔ launch blocker

---

## A. Application & code — ✅ READY

| Area | Status | Evidence |
|---|---|---|
| Boot fails closed on missing/weak secrets or unverified money-DB TLS | ✅ | `startup/validateEnv.js`, `tests/unit/validateEnv.test.js` |
| Stateless app tier (all durable state in Postgres/Redis/S3) | ✅ | `04-GOVERNANCE.md` §17; k8s `readOnlyRootFilesystem`, `emptyDir` |
| Multi-instance realtime (SSE/WebSocket fan-out via Redis) | ✅ | `startup/realtimeBridge.js` |
| Tiered + per-subnet rate limiting, surge breaker, load-shed/bulkhead | ✅ | `middleware/security.js`, `ipDefense.js`, `loadShed.js` |
| Idempotent, crash-resume settlement (no money lost mid-payout) | ✅ | `payoutRecoveryTask`; DR §1 |
| Money as integer paise + append-only, DB-enforced double-entry ledger | ✅ | `postgres/schema.sql` (balance/append-only triggers) |
| PASETO Ed25519 auth (no alg-swap/`none`), instant revocation | ✅ | `domains/identity/paseto.util.js` |
| Health/readiness/liveness + graceful drain; Prometheus + Grafana-as-code | ✅ | `server.js`, `deploy/grafana/` |
| CI: single-store gate, unit + Postgres money-path suites (real Postgres/Redis), typecheck/builds, audit, sbom, secret-scan | ✅ | `.github/workflows/ci.yml` |

**Bottom line:** the code is launch-grade. The remaining work below is *not* code.

---

## B. Secrets & rotation — ✅ all rotatable with zero user impact

Every signing secret now supports an **overlap window** — rotate without logging
users out or 403-ing in-flight records. Procedure: add the old value to the
`*_PREVIOUS_*` var, set the new primary, deploy, and drop the old value after the
overlap (token TTL / order lifetime) elapses.

| Secret | Rotate with | Overlap source |
|---|---|---|
| Auth (`JWT_SECRET`/`PASETO_SECRET_KEY`) | `JWT_PREVIOUS_SECRETS` (or `PASETO_PREVIOUS_SECRETS`) | `paseto.util.js` verify-key set |
| Order integrity (`ORDER_HMAC_SECRET`) | `ORDER_HMAC_PREVIOUS_SECRETS` | `middleware/order-crypto-access.js` |
| Aadhaar dedup (`AADHAAR_HMAC_SECRET`) | `AADHAAR_HMAC_PREVIOUS_SECRETS` | `domains/identity/aadhaarHash.util.js` |
| `METRICS_TOKEN`, alert webhook | System Settings / env, no redeploy | DR §5 |

- 🟡 **Domains:** add to `ALLOWED_ORIGINS`, point DNS. Host-agnostic Caddyfile; frontends fall back to same-origin `/api`. DNS-failover runbook: `DISASTER_RECOVERY.md §4`.
- 🟡 **Servers:** replace freely — rolling update `maxUnavailable: 0` + PodDisruptionBudget; the app holds no durable state.
- 🟡 **DB host:** swap `DATABASE_URL` — any PostgreSQL 16+ host. No call site knows which host it is talking to (`04-GOVERNANCE.md` §17).

---

## C. Data safety / disaster recovery

| Item | Status | Action |
|---|---|---|
| Daily `pg_dump` → S3, 14 retained, failure paged | ✅ | `services/backup.service.js` |
| **Restore drill** ("an untested backup is not a backup") | 🟡 | Run once on staging now, then quarterly — DR §2 |
| PITR (WAL archiving, to-the-second) — **and one rehearsed restore** | ⛔ | Enable WAL archiving off-box — DR §3, §E item 1 |
| Postgres WAL archiving (PITR for money) | 🟡 | Enable on the managed Postgres — DR §3 |
| RPO/RTO targets (≤24h→minutes / ≤1h app, ≤4h DB) | ✅ documented | Validate in the drill — DR header |

---

## D. Infrastructure to stand up for 1M DAU — 🟡 (app exposes the hooks; you run the infra)

The app is a horizontally-scalable stateless monolith with dormant
microservice seams. Capacity sketch: 1M DAU ≈ 30–70k concurrent ≈ 6–20k RPS,
handled by the scaled monolith behind an LB **before** any service split is
needed (`04-GOVERNANCE.md` §18).

- 🟡 **Managed, clustered datastores:** PostgreSQL **primary + streaming replica** (the replica is both read-scaling and the failover target, so size it to match the primary); **Redis Cluster**; managed **Postgres**. Single-node dev stores will not carry 1M DAU.
- 🟡 **Edge gateway / L7 load balancer:** Envoy, Kong, or APISIX in front — TLS termination, global rate limiting, LB across instances. App exposes `/health/live`, `/health/ready`, `/metrics`, versioned routes (`04-GOVERNANCE.md` §18).
- 🟡 **WAF** (Cloudflare) — `middleware/owaspFilter.js` is the app-side complement, not a replacement.
- 🟡 **Autoscaling / HA:** apply `deploy/k8s/deployment.yaml` (api/realtime/scheduler roles, HPA, PDB, topology spread) or equivalent.
- 🟡 **Multi-region + DNS health-checked failover** (`DISASTER_RECOVERY.md §4`).
- ⛔ **Load test.** The RPS numbers above are a *sizing sketch, not a benchmark*. Run a real load test against staging before launch and size pools/replicas from the result. This is the single biggest unknown.

---
## E. The money store — ✅ settled; no cutover to gate

**PostgreSQL is the only datastore, for money and for everything else.** There is
no cutover to gate, no authority to flip, no reconciliation window to wait out
and no rollback to keep ready — all four were properties of running two stores.

This section previously ran to seventy lines: a per-path authority switch
defaulting to the other store, a forward mirror, a reverse mirror whose job was
to make a rollback lossless, a two-sided reconciler, a lock-provenance seeding
step that had to run in a specific minute relative to the flip, and a 24-hour
clean-reconciliation gate before any path could move. **All of it is deleted.**
The platform is pre-deployment, so there was never any data to migrate; the
machinery existed to make a migration survivable and there is no migration. See
`CLAUDE.md` and the 2026-09-01 entry in `04-GOVERNANCE.md`.

**What replaces the gate.** The properties the gate was trying to buy are now
structural, and are asserted by tests against a real PostgreSQL rather than
watched on a dashboard:

| Property | How it is guaranteed now | Evidence |
|---|---|---|
| Money is integer paise at rest | `BIGINT` columns; no float, no decimal string in arithmetic; cast at the read boundary because `BIGINT` returns as a **string** | `postgres/schema.sql`, `npm run test:pg` |
| No lost update on a balance | Row-level `SELECT … FOR UPDATE` around every mutation; the split for a spend order is computed **inside** the lock, never from a pre-read | `npm run test:pg` concurrency suites |
| A replay cannot double-spend | Unique `tx_id` per movement — the constraint is the gate, not an application check | `npm run test:pg` |
| Accounting cannot silently drift | Append-only double-entry ledger with conserve-to-zero triggers; a balance and its ledger are written in **one transaction** | `postgres/schema.sql` triggers |
| Settlement cannot pay from stale state | The winner is written **before** the status, and a cycle with no winner is never offered for settlement | settlement suites |
| No decision reads the wrong number | One store, so a decision read and the write it authorises touch the same row under the same lock | — |

**What is still owed before launch, and is genuinely operational:**

1. ⛔ **Rehearse a restore.** Point-in-time recovery is the one real gap: enable
   WAL archiving off-box and **actually restore from it once**, to a scratch
   host, and time it. An untested backup is not a backup. This was previously
   listed as the gate for removing the reverse mirror; it is now simply the
   gate for taking money, which is where it belonged.
2. ⛔ **Load-test the consolidated tier.** PostgreSQL now carries every domain.
   The sizing in `deploy/CAPACITY_AUDIT_10K.md` §5 is explicitly marked as
   needing re-measurement — do that before buying hardware.
3. 🟡 **Watch `wallets` row-lock waits and 40P01 deadlocks**, not store drift.
   Drift is not a failure mode with one store; lock contention is the ceiling.

## F. Account-security controls — 🟡 one of two is now built

| Control | State | Evidence |
|---|---|---|
| Two-factor authentication | ✅ **built and enforced** | TOTP, **mandatory** for admins and sub-admins, available for merchants. **Not applicable to players** since 2026-08-25 — they have no password, so there is no first factor for a second one to reinforce; controlling the Telegram account is the whole authentication. Two-step enrolment (`POST /api/2fa/setup` mints a *pending* secret; only `POST /api/2fa/activate` with a valid code makes it live), one-time recovery codes stored as hashes, secrets AES-256-GCM encrypted at rest under `TOTP_ENCRYPTION_KEY`. Login issues a short-lived challenge instead of a session until the code is redeemed (`routes.js` `loginHandler` → `loginTwoFactorHandler`, mounted at `/api/admin/login`; both legs now also refuse any account without a staff role). Enrolment + OTP UI in the admin and merchant panels. Files: `domains/identity/{totp.service,twoFactor.routes,twoFactorChallenge,verifySecondFactor}.js`. Own rate-limit tier — `RATE_LIMITS.md`. |
| CAPTCHA / bot-mitigation challenge | ✅ **built**, dormant until keyed | Cloudflare Turnstile on admin login and merchant login (`middleware/captcha.js`). The player login/register endpoints it also guarded were removed on 2026-08-25 — the bot is the player's only door, and Telegram fronts it. Pass-through until `TURNSTILE_SECRET_KEY` is set. Applied per-path, never router-wide — gating the whole `/api/v1/auth` router would also gate `GET /me` and 403 every page load. **Fails OPEN when Cloudflare is unreachable** and alerts: an invalid token is refused, but someone else's outage must not become a platform-wide login outage, and an attacker cannot induce that path. |
| Player authentication | ✅ **rebuilt on Telegram** | No password exists for a player: the bot proves the phone with a contact share, takes the Aadhaar, checks channel membership, and issues a single-use link the browser trades for a session. Nothing to credential-stuff, phish a reset for, or leak as a hash. Sessions are minted by one shared `issueSession`, so the Telegram door and the staff door cannot grant different claims. Account recovery runs on a **second** bot requiring both the registered phone and the Aadhaar on file, with one indistinguishable failure reason. Files: `domains/telegram/*`, `middleware/requireChannelMembership.js`. Full design: `docs/IDENTITY_AND_REFERRALS.md`. |
| Identity at rest | ✅ **built** | Aadhaar held as an HMAC (uniqueness, DB-enforced) *and* AES-256-GCM ciphertext (bulk export), both rotatable via decrypt-only previous-key lists. No identity documents are collected at all — the strongest form of protecting them. `IDENTITY_ENCRYPTION_KEY` is a boot-gate requirement in production. |

**History, kept deliberately.** Until 2026-07-27 the repository claimed both
controls while neither existed; the claims were removed and recorded here as a
gap. 2FA was then built (2026-07-28/29) — but this section was not updated with
it, so for a period the docs understated the platform. Both directions of drift
are the same defect: **a control documented as missing invites someone to build a
second one and collide with the real implementation, exactly as a control
documented as present stops anyone asking for it.** Verify before documenting,
in either direction.

**Why a challenge was needed at all:** the login limiters count FAILURES per
IP, which is the wrong shape for credential stuffing spread across thousands of
residential addresses — each IP tries three passwords and never reaches a
counter. A challenge prices the attempt rather than the failure.

**Remaining owner action:** create a Turnstile site at
dash.cloudflare.com → Turnstile, set `TURNSTILE_SECRET_KEY` on the server and
`VITE_TURNSTILE_SITE_KEY` at panel build time. Until both are set the gate is
inert and rate limiting is again the only control.

**`TOTP_ENCRYPTION_KEY` has no rotation path.** It has no `_PREVIOUS_`
counterpart: rotating it makes every stored secret undecryptable and forces every
enrolled user — including every admin — to re-enrol, with nobody able to sign in
meanwhile. Back it up with the same care as the Android signing keystore.

---

## G. Compliance & legal — ⛔ hard gate

**⛔ India: this category is prohibited, not licensable.** The Promotion and
Regulation of Online Gaming Act, 2025 has been in force since **1 May 2026**.
§5 bans offering or abetting an *online money game* — defined as a game played
on payment of a stake in expectation of winning money, **skill or chance
irrelevant** — with up to 3 years' imprisonment and/or ₹1 crore. §6 bans
advertising it. §7 bans banks *and any other person facilitating financial
transactions* from processing related funds, which reaches the P2P merchant
network personally. Constitutional challenges are before the Supreme Court,
which has **declined an interim stay**.

The practical consequence for this checklist: the first line below cannot be
cleared for India by acquiring anything. There is no licence to obtain, and no
distribution channel — Play, App Store, sideloaded APK or plain web — changes
that. Full analysis, including what each store additionally requires in a
jurisdiction that *does* license the category:
`NATIVE_APP_DISTRIBUTION_POLICY.md` §1. **Not legal advice — take Indian
gaming-law counsel.**

- ⛔ Gambling/gaming **licence** for each jurisdiction served — *and confirmation
  that the jurisdiction licenses this category at all*.
- ⛔ **AML/KYC** program appropriate to that licence. Note the current identity
  model is Aadhaar + a Telegram-linked Indian mobile; it does not transfer to
  another jurisdiction unchanged.
- ⛔ Professional third-party **security audit + penetration test**.
- 🟡 Responsible-gaming controls, geo/age restrictions, dispute/chargeback process.

Infrastructure privacy (origin hiding, operator privacy) is legitimate and
standard, but is **not** a substitute for licensing or a way to evade regulators
(`DEPLOYMENT.md §C`).

---

## Go / No-Go summary

**Green to ship (engineering):** app code, secrets & rotation, backups exist,
CI green, deploy artifacts committed.

**Must clear before a real-money launch:**
- ⛔ **Which jurisdiction, and does it license this category?** For India the
  answer is now no (§G). Everything else on this list is downstream of it.
- ⛔ Compliance/licensing + third-party pen-test (§G)
- ⛔ A real load test at target scale (§D)
- 🟡 Key Turnstile to activate the captcha gate (§F). Both controls that sat
  here — admin 2FA and bot mitigation — are now **built**; 2FA is enforced, the
  captcha needs its keys.
- 🟡 Managed clustered datastores + gateway/LB/WAF stood up (§D)
- 🟡 Restore drill executed at least once; PITR enabled (§C)

**Explicitly deferred (safe to launch without; do on measured triggers):**
- Postgres authoritative cutover (§E) — run as a shadow + reconcile until proven
- Service extraction / Kafka — seams are dormant (`04-GOVERNANCE.md` §18)
