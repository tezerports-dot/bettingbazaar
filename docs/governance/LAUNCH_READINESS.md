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
| Stateless app tier (all durable state in Mongo/Postgres/Redis/S3) | ✅ | `04-GOVERNANCE.md` §17; k8s `readOnlyRootFilesystem`, `emptyDir` |
| Multi-instance realtime (SSE/WebSocket fan-out via Redis) | ✅ | `startup/realtimeBridge.js` |
| Tiered + per-subnet rate limiting, surge breaker, load-shed/bulkhead | ✅ | `middleware/security.js`, `ipDefense.js`, `loadShed.js` |
| Idempotent, crash-resume settlement (no money lost mid-payout) | ✅ | `payoutRecoveryTask`; DR §1 |
| Money as integer paise + append-only, DB-enforced double-entry ledger | ✅ | `postgres/schema.sql` (balance/append-only triggers) |
| PASETO Ed25519 auth (no alg-swap/`none`), instant revocation | ✅ | `domains/identity/paseto.util.js` |
| Health/readiness/liveness + graceful drain; Prometheus + Grafana-as-code | ✅ | `server.js`, `deploy/grafana/` |
| CI: unit + integration (Mongo/Redis/Postgres), typecheck/builds, audit, sbom, secret-scan | ✅ | `.github/workflows/ci.yml` |

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
- 🟡 **DB host:** swap `MONGODB_URI` / `DATABASE_URL` (same engine). Engine swap (Mongo→SQL) is a rewrite, not config (`04-GOVERNANCE.md` §17).

---

## C. Data safety / disaster recovery

| Item | Status | Action |
|---|---|---|
| Daily `mongodump` → S3, 14 retained, failure paged | ✅ | `services/backup.service.js` |
| **Restore drill** ("an untested backup is not a backup") | 🟡 | Run once on staging now, then quarterly — DR §2 |
| Mongo PITR (oplog, to-the-minute) | 🟡 | Enable Atlas Continuous Backup — DR §3 |
| Postgres WAL archiving (PITR for money) | 🟡 | Enable on the managed Postgres — DR §3 |
| RPO/RTO targets (≤24h→minutes / ≤1h app, ≤4h DB) | ✅ documented | Validate in the drill — DR header |

---

## D. Infrastructure to stand up for 1M DAU — 🟡 (app exposes the hooks; you run the infra)

The app is a horizontally-scalable stateless monolith with dormant
microservice seams. Capacity sketch: 1M DAU ≈ 30–70k concurrent ≈ 6–20k RPS,
handled by the scaled monolith behind an LB **before** any service split is
needed (`04-GOVERNANCE.md` §18).

- 🟡 **Managed, clustered datastores:** MongoDB **replica set / sharded** + read replicas (transactions require a replica set); **Redis Cluster**; managed **Postgres**. Single-node dev stores will not carry 1M DAU.
- 🟡 **Edge gateway / L7 load balancer:** Envoy, Kong, or APISIX in front — TLS termination, global rate limiting, LB across instances. App exposes `/health/live`, `/health/ready`, `/metrics`, versioned routes (`04-GOVERNANCE.md` §18).
- 🟡 **WAF** (Cloudflare) — `middleware/owaspFilter.js` is the app-side complement, not a replacement.
- 🟡 **Autoscaling / HA:** apply `deploy/k8s/deployment.yaml` (api/realtime/scheduler roles, HPA, PDB, topology spread) or equivalent.
- 🟡 **Multi-region + DNS health-checked failover** (`DISASTER_RECOVERY.md §4`).
- ⛔ **Load test.** The RPS numbers above are a *sizing sketch, not a benchmark*. Run a real load test against staging before launch and size pools/replicas from the result. This is the single biggest unknown.

---

## E. Postgres money cutover — 🟡 deliberately NOT done (gated)

**State today:** Postgres is a **fully-wired, verified _shadow_.** Every
money mutation dual-writes to it (`postgres/dualWrite.js`, hooked on all seven
money collections) and a reconcile job detects/repairs drift
(`postgres/reconcile.js`). **MongoDB is still authoritative** for reads and
writes — by design.

Making Postgres authoritative is an **owner-gated production cutover**, not a
code flip, because it moves the source of truth for money. The sequence
(`04-GOVERNANCE.md` §18, `postgres/DATA_ROLLBACK_PLAN.md`):

0. ✅ **The cutover machinery is built (2026-07-28), dormant.** Three
   prerequisites that did not exist in code now do: a per-path authority switch
   (`postgres/moneyAuthority.js` — one env var per path, defaults to Mongo,
   refuses an out-of-order cutover at boot), the reverse mirror the rollback
   plan's zero-RPO guarantee depends on (`postgres/reverseMirror.js`), and a
   two-sided reconcile with a per-account Mongo-vs-PG ledger comparison. The
   authoritative wallet path itself (`postgres/walletPg.js`) is written and
   proven against a real Postgres — row locking, the negative-balance guard and
   the unique-`tx_id` idempotency gate hold under concurrency (`npm run test:pg`).
   **No path is flipped**; every one still resolves to MongoDB.
0b. ✅ **The wallet path is genuinely routed (2026-07-28), still dormant.**
   Every operation `walletAuthority.service.js` exposes now has a Postgres
   implementation behind the switch (`postgres/walletPgAuthority.js`), keyed by
   byte-identical txIds so a rollback's Mongo idempotency gate still recognises
   movements Postgres made. Bet placement, which mutated balances with a raw
   `$inc` inside `domains/markets/bet.routes.js`, was moved behind
   `lockBetStake`/`unlockBetStake` — until that happened, balances had a second
   writer the switch could not reach and a flip would have split the source of
   truth mid-bet. 46 tests cover both layers against a real Postgres.
   **Two things remain before the wallet path is flippable:**
   - **Run `npm run pg:seed-locks` immediately before the flip**, while Mongo is
     still authoritative. `lockedDepositAmount`/`lockedWinningsAmount` are never
     a ledger row's field, so the forward mirror cannot carry them and the new
     `wallets.locked_*_paise` columns would be 0 at cutover — the first
     settlement to release a stake would unwind a split Postgres never learned.
     (`-- --check` reports drift without writing.)
   - **Balance READS are still Mongo property access** (~211 sites). They read
     the copy the reverse mirror keeps current — stale by at most a reconcile
     pass rather than wrong — but they are not authoritative.
     `walletAuthority.getBalances()` is the routed read; call sites move to it
     incrementally, and any NEW balance read must use it.
1. ✅ **Reconciliation is already scheduled** — the `pg-reconcile` cron
   (`startup/cronJobs.js`) runs every 5 min once `DATABASE_URL` is set,
   leader-locked, detection-only. It exports drift as metrics and pages
   `sendAlert('pg-drift', …)`. Watch the **cutover gate** on the Grafana
   dashboard: `bb_pg_reconcile_consecutive_clean` must climb and **stay green
   (≥ 24h of clean 5-min passes)** — any drift or crashed run resets it to 0.
   `bb_pg_drift_rows` must be 0 and `bb_pg_trial_balance_ok` must be 1. (Ad-hoc:
   `npm run reconcile:pg -- --all` for a full-history check.) Once any path is
   PG-authoritative the job also checks the REVERSE direction —
   `bb_mongo_drift_rows` (rows in Postgres missing from Mongo, the writes a
   fallback would lose) and `bb_ledgers_agree` (both ledgers match account by
   account). Without those two the gate would keep climbing while Mongo
   silently fell behind. `bb_money_authority_postgres{path=...}` shows which
   paths have moved.
2. 🟡 Once the gate has been green over a sustained window, flip **reads** to Postgres per money path, one at a time, watching the same metrics.
3. 🟡 Flip **writes/authority** per path; wallet/ledger first, **KYC last**.
4. 🟡 Keep the Mongo→PG rollback ready at each step.

> Do **not** flip authority until reconciliation has been clean in production
> repeatedly. Until then the shadow + reconcile is the correct, safe posture —
> you get Postgres's financial-grade guarantees as a continuous cross-check
> without betting live money on an unproven cutover. (`secureBetPlacement.js` is
> the built reference implementation of the authoritative serializable path,
> intentionally dormant until the cutover.)

---

## F. Account-security controls — 🟡 one of two is now built

| Control | State | Evidence |
|---|---|---|
| Two-factor authentication | ✅ **built and enforced** | TOTP, **mandatory** for admins and sub-admins, optional for players, available for merchants. Two-step enrolment (`POST /api/2fa/setup` mints a *pending* secret; only `POST /api/2fa/activate` with a valid code makes it live), one-time recovery codes stored as hashes, secrets AES-256-GCM encrypted at rest under `TOTP_ENCRYPTION_KEY`. Login issues a short-lived challenge instead of a session until the code is redeemed (`routes.js` `loginHandler` → `loginTwoFactorHandler`). Enrolment + OTP UI in all three panels. Files: `domains/identity/{totp.service,twoFactor.routes,twoFactorChallenge,verifySecondFactor}.js`. Own rate-limit tier — `RATE_LIMITS.md`. |
| CAPTCHA / bot-mitigation challenge | ⛔ **not implemented** | No captcha, Turnstile, reCAPTCHA or hCaptcha integration anywhere. Automated-abuse defence today is rate limiting only (`middleware/security.js`, `ipDefense.js`). |

**History, kept deliberately.** Until 2026-07-27 the repository claimed both
controls while neither existed; the claims were removed and recorded here as a
gap. 2FA was then built (2026-07-28/29) — but this section was not updated with
it, so for a period the docs understated the platform. Both directions of drift
are the same defect: **a control documented as missing invites someone to build a
second one and collide with the real implementation, exactly as a control
documented as present stops anyone asking for it.** Verify before documenting,
in either direction.

**Remaining owner decision:** CAPTCHA. Rate limiting alone does not stop a
distributed, low-and-slow credential-stuffing run against the login form. Either
integrate a challenge (Cloudflare Turnstile is the lightest fit — no visible
puzzle in the common case) or record an explicit acceptance here.

**`TOTP_ENCRYPTION_KEY` has no rotation path.** It has no `_PREVIOUS_`
counterpart: rotating it makes every stored secret undecryptable and forces every
enrolled user — including every admin — to re-enrol, with nobody able to sign in
meanwhile. Back it up with the same care as the Android signing keystore.

---

## G. Compliance & legal — ⛔ hard gate

- ⛔ Gambling/gaming **licence** for each jurisdiction served.
- ⛔ **AML/KYC** program appropriate to that licence.
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
- ⛔ Compliance/licensing + third-party pen-test (§G)
- ⛔ A real load test at target scale (§D)
- 🟡 Decide on CAPTCHA / bot mitigation — not implemented (§F). Admin 2FA, which
  previously sat here, is **built and enforced**.
- 🟡 Managed clustered datastores + gateway/LB/WAF stood up (§D)
- 🟡 Restore drill executed at least once; PITR enabled (§C)

**Explicitly deferred (safe to launch without; do on measured triggers):**
- Postgres authoritative cutover (§E) — run as a shadow + reconcile until proven
- Service extraction / Kafka — seams are dormant (`04-GOVERNANCE.md` §18)
