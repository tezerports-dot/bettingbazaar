# Go-Live Runbook — for a non-coder

This is the **ordered, do-this-then-that** guide to taking Betting Bazaar live on
a Shinjiru dedicated server, with **Postgres as the money authority from day one**
and your **built-in manual (merchant) payment system**. It does not assume you
can code. Each step says *what to do*, *why*, *what success looks like*, and
*what to do if it fails* (almost always: paste the exact error back into Claude
Code here).

Two documents carry the deep detail; this runbook tells you **when** to use them:
- `deploy/VPS_UBUNTU_SETUP.md` — every command to build the server.
- `docs/governance/ANDROID_RELEASE_SETUP.md` — the Android app / APK.

> **One thing this runbook cannot give you: the licence.** Real-money betting is
> regulated. You need a gambling licence for each country you serve, an AML/KYC
> policy, and geo-restriction to licensed countries. That is a legal task, not a
> code task, and it is cheaper to solve before launch than after. See
> `docs/governance/LAUNCH_READINESS.md` §G.

---

## The picture: what you are turning on

One Shinjiru box runs everything:

```
        Players / Merchants / Admins  (browser + Android app)
                          │  HTTPS
                    ┌─────▼─────┐
                    │   NGINX   │  TLS, one public door
                    └─────┬─────┘
             ┌────────────┼────────────┐
        bb-api        bb-realtime   bb-scheduler   (3 PM2 processes, one codebase)
             └────────────┼────────────┘
        ┌──────────┬──────┴───┬──────────┬──────────┐
     MongoDB    PostgreSQL   Redis    MinIO/R2   (all private, loopback only)
   (app data)  (THE MONEY)  (live)   (KYC files)
```

- **PostgreSQL is the money authority** (your decision). Every wallet, bet,
  order and ledger write is decided in Postgres; MongoDB keeps a live copy for
  everything else and as a fallback.
- **MongoDB is still required** and must be a **replica set** (even single-node) —
  the app uses database transactions, which a plain MongoDB refuses.
- **Payments are manual** — your merchant system. No third-party payment gateway
  is wired, and none is needed.

---

## Phase 0 — Before you touch a server

1. **Licence & legal** — see the box above. This gates everything.
2. **A domain name** you control (e.g. `yourdomain.com`) with access to its DNS.
3. **Decide the money model is Postgres-authoritative** — you have. Because this
   is a **fresh launch with no existing money data**, there is nothing to
   migrate: Postgres simply starts empty and authoritative, and MongoDB mirrors
   it. That removes the biggest risk of a "flip". The one risk that remains is
   **behaviour under real load**, which you will measure in Phase 6.
4. **A Shinjiru dedicated box**, Ubuntu 22.04 or 24.04 LTS, root/sudo access.

---

## Phase 1 — Build the server

Follow **`deploy/VPS_UBUNTU_SETUP.md` top to bottom.** It is exact and tested-in-
prose. It installs, in order: Node 22, MongoDB 7 (as a replica set), PostgreSQL
18, Redis, MinIO (your private file bucket for KYC), then the app under PM2, then
NGINX with a real TLS certificate, then the firewall.

**The four things that will silently break it** (VPS doc §0 — read them, they
each fail *after* you think you're done):
1. MongoDB must be a **replica set**, not standalone.
2. Object storage (MinIO or Cloudflare R2) is **mandatory** — no local-disk mode.
3. You need **HTTPS with a real certificate** before anyone can even log in.
4. `TRUST_PROXY=1` must be set, or every user shares one rate-limit budget.

**Success looks like:** VPS doc §12 — `pm2 status` shows 3 apps online,
`curl localhost:3000/health/ready` returns `ready: true`, and
`https://yourdomain.com/` loads.

**If it fails:** copy the exact error (from `pm2 logs` or the terminal) and paste
it here. Do not guess — the failure is almost always one of the four above.

---

## Phase 2 — Configure (the `.env` file)

VPS doc §8 lists every variable. Two extra lines make Postgres the money
authority. In `/var/www/bettingbazaar/.env`, in addition to the required
variables, add:

```ini
# Postgres is the source of truth for money (your launch decision).
MONEY_AUTHORITY_WALLET=postgres
MONEY_AUTHORITY_LEDGER=postgres
MONEY_AUTHORITY_ORDERS=postgres
MONEY_AUTHORITY_KYC=postgres
```

And one line that lifts the concurrency ceiling — the single most important
setting for handling many players at once on one box:

```ini
# Sum the live pool from the bets instead of a per-bet write to one Cycle row.
# Without this, every bet on a cycle queues behind the one before it and a bigger
# (or second) server does NOT help — they all queue on the same row. With it,
# bets contend with nothing. Correctness is identical; validate with the load
# test in Phase 5. Remove the line to revert instantly.
FEATURE_DERIVED_CYCLE_POOLS=true
```

> **Do not just paste these and hope.** After the app boots (Phase 3), run the
> readiness check in Phase 4 — it refuses to let a money path go live on Postgres
> unless the code, the reconciliation query and the rollback path all line up. If
> it objects, it tells you exactly which flag to remove. Trust it over this file.

Generate every secret with `openssl rand -base64 48`. Back up `TOTP_ENCRYPTION_KEY`
and the admin keystore **off the box** — they cannot be rotated.

`IDENTITY_ENCRYPTION_KEY` must decode to exactly **32 bytes**, so generate that
one with `openssl rand -base64 32`. The server refuses to boot in production
without it and refuses a wrong-length value at the gate rather than failing later
on the first Aadhaar it cannot read. It *can* be rotated, but only by keeping the
old value in `IDENTITY_ENCRYPTION_PREVIOUS_KEYS` until every row is re-encrypted
— back it up anyway.

**The bot is not configured here.** Telegram bot tokens, webhook secrets and the
channel id live in the database, not in `.env`, so that a suspended bot can be
replaced from the admin panel without a deploy. After the app is live, sign in to
the admin panel → **Telegram Setup** and activate generation 1; until you do,
`/api/telegram/public-config` returns 503 and nobody can sign up. See
`docs/IDENTITY_AND_REFERRALS.md` §7.

---

## Phase 3 — Deploy the app

Still in `deploy/VPS_UBUNTU_SETUP.md`: §7 (build), §9 (PM2 three roles), §10
(NGINX + TLS), §11 (firewall), §12 (verify). At the end you have a live HTTPS
site — but **do not open it to real players yet.** Phases 4–6 come first.

---

## Phase 3.5 — Create the bots and activate them (nobody can sign up until you do)

Five minutes, in Telegram and then in the admin panel. Skipping it leaves a site
where every "Sign in" button says the service is being configured.

**In Telegram, talk to `@BotFather`:**

1. `/newbot` → name it → **copy the token**. This is the sign-in bot.
2. `/newbot` again → a second, differently-named bot → **copy that token**. This
   is the recovery bot. A separate one on purpose: a compromised sign-in bot must
   not be able to hand out other people's accounts.
3. Create your public **channel**, add the sign-in bot to it **as an
   administrator** (it cannot read join/leave events otherwise), and copy the
   channel id — forward any channel post to `@userinfobot` if you do not know it.

**In the admin panel → Telegram Setup:**

4. Paste both tokens and the channel id, add the invite link and your public URL,
   write a reason, and **Activate**. The token is checked against Telegram before
   anything is stored, so a mistyped value is refused here instead of silently
   taking sign-in down.
5. Confirm the result says the webhook is **registered**. If it says otherwise,
   the most common cause is a `webhookBaseUrl` Telegram cannot reach over public
   HTTPS. Fix it and activate again — activating a second time is safe and simply
   creates generation 2.

> **Keep BotFather access.** Telegram suspends gambling bots, and when it happens
> this same screen is how you recover: make a new bot, activate it, and existing
> players keep their accounts — identities key on each *player's* Telegram id, not
> on your bot. That is a 5-minute fix, not a redeploy.

---

## Phase 4 — Turn on Postgres money authority (the readiness gate)

This is the one step unique to your direct-Postgres decision. Do not skip the
check.

1. **Apply the Postgres schema** (creates the money tables, triggers, guards):
   ```bash
   cd /var/www/bettingbazaar
   npm run sync:indexes        # Mongo indexes
   # the Postgres schema is applied automatically on first boot; confirm the
   # tables exist:
   sudo -u postgres psql -d bb_money -c '\dt' | grep -E 'wallet_ledger|accounting_events|payment_orders'
   ```

2. **Run the readiness check — this is the gate:**
   ```bash
   npm run preflight:flip
   ```
   It inspects every money path and prints, per path, whether Postgres may safely
   hold authority. **Green everywhere → your `.env` flags from Phase 2 are safe.**
   If any path is not ready, it names it — remove that one `MONEY_AUTHORITY_*`
   line, leave it on Mongo for now, and it will mirror to Postgres until you flip
   it later. **Never force a flag past this check.**

3. **Restart so the flags take effect and confirm what's authoritative:**
   ```bash
   pm2 restart all --update-env
   npm run certify:report       # shows which store owns each money path, live
   ```

4. **Reconciliation on a schedule.** Add a cron (or PM2 cron) for
   `npm run reconcile:pg`. It continuously proves Mongo and Postgres agree and
   pages you (via your alert webhook) if they ever drift.

**Success looks like:** `certify:report` shows wallet/ledger/orders/KYC on
`postgres`, and `reconcile:pg` reports clean.

---

## Phase 5 — Prove it works, by hand, on staging (not automatable)

Open the site to **yourself and a test merchant only.** You are checking the
*system*, not the code (the code is CI-tested). Do each of these once and watch
the money land correctly in both the wallet and the ledger:

- [ ] **Register + log in**; the session survives a page refresh (proves TLS/cookies).
- [ ] **Onboard a merchant** and fund their float (admin top-up — this path
      historically had a bug; test it explicitly).
- [ ] **Manual deposit end-to-end:** a player requests a deposit → it is assigned
      to your merchant → player pays the merchant by UPI/bank → merchant confirms
      → tokens appear in the player wallet.
- [ ] **Place a bet, let the cycle settle, confirm winnings credit.**
- [ ] **Manual withdrawal end-to-end:** request → merchant pays out → the hold
      window behaves → balance is debited exactly once.
- [ ] **Sign up through the bot end to end** — `/start`, send a test Aadhaar,
      share the contact, join the channel, then tap the link it sends. You should
      land in the app already signed in.
- [ ] **The player appears in admin → KYC Queue** as awaiting a verdict, with
      only the last four Aadhaar digits shown.
- [ ] **Export and re-import one row** in admin → Bulk KYC. Put `YES` in the
      verdict column; the player's status should become APPROVED and both the
      export and the import should appear in the batch history naming you.
- [ ] **Try to place a bet after leaving the channel** — refused. Re-join and it
      is allowed again (the `chat_member` event updates the cache; no restart).
- [ ] **Recover an account** on the second bot with the registered phone and the
      right Aadhaar; confirm the balance and history survive, and that a *wrong*
      Aadhaar gives the same message as an unknown number.
- [ ] **A dispute inside the withdrawal hold window** resolves correctly.

**If anything is wrong:** paste what you saw + the relevant `pm2 logs` line here.

> **There are no KYC documents to migrate.** The upload path was removed on
> 2026-08-25 — KYC is an Aadhaar number captured by the bot and verified in bulk,
> so there is no bucket to configure and nothing to move. If you are reading an
> older copy of this runbook that mentions `migrate:kyc-private`, that script no
> longer exists. See `docs/IDENTITY_AND_REFERRALS.md` §6.

---

## Phase 6 — Load test on the real box (your plan)

You said you'll verify capacity on the Shinjiru hardware and bring logs back
here. Exactly right — capacity must be **measured on the real machine**, never
guessed. On the box, against staging:

```bash
npm run loadtest:seed        # create test accounts
npm run loadtest:bets        # drive concurrent bets — finds the write ceiling
npm run loadtest:realtime    # 2000 then 5000 then 10000 live connections
```

While they run, in another terminal:
```bash
curl -s localhost:3000/metrics -H "Authorization: Bearer $METRICS_TOKEN" \
  | grep -E 'bb_realtime_stats|nodejs_eventloop_lag_seconds|bb_pg_pool_connections'
```

**Bring these back to Claude Code here:** the numbers above, plus `pm2 logs` for
any errors, plus `htop` CPU/RAM. That's everything needed to tell you whether the
box holds your target and, if not, exactly what to fix. **Do not open to real
players until this passes** — for a betting site, an unknown concurrency ceiling
is a launch-day crash.

---

## Phase 7 — The Android app

Follow **`docs/governance/ANDROID_RELEASE_SETUP.md`** — it is the complete,
non-coder APK guide. In short:
1. Generate a signing keystore on your own machine and **back it up off the box**
   (lose it and you can never update the app).
2. Put 4 secrets + 2 variables into GitHub (the keystore, its passwords, and your
   API/merchant URLs).
3. `Actions → Android Release → Run workflow`, enter a version like `1.0.0`.
4. Download the APK artifact, install on a real phone, and run the on-device
   checks (login reaches the backend, live cycles resume after backgrounding).

The app talks to the same backend you just deployed, so it inherits everything
above — get the website solid first.

---

## Phase 8 — After you open the doors

- [ ] **Change the seeded admin password** and enrol admin 2FA (mandatory).
- [ ] **Point alerts at a human** — set `SystemConfig.alertWebhookUrl` (Slack/
      Telegram/PagerDuty) or money-path warnings go nowhere.
- [ ] **Do a restore drill** — restore yesterday's backup into a scratch DB and
      confirm it works. A backup you have never restored is not a backup.
- [ ] **Ship backups off the box** — same-disk backups die with the box.
- [ ] **Watch `reconcile:pg` and the drift metrics** daily for the first weeks.

---

## What can still go wrong (know these now, not at 2am)

- **Single box = single failure domain.** If the server dies, everything dies
  together. A second box / managed datastores is the HA upgrade when revenue
  justifies it.
- **Deploys mean brief downtime** unless you run a second app process and shift
  NGINX to it (`pm2 reload` gets close — the app drains gracefully).
- **The write ceiling on a single cycle** — *now lifted, if you set the flag.*
  Without `FEATURE_DERIVED_CYCLE_POOLS=true` (Phase 2), every bet on a cycle
  updates the same row and they queue one behind another — the one limit a second
  server can't fix. With it on, the pool is summed from the bets and they contend
  with nothing. Phase 5's load test tells you where the new ceiling sits. Leave it
  on for launch; it's the cheapest capacity you will ever buy.
- **A retried bet on a flaky mobile network can no longer become a second bet.**
  The backend now *requires* an `Idempotency-Key` on `POST /bet/place` and returns
  the original bet for any redelivery — no second debit, no doubled pool, no
  duplicate transaction — and the app already sends a fresh key per tap and reuses
  it on retry. Nothing to do; just don't strip the header at your edge/proxy.

---

## How to work with Claude Code on this (this is the real skill)

You are not a coder, so *how you ask* matters more than *what you ask for*. What
has actually worked on this project:

- **Ask for evidence, not assurances.** "Never mark something done based only on
  reading the code — show me the command that proved it." This is how the real
  bugs here were found.
- **Ask "what did you NOT verify?"** at the end of any task. The answer is where
  the risk hides. "Everything passed" → ask again, more specifically.
- **One thing at a time.** "Finish the migration" produces something nobody can
  check. "Flip the wallet path, show me what changes and how I undo it" does.
- **Paste real errors, never paraphrases.** "Something's wrong: [exact log line]"
  beats "the deposit is broken."
- **Watch for silent scope reduction.** If you asked for three things and got
  two, the third did not become unnecessary.

Good prompts for this repo:
> "Run the full test suite and show me the actual output, not a summary."
> "I want to flip `MONEY_AUTHORITY_WALLET`. Walk me through what changes, what
> breaks if it goes wrong, and how I undo it."
> "Here are my load-test numbers and `pm2 logs` [paste]. Where's the ceiling and
> what do I fix?"

## The files that tell you the truth

| File | What it answers |
|---|---|
| `deploy/VPS_UBUNTU_SETUP.md` | Every command to build the server |
| `docs/governance/ANDROID_RELEASE_SETUP.md` | The APK, start to finish |
| `docs/governance/ENV.md` + `.env.example` | Every environment variable |
| `npm run certify:report` | Which store owns each money path, **live** |
| `npm run preflight:flip` | Whether Postgres may safely hold authority |
| `docs/POSTGRES_FULL_AUTHORITY_PLAN.md` | The money-cutover machinery in depth |
| `docs/governance/LAUNCH_READINESS.md` | Everything that is not code (licence, load, legal) |
