# Launch plan — test on Railway, run on Hetzner

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

Two stages, deliberately. **Railway proves the software works** — you walk the
whole money loop with real clicks and find what is broken while nothing is at
stake. **Hetzner runs the business** — same image, your hardware, your data.

Doing it in that order costs you about two hours and removes the worst launch
day there is: the one where the site is live, money is moving, and you cannot
tell whether the problem is the server, the database or the code.

> **Not covered here, and not optional:** a gambling licence and an AML/KYC
> programme for every jurisdiction you accept players from
> (`docs/governance/LAUNCH_READINESS.md` §G). This document gets the software
> running correctly. It cannot make running it lawful.

---

## Stage 1 — Railway, for one day only

**Why Railway first.** You click to add MongoDB, PostgreSQL and Redis; no server
administration at all. You will find the same bugs you would find on Hetzner,
without also debugging Docker, DNS and firewalls at the same time.

**Why not to stay.** Railway's terms prohibit gambling. You can be terminated
with your data inside. Treat it as a staging environment with a deadline.

### Steps

1. **railway.app** → sign in with GitHub → **New Project** → **Deploy from GitHub repo**
2. Leave the root directory at the repository root — `railway.json` drives the build.
3. **+ New** → **Database** → add **MongoDB**, **PostgreSQL** and **Redis** (three separate adds).
4. **Variables** tab. Paste the values from `deploy/vps/.env.template`, with these
   Railway-specific substitutions:
   - `MONGODB_URI` → Railway's Mongo connection string, **plus `?replicaSet=rs0`** if it offers one. If Railway's Mongo is standalone, money transactions degrade to non-atomic — acceptable for a one-day test, never for Hetzner.
   - `DATABASE_URL` → Railway's PostgreSQL string
   - `REDIS_URL` → Railway's Redis string
   - `PUBLIC_APP_ORIGIN`, `ALLOWED_ORIGINS`, `APP_BASE_URL` → the `*.up.railway.app` URL Railway gives you
   - `TRUST_PROXY=1`
   - Object storage: create a **Cloudflare R2** bucket now and use it for both stages. It is a few dollars a month and your KYC documents outlive both servers.
5. Deploy. Watch the log. **A `FATAL:` line naming a variable is the boot gate
   doing its job** — fix that variable, redeploy.

### The money loop — this is the actual point of Stage 1

Do all seven, in order, with real clicks. This is the end-to-end verification
that no amount of code review substitutes for.

| # | Action | What it proves |
|---|---|---|
| 1 | Register a player, log in, refresh the page | Auth + session cookie over HTTPS |
| 2 | Approve your own KYC from the admin panel | Admin auth, 2FA, KYC queue |
| 3 | Create a merchant, fund its token balance | Merchant onboarding + wallet |
| 4 | Player deposit → merchant accepts → merchant confirms | **Buy path.** Player's balance rises by the deposit/reserve split |
| 5 | Place a bet, wait for the cycle to settle | Cycle engine, scheduler, settlement, payout |
| 6 | Player withdraw → merchant accepts → merchant confirms | **Sell path.** Order goes to **PAID**, *not* COMPLETED |
| 7 | Wait out the hold, confirm it settles by itself | The withdrawal hold worker |

**Then test the case the hold exists for.** Repeat 6, and *before* the hold
expires raise a dispute as the player and resolve it **for the player** in admin.
Expected: the player's tokens come back and the merchant is credited nothing.
That is your protection against a merchant who claims payment without sending
it — verify it with your own eyes before real money is involved.

**Also check the player can see status the whole way through.** Wallet →
transaction history should show each order moving PENDING_QUEUE → ASSIGNED →
PROCESSING → PAID → COMPLETED, and a held withdrawal should read as settling,
not as done.

If all of that passes, the software works. Move to Hetzner.

---

## Stage 2 — Hetzner

### What to buy for a real launch

Ignore the DAU number when sizing the first box — nobody arrives at 50,000 on
day one, and buying for it wastes money you will want for the second box.

| Stage | Server | ~Cost/mo |
|---|---|---|
| **Launch → first few thousand daily players** | Hetzner **CPX41** (8 vCPU, 16 GB, 240 GB) | ~€30 |
| Smaller start, if you prefer | **CPX31** (4 vCPU, 8 GB, 160 GB) | ~€16 |
| Object storage | Cloudflare R2 | ~$1–5 |
| **Total to launch** | | **~€35/mo** |

Take **CPX41** if you can. Everything runs on one box at this stage — app,
MongoDB, PostgreSQL, Redis — and 16 GB is the difference between comfortable and
tuning memory in week one. Prices change; check before buying.

Pick **Falkenstein or Nuremberg** for European players, **Ashburn** for lower
latency to India than the EU. Whichever you pick, **the app and its databases
must stay in the same region** — every bet makes five to six sequential database
round trips, so a cross-region hop multiplies straight into bet latency
(`docs/governance/LATENCY.md`).

### Deploy

Follow **`deploy/vps/GO_LIVE.md`** exactly — it is written step by step for a
non-developer, with the expected output at each stage.

Reuse the same `.env` you validated on Railway, changing only the three database
URLs (now `mongo:27017`, `postgres:5432`, `redis:6379` inside Docker) and the
domain values. Keep the same R2 bucket and the same secrets, so you are running
the configuration you already proved.

**Point your DNS A record at the server before you start.** Let's Encrypt allows
five failed certificate attempts per hostname per hour, and wrong DNS is the
single most likely way launch morning stalls.

### Before you take real money

- Change the seeded admin password, enrol 2FA, **save the recovery codes**
- Set the nightly backup cron from `GO_LIVE.md`, and copy `/opt/backups` off the server
- Put a Slack or Discord webhook in `ALERT_WEBHOOK_URL` — money-path failures page you there, and blank means nothing tells you
- Create a Turnstile site and set `TURNSTILE_SECRET_KEY` + `VITE_TURNSTILE_SITE_KEY` to switch on bot protection
- Back up `TOTP_ENCRYPTION_KEY` off the server. It has no rotation path: lose it and every admin re-enrols 2FA, with nobody able to sign in meanwhile

---

## Growing: what changes, and when

Scale on measurement, not on the number in your business plan. **Run
`loadtest/bet-contention.js` against a staging copy in week one** — it measures
the one ceiling that hardware cannot move, and it has never been run.

| Daily players | What to do | ~Cost/mo |
|---|---|---|
| 0 – 5,000 | One CPX41. Nothing to change. | ~€35 |
| 5,000 – 25,000 | Bigger box (CCX33, dedicated vCPU). Watch `df -h` and `docker stats`. | ~€65 |
| 25,000 – 100,000 | **Split the databases off the app.** Managed MongoDB replica set (Atlas M30+), managed Redis, managed Postgres. App stays on one or two boxes. | ~€300–600 |
| 100,000 – 1,000,000 | Multiple app servers behind a load balancer. See below. | €1,500+ |

### Scaling horizontally — already built, mostly configuration

Your app tier holds no state, which is what makes this possible:

- **More app servers.** Run several with `BB_RUNTIME_ROLE=api` behind a load balancer. Rate-limit counters and realtime fan-out are already shared through Redis, so instances stay consistent. `deploy/k8s/deployment.yaml` scales API 3→30 and realtime 2→40 automatically.
- **Exactly one scheduler.** `BB_RUNTIME_ROLE=scheduler` runs the cycle engine and crons. Never run two.
- **Database read replicas.** Routing code is written (`readPreference.service.js`); it needs replicas to point at.
- **Postgres partitioning.** Migration already in the repo, apply at millions of rows/month.

**The one thing that needs a code change** is the cycle pool contention — every
bet on a cycle updating the same record. That fix is already written and sitting
behind `FEATURE_DERIVED_CYCLE_POOLS`, **off**. Turn it on only when the load test
says you are hitting the ceiling.

### Two ceilings extra servers will not move

1. **Logins cap near 50/second per process.** Password hashing is deliberately slow. Raise `UV_THREADPOOL_SIZE` (costs ~19 MiB RAM per thread) or add app servers.
2. **The cycle record.** Every bet on a cycle writes the same row, so bet #2 waits for bet #1 — and more servers all queue on the same row. The derived-pools flag is the fix; the load test tells you when you need it.

---

## Answering the question directly

**Can this be live tomorrow?** The software, yes — Railway in the morning,
Hetzner in the afternoon. **A licensed real-money operation, no**, and that gap
is legal rather than technical.

**A sensible middle path:** launch with deposits and withdrawals disabled, or
open only to accounts you control. You prove the deployment, the cycles, the
merchant flow and realtime under genuine conditions, without accepting public
money before the licence is in place.

---

**See also:** `deploy/vps/GO_LIVE.md` (the step-by-step VPS install) ·
`docs/governance/LAUNCH_READINESS.md` (what is not code) ·
`docs/governance/LATENCY.md` (where the ceilings are) · `loadtest/README.md`
