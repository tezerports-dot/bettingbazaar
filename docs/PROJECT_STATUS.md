# Project status — what is built, and what is left

> **This file is the durable backlog.** `CLAUDE.md` §17.4 requires it: session
> containers are ephemeral and the repository is the only durable medium. That
> rule exists because the plan has been lost twice — once an implementation list,
> once a finished feature's code that was never committed. **Update this file in
> the same change that moves the work.**
>
> Rules live in `CLAUDE.md`. This file is status only.

**Last updated:** 2026-09-24, on the single-store branch (PR #184).

---

## 1. Where the project actually is

Every number below was printed by the command beside it on 2026-09-24, not
recalled (§29 — a claim about readiness is a claim about evidence).

| | State | Evidence |
|---|---|---|
| Datastore migration | **Complete** | `npm run check:no-mongo` — "All checks report zero", 186 references removed |
| Unit suite | **853 passing** in 83 files | `npm run test:unit` |
| Money-path suite | **1537 passing** in 101 files | `npm run test:pg` against a real PostgreSQL |
| Control inventory | **1246** controls across 67 screens, 0 FAIL | `npm run test:browser` |
| Panel suites | 81 admin, plus merchant and user | per-panel `vitest` |
| CI | green on every check | PR #184 |
| Capability registry | 74 tracked: 47 full · 9 partial · 7 architecture-ready · 7 absent · 4 decision | `npm run verify:capabilities` |

**What the 2026-09-24 browser work found, because none of it was visible
below a browser.** The three panels were gated per-audience (`CLAUDE.md`
§33.7), and driving them found that `IDENTITY_COLUMNS` mapped `audience`
without ever SELECTing it — so the gate blocked every player and every
merchant out of the whole app on a fully configured platform, while every API
tier stayed green (the server's channel gate fails open; the screen fails
closed). §32 S36. Three harness defects came out of the same pass: an
inventory that had drifted from the drive it is the denominator for, a boot
that was never rate-limit-guarded, and an admin fixture with `admin: null`
that bounced the pass to a sign-in screen for all 44 screens.

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
| **B5c** | Paid and the UTR are two steps — an ATM has a clock, so the merchant presses Continue before the slip exists | `81353f5` |
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
  `TURNSTILE_SECRET_KEY` and the panel site key are set. Add `localhost` to the
  widget's hostnames too, or the Android app cannot pass it.
- **The Android app** (built 2026-09-30, `docs/governance/ANDROID_RELEASE_SETUP.md`):
  make the signing key with `scripts/android/create-signing-key.sh` in a
  Codespace, set `ANDROID_PACKAGE_ID`, `ANDROID_SHA256_CERT_FINGERPRINTS` and
  `https://localhost` in `ALLOWED_ORIGINS`, build with the Android release
  workflow, publish on the admin Android App page. **Never yet run on a phone** —
  the build machine has no emulator; §7 of that guide is the on-device check,
  including the in-app update and its one-time install permission.
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

## 3.5 Tracker — the Android app (as of 2026-09-30)

Owner request: a native APK with in-app and mandatory updates, an admin page to
ship it, and Codespace commands for the signing key. Status is evidence, not
impression (CLAUDE.md §29): each "done" names what proved it.

### Done — 11 of 11 engineering items

| # | Item | Proof |
|---|---|---|
| 1 | Android project builds: debug and signed release | built locally on SDK 36; `apksigner` v2 verified |
| 2 | Brand icon and splash (was Capacitor's placeholder) | `icons:generate --check`; `nativeBrand.test.ts` |
| 3 | One owner for the app version (`package.json`) | `android-release.yml` refuses a disagreeing tag |
| 4 | In-app download and install (native plugin) | JUnit 4/4; compiled into the APK |
| 5 | Mandatory updates and the update screen | `NativeUpdateGate` 8/8; `updateStatus` tests; M163 |
| 6 | Admin Android App page (upload, notes, mandatory, publish) | release routes 16/16; `check:ui-coverage` |
| 7 | Upload refuses the wrong app, debug build, key or version | M161, M162; publish guards M160, M164 |
| 8 | Admin logo and splash reach the app (§32 S39) | `ShareModal` tests; sweep recorded |
| 9 | Server refuses to boot without `https://localhost` in CORS | `validateEnv` test |
| 10 | Codespace key script | run against a stub `gh`; the real upload route accepted its APK (201) |
| 11 | Docs: `ANDROID_RELEASE_SETUP.md`, env templates | — |

Full suites after the last change: pg 1568, unit 874, user 214, admin 115,
e2e 181 (0 fail); every repository gate exits 0.

### Left — in order, and who does it

| # | Step | Who | Estimate | Blocked by |
|---|---|---|---|---|
| L1 | ~~PR #197 CI green on the latest commit~~ **done** | automatic | — | — |
| L2 | ~~Merge PR #197~~ **done 2026-09-30** | owner | — | — |
| L3 | Run `scripts/android/create-signing-key.sh` in a Codespace | owner | 15 min | L2 |
| L4 | A deployed backend on HTTPS | owner + Claude | **not estimable here** | §3.3: jurisdiction; hosting; S3; domain |
| L5 | Server env: `ANDROID_PACKAGE_ID`, fingerprint, `https://localhost` in `ALLOWED_ORIGINS`; Turnstile `localhost` | owner | 15 min | L3, L4 |
| L6 | First build: Actions → Android release | owner (click) | 10 min | L3 |
| L7 | Upload and publish on the admin Android App page | owner | 5 min | L4, L6 |
| L8 | On-device checklist (`ANDROID_RELEASE_SETUP.md` §7) | owner with a phone | ~1 hour | L7 |
| L9 | Fix whatever L8 finds | Claude | 0 to 1 day; unknown until L8 | L8 |

**The honest critical path:** L1 to L3 and L6 take about an hour of your time.
The app cannot be *used* until L4, because an APK needs a live HTTPS backend
to talk to. The platform has never been deployed (CLAUDE.md §0.0), and §3.3's
jurisdiction item gates that deploy. L9 cannot be sized before a phone has run
the app, because no emulator is available here.

### Not planned — say if you want any of these

- Push notifications (needs Firebase; not requested).
- An iOS app (not requested).
- Over-the-air JS updates without a new APK (declined for now: an unsigned
  code channel into a money app; see DECISION_LOG 2026-09-30).

## 3.6 Tracker — the 2026-09-30 external review (as of 2026-09-30)

An outside review handed over 14 items: A1–A7 fixed on its own branch, B1–B4
confirmed and not fixed, C1–C4 unproven. Each item was reproduced FAILING
first on this branch, not taken on trust. Status is evidence (§29): each "done"
names the test that failed before the fix and the mutation that proves it.

### Done — 14 of 14 items worked; 13 fixed (P197-1 later, as R7), 1 not a defect

| # | Item | Found on main | Fix | Proof |
|---|---|---|---|---|
| A1 | F-024 order tamper tag never written | stripped tag → 200 | tag written at INSERT; guard fails closed | M156, M165, M92 |
| A2 | F-025 retry locked winnings with no order | 2,000 locked for one 1,000 withdrawal | lock + INSERT in one transaction | M166, M118 |
| A3 | F-026 **every buy charged the merchant twice** | 200,000 paise for a 1,000-token buy | hold consumed once, via `moveDepositMoney` | M167, M168 |
| A4 | F-027 admin withdrawal endings wrong in 10/11 cells | lock left standing; cancelled dispute back to DISPUTED | `endWithdrawal` one owner | M169–M171 |
| A5 | F-028 hold=0 confirm settled after commit | (review) | always HELD + settle inline | M172 |
| A6 | S40 NaN-vs-NaN assertion guard | (review) | vitest setupFiles guard | M173 |
| B1 | `check:dead-code` counted comments | 0 DEAD → 12 + 1 module when blanked | gate blanks comments; 12 exports + UTRManager deleted | planted failures reported |
| B2 | IP deny-list dead, claimed live | nothing mounted, called or screened it | first deleted; **rebuilt properly** on the owner's instruction (R1, F-030) | M183–M187 |
| B3 | undeclared config key had no status | `status` undefined | `invalidConfig`; + 2 whitespace-reason 500s found by the sweep | M174–M176 |
| B4 | PAN registry dead | no caller | deleted; table dropped | gates |
| C1 | order stamped on a rail it was not validated for | CASH_ATM-validated, P2P_UPI-stamped | stamp from the validated policy | M180 |
| C2 | cash matcher branched on the live rail | waiting cash order abandoned (0 matched) | per-order rail | M179 |
| C3 | **dispute raced by the hold worker** | dispute erased, money moved | order lock in the settlement; guarded mirror | M177, M178 |
| C4 | Android: zip bomb (P197-2), upload race (P197-3) | 64 MB inflated; loser got 500 | inflate bound; race → 400, no orphan | M181, M182 |
| C4 | P197-5 `https://localhost` + credentials | — | **not a defect**: WebView cookie jars are per-app | reasoning in commit |
| C4 | P197-1 APK signature not verified | — | **fixed as R7 (2026-10-01)** | v2/v3 signatures and content digests verified at upload; M211–M213 |

### Left — who does it

| # | Step | Who | Estimate |
|---|---|---|---|
| R1 | ~~Decide B2~~ **owner, 2026-09-30: build it properly** — **DONE**: mounted, admin routes, Blocked IPs screen, route + page + e2e tests, M183–M187 (F-030 REBUILT) | Claude | ~1 day |
| R2 | Merge this branch's PR | owner | 5 min |
| R3 | ~~Full mutation run (all 135 entries)~~ **done** — CI on PR #198 (`ba2a861`): 135/135 killed. Its first run caught M171 surviving after C3; retargeted | — | — |
| R4 | ~~Browser passes~~ **done (owner: do it)**, 2026-10-01, against a dev backend on `bb_drive`. Final: `test:browser` 72 checks, 68 PASS / 0 FAIL / 4 NOTE (route wildcards; support-assistant's 503 is explained on screen). `test:drive` 69 screens, 68 PASS / 0 FAIL / 1 NOTE (a board button whose name carries the live results strip, so it renames itself each cycle), 0 THREW, 0 5xx. `test:mutate` 49/49 driven, 0 failed, every bystander untouched. `test:forms` 16/16. **Fixed on the way:** Announcements hid a failed load as "none" (§28); the player app's toasts were not a live region, so every bet-card refusal was silent to a screen reader; 12 default tabs/segments published no selected state; 3 icon/initials-only buttons had no name (profile photo, stop pricing, Restore version N); bet sides did not say when betting was shut; Min/Max Bet Amount had no client floor. **Harness made honest:** file pickers, live select options, checked radios, collapsed `<details>`, and disabled-at-press-time are now read rather than reported as INERT/UNREACHABLE (18 notes → 1) | — | — |
| R5 | ~~PostgreSQL 18~~ **done** — CI on PR #198: pg tier 109/109 files green on PostgreSQL 18.6 | — | — |
| R6 | ~~Domains the review did not reach~~ **done (owner: do it)**: bet placement (F-033, F-034), settlement (F-035), 2FA/reset (F-036–F-038), Telegram gates (F-039), referral payouts (F-040), commission engine (F-041), sub-admin permissions (F-042); USDT rail reviewed with no new defect. **Casino WIN (owner, 2026-10-01: wins only on rounds the player bet on): done as F-043.** A provider WIN now needs the player's own standing bet on that round, at that provider; M208–M210 | — | — |
| R7 | ~~APK signature verification~~ **done (owner, 2026-10-01: do it).** Every v2/v3 signer of an uploaded APK is verified: content digest recomputed in 1 MB chunks, signature checked with the signer's key for every algorithm it lists, and the certificate must be that key. Proven against Google's `apksigner` (build-tools 34) output, RSA and EC, v2 and v3, whose printed fingerprints the tests pin; tampered contents, a bad signature, and a certificate naming another key are each refused; M211–M213 KILLED | — | — |
| R9 | ~~Admin control of the APK~~ **done (owner, 2026-10-01).** (a) **Halt / Resume** a published release: it stops being offered, downloaded or required at once, phones go back to the newest release that is not halted, a mandatory block it set is lifted; the publish floor and the upload's early check still count it (the upload check had read the offered release and would have accepted a build below a halted one: caught by the new test before it shipped). (b) **Android-version safety**: the app reports its API level (new `sdkLevel` plugin method; older installs send nothing and behave as before); a phone is never offered, or blocked by, a release it cannot install, and below a mandatory one it cannot install it is told its Android is too old (`unsupported`, a new blocking screen) rather than looping. (c) The card shows required Android, verified signature schemes, uploader/publisher/halter, a Download APK button, and warns when a draft raises the Android floor. Tests: androidReleaseControlRoutes 9 (pg), AndroidAppPage 7, NativeUpdateGate +1, nativeUpdater 3; M214–M218 KILLED. Not verified here: the Java method compiles only in CI's Android build (this container has no Android SDK) | — | — |
| R8 | ~~Force the races behind M49 / M122~~ **done**: M49's export test now forces the overlap (a SHARE lock on `kyc_batches` parks export A holding its rows while B runs) — KILLED 3/3. M122 was already deterministic: the sequential 'second tap' test kills it | — | — |

## 4. How to pick this up

1. Read `CLAUDE.md` end to end. It is the only rules file.
2. Run the gates before believing anything about state:
   `npm run check:no-mongo`, then the rest of the command table.
3. Run the suites: `npm run test:unit`, and `npm run test:pg` with a real
   PostgreSQL (`DATABASE_URL` set).
4. Read §3 above for what is open, and `docs/reference/DECISION_LOG.md` for why
   something is the way it is before changing it.
5. **When you finish a piece of work, update this file in the same commit.**
