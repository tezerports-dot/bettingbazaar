# Plan Status Audit — the 58-item plan vs. the actual repo (2026-07-13)

The uploaded plan ("BETTINGBAZAAR_STATUS_AND_PLAN") was re-verified item by item
against the code — not against doc claims. This file records (1) where the plan
was **stale**, (2) what was **built today**, (3) what remains, in priority order,
and (4) the Postgres decision. Everything built follows governance (§1 authority
rows, admin-editable via `setConfigField`, config-catalog listed).

## 1. Corrections — plan claims that were stale (verified in code)

| Plan claim | Reality (verified) |
|---|---|
| "settlementService.js mutates lockedBalance with raw `$inc` (F-2, don't touch blind)" | **Already fixed.** `settlementService.js` routes every unlock through `walletAuthority.releaseLockedStake` (see its header comment); proven under concurrency + crash-resume by `settlementConcurrency.integration.test.js`. |
| Item 37 structured logging "NOT STARTED — no pino/winston" | **Done (custom).** `backend/services/logger.js` emits structured JSON with correlation IDs from `requestContext.js` — a deliberate zero-dependency choice (portability). Adding pino would be a swap, not a gap-fill. |
| Item 52 email abstraction "NOT STARTED" | **Done.** `channelRegistry.js` has a real SMTP EMAIL adapter (Phase E), activation-gated on `SMTP_*` env, provider-agnostic. |
| Item 15 distributed locking "NOT STARTED — no locks anywhere" | **Substantially covered.** Cron leader election (`startup/cronLock.js`, CI-tested) serializes every scheduled job across instances, and settlement takes a per-cycle Mongo lock (`findOneAndUpdate` claim in gameEngine). Both named risk spots (settlement, assignment) are guarded; assignment also has a CI race test (X-9). Redis redlock remains optional hardening, not a gap. |

## 2. Built today (this session)

| Item(s) | What shipped |
|---|---|
| **5 + 58** Dependency validation + CI enforcement | `dependency-cruiser` + `.dependency-cruiser.cjs` (no-circular = error; domain core must not import routes; wallet authority must not import product domains) + `npm run check:deps` + CI step. Verified: the codebase currently has **zero circular deps** and zero wallet-purity violations, so any CI failure is *new* drift. Domain-owned `*.admin.routes.js` → `_adminShared.js` is allowed by design (edge files sharing edge plumbing). |
| **33** Prometheus metrics | `prom-client` + `backend/services/metrics.service.js`: default process metrics, HTTP duration/count histogram (bounded route labels), business counters (`bb_settlement_runs_total`, `bb_ledger_reconcile_errors_total`, `bb_alerts_sent_total`). `GET /metrics` on the server, optionally Bearer-gated by `METRICS_TOKEN`. |
| **38** Alerting | `backend/services/alerting.service.js` — POSTs Slack-compatible JSON to an **admin-editable** webhook (`SystemConfig.alertWebhookUrl`, System Settings card; env `ALERT_WEBHOOK_URL` bootstrap fallback; versioned via setConfigField; config-catalog listed). Wired to the two money-critical failure points: ledger-reconcile item/cron failures and settlement tick failures. 10-min per-key cooldown; fire-and-forget (can never break a money path). |
| **26** Caddy hardening (compression) | `encode zstd gzip` added to the Caddyfile. HTTP/2/3: Caddy defaults — verify post-deploy with `curl -I --http2`. |

Also this session (user asks, same governance pattern): expandable results panel
with win-probability stats on the game page; **admin-editable footer tabs**
(`SystemConfig.footerPages`); fixed the unmounted `GameProviderProvider` (casino/
crash sections were unreachable); Prometheus + alerting as above.

## 3. Remaining — prioritized, with honest sizing

**Next (small, code-only):**
- **19** `backend/config/security.config.js` — centralize CORS/helmet/rate-limit policy (mechanical refactor of working code).
- **28** network config module — build together with 29 when multi-domain is scheduled.
- **34** Grafana dashboards — now unblocked (33 exists); build on real scrape data.
- **4** service registry — start minimal per the plan; low urgency for a monolith.

**Medium (needs Redis-always-on or infra decisions):**
- **17/56** BullMQ job queue (one build, two items) — move settlement/bonus/retention crons onto retryable, observable jobs. Prereq: Redis required (today it's optional-with-fallback).
- **21** explicit helmet header audit; **20** secrets manager (plan itself says: only on a trigger).
- **29/30** multi-domain + DNS failover — fully specced in the plan; **hard constraint stands: origin-health signals only, never client IP/geo/ISP.** Needs domains + DNS provider details from the owner.
- **45/46** backups + PITR — mongodump schedule now; PITR lands naturally with Postgres (WAL).

**Large (owner decision required before any code):**
- **POSTGRES HYBRID MIGRATION (6/10/11)** — the plan's centerpiece. Not started;
  correctly sized as a multi-week program (schema → dual-write → CDC verification
  → reconciliation → cutover → data-rollback plan). **Blockers only the owner can
  clear:** provision a Postgres instance (env `DATABASE_URL`), choose the CDC
  tooling budget (Debezium needs Kafka/Connect infra — or start with the
  dual-write + reconciliation script and add CDC after), and schedule a staging
  window. The **`round2()` float-money bug is confirmed real** in
  `walletAuthority.service.js` / `wallet.service.js` — per the plan it gets fixed
  *inside* this migration (BIGINT paise columns), not as a risky standalone patch.
  When this starts, it starts with the plan's step 1 (schema) on a staging DB.
- **40/41/43/44** k8s / IaC / blue-green / rolling — platform decisions, only on a
  real scaling trigger (plan agrees).
- **31** geo routing — **do not build**; recorded as needs-a-decision, per the plan's own constraint.
- **16** Redis sessions — decision recorded: **not needed**; JWT + TokenBlacklist already covers instant revocation. Closed unless a new requirement appears.
- **24** WAF — when scheduled, OWASP-pattern blocking only (plan's scoping stands).
- **48** DR plan doc — write after 30/45/46 exist so it describes real mechanisms.

## 4. Scoreboard after today

- Done: 19 (plan) + 4 corrected-to-done (F-2 note, 37, 52, 15-substantially) + 4 built today (5, 58, 33, 38) + 26 completed → **~27 of 58 closed**, 9 partial, the rest scoped above with owners/triggers named.
