# Architecture, portability and capabilities

> **This document holds data and history, never rules.** Every rule lives in
> `CLAUDE.md`, which is the single rules file and outranks this document.
> Extracted from the former `CLAUDE.md` on 2026-09-09.

The machine-checked capability source of truth is `platform/capabilities.yaml`
(`npm run verify:capabilities`); the matrix below is its human-readable companion
and its counts are a snapshot — run the verifier for live numbers.

## 17. Portability (hosting / server / database / CDN)

**Goal:** move to any host/DB/CDN with **no code change** — all infra via env vars, never hardcoded.

Portable today (audited): a scan of `backend/**` found **zero** hardcoded platform URLs or container paths.

| Concern | Env var(s) | Swap to |
|---|---|---|
| Database | `DATABASE_URL`, `PG_POOL_SIZE`, `PG_SSL` | RDS, Cloud SQL, Neon, Supabase, Railway, self-hosted — any PostgreSQL 16+ host |
| Cache / lock / rate-limit | `REDIS_URL` | Railway, Elasticache, Upstash, self-hosted, or **none** (in-memory fallback) |
| Object storage | `S3_ENDPOINT/REGION/BUCKET_NAME/ACCESS_KEY/SECRET_KEY` | any S3-compatible (S3, R2, B2, iDrive, Vultr, MinIO) |
| CDN | `CDN_URL` | any CDN in front of the bucket |
| Public URL / CORS | `APP_BASE_URL`, `ALLOWED_ORIGINS` | any domain |
| Email | `SMTP_*` | any SMTP provider |
| Port | `PORT` (default 8080) | whatever the platform assigns |

- **Frontends are origin-agnostic:** call `VITE_API_URL` if set, else same-origin `/api` (single-service deploy needs no frontend URL config).
- **Any container host:** the `Dockerfile` starts `node backend/server.js` — no platform SDK, no `.env` at boot (env injected). Runs on ECS/Fargate, Cloud Run, Azure, DO, Fly, Render, k8s, bare VM.
- **Observability is portable:** structured JSON logs to stdout; any system ingests them.
- **Migrate:** provision PostgreSQL (+ optional Redis + S3 bucket + CDN) → set `.env.example` vars → `docker build`/buildpack → point DNS + set `APP_BASE_URL`/`ALLOWED_ORIGINS`. Railway files (`railway.json`, `nixpacks.toml`, `Procfile`, `Caddyfile`) are optional convenience; the Dockerfile is the neutral path.
- **The former DB-engine limit is closed.** Earlier revisions recorded an honest caveat here: the app was built on a document store with 200+ ODM models and no data-access abstraction, so swapping the engine meant a data-layer rewrite. That rewrite was done. State lives in PostgreSQL behind repository modules in `database/`, so the host is a `DATABASE_URL` swap and no call site knows which host it is talking to.
- **Resolved caveats:** app-asset uploads write to S3 when configured (multi-instance correct); SSE/socket fan-out uses a Redis pub/sub bridge (`startup/realtimeBridge.js`, graceful no-op without Redis).

---

## 18. Hybrid Architecture — modular monolith → selected microservices, for 1M DAU

**Today: a modular monolith.** 26 bounded domains under `backend/domains/`, boundaries CI-enforced by dependency-cruiser. One process, one deploy — the right shape now (most "microservices at 1M DAU" failures split too early).

**Target: hybrid.** Keep the monolith core; extract a *small number* of services only on a **measured trigger** (independent scaling, failure isolation, or a different runtime profile). Method: **strangler-fig, seams-first** — the seams are built and **dormant** until an env var flips them (same pattern as the Postgres money DB and S3 storage).

**Seams built now (dormant):**

| Seam | File | Dormant until |
|---|---|---|
| Service topology (local vs remote resolver) | `backend/gateway/serviceTopology.js` | `SERVICE_<NAME>_URL` set |
| Consistent hashing (ring, ~1/N remap) | `backend/gateway/consistentHash.js` | a service scales horizontally |
| Inter-service auth (short-lived HS256 `iss`/`aud` tokens) | `backend/gateway/serviceAuth.js` | a domain goes remote; `SERVICE_JWT_SECRET` |
| Event backbone (forwards domain events to a log) | `backend/services/eventBackbone.js` + `backbone/kafkaDriver.js` | `KAFKA_BROKERS` set |
| RAG service (first split candidate) | `backend/domains/support/*` | `ANTHROPIC_API_KEY` + embeddings + pgvector |

**API gateway — two meanings, both explicit.** (a) The **application edge** is already in-process (`server.js`: Helmet, CORS, compression, correlation IDs, metrics, tiered rate-limiting, load-shed, OWASP filter, service registry, `/api/v1/` versioned routes) + the new `serviceTopology` resolver. (b) The **infrastructure edge** at 1M DAU is a dedicated **Envoy / Kong / APISIX** in front (TLS, global rate-limit, LB) — **infra-owned**; the app exposes `/health/live`, `/health/ready`, `/metrics`, versioned routes. Protocols: **public REST/JSON stays**; **internal service-to-service = gRPC** once services exist (proto contracts written at extraction, not speculatively).

**Do we need Kafka? — not yet; seam is ready.** The monolith is covered by the in-process `eventBus`, Redis pub/sub (cross-instance realtime), and BullMQ (durable jobs). Kafka earns its cost only at: 2+ independent services needing the same stream · replay · throughput/retention beyond Redis · CQRS/event-sourcing. Turning it on is `KAFKA_BROKERS=...` + the existing driver — no call-site changes.

**Inter-service security.** Inside the monolith the process boundary *is* the trust boundary — do not add service-auth ceremony to in-process calls. When a domain goes remote: app-identity service tokens (built, `serviceAuth.js`) + mTLS (mesh/Envoy, infra) + default-deny network policies (infra) + rotated `SERVICE_JWT_SECRET` (infra).

**One database (PostgreSQL).** Every domain — money, identity, configuration, content, engagement — is stored in PostgreSQL and reached through the repository modules in `database/`. The financial core is what the rest of the schema is held to: integer paise in `BIGINT`, row-level locking around every balance mutation, an append-only double-entry ledger, unique `tx_id` idempotency gates, `*_transitions` audit tables, and `CHECK` constraints that make an impossible row impossible. Read-mostly configuration and CMS documents are JSONB columns, which is the appropriate shape for them and is not a second store. pgvector rides the same PostgreSQL for RAG. Redis stays the cache + lock + rate-limit + queue layer and holds no durable state. **There is deliberately no sync layer, because there is nothing to sync to** — a dual-write, a reverse mirror, a reconciler and a CDC pipeline are all answers to a question this architecture does not ask.

**HA / resilience — app vs infra.** **App (done):** health/readiness/drain, load-shed/bulkhead, backoff+jitter, tiered + per-subnet rate limiting + surge breaker, consistent-hash primitive, Prometheus + Grafana-as-code. **Infra (Bucket C):** reverse proxy w/ dynamic upstreams + geo-routing, multi-region/multi-provider + DNS failover, managed WAF (`owaspFilter` is the app-side complement), IaC, encrypted cross-region backups. The app is HA-*ready* (stateless, Redis-backed shared state); multi-region/WAF/DNS are operational programs the app integrates with.

**Extraction order (on measured triggers):** 1) `support` (RAG) — stateless, zero money risk, the rehearsal; 2) `markets` — CPU-heavy engine + realtime; 3) `payment`/`merchant` — high throughput; 4) `wallet` — **last** (strongest consistency). `identity` stays central.

**Capacity sketch (1M DAU):** ~30–70k concurrent at peak → ~6–20k RPS. A horizontally-scaled stateless monolith + Redis shared state + PostgreSQL read replicas + pooling handles this behind a load balancer **before** any split is mandatory. The first thing to hurt is hot datastore paths, not the web tier — hence the money-DB partitioning framework + pool monitoring. **Scale the monolith horizontally first; extract on measured triggers.**

**Activation env-vars (all off by default):** `DATABASE_URL`+`VOYAGE_API_KEY` (RAG retrieval), `ANTHROPIC_API_KEY` (RAG generation), `KAFKA_BROKERS` (event backbone), `SERVICE_<NAME>_URL` (remote service), `SERVICE_JWT_SECRET` (mesh signing).

---

## 19. Capability Matrix (human-readable; **authoritative source = `platform/capabilities.yaml`**)

`platform/capabilities.yaml` (70 capabilities: id / bucket / owner / status / deps / evidence / verification / docs) is checked on every build by `scripts/verify-capabilities.mjs` so a claimed capability can't rot. **Bucket model:** **A** = build fully now · **B** = built + configurable, activated when infra exists · **C** = infra/ops-owned (app provides integration points) · *decision* = recorded architecture decision.

**Scoreboard (live — `platform/capabilities.yaml`, verified by `npm run verify:capabilities`):** **74 capabilities** — full **48** · partial **10** · architecture-ready **9** · absent **4** · recorded-decision **3**. **Zero capabilities are absent-and-unaccounted-for** — every partial/absent has a recommended upgrade + priority; the high-priority ones are all **owner/infra-gated** (Postgres cutover, PITR), not code gaps. Legend: **full** meets the 2026 enterprise standard · **architecture-ready** built + configurable, dormant until infra exists · **partial** works but has an owner/infra/volume-gated gap · **decision** a recorded architecture choice · **absent** not implemented. (Run the verifier for the exact live counts — this line is a snapshot.)

**FULL (representative evidence):** enterprise-architecture layering, governance framework, DDD boundaries (CI-enforced), centralized config, dependency validation + drift detection, append-only ledger (app + PG trigger), rollback strategy, connection pooling (+ `bb_pg_pool_connections`), Redis cache/locks/queue/rate-limit, central security config, security headers/cookies/CSP/HSTS, authorization matrix, audit logging, Caddy hardening + reverse proxy, central network config, load balancing (k8s HPA), health endpoints, Prometheus histogram metrics, Grafana-as-code, correlation IDs, structured logging + alerting, Docker + k8s readiness, CI/CD (PG18/Redis8, `npm ci`, audit + secret-scan + SBOM + 3 panel builds), blue/green + rolling, DR platform + SRE, cloud-agnostic provider layer, storage/email/SMS abstraction, feature flags, background job platform.

**PARTIAL / ABSENT (all accounted, gated):**
- **Owner/infra-gated (high):** Point-in-Time Recovery (enable WAL archiving on the PostgreSQL host). PostgreSQL-as-source-of-truth and integer-money-at-rest are no longer gated — they are the architecture (2026-09-01).
- **Owner/infra-gated (medium):** read replicas (+ lag gauge), Redis HA (Sentinel/Cluster URL), WAF (front with Cloudflare), DNS failover (wire health-watch to provider), secret rotation automation (vault — pairs with secret-management), backup restore automation.
- **Volume-gated:** partitioning (apply RANGE-by-month with preserved global-uniqueness when millions/month).
- **Recorded decisions:** CDC/Debezium (nothing to capture changes *to* — one store), Redis sessions (JWT+blacklist gives revocation), geo-routing (single region), OpenTelemetry SDK (adopt at 2nd-service trigger; W3C `traceparent` interop already shipped), IaC Terraform (manifests are the reproducibility layer on Railway), Helm / policy-as-code (only under k8s).
- **ABSENT (low/medium, no registry pipeline yet):** artifact signing (Cosign), SLSA provenance, replica-lag monitoring — all add when an image registry / read replica exists.

> **Governance consolidation note:** present-state, completed-work, backlog, and future-capability tracking live in this matrix + `capabilities.yaml`. Do not recreate standalone phase-status / execution-queue / future-capability markdown files unless a separate document is required for an active audit or regulatory handoff.

---
