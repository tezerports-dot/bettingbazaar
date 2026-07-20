# Hybrid Architecture — monolith → microservices, for 1M DAU

**Status:** design + seams landed (Bucket B, dormant). 2026-07-14.
**Why:** the owner expects **≥1 million daily active users** and wants a **hybrid
monolith + microservices** platform. This document is the plan and the record of
what has actually been built to make that transition cheap — plus honest answers
to "do we need Kafka?" and "what about inter-service security?".

It also folds in the reference roadmap the owner shared (hybrid DB, HA layers,
gRPC-internal/REST-public, consistent hashing) — adapted to *this* codebase and
to 2026 practice, keeping the platform's rules: **no dead code, no fake
placeholders, env-gated activation.**

---

## 1. Where we are, where we're going

**Today: a modular monolith.** 13+ bounded domains under `backend/domains/`,
boundaries enforced in CI by dependency-cruiser. One process, one deploy. This is
the right shape now — most "microservices at 1M DAU" failures are teams that
split too early and bought network partitions, distributed transactions, and 10×
the ops for problems they didn't have yet.

**Target: hybrid.** Keep the monolith as the core, and extract a *small number*
of services where there is a real, measured reason: independent scaling,
independent failure isolation, or a different runtime profile. Everything else
stays in-process.

**Method: strangler-fig, seams-first.** We do not rewrite. We put the *seams* in
now (this PR), so extracting a service later is a config change, not a
re-architecture. The seams are all **dormant** until an env var flips them —
identical to how the Postgres money DB and S3 storage already work here.

---

## 2. What has been built now (the seams)

| Seam | File(s) | What it does | Dormant until |
|---|---|---|---|
| **Service topology** | `backend/gateway/serviceTopology.js` | Single resolver for "is domain X local (in-process) or remote (a service)?" | `SERVICE_<NAME>_URL` set |
| **Consistent hashing** | `backend/gateway/consistentHash.js` | Ring w/ virtual nodes; ~1/N remap on instance churn — routing/sharding primitive | used when a service scales horizontally |
| **Inter-service auth** | `backend/gateway/serviceAuth.js` | Short-lived, HS256-pinned, `iss`/`aud`-scoped service tokens + `requireServiceAuth` guard | a domain goes remote; `SERVICE_JWT_SECRET` |
| **Event backbone** | `backend/services/eventBackbone.js` + `backbone/kafkaDriver.js` | Forwards every domain event to an external log (Kafka) — a no-op driverless seam wired into the existing bus | `KAFKA_BROKERS` set |
| **RAG service (first split candidate)** | `backend/domains/support/*` | Stateless, external-API-bound support assistant — the easiest domain to extract first | `ANTHROPIC_API_KEY` + embeddings + pgvector |

All five are covered by unit tests and change **nothing** at runtime until
configured. The monolith still boots and behaves exactly as before.

---

## 3. API Gateway — "as hybrid"

There are two different things people call an "API gateway". We are explicit
about both:

### 3a. The application edge (in-process) — already here, extended
`backend/server.js` already is an application-level gateway: Helmet, CORS,
compression, correlation IDs, Prometheus metrics, tiered rate-limiting
(`middleware/security.js`, `middleware/ipDefense.js`), bulkhead/load-shedding
(`middleware/loadShed.js`), an OWASP request filter (`middleware/owaspFilter.js`),
and a named service registry (`services/serviceRegistry.js`). Versioned routes
(`/api/v1/...`) are already the convention.

The **new** piece is `serviceTopology.js`: the edge can now ask "should this call
run in-process or proxy to a remote service?" Today the answer is always "local".
When we extract, say, `support`, we set `SERVICE_SUPPORT_URL=https://support.internal`
and the edge proxies there instead — **without touching call sites**.

### 3b. The infrastructure edge (out-of-process) — Bucket C
At 1M DAU the public edge should sit behind a dedicated gateway/proxy —
**Envoy, Kong, or APISIX** (2026: all three are solid; APISIX and Envoy are the
lightest to run) — terminating TLS, doing global rate limiting, and load
balancing across monolith and service instances. That is **infra-owned (Bucket
C)**; the app already exposes everything it needs (`/health/live`,
`/health/ready`, `/metrics`, versioned routes). We do **not** vendor a gateway
into the app repo.

### 3c. Protocols: gRPC internal, REST public
- **Public API stays REST/JSON** (what the web/mobile panels already speak). No
  churn for clients.
- **Internal service-to-service calls use gRPC** once services exist: typed
  contracts (protobuf), HTTP/2 multiplexing, ~half the latency and payload of
  JSON at high fan-out. The seam for this is the topology resolver + service
  auth; the `.proto` contracts are written per service at extraction time (not
  speculatively now — an unused proto is dead code).

---

## 4. Do we need Kafka? — recommendation: **not yet; seam is ready**

**Short answer: No, not for the monolith.** Add it when we split services and
need a **durable, replayable, multi-consumer event log across the network**.

What we already have covers the monolith's needs:
- **In-process `eventBus`** (`services/eventBus.service.js`) — synchronous domain events.
- **Redis pub/sub** (`startup/realtimeBridge.js`) — cross-instance realtime fan-out (SSE/Socket.IO).
- **BullMQ on Redis** (`services/jobQueue.service.js`) — durable background jobs with retries.

**When Kafka earns its cost (the triggers):**
1. Two or more **independent services** need the same event stream (fan-out across the network).
2. You need **replay** — a new/failed consumer re-reading history (analytics, audit, rebuilding a projection).
3. Event **throughput or retention** outgrows Redis Streams/BullMQ (sustained very high write rates, long retention).
4. You adopt **CQRS/event-sourcing** for a domain (e.g. the ledger as an event log).

Until then Kafka is pure operational overhead (a cluster to run, secure, and
monitor). The **seam is built** (`eventBackbone.js`): every published event is
already forwarded to a pluggable backbone. Turning Kafka on is
`KAFKA_BROKERS=...` + the existing `kafkaDriver.js` — no call-site changes. If we
later prefer **NATS JetStream** or **Redis Streams** as the log, that's a second
driver in the same seam.

> Recommendation: **defer Kafka.** Ship the seam (done). Revisit at the first
> service extraction that needs cross-service replay.

---

## 5. Inter-service security — recommendation

Inside the monolith the process boundary is the trust boundary, so there is
literally nothing to authenticate between domains — direct imports. **Do not add
service-auth ceremony to in-process calls; it would be theater.**

The moment a domain is remote, defense-in-depth applies:

| Layer | Mechanism | Where | Status |
|---|---|---|---|
| **App identity** | Short-lived signed **service tokens** (`iss`/`aud`-scoped, HS256-pinned, ~60s TTL) | `backend/gateway/serviceAuth.js` | **built (dormant)** |
| **Transport** | **mTLS** between services | service mesh (Linkerd/Istio) or Envoy | infra (Bucket C) |
| **Network** | Default-deny **network policies**; internal APIs never public | k8s NetworkPolicy / VPC | infra (Bucket C) |
| **Secrets** | Dedicated `SERVICE_JWT_SECRET`, rotated | secrets manager | infra (Bucket C) |

The app owns the **identity** layer (built here). Transport/network/secret
management is infra-owned — the app provides the integration point
(`requireServiceAuth(thisService)` guards a service's internal API).

---

## 6. Hybrid database (Mongo + Postgres)

This is **already underway** and matches the reference roadmap:

- **MongoDB** — high-velocity, flexible data: game cycles, real-time, sessions,
  logs, content. Authoritative **today** for everything.
- **PostgreSQL** — financial integrity (wallets, ledger, payment orders, KYC):
  strong ACID, integer paise, partitioning. Provisioned via
  `backend/postgres/pgClient.js`; production startup requires `DATABASE_URL`
  so the hybrid money datastore is configured before serving traffic.
- **Sync:** dual-write from the money models (`backend/postgres/dualWrite.js`)
  with **continuous reconciliation + drift metrics** (`reconcile.js`, cron).
  Postgres is a verified **shadow** first; it becomes **authoritative for money
  last**, after wallet/ledger/payment/UTR are proven — an owner-gated cutover
  (`DATA_ROLLBACK_PLAN.md`).
- **pgvector** rides the same Postgres for the **RAG** vector store (§7) — one
  managed dependency, two uses.

CDC (Debezium) from the reference is an **option for later** — only if we need to
stream money-table changes to services/analytics. Dual-write + reconciliation is
the right, simpler choice while Postgres is a shadow; revisit CDC at cutover.

Redis remains the **cache + lock + rate-limit + queue** layer across both DBs.

---

## 7. RAG support assistant (built this PR)

The first concrete, fully-built piece and the model first-extraction candidate.
See `backend/domains/support/README.md`. Flow: ingest → chunk → embed (Voyage) →
store (pgvector); ask → embed query → cosine top-K → generate (Claude
`claude-opus-4-8`). Grounded-only answering (no invented policies/payouts),
env-gated dormant until keys + pgvector exist.

---

## 8. HA / resilience layers — what's app vs infra

Mapping the reference's HA roadmap to buckets, honestly:

| Layer | Owner | Status |
|---|---|---|
| Health-checked liveness/readiness, graceful drain | app | **done** (`server.js`) |
| Load shedding / bulkhead (per-instance overload valve) | app | **done** (`middleware/loadShed.js`) |
| Backoff + jitter on outbound calls | app | **done** (`utils/retry.js`) |
| Tiered + per-subnet rate limiting, surge breaker | app | **done** (`middleware/ipDefense.js`) |
| Consistent-hash routing/sharding primitive | app | **done** (`gateway/consistentHash.js`) |
| Prometheus metrics + Grafana dashboard-as-code | app | **done** |
| Reverse proxy w/ dynamic upstreams, geo-routing | infra | Bucket C (Envoy/Kong/APISIX + Cloudflare) |
| Multi-region / multi-provider redundancy, DNS failover | infra | Bucket C |
| WAF | infra | Bucket C (Cloudflare + `owaspFilter` is the app-side complement) |
| IaC (Terraform/Ansible), one-click redeploy | infra | Bucket C |
| Encrypted cross-region backups + restore testing | infra | Bucket C (`docs/governance/DISASTER_RECOVERY.md`) |

The app is HA-*ready* (stateless where it can be, health/metrics/drain correct,
Redis-backed shared state so instances are interchangeable). Multi-region,
multi-provider, DNS, and WAF are operational programs — the app provides the
integration points, not the infrastructure.

---

## 9. Edge/network features — separate infrastructure review

The reference roadmap also calls for a **Core Infrastructure Architecture** for
licensed operators. That future track is **not implemented in the application
codebase today**, but it is recorded in `CAPABILITY_MATRIX_2026.md` as an owned-edge
Layer-4 SNI passthrough and PROXY protocol v2 client-IP preservation plan.
Delivery belongs to a legally registered software/company infrastructure
workstream with legal, regulatory, provider-contract, abuse-monitoring, and
observability review before rollout.

Ordinary Layer-4 passthrough remains compatible with this architecture when it
routes only to owned services, preserves end-to-end TLS where required, and is
documented alongside the deployment topology, logging model, abuse controls, and
client-IP handling expectations.

---

## 10. Service extraction order & triggers

Extract only on a measured trigger (a domain that scales differently, fails
independently, or needs a different runtime). Suggested order:

1. **`support` (RAG)** — stateless, external-API-bound, spiky. Zero money risk. The rehearsal.
2. **`markets`** — CPU-heavy game engine + realtime; benefits from independent scaling.
3. **`payment`/`merchant`** — high throughput; isolate P2P orchestration.
4. **`wallet`** — **last**. The money authority wants the strongest consistency; keep it in the core until everything else is proven.

`identity` stays central (everyone depends on it) and scales with the monolith.

---

## 11. Rough capacity sketch (1M DAU)

Order-of-magnitude, to decide *where* to split — not a load test:
- 1M DAU → ~30–70k concurrent at peak (typical 3–7% concurrency for consumer apps).
- If an active user drives ~1 request / 3–5 s at peak → ~**6–20k RPS** aggregate.
- A horizontally-scaled monolith (stateless app tier + Redis shared state +
  Postgres/Mongo with read replicas + connection pooling) handles this behind a
  load balancer **well before** any split is mandatory.
- The first thing that hurts is **not** the web tier — it's hot datastore paths.
  That's why the money-DB partitioning framework and connection-pool monitoring
  already exist, and why `markets`/`payment` are the first *scaling* concerns.

**Conclusion:** scale the monolith horizontally first; extract services on
measured triggers; the seams in this PR make each extraction a config-gated,
low-risk step.

---

## 12. Activation env-var reference

| Feature | Env vars | Effect when set |
|---|---|---|
| RAG retrieval | `DATABASE_URL`, `VOYAGE_API_KEY` (`RAG_EMBEDDING_*`) | pgvector store + embeddings live |
| RAG generation | `ANTHROPIC_API_KEY` (`RAG_MODEL`, `RAG_MAX_TOKENS`) | Claude answers live |
| Event backbone | `KAFKA_BROKERS` (`KAFKA_SSL`, `KAFKA_SASL_*`, `KAFKA_TOPIC_PREFIX`) | events forwarded to Kafka |
| Remote service | `SERVICE_<NAME>_URL` | that domain resolves remote (hybrid mode) |
| Service auth | `SERVICE_JWT_SECRET` (`SERVICE_JWT_TTL`) | dedicated mesh signing key |

Everything above is **off by default**. The monolith runs unchanged with none of
them set.
