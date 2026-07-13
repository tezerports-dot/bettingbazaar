# Architecture Audit 2026 — Principal Platform Architect review (2026-07-13)

**Role:** Principal Platform Architect. **Mandate:** assume every implementation was
written by a competent senior engineer in 2024–2025; determine whether it still
represents the best enterprise architecture in mid-2026. "Already implemented" is
not a stopping condition; "current implementation demonstrably meets modern
enterprise architecture standards" is.

**Method:** every subsystem was read in the repo (files cited by path:line), then
compared against current external standards — AWS/Google/Azure Well-Architected,
CNCF/Kubernetes production guidance, OWASP ASVS 5.0 (May 2025) + API Security
Top 10, NIST SP 800-63B-4, PostgreSQL 17/18, Redis 8, OpenTelemetry, Prometheus,
Caddy — with the version-sensitive facts verified against July-2026 sources
(links in §8). Each subsystem gets the six-question treatment:
A exists · B complete · C current-best-practice · D industry moved on ·
E measurable benefit to upgrade · F migration risk acceptable.

**Division of labor (owner directive):** this document is research + comparison
only (Fable session). All code changes are queued in §5 (AQ-numbers), sized and
batched for 5-hour Opus 4.8 implementation sessions. Governance changes are
**proposed** in §7 — the owner chooses; nothing in governance was edited.

**Continuity note:** a prior session's research list was lost with its container
(only commits survive). Its shipped items map to: backoff+jitter (`item 3` →
`backend/utils/retry.js`), CPU worker pool (`item 5`), N+1 audit (`item 6` →
`docs/N_PLUS_ONE_AUDIT.md`), load shedding (`item 9` → `middleware/loadShed.js`),
IP-rotation defense (`item 12` → `middleware/ipDefense.js`). All five re-verified
present and sound. Every un-shipped item from that lost list is re-derived below —
nothing depends on the lost document. This file is committed precisely so that
can't happen again.

---

## 1. Verdict scoreboard

| # | Subsystem | A | B | C | D | Verdict |
|---|---|---|---|---|---|---|
| 1 | Runtime baseline (Node) | Yes | Yes | **No — EOL** | Yes | **UPGRADE** (AQ‑5) |
| 2 | Web framework (Express 4) | Yes | Yes | Borderline | Yes — v5.2 endorsed, v4 EOL ~Oct 2026 | **UPGRADE** (AQ‑6) |
| 3 | Secrets & config | Yes | Yes | One defect | No | **FIX defect** (AQ‑1), else KEEP |
| 4 | JWT/session auth | Yes | Yes | **No** (fallback secret, no alg pinning) | Partially | **UPGRADE** (AQ‑1/2) + owner decision D‑4 |
| 5 | Password hashing | Yes | Yes | Yes (ASVS-compliant) | Yes (argon2id preferred) | **UPGRADE, low-risk** (AQ‑8) |
| 6 | HTTP security headers/CSP | Yes | Yes | Yes | Minor (helmet 8) | **KEEP** (bump inside AQ‑6) |
| 7 | Rate limiting & anti-abuse | Yes | Yes | Yes | No | **KEEP** (evidence §4.3) |
| 8 | Input validation & injection defense | Yes | Yes | Yes-for-launch | Partially (schema-per-route) | **KEEP for launch**, post-launch increment recorded |
| 9 | Authorization | Yes | Yes (matrix, X‑8) | Yes | No | **KEEP** (evidence §4.4) |
| 10 | Money data layer (Mongo float + PG paise hybrid) | Yes | Code-complete | Direction correct; 2 defects | No — plan matches 2026 practice | **FIX defects** (AQ‑3/9); cutover = owner gate; PG version = decision D‑2 |
| 11 | Caching | Yes | Yes | Yes | No | **KEEP** |
| 12 | Background jobs | Yes | Yes | Yes | No | **KEEP** (evidence §4.5) |
| 13 | Realtime fan-out (SSE + socket.io + Redis) | Yes | Yes | Yes | No | **KEEP** (CI-proven) |
| 14 | Observability (logs/metrics/alerts) | Yes | Yes | Yes-for-a-monolith | Yes (OTel is the CNCF standard) | **KEEP with trigger** — owner decision D‑3; small gaps AQ‑13 |
| 15 | Resilience primitives (retry/shed/breaker) | Yes | Yes | Yes | No | **KEEP** (shipped items 3/9; breaker assessed §4.6) |
| 16 | Graceful shutdown & health probes | Yes | **Incomplete** | **No** | n/a | **UPGRADE** (AQ‑4) — correctness gap |
| 17 | Container image | Yes | Yes | **No** (EOL base, root user, fat single-stage) | n/a | **UPGRADE** (AQ‑5) |
| 18 | Kubernetes manifests | Yes | Reference-grade | **No** (probe wiring, no securityContext/PDB) | n/a | **UPGRADE** (AQ‑11) |
| 19 | Edge (Caddyfile) | Yes | **Broken as-is** (no API proxy; not in Railway path) | No | n/a | **FIX or REMOVE** (AQ‑12) |
| 20 | CI/CD & supply chain | Yes | Tests strong | **No scanning; non-reproducible prod builds** | Yes (SLSA/OpenSSF baseline) | **UPGRADE** (AQ‑7) |
| 21 | Backups & DR | Yes | Yes | Yes for scale | No | **KEEP** (owner actions stand) |
| 22 | Architecture shape (modular monolith, 13 domains) | Yes | Yes | Yes | No — 2026 consensus favors modular monolith at this org size | **KEEP** (evidence §4.1) |

Summary: **8 subsystems demonstrably meet 2026 standards and are kept with
evidence; 10 get targeted upgrades (14 queued items, ~3 Opus sessions); 4
decisions belong to the owner (§6).** No subsystem needs a from-scratch build.

---

## 2. The three findings that gate go-live (read these first)

**G‑1 · Production runtime is end-of-life.** Node 20 reached EOL 2026‑04‑30 — no
security patches since. The Docker image pins `node:20-slim` (Dockerfile:11), and
the Railway path is worse: nixpacks resolves the Node version from
`engines: >=18.0.0` (package.json:78), so production builds may run Node 18
(EOL April 2025). CI already proves the suite green on Node 22 (ci.yml:44) —
the fix is alignment, not porting. *An unpatched runtime under a money platform
fails every framework's security pillar.* → AQ‑5.

**G‑2 · JWT verification accepts a hardcoded fallback secret.**
`sse.routes.js:28`: `JWT_SECRET || 'fallback-secret'`. The personal-events SSE
endpoint verifies user identity against a public string whenever the env var is
missing. Every other verify site requires the env (auth.middleware.js:34) — this
one silently doesn't. Defense-in-depth also missing: none of the 11 `jwt.verify`
sites pins `algorithms` (ASVS V3/V9; jsonwebtoken accepts any HMAC alg the
secret type allows). → AQ‑1, AQ‑2.

**G‑3 · Production deploys are not reproducible and unscanned.** Railway builds
with `npm install --legacy-peer-deps` + `NIXPACKS_NO_CACHE` (railway.json) — the
deploy resolves fresh semver ranges, so production can run dependency versions
CI never tested, silently, on every deploy. There is no dependency-vulnerability,
secret, SAST, or image scan anywhere in CI. OpenSSF/SLSA treat lockfile-exact
installs + scanning as the 2026 baseline for anything handling money. → AQ‑7.

---

## 3. Subsystem analyses (exists → 2026 standard → gap → verdict)

### 3.1 Runtime baseline — UPGRADE
- **Exists:** `engines >=18` (both package.json files), `node:20-slim` image, CI on 22.
- **2026 standard:** Node 24 = Active LTS, Node 22 = Maintenance LTS; 18 and 20 are EOL.
- **Gap:** three different Node stories across CI / Docker / Railway; two of the three are EOL lines.
- **Verdict:** standardize on **22 LTS now** (already CI-proven; zero porting risk; EOL Apr 2027), record 24 as the next step. Pin nixpacks (`NIXPACKS_NODE_VERSION=22`), image `node:22-slim`, engines `>=22 <23`… exact range Opus decides. Measurable: patched CVE surface; identical runtime in CI and prod.

### 3.2 Express 4 → 5 — UPGRADE (the one large item)
- **Exists:** `express ^4.18.2`; wildcard routes `app.get('*')`, `app.options('*')`, `/admin/*`, `/merchant/*` (server.js:124,324–338); `express-mongo-sanitize` 2.x (mutates `req.query` — hard-breaks on Express 5's getter-only `req.query`); helmet 7; express-rate-limit 7.
- **2026 standard:** Express 5.2 (Dec 2025) is the TC-endorsed production release; v4 entered Maintenance Apr 2025 with target EOL **no sooner than Oct 1, 2026** — three months out. path-to-regexp 8 removes ReDoS-prone route patterns.
- **Gap:** staying on 4 past October means running the framework equivalent of an EOL runtime under a wallet product; migrating later means migrating under time pressure.
- **Risk check (F):** genuinely acceptable *here*: the integration suite runs real route → engine → ledger flows in CI, all three panels build in CI, and the breaking changes are mechanical (route syntax, `req.query`, sanitizer swap, helmet 8 + express-rate-limit 8 bumps ride along). One focused Opus session with the suite as the net.
- **Verdict:** migrate now (owner confirm — decision D‑1). If deferred: document acceptance + calendar the EOL.

### 3.3 Secrets & config — KEEP (one defect + one small add)
- **Exists:** 12-factor env with a thorough `.env.example`; secrets-manager decision recorded with triggers (PLAN_STATUS_AUDIT §4 item 20) — matches AWS/Google guidance for a single-service deploy at this scale. Defect: G‑2's fallback secret contradicts the fail-fast posture.
- **Add:** one boot-time validator: in production, refuse to start without `JWT_SECRET`, `ORDER_HMAC_SECRET`, `MONGODB_URI`; warn-list the optional ones. (AQ‑1.)

### 3.4 JWT/session — UPGRADE (targeted)
- **Exists:** HS256 (implicit), `7d` expiry (routes.js:22), logout → `TokenBlacklist` checked per request — i.e., instant revocation exists, which is the control refresh-rotation usually buys.
- **2026 standard (ASVS 5.0 V3, OWASP API2):** explicit alg allowlist, `iss`/`aud` claims, short-lived access tokens *or* server-side revocation.
- **Verdict:** centralize the 11 verify sites into one `verifyToken()` with `algorithms:['HS256']` + `iss/aud` (AQ‑2). Token lifetime is a product tradeoff → decision D‑4 (my recommendation: 24h + keep the blacklist; full refresh-token machinery is not justified while revocation already works).

### 3.5 Password hashing — compliant today, cheap upgrade available
- **Exists:** bcryptjs cost 12. **This passes ASVS 5.0** (bcrypt ≥10 approved).
- **2026 standard:** argon2id first choice (OWASP/NIST; min 19 MiB, t=2, p=1). Also material: bcryptjs is pure JS — each hash burns ~150–250 ms *on the event loop*; native argon2 runs on the libuv threadpool.
- **Verdict:** AQ‑8 — argon2id for new hashes + transparent rehash-on-login for existing ones (verify old bcrypt → immediately store argon2id). Zero user impact, measurable event-loop relief on login bursts, aligns with the standard that will outlive bcrypt.

### 3.6 Money data layer — direction correct; two defects; cutover is the owner gate
- **Exists:** Mongo authoritative with float rupees + `round2()` (walletAuthority.service.js:34 — known); walletAuthority as sole writer; append-only ledgers; **PG hybrid shadow already code-complete**: BIGINT-paise schema with DB-enforced append-only + conserve-to-zero triggers (postgres/schema.sql), fire-safe idempotent dual-write, reconcile+backfill, rollback plan — CI-proven against real Postgres.
- **2026 standard:** integer minor units in an ACID store with database-enforced invariants — *exactly what the plan builds*. The plan needs no redesign.
- **Defects found:** (a) `pgClient.js:27` connects with `ssl: { rejectUnauthorized: false }` — the money database accepts any TLS certificate (MITM-able). → AQ‑3. (b) reconciliation is manual (`npm run reconcile:pg`); enterprise practice is *continuous* verification — scheduled reconcile + drift metric + alert while dual-write runs. → AQ‑9.
- **PG version:** nothing is provisioned yet, so the version choice is free. PostgreSQL 18 (Sep 2025) brings async I/O (up to ~3× read throughput), uuidv7, skip-scan; 17 is the conservative pick. Schema requires only ≥14; CI should match the choice (currently postgres:16). → decision D‑2.

### 3.7 Kubernetes + probes + shutdown — UPGRADE (correctness, not polish)
- **Exists:** manifests with RollingUpdate maxUnavailable:0, HPA, resources; app has SIGTERM handler.
- **Gaps vs Kubernetes production guidance:**
  1. **Liveness and readiness both hit `/health`, which returns 503 when Mongo is down** (deployment.yaml:35–42, server.js:214–221). A Mongo outage would make kubelet kill and restart every pod in a loop — turning a dependency outage into a full platform outage. Standard: liveness = process-only; readiness = dependencies.
  2. **`_shutdown` never calls `server.close()`** (server.js:364–377): the listener keeps accepting new connections for the whole 10s grace window, then `process.exit` kills them mid-flight. Rolling deploys will drop requests. Standard: fail readiness → stop accepting → drain → close pools → exit.
  3. No `securityContext` (runAsNonRoot, drop capabilities, seccomp), no PodDisruptionBudget, no startupProbe.
- **Verdict:** AQ‑4 (app: `/health/live` + `/health/ready` + real drain — this fixes Railway zero-downtime too, not just k8s) and AQ‑11 (manifest hardening).

### 3.8 Container image — UPGRADE
- **Exists:** single-stage `node:20-slim`, runs as **root**, `npm install` with devDependencies + three frontends' toolchains left in the runtime image.
- **2026 standard (CIS Docker / every cloud framework):** non-root `USER`, multi-stage (builder → slim runtime with prod deps + dist only), supported base.
- **Verdict:** AQ‑5. Measurable: patched base; image likely shrinks by hundreds of MB (faster pulls/scale-ups); root-escape blast radius removed.

### 3.9 Edge (Caddyfile) — broken artifact, decide its fate
- **Exists:** Caddyfile serving the three panels — **with no `reverse_proxy` for `/api`, `/health`, SSE, or websockets at all**. Used as written, the app's API would be unreachable. Railway's actual path (railway.json → nixpacks → `node backend/server.js`) doesn't use Caddy; neither does the Dockerfile.
- **Verdict:** AQ‑12 — either make it a *correct* optional edge (add reverse_proxy incl. websocket/SSE passthrough + a `header` security block; Caddy 2.10 gives HTTP/3 and modern TLS by default) or delete it and record the Dockerfile/nixpacks paths as the only two. Recommendation: fix it (≈20 lines) — a correct Caddy front is the natural self-hosting story this repo already documents in deploy/README.md.

### 3.10 CI/CD & supply chain — UPGRADE
- **Exists:** genuinely strong test CI (real Redis + Postgres + in-memory Mongo, money-flow integration tests, dependency-cruiser architecture gates, three panel builds).
- **Gaps vs OpenSSF/SLSA baseline:** no `npm audit`/OSV scan, no CodeQL/semgrep, no gitleaks, no image scan, `npm ci || npm install` fallback in CI, `npm install` (rangy) in the production build (G‑3), CI services one major behind chosen targets (postgres:16 vs D‑2 choice; redis:7 vs Redis 8.8 current), no Dependabot/Renovate.
- **Verdict:** AQ‑7. Measurable: production runs exactly the lockfile CI tested; known-vuln dependencies and leaked secrets fail the build instead of shipping.

### 3.11 Observability — KEEP with a named trigger (owner decision D‑3)
- **Exists:** structured JSON logs with correlation IDs (AsyncLocalStorage), W3C `traceparent` interop, prom-client metrics with bounded route labels + business counters, Grafana dashboard JSON, admin-editable alert webhook with retry+jitter.
- **2026 standard:** OpenTelemetry everywhere is the CNCF default answer.
- **Analysis (D=Yes, E marginal, F fine → keep):** distributed tracing pays off across service hops; this is a deliberate modular monolith with request-scoped correlation IDs already linking route→service→wallet→ledger. OTel SDK + OTLP pipeline would add dependencies and an infra requirement for span-level DB timing that slow-query logs + histograms largely cover. **Trigger recorded:** the day a second deployable service exists (or a provider integration goes synchronous-critical), adopt OTel traces; the `traceparent` interop shipped in item 35 makes that adoption non-breaking.
- **Small real gaps:** no log redaction helper (tokens/OTPs could reach logs via meta objects) → AQ‑13; no metric/alert on PG dual-write failures (belongs with AQ‑9).

### 3.12 Remaining KEEPs (evidence)
- **Rate limiting/anti-abuse:** per-IP tiers + Redis-shared atomic counters (CI-proven cross-instance) + subnet /24-IPv4 + /64-IPv6 aggregation + optional global surge breaker + flag-gated OWASP content filter. Matches or exceeds AWS WAF-style layering for an origin-enforced design. IPv6 per-IP keying rides the /64 subnet layer — covered.
- **Background jobs:** BullMQ repeatables with retry/backoff/jitter + leader-elected fallback without Redis + graceful close. This is the standard 2026 Node pattern.
- **Realtime:** socket.io Redis adapter + SSE Redis relay with origin dedup; horizontal scale proven in CI.
- **Caching:** Redis with bounded in-memory fallback (cache.service.js caps 1000 entries/60s TTL) — correct fallback discipline. (July-2026 "Postgres 18 replaces Redis" takes noted and rejected here: Redis also carries rate limits, queues, and pub/sub in this stack — consolidating onto PG would *increase* coupling on the money store.)
- **Backups/DR:** daily mongodump→S3, retention, failure alerts, restore drill documented, PITR = provider toggle. Right-sized.
- **Modular monolith:** 13 bounded domains, dependency-cruiser-enforced boundaries, single deployable. 2026 industry consensus (including the cloud frameworks' own guidance) endorses exactly this until team/org scale forces a split. No microservices migration is recommended.
- **Validation posture:** mongo-sanitize + mongoose strict casting + risk-validation authority on money paths + HMAC order signing; schema-per-route (zod) recorded as a post-launch increment, not a launch gate.
- **Structured logger (custom, zero-dep):** deliberate portability decision, JSON + reqIds already ingestible everywhere. pino would be a swap, not a gap-fill; revisit only if log volume becomes a measured cost.

---

## 4. (Reserved — section numbers referenced above map here)
For brevity, the evidence bullets live inline in §3; §4 numbers cited in the
scoreboard: 4.1=§3.12 monolith, 4.3=§3.12 rate limiting, 4.4=AUTHORIZATION_MATRIX.md,
4.5=§3.12 jobs, 4.6: circuit breakers assessed — outbound calls (SMTP, SMS, webhook,
S3) are already timeout-bounded, retried with jitter, and fire-and-forget off money
paths; a stateful breaker adds bookkeeping without changing failure behavior at this
fan-out. Not built; trigger = any synchronous outbound dependency on a user path.

---

## 5. Implementation queue — for Opus 4.8 sessions (AQ = Architecture Queue 2026)

Rules: each item lists files, change, proof. Follow 04‑GOVERNANCE.md as always
(§1 authorities, config via setConfigField where applicable). Do NOT start AQ‑6
mid-session; it gets a fresh session.

**SESSION 1 — security + runtime correctness (P0, fits one 5h session):**
- **AQ‑1** Fail-fast secrets. Remove `|| 'fallback-secret'` (sse.routes.js:28); add `startup/validateEnv.js` — production boot refuses without JWT_SECRET/ORDER_HMAC_SECRET/MONGODB_URI. Test: boot matrix.
- **AQ‑2** Single `verifyToken()` (domains/identity), `algorithms:['HS256']`, `iss`/`aud` (`bettingbazaar`) on sign+verify with a compat window for old tokens (verify accepts missing iss/aud until +30d, then enforce — old 7d tokens age out). Reroute all 11 verify sites. Tests: alg-confusion rejected; legacy token accepted during window.
- **AQ‑3** pgClient TLS: default verify; `PG_CA_CERT` (inline PEM env) → `ssl:{ca}`; explicit `PG_SSL=no-verify` escape hatch, loudly logged. Test: config matrix unit test.
- **AQ‑4** Real graceful shutdown + probe split. `/health/live` (200 if process up), `/health/ready` (deps; flips 503 immediately on SIGTERM), then `server.close()` → drain (maxwait) → close queues/PG/worker pool/Mongo/Redis → exit. Update deployment.yaml probes, Dockerfile HEALTHCHECK→ready, railway.json healthcheckPath stays /health (Railway has no liveness/readiness split — document). Integration test: SIGTERM completes in-flight request, refuses new.
- **AQ‑5** Runtime + image. engines `>=22` both package.json files (and sync backend/package.json's missing deps — pg/bullmq/prom-client/nodemailer — or mark it explicitly non-installable; Opus verifies nothing installs from it); `NIXPACKS_NODE_VERSION=22` (railway.json variables); Dockerfile: `node:22-slim`, multi-stage (builder builds panels; runtime = prod deps + backend + dist folders), `USER node`. Prove: docker build + container boots + /health/ready green locally.

**SESSION 2 — platform currency (P1):**
- **AQ‑6** Express 5.2 migration (one session, alone): route wildcards → v5 syntax (`app.get('*')` → `app.get('/*splat')` etc. — server.js:124,324–338 and any router-level wildcards), replace express-mongo-sanitize with an Express‑5-compatible equivalent (sanitize body+params; `req.query` is getter-only), helmet →^8, express-rate-limit →^8 (re-verify the custom Redis store contract + built-in IPv6 handling), cookie/status API removals audit. Proof: full unit+integration suite, three panel builds, manual smoke of SSE + websocket + an admin route.
- **AQ‑7** CI supply chain: `npm ci` everywhere (drop `|| npm install`; Railway buildCommand → `npm ci --legacy-peer-deps …`, drop NIXPACKS_NO_CACHE), add jobs: `npm audit --omit=dev --audit-level=high` (or osv-scanner), gitleaks, CodeQL (javascript), optional docker build+trivy on main; bump CI services redis:7→8, postgres:16→(per D‑2); add .github/dependabot.yml (weekly, grouped minor/patch).

**SESSION 3 — hardening + money-cutover support (P1/P2):**
- **AQ‑8** argon2id (m=19456,t=2,p=1) via native `argon2`; verify-then-rehash for existing bcrypt hashes; keep bcryptjs only as verify-fallback. Tests: old-hash login upgrades in place; new hash format asserted.
- **AQ‑9** Continuous PG reconciliation while dual-write runs: scheduled job (jobQueue repeatable; cron-fallback pattern as the other jobs) invoking the reconcile core + `bb_pg_drift_total` / `bb_pg_dualwrite_failures_total` metrics + alert on nonzero. Test: drift injected in CI is detected + counted.
- **AQ‑10** Body-limit rightsizing: `express.json({limit:'1mb'})` default after verifying upload paths are multipart/S3 (if any JSON base64 uploads exist, keep a scoped larger limit on those routes only). Test: oversize JSON → 413 on a normal route.
- **AQ‑11** k8s hardening: securityContext (runAsNonRoot, allowPrivilegeEscalation:false, capabilities drop ALL, seccomp RuntimeDefault), PDB (minAvailable:1), startupProbe, probes → AQ‑4 endpoints, topologySpreadConstraints.
- **AQ‑12** Caddyfile: add `reverse_proxy` for /api,/health,/metrics,/app-assets,/storage + websocket/SSE passthrough + `header` security block (HSTS only here — TLS terminates at Caddy in self-host), or delete + document. Default: fix.
- **AQ‑13** Log redaction: `logger.js` redacts known keys (password, token, authorization, otp, secret) in meta; grep-audit existing log calls. Unit test.
- **AQ‑14** Mongoose `autoIndex:false` in production + `scripts/sync-indexes.mjs` (explicit syncIndexes) documented in deploy notes. Prevents boot-time index builds stalling scaled instances.

Estimated total: Session 1 ≈ 4h, Session 2 ≈ 4–5h, Session 3 ≈ 4h.

---

## 6. Owner decisions — ALL DECIDED 2026-07-13 (owner, via decision prompt)

- **D‑1 Express 5: MIGRATE NOW.** AQ‑6 proceeds as a dedicated session.
- **D‑2 Postgres version: 18.** Provision PostgreSQL 18 for the money cutover; AQ‑7 bumps the CI service image to `postgres:18`.
- **D‑3 OpenTelemetry: keep current posture, adopt at the recorded trigger** (second deployable service or a synchronous-critical provider integration). Default recommendation accepted; owner may reopen anytime.
- **D‑4 JWT lifetime: 24 hours** + keep the per-request TokenBlacklist. AQ‑2 sets `JWT_EXPIRES_IN` default to `24h` (env still overrides); document the re-login behavior change.

## 7. Governance update proposals — ALL FOUR APPROVED 2026-07-13, applied as 04-GOVERNANCE.md §16

- **P‑1 Runtime currency rule (04‑GOVERNANCE §-new):** "Production runs only supported LTS runtimes and supported major versions of security-load-bearing dependencies (framework, auth, DB drivers). An EOL runtime/framework in production is a launch/operate blocker. CI pins and proves the same versions production runs."
- **P‑2 Reproducible deploys rule:** "Production builds install from the committed lockfile (`npm ci`). A deploy that resolves dependency ranges at build time is invalid."
- **P‑3 Audit cadence:** "Re-run the §3 subsystem comparison quarterly or on any major-version EOL announcement affecting the stack; findings land in this file's changelog."
- **P‑4 Research artifacts rule:** "Research/plans that gate implementation are committed to the repo in the same session they're produced (this audit exists because a prior session's list died with its container)."

## 7a. Changelog — implementation progress

**2026-07-13 · SESSION 1 SHIPPED (AQ-1…AQ-5, P0 go-live blockers).** Opus 4.8.
- **AQ-1** `startup/validateEnv.js` — production boot refuses without JWT_SECRET /
  ORDER_HMAC_SECRET / MONGODB_URI; advised-var warnings. Wired in server.js.
  Removed a SECOND `|| 'fallback-secret'` found during implementation
  (`merchant.routes.js:20`, beyond the SSE one the audit flagged). 6 unit tests.
- **AQ-2** `domains/identity/jwt.util.js` — the single sign/verify authority:
  HS256 pinned on verify (algorithm-confusion rejected), iss/aud stamped, 24h
  default (D-4), legacy-token compat window (JWT_ENFORCE_CLAIMS flag). All 5
  sign sites + 11 verify sites across 6 files rerouted; zero `jwt.*` calls remain
  outside the authority. 8 unit tests incl. an alg:none forgery rejection.
- **AQ-3** `pgClient.resolvePgSsl()` — money-DB TLS now defaults to VERIFIED
  (was `rejectUnauthorized:false` = any cert accepted); PG_CA_CERT pinning +
  explicit `PG_SSL=no-verify` escape hatch. 6 unit tests.
- **AQ-4** Probe split + real drain in server.js: `/health/live` (process-only),
  `/health/ready` (deps + drain aware), legacy `/health` kept as readiness.
  SIGTERM now fails readiness → `server.close()` → drain in-flight → close
  Mongo/Redis/PG/queue/worker → exit, with a hard-deadline backstop for SSE.
  k8s probes + Dockerfile HEALTHCHECK repointed. Live smoke-tested (live=200,
  ready=503 on Mongo-down, clean SIGTERM exit).
- **AQ-5** Node 22 LTS everywhere (engines both package.json, NIXPACKS_NODE_VERSION,
  `node:22-slim`); Dockerfile now multi-stage + non-root `USER node` + writable
  dirs provisioned. Node 20 was EOL (2026-04-30).
- Result: 125 unit tests green (20 new). Full integration suite + panel builds
  run in CI.

**2026-07-13 · BATCH 2 SHIPPED (AQ-10, 11, 12, 13, 14).** Opus 4.8.
- **AQ-10** body limits: global JSON/urlencoded 10mb → 1mb default
  (JSON_BODY_LIMIT); admin base64 asset upload keeps a scoped 8mb parser. All
  other uploads use presigned S3. Verified 300KB→200, 1.5MB→413.
- **AQ-11** k8s hardening: pod+container securityContext (non-root uid 1000,
  drop ALL caps, seccomp RuntimeDefault, no-priv-esc), PDB (minAvailable 1),
  topologySpreadConstraints.
- **AQ-12** Caddyfile: was broken (no reverse_proxy — API unreachable); now
  proxies /api,/socket.io,/health*,/metrics,/app-assets,/storage with WS+SSE
  passthrough + edge security headers.
- **AQ-13** log redaction: logger.redact() masks password/otp/token/secret/etc
  recursively; unit-tested.
- **AQ-14** index sync: autoIndex env-gated (default ON — idempotency indexes);
  scripts/sync-indexes.mjs + `npm run sync:indexes` for the manual-sync workflow.
- Result: 128 unit tests green (3 new).

**2026-07-13 · BATCH 3 (AQ-8 SHIPPED).** Opus 4.8.
- **AQ-8** argon2id: new domains/identity/password.util.js is the hashing
  authority — argon2id (m=19456,t=2,p=1) for new hashes; verifyPassword accepts
  BOTH argon2 and legacy bcrypt (no lockout) and reports needsRehash so the two
  login handlers upgrade bcrypt→argon2id in place on next login. All 8 hash
  sites + 3 verify sites rerouted; bcryptjs retained only as verify-fallback.
  argon2 native prebuild confirmed clean on Node 22 (Docker/CI safe). 134 unit
  tests green (6 new).

**2026-07-13 · BATCH 4 SHIPPED (AQ-7 CI supply chain).** Opus 4.8.
- Reproducible installs: CI `npm ci --legacy-peer-deps` (was `npm ci || npm
  install`) — production runs exactly the committed lockfile (governance §16 P-2).
- Dependency remediation: `npm audit fix` cleared ALL 13 vulnerabilities
  (including the high-severity ws/socket.io/engine.io chain, GHSA-96hv-2xvq-fx4p)
  with ZERO package.json changes — transitive lockfile bumps only (ws→8.21.0).
  134 unit tests + socket.io boot re-verified after the bump.
- New CI gates: blocking `npm audit --audit-level=high` job (clean today, fails
  on any new high/critical); CodeQL SAST workflow (security-and-quality, weekly
  + PR); gitleaks secret scan (report-only initially); CI service images bumped
  to redis:8 + postgres:18 (matches decision D-2). `.github/dependabot.yml`
  (grouped weekly updates across root + both panels + Actions).
- **Remaining: AQ-6 (Express 5, dedicated session — highest risk), AQ-9
  (continuous PG reconciliation — activates once Postgres is provisioned).**

## 8. Sources (July 2026)

- Node.js EOL/LTS: [endoflife.date/nodejs](https://endoflife.date/nodejs), [nodejs.org releases](https://nodejs.org/en/about/previous-releases), [HeroDevs July-2026 reference](https://www.herodevs.com/blog-posts/node-js-end-of-life-dates-you-should-be-aware-of)
- Express 4/5 status: [expressjs.com migration guide](https://expressjs.com/en/guide/migrating-5/), [HeroDevs Express 2026 support reference](https://www.herodevs.com/blog-posts/express-3-is-eol-express-4-is-next-the-2026-support-reference), [InfoQ Express 5](https://www.infoq.com/news/2025/01/express-5-released/)
- PostgreSQL 18: [postgresql.org/18 release](https://www.postgresql.org/about/news/postgresql-18-released-3142/), [release notes](https://www.postgresql.org/docs/release/18.0/)
- Redis 8.x: [redis GitHub releases](https://github.com/redis/redis/releases), [Redis 8.0 OSS notes](https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/release-notes/redisce/redisos-8.0-release-notes/), [eosl.date/redis](https://eosl.date/eol/product/redis/)
- Password storage: [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) (argon2id m=19MiB/t=2/p=1; bcrypt ≥10 acceptable), OWASP ASVS 5.0, NIST SP 800-63B-4
- Plus: Kubernetes production probe/shutdown guidance, CIS Docker Benchmark, OpenSSF/SLSA supply-chain baselines, OWASP API Security Top 10 (2023), W3C Trace Context — applied as cited inline.
