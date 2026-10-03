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

## 3.7 Tracker — the 2026-10-01 review of PR #198 (as of 2026-10-01)

PR #198's follow-up report was checked against main `bd2e721`, claim by claim,
by re-running every tier and gate on a fresh database and reading all 30 new
commits. **Every number in the report reproduced**: unit 896, pg 1645 (117
files), player 220, admin 121, merchant 64, all 16 gates exit 0, audit map
matching, 171 mutation entries with every anchor unique. A planted
comment-only export was reported DEAD by the rebuilt gate, so B1 holds.

Three new defects were found in the new code. All three are fixed, each
reproduced failing on main first:

| # | Defect | Found how | Fix | Proof |
|---|---|---|---|---|
| F-044 | **A shared provider round admitted only its first player**, after F-043. Before F-043 the rows merged. | Reading F-043's refusal against the schema: `round_id UNIQUE` | round keyed `(provider_key, user_id, round_id)`; ownership refusals gone | casinoWinNeedsBetPg 10 (6 fail on main); M209, M210 retargeted, KILLED |
| F-045 | An IP-blocked address still opened a socket | §32 S32: which path skips the middleware? Then **measured live**: HTTP 403, socket connected | `realtimeAdmission` judges Express's own `req.ip` in `allowRequest` | ipBlocklistRealtime 2; live re-measure; M219, M220 KILLED |
| F-046 | `::ffff:10.0.0.0/104` (an IPv4 /8) passed the /16 floor | probing `judgeNetwork` with the mapped spelling | IPv4 floor applied in IPv4 terms | ipBlocklistRoutesPg +3 (2 fail on main); M221 KILLED |

After the fix, the branch measured: unit 898, pg 1650 (117 files), all 16
gates exit 0, audit map matching, 174 mutation entries with every anchor
unique.

**Not done in this pass:** a full mutation run (only the six touched entries
ran), a browser re-run (no screen changed), PostgreSQL 18 (CI runs it).

## 3.8 Tracker — measured coverage, and the handoff (as of 2026-10-01)

The owner asked for coverage gaps to be **measured, not guessed**: every route
nothing calls, and every control nothing pressed, per account type and state.
This section is also the handoff. Work here stopped at a mergeable point on
branch of PR #200, so another
session can pick it up.

### How the measurement works (rerun it before trusting any number below)

| What | How |
|---|---|
| Route hits | Start any server or test tier with `BB_ROUTE_COVERAGE=<dir>/<tier>.jsonl` (`backend/startup/routeCoverage.js`). Each route is identified by the file:line that registered it; a hit is recorded on `finish` or `close`, so SSE streams count. The server writes `<file>.inventory.json` at boot. |
| Route report | `node scripts/report-route-coverage.mjs --dir <dir> --out docs/reference/ROUTE_COVERAGE.md` (`npm run report:routes`) |
| Controls per account | `BB_PROFILE=<name> [BB_VIEWPORT=phone] npm run test:browser` writes `controls.manifest.<name>[.phone].json` (gitignored). The 18 profiles are in `backend/tests/browser/profiles.js`. |
| Control gap report | `npm run report:control-gaps`, which writes `docs/reference/CONTROL_COVERAGE_BY_ACCOUNT.md` |

### Measured (generated reports are committed)

| | Number |
|---|---|
| Routes mounted | 335 |
| Reached by some tier | 278: unit 2, pg 215, e2e 59, browser 160 |
| **Never reached by any tier** | **57** (listed in ROUTE_COVERAGE.md) |
| Reached but only ever refused | 57 |
| Reached only by in-process route tests | 90 |
| Answered a 5xx at least once | 8 (read the list; some are provoked on purpose) |
| Client methods no screen calls | 20 (27 before this pass) |
| Controls only some account has, never pressed | 52 distinct (99 screen slots) |
| Browser passes on this branch | inventory 72 checks 68 pass 0 fail, phone 72 checks 68 pass, drive 69 screens 68 pass 0 fail 1 note, forms 16/16, ghost-mode 14/14, mutate 48/51 → fixed, the failing and not-driven cases rerun 4/4 |
| Panel suites | admin 141, merchant 70, user 224 |

### Done in this pass: 19 commits, `6f31cef`..`1fc666b`

Defects found by the measurement and fixed. Each has a test that fails without the fix:

| Found | Fix |
|---|---|
| A sub-admin without an area was sent to the sign-in page while signed in | `NoAccess` screen inside the layout; a sub-admin with NO area is told so at `/` |
| A paused merchant was shown "Accepting orders" | `assignmentPausedAt` sent; one `availabilityOf()` used by every merchant screen |
| A rejected player had no way to correct their Aadhaar | resubmission form in `KYCModal` |
| Dashboard "today" tiles showed all-time figures and counted phantom bets | `bettingStats` excludes phantoms; tiles read `finance.today` (M236) |
| No way to lift a chat ban | Chat bans list with Lift ban |
| Second leg of every login (3 doors) reached by nothing | `loginSecondFactorPg` 7 tests (M237–M239) |
| Cash payment-reference route reached by nothing | `cashReferenceRoutePg` 5 tests (concurrent case serialised by `utr_registry`) |
| Merchant 2FA enrolment reached by nothing; message named a route that does not exist | `merchantTwoFactorEnrolmentPg` 4 tests (M240, M241) |
| Staff told to "disable 2FA first", which `/disable` refuses them | role-dependent refusal text |
| **A queue manager's own queue screen could not load (F-047 regression)** | `/payment-queue` gated by `queueManagerOrPermission` (M242) |
| Sub-admins offered Add/Deduct/Phantom and Approve/Reject/Cancel they cannot use; a Video KYC button that always threw | controls gated by `can()`; Video KYC removed |
| 5 merchant methods shipped in the player bundle | deleted |
| Fresh-database provider seeding silently updated 0 rows | `enableGameProviders` fetches first, throws on rowCount ≠ 1 |
| Two mutate cases queried `cycles.type` | `cycle_type` |

CLAUDE.md gained shapes S46–S48 and the coverage commands.

### Left: in order, with how

1. **Decide wire-or-delete for the 20 uncalled client methods** (table in
   ROUTE_COVERAGE.md). Admin `deleteUser` and `updateRoles` are features with
   no button: wire them with a test or delete them. The user-panel
   `getBetHistory`/`getTransactionHistory`/`getWinners` look superseded:
   confirm, then delete (§30).
2. **Work the 57 never-reached routes.** Each gets a pg route test or is
   deleted. Known ones: merchant signup (live scripts only), fake-winners
   CRUD, payment admin config/test-gateway, `/api/bonuses/my`, leaderboard
   rebuild, and the retry/batch routes (only their services are tested).
3. **Read the 8 routes that answered a 5xx.** In particular,
   `GET /api/v1/system/config` 500 once in e2e and `POST /api/bet/place` 500
   once in pg. Find out which run did it and why.
4. **Make the cross-area sweep a gate.** This pass ran it once by hand. Walk
   the live route stacks (as `check:staff-permissions` already does), map
   each admin `api.ts` method to the area its route needs, and fail when a
   screen offers a control whose area differs from the screen's own without
   a `can()` around it. Put it inside `check:staff-permissions`.
5. **Profile the states not yet profiled:** cycle paused, closing or
   settled; an order in each lifecycle state; paginated lists past page 1; a
   merchant with live orders. Add each to `profiles.js` and rerun
   `report:control-gaps`.
6. **Recorded, not changed:** a blocked player sees the signed-out app and
   learns of the block only at sign-in. A suspended merchant is the same.
   The `merchant-pending` profile is a state login cannot produce (drop it or
   make it the signup screen). `setPaused`'s comment is inaccurate: resume
   decides by `end_time`. Real bets are safe (`bet.routes.js` checks close
   time); phantom bets are exposed for at most one tick.
7. **Owner decision A3: free spins.** F-043 refuses a provider WIN with no
   stake. Keep refusing, or credit it as a bonus through a bounded pool.
8. **Not run in this pass:** the full mutation run (only M236–M242 ran, all
   KILLED), the e2e tier after the last three commits, and an independent
   review (§37 step 12). **This branch has not been independently reviewed.**

## 3.9 Tracker — §3.8 items 1, 3 and 4 worked; the session door closed (as of 2026-10-01, IN PROGRESS)

**Committed as it goes so nothing is lost (§17.4).** The two pg tests that were red at the first commit of this section were fixed (item 1).

| Found | Fix | Proof |
|---|---|---|
| A staff flag could be written onto a PLAYER row, and the authority checks read flags off whatever row a session belongs to. Measured: `POST /api/admin/users/:id/queue-manager` with a player id → 200, and that player's own session read `GET /api/admin/payment-queue` → 200 | `users_staff_flags_need_staff` CHECK; the grant route refuses a non-STAFF id with 409; `PUT /users/:userId/roles` deleted (no screen, unscoped) | adminUsersRoutes +4 (3 fail on main); M243, M244 |
| A deleted account was asked about by nothing: login refused BLOCKED only, so a deleted player signed in as before. The delete route was also unscoped, so a sub-admin with the players area could close the full admin | `accountClosed` refused at both login legs, `/me`, `authenticate`; `softDeleteUser` is PLAYER-only and moves `sessions_valid_from` (evicts sockets/SSE) | closedAccountPg 4 (all 4 fail on main); M245–M249 |
| `users.deleteUser` had no button | Delete Account on PLAYER rows of the Users screen, behind a confirmation; the server's 409 text is shown | UsersList.areas +3 |
| 17 client methods no screen called | deleted (user-panel 11, admin 6) | tsc all panels |
| `report:routes` counted helpers the client calls itself as uncalled, and matched bare names (so `utr.getFlagged` hid behind `users.getFlagged`) | object-aware matching, per-file comment blanking, calls no longer taken for definitions | uncalled list 20 → 25, read by hand |

CLAUDE.md gained S49 and S50.

Measured on this commit: unit 912/912; pg 1705/1707 (the 2 below); admin panel 144, user panel 224; all 16 gates exit 0; audit map regenerated and matching.

### Left

1. **DONE.** Two pg fixtures put staff flags on PLAYER rows, which the new CHECK now refuses (§32 S16): `userPg.test.js` "derives the authorisation flags from the roles it is given" (uses player `u-4`) and `staffTwoFactorEnrolmentPg.test.js` "flags on the SESSION CHECK too" (promotes a PLAYER mid-session). Each needs a STAFF account. A fix was drafted and held for the owner.
2. Run the mutation harness for M243–M249 (not run).
3. Regenerate `ROUTE_COVERAGE.md` with the fixed script: every tier must be re-run with `BB_ROUTE_COVERAGE` set, browser included. Not done, so the committed report still shows the old 20.
4. **DONE — Payment References screen** (`/payment-references`, `canManageUtr`). It shows registry totals, a review queue (references somebody tried to reuse, plus flagged ones), the full registry by status, lookup by reference, flag with a required reason, clear a flag, and the player's other references. Proof: `UtrMonitor.test.tsx` 8; browser pass on a live server, admin panel 46 pass / 0 fail with the screen opened; `test:mutate` `admin/utr/flag`, `admin/utr/clear` and `admin/users/delete` DROVE against the database, each with a bystander unchanged. The old client `utr.resolve` sent `{ resolution }` to a route that requires `{ action }` (S26), and it is gone.
4a. **DONE (owner, 2026-10-01: delete).** `GET /utr/flagged`, `POST /utr/resolve/:orderId`, and `order_states.requires_review` with its four `review_*` columns are deleted. So are the `awaitingReview` counts in `orderCounts` and `operationStats`, which no screen read and which were always 0.
4b. **DONE — the boot deadlock.** `server.js` started `gameEngine` and `cycleGenerator` at module load, while `applySchema()` was still running; only the cron jobs waited. PostgreSQL's log showed the deadlock between the generator's pool read and the schema apply's AccessExclusiveLock. On a fresh database the same race produced `relation "cycles" does not exist`. Both now start where the cron jobs start, after the schema chain succeeds. Proof: `schedulersWaitForSchema.test.js` 4 (M250 KILLED). Live: booted twice against an existing database and once against a fresh one, with 0 deadlocks (PostgreSQL log count unchanged) and 0 generator errors. The neighbour, the CSP provider refresh, also reads the database before the schema exists on a fresh boot. It fails closed by design; it now refreshes again right after the apply.
5. **DONE (owner, 2026-10-01: delete all five).** `/v1/content/ai-analysis`, `/v1/system/time`, `/v1/game/cycle/:type/:startTime`, `/user/:userId/bets` and `/user/:userId/transactions` are deleted, along with what only they used (`recentResults`, `getCycleAt`, `LIVE_STATUSES`). The pen test's IDOR probe keeps the three player-id routes that remain. Its SQL-injection path probe moved to `GET /api/cycles/:cycleId`. e2e: 180 pass, 0 fail.
6. The remaining client methods are listed by `report:routes`: user `getById`, `deleteUser` (now wired), and `utr.*`.
7. **§3.8 item 3 DONE — the 8 routes that answered a 5xx.** Six are deliberate: `bet/place` is a pg test injecting a refund failure, `/r/:code` is a unit test of a database outage, and the support-assistant routes (×3), promo upload-url and the Telegram webhook answer 503/502 because RAG, S3 or Telegram is not configured here. The other two trace to boot ordering: `GET /v1/system/config` answered 500 to the e2e readiness poll before the schema existed, which is 4b's shape. The server still serves HTTP before the schema is applied; readiness (`/health/ready`) says so, but the API answers. Not changed: whether to refuse API requests until ready is a separate decision.
8. **§3.8 item 4 DONE — the cross-area sweep is a gate.** Rule 5 of `check:staff-permissions`: a screen gated on one area that calls a route in another must ask `can()` for it. A planted missing `can()` on Users made it fail. It found 4: Balance Adjust searched players through the Users area and read its cap from System Settings, so it was unusable with its own area alone, and its results carried no balances (all "Dep: ₹0"). Fixed with `GET /admin/balance-adjust/players` (players only, with balances and the cap). `POST /admin/balance-adjust` now refuses a STAFF or MERCHANT login (409). Operations showed "No admin actions" when the audit read had been refused; it is now asked for only with `canViewAuditLogs`. Cycle History's phantom stats are now asked for only with `canManagePhantomAgents`. Proof: balanceAdjustAreaPg 6, BalanceAdjustment.test 2, M251 and M252 KILLED.
9. **Full mutation run: 202/202 KILLED**, then M250–M252 KILLED.
10. §3.8 items 2 and 5 still stand. ROUTE_COVERAGE.md is not regenerated. **Not independently reviewed.**
11. **DONE (owner: "check all the surroundings, delete those which are stale").** Six routes no client called were deleted: `GET /api/app/bootstrap` (with its file), `GET /api/v1/auth/health`, `GET /api/sse/stats`, `GET /api/v1/branding`, `GET /api/v1/tokens/rate` and `GET /api/v1/token/rates`. So was `PUBLIC_APP_ALLOWED_ORIGINS`, which only the bootstrap read and which production refused to boot without. The audit map moved 315 → 308 routes, 41 → 35 unauthenticated.
12. **DONE (owner: delete the second confirm if stale).** `POST /api/payment/deposit/:orderId/confirm` had no screen and no workflow; the merchant panel confirms through `POST /api/merchant/confirm/:id`. The catch was that the split, the double delivery, the 4-way race, the accounting event, the reference release and the redacted view were asserted ONLY against the stale route. They were ported to `merchantConfirmMoneyPg.test.js` (8) against the live one first, then the route, `paymentActorAuth` and `orderAccessGuardOrAdmin` went.
13. **DONE — the session door (§32 S51).** The login doors scoped by `account_type`; the session door did not. Measured: a real merchant's session read the PLAYER's projection of an order assigned to it (`GET /api/payment/order/:id` 200) and the player's order list (200); a full admin's and a sub-admin's session each opened a deposit in the staff account's name (`POST /api/payment/deposit/create` 200). Fix: `authenticatePlayer` on all 35 player routes; `authenticate` refuses a MERCHANT session and stops copying `req.merchantId` out of its token; `/me` refuses it inline; every refusal is `403 WRONG_PANEL` naming the panel. The order guard is now owner-only. The same door on the socket: `join_user_room` admits a PLAYER to their own room only (it admitted any full admin to ANY player's room), and `join_merchant_room`, which no client emitted and which admitted a full admin to any merchant's room, is deleted. Phantom access is a player's (`users_phantom_access_needs_player`; the grant refuses a staff or merchant id with 409; the Users screen offers Add/Deduct/Phantom on player rows only). Proof: `playerDoorPg` 11 (sweeps every player route as a staff and a merchant session, and as a player for the opposite case), orderAccessGuardRoutes, adminUsersRoutes +3, `s8-pentest` +5 probes over HTTP with the database checked; M225 repointed, M254–M261 KILLED.
14. **DONE — three pushes the merchant never received.** Swept every name sent to a merchant against the names the merchant panel registers: 8 sent, 6 registered. `order_paid` (the player's Paid tap, 3 send sites) was never registered, so the order sat unchanged on screen while `paidResponseMinutes` ran against the merchant. A moved UTR deadline went out as `order_updated`, a typo variant of `order_update`. A resolved dispute went to `io.to('merchant-<id>')`, a socket room no merchant client joins. Fixed: `order_paid` registered and merged; the typo renamed; the resolution sent through `emitMerchantUpdate` with `{orderId, status}` only. Proof: `useOrders.live.test.tsx` 3, which drives the REAL SSE client with only EventSource replaced (2 of 3 fail without the fix), utrGracePg +1, disputeResolutionRoutes +1, M262 and M263 KILLED.
15. **Trap 10, again.** Under M261 (the phantom CHECK disabled) the database probe wrote the forbidden row and failed before its revoke, and the restored CHECK then refused to be re-added: the schema apply stopped and the next two mutation suites reported NOT-MEASURED. Both CHECK probes now clean up in a `finally`; rerun KILLED with zero rows left. CLAUDE.md trap 10 records it.
16. **Recorded, not changed:**
    - An admin's message on a disputed order never reaches the merchant. It went to a socket room nobody joins, and the merchant panel has no order chat to show it in. Routing it to `order_update` as it stood would have merged `type: 'ADMIN_MESSAGE'` over the order's own type. A merchant-side surface is a feature decision.
    - The admin panel has no socket client at all, so `join_admin_room` and the per-area staff socket rooms (F-047's socket half) have no member. Staff receive everything over SSE. Keep the socket half as defence for a client that does not exist, or delete it: a decision, not done here.
    - `POST /api/2fa/disable` has no client. Deleting it would leave the player's setup refusal telling them to "turn it off first" (S14). Whether players keep 2FA at all is for the owner, alongside the Mini App below.
17. **Owner plan, 2026-10-01 — the Telegram Mini App.** Players will verify through a Telegram Mini App rather than the sign-in bot fleet: channel joining and phone-number verification both happen inside the Mini App, so the platform needs ONE bot that sends no messages to anyone, plus the Mini App. Not started. It replaces §33.2's fleet and rotation, `sendTemplate({ bot })` and the per-bot webhooks; the gate (§33.3) and the one-reason verification state stay. Open questions for the owner are listed in DECISION_LOG.md under 2026-10-01.

18. **DONE (owner chose to wire these three).**
    - **Run retention** — Operations → Maintenance: *Preview retention* counts per category; *Prune now* appears only after a preview and is confirmed with the count and cutoff the preview reported. The route answered a failed run `success: true` (`runRetention` never throws, so its failure is a value) — now a 500 with fixed wording — and a real prune writes a `RETENTION_RUN` audit row. Proof: retentionRunRoutesPg 6 (old rows go, a young one and anything under 30 days stays, a request without `dryRun` only previews), OperationsOverview +5, M264–M266 KILLED. The two helper components declared inside the screen were hoisted (S23).
    - **Player bonus history** — a *Bonuses* tab on the wallet (`GET /api/bonuses/my`), with a failed load said as a failure rather than "No bonuses yet". Found on the way, and the more important half: **the player's wallet History showed `[Admin:<staff user id>] <the admin's note>` as the title of every support adjustment** — the note the admin form says is "written to the audit log" (§32 S52). Both player routes now project through `playerLedgerView.js`: "Credited/Debited by support", key sets asserted; the admin's own user screen still shows the note. The History list was keyed on `_id`, which the server never sends (§23). Proof: playerLedgerViewPg 5, WalletBonuses 4, M267–M269 KILLED. **Note for the owner:** `bonus_records` has one writer — the admin credit — so "bonuses" today means support credits; referral rewards are paid through `creditWinnings` and appear in the History tab and on Refer & Earn, not here.
    - **Merchant stats** — Merchant Platform: *view* on a leaderboard row opens the merchant: wallet, completed buys and sells with volume **in the merchant's own currency** (the stats now name it; a USDT merchant's volume was summed in USDT and would have read as rupees), commission paid, admin top-ups, success rate, average response, the days with completed orders in the selected period, and the wallet ledger (now in BB, as its own Wallet column is). Each read fails on its own. Found on the way: **the leaderboard's Wallet column showed 0 BB for every merchant** — it read `tokenBalance` off rows that never carried one (S9); the query now joins `merchant_wallets`. Proof: merchantPlatformStatsPg 6, MerchantPlatform +4, M270 and M271 KILLED.
19. **Recorded, not changed:** `merchantLeaderboard` and `merchantProfitEngine` count PAID orders as completed (`state IN ('COMPLETED','PAID')`), while the per-merchant stats count COMPLETED only, so one merchant's "completed" can differ by its PAID orders between the leaderboard row and its own panel (§32 S47). For a buy, PAID is the player's claim, not finished work. Which one "completed" means is a decision for the owner; the fix is one predicate in two queries.

20. **DONE — §3.8 item 2, first routes worked (while the browser drive ran).**
    - **Games screen: a create overwrote.** `POST /admin/games` read `getGame` and then UPSERTED, under a comment saying the primary key decided; two creates of one slug both answered 200 and the second overwrote the first (§32 S6). `POST /admin/categories` upserted with no check, so "creating" an existing category replaced its name, icon and order and re-enabled it if disabled. Both are a create now (`createOnly`: `ON CONFLICT DO NOTHING`, 409); the seed keeps its upsert. Proof: gameRegistryAdminRoutesPg 9 (every game and category admin route, the race included), M272, M273 KILLED.
    - **Curated winners.** The edit took any amount (the create refuses ≤ 0 and the table has no CHECK, so an entry could be edited to −5 and published), a non-number left as a 500 (S35), and it was the one change to the feed with no audit row. And the PUBLIC, unauthenticated `/api/v1/winners` spread the editor's row whole, publishing `createdBy` — the staff account that wrote each entry (S52). Fixed with the create's rule on the edit, `CURATED_WINNER_UPDATED`, and an explicit public shape matching the real-winner half. Proof: curatedWinnersRoutesPg 8 (key set of the public feed asserted), M274–M276 KILLED.
    - **Deleted (owner rule: stale routes go):** `GET /api/v1/content/promo/:location`. No client: the player app asks over the socket (`request_promo`), which reads the same `listLivePromos` and also upper-cases the location this route did not.
21. **Recorded for the owner — the payment GATEWAY settings have no consumer (§3).** The Payment Control Center's gateway section (`GET/PUT /api/payment/admin/config`, `POST /api/payment/admin/test-gateway`) stores "P2P enabled", "gateway enabled", the mode and gateway credentials, and nothing outside those routes reads any of it: the `PAYMENT_GATEWAY` rail is declared inactive scaffolding. An admin who turns P2P off and the gateway on is told it saved, and deposits go on exactly as before. §3 calls an admin-editable field with no consumer a violation, and §0.0 says build the target state rather than accommodate. **Recommendation:** delete the section, its three routes and `payment_gateway_configs` until a gateway integration exists, or hide the controls behind that integration when it is built. Not tested or changed here, because it is a decision about a planned feature.

Measured on the commit that adds items 20–21: pg 1753/1753 (135 files), unit 920/920, all 17 gates exit 0, audit map regenerated (307 routes, 34 unauthenticated). The browser drive was still running; its numbers go in the next commit with the regenerated ROUTE_COVERAGE.md.

Measured on the commit that adds items 18–19: unit 920/920; pg 1736/1736 (133 files); admin 163, merchant 73, user 228, tsc clean on all three; e2e 188 checks, 183 pass, 0 fail, 5 notes; all 17 gates exit 0 (`check:ui-coverage` 0 dead, and none of the four wired routes on `--unused`); audit map regenerated. Mutation: M264–M271 KILLED. Not run: the browser tiers, the full mutation run, an independent review.

Measured on the commit that adds items 11–17: unit 920/920; pg 1719/1719 (130 files); admin panel 155, merchant 73, user 224, tsc clean on all three; e2e 183 checks, 178 pass, 0 fail, 5 notes (each says what a dev server cannot measure), then s8 alone with the door probes 64/61/0/3; all 17 gates exit 0; `audit:map --check` matches after regeneration (308 routes, 35 unauthenticated). Mutation: M225, M243, M254–M263 KILLED. Not run: the browser tiers after the door change, the full mutation run, and an independent review (§37 step 12).

## 3.10 Plan — the redesign (owner, 2026-10-02). Step 1 DONE; Step 2 IN PROGRESS (2a, 2b done); Step 3 NOT STARTED.

Three replacements, built in this order, each step tested, committed, and
reported to the owner in a short update every 5–10 fixes.

### Step 1 — Remove KYC entirely — **DONE 2026-10-02**
Done as planned below, plus: the Aadhaar-based Telegram account-move recovery
(`telegramRecovery.service.js`, `telegram_recovery_sessions`, `relinkIdentity`)
is deleted; the recovery bot now does password reset only. **Defaults taken,
for the owner to change:** referral eligibility rests on the account not being
blocked (the KYC condition is gone); a player who changes their Telegram
account has no self-service path until the Mini App (Step 3).
- Signup becomes mobile + password + captcha + invite code. No Aadhaar.
- Delete: the Aadhaar field and its hashing/encryption, `kyc_verifications`
  and every `kyc_*`/`aadhaar_*` column, the admin KYC queue and bulk verify,
  `POST /api/v1/auth/kyc/resubmit`, the KYC modal, and every
  `requireApprovedKyc`/`requireLinkedKyc` gate (withdrawals included).
- The only identity check is the Telegram contact share (Step 3).

### Step 2 — Replace the payment system with supervisors and teams
Owner answers, 2026-10-02 (two rounds; the second replaced the security deposit with a team token pool and made commission instant):

| Topic | Decision |
|---|---|
| Account types | A **supervisor** is a MERCHANT login with a supervisor role, on the merchant panel; created/approved by the admin. It does no transactions. **Members** sign up as merchants; the supervisor adds them by merchant ID; the admin approves. A member is in exactly one team. |
| Team size | Up to 4 teams per supervisor, exactly 10 members each. A team works only with 10. If it drops below 10 it keeps working until the end of that day (IST), then takes no new orders until it is back to 10; open orders always finish. |
| Rail | Each supervisor is approved for ONE rail: `CASH` (cash link), `UPI_BANK` (UPI link / bank account) or `USDT`. This **replaces the platform-wide payment-mode switch** (`payment_mode_policies`) and the gateway settings, which are deleted. |
| Denominations | Global, admin-editable list of which sizes are on offer, from 500, 1,000, 5,000, 10,000, 50,000, 100,000, 500,000 tokens. CASH serves 500 / 1,000 / 5,000 / 10,000; UPI_BANK serves 50,000 / 100,000 / 500,000 — the same sizes for buys and sells. One size per order; **no splitting** (the CDM split and CDM receipts go). Cash sells may be paid by UPI or any means. |
| USDT | Buy only. Multiples of 100 USDT, minimum 100, maximum 10,000 (admin-editable; owner confirmed). Token↔USDT rate admin-editable. No USDT sells. |
| ~~Security deposit~~ → **Team token pool** | **Revised by the owner, 2026-10-02 (second round).** There is no security deposit. Each TEAM has a token POOL. The supervisor BUYS tokens from the admin on the team's behalf (paid off-platform in INR or USDT, recorded by the admin with what was paid), and the team can only take orders its pool can cover: a buy HOLDS its tokens in the pool at assignment, in the statement that assigns it (§32 S6). The supervisor can SELL pool tokens back to the admin to cash out, which shrinks what the team can take on. |
| Tokens | Individual merchants hold NO tokens; the team pool does. A confirmed buy moves the held tokens from the pool to the player; a completed sell moves the player's tokens into the pool. Conservation becomes platform holding + every team pool + every player wallet = total. The UTR registry, the order lifecycle and disputes stay. |
| Routing | Auto-assign inside the team: an eligible online member with the fewest open orders, ties to the one assigned least recently. CASH buys additionally need the member to press **Ready** (they are at the ATM); it switches itself off when an order is assigned. Concurrency per member: CASH 1 at a time, UPI_BANK 3, USDT admin-editable — all admin-editable. A CASH member with an open buy is not given a sell until it is done; UPI_BANK and USDT members may be. |
| Commission | **Instant** (owner, second round). Matched volume = min(completed buys, completed sells) for the TEAM. Every time it rises above the team's high-water mark — even by 500 — 10% of the rise is credited as TOKENS into the team's pool from the platform's commission pool, once per volume (the mark is the idempotency key). The 16% supervisor / 84% members-equally split is kept as an ATTRIBUTION record so each person sees what they earned; the tokens themselves sit in the pool. Replaces the per-variety commission engine. |
| Red flag | Computed daily: a member whose transaction count and active time are below the team average by the threshold (admin-editable, default 25%) is flagged to the supervisor and admin. Flag only — the supervisor decides. |
| Visibility | Members see their team's performance. The supervisor sees and manages members, sees all their transaction logs, and talks to the dispute manager on members' behalf. |

**Also decided (second round):**
- **Cash link by QR.** For a CASH buy the member, at the ATM, scans the machine's
  QR with a scanner built into the order screen. The decoded link (amount
  pre-filled) is attached to the order, and the player sees a single
  "Pay ₹amount" button. The pre-supplied cash-link queue is deleted.

**Defaults I took, for the owner to change:**
- One pool PER TEAM (not one per supervisor).
- A team's open orders of BOTH directions count against nothing but the pool:
  a buy holds pool tokens; a sell holds none (it adds tokens when it completes).

**Build order — each batch tested, committed, pushed and reported:**
- **2a Teams — DONE 2026-10-02.** `teams`, `team_members`, supervisor role + rail on the merchant;
  caps (4 teams, 10 members, one team per member) enforced in the statements;
  admin designates supervisors and approves members; supervisor manages teams
  on the merchant panel; members see their team. No money, no orders.
- **2b Team pool — DONE 2026-10-02.** `team_pools` (available + held) and the
  append-only `team_pool_entries` ledger, written only by
  `database/repositories/teamPools.js`. A supervisor REQUESTS a buy or a
  buyback per team from the merchant Team page (`team_pool_requests`, one
  pending per direction per team); an admin holding `canFundMerchants`
  fulfils it from the Teams page after the money has moved, typing what was
  received (INR or USDT, a sale) or paid (INR only, a buyback). Fulfilment is
  ONE transaction: the status flip is the once-only guard, the buyback floor
  is the pool UPDATE's own WHERE, the treasury moves TOKEN_SUPPLY↔`TEAM_FLOAT`,
  and the `admin_token_considerations` row (now with `team_id`) records the
  payment. Reconciliation checks TEAM_FLOAT = Σ pools. A team with pool
  history cannot be deleted. `held_paise` is written by 2c's buy holds.
  **Default taken:** no admin-side "sell without a request" — every pool
  movement starts as the supervisor's request, so both sides see one record.
- **2c The switch.** Orders route to teams: fewest open orders, ties to least
  recently assigned; Ready for CASH buys; per-rail concurrency (CASH 1, UPI 3,
  USDT editable); no sell to a CASH member with an open buy; the end-of-day
  below-10 rule; buys hold pool tokens at assignment. DELETE the per-merchant
  wallet, escrow, scoring/ranking, cash-link queue, payment-mode policy,
  gateway settings, merchant token orders and fund/deduct.
  **Part 1 DONE (data layer, nothing calls it yet):** `teamRouting.js`
  (`routingCandidates`, `assignToTeam`, `setCashReady`, `routingSettings`),
  the pool's order money in `teamPools.js` (`holdForBuyWithin`,
  `releaseBuyHold`, `spendForBuy`, `creditSellToPool`, `reverseSellFromPool`,
  the two hold reports), `order_states.team_id` / `pool_held_paise`,
  `merchants.cash_ready` / `last_assigned_at`, `SystemConfig.teamRouting`, and
  a `within` step on the order transition so the hold commits with the move.
  `teamRoutingPg` 21 cases, M294–M304. Part 2 switches the order paths onto
  it; part 3 deletes what it replaces.
  **Parts 2–3 DONE (2026-10-03), built on branch
  `claude/busy-wright-cy111a-2c-wip` and fast-forwarded onto #201's branch.** Work moved from the Project thread to a plain session (owner: the
  Project's usage limit was reached; then the owner chose to stay in the
  Project with ONE FRESH THREAD PER STEP instead). What the branch holds:
  - DONE and green when last run: every order path switched onto routing and
    pool holds; per-merchant wallets, escrow, scorer, cash-link queue,
    payment-mode policy, gateway settings, merchant token orders and
    fund/deduct deleted; rail derived per order (`database/repositories/orderRails.js`);
    no withdrawal splitting (a cash-size withdrawal that is not a dispensable
    amount is refused, `NOT_A_CASH_AMOUNT`); player panel (tsc 0, 228 tests);
    merchant panel (Ready card, tsc 0, 89 tests); the DB suites
    (`teamRoutingPg` 25, `moneyConservation`, `depositConservationPg`,
    `ledgerPg`, `treasuryPg`, `configPg`, `merchantPg`, `newDomains`,
    `paymentModeImmutabilityPg`). A settled sell refunded after the team spent
    its tokens is covered by the platform (`reverseSellFromPool({ coverShortfall })`,
    TOKEN_SUPPLY → USER_FLOAT, once, under the order lock).
  - FINISHED 2026-10-03: the admin panel (170 tests); the merchant, payment,
    rejection-cap, player-payment-failure, platform-stats and privacy route
    suites, moved onto real routed orders; the e2e scenarios s1–s8 (team
    pools, Ready, pool requests and buybacks); the browser and live harnesses
    (`mutate.js` no longer imports `depositEscrow`; `walletButtons.js` and
    `test:wallet-buttons` deleted with the routes they pressed;
    `operations.mjs` lists the 12 cron jobs `cronJobs.js` runs). Found on the
    way: routing had stopped reading a member's "accept buys / accept sells"
    switches, so a member who switched buys off kept being routed them. It is
    a predicate in `routingCandidates` now (M329). Measured: `test:pg` on a
    fresh database 124 files / 1504 passed; every gate; panels 228 / 170 / 89.
    Still open: `mutate.js`'s two `admin/payment-control` dispute cases target
    a screen that no longer exists, so they report NOT DRIVEN.
  - FIXED 2026-10-03 (c5f2d8a; `withdrawalResolutionPg`, M307–M310): the
    defect below. A stake is now returned through `returnWithdrawalStake`,
    which reads the ledger under the wallet lock, and the release and the
    refund each refuse the other's key (`excludes`).
  - WAS AN OPEN DEFECT (a 2c regression, measured): `endWithdrawal(id,
    'REFUND')` replayed on a settled sell pays the player twice. The first
    refund's `mirrorSettlement(…, 'CANCELLED')` rewrites
    `merchantCreditStatus` from RELEASED to REVERSED, so the replay
    (`alreadyReversed` / `alreadyCovered`, still `ok`) takes the else-branch
    and calls `refundWithdrawal` on key `refund_<id>` — a different key from
    the first refund's `dispute_wd_refund_<id>` — draining another order's
    locked stake, or throwing a 500 when there is none. Reached by two admins
    resolving one disputed settled sell at once
    (`disputeResolution.admin.routes.js` `moved.idempotent`,
    `paymentOrder.routes.js` `resolved.idempotent` and `/action`). HEAD before
    2c replayed `creditWinnings` on one key. Fix: decide the branch from what
    the ledger says was consumed, not from the mirrored status; test the replay.
  - `scripts/mutation-check.mjs` is retargeted statically (220 entries, every
    anchor and test present, 34 deleted with the code they guarded); NOT yet
    run. Run it once the suites are green.
  - Then: every gate, `test:unit`, `test:pg` on a fresh database, all three
    panels' tsc/test/build, `audit:map`, CLAUDE.md §2 rows for the new owners
    (or leave to 2g), the §31 table, merge onto `claude/busy-wright-cy111a`, push, CI green.
  **2c design (written before building it, §17.4):**
  - *The rail an order runs on* is derived at creation, never read from a
    switch: USDT currency → the USDT rail; INR up to 10,000 tokens → `CASH`
    (`payment_mode = CASH_ATM`); INR above → `UPI_BANK` (`P2P_UPI`). The
    column `order_states.payment_mode` and its trigger stay — every worker
    already branches on the ORDER's value. 2d replaces the amount boundary
    with the denomination list.
  - *Timers and caps* move from `payment_mode_policies` to `SystemConfig`
    (`teamRouting`): the same five timers per rail, defaults equal to the
    policy's column defaults, and the per-member concurrency
    (CASH 1, UPI_BANK 3, USDT 3).
  - *Routing* is one query in `database/repositories/teamRouting.js`: approved
    members of a team whose supervisor's rail is the order's and whose
    strength is WORKING or GRACE; member ACTIVE, APPROVED, online, not
    assignment-paused, not barred for this order or player, under the cap, on
    USDT holding an address on the order's chain; a CASH buy needs **Ready**;
    a CASH member with an open buy gets no sell; for a buy, the team's pool
    must cover it. Ordered by open orders, then least recently assigned.
  - *The hold is the assignment*: one transaction locks the pool row, moves
    the buy's tokens available → held (refused in the UPDATE's WHERE),
    transitions the order with `team_id`, stamps the member's
    `last_assigned_at` and clears Ready on a CASH buy.
  - *Money*: a confirmed buy spends the hold (held −a) and credits the
    player; a cancelled/expired/refused buy releases it (held → available);
    a settled sell credits the pool (available +a). The treasury moves
    TEAM_FLOAT ↔ USER_FLOAT with them, so TEAM_FLOAT = Σ pools stays true.
    A refund of a settled sell takes the tokens back out of the pool.
  - *Deleted*: `merchant_wallets`, `merchant_wallet_entries`,
    `merchant_settlements` and the escrow service, the scorer and
    `assignmentCandidates`, the cash-link queue (QR replaces it in 2d), the
    payment-mode policy and its screens, the gateway settings, merchant token
    orders, admin fund/deduct of a merchant, and every test, mutation and
    panel control that existed only for them.
- **2c+ Escrow windows and disputes (owner, 2026-10-02 21:13).** The team
  pool works as the per-merchant escrow did: an order's tokens are LOCKED in
  escrow for the order's life and released only by a window or a decision.
  - *Buy.* At assignment the order's tokens leave the team pool into escrow
    (the 2c hold). Confirmed: the player is credited. If the player tapped
    Paid with a UTR and the member REJECTS it (not received / looks fake), the
    player is told by a pop-up and has **15 minutes** from the rejection to
    raise a dispute. No dispute in the window: the tokens go back to the team
    pool. Dispute raised: the tokens stay in escrow with NO time limit until
    the dispute manager decides — player was right → escrow to the player;
    member was right → escrow back to the team pool.
  - *Sell.* The player's tokens are locked in escrow. When the member says
    they paid, the tokens stay in escrow for **at least 1 hour**
    (`withdrawalHoldMinutes`, default 60) and the player may raise a dispute
    in that window; same decision path. No dispute: released to the team pool.
  - *Who was wrong is suspended completely* (player or member), and only a
    sub-admin (or admin) lifts it. Every lost dispute is a red flag on the
    account; a THIRD lost dispute suspends again and sends the account to admin
    review as high risk.
  - Both windows are `SystemConfig` values an admin edits (defaults 15 and 60
    minutes), with their consumers in the same change (§3).
  - *Notifications.* A team of **five Telegram bots** messages players about
    their transaction: completed, rejected, and the time until which they can
    raise a dispute. This changes Step 3, which kept bots silent: Step 3 keeps
    the five notification bots (rotated like the sign-in fleet; a bot can only
    message a player who has opened a chat with it, §33.2) alongside the Mini App.
  - *USDT rates are admin-set*: the rate a player pays (USDT per token) and the
    rate a team buys pool tokens at, both in `SystemConfig.usdtPricing`,
    bounded, frozen on each order and each pool sale (§25).
- **2c+ status (2026-10-03): BUILT on `claude/busy-wright-cy111a`.** What runs:
  - *Buy window.* The member's "rejected as unpaid" moves the buy to
    `REJECTED` (was `CANCELLED`) with the pool hold intact and writes
    `dispute_window_until` on the database clock. The player's dispute route
    checks the same column under the order lock; the `rejected-buy-window`
    sweep (every minute) cancels an undisputed buy and releases the hold.
    `rejectedBuyDisputeMinutes` 15 (5–1440). A REJECTED buy cannot be retried
    while its window is open. Player: a pop-up on the push, and a countdown
    with a Raise-a-dispute button on the order card. Member: the deadline on
    the Rejected banner.
  - *Sell window.* `withdrawalHoldMinutes` is 60 with a floor of 60; the
    zero-hold "settle at once" path in the member confirm is gone. The player's
    order shows `disputeUntil` (the hold's end) with the same dispute button.
  - *Who was wrong is suspended* by all three routes that decide a dispute
    (`disputeOutcome.service.js` → `disputeFaults.js`), once per order. Third
    loss → high-risk review; a sub-admin's lift is then refused in the write
    and a full admin's goes through. Admin Users and Merchants lists show
    the lost-dispute count and a High risk badge; the Dispute Manager says
    who will be suspended before the press.
  - *USDT rates.* Both `usdtPricing` rates are held to ₹10–₹1,000 per USDT
    on save and on read; the team pool rate's default is now 0 (unset).
  - *Fixed on the way:* `expectFrom` was ignored by the order writer, so a
    member's reject could close a buy the player had DISPUTED (and the
    paid-timeout sweep could dispute a just-completed buy); the Dispute
    Manager's decision menu sent values the route refuses, so no dispute
    could be decided for the team.
  - *Defaults chosen:* the loser is suspended automatically on the decision
    (no separate admin step); lifting high risk is admin-only, lifting a
    first or second loss is admin or sub-admin; a sell can still be disputed
    after its hour (the refund then comes out of the team pool, as in 2c).
  - *Deferred to Step 3:* the five Telegram notification bots.
  - *Security review before the push (2026-10-03), four findings, all fixed
    with tests and mutations M330–M343:* (1) every route that completes a buy
    moved the money before the guarded transition, so an admin APPROVE on a
    REJECTED buy paid the player and answered 409, and a confirm racing a
    reject could pay out a buy that ended REJECTED — now the spend asks the
    state under the order lock and stamps `pool_paid_at`, after which only
    COMPLETED may follow; (2) any decided dispute suspended somebody — now only
    a payment dispute the player or platform raised counts, and a member cannot
    red-flag their own rejection; (3) a member's accept/decline could act on an
    order an admin had just handed to a colleague — every member transition now
    pins the member; (4) fractional window minutes were accepted and silently
    read as the default, and a high-risk review re-opened after an admin lift
    raised no alert.
- **2d Orders.** Global admin-editable denomination list; CASH 500–10,000 and
  UPI_BANK 50,000–500,000 for both directions; no splitting (split payouts and
  CDM receipts deleted); USDT 100–10,000 step 100; the QR cash link.
- **2d status (2026-10-03): BUILT on `claude/busy-wright-cy111a`.**
  - *Order sizes.* An INR order is one of seven sizes (`ORDER_SIZES`); the
    admin's Settings screen ticks which are offered (`SystemConfig.orderSizes`),
    and the player picks from those. Min/max deposit and withdrawal limits are
    gone; a size that is not offered is refused naming the ones that are.
  - *USDT.* A buy is 100–10,000 USDT in steps of 100 (`SystemConfig.usdtBuy`,
    admin-editable); tokens follow from the frozen rate. No USDT sell.
  - *No splitting.* Split withdrawals, their batch screens and CDM slips are
    deleted (columns dropped, upload category removed).
  - *How each rail is paid (owner, 2026-10-03).* Every sell, on every rail, is a
    bank transfer to the player's account and the member gives the UTR. A
    UPI_BANK buy is a bank transfer into the member's account: the player sees
    holder, account number, IFSC and bank with Copy buttons; routing skips a
    member without a full account. The QR cash link is for CASH buys only.
  - *The QR cash link.* The member's order card asks them to scan the ATM's
    QR (camera with a jsQR fallback, or a photo; no typed link); the server
    checks it (`checkCashLink`: a `upi://pay` link for exactly the order
    amount) and the player gets one Pay button. No Paid tap before the scan; a
    re-scan replaces it until the tap; a change of member clears it (trigger)
    and a tap racing one is refused (`expectMerchant`). A cash buy that lapses
    unscanned counts on the member only.
  - *No mobiles (owner, 2026-10-03).* Closed three leaks: the member's UPI
    handle in the player-readable timeline, an admin's mobile as a display
    name, a merchant named after their mobile. `check:player-privacy` check 6.
    An account number that is a mobile (payments-bank IFSC, or the holder's
    own mobile at any bank) is refused by a CHECK on `merchants` and `users`,
    named on every save path; a cash QR whose handle is a mobile is refused.
    Default chosen with the coordinator; the owner can ask for it relaxed. The
    security review added: a mobile in the holder's or bank's name, and in a
    cash QR's name or note, is refused too; IFSC case and spacing and a 0091
    prefix no longer slip past.
  - *Accept before pay (security review).* The player is shown where to pay
    (account, QR or USDT address) only once the member accepts; until then
    "Waiting for the member to accept…", and Paid is refused
    (`NOT_ACCEPTED_YET`). The scan waits for the accept (`ACCEPT_FIRST`); the
    Paid move names the member on every rail; an unaccepted lapse is the
    member's. Before this a member could take a transfer, decline, and leave
    the order with someone else.
  - *Tests.* `cashLinkPg` (15), `payoutAccountNotAMobilePg` (9),
    `acceptBeforePayPg` (4), `orderTimelineNoMobilePg` (2), `orderSizesPg`,
    privacy suites rewritten, `CashLinkScanner` (11), `BuyPaymentUI` (22);
    mutations M349–M382; e2e s1/s3/s4/s7 accept before paying.
- **2e Commission.** Instant, per-team high-water mark, 10% into the pool,
  16/84 attribution. DELETE the per-variety engine.
- **2f Oversight.** Daily red flag (threshold admin-editable, 25%) from
  transaction count and online time; member online-time log; team
  performance for members; supervisor sees member logs and joins their
  disputes.
- **2g Close-out.** CLAUDE.md §2/§25/§26 rewritten for the new owners, docs,
  every gate and tier.

### Step 3 — Telegram Mini App replaces every bot, all three panels
- One bot per panel, which sends no messages; the Mini App does contact
  share (proves the mobile), channel-membership check, and password reset.
- **Login with Telegram** beside the password form: tapping it opens the Mini
  App, and the app (or the website) is signed in — only when the Telegram
  account is the one whose shared contact matches the account's mobile. The
  Mini App's `initData` is verified server-side with the bot token.
- Deleted: the sign-in bot fleet, rotation, per-bot webhooks, bot message
  templates, the recovery bots.

### Defaults chosen without an answer (change any of them)
- USDT order maximum 10,000 USDT.
- "Until the next day" means until 00:00 IST.
- The security deposit is recorded in rupees.

## 4. How to pick this up

1. Read `CLAUDE.md` end to end. It is the only rules file.
2. Run the gates before believing anything about state:
   `npm run check:no-mongo`, then the rest of the command table.
3. Run the suites: `npm run test:unit`, and `npm run test:pg` with a real
   PostgreSQL (`DATABASE_URL` set).
4. Read §3 above for what is open, and `docs/reference/DECISION_LOG.md` for why
   something is the way it is before changing it.
5. **When you finish a piece of work, update this file in the same commit.**
