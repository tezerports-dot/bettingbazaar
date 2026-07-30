# Go live — a VPS launch you can do yourself

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

Written for someone who does not write code. Every command is copy-paste. When
something can go wrong, it says what the failure looks like, so you can tell a
real problem from a normal message.

**Time:** about 90 minutes if DNS is ready. **Cost:** $15–20/month.

---

## Before you start — read this page only

Three things determine whether tomorrow morning goes well.

**1. Buy the right product.** You need a **VPS**, not web hosting. On Hostinger
that means "VPS Hosting", not "Web Hosting" — hPanel manages both, but only the
VPS gives you a real server. Choose **KVM 2 (8 GB RAM) or larger**, Ubuntu 24.04,
and pick the **Docker** template if offered. Shared/cPanel hosting cannot run
this app at all: it has no MongoDB, and MongoDB is not optional here.

**2. Point your domain at the server first.** In your domain registrar's DNS
settings, create an **A record** pointing to your VPS's IP address. Do this
*before* Step 4 — the HTTPS certificate is issued by proving you control the
domain, and that check fails if DNS is not live yet. DNS can take 5 minutes or
a few hours. Check it with `nslookup yourdomain.com` — it must show your VPS IP.

**3. Two secrets you can never recover.** `TOTP_ENCRYPTION_KEY` (Step 3) and
your Android signing keystore. Lose either and there is no recovery path — not
by support ticket, not by reinstalling. Save both to a password manager *and*
somewhere offline, the day you create them.

> **One thing that is not technical.** Your repository's own launch checklist
> (`docs/governance/LAUNCH_READINESS.md` §G) treats a gambling licence and an
> AML/KYC programme as requirements before accepting real money, alongside a
> third-party security test. That is a business decision and it is yours — this
> page cannot make it for you, and it will not remind you again.

---

## Step 1 — Connect to your server

From Hostinger's hPanel, find your VPS's **IP address** and **root password**.
Then on your own computer open Terminal (Mac) or PowerShell (Windows):

```bash
ssh root@YOUR_SERVER_IP
```

Type `yes` if it asks about authenticity, then the password. Nothing appears
while you type a password — that is normal, keep typing and press Enter.

**You are now typing commands on the server, not your own computer.**

## Step 2 — Install Docker and download your code

Copy this whole block at once and press Enter. It takes 2–3 minutes.

```bash
apt update && apt upgrade -y
apt install -y git curl
curl -fsSL https://get.docker.com | sh
```

Verify Docker is alive — this must print a version number:

```bash
docker --version
```

Now download your code:

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/tezerports-dot/bettingbazaar.git
cd bettingbazaar/deploy/vps
```

If the repository is private, git will ask for a username and password — use
your GitHub username and a **Personal Access Token** (GitHub → Settings →
Developer settings → Personal access tokens), not your account password.

## Step 3 — Generate your secrets

You need six random secrets. This prints all six at once, already labelled:

```bash
echo "JWT_SECRET=$(openssl rand -base64 48)"
echo "ORDER_HMAC_SECRET=$(openssl rand -base64 48)"
echo "AADHAAR_HMAC_SECRET=$(openssl rand -base64 48)"
echo "METRICS_TOKEN=$(openssl rand -base64 48)"
echo "POSTGRES_PASSWORD=$(openssl rand -base64 48)"
echo "TOTP_ENCRYPTION_KEY=$(openssl rand -base64 32)"
```

**Copy that entire output into a password manager now**, before continuing.
Save `TOTP_ENCRYPTION_KEY` twice — password manager *and* somewhere offline.

## Step 4 — Fill in your settings

```bash
cp .env.template .env
chmod 600 .env
nano .env
```

`nano` is a text editor inside the terminal. Arrow keys move, typing edits.
Work top to bottom and replace every value marked **FILL IN**, pasting the
secrets you just generated.

**Three formatting rules that break things silently:**
- No spaces around `=` — `JWT_SECRET=abc`, never `JWT_SECRET = abc`
- No quotes around values
- **Never put a `#` comment on the same line as a value** — the text after it
  can end up inside the value

Save and exit: **Ctrl+O**, Enter, then **Ctrl+X**.

For file storage, the template is set up for **Cloudflare R2** (recommended —
your customers' KYC documents then survive this server dying). Create a bucket
and API token at `dash.cloudflare.com` → R2. If you would rather start simpler,
follow Option B in the file to use storage on this server instead.

## Step 5 — Start it

**If you chose Cloudflare R2 (Option A):**

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

**If you chose MinIO on this server (Option B):**

```bash
docker compose -f docker-compose.prod.yml --profile minio up -d --build
```

First run takes 5–10 minutes — it is building your three panels from source.
Lots of scrolling text is normal.

Then check everything is running:

```bash
docker compose -f docker-compose.prod.yml ps
```

Every service should say `running`. **Except `mongo-init` and `minio-init`,
which should say `exited (0)`** — those are one-time setup jobs, and `exited (0)`
means they finished successfully. That is correct, not an error.

## Step 6 — Confirm it is actually working

```bash
curl -s https://YOURDOMAIN.com/health/ready
```

You want to see `"status":"ready"`.

Then open `https://yourdomain.com` in a browser. You should see your site with a
padlock in the address bar.

**Now the five checks that prove it really works.** Do all five — each one
catches a different failure that looks fine from the outside:

1. **Log in, then refresh the page.** If you get logged out, HTTPS is not
   working properly — the browser is throwing away your session.
2. **Watch a game cycle count down and change.** Proves the scheduler and the
   live connection are both working.
3. **Open the admin panel** at `https://yourdomain.com/admin/` and leave it open
   for two minutes. If it stays connected, the live admin feed is working.
4. **Open the merchant panel** at `https://yourdomain.com/merchant/`.
5. **Upload something** — a KYC document or a branding image. Proves storage.

If any fail, go to Troubleshooting below.

## Step 7 — Secure it

```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
```

Your databases were never exposed — they run on a private Docker network with
no public ports — but this closes everything else.

## Step 8 — First login, immediately

1. Go to `https://yourdomain.com/admin/`
2. Log in with `DEFAULT_ADMIN_MOBILE` / `DEFAULT_ADMIN_PASSWORD` from Step 4
3. **Change the password right away**
4. **Set up 2FA** — scan the QR code with Google Authenticator or Authy
5. **Save the recovery codes it shows you.** They appear once. Without them, a
   lost phone locks you out of your own platform permanently.
6. Blank out `DEFAULT_ADMIN_PASSWORD` in `.env`, then:
   `docker compose -f docker-compose.prod.yml up -d`

---

## Running it day to day

```bash
cd /opt/bettingbazaar/deploy/vps

# Watch what's happening (Ctrl+C to stop watching)
docker compose -f docker-compose.prod.yml logs -f api

# Restart everything
docker compose -f docker-compose.prod.yml restart

# Deploy new code
cd /opt/bettingbazaar && git pull
cd deploy/vps && docker compose -f docker-compose.prod.yml up -d --build

# Check disk space (do this weekly — a full disk stops everything)
df -h
```

### Back up your data — this is the one that saves your business

Set this to run nightly:

```bash
mkdir -p /opt/backups
cat > /opt/backup.sh <<'EOF'
#!/bin/bash
cd /opt/bettingbazaar/deploy/vps
D=$(date +%F)
docker compose -f docker-compose.prod.yml exec -T mongo \
  mongodump --archive --quiet > /opt/backups/mongo-$D.archive
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U bb bettingbazaar > /opt/backups/pg-$D.sql
find /opt/backups -type f -mtime +14 -delete
EOF
chmod +x /opt/backup.sh
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/backup.sh") | crontab -
```

**A backup on the same server is not a backup.** If the server dies, they die
with it. Copy `/opt/backups` somewhere else — your own computer weekly at
minimum. And once, before you need it, **restore a backup onto a test server**.
An untested backup is a guess.

---

## Troubleshooting

**Containers keep restarting.** Read the reason:
```bash
docker compose -f docker-compose.prod.yml logs api | tail -50
```
A line containing `FATAL` or `Refusing to start` tells you exactly which setting
is wrong. That is the app protecting you from running misconfigured — fix the
value in `.env`, then `up -d` again.

**No padlock / certificate errors.** Your DNS is not pointing here yet:
```bash
nslookup yourdomain.com          # must show your VPS IP
docker compose -f docker-compose.prod.yml logs caddy | tail -30
```
Fix DNS, wait, then `docker compose -f docker-compose.prod.yml restart caddy`.

> Let's Encrypt allows only **5 failed attempts per domain per hour**. If you
> hit that, waiting an hour is the only fix. Get DNS right first.

**Login appears to work but you get logged out on refresh.** HTTPS is not
working end to end. Do not work around this — the session cookie requires a
valid certificate. Fix the certificate.

**"No space left on device".** `df -h`, then:
```bash
docker system prune -a          # removes old unused images
```

**Everything is slow.** `docker stats` shows what's consuming resources. If RAM
is consistently full, upgrade the VPS plan in hPanel — you can resize up without
losing data.

---

## Multiple domains

Your codebase supports several domains serving the same site — useful if one
gets blocked or expires.

1. Point each new domain's DNS A record at this server.
2. **Wait for DNS to resolve** (`nslookup newdomain.com`).
3. Add it to `.env` — space separated in `SITE_ADDRESS`, comma separated in the
   other three:
   ```
   SITE_ADDRESS=example.com www.example.com backup.com
   ALLOWED_ORIGINS=https://example.com,https://www.example.com,https://backup.com
   PUBLIC_APP_ALLOWED_ORIGINS=https://example.com,https://www.example.com,https://backup.com
   VITE_API_FALLBACK_URLS=https://backup.com
   ```
4. `docker compose -f docker-compose.prod.yml up -d`

Caddy gets a certificate for each one automatically. Every domain serves exactly
the same site — this is redundancy, not different sites, and there is no
per-domain behaviour anywhere in the code.

Setting `CANONICAL_HOST=example.com` sends all other domains to that one
(better for Google). Leave it unset to keep them equal.

---

## Before you scale up

Two ceilings that **buying a bigger server will not move**:

1. **Logins cap around 50/second per process.** Password hashing is deliberately
   slow, which is what makes stolen passwords hard to crack. Normally invisible —
   but sign-ins cluster hard after a promotion or a push notification.

2. **The betting ceiling.** Every bet on a cycle updates the *same* database
   record. Bet #2 waits for bet #1. **Adding servers does not help** — they all
   queue on the same record. Nobody knows where that limit is on your setup.

Your repository already contains the test that answers #2:
`loadtest/bet-contention.js`, built for exactly this question and **never run**.
Run it against a test copy — never production, it places real bets — before you
promise anyone a user number:

```bash
npm run loadtest:seed          # creates throwaway funded test users
npm run loadtest:bets          # needs k6 installed
```

Read the result: plot response time against bets/second. It stays flat, then
bends sharply. **That bend is your real capacity.** Until you have it, any user
number is a guess.

---

**Related:** `deploy/VPS_UBUNTU_SETUP.md` (manual setup without Docker) ·
`docs/governance/ENV.md` (every setting explained) ·
`docs/governance/LAUNCH_READINESS.md` (what is not code) ·
`loadtest/README.md` (capacity testing)
