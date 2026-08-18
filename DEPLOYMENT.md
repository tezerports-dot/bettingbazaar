# Deploying Betting Bazaar

The platform is **one Node 22 app** (`node backend/server.js`) that serves the API
plus the three built SPAs (`user-panel`, `admin-panel`, `merchant-panel`), backed
by four stateful dependencies. In production the boot gate (`backend/startup/validateEnv.js`)
**refuses to start** without a valid configuration, so provision dependencies and
secrets first.

> ⚠️ **Compliance first.** Real-money betting requires a gambling/gaming licence and
> AML/KYC compliance for your jurisdiction, plus a professional third-party security
> audit + penetration test. This document covers *engineering* deployment only —
> infrastructure privacy is not a substitute for licensing or law.

---

## 0. Prerequisites (all paths)

| Dependency | Purpose | Notes |
|---|---|---|
| **MongoDB** | primary datastore | must be a **replica set** (even 1 node) — money transactions require it |
| **PostgreSQL 18** | hybrid money ledger (`DATABASE_URL`) | required in prod; pin the CA via `PG_CA_CERT` |
| **Redis** | rate limits, realtime fan-out, job queue | required at >1 replica |
| **S3-compatible storage** | KYC / payment-proof / profile uploads (`S3_BUCKET_NAME`) | AWS S3, Cloudflare R2, Backblaze B2, MinIO… |

**Required env** (see `.env.example` for the full annotated list). Each secret must
be **≥32 chars and non-placeholder** — the boot gate rejects weak ones:

- Secrets: `JWT_SECRET`, `ORDER_HMAC_SECRET`, `AADHAAR_HMAC_SECRET`, `METRICS_TOKEN`
  (generate with `openssl rand -base64 48`)
- Data: `MONGODB_URI`, `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET_NAME` (+ S3 creds/endpoint)
- Web: `ALLOWED_ORIGINS`, `PUBLIC_APP_ORIGIN`, `PUBLIC_APP_ALLOWED_ORIGINS`
- Money-DB TLS: set `PG_CA_CERT` (verified TLS). `PG_SSL=no-verify` is **refused in
  production** unless `ALLOW_INSECURE_PG_TLS=true`; `PG_SSL=false` is for local plaintext only.

Node **22 LTS** everywhere (pinned in CI, `nixpacks.toml`, and the Dockerfile).
Install with `npm ci` (the user-panel no longer needs `--legacy-peer-deps`).

---

## A. Railway (legacy managed path — not the current plan)

> **Going live?** The current plan is a **Shinjiru dedicated box** — follow
> **[`docs/GO_LIVE_RUNBOOK.md`](docs/GO_LIVE_RUNBOOK.md)** (the ordered non-coder
> runbook) and **[`deploy/VPS_UBUNTU_SETUP.md`](deploy/VPS_UBUNTU_SETUP.md)** (every
> command). The Railway steps below are kept only as a generic managed-PaaS
> reference; note Railway's single-node MongoDB plugin does **not** satisfy the
> replica-set requirement, so it cannot run the money paths as-is.
>
> Architecture/sizing reference: **[`docs/PRODUCTION_ARCHITECTURE.md`](docs/PRODUCTION_ARCHITECTURE.md)**
> covers which database owns which data, Hetzner sizing and cost for ~50k DAU,
> and why Kubernetes is not recommended at this scale.

`railway.json` + `nixpacks.toml` are already committed (Nixpacks, Node 22, builds all
three panels, starts `node backend/server.js`, healthcheck `/health`).

1. **New Project → Deploy from GitHub** → `tezerports-dot/bettingbazaar`.
2. Add plugins to the project: **Redis**, **PostgreSQL**, and **MongoDB**. Railway's
   MongoDB is single-node — enable a replica set on it, or use **MongoDB Atlas** (free
   M0) and point `MONGODB_URI` at it (transactions need a replica set).
3. Create an S3 bucket (Cloudflare R2 / Backblaze B2 are cheap) → set `S3_BUCKET_NAME` + creds.
4. **Variables** → paste the required env; map `MONGODB_URI` / `DATABASE_URL` / `REDIS_URL`
   to the plugin references; set the four strong secrets and your origins.
5. Deploy, then attach your domain in **Settings → Domains** (Railway terminates TLS;
   the host-agnostic Caddyfile means every attached domain serves identical content).
6. Smoke test: `curl -I https://<domain>/health`.

Railway deploys are **replace** (not rolling/blue-green). For zero-downtime rollouts use
the k8s manifests in `deploy/` (native `RollingUpdate` + blue/green selector flip).

---

## B. Your own VPS

### B1 — Docker Compose (simplest, reproducible)

`deploy/docker-compose.yml` now stands up **app + MongoDB (1-node RS) + Redis + Postgres 18**
from scratch. Provide S3 (managed R2/B2/MinIO) and your secrets via a `.env` file.

```bash
git clone https://github.com/tezerports-dot/bettingbazaar && cd bettingbazaar
cp .env.example deploy/.env      # fill strong secrets + S3_* (DATABASE_URL/PG_SSL are prewired)
docker compose -f deploy/docker-compose.yml up -d --build
curl -I http://localhost:8080/health
```

Put **Caddy** in front for automatic HTTPS (the repo `Caddyfile` pattern — one site block
per domain, certs issued automatically).

### B2 — PM2 + Caddy (no Docker)

`ecosystem.config.cjs` is preconfigured for a VPS:

```bash
# Node 22 first, then:
npm ci
for p in user-panel admin-panel merchant-panel; do (cd "$p" && npm ci && npm run build); done
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup   # survives reboot
# multi-core: PM2_INSTANCES=max and exec_mode:'cluster'
```

Provide Mongo (RS) + Redis + Postgres + S3 (managed or self-run) and front with Caddy
(auto-HTTPS) or Nginx. Start sizing ~2 vCPU / 4 GB for the app tier; give the databases
their own resources.

---

## C. Faster, anonymous, low-latency self-hosting

Infra **privacy** (origin-IP hiding, operator privacy, DDoS resilience) is legitimate and
standard; it is **not** a way around licensing/KYC/law, and nothing here helps evade
regulators or law enforcement. The low-latency-compatible pattern:

- **Region = latency.** This app is India-facing (₹, UPI, Aadhaar). Host in **Mumbai**
  (or **Singapore** as a close second) so user RTT is ~5–40 ms. Keep the databases in the
  **same region/AZ** as the app — cross-region DB hops dominate latency. This single
  choice beats any CDN trick for real latency.
- **Operator privacy:** a **crypto-paid privacy VPS** in-region (providers accepting
  Monero/BTC without ID) + a privacy-forward registrar with WHOIS privacy.
- **Origin hiding (near-zero latency cost):** front the origin so its IP isn't exposed —
  a CDN proxy (Cloudflare / BunnyCDN) or a small edge VPS running the
  `deploy/haproxy/core-infra-l4-passthrough.cfg` template (**L4 SNI passthrough with
  PROXY-protocol v2**: origin stays hidden, real client IPs preserved, L4 ≪ L7 overhead).
  Firewall the origin to accept traffic only from the front.
- **Edge-cache the static bundles** (BunnyCDN is cheap/fast) so panel assets load from a
  POP near the user; keep the API on the in-region origin.
- **Do NOT use Tor** — anonymous but hundreds of ms of latency; wrong tool here. A
  crypto-paid in-region VPS + CDN front gives privacy *and* speed.

**Minimal fast/anonymous stack:** in-region privacy VPS → Caddy (auto-HTTPS, HTTP/2/3) →
`node backend/server.js` (PM2 cluster) → Mongo Atlas (nearest region) + Redis + Postgres;
BunnyCDN in front of static assets; origin firewalled to the CDN/edge only.

---

## Post-deploy checklist

- `curl -I https://<domain>/health` → 200; `curl -I --http2 …` confirms HTTP/2.
- `/metrics` protected by `METRICS_TOKEN`; import `deploy/grafana/bettingbazaar-dashboard.json`.
- MongoDB backups tested by **restore** (`backend/services/backup.service.js` mongodump job).
- Postgres reconcile clean (`npm run reconcile:pg`).
- Boot fails loudly on a weak/missing secret or unverified money-DB TLS — that's the gate working.
