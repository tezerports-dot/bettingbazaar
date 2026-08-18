# Single-VPS deployment — Ubuntu 22.04 / 24.04 LTS

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

Provisions the whole platform on one Ubuntu box: Node 22, MongoDB 7 as a
single-node replica set, PostgreSQL 18 + pgvector, Redis, MinIO (S3-compatible),
PM2 with the three runtime roles, and NGINX terminating TLS in front.

**Read §0 first.** Four things about this codebase will stop a generic Node
deployment dead, and all four fail *after* you think you are finished.

> **This is an engineering runbook, not a licence.** A real-money launch needs a
> gambling licence, an AML/KYC programme and a third-party pen test first —
> `docs/governance/LAUNCH_READINESS.md` §G. Nothing here substitutes for that.

---

## 0. The four things that will bite you

**1. The boot gate is a hard gate.** `backend/startup/validateEnv.js` refuses to
start in production unless **all eleven** required variables are present, and
holds the signing secrets to ≥32 non-placeholder characters. A missing one is a
fatal throw at boot, not a warning. The full list is in §7.

**2. Object storage is mandatory in production.** `backend/server.js` throws
`FATAL: production storage requires a fully configured S3-compatible provider;
refusing local-disk fallback.` unless `S3_BUCKET_NAME`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY` **and** `S3_ENDPOINT` are all set. "Single VPS" therefore means
running MinIO on the same box (§6) or pointing at an external bucket (R2, B2,
Vultr, iDrive e2). There is no local-disk production mode.

**3. You need TLS before you can log anyone in.** In production the session
cookie is `secure: true, sameSite: 'none'` (`backend/routes.js`). Browsers reject
`SameSite=None` without `Secure`, and reject `Secure` cookies over `http://`.
Over plain HTTP the login returns `200 OK` and the cookie is silently discarded —
you will chase a "login does nothing" bug that is entirely the missing
certificate. The boot gate also requires `PUBLIC_APP_ORIGIN` to be an **https**
origin in production, so you need a real domain and a certificate before the
process will start at all. Port 80 alone is not a valid deployment.

**4. `TRUST_PROXY` must be set behind NGINX.** Unset, `req.ip` is `127.0.0.1` for
every visitor, so every per-IP control — the rate limiters, `ipDefense`, audit
logs — applies **one shared budget to your entire user base**. Four wrong
passwords from any one person locks out login for everybody.

---

## 1. Base packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl gnupg lsb-release ca-certificates build-essential git ufw
```

`build-essential` is not optional — `argon2` compiles a native addon.

**Sizing.** Argon2id holds ~19 MiB per concurrent hash on the libuv threadpool
(default 4 threads), so budget ≥2 GB RAM for the app alone before MongoDB,
Postgres, Redis and MinIO. On a 2 GB box add swap:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Node 22 + PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x

sudo npm install -g pm2
```

Run PM2 as your **deploy user**, never as root — `sudo pm2` creates a second
daemon under root, and a later `pm2 save` as your own user then saves an empty
process list. Set up boot persistence after the apps are running (§9).

## 3. MongoDB 7 — single-node replica set

Money transactions require a replica set, even with one member.

> **Ubuntu 24.04:** MongoDB 7.0's apt repository has no `noble` suite. Pin
> `jammy` on 24.04; `$(lsb_release -cs)` is correct on 22.04 only.

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor

# 22.04 → jammy · 24.04 → also jammy (no noble suite exists for 7.0)
MONGO_SUITE=jammy
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${MONGO_SUITE}/mongodb-org/7.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list

sudo apt update && sudo apt install -y mongodb-org
```

Enable replication in `/etc/mongod.conf` and confirm the bind address is loopback:

```yaml
net:
  bindIp: 127.0.0.1

replication:
  replSetName: "rs0"
```

```bash
sudo systemctl enable --now mongod
```

**Initialise with an explicit member address.** A bare `rs.initiate()` registers
the machine's hostname; the driver then reads that config back and tries to
reach a name that may not resolve, and every connection fails with "no primary"
even though `mongod` is healthy:

```bash
mongosh --eval 'rs.initiate({_id:"rs0", members:[{_id:0, host:"127.0.0.1:27017"}]})'
mongosh --eval 'rs.status().ok'   # → 1
```

## 4. PostgreSQL 18 + pgvector

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt update
sudo apt install -y postgresql-18 postgresql-contrib-18 postgresql-18-pgvector
sudo systemctl enable --now postgresql
```

```bash
sudo -u postgres psql <<'SQL'
CREATE USER bb_user WITH PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';
CREATE DATABASE bb_money OWNER bb_user;
\c bb_money
CREATE EXTENSION IF NOT EXISTS vector;
SQL
```

Named `bb_money`, not `bb_shadow` — Postgres is a shadow *today*, but the whole
point of the cutover machinery is that it stops being one
(`docs/governance/LAUNCH_READINESS.md` §E). A database name that becomes a lie
after the flip is a bad name.

`pgvector` is only needed if you enable the RAG support assistant. Creating the
extension now costs nothing and saves a later migration.

The app connects with **`DATABASE_URL`**, a single connection string.
`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` are read by **nothing** in
this codebase — `backend/postgres/pgClient.js` reads `process.env.DATABASE_URL`
and nothing else. A `127.0.0.1` URL disables TLS automatically (`resolvePgSsl`),
which is correct for a loopback connection.

## 5. Redis

```bash
sudo apt install -y redis-server
sudo sed -i 's/^supervised .*/supervised systemd/' /etc/redis/redis.conf
grep -E '^bind ' /etc/redis/redis.conf     # expect: bind 127.0.0.1 ::1
sudo systemctl restart redis-server && sudo systemctl enable redis-server
redis-cli ping   # PONG
```

Redis is not optional above one process. Rate-limit counters, the cron leader
lock and the realtime fan-out bridge all share state through it, and you are
running three processes.

## 6. MinIO — the S3-compatible bucket (see §0.2)

Skip only if you are using an external S3 provider.

```bash
wget https://dl.min.io/server/minio/release/linux-amd64/minio -O /tmp/minio
sudo install -m 755 /tmp/minio /usr/local/bin/minio
sudo useradd -r -s /sbin/nologin minio-user || true
sudo mkdir -p /var/lib/minio && sudo chown minio-user: /var/lib/minio

sudo tee /etc/default/minio >/dev/null <<'EOF'
MINIO_VOLUMES="/var/lib/minio"
MINIO_OPTS="--address 127.0.0.1:9000 --console-address 127.0.0.1:9001"
MINIO_ROOT_USER=REPLACE_ME
MINIO_ROOT_PASSWORD=REPLACE_ME_STRONG
EOF
sudo chmod 600 /etc/default/minio
```

Create a systemd unit (upstream publishes `minio.service`), start it, then create
the bucket with `mc`. Keep MinIO on loopback — NGINX does not need to expose it
unless you serve user uploads directly from it, in which case front it on a
separate subdomain rather than widening this vhost.

## 7. Clone, build, and place the panel bundles

```bash
sudo mkdir -p /var/www && cd /var/www
sudo git clone <your-repo-url> bettingbazaar
sudo chown -R "$USER:$USER" /var/www/bettingbazaar
cd /var/www/bettingbazaar

npm ci --legacy-peer-deps
npm run install:panels
npm run build          # builds user, admin and merchant
```

**`--legacy-peer-deps` is required**, and `npm run install:panels` already applies
it to all three panels. Every install path in this repo uses it — CI, the
Dockerfile, the README. A plain `npm ci` fails on peer conflicts.

**Then place the user-panel bundle where the server actually looks for it.**
`backend/server.js` serves the player app from `path.join(__dirname, '../dist')`
— that is the **repository root** `dist/`, not `user-panel/dist`. Admin and
merchant are served from `../admin-panel/dist` and `../merchant-panel/dist`,
which the build already produces, so only the user panel needs this:

```bash
ln -sfn user-panel/dist /var/www/bettingbazaar/dist
```

(The Dockerfile does the same thing with `COPY --from=builder
/app/user-panel/dist ./dist`. Without it the player app 404s while the other two
panels work — a confusing failure to diagnose.)

## 8. Environment

```bash
cd /var/www/bettingbazaar
cp .env.example .env      # the annotated full reference
nano .env
```

Generate every secret with `openssl rand -base64 48` (32 for
`TOTP_ENCRYPTION_KEY`). **All eleven required variables must be present or the
process will not boot** (`backend/startup/validateEnv.js`):

```ini
NODE_ENV=production
PORT=3000

# ── Required: the boot gate throws without these ────────────────────────────
JWT_SECRET=<openssl rand -base64 48>
MONGODB_URI=mongodb://127.0.0.1:27017/bettingbazaar?replicaSet=rs0
DATABASE_URL=postgresql://bb_user:PASSWORD@127.0.0.1:5432/bb_money
ORDER_HMAC_SECRET=<openssl rand -base64 48>
AADHAAR_HMAC_SECRET=<openssl rand -base64 48>
REDIS_URL=redis://127.0.0.1:6379
ALLOWED_ORIGINS=https://yourdomain.com
S3_BUCKET_NAME=bettingbazaar
METRICS_TOKEN=<openssl rand -base64 48>
PUBLIC_APP_ORIGIN=https://yourdomain.com
PUBLIC_APP_ALLOWED_ORIGINS=https://yourdomain.com

# ── Required in practice: server.js throws without all four (§0.2) ──────────
S3_ENDPOINT=http://127.0.0.1:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=<minio access key>
S3_SECRET_KEY=<minio secret key>

# ── Required behind a reverse proxy (§0.4) ──────────────────────────────────
TRUST_PROXY=1

# ── 2FA. Back this up like the Android keystore — it has no _PREVIOUS_ ──────
TOTP_ENCRYPTION_KEY=<openssl rand -base64 32>

# ── First-boot admin. Change the password immediately after first login ─────
DEFAULT_ADMIN_MOBILE=9999999999
DEFAULT_ADMIN_PASSWORD=<strong temporary password>

# ── Optional but wanted on a single box ─────────────────────────────────────
APP_BASE_URL=https://yourdomain.com
ALERT_WEBHOOK_URL=
UV_THREADPOOL_SIZE=8
```

Notes that cost people hours:

- **There is no `PASETO_SECRET`.** The effective signing seed is
  `PASETO_SECRET_KEY || JWT_SECRET` (`domains/identity/jwt.util.js`). Set
  `JWT_SECRET`. A variable named `PASETO_SECRET` is read by nothing and the boot
  gate will still report `JWT_SECRET` missing.
- **`ALLOWED_ORIGINS` is browser origins only** — the panels' own URLs. Do not
  put the API URL there unless it is also a front end someone loads in a browser.
- **`TOTP_ENCRYPTION_KEY` is permanent.** It has no `_PREVIOUS_` counterpart;
  rotating it makes every stored TOTP secret undecryptable and forces every
  enrolled user to re-enrol. Back it up off the box.
- **`UV_THREADPOOL_SIZE`** — at 4 threads and ~80 ms per Argon2 verify, one
  process tops out near 50 logins/second. Raising it costs ~19 MiB of hashing
  memory per thread; benchmark rather than guessing
  (`docs/governance/LATENCY.md`).
- `chmod 600 .env`.

## 9. PM2 — the three runtime roles

**The repository already ships `ecosystem.config.cjs`.** Extend that file; do not
create `ecosystem.config.js`. The root `package.json` declares `"type": "module"`,
so a `.js` file containing `module.exports` throws
`ReferenceError: module is not defined in ES module scope` and PM2 starts
nothing.

What the roles actually do (`backend/startup/runtimeRole.js`):

| `BB_RUNTIME_ROLE` | HTTP API | Realtime (WS + SSE) | Cron + cycle engine |
|---|---|---|---|
| `all` (default) | ✅ | ✅ | ✅ |
| `api` | ✅ | ❌ — `/api/sse` 404s | ❌ |
| `realtime` | ✅ | ✅ | ❌ |
| `scheduler` | ❌ — all `/api` 404s | ❌ | ✅ |

Two consequences worth internalising: `realtime` serves the **whole** API, not
just sockets, so NGINX may send it anything; and `scheduler` still binds a
listener, so give it its own port or it will collide with `api` on 8080.

```js
// ecosystem.config.cjs — three roles on one box
module.exports = {
  apps: [
    { name: 'bb-api',       script: 'backend/server.js',
      env_production: { NODE_ENV: 'production', BB_RUNTIME_ROLE: 'api',       PORT: 3000 } },
    { name: 'bb-realtime',  script: 'backend/server.js',
      env_production: { NODE_ENV: 'production', BB_RUNTIME_ROLE: 'realtime',  PORT: 3001 } },
    { name: 'bb-scheduler', script: 'backend/server.js',
      env_production: { NODE_ENV: 'production', BB_RUNTIME_ROLE: 'scheduler', PORT: 3002 } },
  ],
};
```

**Exactly one `scheduler` process, ever.** It owns the game-cycle producer and
the cron jobs. The jobs are Redis leader-locked so a second one would not corrupt
anything, but running two is a pointless race.

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup systemd          # prints a command — RUN THE COMMAND IT PRINTS
pm2 install pm2-logrotate    # or the logs will fill the disk
```

## 10. NGINX + TLS

Get the certificate first (§0.3) — the app will not boot without an https
`PUBLIC_APP_ORIGIN`, and login is broken without a real certificate.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo rm -f /etc/nginx/sites-enabled/default
```

`/etc/nginx/sites-available/bettingbazaar`:

```nginx
upstream bb_api      { server 127.0.0.1:3000; }
upstream bb_realtime { server 127.0.0.1:3001; }

server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    # certbot fills these in
    # ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    client_max_body_size 10m;   # app caps JSON at 1m / 8m; this is the outer wall

    # KYC documents and payment proofs upload direct to the bucket via presigned
    # URLs, so large bodies never traverse this proxy.

    location / {
        proxy_pass http://bb_api;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket. proxy_read_timeout MUST be long: socket.io pings every 25s with
    # a 60s timeout, and NGINX's 60s default kills the connection right at the
    # boundary — producing intermittent drops that look like an app bug.
    location /socket.io/ {
        proxy_pass http://bb_realtime;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 24h;
        proxy_send_timeout 24h;
    }

    # SSE. Buffering off, and the same long read timeout — an admin or merchant
    # stream sits idle between events and the 60s default would cut it.
    location /api/sse/ {
        proxy_pass http://bb_realtime;
        proxy_http_version 1.1;
        proxy_set_header Connection        '';
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 24h;
    }

    # Prometheus scrape — bearer-token protected in the app, but there is no
    # reason to publish it. Restrict or delete this block.
    location /metrics { deny all; }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/bettingbazaar /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com
```

`TRUST_PROXY=1` matches exactly this shape — one proxy hop. Behind an additional
CDN, use the CIDR form (`docs/governance/ENV.md` §1). Never `TRUST_PROXY=true`:
any client can then forge `X-Forwarded-For` and impersonate an arbitrary IP.

## 11. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

MongoDB, Postgres, Redis and MinIO stay on loopback and are never opened. Verify
rather than assume:

```bash
sudo ss -tlnp | grep -E '27017|5432|6379|9000'   # every line must show 127.0.0.1
```

## 12. Verify

```bash
mongosh --eval 'rs.status().ok'                              # 1
sudo -u postgres psql -d bb_money -c '\dx'                   # vector listed
redis-cli ping                                               # PONG
pm2 status                                                   # 3 apps online
curl -s localhost:3000/health/ready | jq                     # ready: true
curl -s localhost:3001/health/ready | jq                     # ready: true
curl -sI https://yourdomain.com/                             # 200
```

Then the checks that actually prove it works end to end:

1. **Log in and confirm the session survives a refresh.** If it does not, the
   cookie is being rejected — re-read §0.3.
2. **Confirm your own IP appears in the logs**, not `127.0.0.1`. If it does not,
   `TRUST_PROXY` is wrong and your rate limits are pooled across all users (§0.4).
3. **Open the player app and watch a cycle tick** — that proves the scheduler
   process and the WebSocket path together.
4. **Open the admin panel and confirm the SSE stream stays connected past 60
   seconds** — that proves `proxy_read_timeout`.
5. **Submit a KYC document or upload an asset** — that proves the bucket.

## 13. After first boot

- **Change the seeded admin password immediately**, then enrol admin 2FA. 2FA is
  mandatory for admin and sub-admin roles and is enforced at login.
- **Restore drill.** Backups run daily to the bucket
  (`backend/services/backup.service.js`). An untested backup is not a backup —
  `docs/governance/DISASTER_RECOVERY.md` §2.
- **Point `SystemConfig.alertWebhookUrl`** at Slack or PagerDuty from System
  Settings, or money-path alerts go nowhere.
- **Scrape `/metrics`** with the `METRICS_TOKEN` bearer and import
  `deploy/grafana/bettingbazaar-dashboard.json`.
- **Run a load test before opening to real traffic.** It is a launch blocker, not
  a nice-to-have (`LAUNCH_READINESS.md` §D), and single-VPS is precisely the shape
  where the ceilings in `docs/governance/LATENCY.md` — Argon2 threadpool, the
  `Cycle` document write contention — arrive soonest.

### What a single VPS cannot give you

Honest limits, so they are decisions rather than surprises:

- **No high availability.** One box is one failure domain — the app, all four
  datastores and the proxy die together.
- **No PITR by default.** Enable Postgres WAL archiving and Mongo oplog backups
  off-box, or you can only restore to the last daily dump.
- **Backups on the same disk are not backups.** Ship the bucket off-host.
- **The Postgres money cutover is an owner decision.** By default (flags unset)
  Postgres runs as a verified shadow with reconciliation. The **current launch
  plan flips it ON** — `MONEY_AUTHORITY_*=postgres` — from day one, after the
  readiness gate passes (`docs/GO_LIVE_RUNBOOK.md` Phase 4; the gate is
  `LAUNCH_READINESS.md` §E and `npm run preflight:flip`). On a fresh database
  there is no data to migrate, which is what makes the direct flip low-risk.
- Deploying updates means downtime unless you add a second process and shift the
  upstream. The app drains gracefully on SIGTERM, so `pm2 reload` is close.

---

**See also:** `docs/governance/ENV.md` (every variable) · `.env.example`
(annotated reference) · `DEPLOYMENT.md` (platform deploys) ·
`docs/governance/LAUNCH_READINESS.md` (what is not code) ·
`docs/governance/04-GOVERNANCE.md` §21 (SRE runbooks) · `deploy/README.md`
(Docker Compose and Kubernetes)
