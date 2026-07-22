# ENV.md — Environment Variables (mandatory + common optional)

**What to set before boot.** In **production** the boot gate
(`backend/startup/validateEnv.js`) **refuses to start** if any **Required** var
below is missing, weak, or a placeholder — so a misconfig fails at deploy time,
not at 3 a.m. `.env.example` (repo root) is the full annotated list; this file is
the authoritative summary of what is *mandatory* and the rules the gate enforces.

Generate every secret with: `openssl rand -base64 48`

---

## 1. Required — production will not boot without these

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs/verifies every auth token (PASETO Ed25519 seed). A weak/fallback value lets anyone forge sessions. |
| `MONGODB_URI` | Primary datastore. Must be a **replica set** (even 1 node) — money transactions require it. Unset silently connects to localhost. |
| `DATABASE_URL` | PostgreSQL money datastore (hybrid dual-write). `postgresql://user:pass@host:5432/db`. |
| `ORDER_HMAC_SECRET` | Dedicated payment-order integrity HMAC (separate from the auth key). |
| `AADHAAR_HMAC_SECRET` | Dedicated Aadhaar dedup HMAC (prevents reversible document hashes). |
| `REDIS_URL` | Cross-instance rate limits, realtime fan-out, job queue. Required at >1 replica. |
| `ALLOWED_ORIGINS` | CORS allow-list — production must name trusted origins explicitly (comma-separated). |
| `S3_BUCKET_NAME` | Durable asset/upload storage (KYC, proofs, branding). Local disk is not production-safe. |
| `METRICS_TOKEN` | Bearer token protecting `GET /metrics` from public disclosure. |
| `PUBLIC_APP_ORIGIN` | Official public app origin advertised to native clients (a valid `https://…` origin). |
| `PUBLIC_APP_ALLOWED_ORIGINS` | Public app origin allow-list advertised to native clients (comma-separated origins). |

**Secret-strength rules the gate enforces (production):**
- `JWT_SECRET`, `PASETO_SECRET_KEY` (if used instead of `JWT_SECRET`), `ORDER_HMAC_SECRET`,
  `AADHAAR_HMAC_SECRET`, `METRICS_TOKEN` must each be **≥ 32 characters and non-placeholder**.
- `PUBLIC_APP_ORIGIN` / `PUBLIC_APP_ALLOWED_ORIGINS` must be valid **https** origins in production.

## 2. Object storage (S3-compatible) — required alongside `S3_BUCKET_NAME`

Works with any S3-compatible provider (AWS S3, Cloudflare R2, Backblaze B2, iDrive e2, Vultr, MinIO).

| Variable | Purpose |
|---|---|
| `S3_ENDPOINT` | Provider endpoint (omit for AWS S3 default). |
| `S3_REGION` | Bucket region. |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Credentials. |
| `CDN_URL` | *(optional)* CDN in front of the bucket for public asset URLs. |

## 3. Money-DB TLS (Postgres)

| Variable | Purpose |
|---|---|
| `PG_CA_CERT` | Provider CA to pin — **verified TLS** (recommended in production). |
| `PG_SSL` | `no-verify` is **refused in production** unless `ALLOW_INSECURE_PG_TLS=true`; `false` is for local plaintext only. |
| `ALLOW_INSECURE_PG_TLS` | Explicit opt-in to accept `PG_SSL=no-verify` (do not use with a real money DB). |

## 4. Secret rotation (zero-downtime — set the `*_PREVIOUS_*` var during a rotation)

Move the current value into the `PREVIOUS` var, set a new primary, deploy, then drop the old value
after the overlap (token TTL / order lifetime). Verification accepts current **or** retained values.

| Rotating | Retained-values var |
|---|---|
| Auth key (`JWT_SECRET`/`PASETO_SECRET_KEY`) | `JWT_PREVIOUS_SECRETS` (alias `PASETO_PREVIOUS_SECRETS`), comma-separated |
| Order integrity (`ORDER_HMAC_SECRET`) | `ORDER_HMAC_PREVIOUS_SECRETS` |
| Aadhaar dedup (`AADHAAR_HMAC_SECRET`) | `AADHAAR_HMAC_PREVIOUS_SECRETS` |
| `METRICS_TOKEN`, alert webhook | Rotate from System Settings / env; no `PREVIOUS` needed |

## 5. Common optional (safe defaults; see `.env.example` for the exhaustive list)

| Variable | Default / note |
|---|---|
| `PORT` | `8080` — the platform usually injects this. |
| `NODE_ENV` | Set `production` on deploy (activates the boot gate + secure cookies + HSTS). |
| `JWT_EXPIRES_IN` | `24h` access-token lifetime (revocation via `TokenBlacklist`). |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `bettingbazaar`; set `JWT_ENFORCE_CLAIMS=true` only after all pre-claims tokens have expired. |
| `APP_BASE_URL` / `CANONICAL_HOST` | Public URL; optional canonical-host 301. |
| `ALERT_WEBHOOK_URL` | Fallback money-path alert sink (or set `SystemConfig.alertWebhookUrl` in-app). |
| `DEFAULT_ADMIN_MOBILE` / `DEFAULT_ADMIN_PASSWORD` | First-boot admin bootstrap — **change the password immediately after first login**. |
| `SMTP_HOST` / `SMTP_FROM` / `SMTP_*` | Enables the EMAIL channel when set (no delivery until then). |
| `MONGO_AUTO_INDEX` | `true` (build indexes at boot). Set `false` + run `npm run sync:indexes` in the pipeline to avoid boot-time builds on a scaled fleet. |
| `PG_POOL_SIZE` | Postgres pool per instance. Keep `instances × (Mongo pool + PG pool) ≤` the DB tier's connection cap (§21). |
| `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` | Password-hash cost (OWASP minimum by default; raise on capable hardware). |
| `BB_RUNTIME_ROLE` | `api` / `realtime` / `scheduler` for a split k8s fleet (see `deploy/k8s/`). |

## 6. Activation vars — off by default (feature stays dormant until set; see §18/§19)

| Variable | Activates |
|---|---|
| `VOYAGE_API_KEY` (+ `DATABASE_URL`) | RAG retrieval (pgvector embeddings). |
| `ANTHROPIC_API_KEY` | RAG generation (support assistant). |
| `KAFKA_BROKERS` (+ `KAFKA_SSL`/`KAFKA_SASL_*`) | External event backbone. |
| `SERVICE_<NAME>_URL` | Resolves that domain to a remote service (hybrid mode). |
| `SERVICE_JWT_SECRET` | Inter-service auth signing key (mesh). |

---

**Full annotated reference:** `.env.example` (repo root). **Deploy walkthroughs:** `DEPLOYMENT.md`.
**Boot-gate source of truth:** `backend/startup/validateEnv.js`.
