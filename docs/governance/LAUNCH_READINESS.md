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
| Stateless app tier (all durable state in Mongo/Postgres/Redis/S3) | ✅ | `PORTABILITY.md`; k8s `readOnlyRootFilesystem`, `emptyDir` |
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
- 🟡 **DB host:** swap `MONGODB_URI` / `DATABASE_URL` (same engine). Engine swap (Mongo→SQL) is a rewrite, not config (`PORTABILITY.md`).

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
needed (`HYBRID_ARCHITECTURE.md §11`).

- 🟡 **Managed, clustered datastores:** MongoDB **replica set / sharded** + read replicas (transactions require a replica set); **Redis Cluster**; managed **Postgres**. Single-node dev stores will not carry 1M DAU.
- 🟡 **Edge gateway / L7 load balancer:** Envoy, Kong, or APISIX in front — TLS termination, global rate limiting, LB across instances. App exposes `/health/live`, `/health/ready`, `/metrics`, versioned routes (`HYBRID_ARCHITECTURE.md §3b`).
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
(`HYBRID_ARCHITECTURE.md §6`, `postgres/DATA_ROLLBACK_PLAN.md`):

1. 🟡 Run `npm run reconcile:pg` on a schedule in **staging → production**; require **repeated clean runs** (zero drift) over a real window.
2. 🟡 Flip **reads** to Postgres per money path, one at a time, watching drift metrics.
3. 🟡 Flip **writes/authority** per path; wallet/ledger first, **KYC last**.
4. 🟡 Keep the Mongo→PG rollback ready at each step.

> Do **not** flip authority until reconciliation has been clean in production
> repeatedly. Until then the shadow + reconcile is the correct, safe posture —
> you get Postgres's financial-grade guarantees as a continuous cross-check
> without betting live money on an unproven cutover. (`secureBetPlacement.js` is
> the built reference implementation of the authoritative serializable path,
> intentionally dormant until the cutover.)

---

## F. Compliance & legal — ⛔ hard gate

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
- ⛔ Compliance/licensing + third-party pen-test (§F)
- ⛔ A real load test at target scale (§D)
- 🟡 Managed clustered datastores + gateway/LB/WAF stood up (§D)
- 🟡 Restore drill executed at least once; PITR enabled (§C)

**Explicitly deferred (safe to launch without; do on measured triggers):**
- Postgres authoritative cutover (§E) — run as a shadow + reconcile until proven
- Service extraction / Kafka — seams are dormant (`HYBRID_ARCHITECTURE.md §4, §10`)
