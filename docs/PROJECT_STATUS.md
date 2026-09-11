# Project status — what is built, and what is left

> **This file is the durable backlog.** `CLAUDE.md` §17.4 requires it: session
> containers are ephemeral and the repository is the only durable medium. That
> rule exists because the plan has been lost twice — once an implementation list,
> once a finished feature's code that was never committed. **Update this file in
> the same change that moves the work.**
>
> Rules live in `CLAUDE.md`. This file is status only.

**Last updated:** 2026-09-09, on the single-store branch (PR #184).

---

## 1. Where the project actually is

| | State | Evidence |
|---|---|---|
| Datastore migration | **Complete** | `npm run check:no-mongo` — all eight counts zero |
| Structural gates | **12 of 12 green** | see the command table in `CLAUDE.md` |
| Unit suite | 760 passing | `npm run test:unit` |
| Money-path suite | 1283 passing | `npm run test:pg` against a real PostgreSQL |
| Panel suites | 81 admin, plus merchant and user | per-panel `vitest` |
| CI | green on every check | PR #184 |
| Capability registry | 74 tracked: 47 full · 9 partial · 7 architecture-ready · 7 absent · 4 decision | `npm run verify:capabilities` |

**The datastore migration — the thing `CLAUDE.md` §1 is about — is mechanically
finished.** Everything below is either the payment-rail feature work or
operational work that is not code.

---

## 2. The two rails — the A/B work

The platform runs **one of two P2P settlement rails at a time**, with an admin
switching between them and neither deleted. The design is
`docs/design/PAYMENT_MODES.md`; the letters come from there.

| | Mode A — `P2P_UPI` | Mode B — `CASH_ATM` |
|---|---|---|
| Buy | player pays a merchant UPI, submits UTR | player draws cash at an ATM on a merchant-supplied link |
| Sell | merchant pays into the player's bank | merchant deposits cash at a CDM, submits the slip |
| Amounts | a range | fixed denominations |
| Assignment | score-based pull | link queue, first matching link wins |

Mode A already existed and was not rewritten. **Mode B is the new work**, and is
what the B-numbers refer to.

### 2.1 Built — Mode A and the switch

| Work | Commit |
|---|---|
| Bulk payout ran one raw UPDATE to COMPLETED, bypassing the hold, the transition row and the escrow flags | `ecddb90` |
| Merchant order projection became an allowlist — a merchant was being sent the player's UPI ID on every withdrawal | `e2259b1` |
| The settlement rail became a versioned policy row; an order is stamped with its rail and it is immutable by trigger | `eac6236` |
| The switch reaches an admin screen and a merchant banner | `c2ea5ee` |
| One owner for the order window, and it is the rail — not a global config number | `8f794b4` |
| Player order projection became an allowlist — every player response had been carrying the merchant's bank details whole | `0f6a6ce` |
| A merchant's inventory is HELD by the orders they already hold — the escrow existed on the SELL side only, so a merchant could be assigned more buy orders than their tokens could cover | `0ad68fb` |

### 2.2 Built — Mode B, the cash rail

| # | Work | Commit |
|---|---|---|
| — | One merchant, one denomination | `4388ca6` |
| — | The ATM link queue — supply that arrives before demand | `f2360d8` |
| — | Supplying a link, claiming one, telling the right merchants | `e45556b` |
| — | The merchant screen | `11cd3ed` |
| — | What a player may buy is decided by the server, not the app | `f4620ef` |
| — | The player side | `48b4dc8` |
| — | The CDM receipt, write-only by construction | `e84ce9c` |
| **B3** | The CDM receipt gets its screens, and the gate that should have caught them | `482d65a` |
| **B4** | A withdrawal too large for one denomination, paid in parts | `2dde492`, `19ba696` |
| **B5a** | The minute to fetch the UTR, and the admin window that decides it | `9c71cc4` |
| **B5b** | Retry with priority, and the link that never reached a waiting order | `61e29f4` |
| **B7** | USDT deposits — originally through BTCPay Server | `5ba3f2c` |
| — | **B7 superseded:** USDT is a merchant rail, two chains, one claim per payment | `53d637c` |
| — | USDT buys are denominated in TOKENS; the ledger speaks one currency | `59e6bdb` |
| **B8** | A merchant is paid per variety of work, not one rate for all of it | `c0074aa` |

**There is no B1, B2 or B6 in the commit history.** B1/B2 most likely map to the
unnumbered cash-rail commits above, which predate the numbering. **B6 is
genuinely unaccounted for** — no commit, no doc, no issue names it. If it was a
planned item it was never recorded anywhere durable, which is the failure this
file exists to stop. If you remember what B6 was, add it below.

### 2.3 The USDT rail changed shape mid-flight

B7 shipped BTCPay Server as the USDT rail. It was then **replaced** by a
merchant-served rail: a player sends tokens to a USDT merchant's wallet on a
chosen chain and submits the transaction id. There is no payment processor and no
webhook.

`docs/design/PAYMENT_MODES.md` §7 was updated on 2026-09-09 to describe the
merchant rail and to mark the BTCPay design superseded. The binding description
is `CLAUDE.md` §25.

---

## 3. What is left

### 3.0 Closed 2026-09-09 — the four findings from the penetration pass

Four of the five items recorded here on `ab6bf69` are fixed. Kept as a record of
what was decided, because each was an owner decision rather than a bug:

| Item | What was done |
|---|---|
| **Deposits refused while KYC is `PENDING_APPROVAL`** | The service check now matches the middleware. Money IN needs a *linked* identity; money OUT needs an *approved* one. The two predicates live in one side-effect-free module, `backend/domains/identity/kycGates.js` (`isKycLinked` / `isKycApproved` / `kycRefusalFor`), imported by both `auth.middleware.js` and `paymentProcessing.service.js` so the gate and the service can no longer disagree. Refusals now carry a code (`KYC_NOT_LINKED` / `KYC_NOT_APPROVED`) and say which of the three states the player is in. |
| **Two live paths completed a PAID deposit** | One writer kept. `/api/merchant/orders/:id/approve` was **deleted** (~155 lines) along with the merchant panel's `approveOrder` export; `/api/merchant/confirm/:id` is the sole path, because it is the one that writes settlement inline and claims the UTR. |
| **Dead transaction scaffolding in the approve path** | Removed with the path above — `safeSession`/`commitOrEnd`/`abortOrEnd`/`withSession` were only reachable from it. The surviving `/confirm` path is a sequence of individually idempotent steps on canonical keys, which is the correct shape here: a real transaction cannot span the wallet write, the merchant debit and the ledger post anyway, and idempotent steps make a crash resumable rather than atomic-looking. |
| **`/deposit/create` had no rate limiter** | `depositCreateLimiter` added, admin-editable: `SystemConfig.riskRules.maxDepositOrdersPerMinute` (schema default **1**, range 0–60, 0 = off), surfaced on the admin System Settings page as "Purchase Pace". A config read failure falls back to 1 rather than opening the gate. Covered by a route test asserting the second create in a minute returns **429**, not the one-open-buy 409. |

Also closed while proving the above: `users.getUser()` no longer being a balance
source is now a regression test (`database/tests/walletPg.test.js`), and the
merchant approve path's balance read was moved to `wallets.getBalances()` before
the path itself was deleted.

### 3.0.1 Closed 2026-09-09 — token orders and phantom agents have screens

The fifth recorded item was ten endpoints served with no UI. Seven of them now
have one; the three bulk-payout endpoints are still open and are listed in §3.1.

| Built | What it is |
|---|---|
| `merchant-panel/src/pages/TokenSupply.tsx` | Where a merchant buys the float they trade with. Price an amount, send that exact USDT, file the request with the transaction ID. Nav entry **Token supply**. Calls `GET`/`POST /api/merchant/admin-token-orders` and the new quote route. |
| `admin-panel/src/Pages/Merchants/MerchantTokenOrders.tsx` | The treasury queue: approve (mints supply and credits the merchant's wallet) or reject with a reason. `AdminOnly`, matching the `isAdmin` the routes enforce. Nav entry **Token Purchases**. |
| `admin-panel/src/Pages/Users/PhantomAgents.tsx` | Who can place cosmetic bets and on which boards, with revoke. The grant already had a screen (a button on the Users list); reading it back had none, and an access grant nobody can enumerate is one nobody revokes. Nav entry **Phantom Agents**. |

Two backend changes came out of building them, both defects the screens made
visible rather than scope creep:

- **`GET /api/merchant/admin-token-orders/quote`** (new). The merchant has to
  send the USDT *before* the request exists, so the panel needs the figure in
  advance — a second reader of the price. The rate, the rounding to whole tens
  of USDT and the accepted band are now one function, `quoteAdminTokenPurchase`,
  that both the quote route and the create route call (§5). A refusal comes back
  as `200 { ok: false, message }`, because a merchant still choosing an amount
  needs the bound, not an error.
- **The transaction hash is now REQUIRED at creation.** It was optional, and
  `merchant_token_orders_approved_has_hash` refuses to approve a purchase with a
  `usdt_amount` and no transaction on it — which is every merchant-created
  purchase. The approve path mints and credits *before* it writes the status, so
  a hashless request meant: the merchant is paid, the CHECK rejects the status
  write, the handler 500s, and the order sits PENDING with the tokens delivered.
  `merchant_token_orders_one_per_day` then locked the merchant out of filing a
  corrected one. Covered by `backend/tests/routes/merchantTokenSupplyRoutes.test.js`
  (11 tests, real database), which also asserts the quote a merchant is shown is
  the quote that gets written.


### 3.0.2 Removed 2026-09-10 — merchant bulk payouts

Deleted at the owner's decision, having been reported as a rejected feature that
was still present. Provenance first, because "which change put this back" is
answerable from git and should not be guessed: it was introduced by `0cb9c85`
("Reachability: things that were built, merged, and never once ran", #171),
merged to `main`, which is this branch's own branch point. No later commit
restored it and no commit on any branch had ever deleted it.

It was also **not a working feature that was dropped**. Nothing in the platform
ever wrote `bulk_payout_date`, and the batch query filtered on that column — so
`GET /bulk-payouts` and `/bulk-payouts/export` returned an empty batch for every
merchant on every day this has run, and no panel called either one to notice.
Only `mark-paid` had test coverage, and it takes explicit order ids rather than
reading a batch.

Removed: the three routes, `bulkPayoutExport.js`, both test files, the
`requireBulkPayoutsEnabled` guard, the `MERCHANT_BULK_PAYOUTS` flag,
`istToday()` and `bulkPayoutBatch()` in the orders repository, the three
`bulk_payout_*` columns (dropped in `schema.sql`, following the split-leg
precedent), their entries in both order projections, and the
`bulk_payout_completed` event from the realtime registry.

**`withdrawal_batch_ref` was kept** and is unrelated despite the name: it is the
splitter's label for the siblings of one oversized withdrawal, written by
`paymentProcessing.service.js` and read by the stalled-withdrawals and dispute
screens.

A merchant closes payouts one at a time through `/confirm/:id`, which takes the
withdrawal hold, writes the transition and moves the escrow flags.

### 3.1 Code — small, and each item is verifiable

| Item | Why it is open |
|---|---|
| ~~Endpoints built with no UI~~ | **Closed 2026-09-10.** Token orders and phantom agents got screens (§3.0.1); merchant **bulk payouts** was deleted outright at the owner's decision — see §3.0.2. `check:ui-coverage -- --unused` now lists only endpoints that legitimately have no UI. |
| **No mutation run covers B8** | The commission engine's new guards are test-covered but not mutation-proven. The harness owns the files it names while running (`CLAUDE.md` trap 12). |
| **Route constants in two panels** | The admin and user panels write route paths as literals (`CLAUDE.md` §8). Open work, not a rule being broken silently. |
| **Brand colour literals** | `#D4AF37` still appears in panel sources instead of `var(--brand-primary)` (`CLAUDE.md` §4). Merchant panel is already at zero. Re-count before quoting a number. |

`npm run check:ui-coverage -- --unused` lists the remainder, and every one of
them legitimately has no UI: health and metrics probes, the Telegram and casino
webhooks, the SSE streams, `assetlinks.json`, and the versioned `/api/v1`
aliases of routes the panels already call under another path. Re-run it before
quoting a number.

### 3.2 Operator settings the cash rail needs

Two defaults do not match the cash rail's own rules. Neither is a code bug and
both will silently misbehave if missed:

- **`max_concurrent_orders` seeds to 3; on the cash rail the answer is 1.** The
  notes a merchant is holding are the same notes, so two orders promise them
  twice. Set it per policy version when switching to the cash rail.
- **`maxWithdrawal` defaults to ₹50,000 and the largest denomination is
  ₹40,000.** On a default configuration the only split that exists is two parts,
  and a ₹100,000 withdrawal is refused before it reaches the splitter — by a
  limit that has nothing to do with denominations. Raise it or splitting is
  decoration.

### 3.3 Not code — the real gates before taking money

Carried over from the retired `LAUNCH_READINESS.md`, because the items are real:

**Hard blockers**

- **Jurisdiction and licensing.** India prohibits this category outright — the
  Promotion and Regulation of Online Gaming Act, 2025, in force since 1 May 2026.
  §5 bans offering an online money game (skill or chance expressly irrelevant),
  up to 3 years and/or ₹1 crore; §6 bans advertising it; §7 reaches *any person
  facilitating financial transactions*, which includes the P2P merchant network
  personally. The Supreme Court has declined an interim stay. **There is no
  Indian licence to obtain, because the category is prohibited rather than
  regulated.** Every other item is downstream of choosing a jurisdiction that
  licenses this at all. Not legal advice — take gaming-law counsel.
- **A real load test at target scale.** The capacity numbers in the deploy docs
  are a sizing sketch, not a benchmark. This is the single biggest engineering
  unknown, and a high-frequency board multiplies it (`CLAUDE.md` §18.4).
- **Point-in-time recovery, rehearsed.** Enable WAL archiving off-box and
  actually restore from it once, to a scratch host, timed. An untested backup is
  not a backup.
- **Third-party security audit and penetration test.**

**Owner/infra actions**

- Key Cloudflare Turnstile — the captcha is built and inert until
  `TURNSTILE_SECRET_KEY` and the panel site key are set.
- Managed clustered PostgreSQL (primary + streaming replica) and Redis.
- Edge gateway / L7 load balancer, and a WAF in front.
- Multi-region and DNS health-checked failover.
- Watch `wallets` row-lock waits and 40P01 deadlocks — lock contention is the
  ceiling, and store drift is not a failure mode with one store.

**`TOTP_ENCRYPTION_KEY` has no rotation path.** Rotating it makes every stored
2FA secret undecryptable and forces every admin to re-enrol with nobody able to
sign in meanwhile. Back it up like the Android signing keystore.

### 3.4 Infrastructure capabilities not yet built

From `platform/capabilities.yaml` — all infrastructure, none of it feature code:

- **Absent:** read replicas, Redis cache layer, cache TTL/invalidation strategy,
  artifact signing / SLSA provenance, replica-lag monitoring, Helm charts,
  policy-as-code.
- **Partial:** point-in-time recovery, backup verification, autovacuum tuning,
  secret management, WAF integration, multi-domain, DNS failover, IaC, backup
  restore testing.
- **Architecture-ready (dormant until infra exists):** partitioning, Redis HA,
  OpenTelemetry, secret rotation, hybrid service topology, inter-service auth,
  Kafka event backbone.

---

## 4. How to pick this up

1. Read `CLAUDE.md` end to end. It is the only rules file.
2. Run the gates before believing anything about state:
   `npm run check:no-mongo`, then the rest of the command table.
3. Run the suites: `npm run test:unit`, and `npm run test:pg` with a real
   PostgreSQL (`DATABASE_URL` set).
4. Read §3 above for what is open, and `docs/reference/DECISION_LOG.md` for why
   something is the way it is before changing it.
5. **When you finish a piece of work, update this file in the same commit.**
