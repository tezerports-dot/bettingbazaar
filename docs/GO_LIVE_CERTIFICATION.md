# Go-live certification report

Status of every major area, as of the audit on this branch.

**Three values, used strictly:**

| | Meaning |
|---|---|
| **PASS** | Verified by running something — a test, a boot, a query. Evidence named. |
| **FAIL** | Verified broken, or a required control is absent. |
| **NOT VERIFIED** | Not checked, or not checkable in this environment. **Not a synonym for "fine."** |

Most rows below are NOT VERIFIED. That is the honest state of a first audit pass
against a codebase this size, and the point of separating the column from FAIL
is so the unknowns stay visible instead of being rounded up to "ready".

**Overall: NOT CERTIFIED FOR REAL MONEY.** Four defects were found and fixed;
the areas that most need independent verification — the Mongo money paths under
concurrency, and anything requiring a deployed environment — have not been
verified at all.

---

## 1. Security

| Item | Status | Evidence |
|---|---|---|
| Game-provider webhook authentication | **PASS** (was FAIL) | Missing-signature bypass fixed; 8 tests, `gameProviderWebhookSignature.test.js` |
| Constant-time secret comparison | **PASS** | `timingSafeEqual` in webhook, order HMAC, TOTP |
| CSRF on state-changing requests | **PASS** (was FAIL) | Simple-request parsing removed; 5 tests, `csrfSimpleRequestSurface.test.js` |
| SQL injection | **PASS** | All Postgres access parameterised; no string-concatenated SQL |
| LIKE/pattern injection | **PASS** (was FAIL) | Only `LIKE` in the tree was the wallet probe; now `= ANY($2)` |
| Mongo/NoSQL injection | **PASS** | `mongoSanitize` middleware; admin search escapes regex |
| Prototype pollution | **PASS** | `__proto__`/`constructor`/`prototype` blocked in `mongoSanitize` |
| Path traversal | **PASS** | Asset slots regex-validated; `safeJoin` normalises + prefix-checks |
| Hardcoded secrets | **PASS** | Scan clean; gitleaks in CI |
| Weak-secret boot gate | **PASS** | ≥32 chars, non-placeholder, enforced in prod; `validateEnv.test.js` |
| Authorization on admin routes | **PASS** | `router.use(authenticate)` + per-route permission |
| IDOR on upload endpoints | **PASS** | Ownership checked, 403 on mismatch (`upload.routes.js`) |
| Dependency vulnerabilities | **PASS** (was FAIL) | 2 high in admin-panel fixed; per-lockfile CI matrix |
| SSRF egress controls | **FAIL** | `networkClient` has no allowlist or private-IP block. Admin-controlled URLs only, but an admin (or a stolen admin session) can reach cloud metadata. See §Open below |
| Broken admin branding upload | **FAIL** | `BrandingSettings.tsx` POSTs multipart to `/api/admin/cdn/upload`, which does not exist and has no multipart parser. Feature is broken, not a vulnerability |
| XSS (three React panels) | **NOT VERIFIED** | React escapes by default; no `dangerouslySetInnerHTML` audit done |
| CSP / HSTS / Helmet config | **NOT VERIFIED** | Helmet is mounted; headers not asserted against a live response |
| Session fixation / hijacking | **NOT VERIFIED** | Rotation-on-login not traced |
| 2FA / OTP brute force | **NOT VERIFIED** | Limiters exist; not exercised |
| Rate-limit bypass | **NOT VERIFIED** | Per-IP → subnet → surge chain exists; not adversarially tested |
| Privilege escalation (h/v) | **NOT VERIFIED** | Matrix documented in `AUTHORIZATION_MATRIX.md`, not tested per-role |
| Mass assignment | **NOT VERIFIED** | One admin-only spread found (`content.admin.routes.js:234`); rest unaudited |
| Penetration test | **NOT VERIFIED** | None performed. Independent test recommended before real money |

## 2. Money correctness

| Item | Status | Evidence |
|---|---|---|
| Postgres wallet: negative-balance guard | **PASS** | In the UPDATE WHERE clause; `walletPg.test.js` |
| Postgres wallet: row locking | **PASS** | `SELECT … FOR UPDATE`; 51 tests vs real PG 16 |
| Postgres wallet: atomicity of balance+ledger | **PASS** | Same transaction; tested |
| Postgres wallet: idempotency | **PASS** (was FAIL) | `LIKE` prefix bug fixed; `walletPgIdempotencyKeys.test.js` |
| Integer-only arithmetic (paise) | **PASS** | `Number.isInteger` guards at every entry point |
| Trial-balance / drift metrics exist | **PASS** | `bb_pg_trial_balance_ok`, `bb_pg_drift_rows` in `metrics.service.js` |
| **Mongo money paths (currently authoritative)** | **NOT VERIFIED** | **The integration suite could not run here — `mongodb-memory-server` cannot fetch `mongod` in this sandbox. This is the single largest gap: the paths actually serving money today are unverified by execution in this audit.** CI runs them |
| Deposits / withdrawals end-to-end | **NOT VERIFIED** | Needs a deployed environment |
| Settlement + equalization | **NOT VERIFIED** | Not traced |
| Bonuses, commissions, referrals | **NOT VERIFIED** | Not traced |
| Merchant payouts, treasury, disputes | **NOT VERIFIED** | Not traced |
| Admin balance adjustments | **NOT VERIFIED** | Wrapped in `session.withTransaction()`; not tested |
| Casino ROLLBACK/REFUND requires prior debit | **FAIL** | Credits without proving a matching debit existed. Not externally reachable now that the signature is enforced, but the model is wrong |
| Concurrent double-spend under load | **NOT VERIFIED** | `loadtest/bet-contention.js` exists, never run |
| Money conservation across a real cycle | **NOT VERIFIED** | Needs a deployed environment |

## 3. Deployment reliability

| Item | Status | Evidence |
|---|---|---|
| Listener opens before datastores | **PASS** (was FAIL) | Boot-verified: `/health` 503, `/health/live` 200 with Mongo down |
| Readiness vs liveness separation | **PASS** | `/health` dep-aware, `/health/live` process-only |
| Env gate completeness | **PASS** (was FAIL) | All four S3 vars now required; one test each |
| Graceful shutdown / drain | **PASS** (code review) | Fails readiness first, then closes; not load-tested |
| `railway.json` / `nixpacks.toml` valid | **PASS** | Parsed; Node 22 pinned |
| Backend syntax + architecture | **PASS** | `node --check`; depcruise 191 modules, 0 violations |
| Panel builds | **PASS** | admin + merchant built clean locally |
| Docker / compose config | **NOT VERIFIED** | Not built or run |
| K8s manifests in `deploy/` | **NOT VERIFIED** | Not applied |
| Migrations | **NOT VERIFIED** | `pg:migrate:partition` not exercised |
| PWA / service worker | **NOT VERIFIED** | Not loaded in a browser |
| Android build | **NOT VERIFIED** | Needs the signing keystore |

## 4. Infrastructure, HA, DR

| Item | Status |
|---|---|
| Production architecture designed | **PASS** — `docs/PRODUCTION_ARCHITECTURE.md` |
| Hetzner sizing + cost | **PASS** (as an estimate to confirm against real traffic) |
| Kubernetes decision documented | **PASS** — not recommended at this scale, with reasoning |
| Horizontal scaling supported in code | **PASS** — Redis-backed limits, realtime bridge, runtime roles |
| Zero-downtime deploys | **FAIL on Railway** (replace, not rolling). Available via `deploy/` k8s or the compose plan |
| Backups configured | **NOT VERIFIED** — no infrastructure exists yet |
| **Restore tested** | **NOT VERIFIED** — an untested backup is not a backup |
| Failover tested | **NOT VERIFIED** |
| Private networking / firewalls | **NOT VERIFIED** — designed, not built |

## 5. Observability

| Item | Status |
|---|---|
| Prometheus metrics exposed + token-protected | **PASS** — `/metrics` |
| Money-specific gauges | **PASS** — drift, trial balance, reconcile streak |
| Structured logging | **PASS** — `services/logger.js`, correlation IDs |
| Dashboards | **NOT VERIFIED** — `deploy/grafana` exists, not deployed |
| Alerting rules firing | **NOT VERIFIED** — nothing scrapes `/metrics` yet |
| Tracing | **NOT VERIFIED** — no OpenTelemetry. Not needed at this stage |

## 6. Testing and CI

| Item | Status |
|---|---|
| Unit tests | **PASS** — 412 passing |
| Postgres money tests | **PASS** — 51 passing vs real PG 16 |
| Integration tests | **NOT VERIFIED HERE** — blocked on `mongod` download; runs in CI |
| E2E (Playwright) | **NOT VERIFIED** — needs a deployed target |
| Load tests | **NOT VERIFIED** — never run |
| CI gates | **PASS** — tests, per-lockfile audit, SBOM, gitleaks, depcruise |
| Regression tests for every fix | **PASS** — each confirmed to fail against the pre-fix code |

## 7. Compliance and legal

| Item | Status |
|---|---|
| Gaming licence for target jurisdictions | **NOT VERIFIED** — outside engineering; see `LAUNCH_READINESS.md` §G |
| KYC/AML programme | **NOT VERIFIED** |
| Data retention policy | **PASS** (documented) — `RETENTION_POLICY.md`; enforcement not verified |
| Audit log tamper-resistance | **NOT VERIFIED** |
| Responsible-gambling controls | **NOT VERIFIED** |

> These are hard gates and none of them are engineering problems. A technically
> perfect platform that takes real-money bets without the right licence is not
> shippable.

---

## Open items requiring a decision (not safe to patch unilaterally)

1. **SSRF egress policy.** Blocking private/link-local ranges in `networkClient`
   is a two-line change, but a self-hosted provider inside your Hetzner private
   network is a legitimate case it would break. Decide: allowlist of provider
   hosts, or block private ranges with an explicit opt-out.
2. **Structural CSRF.** The vector is closed; the design is not. Choose
   token-based CSRF, or drop cookie auth in favour of the `Authorization` header
   everywhere. Spans three panels plus the Android shell.
3. **Webhook signature payload.** The HMAC covers `JSON.stringify(req.body)` — a
   re-serialisation, not the bytes the provider signed. Key order and unicode
   escaping must coincidentally match. Signing the raw body is correct but
   changes the wire contract with providers.
4. **Casino ROLLBACK/REFUND.** Credits without proving a matching debit existed.
   Needs the settlement model reviewed, not a patch.
5. **Broken branding upload.** `BrandingSettings.tsx` targets a nonexistent
   endpoint. Point it at the working `/api/admin/app-assets/upload` (base64
   JSON), or add the multipart route it expects.
6. **Money authority cutover.** Recommendation: launch Mongo-authoritative, flip
   wallet authority weeks later under real traffic. Reasoning in
   `PRODUCTION_ARCHITECTURE.md`.

## What would move this to certified

In order:

1. Deploy to Railway staging. Confirm the integration and E2E suites pass there.
2. Run `loadtest/bet-contention.js` against it. Confirm no double-spend and no
   negative balances under concurrency.
3. Audit the **Mongo** money paths to the depth the Postgres ones got here —
   they are the ones serving money today, and they are this report's largest
   NOT VERIFIED.
4. Resolve the six open items above.
5. Build Hetzner infrastructure; test a restore and a failover.
6. Independent penetration test.
7. Clear the compliance gates in `LAUNCH_READINESS.md` §G.
