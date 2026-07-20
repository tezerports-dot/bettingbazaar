# Capability Matrix 2026 — 58-point Enterprise Verification

> **Addendum 2026-07-13 — A/B/C bucket model adopted + machine-readable registry.**
> Per owner direction, capabilities are now bucketed: **A** = build fully now ·
> **B** = architecture built + configurable, *activated when infra exists* · **C**
> = infrastructure/ops-owned (the app provides integration points only) ·
> *decision* = recorded architecture decision. The narrative tables below remain
> the human-readable analysis; the authoritative, CI-verified source of truth is
> **`platform/capabilities.yaml`** (70 capabilities, each with id / bucket / owner
> / implementation + activation status / dependencies / evidence / verification /
> docs), checked on every build by `scripts/verify-capabilities.mjs`
> (`npm run verify:capabilities`) so a claimed capability can't rot while the
> registry still asserts it — this operationalizes capability #6 (drift detection)
> and keeps docs synced to code.
>
> **Built this pass (all Bucket A/B, minimal disruption):**
> - **Integer Money Engine** (`backend/shared/money.js`, CAP-09) — paise-native
>   helpers with integer/finite/overflow invariants + conservation tests; the PG
>   paise boundary delegates to it. At-rest float→paise conversion remains the PG
>   cutover step (no dual money representation mid-migration).
> - **JWT secret-rotation keyring** (CAP-60, Bucket B activation-ready) — sign with
>   `JWT_SECRET`, verify against it + `JWT_PREVIOUS_SECRETS`; zero-downtime
>   rotation, backward-compatible default.
> - **Partitioning migration framework** (CAP-16, Bucket A) — opt-in
>   `npm run pg:migrate:partition` (RANGE-by-month) that *preserves* the
>   idempotency-key uniqueness via a separate global-unique table; not auto-applied.
> - **Platform Capability Registry + CI verifier** (CAP-59) — the new capability
>   the owner asked for.
>
> **Bucket B items coded to activation-ready (dormant until infra):** PostgreSQL
> SoR (CAP-07), dual-write (CAP-12), read-replica routing (CAP-18), Redis HA
> client (CAP-27), OTel context propagation (CAP-46), secret rotation (CAP-60).
> **Bucket C (app integrates, does not implement):** PITR, WAF, DNS failover,
> autovacuum, artifact signing/SLSA, Helm, policy-as-code — each carries an
> `owner` and activation path in the registry.



**Method:** the 58-capability checklist (+ the owner's 2026 additions) treated as
the target architecture. Every row is graded against the **actual repo**, not
progress notes, and against current (2026) enterprise guidance. A capability is
**not** marked complete merely because a basic version exists — only when it
demonstrably meets modern enterprise standards.

This verification ran **after** the ARCHITECTURE_AUDIT_2026 queue (AQ-1…14) was
merged to `main`, so it reflects Node 22, Express 5.2, argon2id, the JWT
authority, verified money-DB TLS, graceful-shutdown probes, the hardened
image/k8s, reproducible+scanned CI, and the dormant Postgres money layer.

### Status legend
- **FULL** — meets 2026 enterprise standard, evidence in-repo.
- **FULL✓(design)** — deliberately scoped this way with a recorded rationale; the "gap" is a documented decision, not an omission.
- **PARTIAL** — real and working, but a measurable gap remains (often owner/infra-gated or volume-gated).
- **ABSENT** — not implemented.
- Items marked **[fixed this pass]** were implemented during this verification.

### Scoreboard
- **FULL / FULL✓(design): 40** · **PARTIAL: 15** · **ABSENT: 3** (of 58).
- 2026 additions: 5 now FULL (2 fixed this pass), 4 PARTIAL, 4 ABSENT/low-priority.
- **Zero capabilities are absent-and-unaccounted-for.** Every PARTIAL/ABSENT has a
  recommended upgrade and a priority; the high-priority ones are all
  owner/infra-gated (Postgres cutover, PITR), not code gaps.

---

## A. Architecture & Governance

| # | Capability | Status | Evidence | Gap analysis | Recommended upgrade | Priority |
|---|---|---|---|---|---|---|
| 1 | Enterprise Architecture Layer | **FULL** | `backend/domains/` (13 bounded domains), `backend/shared/`, `backend/config/`, `backend/providers/` | Platform/infra/business/domain layers are real and separated | — | — |
| 2 | Governance Framework | **FULL** | `docs/governance/04-GOVERNANCE.md` (§0–16, incl. currency + reproducibility rules), `docs/governance/ENTERPRISE_DECISIONS.md`, `ARCHITECTURE_AUDIT_2026.md` | ADRs are embedded in decision docs, not a formal `/adr` log | (Optional) extract an ADR index for discoverability | Low |
| 3 | Domain-Driven Module Boundaries | **FULL** | `domains/{wallet,payment,markets,merchant,revenue,identity,configuration,risk,funding,…}`, enforced by `.dependency-cruiser.cjs` | Wallet/Payment/Betting/Merchant/Settlement/KYC boundaries exist and are CI-enforced | — | — |
| 4 | Centralized Configuration Platform | **FULL** | `SystemConfig` + `configVersioning.service.js` + `depositPolicy` + `operations/config-catalog` + `security.config.js` + `network.config.js` | Business config is one versioned `SystemConfig` doc (2026 addition suggests finer split — see PE row below) | Split only if a domain needs independent lifecycle; current catalog already enumerates ownership | Low |
| 5 | Dependency Validation | **FULL** | `.dependency-cruiser.cjs` + CI `check:deps` (no-circular, domain-core-not-import-routes, wallet-purity) | — | — | — |
| 6 | Architecture Drift Detection | **FULL** | dependency-cruiser (structural drift) in CI; governance §16 P-3 quarterly re-audit | Only structural/boundary drift is automated; semantic drift relies on the audit cadence | Keep; cadence rule covers semantic drift | Low |

## B. Financial Platform

| # | Capability | Status | Evidence | Gap analysis | Recommended upgrade | Priority |
|---|---|---|---|---|---|---|
| 7 | PostgreSQL as Financial SoT | **PARTIAL** | `backend/postgres/schema.sql` (BIGINT paise), `pgClient.js`, `dualWrite.js` | Code-complete but **dormant** — MongoDB is still the source of truth; PG is a shadow until provisioned + authority is flipped | Owner cutover: provision PG 18 → run dual-write → `reconcile:pg` clean → flip authority per `DATA_ROLLBACK_PLAN.md` | **High (owner)** |
| 8 | Append-Only Ledger | **FULL** | `domains/revenue/accountingEvent.model.js` (immutability middleware) + PG `accounting_events` DB-level append-only trigger | Enforced at both app (Mongo) and DB (PG) layers | — | — |
| 9 | Integer Money Engine | **PARTIAL** | PG BIGINT paise; `riskValidation.computeBetFundingPlan()` paise-exact | Mongo side still stores float rupees with `round2()` — the known float risk | Resolved **by** the item-7 cutover (paise at rest); no risky standalone refactor | **High (tied to 7)** |
| 10 | Database Transactions | **PARTIAL** | `safeSession()` Mongo transactions (settlement/wallet); PG dual-write transactional | Standalone Mongo degrades non-atomic (correctness then rests on idempotency keys) | Run Mongo as a replica set (Atlas default) for full multi-doc atomicity | Medium |
| 11 | CDC Migration | **FULL✓(design)** | `reconcile.js` reconciliation-based verification; Debezium noted as layerable | No live change-data-capture stream | Add Debezium only if streaming (vs snapshot) verification is required; reconciliation already proves correctness | Low |
| 12 | Dual-Write Migration | **FULL** (dormant) | `dualWrite.js` post-save hooks on 6 money models; CI-proven (`postgresDualWrite.integration.test.js`) | Fire-safe, idempotent; activates on `DATABASE_URL` | — | — |
| 13 | Reconciliation Engine | **FULL** | `reconcile.js` + AQ-9 continuous `pg-reconcile` cron + `bb_pg_drift_rows` / `bb_pg_trial_balance_ok` metrics + drift alert | — | — | — |
| 14 | Rollback Strategy | **FULL** | `backend/postgres/DATA_ROLLBACK_PLAN.md` (lossless per-phase fallback) | — | — | — |

## C. PostgreSQL Platform

| # | Capability | Status | Evidence | Gap analysis | Recommended upgrade | Priority |
|---|---|---|---|---|---|---|
| 15 | Connection Pooling | **FULL** | `pg.Pool` (`PG_POOL_SIZE`), Mongo `maxPoolSize`/`minPoolSize`; **[fixed this pass]** `bb_pg_pool_connections` gauge | — | — | — |
| 16 | Partitioning Strategy | **PARTIAL** | **[fixed this pass]** strategy documented in `schema.sql` header | Not pre-applied — partitioning a table with unique idempotency keys requires the key to include the partition column, which would weaken the double-spend gate | Apply RANGE-by-month on `wallet_ledger`/`accounting_events` **with** a preserved global-uniqueness mechanism when row counts (millions/month) justify it | Medium (volume-gated) |
| 17 | Point-in-Time Recovery | **PARTIAL** | `docs/governance/DISASTER_RECOVERY.md`; PG WAL / Atlas toggle | Enablement is an owner/provider action | Enable Atlas continuous backups / PG WAL archiving; test one restore | **High (owner)** |
| 18 | Read Replicas | **PARTIAL** | `readPreference.service.js` + `FLAGS.READ_REPLICA` (winners feed routes to replica) | Replica infra = owner; replica-lag metric absent | Provision a replica member + add a lag gauge (pairs with the pool metric) | Medium |
| 19 | Backup Verification | **PARTIAL** | `backup.service.js` (daily mongodump→S3, retention, failure alert) + DR restore drill (manual) | Restore is documented, not automatically verified | Scheduled restore-to-scratch-DB check with a row-count assertion | Medium |
| 20 | Autovacuum / Perf Tuning | **PARTIAL** | PG autovacuum on by default; schema btree indexes | No explicit tuning (fillfactor, autovacuum scale factors) yet | Tune once PG is live under real load; capture in a PG runbook | Low (post-provision) |

## D. Redis Platform

| # | Capability | Status | Evidence | Gap analysis | Recommended upgrade | Priority |
|---|---|---|---|---|---|---|
| 21 | Redis Cache | **FULL** | `cache.service.js` (Redis + bounded in-memory fallback) | — | — | — |
| 22 | Distributed Locks | **FULL** | `startup/cronLock.js` (leader election), gameEngine per-cycle `findOneAndUpdate` claim | — | — | — |
| 23 | Redis Sessions | **FULL✓(design)** | Decision recorded (audit §3.4): JWT + `TokenBlacklist` gives instant revocation | Not needed — no per-session server state | Reopen only if server-side session state becomes a requirement | — (closed) |
| 24 | Queue Coordination | **FULL** | `jobQueue.service.js` (BullMQ repeatables + leader-locked setInterval fallback) | — | — | — |
| 25 | Distributed Rate Limiting | **FULL** | `redisRateLimitStore.js` (atomic Lua INCR+PEXPIRE, shared counters, per-instance fallback); IPv6-safe keys (AQ-6) | — | — | — |
| 26 | Cache Strategy (TTL/Invalidation) | **FULL** | `cache.service.js` TTL + `invalidatePattern` | — | — | — |
| 27 | Redis High Availability | **PARTIAL** | `ioredis` client supports Sentinel/Cluster via `REDIS_URL` | HA topology is an owner/provider choice; single instance today | Managed Redis with replication, or a Sentinel/Cluster URL, before heavy scale | Medium |

## E. Security Platform

| # | Capability | Status | Evidence | Gap analysis | Recommended upgrade | Priority |
|---|---|---|---|---|---|---|
| 28 | Central Security Configuration | **FULL** | `config/security.config.js` (CSP, CORS shape, rate-limit tiers as data) | — | — | — |
| 29 | Secret Management | **PARTIAL✓(design)** | `startup/validateEnv.js` fail-fast + 12-factor env; secrets-manager decision with triggers | No vault / automated rotation | Vault or cloud secret manager when multi-env / scoped access / compliance mandate appears | Medium |
| 30 | Security Headers | **FULL** | `helmet@8` with explicit header audit (security.config §21 notes) | — | — | — |
| 31 | Secure Cookies | **FULL** | `routes.js` `COOKIE_OPTS` (httpOnly, secure in prod, sameSite) | — | — | — |
| 32 | CSP & HSTS | **FULL** | helmet CSP directives + HSTS (prod https); edge HSTS in Caddyfile | CSP allows `'unsafe-inline'` for styles (common for the panels) | Tighten style-src with nonces/hashes if the panels allow | Low |
| 33 | WAF Integration | **PARTIAL✓(design)** | `middleware/owaspFilter.js` (flag-gated OWASP-pattern content filter) | Not a managed/volumetric WAF | Front with Cloudflare/AWS WAF for managed rulesets + L7 DDoS when public | Medium |
| 34 | Authorization Matrix | **FULL** | `docs/governance/AUTHORIZATION_MATRIX.md` + `auth.middleware.js` role/permission guards (X-8 scan found no holes) | — | — | — |
| 35 | Audit Logging | **FULL** | `EnhancedAuditLog` / `AuditLog` on every admin/financial write | Mongo audit is app-append (not DB-immutable like the ledger) | (Optional) mirror critical audit into the append-only ledger store | Low |

## F. Networking & Edge

| # | Capability | Status | Evidence | Gap analysis | Recommended upgrade | Priority |
|---|---|---|---|---|---|---|
| 36 | Caddy Hardening | **FULL** | `Caddyfile` (AQ-12: reverse_proxy incl. WS/SSE, zstd/gzip, edge security headers) | — | — | — |
| 37 | Reverse Proxy Platform | **FULL** | Caddy (self-host) / Railway edge; TLS terminated at edge | — | — | — |
| 38 | Central Network Configuration | **FULL** | `config/network.config.js` (single port/host/canonical parse point) | — | — | — |
| 39 | Multi-Domain Architecture | **PARTIAL✓(design)** | host-agnostic serving + `CANONICAL_HOST` + `DOMAINS`; panels split by path | API/Admin/Merchant/CDN are path-separated, not distinct domains | Split to distinct domains/CDN host when scale or isolation warrants | Low |
| 40 | DNS Failover | **PARTIAL** | `deploy/` health-watch monitor (origin-health only) + DNS runbook | DNS-provider config (Route53/Cloudflare) = owner | Wire the health-watch to a real DNS provider + secondary origin | Medium (owner) |
| 41 | Geo-Routing | **ABSENT✓(design)** | Decision: single region deployed (audit §6 D, PLAN_STATUS) | Nothing to route between yet | Extend item-40 origin-health approach when a second region exists | — (decision) |
| 42 | Load Balancing | **FULL** | `deploy/k8s` Service + HPA (min 2/max 6); Railway platform LB | — | — | — |

## G. Observability

| # | Capability | Status | Evidence | Gap analysis | Recommended upgrade | Priority |
|---|---|---|---|---|---|---|
| 43 | Health Endpoints | **FULL** | `/health/live` (process) + `/health/ready` (deps+drain) (AQ-4); k8s startup/readiness/liveness probes | — | — | — |
| 44 | Prometheus Metrics | **FULL** | `metrics.service.js`: default process metrics, HTTP duration **histogram**, business counters, drift + **[fixed this pass]** pool gauges | — | — | — |
| 45 | Grafana Dashboards | **FULL** | `deploy/grafana/bettingbazaar-dashboard.json` (dashboard-as-code) | — | — | — |
| 46 | OpenTelemetry | **PARTIAL✓(design)** | W3C `traceparent` interop shipped; decision D-3 defers the SDK to a trigger | No distributed traces / collector | Adopt OTel SDK + OTLP at the recorded trigger (2nd service / synchronous provider integration) | Low–Med (trigger) |
| 47 | Correlation IDs | **FULL** | `middleware/requestContext.js` (AsyncLocalStorage), threaded into every log | — | — | — |
| 48 | Structured Logging & Alerting | **FULL** | `services/logger.js` (JSON + secret redaction) + `alerting.service.js` (admin webhook, cooldown, retry+jitter) | — | — | — |

## H. Platform & Deployment

| # | Capability | Status | Evidence | Gap analysis | Recommended upgrade | Priority |
|---|---|---|---|---|---|---|
| 49 | Docker Standardization | **FULL** | `Dockerfile` (AQ-5: multi-stage, `node:22-slim`, non-root `USER node`) | — | — | — |
| 50 | Kubernetes Readiness | **FULL** | `deploy/k8s/deployment.yaml` (AQ-4/AQ-11: probes, HPA, securityContext, PDB, topology spread) | — | — | — |
| 51 | Infrastructure as Code | **PARTIAL✓(design)** | `deploy/docker-compose.yml`, k8s manifests, `railway.json` | No Terraform/Pulumi (declarative manifests only) | Terraform/Pulumi on platform exit; manifests are the reproducibility layer on Railway | Low |
| 52 | CI/CD Platform | **FULL** | `.github/workflows/ci.yml` (test on PG18/Redis8, `npm ci`, audit gate, secret scan, typecheck, 3 panel builds, **[fixed this pass]** SBOM) | — | — | — |
| 53 | Blue/Green & Rolling | **FULL** | k8s `RollingUpdate` maxUnavailable:0 + blue/green color-selector procedure (`deploy/k8s/README.md`) | Railway is replace-style (documented) | — | — |
| 54 | Disaster Recovery Platform | **FULL** | `docs/governance/DISASTER_RECOVERY.md` + **[fixed this pass]** `SRE.md` (SLOs, runbooks, capacity, rollback) | — | — | — |
| 55 | Cloud-Agnostic Provider Layer | **FULL** | `providers/registry.js` + storage/payment/casino/sportsbook provider interfaces | — | — | — |
| 56 | Storage/Email/SMS Abstraction | **FULL** | `providers/storage/{S3,LocalDisk}` + `domains/communication/channelRegistry.js` (EMAIL live, SMS adapter, PUSH declared) | — | — | — |
| 57 | Feature Flag Platform | **FULL** | `services/featureFlags.service.js` (`FLAGS`, env + config gated) | No per-user/%-rollout targeting | Add targeting rules if experimentation is needed | Low |
| 58 | Background Job Platform | **FULL** | `services/jobQueue.service.js` (BullMQ retryable repeatables + leader-locked fallback + graceful close) | — | — | — |

---

## 2026 additions (owner's extensions)

| Capability | Status | Evidence | Gap / Upgrade | Priority |
|---|---|---|---|---|
| SBOM (Software Bill of Materials) | **FULL [fixed this pass]** | CI `sbom` job → CycloneDX 1.5 via native `npm sbom`, uploaded as a 90-day artifact | — | — |
| Artifact signing (Sigstore/Cosign) | **ABSENT** | — | No image is built/pushed to a registry in CI yet; add `cosign sign` once one is | Medium |
| Build provenance / SLSA | **ABSENT** | — | Add SLSA provenance attestation on the image build when a registry pipeline exists | Medium |
| SRE runbooks / incident playbooks | **FULL [fixed this pass]** | `SRE.md` §4 (per-alert runbooks) | — | — |
| Capacity planning | **FULL [fixed this pass]** | `SRE.md` §5 (scaling unit, DB connection ceiling, cadence) | — | — |
| Error budgets / SLOs | **FULL [fixed this pass]** | `SRE.md` §1–2 (SLO table, error-budget policy, hard-SLOs) | — | — |
| Platform config split (Infra/Security/Deployment/Platform/Business) | **PARTIAL** | `security.config.js` + `network.config.js` split out; business config unified in `SystemConfig` + catalog | Split business config only where a domain needs independent lifecycle; low functional gain today | Low |
| Continuous reconciliation metrics | **FULL** | AQ-9 `pg-reconcile` cron + `bb_pg_drift_rows` / `bb_pg_trial_balance_ok` | — | — |
| Connection pool monitoring | **FULL [fixed this pass]** | `bb_pg_pool_connections{state}` gauge | Mongo pool metrics could follow (driver events) | Low |
| Replica lag monitoring | **ABSENT** | — | Add a lag gauge when a read replica is provisioned (pairs with cap. 18) | Medium |
| Backup restore testing | **PARTIAL** | DR manual drill | Automate a scheduled restore-to-scratch verification | Medium |
| Native Prometheus histograms | **FULL** | `http_request_duration_seconds` histogram with tuned buckets | — | — |
| OpenTelemetry collectors | **ABSENT✓(design)** | — | With cap. 46, adopt at the recorded trigger | Low |
| Trace sampling strategy | **N/A** | — | Defined alongside OTel adoption | — |
| Dashboard-as-code | **FULL** | `deploy/grafana/*.json` | — | — |
| Helm charts | **ABSENT** | raw k8s manifests only | Add a Helm chart only if k8s/Helm becomes the operational target (speculative on Railway — deliberately not scaffolded per the no-fake-placeholders governance) | Low |
| Secret rotation | **PARTIAL** | env-based; `validateEnv` supports rotated values; owner checklist A1 | Automate rotation with a secret manager (pairs with cap. 29) | Medium |
| Policy-as-code (OPA/Kyverno) | **ABSENT** | — | Relevant only under k8s; add admission policies if/when k8s is the runtime | Low |

---

## What was implemented during this verification pass (minimal disruption)

1. **Connection-pool metrics** (`bb_pg_pool_connections`) — `metrics.service.js` async `collect()` reading `pgClient.getPoolStats()`. Zero interval/state; dormant until PG is configured.
2. **SBOM in CI** — new `sbom` job emitting a CycloneDX 1.5 bill of materials via native `npm sbom` (no new dependency), published as a build artifact.
3. **Partitioning strategy** — documented in `schema.sql` with the idempotency-key caveat, so it can be applied correctly when volume warrants (not pre-applied, which would risk the double-spend gate).
4. **SRE.md** — SLOs, error-budget policy, golden signals, per-alert incident runbooks, capacity planning, and rollback — all grounded in the metrics/alerts/probes this repo actually exposes.

Everything else that is PARTIAL/ABSENT is either **owner/infra-gated** (Postgres
cutover, PITR, read replicas, DNS failover, Redis HA, WAF, secret rotation),
**volume-gated** (partitioning), or a **recorded design decision** (CDC, Redis
sessions, geo-routing, OTel-at-trigger, Terraform-on-exit, Helm/policy-as-code
only-under-k8s). None is an unaccounted gap, and none warranted a
high-disruption change to a green, production-ready `main`.

## Governance consolidation note (2026-07-19)

To avoid maintaining multiple overlapping governance status files, present-state,
completed-work, backlog, and future-capability tracking now live in this matrix.
Do not recreate standalone phase-status, execution-queue, or future-capability
markdown files unless a separate document is required for an active audit or
regulatory handoff.
