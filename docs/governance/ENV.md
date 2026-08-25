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
| `S3_ACCESS_KEY` | S3 credential. Required: production refuses the local-disk fallback. |
| `S3_SECRET_KEY` | S3 credential. Required: production refuses the local-disk fallback. |
| `S3_ENDPOINT` | S3-compatible endpoint URL. Required **even on AWS S3** — see §2. |
| `METRICS_TOKEN` | Bearer token protecting `GET /metrics` from public disclosure. |
| `PUBLIC_APP_ORIGIN` | Official public app origin advertised to native clients (a valid `https://…` origin). |
| `PUBLIC_APP_ALLOWED_ORIGINS` | Public app origin allow-list advertised to native clients (comma-separated origins). |

**`TRUST_PROXY` — set this whenever anything terminates TLS in front of Node.**
Not in the required table because the app boots without it, but leaving it
wrong breaks IP attribution in both directions, and every per-IP control
(`ipDefense`, the rate limiters, audit logs) reads the result.

| Value | Meaning |
|---|---|
| *unset* / `false` / `none` | **Default.** `X-Forwarded-*` is ignored — correct for a directly-exposed listener. Behind a proxy this makes every client look like the proxy, so per-IP limits apply to your whole fleet at once. |
| `1` (or an integer *n*) | Trust *n* proxy hops. Correct for a single known edge (Caddy, one NGINX, one CDN). |
| `10.0.0.0/8, 172.16.0.0/12` | Trust these addresses/CIDRs only — a comma-separated list is passed through to Express verbatim. **Prefer this** when the upstream ranges are known. |
| `true` | Trusts every hop. Any client can then forge `X-Forwarded-For` and impersonate an arbitrary IP to `ipDefense`. Do not use in production. |

`PROXY_PROTOCOL_V2` / `PROXY_PROTOCOL_TRUSTED_SUBNETS` are the L4 alternative:
enable only when this listener sits directly behind internal edge routers that
prepend PROXY v2.

**Secret-strength rules the gate enforces (production):**
- `JWT_SECRET`, `PASETO_SECRET_KEY` (if used instead of `JWT_SECRET`), `ORDER_HMAC_SECRET`,
  `AADHAAR_HMAC_SECRET`, `METRICS_TOKEN` must each be **≥ 32 characters and non-placeholder**.
- `PUBLIC_APP_ORIGIN` / `PUBLIC_APP_ALLOWED_ORIGINS` must be valid **https** origins in production.

## 2. Object storage (S3-compatible) — all four vars are required

Works with any S3-compatible provider (AWS S3, Cloudflare R2, Backblaze B2, iDrive e2, Vultr, MinIO).

`server.js` refuses to boot production unless `isS3Configured()` is true, and
that requires **`S3_BUCKET_NAME` + `S3_ACCESS_KEY` + `S3_SECRET_KEY` +
`S3_ENDPOINT`** all to be set (`services/cdn.service.js`). There is no partial
configuration and no local-disk fallback in production — losing KYC documents on
a redeploy is not an acceptable degradation.

> **`S3_ENDPOINT` is required even on AWS S3.** This section previously said to
> omit it for the AWS default; following that produced a hard boot failure,
> because the configuration check requires it unconditionally. Use the regional
> endpoint, e.g. `https://s3.eu-central-1.amazonaws.com`.

| Variable | Purpose |
|---|---|
| `S3_REGION` | Bucket region. |
| `CDN_URL` | *(optional)* CDN in front of the bucket for public asset URLs. |

## 3. Money-DB TLS (Postgres)

| Variable | Purpose |
|---|---|
| `PG_CA_CERT` | Provider CA to pin — **verified TLS** (recommended in production). |
| `PG_SSL` | `no-verify` is **refused in production** unless `ALLOW_INSECURE_PG_TLS=true`; `false` is for local plaintext only. |
| `ALLOW_INSECURE_PG_TLS` | Explicit opt-in to accept `PG_SSL=no-verify` (do not use with a real money DB). |

## 3b. Outbound egress policy (SSRF)

`services/outboundGuard.js` restricts where the server may make HTTP requests.
Every outbound call through `networkClient` is limited to **http/https**, must
resolve to a **public** address, and has **every redirect hop re-validated** —
a permitted host answering `302 → http://169.254.169.254/` is the classic
metadata bypass and is refused.

No outbound URL comes from an end user. The risk this closes is an **admin**, or
a stolen admin session, pointing a configurable URL at something only the server
can reach — cloud metadata, the money datastore on the private network, or a
loopback admin service.

| Variable | Purpose |
|---|---|
| `OUTBOUND_ALLOW_PRIVATE` | `true` permits private/loopback/link-local destinations. Needed only when a provider is **self-hosted inside your private network** (see the Hetzner design). Off by default. |
| `OUTBOUND_ALLOWED_HOSTS` | Optional comma-separated host allow-list. When set, nothing outside it is reachable. Tightest posture; requires updating when you add a provider. |

### Approved outbound destinations

Everything the backend may legitimately call. Anything not on this list arriving
in a config value should be treated as a misconfiguration or an attack.

| Destination | Configured by | Caller |
|---|---|---|
| Game-provider APIs | `provider.apiUrl` (admin panel) | `domains/casino/gameProvider.routes.js` |
| SMS gateway | `SMS_API_URL` | `domains/communication/channelRegistry.js` |
| LLM / embeddings endpoint | RAG provider env | `domains/support/ragService.js` |
| S3-compatible storage | `S3_ENDPOINT` | AWS SDK (own client, not `networkClient`) |
| Cloudflare Turnstile | hard-coded constant | `middleware/captcha.js` |

> **Two reviewed exceptions** bypass `networkClient`. The **AWS SDK** manages its
> own connection pool and signing and cannot practically be routed through it.
> **`captcha.js`** calls a hard-coded Turnstile URL with its own timeout on the
> login hot path; it takes no configurable input, so the guard would add a DNS
> lookup per login for no security gain. Both are constant destinations, which
> is why they are acceptable — a *configurable* URL must go through
> `networkClient`.

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

## 6. Documented 2026-07-27 — read by the backend, previously listed nowhere

An audit of `process.env.*` reads against this file and `.env.example` found 35
variables the backend consults that appeared in neither. Nothing here is
required — every one has a working default — but an operator cannot tune or
harden what is not written down, so they are recorded. Re-run the check with:

```bash
grep -rhoE 'process\.env\.[A-Z][A-Z0-9_]{2,}' backend --include='*.js' | sort -u
```

**Defence toggles** (all default ON — set to `false` only to debug):

| Variable | Default | Effect |
|---|---|---|
| `LOAD_SHED_ENABLED` | on | Master switch for the load-shed/bulkhead middleware. |
| `LOAD_SHED_MAX_INFLIGHT` | see `middleware/loadShed.js` | Concurrent-request ceiling before shedding. |
| `LOAD_SHED_MAX_LAG_MS` | see `middleware/loadShed.js` | Event-loop lag threshold that triggers shedding. |
| `IP_DEFENSE_ENABLED` | on | Master switch for per-IP/per-subnet defence. |
| `IP_DEFENSE_SUBNET_MULT` | see `middleware/ipDefense.js` | Subnet budget multiplier over the per-IP budget. |
| `BET_BEHAVIOR_MAX_PER_MINUTE` | see risk rules | Per-user bet velocity ceiling. |

**Runtime & transport tuning:**

| Variable | Default | Effect |
|---|---|---|
| `WORKER_THREADS_ENABLED` | `true` | Offload CPU-bound work to the worker pool. |
| `WORKER_POOL_SIZE` | CPU-derived | Worker thread count. |
| `SSE_MAX_BUFFERED_BYTES` | see `sseManager.service.js` | Per-client SSE backpressure ceiling before disconnect. |
| `CSV_OFFLOAD_MIN_ROWS` | see reporting | Row count above which CSV export is offloaded to a worker. |
| `CYCLE_POOL_REFRESH_MS` | `1000` | Freshness window for the derived cycle-pool projection (`FLAGS.DERIVED_CYCLE_POOLS`). Only consulted when that flag is on; the money-critical reads (winner, netProfit) bypass it. |

**Bot mitigation (Cloudflare Turnstile)** — dormant until the secret is set:

| Variable | Default | Effect |
|---|---|---|
| `TURNSTILE_SECRET_KEY` | unset | Enables the captcha gate on player login/register, admin login and merchant login. Unset = pass-through, exactly as before the middleware existed. |
| `TURNSTILE_TIMEOUT_MS` | `4000` | How long to wait for Cloudflare before giving up. On timeout the request is **allowed** and an alert fires — a Cloudflare outage must not become a platform-wide login outage. An invalid token is still refused. |
| `VITE_TURNSTILE_SITE_KEY` | unset | Front-end widget key (public, safe to ship in the bundle). Set per panel at build time. |

Get both keys from the Cloudflare dashboard → Turnstile → Add site. The **site**
key is public; the **secret** key is a server credential and belongs with
`JWT_SECRET` in your secret store.

**Withdrawal settlement hold** is a business value, not an env var — it lives in
`SystemConfig.withdrawalHoldMinutes` (default 60) and is edited from admin
System Settings.

**Auth token claims** (defaults are fine for a single deployment):

| Variable | Default | Effect |
|---|---|---|
| `PASETO_ISSUER` | `bettingbazaar` (falls back to `JWT_ISSUER`) | `iss` claim. |
| `PASETO_AUDIENCE` | see `paseto.util.js` | `aud` claim. |
| `PASETO_EXPIRES_IN` | see `paseto.util.js` | Token TTL. |
| `PASETO_PREVIOUS_PUBLIC_KEYS` | unset | Verify-only keys during a rotation (§4 pattern). |
| `SERVICE_JWT_TTL` | see `gateway/serviceAuth.js` | Inter-service token lifetime (dormant until a domain goes remote). |

**Edge / mTLS** (all unset by default; the server runs plain HTTP behind a proxy):

| Variable | Effect |
|---|---|
| `BACKEND_MTLS_CERT` / `BACKEND_MTLS_KEY` / `BACKEND_MTLS_CA` | Enable mutual TLS on the backend listener. All three are required together. |
| `TLS_FINGERPRINT_EDGE_SECRET` | Shared secret that lets the app trust a TLS-fingerprint header from the edge. Without it the header is ignored — correct default. |

**Native app identifiers** (used by the app-distribution endpoints — see `NATIVE_APP_DISTRIBUTION_POLICY.md`):
`ANDROID_PACKAGE_ID`, `IOS_BUNDLE_ID`, `DESKTOP_APP_ID`, `PUBLIC_APP_NAME`.

**Support RAG service** (dormant until an API key is set — §19):
`RAG_CHAT_API_KEY`, `RAG_CHAT_BASE_URL`, `RAG_CHAT_MODEL`, `RAG_MODEL`,
`RAG_MAX_TOKENS`, `RAG_ASK_RATE`, `RAG_GENERATION_PROVIDER`,
`RAG_EMBEDDING_PROVIDER`, `RAG_EMBEDDING_MODEL`, `RAG_EMBEDDING_DIM`.

> ⚠️ Two naming traps worth knowing:
> - **`OPENAI_API_KEY`** is read as a fallback for `RAG_CHAT_API_KEY`
>   (`domains/support/ragService.js`). The provider is configurable — governance
>   §18 names `ANTHROPIC_API_KEY` as the RAG trigger, so set the provider vars
>   deliberately rather than relying on whichever key happens to be in the env.
> - **`MONGO_URI`** (no `DB`) is accepted *only* by
>   `backend/scripts/enforce-public-chat-retention.js`, which falls back to
>   `MONGODB_URI`. Everything else uses `MONGODB_URI`. Set `MONGODB_URI`.

---

## 7. Activation vars — off by default (feature stays dormant until set; see §18/§19)

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

## Client origin failover (user panel, build-time)

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Absolute API origin. Optional for a same-origin web deploy (relative `/api` works); **mandatory** for the Android build, which has no same-origin backend to fall back on. |
| `VITE_API_FALLBACK_URLS` | Comma-separated alternate origins serving the SAME deployment, tried in order when the primary does not answer. |

Every listed host must serve the same app — this is the multi-domain redundancy
in `backend/config/network.config.js` (`DOMAINS`), where each hostname serves
identical routes and behaviour. The client probes `/health/live` and adopts the
first origin that responds, remembering it for 30 minutes so a recovered primary
is eventually retried.

Failover triggers on **transport** failures only (DNS, TLS, connection refused,
timeout). An HTTP error status means the origin answered, and abandoning a host
that is talking to us would turn a server-side bug into a multi-origin outage.

This addresses origin availability. It takes no client IP, geo or ISP as an
input — the candidate order is static and identical for every user — and it is
not a circumvention mechanism (`04-GOVERNANCE.md` §20, 2026-07-28).

## Identity at rest (Aadhaar, bot tokens)

| Variable | Required | Purpose |
|---|---|---|
| `IDENTITY_ENCRYPTION_KEY` | **yes — the server refuses to boot in production without it** | AES-256-GCM key over the stored Aadhaar ciphertext and the Telegram bot tokens. Must decode to exactly **32 bytes**: `openssl rand -base64 32`. A wrong or absent key makes every stored identity unreadable. |
| `IDENTITY_ENCRYPTION_PREVIOUS_KEYS` | no | Comma-separated retired keys, **decrypt-only**. Their presence is what makes a rotation possible without a migration window. |
| `AADHAAR_HMAC_SECRET` | yes | Keyed hash enforcing one account per Aadhaar. Not reversible — it cannot serve the bulk export, which is why the ciphertext exists too. |
| `AADHAAR_HMAC_PREVIOUS_SECRETS` | no | Comma-separated rotation candidates, checked on lookup so a rotation does not lock existing players out of account recovery. |

**Why two forms of the same number.** The HMAC is one-way, so it cannot produce
the value the verification provider needs; GCM is randomised, so the same Aadhaar
encrypts differently every time and cannot back a unique index. One does
uniqueness, the other does export.

**Rotating `IDENTITY_ENCRYPTION_KEY`:** move the current value into
`IDENTITY_ENCRYPTION_PREVIOUS_KEYS`, set the new one, redeploy, then re-encrypt
at leisure with `rewrapField()` and drop the old entry. Unlike
`TOTP_ENCRYPTION_KEY` below, this key *can* be rotated — but only if the previous
value is kept until the re-encryption finishes.

**Bot tokens are NOT environment variables.** They live in `TelegramConfig` so a
suspended bot can be replaced from the admin panel without a deploy — see
`docs/IDENTITY_AND_REFERRALS.md` §7.

## Telegram

| Variable | Required | Purpose |
|---|---|---|
| `PUBLIC_APP_ORIGIN` | yes | Where bot login links point, and the base for the webhook URL registered with Telegram. |
| `TELEGRAM_LOGIN_TTL_MS` | no | Lifetime of a one-time login link (default 5 min). |
| `TELEGRAM_MEMBERSHIP_GRACE_MS` | no | How long a money action is still allowed when Telegram is unreachable, measured **from the last confirmed membership** (default 24h). Fail-closed would stop the platform taking money during a Telegram outage; fail-open forever would silently retire the gate. |

## Two-factor authentication (TOTP)

| Variable | Required | Purpose |
|---|---|---|
| `TOTP_ENCRYPTION_KEY` | **yes, once 2FA is enabled** | AES-256-GCM key protecting stored TOTP secrets. Generate with `openssl rand -base64 32`. |

A TOTP secret is a **bearer credential** — anyone holding it can mint valid
codes indefinitely — and unlike a password it cannot be stored as a one-way
hash, because the server must recompute codes from it. So secrets are encrypted
at rest and decrypted only for the duration of a verification. A database dump
alone does not yield working second factors.

Kept separate from `JWT_SECRET` deliberately: rotating the auth key must not
silently invalidate every enrolled authenticator, and a leak of one must not
compromise the other.

**This key has no `_PREVIOUS_` counterpart.** Rotating it makes every stored
secret undecryptable, which means every user re-enrolling. Treat it as
permanent; back it up with the same care as the Android keystore.
