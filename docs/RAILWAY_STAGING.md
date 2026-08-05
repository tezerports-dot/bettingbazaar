# Railway staging deployment — step by step

A complete walkthrough for standing up a **staging** copy of Betting Bazaar on
Railway. Written to be followed by someone who does not write code: every value
you need to create is spelled out, and every step says what "it worked" looks
like.

`DEPLOYMENT.md` section A is the three-minute version for someone who already
knows Railway. This is the long version, and it is the one to follow for a first
deploy.

> **Staging is not production.** Use test payment credentials and fake KYC
> documents here. See "Before you point real money at this" at the end.

---

## 0. What you are building

Railway will run **one application service** (the Node backend, which also
serves the three built front-end panels). It needs four things alongside it:

| Dependency | Where it comes from | Why |
|---|---|---|
| MongoDB | **MongoDB Atlas** (not Railway's plugin — see step 1) | Primary datastore, currently authoritative for money |
| PostgreSQL | Railway plugin | Money mirror; the app refuses to boot without it |
| Redis | Railway plugin | Rate limits, realtime fan-out, job queue |
| S3-compatible storage | **Cloudflare R2** | KYC documents, uploads, branding assets |

You will need accounts on: **GitHub**, **Railway**, **MongoDB Atlas**, and
**Cloudflare**. All four have a free tier sufficient for staging.

---

## 1. MongoDB — use Atlas, not the Railway plugin

**This step is not optional and it is the one people get wrong.**

The money code uses MongoDB *transactions* in 31 places (bet placement, wallet
movements, admin adjustments). MongoDB only supports transactions on a **replica
set**. Railway's one-click MongoDB plugin is a **single node**, so every money
write against it fails with:

```
Transaction numbers are only allowed on a replica set member or mongos
```

Atlas is a replica set even on the free tier, so use Atlas.

1. Go to <https://www.mongodb.com/cloud/atlas> → sign up → **Create a cluster**.
2. Choose the **M0 (Free)** tier. Pick the region closest to your Railway region.
3. **Security → Database Access → Add New Database User.**
   - Username: `bettingbazaar`
   - Password: click **Autogenerate Secure Password** and **copy it somewhere safe now** — Atlas will not show it again.
   - Role: **Read and write to any database**.
4. **Security → Network Access → Add IP Address → Allow access from anywhere**
   (`0.0.0.0/0`).
   Railway does not publish fixed egress IPs, so this is required. It is
   acceptable for staging because the database still requires the username and
   password. For production, see the Hetzner plan — there you run Mongo inside a
   private network and this hole closes.
5. **Database → Connect → Drivers** → copy the connection string. It looks like:

   ```
   mongodb+srv://bettingbazaar:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

6. Replace `<password>` with the password from step 3. **Keep this string** — it
   is your `MONGODB_URI`.

**Check it worked:** Atlas shows your cluster as green/active, and the
connection string contains `mongodb+srv://` and your real password.

---

## 2. Cloudflare R2 — file storage

The app **refuses to start in production without S3 storage configured.** It
will not fall back to local disk, because local disk is lost on every redeploy
and is not shared between instances — which would silently lose KYC documents.

1. Cloudflare dashboard → **R2** → **Create bucket**.
   - Name: `bettingbazaar-staging`
2. **R2 → Manage R2 API Tokens → Create API Token.**
   - Permission: **Object Read & Write**
   - Scope it to the bucket you just made.
3. Copy the three values it shows you:
   - **Access Key ID** → this is `S3_ACCESS_KEY`
   - **Secret Access Key** → this is `S3_SECRET_KEY`
   - **Endpoint** → this is `S3_ENDPOINT`, and looks like
     `https://<account-id>.r2.cloudflarestorage.com`

**Check it worked:** you have four values — bucket name, access key, secret key,
and an endpoint URL starting with `https://`.

---

## 3. Railway project and databases

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** →
   pick `tezerports-dot/bettingbazaar`.
   Railway reads `railway.json` and `nixpacks.toml` automatically — Node 22,
   builds all three panels, starts `node backend/server.js`, healthcheck
   `/health`.
2. The first build **will fail or the app will report unhealthy**. That is
   expected — there are no environment variables yet. Continue.
3. In the same project: **New → Database → Add PostgreSQL**.
4. **New → Database → Add Redis**.
5. Do **not** add Railway's MongoDB. You are using Atlas (step 1).

**Check it worked:** your project shows three boxes — your app, Postgres, Redis.

---

## 4. Generate your secrets

Four secrets must each be **random and at least 32 characters**. The app refuses
to boot in production if any is short or a recognisable placeholder — this is
deliberate, because a guessable signing key lets anyone forge a login session.

Run this **four times** on your computer (macOS/Linux Terminal), and keep the
four different outputs:

```bash
openssl rand -base64 48
```

No terminal? Use <https://generate-secret.vercel.app/48> and refresh for each
one.

Assign one output to each of:

- `JWT_SECRET`
- `ORDER_HMAC_SECRET`
- `AADHAAR_HMAC_SECRET`
- `METRICS_TOKEN`

**Never reuse one value for two variables**, and never commit them to GitHub.

---

## 5. Environment variables

Railway → your **app** service → **Variables** → **Raw Editor**. Paste the
block below, then replace every `REPLACE_ME`.

`${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}` are Railway *reference
variables* — type them exactly as shown and Railway substitutes the real
connection strings automatically. If you named the plugins something other than
`Postgres` and `Redis`, use your names.

```bash
NODE_ENV=production

# --- Databases (Postgres and Redis are Railway references; Mongo is Atlas) ---
MONGODB_URI=REPLACE_ME_ATLAS_CONNECTION_STRING
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}

# --- Secrets: four DIFFERENT outputs of `openssl rand -base64 48` ---
JWT_SECRET=REPLACE_ME
ORDER_HMAC_SECRET=REPLACE_ME
AADHAAR_HMAC_SECRET=REPLACE_ME
METRICS_TOKEN=REPLACE_ME

# --- Cloudflare R2 (all four are required; boot fails without any one) ---
S3_BUCKET_NAME=bettingbazaar-staging
S3_ACCESS_KEY=REPLACE_ME
S3_SECRET_KEY=REPLACE_ME
S3_ENDPOINT=REPLACE_ME_https://<account-id>.r2.cloudflarestorage.com

# --- Public origins. No trailing slash. Must be https in production. ---
# Fill these in AFTER step 6 tells you your domain, then redeploy.
ALLOWED_ORIGINS=REPLACE_ME_https://your-app.up.railway.app
PUBLIC_APP_ORIGIN=REPLACE_ME_https://your-app.up.railway.app
PUBLIC_APP_ALLOWED_ORIGINS=REPLACE_ME_https://your-app.up.railway.app
```

### Rules that will bite you

- **No trailing slash.** `https://x.railway.app/` is rejected;
  `https://x.railway.app` is accepted.
- **Must be `https://`** — plain `http://` is rejected when `NODE_ENV=production`.
- **Secrets ≥ 32 characters**, not `change-me` or similar.

Full reference for every variable, including optional ones:
`docs/governance/ENV.md`.

---

## 6. Deploy and get your domain

1. **Settings → Networking → Generate Domain.** Railway gives you something like
   `bettingbazaar-production-a1b2.up.railway.app` and terminates TLS for you.
2. Go back to **Variables** and put that domain — with `https://`, no trailing
   slash — into all three origin variables from step 5.
3. **Deploy** (Railway redeploys automatically when variables change).

---

## 7. Verify it actually works

Wait for the deploy to finish, then in your browser or terminal:

```bash
curl -i https://YOUR-DOMAIN/health
```

**What you want:**

```
HTTP/1.1 200 OK
{"status":"healthy","ready":true,"mongodb":"connected","redis":"connected",...}
```

**Two other answers and what they mean:**

| Response | Meaning | Do this |
|---|---|---|
| `503` with `"mongodb":"disconnected"` | App is running fine; it cannot reach MongoDB | Check `MONGODB_URI` password, and that Atlas Network Access allows `0.0.0.0/0` |
| Connection refused / no response | App is not running at all | Open **Deploy Logs** — the reason is printed there. See troubleshooting below |

`/health` is a **readiness** check: it returns 503 until MongoDB attaches, by
design. `/health/live` returns 200 as soon as the process is alive, and is the
right probe for "is the process up at all".

Then check the panels load:

- `https://YOUR-DOMAIN/` — user panel
- `https://YOUR-DOMAIN/admin` — admin panel
- `https://YOUR-DOMAIN/merchant` — merchant panel

---

## 8. Troubleshooting: the errors you will actually hit

These are the real failure messages, with the cause.

**`FATAL: missing required environment variable(s)`**
Exactly what it says, and it lists them. Add them and redeploy. This gate lists
all 14 required variables; if it passes, you have them all.

**`FATAL: production storage requires a fully configured S3-compatible provider`**
You set `S3_BUCKET_NAME` but not all of `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`S3_ENDPOINT`. All four are required.

**`FATAL: JWT_SECRET, ... must each be a non-placeholder secret of at least 32 characters`**
One of your four secrets is too short or is a known placeholder. Regenerate.

**`FATAL: invalid public application origin configuration`**
A trailing slash, a missing `https://`, or a path on the end of
`PUBLIC_APP_ORIGIN` / `PUBLIC_APP_ALLOWED_ORIGINS`.

**`Transaction numbers are only allowed on a replica set member or mongos`**
You are pointing at a single-node MongoDB. Use Atlas. See step 1.

**Health check shows 503 for several minutes after a deploy**
Normal on a cold start: the app retries MongoDB for up to ~5.75 minutes.
`healthcheckTimeout` is set to 360s in `railway.json` to accommodate this. If it
is still 503 after that, it is a real connection problem — check Atlas.

**`MongooseError: Operation ... buffering timed out after 10000ms` repeating in logs**
The scheduled jobs tick before MongoDB attaches, so these appear during startup
and stop once it connects. Harmless during boot; a problem if they continue.

---

## 9. Logs, backups, monitoring

**Logs.** Railway → your service → **Deployments → View Logs**. Two streams
matter: *Build Logs* (npm install / panel builds) and *Deploy Logs* (everything
the running app prints, including all the FATAL messages above).

**Postgres backups.** Railway → Postgres service → **Backups**. Enable daily.

**MongoDB backups.** Atlas M0 free tier has **no automated backups.** For
staging that is acceptable. Before real money, upgrade to M10+ (which has
continuous backup) or move to the Hetzner plan.

**Metrics.** The app exposes Prometheus metrics at `/metrics`, protected by the
`METRICS_TOKEN` you generated:

```bash
curl -H "Authorization: Bearer YOUR_METRICS_TOKEN" https://YOUR-DOMAIN/metrics
```

Nothing scrapes this yet on Railway — it is wired for the Prometheus/Grafana
stack in the production plan.

---

## 10. Before you point real money at this

Staging on Railway is for finding functional bugs, not for taking deposits.

- Railway deploys are **replace, not rolling** — every deploy drops connections.
- Atlas M0 has no backups and no point-in-time recovery.
- `0.0.0.0/0` on Atlas Network Access is a staging-only compromise.
- Money authority is still MongoDB. Do **not** set any `MONEY_AUTHORITY_*`
  variable to `postgres` on Railway; that cutover is gated on reconciliation
  evidence (`docs/governance/LAUNCH_READINESS.md` §E).
- Legal/compliance gates in `LAUNCH_READINESS.md` §G are unrelated to
  infrastructure and still apply.
