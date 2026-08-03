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

**Overall: NOT CERTIFIED FOR REAL MONEY.** Nine defects found and fixed across
two passes — two money bugs (one on each store), CSRF, two deploy blockers, a
dependency-gate gap, SSRF egress, a silent unaudited-money blind spot, and an
admin feature that never worked. Three remain open by decision rather than
oversight (see below), and the areas that most need verification — money under
real concurrency, and anything needing a deployed environment — are still
unverified.

---

## 1. Security

| Item | Status | Evidence |
|---|---|---|
| Game-provider webhook authentication | **PASS** (was FAIL) | Missing-signature bypass fixed; 8 tests, `gameProviderWebhookSignature.test.js` |
| Constant-time secret comparison | **PASS** | `timingSafeEqual` in webhook, order HMAC, TOTP |
| CSRF vector | **PASS** (was FAIL) | Simple-request parsing removed; 5 tests, `csrfSimpleRequestSurface.test.js` |
| CSRF structural design | **NOT VERIFIED** | Header-only auth proposed in `AUTH_AND_CSRF_DESIGN.md`; **not implemented** — needs the step-1 measurement first |
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
| SSRF egress controls | **PASS** (was FAIL) | `services/outboundGuard.js`: protocol + public-address checks, per-hop redirect re-validation, optional host allow-list; 19 tests |
| Broken admin branding upload | **PASS** (was FAIL) | Repointed at the existing presigned flow; integration test pins that frontend and backend paths match |
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
| Mongo `debitForBet` replay safety | **PASS** (was FAIL) | Double-charge when a replay re-split pockets; fixed. **4 tests executed against real MongoDB in CI run 30819385308** (19 files / 85 tests / 0 failures). See `MONGO_MONEY_AUDIT.md` M-1 |
| Mongo bet-stake path idempotency | **FAIL** | `_mongoBetStake` has no idempotency key on the balance move. Not reachable from today's caller (fresh UUID per request); unsafe primitive. M-2, proposed design in the audit doc |
| Mongo bet-stake atomicity | **FAIL** | Balance and ledger are separate operations; money can move unaudited. M-4, proposed design in the audit doc |
| Unaudited movements observable | **PASS** (was FAIL) | `bb_unaudited_money_movements_total` + log; was a silent `.catch(() => {})`. M-3 |
| **Mongo money paths — remaining** | **NOT VERIFIED** | Merchant wallet, payouts, treasury, equalization, disputes, bonus/commission/referral, deposit+withdrawal state machines. **The sandbox cannot run MongoDB** (`fastdl.mongodb.org` 403 via the egress proxy; no apt package), so all Mongo tests are verified by CI |
| Deposits / withdrawals end-to-end | **NOT VERIFIED** | Needs a deployed environment |
| Settlement + equalization | **NOT VERIFIED** | Not traced |
| Bonuses, commissions, referrals | **NOT VERIFIED** | Not traced |
| Merchant payouts, treasury, disputes | **NOT VERIFIED** | Not traced |
| Admin balance adjustments | **NOT VERIFIED** | Wrapped in `session.withTransaction()`; not tested |
| Casino ROLLBACK/REFUND requires prior debit | **FAIL** | Credits without proving a matching debit existed. Not externally reachable now that the signature is enforced, but the model is wrong |
| Mongo money under concurrency | **PASS** | 5 scenarios executed against real MongoDB in CI run 30819385308: 50-copy retry storm, 100 bets racing a balance fitting 10, 20× duplicate webhook, debits interleaved with credits, racing writes on one key. Invariant asserted throughout: the ledger explains the balance |
| Postgres money under concurrency | **PASS** | Adversarial run against real PG 16: 200 concurrent distinct debits (exactly 100 committed, ledger sums, never negative), 200 concurrent same-txId (charged once), 100 debits × 100 credits interleaved (ledger explains balance) |
| Survives a Postgres restart mid-transaction | **PASS** (was FAIL) | Unguarded checked-out client crashed the process on an unhandled `'error'`. Fixed via `connectGuarded`; re-run shows process survives, 53 in-flight ops rejected not silently succeeded, and balance+debits reconciles across the crash |
| Port collision fails readably | **PASS** (was FAIL) | EADDRINUSE was an unhandled `'error'` event and a raw stack trace; now a named FATAL and exit 1 |
| Concurrent double-spend under multi-instance load | **NOT VERIFIED** | Single-process concurrency is covered above. Multi-instance contention needs `loadtest/bet-contention.js` on staging — §A of `CONCURRENCY_CERTIFICATION.md` |
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

1. **Mongo bet-stake path (M-2, M-4).** The main bet money path has no
   idempotency key and writes its ledger outside the transaction. Fixing it
   means putting the hottest path in a transaction and inverting the write
   order — a latency change under exactly the spiky load bet placement creates.
   Proposed design in `MONGO_MONEY_AUDIT.md`; measure under
   `loadtest/bet-contention.js` on staging first.
2. **Structural CSRF.** The vector is closed; the design is not. Recommendation
   and migration in `AUTH_AND_CSRF_DESIGN.md` — header-only auth, since every
   client already sends `Authorization: Bearer` and the cookie serves nobody.
   Starts with a week of measurement, not a code change.
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

1. Deploy to Railway staging. Confirm the integration and E2E suites pass there
   — this is also what finally verifies the Mongo tests written in this audit
   against a real database rather than CI alone.
2. Run `loadtest/bet-contention.js` against it. Confirm no double-spend and no
   negative balances under concurrency.
3. Audit the **Mongo** money paths to the depth the Postgres ones got here —
   they are the ones serving money today, and they are this report's largest
   NOT VERIFIED.
4. Resolve the six open items above.
5. Build Hetzner infrastructure; test a restore and a failover.
6. Independent penetration test.
7. Clear the compliance gates in `LAUNCH_READINESS.md` §G.
