# Portability — hosting, server, database, CDN

**Goal:** the codebase must move to any hosting/server/database/CDN without a
rewrite, with all config flowing through environment variables — never
hardcoded to one platform. This documents what is portable today (audited
2026-07-10), how to move it, and the one honest limitation.

---

## ✅ Portable today (verified)

**No platform lock-in in code.** A scan of `backend/**` found **zero** hardcoded
platform URLs or absolute container paths — every piece of infra is read from
an environment variable:

| Concern | Env var(s) | Swap to anything |
|---|---|---|
| Database | `MONGODB_URI`, `MONGO_MAX/MIN_POOL_SIZE` | Atlas, self-hosted Mongo, DocumentDB, any MongoDB-wire host |
| Cache / rate-limit / lock | `REDIS_URL` | Railway Redis, Elasticache, Upstash, self-hosted, or **none** (graceful in-memory fallback) |
| Object storage | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_NAME`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | **any S3-compatible** provider — AWS S3, iDrive e2, Vultr, Backblaze B2, MinIO, R2 |
| CDN | `CDN_URL` | any CDN in front of the bucket (Bunny, CloudFront, Fastly, …) |
| Public URL / CORS | `APP_BASE_URL`, `ALLOWED_ORIGINS` | any domain |
| Email | `SMTP_*` | any SMTP provider |
| Port | `PORT` (default 8080) | whatever the platform assigns |

**Frontends are origin-agnostic.** The three panels call `VITE_API_URL` if set,
otherwise fall back to **same-origin `/api`** — so a single-service deploy needs
no frontend URL config at all, and a split deploy just sets one env var.

**Runs on any container host.** A `Dockerfile` builds the whole app and starts
with `node backend/server.js` — no platform SDK, no `.env` file required (env is
injected by the platform). That image runs unchanged on AWS ECS/Fargate, GCP
Cloud Run, Azure, DigitalOcean, Fly.io, Render, Kubernetes, or a bare VM.

**No `.env`-file dependency at boot.** `npm start` is now `node backend/server.js`
(env injected by the platform); `npm run start:local` keeps the `--env-file=.env`
convenience for local dev. (Previously `npm start` hard-required a `.env` file,
which would break on env-injecting platforms — fixed.)

**Observability is portable.** Structured JSON logs to stdout (no vendor agent);
any log system ingests them (Datadog, Loki, CloudWatch, ELK).

## How to migrate (any target)

1. Provision Mongo + (optionally) Redis + an S3-compatible bucket + a CDN on the
   new platform.
2. Set the env vars from `.env.example` there.
3. `docker build` + run the image, **or** use the platform's Node buildpack with
   build `npm run build` and start `npm start`.
4. Point DNS at the new host; set `APP_BASE_URL` + `ALLOWED_ORIGINS`.
   No code changes.

The Railway-specific files (`railway.json`, `nixpacks.toml`, `Procfile`,
`Caddyfile`) are **optional convenience descriptors** — other platforms ignore
them; the Dockerfile is the platform-neutral path.

## ⚠️ The one honest limitation: the database ENGINE

"Any database" has a boundary. The app is built on **MongoDB via Mongoose** —
200+ models, aggregation pipelines, the append-only ledger's document shape, and
transaction usage all assume MongoDB semantics. You can move to **any MongoDB
host/provider** freely (that is fully portable). Swapping the *engine* to a SQL
database (Postgres/MySQL) is **not** a config change — it is a data-layer
rewrite. That is a deliberate architectural choice, not an oversight; if
SQL-portability is ever required it would be a dedicated project (introduce a
repository/DAL abstraction over the domains). No such abstraction exists today.

## Minor portability caveats (queued, not blockers)

- **App-asset uploads** (admin PWA icons) write to local disk
  (`backend/app-assets/`) via multer — ephemeral on a container host and not
  shared across instances. Branding/KYC uploads already use S3; app-assets
  should move to S3 too before multi-instance. (Queued.)
- **SSE/socket fan-out** is per-instance — needs a Redis pub/sub bridge before
  running >1 instance (already queued with the horizontal-scale items).
