# CLAUDE.md — the single rules file for BettingBazaar

**This is the only file in this repository that states rules.** Every source file
cites it, every other document is subordinate to it, and where anything
disagrees with this file, this file wins and the other thing is wrong and must
be corrected.

It was merged from the former root `CLAUDE.md` and the former
`docs/governance/04-GOVERNANCE.md` on 2026-09-09. Those were two rule files with overlapping authority, which is the
same defect they both warn about: one owner per value. The governance file's
reference material and history were not deleted — they moved to the documents
listed below, which hold **data and history, never rules**.

| What you want | Where it is |
|---|---|
| Any rule at all | this file |
| What has been built, and what is left | `docs/PROJECT_STATUS.md` |
| Every realtime event name | `docs/reference/REALTIME_EVENTS.md` |
| Why a decision was made, dated | `docs/reference/DECISION_LOG.md` |
| Architecture, portability, capabilities | `docs/reference/ARCHITECTURE.md` |
| Every workflow, every branch, and what the row says after it | `docs/reference/OPERATIONS_MAP.html` |
| **Every screen, every button, every branch, every outcome — all three panels** | `docs/reference/PANEL_WORKFLOWS.html` (derived from the code; its appendix is generated) |
| SLOs, runbooks, on-call | `docs/reference/SRE_AND_OPERATIONS.md` |
| Branding field → consumer table | `docs/reference/BRANDING.md` |
| Machine-checked capability registry | `platform/capabilities.yaml` (`npm run verify:capabilities`) |
| What has been security-audited, and what has not | `docs/audit/SECURITY_AUDIT_MAP.md` (`npm run audit:map`) |
| **How this audit keeps missing things, and the four questions that find them** | `docs/audit/SECURITY_AUDIT_MAP.md` **§0.5 — read before trusting a green check** |
| **Every defect SHAPE found so far, how wide you must search to see it, and what actually found it** | `docs/audit/SECURITY_AUDIT_MAP.md` **§4.0 — the shape index. Read it before auditing anything.** |
| **What every change must REPORT, as a table, before it is done** | **§31 — the completeness contract** |
| **The twenty-five shapes that keep shipping here, each with the question that finds it** | **§32 — ask these of the change in front of you** |
| **How a player signs up, signs in, and is verified** | **§33 — the form, the bot fleet, the gate, and which limiter guards what** |

---

## 0.0 This platform is NOT DEPLOYED. There are no users.

**Development, pre-deployment. Zero live accounts, zero live money, zero live
merchants.** Nothing in this repository has ever served a real person.

So there is no migration to plan, no back-compatibility to preserve, and no
"existing users" to think about. **Build the target state and delete what it
replaces** — that is §30's "do not accommodate; remove", stated as a fact about
where this platform is rather than as a preference.

This is written down because it has been raised, and answered, repeatedly: an
agent reads a schema change and starts designing a migration path for accounts
that do not exist, or softens a replacement into a parallel code path so the old
one keeps working for nobody. Both cost real work and leave the second
implementation §2 exists to prevent.

When this changes — when the platform takes its first real deposit — this
section is the one that has to be rewritten first, and §29 already says what
readiness requires before that day.

---

## 0. Before you edit anything

1. Read this file to the end. It is the contract.
2. Identify which section governs your change.
3. Confirm the change violates no rule here.
4. If it introduces a new authority for a value, add it to §2.
5. If it removes a file, confirm nothing imports it (`npm run check:dead-code`).
6. If it adds a realtime event, check `docs/reference/REALTIME_EVENTS.md` for a
   typo variant of the name you are about to add, and add yours there.
7. If it touches branding, read §13 first.
8. If it touches the wallet, read §9 first.
9. If it adds a cycle type, board or game, follow §18 without being asked.
10. If it adds a route, a query, or a panel render of server text, run
    `npm run audit:map` and read the diff — the security audit map's counts are
    derived from the code and CI fails when they drift.
11. **Before trusting any green check, read
    `docs/audit/SECURITY_AUDIT_MAP.md` §0.5.** It records the failure mode of
    every AI session that has worked on this repository: every serious defect in
    the register was found only after the owner pushed back, never on a first
    pass. It lists the four questions that actually found them — *does anything
    CALL this; is this check a snapshot or a guarantee; if it fails halfway what
    does the row say; am I fixing the symptom or the cause* — and the gate blind
    spots that were reporting green over live defects.
12. **Read `docs/audit/SECURITY_AUDIT_MAP.md` §4.0 — the shape index — before
    you start looking for anything.** It lists every defect shape found in this
    repository, **how wide the search has to be before the shape is visible at
    all**, and what actually surfaced it. Two radii cannot be reached by reading
    code — *plus the clock* (what changes between a read and the write it gates)
    and *plus the business model* (who bears the loss) — and those are where the
    HIGH findings live. "I read the whole file" is not an answer to "did you
    check the clock".
13. **Before you report the change as done, fill in §31's table.** Every front,
    every row, with `done` / `n/a` + reason / `NOT DONE`. The rows nobody fills
    in are where every defect in the 2026-09 review was living, and none of them
    was a wrong calculation.
14. **Ask §32's twenty-five questions of what you just wrote.** They are the shapes
    this codebase has actually produced, each with the question that finds it.
15. **If it fixes a vulnerability, sweep for the same SHAPE across the whole
    codebase and record the result** — including "swept, none found". A fix that
    closes one instance and leaves its siblings is how `setOrderFields` shipped
    the same defect three times (§21). The procedure and the register are in
    `docs/audit/SECURITY_AUDIT_MAP.md` §1 and §4.

**For AI sessions specifically.** You cannot assume your context holds the
current state of this codebase. Verify target text exists before generating a
patch, with the exact string rather than a paraphrase. If you cannot verify,
say so and ask.

**Your session is ephemeral; this repository is not.** Any plan, queue or
research that gates implementation work is committed in the session that
produces it. This rule exists because it has already been broken twice: a
prior session's implementation list was lost with its container, and then a
later session's finished feature work was lost the same way, having never been
committed. Only commits survive. See §17.4.

---

## 1. The rule

**PostgreSQL is the only datastore. There is no second store.**

This platform stores every piece of state — money, identity, configuration,
content, engagement — in PostgreSQL. There is no document store, no mirror, no
dual write, no reverse sync, no reconciler, no authority resolver, no capability
flag and no cutover. Those things were an abandoned plan. Any document
describing them describes something that no longer exists; correct it or delete
it, do not follow it.

Do not add a second store. Do not add a compatibility shim for one. Do not
reintroduce an ODM. If a piece of code will not work without one, the code has
not been migrated yet — migrate it, do not accommodate it.

### Consequences that follow from the rule

- **A failing test is not a reason to write a document-store fixture.** It means
  the code under test has not been moved to PostgreSQL yet. Move it.
- **Never read a money decision from one store and execute it in another.**
  Affordability, withdrawal admission and merchant assignment all decide with
  money; every one of them reads the same rows it writes.
- **Do not mock the boundary that carries money.** A suite that mocks the
  settlement writer and asserts on its arguments once reported settlement
  working while the real function threw on every call. Where a boundary carries
  money, test through it against a real database.
- **Removal happens in sweeping passes**, with scripts and codemods across the
  whole codebase — not one call site at a time, waiting for CI to say what is
  next.

### The gate

```
npm run check:no-mongo
```

Non-zero exit with a per-file report while any count is above zero. It runs in
CI and is the definition of done for the migration. It also prints progress as a
percentage of the references that existed before removal began.

**That printed figure is the only progress number to quote.** An estimate made
from memory carries its own denominator, and two estimates taken a day apart are
not comparable: reporting 65% and then 62% looked like regress while every count
was in fact still falling. If somebody asks how far along the migration is, run
the gate and read the number off it.

`scripts/verify-no-mongo.mjs` is the only file permitted to name the forbidden
strings, because it is the thing that forbids them. It excludes itself by path.
Nothing else is exempt — not a comment, not a variable name, not a doc.

**Status as of 2026-09-09: all eight counts are zero.** The migration is
mechanically complete. That is not a claim that the platform is ready — see §28.

---

## 2. One owner per value

Each value below has exactly one owner. Nothing else may store, compute or
default it independently. **This table is the anti-drift mechanism**: a value
with no listed owner gets a second implementation, and a value listed with the
wrong owner gets working code deleted by the next reader.

> Owners are **PostgreSQL tables reached through `database/repositories/`**, or
> exported constants. The ODM model files this table used to name
> (`*.model.js`) no longer exist.

| Value | Owner |
|---|---|
| Token buy/sell rates | **Removed 2026-07-08** — conversion is fixed 1:1 (1 token = ₹1) and not configurable. Public rate endpoints return a constant for client compatibility. Do not reintroduce configurable rates. |
| Deposit/reserve split, reserve usage rules | `deposit_policies` via `domains/configuration/depositPolicy.service.js` — whole-document versioned, one ACTIVE per currency. |
| Bet min/max per cycle type | `SystemConfig.betLimits` (`config_documents`) |
| Cycle phase offset defaults | `DEFAULT_CYCLE_PHASES` in `database/spec/config.spec.js`, re-exported by `domains/markets/cycleTypes.js`. It **is** the schema default. Runtime authority stays `SystemConfig.cyclePhases`. Three copies had already drifted once — the admin phase timeline drew a betting-close boundary 30 seconds off what the engine acted on. |
| Resolved-cycle history feed | `domains/markets/cycleHistory.service.js` — the one query behind every cycle-history read. Window is **per type**, `limit` rows each; capped at 1,440 for one type and 200 when several are requested together (three deep windows is ~864 KB against socket.io's 1 MB default). Rows project through `publicCycleView`. |
| Analytics window depth | `ANALYTICS_WINDOW` in `user-panel/src/constants.ts`. A **target**, not a display cap; the server ceiling is enforced independently in `cycleHistory.service.js`. |
| Deposit/withdrawal limits, platform-wide | `SystemConfig` |
| **Whether a business number is admin-editable at all** | `SYSTEM_CONFIG_SPEC` in `database/spec/config.spec.js` — **declaring a field there is what makes it editable.** The PUT in `system.admin.routes.js` derives what it accepts by WALKING the spec; the GET spreads the spec-defaulted document. So a setting is served, accepted and bounds-checked by virtue of being declared, and nobody has to remember to wire it. It was three hand-written lists that disagreed: twelve `merchantOrderLimits` fields declared and **four** writable; `withdrawalHoldMinutes`, both `loadShedding` ceilings and all eight `ipDefense` fields read by live middleware and reachable from nothing — two of them under a comment calling them "admin-editable"; and the one-minute board's four phase offsets run by the engine and invisible to both halves. `maxConsecutiveRejections` was the sharpest: **returned by the GET and dropped by the PUT**, so it was rendered on the settings screen and inert — an operator raising the cap was told it saved and served the old number, §3 in both directions at once. See F-022. |
| **A value in that document the PLATFORM writes, not an operator** | `internal(…)` in the spec. Deriving an accept list from the spec is only safe if the spec says which entries are not settings: `adminTokenSupply.minted` is the running total of tokens ever issued, checked against a 10-billion cap, and an operator who could set it to 0 would re-authorise minting the whole supply. Mark it at the DECLARATION — the reason belongs to the value, not to any route's memory — and every derived list skips it. |
| **A board's ceiling on its earliest phase offset** | `maxMergeBeforeEndSec` on the cycle META (`domains/markets/cycleTypes.js`), reached through `MAX_MERGE_BEFORE_END_SEC`. §18.3's "phases must fit the block" is the half the ordering invariant cannot see, and it was two literals passed at one call site covering two of the three boards. The board it omitted was the 60-second one, where an oversized merge is easiest to enter. A new board declares its own value (§18.2). |
| The FLOOR on any order | `SystemConfig.minDeposit` / `minWithdrawal` — **both 500 tokens**, the same rule read from either end. The buy floor was 100 and the sell floor 500: one policy written as two numbers, drifted. A floor exists because every buy HOLDS a merchant's tokens for the length of its window (F-018), so an order too small to be worth that inventory still takes it out of circulation. |
| The CEILING on any order | **The tokens the merchant holds**, and it is ENFORCED rather than checked — the deposit escrow reserves them at assignment. There is no per-merchant order range: `merchants.min_order`/`max_order` were **removed 2026-09-10**, along with their columns, their admin route fields and their panel inputs. Nothing read them. `assignmentCandidates` never named either column; the only filter on them lived in an admin SCREEN, while a comment in `merchant.routes.js` said assignment filtered on them and was believed twice. Do not reintroduce a per-merchant range. |
| Consecutive-refusal cap, and who may not serve whom | `domains/merchant/merchantRefusal.service.js` — the ONE owner of "a merchant did not serve this order". **Whose fault an expiry is depends on the DIRECTION**: a BUY that expires before PAID is the PLAYER not paying and is not a refusal at all; a BUY that is PAID and unanswered, a SELL that expires, and any decline are the merchant's. Counting every expiry against the merchant suspended honest merchants for players who changed their minds. **There is no timer on any of it**: a suspension and a bar are lifted by an admin or sub-admin who reads the reason and reinstates, and `approveMerchant` zeroes `consecutive_rejections` in the same statement — left standing at the cap, the reinstated merchant is re-suspended by the very next refusal and the admin's decision lasts one order. A decline and an EXPIRED assignment are the same event and count identically, against the same streak and the same bar; they mix, so two lapses and a decline is three. The cap is `SystemConfig.merchantOrderLimits.maxConsecutiveRejections` (schema default 3); the pairs are `order_rejections`, applied in `assignmentCandidates`' WHERE so a barred merchant is never a candidate. The streak advances and is read in one `UPDATE … RETURNING`, and only a COMPLETED order resets it. See F-021. |
| Merchant settlement rail | `merchants.accepted_currencies` — **exactly one** entry, `INR` or `USDT`. Vocabulary in `domains/merchant/merchantCurrency.js` (`MERCHANT_CURRENCIES`, `merchantTypeOf`, `isUsdtAddress`). Do not re-declare the rail strings or a second address pattern. |
| Which rail an order settles on | `order_states.currency`, matched against the merchant's rail at assignment and at accept. |
| How an order reaches a merchant | **A BUY is ASSIGNED, never claimed** — `tryAssignMerchant` ranks the eligible merchants so the biggest holder takes the biggest order, and the accept handler refuses a `PENDING_QUEUE` deposit. Letting merchants claim a queued buy first-come rewarded whoever polled hardest and threw the ranking away. **A SELL may be claimed from the open pool**, deliberately: a withdrawal nobody is free for waits in the open rather than burning retry attempts (`selectBestMerchant` returns null for it). A cash BUY is matched to a link through `tryClaimCashLink`, which is a queue on the supply side, not a contest. |
| An expired BUY order | **Nobody's fault, and still a signal — two of them.** `domains/payment/playerPaymentFailure.service.js` is the ONE owner and advances BOTH counts, so an expiry cannot be recorded against one party and forgotten against the other. It is neither a refusal nor an accusation: the player abandoned a purchase, which is ordinary, and the merchant did nothing. Two earlier versions got this wrong in opposite directions — one suspended honest merchants for players who changed their minds, the next marked the players. |
| Three unpaid buys by one PLAYER | `users.consecutive_payment_failures` (advanced and read in one statement); at `maxConsecutivePlayerPaymentFailures` (schema default 3) they cannot open a new order for `playerOrderLockMinutes` (60) — **on BOTH rails**, or a player locked out of buying just sells instead. `users.order_lock_until` is a TIMESTAMP written by the DATABASE's clock, so it expires on its own with no cron to fail, and `GREATEST` extends rather than shortens. Flagged for an admin too, **never auto-blocked**. Cleared by `moveDepositMoney` — where the money is known to have ARRIVED, not at PAID, or a false UTR would wipe the record. |
| Three unpaid buys against one MERCHANT | `merchants.consecutive_expiries` — **deliberately NOT `consecutive_rejections`**, because an expiry is not a refusal and must never reach the suspension cap. Three different players sent to one merchant, none able to pay, most likely means that merchant cannot BE paid (dead QR, closed handle) — invisible one order at a time. At `maxConsecutiveMerchantExpiries` (schema default 3) `assignment_paused_at` is set and they stop being a candidate on every path: `assignmentCandidates`, `cashSuppliersFor`, and the cash-link claim. **Not a suspension**: they keep their orders, balance and standing. **No timer** — `PUT /api/admin/merchants/:id/resume-assignment` lifts it, because a clock cannot tell whether the QR was fixed; `approveMerchant` clears it too, and both zero the count in the same statement. Any COMPLETED order clears the run by itself. |
| A merchant who ignores a PAID buy | `sweepUnansweredPaidDeposits`, every 2 minutes, against `SystemConfig.merchantOrderLimits.paidResponseMinutes` (schema default 30). The order goes to **DISPUTED** — the admin queue — never cancelled and never reassigned: the player paid THAT merchant's account, so only a person can decide. `disputeRaisedBy` is `'system'`, because a player who raised nothing must not appear to have. The silence counts as a refusal. This was the one window where the player's money was already gone and nothing was watching it. |
| **A cash player who taps Paid and never submits a reference** | `sweepUtrAfterPaid`, every 2 minutes, against `SystemConfig.merchantOrderLimits.utrAfterPaidMinutes` (schema default 15, bounded 2–60). **Only on the CASH_ATM rail**, because only there does PAID come before the reference. An ATM has a time limit: the player taps **Paid** so the merchant can press Continue on the machine, and the UTR arrives after, off the slip. So `PAID` with no `utr` is a state this rail deliberately creates, and two sweeps had to be split to tell the two silences apart — `sweepUnansweredPaidDeposits` (the MERCHANT ignoring evidence that exists) now requires `utr IS NOT NULL`, or it would have counted a refusal against a merchant who had been shown nothing. This one is the PLAYER's silence and goes through `playerPaymentFailure.service.js`, the one owner of "a buy nobody evidenced" — never through `merchantRefusal`. |
| Who may be given a CASH order | The claim query in `database/repositories/cashLinks.js`, which now asks every question `assignmentCandidates` asks on the UPI rail — ACTIVE, APPROVED, online, accepts buys, the merchant's own rail and tier, both concurrency caps, and the `order_rejections` bar. It joined `merchants` not at all before, under a comment saying so deliberately, so a merchant an admin had stopped kept being handed players through a link they had left behind. **A link is supplied minutes before it is claimed: eligibility is a question about the claim, not about the supply.** |
| Which CHAIN a USDT order settles on | `order_states.usdt_chain`, frozen by trigger. A merchant holds one address **per chain** (`usdt_address_trc20`, `usdt_address_bep20`). See §25. |
| The USDT quote | `order_states.rate_used` + `fiat_amount_paise`, written WITH the order and frozen by trigger. Assignment may not re-price. See §25. |
| USDT buy pricing | `SystemConfig.usdtPricing` — admin-set, bounded at both ends. There is no USDT sell rail. |
| The settlement rail in force | `payment_mode_policies` — one ACTIVE version, append-only, justified. **Not** a feature flag (`featureFlags.service.js` is an env var and an in-process Map: it does not survive a restart and cannot say which rail was live when an order was created). **Not** `payment_gateway_configs.active_mode`, which is P2P vs a third-party gateway — both rails here are P2P. |
| The rail an ORDER runs under | `order_states.payment_mode`, stamped at creation by `stampForNewOrder` and **immutable by trigger**. Every worker and screen branches on the order's own value, never the current policy. |
| Merchant earnings | `merchant_commission_policies` + `merchant_commission_rates` (one row per variety), read by `domains/merchant/merchantCommission.service.js`, which owns no numbers. Platform-funded from `MERCHANT_BONUS_POOL`, never deducted from users. Do not reintroduce `commissionRate`, a buy/sell spread, or a deposit-triggered commission. See §26. |
| **How many tokens exist, and where they are** | **`SystemConfig.adminTokenSupply.total` — 20,000,000,000, and NONE ARE EVER CREATED** (owner, 2026-09-23). The platform starts holding all of them; every movement after that is a TRANSFER — platform → merchant when a merchant buys inventory, merchant → player when a player buys, and back the other way when they sell. So `platform holding + every merchant wallet + every player wallet = total`, always, and that is an invariant the double-entry books prove rather than a promise a counter makes. `transferred` is what has left the platform's own holding (`internal`: an operator who could set it to 0 would be telling the platform it still holds tokens it has already given away); what it still holds is `total - transferred`. **Do not reintroduce minting.** The word survived in `reserveAdminMint`, "Approving one mints supply", and a 10-billion "cap" that read as a ceiling on creation — all of which described a model this platform does not have. |
| Merchant token balance mutations | `domains/merchant/merchantWallet.service.js` exclusively — idempotent `tx_id`. |
| **What the platform GOT, or GAVE, for an admin↔merchant token movement** | `admin_token_considerations` via `database/repositories/adminTokenConsiderations.js` — one row per movement, keyed BY the movement, so the money fact inherits the token movement's idempotency instead of inventing its own. The treasury says the tokens moved; nothing said what they moved FOR, so every P&L reading of the admin↔merchant leg was missing its revenue side and the books balanced in tokens while saying nothing about money. **Two amounts, deliberately** (trap 15): `fiat_amount_minor` is hundredths of the currency actually transacted — what a human is shown and what reconciles against a bank line or a chain explorer — and must NEVER be summed across currencies; `inr_equivalent_paise` is the same event in rupees and is the ONLY column anything may aggregate. `rate_used` is frozen on the row for §25's reason: an operator editing the USDT price must not restate a settled trade. The figure is **REQUIRED** on both routes and **0 is a real answer** meaning "no money changed hands" — absence and zero are different facts, and a nullable column could not tell them apart. USDT comes IN only; the platform buys its tokens back in rupees (owner, 2026-09-23), stated as a CHECK so the rule survives the next route that writes here. Validated BEFORE any token moves, because the row is written after the movement commits (§21). |
| A merchant's tokens on a BUY order | **HELD, in `merchant_settlements` (`direction='DEPOSIT'`), through `domains/merchant/depositEscrow.service.js` — the one owner.** Taken at ATTACHMENT by all three routes that attach a merchant (auto-assignment, admin assign/reassign, claiming from the open pool); released automatically on every terminal outcome; consumed by the confirm. At most one live hold per order, enforced by `merchant_settlements_one_live_deposit`. **No gate may ADMIT an order by reading a balance** — a read in one statement acted on in another is a snapshot, and two orders arriving together both passed it. Taking the hold IS the check. See §9 and F-018. |
| Whether a merchant's held tokens can be taken by anything else | **No.** Every other movement touches `available`; `reserved` is reachable only through the settlement state machine. An admin deduction is `legs: { available: -a }`, so it cannot reach a player's promised tokens, and no production caller passes `allowNegativeAvailable`. |
| Whether a merchant is owed a hold they do not have | `findUnheldDepositOrders()` + `findStrandedDepositHolds()`, swept every 5 minutes by `sweepDepositHolds`. A stranded hold is RELEASED; an unheld order is **reported, never silently re-held** — re-taking it hides the path that forgot. `getSpendablePaiseFor()` is the same question as an invariant: with universal holds it must EQUAL `available`, and any divergence is an unheld order. It is no longer a gate. |
| Wallet balance mutations (player) | `domains/wallet/walletAuthority.service.js` exclusively, **including a bet's stake lock**. A route may not move a balance. |
| Wallet balance READS | `walletAuthority.getBalances()`, reading the `wallets` row. No second copy of a balance exists or may be introduced. **Every read is classified display or decision** — see §9. |
| Money in/out of the ecosystem | `domains/funding/fundingAuthority.service.js`; rails are adapters in `providerRegistry.js`. Never owns accounting. |
| Settlement ledger / accounting events | `accounting_events`, written ONLY via `domains/revenue/revenueSettlement.service.js`. Append-only double-entry, integer paise, unique idempotency keys, balances always derived from postings and never stored. |
| External payment references (UTR, chain tx hash, CDM slip) | `utr_registry` via `claimPaymentReference()`. One reference, one order, for good. See §27. |
| What a failed request tells its caller | `backend/shared/httpError.js`. `serverError` logs in full and answers with nothing; `callerError` keeps a refusal's own wording; `respondError` routes a `catch` that holds either, on the PRESENCE of `err.status` and never its value. A handler may not phrase a 5xx itself. |
| Order lifecycle state | `order_states.state` — `PENDING_QUEUE, ASSIGNED, PROCESSING, PAID, COMPLETED, DISPUTED, CANCELLED, FAILED, REJECTED`, enforced by CHECK. |
| Which fields the lifecycle may write | `SETTABLE` in the order writer. See §21. |
| Dispute resolution | `order_states` embedded dispute fields. There is no separate dispute table. |
| Cash denominations and USDT sizes | `domains/merchant/denominations.js`. The SQL CHECKs duplicate the lists by necessity; `merchantDenominationsPg.test.js` asserts the database agrees. Not admin-editable. |
| Referral reward, budget, member cap | `REFERRAL_REWARD_PAISE` in `domains/referral/referralRewards.js` (flat ₹25) and `referral_programmes`. A flat one-off per verified signup, two tiers, from a bounded pool — never a share of anyone's losses and never attached to settlement. |
| Referral earnings ledger and payout order | `domains/referral/referral.service.js` exclusively. Append-only, unique on `(sourceUserId, level)`; eligibility evaluated at payout. Pays strictly in joining-number order through `creditWinnings`. |
| Player contact details | **There are none beyond the mobile.** No player email exists; the bot never asks for one. `SupportLinks.email` and `merchants.email` are different things and stay. |
| Aadhaar mutability | An APPROVED Aadhaar is immutable. A REJECTED one may be replaced **on the panel** (`POST /api/v1/auth/kyc/resubmit` → `domains/identity/aadhaarResubmission.service.js`) up to `MAX_KYC_SUBMISSIONS`. A FAILED submission's row is DELETED, because `aadhaar_hash` is unique and a typo would otherwise park a stranger's Aadhaar in that index and lock its owner out forever. `users.mobile` is never mutable — which is why the signup form normalises `+91` and a leading `0` off the number BEFORE it is written (§33). |
| Identity documents | **None are collected, stored or accepted.** KYC is a 12-digit Aadhaar number held as an HMAC plus AES-256-GCM ciphertext. Do not add an upload path for one. |
| Upload categories that DO exist | `services/cdn.service.js` — P2P chat attachments, payment proofs, admin branding assets, CDM receipts. Nothing else. "No KYC documents, so remove the upload routes" would break deposits and disputes. |
| The live bot and official channel | `telegram_configs` (the active generation, owning the channel) plus the bot registry, composed by `activeConfig()` in `domains/telegram/telegramClient.js`. **The registry wins over a generation's embedded credentials.** A bot swap does NOT bump the generation; only a channel change does. The 30s cache in `activeConfig` is the only permitted cache. |
| **Which PANEL a bot, a channel or a Telegram link belongs to** | `audience` on `telegram_bots`, `telegram_configs`, `telegram_identities` and `telegram_recovery_sessions` — taking exactly the values `users.account_type` takes, so an account's TYPE **is** its audience and nothing else decides which bot serves whom (owner, 2026-09-24). Each panel gets its own sign-in FLEET and its own singular recovery bot: `live_slot` composes the audience in, or the one partial unique index refuses the second panel's recovery bot on the INSERT. Each gets its own channel, so `one_active_telegram_config` is unique on `(audience) WHERE active` — unscoped, activating the merchant channel deactivated the player one and re-gated every player. `telegram_identities` is keyed **(telegram_user_id, audience)**: one person opens all three bots from ONE Telegram account, which a bare key made impossible. Generations stay GLOBALLY unique across all three, which makes a cross-panel stale membership unrepresentable rather than merely unlikely. Every repository read that DECIDES something takes a required audience and THROWS without one, for the reason `getUserByMobile` does. |
| **Where each panel lives, for a link the platform mints** | `panelOrigin()` in `backend/config/panelOrigins.js`. A staff password-reset link sent to the player app is a single-use token spent on the wrong door. `PUBLIC_APP_ORIGIN` is the player's and the fallback for the other two, which is right for the ordinary single-host deployment; `ADMIN_PANEL_ORIGIN` and `MERCHANT_PANEL_ORIGIN` are set when the hosts are genuinely split. |
| **What each audience is CALLED on a screen** | `PANEL_NAME` / `PANEL_NOUN` in `domains/identity/audiences.js`. `ACCOUNT_TYPES` owns the VALUES; this owns the words — kept apart so a renamed label cannot move the database's vocabulary. It exists because the channel-replacement route answered "Every player will be asked to join the new channel" whatever panel had just been flipped, which on the merchant screen is the sentence that makes somebody flip it back. |
| **Whether a STAFF account may pass its own gate before staff Telegram exists** | `verificationStateFor`'s `bootstrap`. STAFF only, and only while `no_bot` or `no_channel` — the screen that registers the staff bot is ON the admin panel, behind the gate that has nothing to check, so a literal reading of "all three panels gate" is a deadlock no account can break. It is RETURNED, never a silent pass, and the admin panel renders it as a standing banner naming the screen that closes it: an exemption nobody can see is one nobody removes. |
| **How many sign-in bots there are, and which one a player gets** | `telegram_bots` (role `signin`, any number ACTIVE) + `assignSigninBot` in `database/repositories/telegram.js`, wrapped by `domains/identity/signupVerification.service.js`. **`signin` is a FLEET; `recovery` is singular** — the generated `live_slot` column names recovery only, and the partial unique index enforces one live recovery bot. The rotation cursor is the SEQUENCE `telegram_signin_rotation`: `nextval - 1` modulo the live count, over the fleet ordered `added_at, bot_id`. The assignment is STORED on `users.telegram_bot_id` because the player is TOLD which bot to open, and re-resolved on every read so a retired bot's players move on their own. Retiring the LAST live sign-in bot is refused **in the statement**, by counting what would be left. |
| **Whether a player may use the app at all** | `domains/identity/signupVerification.service.js` — `verificationStateFor()`, served by `GET /api/v1/auth/verification`. It answers the contact share and the channel membership together and hands back ONE `reason` naming the one thing to do next. **Not `kycStatus`** (that is the admin's bulk Aadhaar verification, on its own clock) and **not two endpoints** — the panel reads `reason` and nothing else, because a screen deriving that from four booleans derives it differently from the next screen that tries. |
| **Which POPULATION a `users` row belongs to** | `users.account_type` — `PLAYER`, `STAFF` or `MERCHANT`, declared in `ACCOUNT_TYPES` (`database/repositories/users.js`) and enforced by `users_account_type_check`. **A mobile is unique PER TYPE** (`users_mobile_per_account_type`), so one person may hold all three with three different passwords, and the credentials for one do not work at another door (owner, 2026-09-24). `getUserByMobile` REQUIRES the type and throws without it: a default would have made every un-updated caller silently correct for players and silently wrong for the other two — failing only on the accounts that move money. **MERCHANT is in this column and that surprises people**: a merchant signup writes a `users` row (the login) as well as a `merchants` row (the trading identity), so merchants living in their own table does NOT make their login separate — without a type of their own that row defaulted to PLAYER and the player door admitted a merchant's merchant password. |
| **Whether a session issued earlier is still valid** | `users.sessions_valid_from` + `sessionSuperseded()` in `domains/identity/auth.middleware.js`. Sessions are stateless PASETO and nothing holds a list of the ones outstanding, so this cutoff is the ONLY way to evict them; a password reset moves it to `now()` in the same statement that writes the hash. **Both authenticated paths check it** — `authenticate` and `GET /api/v1/auth/me`, which verifies its token inline and never calls the middleware. It was in one, and the pre-reset session kept answering 200 on the endpoint every page load uses to restore a session. |
| **A password reset link** | `password_resets` + `domains/identity/passwordReset.service.js`. Issued by a bot to a number Telegram has verified, because there is no player email. It grants the right to CHOOSE A PASSWORD and **never a session** (owner, 2026-09-24) — a fleet of hundreds of bot tokens must not be able to sign anybody in. SHA-256 at rest, single-use (`consumed_at` set in the same UPDATE that reads it), expiry in the WHERE, one live token per account, and the token rides in the URL **fragment** so it never reaches an access log or a `Referer`. PLAYER accounts only, refused twice over. |
| **Which door a password login arrived at** | `LOGIN_DOOR` in `backend/routes.js`, set by the MOUNT. One `loginHandler` serves both `/api/admin/login` (staff) and `/api/v1/auth/login` (players); they differ only in who they admit, and every other thing they do — reading the hash from the one function that returns it, the blocked refusal, the argon2 upgrade, issuing a challenge INSTEAD of a session — is identical and must stay identical. **The door scopes the READ by `account_type`**, so the separation is a predicate rather than a check made afterwards: the staff door never loads a player row at all, and a flipped `is_admin` cannot admit one. Checked on BOTH legs, so a challenge minted at one cannot be redeemed at the other — and on the 2FA leg the type is compared explicitly, because that leg reads by user id and the predicate never touched its query. |
| What the bot says | `TelegramTemplate` rows via `telegramTemplates.service.js`, with `DEFAULT_TEMPLATES` as fallback. A blank row means the shipped default, never silence. Do not hardcode a player-facing sentence in a route. **Which BOT sends it is a separate question** — `sendTemplate({ bot })`, always, on the sign-in fleet: a bot may only message somebody who has opened a chat with IT, so a reply from any other bot is refused by Telegram and reads to the player as a conversation that simply stopped. |
| What a valid Aadhaar, mobile or referral code LOOKS like | `backend/domains/identity/signupFields.js`. Both ends import it — the form that takes what a person typed, and the contact share that takes what Telegram verified — because if they normalise a phone number differently the match fails for a player who did nothing wrong, silently. The user panel keeps a §5 MIRROR (`indianMobile` in `AuthModal.tsx`) because §15 forbids importing from `backend/`; change them in the same commit. |
| What a password may be | `backend/domains/identity/passwordPolicy.js` — `assertStaffPassword` (12) and `assertPlayerPassword` (8), ONE implementation with two floors. The floor is set by BLAST RADIUS: a staff password reads the whole player base and the ledger; a player's reaches one wallet. Everything above the floor is identical, deliberately — a second copy is where the degenerate-run check quietly stops being applied to players. |
| Notifications, all channels | `domains/communication/communication.service.js` `notify()`. Never write a notification row directly. |
| Transaction/bet validation and operational rules | `domains/risk/riskValidation.service.js` — the only place this logic lives. Configurable numbers stay in `SystemConfig`. |
| Cycle timing | `domains/markets/cycleGenerator.service.js` computes; `GAME_CORE.ts` mirrors for display math only. |
| Cycle-type vocabulary | `domains/markets/cycleTypes.js` — names only, never numbers. Throws on an unknown type rather than defaulting, because the ternaries it replaced failed silently. |
| Game catalogue | `games` + `game_categories`. No hardcoded game arrays anywhere. |
| Trading vocabulary | `domains/trading/tradingModels.js` |
| Sub-admin permission keys | `users.sub_admin_permissions`; frontends import from `utils/permissions.ts`. |
| Chat rules | Chat config document via `/api/chat/config` |
| Branding | The `Branding` document — see §13 |
| Social/support links | `SupportLinks` — **not** Branding |
| Auth tokens | One storage key per app (`auth_token` / `merchantToken` / `admin-auth`) |
| Realtime event names | `docs/reference/REALTIME_EVENTS.md` — see §12 |
| App version | `package.json`, read via `VITE_APP_VERSION`. Never a literal in a component. |

---

## 3. Forbidden patterns

- **No frontend hardcoded business value that has a backend config equivalent.**
  A `??` fallback must equal the schema default, never an independent number.
- **No admin-editable field without a real consumer.** If a value can be changed
  through an admin API or UI but nothing reads it to alter behaviour, that is a
  violation. Any new admin setting ships with its consumer in the same change.
- **No shadow table duplicating another's responsibility.**
- **No frontend enum or constant mirror with zero consumers.**
- **No second write path to a value with a designated single writer.**
- **No realtime event emitted under more than one name for the same change.**
- **No private realtime channel without a verified backend registration route.**
- **No version literal in any component source file.**

---

## 4. No hardcoded business values

- Any number representing a business rule originates from a database-backed
  config document. A `??` fallback is a loading placeholder only, permitted when
  its value equals the schema default and a comment cites that default.
- **Any colour, font, logo path or app name shown to a user originates from
  `Branding`**, injected as a CSS variable (`--brand-primary`,
  `--brand-secondary`, `--brand-accent`) or via `localStorage.app_branding`.
  Never a hex literal in a component. This is still being remediated; re-count
  with `npm run report:branding` (`--files`, `--lines`), **never by grepping a
  hex**.

  **The count is ZERO as of 2026-09-17, and the report now FAILS the build.**
  Run it; do not quote a number from here.

  How it got there, because two of the three steps were not remediation:

  | | count | what happened |
  |---|---|---|
  | quoted here | 89 | wrong — `grep -ro "D4AF37"` counts one spelling of one of three colours |
  | first real report | 209 | all three colours, every spelling |
  | after the dead-UI delete | 117 | **92 were in code no screen had mounted** since `RedesignShell` replaced `Layout/Header`. Not repainting — deletion. |
  | after the repaint | **0** | every tint repointed at `--brand-*-rgb` |

  The original 89 was reassuring in every direction: it said the merchant panel
  was at zero when it was at one, and the admin panel at two when it read nine.
  The work looked nearly done, and an operator changing their brand colour would
  have found most of the player panel still gold. That is §29 — absence of a
  failing check is not evidence when no check covers the claim.

  **Why a hex was not enough, and what fixed it.** `--brand-primary` is a hex,
  which is all `color: var(--brand-primary)` needs. But most brand colour in
  these panels is tints, glows, borders and shadows, and CSS cannot take an
  alpha channel off a hex variable — so the same colour was written twice: once
  as a token an operator controls, and a hundred times as a literal rgba()
  triplet they do not. Each panel now also publishes `--brand-primary-rgb`,
  `--brand-secondary-rgb` and `--brand-accent-rgb`, **derived** from the saved
  hex by its own `services/branding.ts`, never stored separately, so the two
  cannot disagree (§2). A tint is `rgba(var(--brand-primary-rgb), 0.25)`.

  **One applier per panel.** The user panel had two — `App.tsx` and
  `GameContext` — and they had already drifted: one titled the tab from
  `userPanelName` and the other from `appName`, so which name appeared depended
  on which fired last. §5, exactly.

  **And the owner itself was wrong.** `SYSTEM_CONFIG_SPEC.branding` declared
  `secondaryColor: #8B5CF6` (purple) and `accentColor: #F59E0B` (amber) while
  the shipped panel rendered `#B8860B` and `#F5C77A`, and the admin form
  defaulted to a third set. Only the primary agreed. It never showed because
  nothing READ the secondary or accent — they were literals — so the drift was
  invisible until the tints were repointed at the tokens, at which point the
  spec's purple would have appeared as borders on a gold panel. The spec is now
  aligned to what the product renders: an owner that disagrees with every
  consumer is the wrong number, not the true one.

  A literal is PERMITTED in exactly three forms, and `isAnchor` in the report
  implements all three: the token's own declaration (`--brand-primary: #D4AF37`),
  a `var(--brand-primary, #D4AF37)` fallback, and a loading placeholder that
  CITES the schema default in a comment. The third is this section's own wording
  and the report did not implement it — it was handed the comment-STRIPPED line,
  so a citation could never be seen and the rule could not be satisfied by any
  line that followed it.

- Any permission key, status enum or event name originates from a shared module.

---

## 5. No duplicates

- Before adding a constant, enum or config field, search for the existing one
  and extend it.
- Before adding an admin-editable setting, confirm a consumer reads it in the
  same change.
- Before adding a realtime event, grep the registry for typo variants.
- A frontend mirror of a backend enum requires a comment citing the exact
  backend file and field, plus an entry in §2.

**Say it in the form it keeps being violated: the same payload assembled in two
places drifts, and it drifts silently.** The system-config payload was built
twice — once in `socketHandlers.js`, once in the HTTP route — with independently
written fallbacks, and they had already diverged: the socket carried
`webUrl`/`androidUrl`/`iosUrl`, the route carried
`kycRequired`/`registrationEnabled`, and a client got a different answer about
the platform depending on which one it asked. A value an operator can edit is
only config if **every** consumer reads the same owner. Two builders with
matching defaults are not one owner; they are one bug waiting for the next field.

---

## 6. Configuration ownership

- `SystemConfig` owns platform-wide operational limits.
- **There are no per-merchant order caps.** A merchant's ceiling is the tokens
  they hold, enforced by the deposit escrow; the floor is platform-wide. The
  columns that claimed otherwise were removed once it was clear nothing read
  them — §3, an admin-editable field with no consumer is a violation, and a
  column nothing reads is the next reader's false lead.
- Every config field exposed by an admin route has its default in exactly one
  place: the column `DEFAULT` in `database/schema.sql`, or the single exported
  constant the repository applies when a JSONB key is absent. Every server-side
  fallback matches it. **Citation required** — write `// schema default: 500`
  next to every `??`. If you do not know the default, look it up first.
- Config cached client-side documents its staleness window in a comment at the
  cache definition.

---

## 7. Workflow ownership

- A workflow has exactly one state field per logical question.
- Cron jobs are verified to run against the table the real workflow populates.

---

## 8. Route ownership

- **Merchant panel** derives paths from `merchant-panel/src/constants.ts`
  `ROUTES`; its nav and `<Route>` table use the same object.
- **Admin and user panels do not**, and this section used to claim they did. The
  admin panel's `ADMIN_ROUTES` was imported by nothing — every route wrote its
  path as a literal — so the file was deleted rather than left as a module
  claiming ownership it did not have. A constants module nobody imports is not
  one owner; it is a second place for a path to be wrong.
- Adopting route constants in those two panels is open work, not a rule they are
  breaking in silence.

---

## 9. Balance ownership

- All balance reads and writes go through `walletAuthority.service.js`.
- No handler performs a raw increment or read-then-write on a balance.
- Settlement computes amounts and calls the wallet authority.
- **Settlement pays no commission.** The engine credits winners and nothing else.
- The referral programme does not touch settlement: a flat amount per verified
  signup from a bounded pool, on an admin-triggered disbursal, through
  `creditWinnings`. No bet result is ever a payment trigger.
- **Classify every balance read as display or decision.** A display read may be
  stale; a decision read may not. Money decisions read from the wrong place were
  found in three: bet-placement affordability, withdrawal admission, and
  merchant assignment. `npm run check:balance-reads` enforces it mechanically —
  a number that GATES a transfer is read from the rows the write will lock.

---

## 10. Admin ownership

- Every field on an admin settings page wires to a real consumer in the same
  change.
- The admin panel applies its own branding.
- Admin dashboard statistics read from the table the workflow actually writes.

---

## 11. Allowed exceptions

- A genuine UI-only value (chip denominations, a display countdown) may be a
  frontend constant provided it is never used for server-side validation and a
  comment says so, citing this section.
- A temporary duplication during an in-progress migration is allowed for the
  shortest practical window and removed by the change that completes it.
- Display-only timing mirrors are allowed when the real gating is server-side.

---

## 12. Realtime events

**One name per logical change, unique across all three transports** — socket.io
(public browser clients), SSE (private authenticated streams), and the emitter
(`domains/notification/realtimeEmitters.js`). Never reuse a name on a different
transport for a different meaning.

The registry is `docs/reference/REALTIME_EVENTS.md`. **Any new event is added
there in the same change that introduces it.** A registry that is wrong is worse
than none, because §5 tells you to grep it before adding an event: it once
listed three names the backend never emits — the merchant panel was subscribed
to one of them, receiving nothing — while omitting about twenty that are.

Two dead-delivery traps found here, both silent:

- `emitMerchantUpdate('*', …)` reaches **nobody** — it looks the literal `'*'`
  up as a merchant id and returns, no error and no log. Use `broadcastToMerchants`.
- The panel SSE client registers listeners from a hardcoded name list, so a
  subscriber for an unlisted event never fires and never errors.

---

## 13. Branding

The `Branding` row is the single source. `sendBranding()` in `socketHandlers.js`
is the **sole constructor** of the branding socket payload and must never emit a
hardcoded filename or colour. Saving branding re-emits the full document so
every panel updates live.

Each panel, on the branding event: store to `localStorage.app_branding`, apply
the CSS variables, set `document.title` from its own panel-name field.

Normalise both sides when building a logo URL — strip the trailing slash from
the CDN base and the leading slash from the path — or you get a double slash.

Every branding field must have a real consumer (§3). The field → consumer table
is `docs/reference/BRANDING.md`.

---

## 14. Dead artifact policy

**No committed artifact may describe a pending fix that is not applied.**

1. Patch files are applied and deleted before merge; a pending patch lives in a
   branch, not the repo root.
2. Fix scripts that apply code changes are applied and deleted. One-off scripts
   are not repository assets.
3. A migration script is deleted once applied everywhere, or carries
   `// STATUS: PENDING`. There is no in-between.
4. A TODO citing a specific fix is resolved in the change that introduces the
   fix. Permanent TODOs are not allowed in production code.

---

## 15. Monorepo structure and split readiness

Three frontends and one backend. All shared configuration originates from the
backend API or socket — never from source files copied between panels.

- No panel imports a TypeScript file from another panel's `src/`.
- No panel imports from `backend/`.
- Shared types, if ever needed, live in their own package — not in a panel's `src/`.
- Each panel owns its `package.json`, build config, route constants where it has
  them, auth storage key and version.
- **No frontend package in the root `package.json`.** The root is what the
  backend image installs; a React stack there ships to the API server and
  inherits every advisory filed against it.

---

## 16. Every source file cites this file

Every source file carries, within its first 10 lines:

```
// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
```

The requirement applies to a pre-existing file on its first edit. An AI that
opens a file without the header adds it before making other changes.

This exists because sessions frequently receive a single file as context without
the surrounding codebase. The header is the safety net that prevents drift when
this file is not in the prompt.

---

## 17. Runtime currency, reproducibility, and durable artifacts

1. **Runtime currency.** Production runs supported LTS runtimes and supported
   major versions of security-load-bearing dependencies. An EOL runtime or
   framework in production is a blocker, not a backlog item. CI pins and proves
   the same versions production runs.
2. **Reproducible deploys.** Production installs from the committed lockfile
   (`npm ci`). A pipeline that resolves semver ranges at build time is invalid —
   production must run exactly what CI tested.
3. **Audit cadence.** The architecture comparison is re-run quarterly, or on any
   major-version EOL affecting the stack.
4. **Research artifacts are committed.** Any research, plan or numbered queue
   that gates implementation work is committed in the same session that produces
   it. Conversation context and session containers are ephemeral; the repository
   is the only durable medium. **This has now been broken twice** — once losing a
   prior session's implementation list, once losing a finished feature's code
   that was never committed before the container was reclaimed. The plan lives in
   `docs/PROJECT_STATUS.md`; keep it current in the same change that moves it.

---

## 18. Adding a cycle type, board or game

**A new board inherits the money system. It does not re-implement any part of
it, and no instruction to that effect is needed on the request.**

### 18.1 Inherited automatically — never given a per-type case

Bet funding split · reserve funding · winnings fee · payout multiplier ·
settlement, payout, idempotency and crash resume · the wallet ledger · realtime
snapshots, rooms and live pools · bet rate limiting · cache and rate-limit
counters · cron, retention and reconciliation.

**The rule that follows:** if adding a type requires editing one of those, you
have found a type-specific branch that should not exist. **Fix the branch; do
not add a case to it.** Adding the case is how a ternary came to announce every
unknown board's winner under the wrong name.

### 18.2 Declared per type — the complete list

1. One `META` entry in `domains/markets/cycleTypes.js`.
2. `DEFAULT_CYCLE_PHASES.<phasesKey>` — one declaration, read by the schema
   default and both consumers.
2a. `maxMergeBeforeEndSec` on the type's `META` entry — the longest the earliest
   phase may be for THIS board. The ordering invariant below compares phases
   only with each other; this is the only thing that knows the block's length.
   Omit it and the admin config route refuses the board's phases by name rather
   than accepting a merge that fires before the cycle starts.
3. `SystemConfig.betLimits.<limitsKey>` — declare them even when they equal
   another board's, so retuning one cannot silently retune the other.
4. The phantom-access enum, so an agent can be scoped without being granted all.
5. Frontend: the cycle-type enum, chip values and phase map, each a §5 mirror
   needing its citing comment.
6. `cycleTypes.test.js` — covered by the existing per-type loops.
7. A lifecycle test **if the new board's phases are a different order of
   magnitude**. Everything else runs at 30-minute timings where the 1-second
   status tick has minutes of slack; that proves the settlement machinery and
   proves nothing about a board whose phases are seconds apart.

### 18.3 Invariants

- Phase ordering: `merge > equalizer > close > celebrate >= 0`, and
  `merge < duration`. A set failing this is discarded at read time and the board
  silently runs on defaults.
- **Phases must fit the block.** The ordering invariant compares phases only
  with each other, never with the duration — a merge offset larger than the
  block fires before the cycle starts and nothing objects.
- The celebration lock and next-cycle timer derive from the type's own celebrate
  offset. A 10-second lock on a 60-second block eats a sixth of the next cycle.
- Status ticks are 1s, so a close→declare window under ~2s can be missed. The
  phase logic tolerates it by letting a still-OPEN cycle complete directly. Do
  not "fix" that tolerance.
- Unknown types fail loudly. Callers on a broadcast path skip the row rather
  than defaulting — one unrecognised cycle must not take a screen down.

### 18.4 Operational gate

Cycle frequency multiplies settlement runs, rows and realtime traffic linearly.
Re-run the load test before enabling a new high-frequency board.

---

## 19. What is kept: the financial core

The financial core in PostgreSQL is good and stays exactly as it is:

- Integer paise in `BIGINT` — never floats, never a decimal string in arithmetic.
- Row-level wallet locking (`SELECT … FOR UPDATE`) around every balance mutation.
- An append-only, double-entry ledger.
- Unique `tx_id` idempotency gates.
- `*_transitions` audit tables.
- `CHECK` constraints that make an impossible row impossible.

If a change would weaken any of those six, it is wrong regardless of what else
it achieves.

---

## 20. Traps — already found and paid for. Do not rediscover them.

1. **`computeWinningsPayout()` has no `payout` key.** It returns
   `{gross, fee, net, …}`. Writing `p?.payout ?? 0` silently pays **zero** while
   still charging the fee. Read `net`.
2. **Take the owner from the row, not the argument.** `settleBetOnPostgres()`
   read `String(bet.userId)` unguarded in two places. Callers enumerating from
   PostgreSQL pass `bet: null`, so it threw on every call.
3. **Something must actually advance the cycle.** Nothing in production advanced
   the PostgreSQL cycle `status` or `winner` — `ensureCycle` created the row at
   `OPEN` and it stayed there, so the engine looked healthy and silently never
   settled. Whatever declares a result **must write the winner BEFORE the
   status**, and a cycle with no winner **must not be offered for settlement**.
4. **Do not store real pool totals on the `cycles` row** — it deadlocks (40P01).
   A bet holds `FOR SHARE` on that row, so a bet that also `UPDATE`s it blocks
   against another bet doing the same. Derive real pools from `bets`; store only
   the phantom figures.
5. **`BIGINT` comes back from node-postgres as a STRING.** Uncast, `'900' >= 1000`
   is `true` and every balance comparison is wrong. Cast at the boundary, once,
   where the row is read.
6. **Reconstruct counters from rows; never accumulate them in memory.** An
   accumulator counts passes, not rows, and a crash mid-pass loses the count
   permanently while the money stays correct.
7. **Classify every balance read as display or decision.** See §9.
8. **`createWithdrawalOrder` and `selectBestMerchant` decide where a player's
   money goes and had zero tests.** They stay covered.
9. **CI log noise buries the failure.** PostgreSQL logs every refused `ERROR`
   with its full statement, and the concurrency suites provoke those on purpose.
   Set `log_min_error_statement=panic` and `log_min_messages=fatal` at runtime
   before the suites run. A service container has no `command:` key — use
   `ALTER SYSTEM` + `pg_reload_conf()` in a step.
10. **A mutation run leaves its rows behind.** `mutation-check.mjs` reverts the
    source file; it does not revert the database. A mutant that disables a guard
    creates exactly the rows that guard exists to prevent, and they stay there.
    A ₹7,770 cash-rail order — an amount no ATM dispenses — sat in `order_states`
    because the mutant disabling that gate had run once.

    The consequence is a rule: **never assert a global invariant over a shared
    table.** A test that walks everything a query returns and asserts each row is
    well-formed is asserting something about every other process that has ever
    touched that database, including the mutation harness deliberately creating
    malformed data. Take a baseline, create your own rows, assert the delta.

    **CONFIG is the shared table where "create your own rows" is not available.**
    `config_documents` is ONE row per scope and it holds the platform's live
    rules, so a suite that writes one is not leaving a stale fixture behind —
    it is leaving the platform running under different rules for every suite
    after it, in the same process. A route test that raised
    `maxConsecutiveRejections` to 4 and stopped there made the rejection-cap
    suite assert a suspension that correctly did not happen, and
    `playerOrderLockMinutes` at 61 made the cool-off suite measure a lock longer
    than the one it had just written: **fourteen failures, in five files, none
    of which the change had touched.** Worse, the values CLIMBED each run, so
    the same suite passed locally and failed on the next run of itself.

    A test that writes config takes a baseline in `beforeAll` and puts it back
    in `afterAll`, outside any assertion — a restore that only runs when the
    suite passed is the one that matters least. And a test asserting a config
    round trip must compare against **what was stored a moment ago**, never
    against the schema default: the row survives between runs, so a field left
    at the value you were about to write reads back correct against a write
    that never happened.
11. **A gate that reads printed prose will eventually read it wrong.** The
    mutation harness decided KILLED vs SURVIVED by regexing vitest's summary line
    out of stdout. That line is prose: its wording depends on the reporter, ANSI
    colour codes sit between the words the pattern needs adjacent, and which
    stream it lands on depends on whether the runner looks like a terminal. M49
    measured 22 tests on every local run and came back NOT MEASURED in CI, on a
    check green for weeks.

    A machine-readable result exists (`--reporter=json --outputFile`); read that.
    And a non-zero exit is not by itself evidence a mutation was killed — a
    mutant that makes a module unparseable also exits non-zero.
12. **The mutation harness OWNS every file it names while it runs.** It reads a
    source file, writes a mutant over it, runs a suite, and writes back the copy
    it took at the start. An edit made in between is **silently reverted** — no
    conflict, no error. It happened to a one-line fix that had been made,
    verified and moved on from; it was gone twenty minutes later.

    **Never edit a file while a mutation run is in flight.** After any run,
    re-check the edits you made near it.
13. **A mutation anchor that matches twice mutates the WRONG PLACE.**
    `String.replace(string, …)` changes the first occurrence only, so
    `AND consumed_at IS NULL` — three times in one repository — mutated the login
    TOKEN while the entry described the login CODE. It reported KILLED, and the
    guard it claimed to cover had no test at all. The harness now refuses an
    ambiguous anchor.
14. **`CREATE OR REPLACE` twice in one schema file is ONE definition, the last.**
    `bb_forbid_order_mode_change()` was written three times, each restating the
    earlier branches, so every version read correctly at its own position.
    Editing the first two changed nothing. `check:coherence` now fails on a
    schema object defined more than once.
15. **`fiat_amount_paise` is in the ORDER's currency. The ledger is not.**
    On a USDT order it holds USDT — 500, for 50,000 tokens. Posting it as rupees
    still SUMS TO ZERO, because the difference falls into the residual: every
    USDT deposit credited PLATFORM_REVENUE ₹49,500 the platform never earned. The
    ledger posts the INR-equivalent (`token_amount_paise` at the peg); the figure
    the player actually sent stays in `metadata.fiatAmount` beside `rateUsed`.
    Anything that RENDERS the amount goes through `formatOrderFiat(order)` —
    "₹500" for a payment of 500 USDT is the same lie in the line a human reads.

    **The same trap has a second mouth: any AGGREGATE over that column.** The
    merchant commission engine summed `fiat_amount_paise` across currencies to
    get matched volume, so a 50,000-token USDT deposit counted as ₹500 of work
    instead of ₹50,000 — a hundredfold understatement in a figure a percentage is
    paid on. Aggregate `token_amount_paise`.
16. **A merchant-scoped read is a permission. Do not widen it to fetch more.**
    The CDM receipt handler read `getMerchantOrder(id, req.merchantId)` — which
    404s on somebody else's order — and a later edit swapped it for
    `getOrderRecord(id)` to get at a field. Nothing else changed, no check went
    red, and **any merchant could attach their slip to any payout**. When a
    handler needs more of a row, widen the SCOPED reader — never reach past it.
17. **`transition()` does not write `completed_at`.** The one order lifecycle
    writer sets `state`, `updated_at` and `merchant_id` and nothing else. Five
    separate routes set `completedAt` themselves, in a `setOrderFields` call
    AFTER the transition commits — the §21 shape, a second write that can be
    absent on a genuinely completed order. **Checked 2026-09-10: all four
    `completeOrder` callers do set it, and `mirrorSettlementState` sets it by
    its own `CASE`, so there is no live gap today.** The point is that keeping
    it true is five separate authors' job, and the fifth completion path added
    without it fails nothing. So `completed_at IS NOT NULL` is not the same
    question as "this order completed", and a money gate must never rest on it. Where you need "has this money actually moved", ask the ledger:
    `merchant_wallet_entries` is written by `applyMerchantMovement` inside the
    same transaction as the balance change, so it cannot disagree with the
    balance. Net DEBIT against CREDIT rather than testing existence — a movement
    REVERSED by `reverseMovement` puts the tokens back and restores the
    obligation together, and a boolean sees only the first row.
18. **A guard you can pass twice is not a guard, however good its number is.**
    F-018's first fix made the assignment check read a MORE ACCURATE balance —
    available minus the orders already in flight — and left it a read. Two buy
    orders arriving in the same instant both passed it and were both assigned to
    a merchant who could fund one; measured, not theorised. **A number read in
    one statement and acted on in another is a snapshot no matter how good the
    number is.** The only fix is a write the database serialises: the guard goes
    in the `UPDATE`'s own `WHERE` under a row lock, and the caller learns the
    answer from whether the write landed. This is §0.5 question 2, and it was
    asked of the code and not of the fix.
19. **A silent no-op after a committed ledger write strands money.**
    `creditMerchantTokens` returns `{merchant: null}` for an id with no merchant
    row — it does not throw. The commission engine wrote its ledger event first,
    so the pool was debited, the platform recorded the merchant as owed, the
    wallet credit did nothing, and the high-water mark (derived from that very
    event) advanced past the volume: owed, undelivered, never retried, and
    reported as issued. `order_states.merchant_id` has no foreign key to
    `merchants`, so this was reachable. **Check that the recipient can receive
    before writing the record that says they did.**

    **The same shape, found a second time, on the admin top-up (2026-09-23).**
    `POST /admin/merchants/:id/fund` read the recipient from the CREDIT's return
    value — after the treasury transfer had already committed. Measured on a
    running server: funding a merchant id that does not exist answers **404
    "Merchant not found"** while the tokens leave `TOKEN_SUPPLY` and land in
    `MERCHANT_FLOAT`, credited to nobody. `MERCHANT_FLOAT` then claims tokens no
    merchant wallet holds, so §2's conservation invariant — platform holding +
    every merchant wallet + every player wallet = the total — is broken by a
    typo in a URL, silently, with the admin told nothing moved. **A 404 is not a
    rollback.** Read the recipient FIRST.

---

## 21. A write that follows a commit must not be able to fail

The order lifecycle moves the STATE first and writes the accompanying fields
SECOND, deliberately: an order must never be found in a new state without the
facts that justify it. The price is that anything wrong in the second write
happens **after the first has committed** — the order moves, the handler's
`catch` returns a 500, and everything it meant to do next, including moving
money, never runs.

`setOrderFields` throws on a field name it does not know. That has shipped
**three times, in three files**, with every check green each time:

- `resolvedAt`/`resolvedBy` — every admin dispute resolution failed.
- `updatedAt` in the merchant reject handler — 500 on every call, and no screen
  called it, so nothing noticed.
- `resolutionNotes`+`updatedAt` — the release button marked a **disputed deposit
  COMPLETED and never credited the player**, then told the admin it had failed.
  The order left the DISPUTED queue, so nothing remained to show it had gone wrong.

`npm run check:settable` refuses the whole class at build time. It cannot see
whether the values are right or whether the money moved — those need a test
through the real database.

**The same shape, inside one request, with no lifecycle involved: a loop of
single-field writes.** The admin System Settings page sends about thirty values
in one PUT, and the route applied them by calling `setConfigField` once per
value. Each call is its own transaction, and the spec refuses an out-of-range
value by THROWING — so an operator typing 11 into a field capped at 10
committed every value before it, abandoned every value after it, and was shown
"Failed to update settings". They reload into a form half in the old state and
half in the new, with nothing on the screen saying which half. It also wrote
thirty audit rows for one decision, so the version an operator would roll back
to is one of thirty midpoints the platform never intentionally ran in.

`setConfigFields` takes the whole save and hands it to `applyConfig`, which
**validates the entire patch before it opens a transaction**. Where a caller
holds several values that belong to one decision, write them in one call; a
loop that commits per field is this section's shape however small each write is.

**And the refusal is the CALLER's, so it carries `status: 400` at the throw.**
Without it `respondError` routes a spec violation to `serverError`, which logs
in full and answers with nothing by design — so the message naming the field and
its bound, the only thing that tells the operator what to type instead, is
swallowed and they are told the platform broke.

The same shape exists outside the lifecycle: a `NOT NULL` column refuses an
explicit `null`, and `updateUser` passes values straight through. That is how
`unblock?resetWarnings=true` 500'd *after* the unblock committed, leaving
`is_blocked` false with `status` still `BLOCKED`. **Before writing `null`, check
the column.**

---

## 22. Code nothing imports is not code

`check:dead-code` scans exported names. A default export is named at the import
site, so a module whose only export is a `default` was exempt from every check.
`admin.service.js` was exactly that: 380 lines duplicating live routes, holding
two writes of `null` into a `NOT NULL` column — and holding a locked-balance
guard the LIVE delete route did not have, while a test asserted that guard
**against the dead file** and passed. The live route would soft-delete a player
with a withdrawal still in escrow.

1. **A module nothing imports is dead**, whatever it exports. Deliberate
   exceptions go in `ORPHAN_ALLOW` **with a stated reason** — adding a line there
   is a decision, not a silencer.
2. **A test that reads a file's source is not a consumer of it.** Asserting a
   money guard against unreachable code is worse than no assertion, because it
   reports the guard as present. When a test names a path, check that something
   *imports* that path.

---

## 23. A type that lies is worse than no type

`admin-panel/src/types.ts` declared `User._id`. The server has never sent one —
the repository and the KYC queue both emit `userId`. TypeScript could not catch
it, because **the interface was the thing that was wrong**: every `u._id`
typechecked and was `undefined` at runtime.

- Every user-scoped call built `/api/admin/users/undefined/…`, 404'd into a
  caught error and an empty state.
- On the KYC screen, `find(u => u._id === selectedId)` matched the **first** row
  every time — a reviewer clicking the fifth player read the first player's
  record — and every row rendered highlighted. Approving grants withdrawal access.

The fix that found every call site was renaming the field in the interface and
letting `tsc` list them. A search would have missed one, and a missed one is a
silent 404. **When a panel type names an id, check it against what the mapper
actually emits.**

Two relatives, same suspicion:

- `req.user?.id` in three rate limiters. `authenticate` sets `req.user` from the
  repository, which returns `userId`. Every limiter silently fell through to its
  IP fallback — including the withdrawal cap and the 2FA brute-force guard, whose
  comment described the account takeover it was no longer preventing.
- `.save()` on a repository row is a TypeError the route's `catch` turns into a
  500, writing nothing. `check:settable` refuses `.save`, `.populate`,
  `.toObject` and `.lean` outside a `typeof … === 'function'` guard.

---

## 24. Privacy points BOTH ways

**A merchant may see the bank account a withdrawal pays and the name on it.
Nothing else identifies the player** — not the phone number in whole or in part,
not the UPI ID (which resolves to both), not a CDM receipt after submission.
**A player sees where to pay and nothing about who they are paying** — a payment
link, an opaque `Merchant #<ref>`, a deadline.

`sanitizeMerchantOrder` was a denylist: it deleted the player's payout
destinations only on the DEPOSIT branch, so on **every withdrawal** the merchant
received the player's UPI ID, and the panel had a render waiting for it while its
order search matched on the player's phone number. The other half had nothing at
all: every player-facing response carried `merchantSnapshot` whole — the
merchant's UPI handle, QR, bank account number, IFSC, account-holder name and
USDT address — on creation, fetch, dispute, assignment push and every status
poll. A player could copy and keep a merchant's account number from one deposit.

1. **Each projection is an allowlist in one file** —
   `domains/merchant/merchantOrderView.js` and `domains/payment/playerOrderView.js`.
   A denylist admits the next column added to `order_states` by default and the
   mistake is always "too much"; an allowlist fails closed and its symptom is a
   blank field somebody notices.
2. **Assert the key set, not the field.** A test checking one field is absent is
   the denylist written as a test. The suites assert the response's keys are a
   **subset** of the allowlist, so a new leak fails without anybody adding a line.
3. **A field the panel's type names is a field somebody will render.** The gates
   read the forbidden list from the server module and fail if a panel type
   declares any of them.
4. **A channel is a responder wherever it is written.** A gate reading one route
   file was green while `paymentProcessing.service.js` spread the WHOLE order onto
   the merchant's stream at assignment and `sse.routes.js` pushed `page.orders`
   RAW to every merchant on connect. Both gates now read the whole backend.
5. **A spread defeats a key scan.** `{ ...order, server_ts: … }` names one
   permitted key and carries thirty forbidden ones. A spread is permitted only
   from a producer whose returned object the gate has itself verified, and the
   chain to it is stated in the gate rather than assumed.
6. **Blank comments before scanning.** An apostrophe in `// the player's shape`
   is an opening quote to a bracket counter: it swallowed the rest of a return
   literal, and the producer check reported no `order` key in a function that
   plainly returns one — a check measuring zero things, reading exactly like a
   pass. A producer that yields nothing to check is now a failure, not a silence.

Note honestly what this does not do: a `upi://pay` intent carries the payee, so
the payer's own banking app will show it. The platform stops publishing the
merchant's identity; it cannot hide a payee from a payer.

`npm run check:merchant-privacy` · `npm run check:player-privacy`

---

## 25. USDT is one token on several chains

A player buys with USDT from a **USDT merchant**, by sending tokens to that
merchant's wallet and submitting the transaction id. There is no payment
processor and no webhook. The counterparty is a person, and the rail is the
ordinary order lifecycle with a different currency on it.

**A USDT buy is denominated in PLATFORM TOKENS, not rupees**, at exactly
**50,000, 100,000 or 500,000 tokens**. What the player *sends* is DERIVED from
the admin's rate at creation. There is no second denomination list in USDT — the
rate is admin-editable, so a stored USDT amount would be a second owner that
drifts the moment it changes.

**The quote is the contract.** It is computed and written WITH the order, and
the assignment path — minutes later — is forbidden from remaking it: `rate_used`
and `fiat_amount_paise` are frozen by trigger. Assignment used to re-read the
rate, so an admin edit in between silently re-priced a purchase the player had
already agreed to. A purchase that cannot be priced is **refused by name**
(`USDT_RATE_UNSET`); there is no fallback, because 0 gives Infinity USDT and 1
would sell 50,000 tokens for 50,000 USDT. The rate is bounded at both ends —
a misplaced decimal could otherwise price the whole rail.

**The chains are not interchangeable.** USDT sent to a Tron address from a BNB
Smart Chain wallet is gone — no support desk recovers it, and it is the only
unrecoverable mistake this platform can make. Everything follows from that:

1. **A merchant holds an address PER CHAIN** (`usdt_address_trc20`,
   `usdt_address_bep20`), not one "USDT address". A single column made Tron the
   only usable chain and made *which chain is this?* unanswerable.
2. **The player picks the network first**, before an order exists, because it
   decides which merchants can serve it.
3. **The address and its network always travel together** — in the snapshot, in
   `payTo`, on the screen. An address on its own is the mistake.
4. **Only the chain the order named.** The merchant's other address is not part
   of that order and is not sent.
5. **The chain is frozen on the row** by trigger, because the snapshot carries
   the address for that chain alone.
6. **A merchant with no address on the order's chain is not a candidate.** That
   guard is in the assignment query, not a row constraint: a row cannot see which
   chain an order asked for, and a "must hold an address" CHECK would refuse the
   middle step of ordinary onboarding.

**₹10,000 and ₹40,000 are the ATM's ceilings, not the platform's.** ₹10,000 is
the largest a cash machine dispenses in one go, so it bounds a CASH_ATM buy;
₹40,000 is the largest denomination it deals in at all, so it bounds one payout
LEG (a larger withdrawal is split, never refused). Neither applies on the UPI
rail, and neither applies to USDT. `MAX_CASH_BUY_PAISE` was once
`MAX_INR_BUY_PAISE` and was enforced on every INR buy on both rails — a
machine's limit applied where there is no machine.

A refusal on either rail **names that rail's own choices**: a player told only
"invalid amount" tries again and again.

---

## 26. Merchant commission is paid per variety of work

A merchant is paid on **matched buy→sell volume** — `min(deposits, withdrawals)`
— paid **once**, above a high-water mark, from the platform-funded pool. Never
from a user balance, never from a rate spread, never triggered by a deposit.

What varies is the RATE, per **variety**: `(currency, payment_mode,
denomination)`. A ₹500 run to a cash machine and a 500,000-token USDT transfer
are not the same job and one number could not say so. Within a variety, each
LEG has its own percentage and the engine ADDS them, because a matched rupee came
in through a deposit and went out through a withdrawal.

1. **Match within a variety, never across.** Otherwise a cash run pairs with a
   UPI payout and one rate pays for two different jobs.
2. **One high-water mark per (merchant, variety).** One mark per merchant lets a
   payment for cash work advance the mark on UPI work, and the volume underneath
   is never paid — money withheld silently, with a ledger that reads complete.
3. **An unpriced variety earns nothing and is REPORTED as unpriced.** No default
   and no nearest-match: a variety nobody priced is a decision nobody made, and a
   row priced 0/0 reads as priced and pays nothing, which is the shape most
   easily mistaken for a working rate. Absence is how a variety goes unpriced.
4. **The mark is read from the idempotency key**, not from metadata. The engine
   this replaced read `$metadata.cumulativeMatchedMinor`; there is no metadata
   column, so every mark came back undefined and defaulted to 0 — enabling it
   would have paid every merchant their whole history again, on every run. The
   key exists, is UNIQUE, and is what makes the payment idempotent, so the mark
   and the idempotency cannot disagree.
5. **The key separator is `~`, not `_`.** A merchant id can contain an
   underscore, so a pattern has to guess where the id ends.
6. **Never partial-issue.** Paying what the pool holds while recording the full
   high-water mark under-pays permanently. Skip until the pool is funded.
7. **Check the merchant exists before posting.** See trap 19.

---

## 27. One payment, one claim

A UTR is a bank's reference for one real transfer. A transaction hash is a
blockchain's reference for one real transfer. A CDM slip carries the machine's
reference for one real cash deposit. **They mean the same thing, so they share
one registry** — `utr_registry`, where a reference belongs to exactly one order,
for good.

Only the player's UTR was ever claimed. Two other paths wrote a reference into a
column and claimed nothing: `cdm_transaction_id` (a merchant's proof they paid a
withdrawal in cash — the same slip could be presented twice) and `usdt_tx_hash`
on a merchant's token purchase (one payment funding two purchases of the
platform's own inventory). Both were green under every check, because no check
looked at the *shape* of the problem — a column holding somebody else's
reference — only at handlers.

`claimPaymentReference()` is the one owner, it **throws** rather than returning a
flag a caller can ignore, and `check:payment-references` fails the build on a
handler taking a reference from `req.body` without claiming it — matched **per
field**, because a first draft only asked whether the file contained a claim
anywhere, and a file with two claims stayed green after one was deleted.

- **A hex hash in two cases is ONE transaction.** References are uppercased
  before they are claimed and the hash patterns are case-insensitive, so `0xAB…`
  and `0xab…` collide on the primary key as they must.
- **The refusal speaks the submitter's vocabulary.** "This UTR was already used"
  shown to somebody holding a Tron hash reads as another system's error, and they
  submit it again.

---

## 28. Shipped means reachable, and gates measure the code

### Shipped means reachable

A backend that works and a panel that calls it are two different facts. Every
check passed while five admin buttons hit paths the server has never served: the
request 404'd, the component caught it, and the screen rendered its empty state —
indistinguishable from "no data". The dispute queue was permanently empty,
release and refund did nothing, and every merchant's order history read "No
orders found" however busy they were.

A route test proves a handler works. It can never prove anything calls it.

1. **A panel call that resolves to no route is a live defect.**
   `npm run check:ui-coverage` fails the build on one.
2. **A backend feature with no UI is not shipped.** It is built, tested, merged
   and unreachable. `check:ui-coverage --unused` lists these; the list is triage,
   not failure, because webhooks and SSE belong on it. Anything else on it is
   either work someone forgot to finish or code to delete.
3. **Do not describe a screen as working without following its calls to a
   route.** Reading the handler is not enough; reading the component is not
   enough. The two must be checked against each other.

### A gate whose failure mode is "the author forgot to update me" reports the author

- `check:ui-coverage` mapped router file → mount prefix in a hand-written table.
  A new router mounted and served was reported as eight DEAD BUTTONS. The
  prefixes are derived from `server.js`'s own imports now — which immediately
  found five routes the table had been missing in the other direction.
- `check:settable` compared every `set: { … }` against the ORDER lifecycle's
  `SETTABLE`, assuming one writer. A second lifecycle briefly existed and the
  gate reported its perfectly valid `set` as a field the order writer would
  refuse: a false failure, which is how a gate loses trust and gets silenced. A
  `set` is now checked against **the writer it is handed to**.

- `check:orphans` scans `backend/**` with Node's globals, and
  `backend/tests/browser/` holds functions that are serialised and run inside
  Chromium. It reported `document` and `localStorage` as references that
  "throw a ReferenceError the moment [they] run" — they cannot; they never run
  in that process. A false failure is how a gate loses its authority and gets
  switched off, so the gate learned the rule (a function argument to
  `page.evaluate` and friends is browser code) rather than the file being
  exempted. It still catches an orphan on either side of that line; both were
  planted on purpose to check.

**Derive what a gate checks from the thing it is checking.**

### No path that only works on one machine

`verify-ui-coverage.mjs` shipped with an absolute path to the author's own
checkout. It passed locally and could not run anywhere else; CI died at the first
read. Derive a root from `import.meta.url`. Running a script from the repo root
is not evidence it runs — run it from somewhere else.

---

## 29. Do not claim readiness, and do not call it perfect

Until `check:no-mongo` reports zero on every count **and** the suites run green
against PostgreSQL alone, this platform is not ready to take money. No individual
green check says otherwise.

**"Clean", "complete", "perfect", "nothing missing" and "production-ready" are
claims about evidence, not impressions.** Every one requires naming the gate that
was run and the number it printed. A green CI run is not that claim: CI was green
on every commit while all five dead buttons were live, because nothing was
looking for them.

When asked whether something is finished, answer with what was checked and what
was **not**. An honest "I verified the handlers; I never checked that a button
calls them" is worth more than a confident summary — that exact unasked question
was hiding five defects, a duplicated config payload, and 71 endpoints no screen
reaches.

**Absence of a failing check is not evidence of correctness when no check covers
the thing being claimed.**

---

## 30. Working rules

- **Read the whole path before changing part of it** — endpoint, service, store
  access and fixtures together. A route rewritten without its service is a bug
  with a green test.
- **Do not accommodate; remove.**
- **Derive, do not duplicate.** One owner per value (§2).
- **Money is integer paise, everywhere, in `BIGINT`.**

---

## 31. Every change reports what it covered. No exceptions.

**The problem this exists to stop.** Six sessions in a row reported this
platform as ready on the strength of the code being correct. It was correct.
It was also, at various times: crediting nobody because a handler threw after
the commit; showing an empty dispute queue because five buttons called routes
the server never served; refusing every deposit because a check outlived the
thing it checked; charging a player for the refusal that taught them the rule;
and storing an operator's announcement where no player could read it. Every one
passed CI. Every one was found by RUNNING it, usually after the owner pushed
back.

The common cause is not carelessness. It is that "I changed the handler" and
"the feature works" are different claims, and only the first one is ever
checked. So:

**A change is not reported as done until its author states, as a table, which
fronts it touched and what was verified on each.** Copy this table into the
commit message or the reply. Every row gets one of:

- **done** — verified, and the table says HOW (the command, the number, the
  screen)
- **n/a** — with a reason. "Not applicable" without a reason is not an answer.
- **NOT DONE** — the honest one. This is allowed. Hiding it is not.

| Front | Question it answers |
|---|---|
| Data layer | Does the column/table exist, and does one owner write it (§2)? |
| Backend route | Does the handler work, through a real database (§1)? |
| Route ADMISSION | If a second route reaches the same state, do they admit the SAME things? |
| Panel UI | Is there a screen, and does it render the new field? |
| The button | Does a control actually CALL it — `check:ui-coverage`, and the `--unused` list read, not counted (§28)? |
| Cross-panel | What do the OTHER two panels show after this? An admin action a merchant or player never sees is half a feature. |
| Failure path | What does the user see when it refuses? Is the message actionable (§25)? |
| Money | Both sides asserted — debited AND credited — against a real database (§9, §19)? |
| Tests | Which tier, how many, and does a mutation of the fix fail them? |
| Gates | Which ones ran, and what did they PRINT (§29)? |

**Rows nobody fills in are where the defects were.** Of everything found in the
2026-09 review, not one was a wrong calculation. They were: a route no button
called, a button calling no route, a panel rendering a field the server never
sent, a server sending a field no panel read, two routes admitting different
things, and a message that blamed the player. Six of the ten rows above.

### 31.1 Keep the table current

This section and §32 are UPDATED BY THE CHANGE THAT INVALIDATES THEM, in the
same commit — the same rule §12 applies to realtime events and §0.4 to new
authorities. A new feature adds its row; a shape found for the first time is
added to §32 with the question that would have caught it.

A rules file that lags the code is worse than none, because §0 tells the next
session to trust it.

---

## 32. The shapes that keep shipping here

Not a list of bugs. A list of SHAPES, each with the question that finds it.
Ask these of the change in front of you — §0.5's four are the general form and
these are the specific ones this codebase has actually produced.

| # | Shape | The question |
|---|---|---|
| S1 | A button calls a route that does not exist | Does this path resolve, with this METHOD? |
| S2 | A route no button calls | Read `--unused`. Is this unfinished, or is it a hole nothing is hiding but the UI? |
| S3 | Two routes reach one state with different admission | What does the OTHER one refuse that this one allows? |
| S4 | A consumer outliving its producer | Does anything still WRITE the thing this reads? |
| S5 | A producer outliving its consumer | Does anything still READ the thing this writes? |
| S6 | A guard you can pass twice | Is this a read acted on in another statement, or a write the database serialises? |
| S7 | A write after a commit that can fail | If the second write throws, what does the row say? |
| S8 | A gate measuring a fraction | Make it fail on purpose. Does it? |
| S9 | A type that names a field the server never sends | Check the mapper, not the interface. |
| S10 | A type that omits a field the server does send | Check the emitter, not the interface. |
| S11 | The same value assembled twice | Which one is the owner (§2)? The other is a bug with a delay. |
| S12 | A default that disagrees with the spec | Does the schema default equal every fallback that cites it? |
| S13 | A refusal that costs the user their next attempt | Does this limiter bound EFFECTS or ATTEMPTS? |
| S14 | A message blaming the user for the platform's state | Can the person reading this act on it? |
| S15 | An aggregate across currencies | Is this column in the ORDER's currency (trap 15)? |
| S16 | A fixture in a state production cannot produce | Could the platform actually create this row? |
| S17 | An admin decision no other panel reflects | What does the merchant/player see after this? |
| S18 | A silent no-op after a committed write | Can the recipient actually receive, before the record says they did? |
| S19 | A test asserting a precondition it never established | Did THIS run create the state this asserts, or is it reading whatever the database happened to hold? |
| S20 | A cache or deduplicator that shares a SINGLE-USE resource | Can two callers both consume what this hands back, or does the first one spend it? |
| S21 | A screen that renders only the shell when its own content failed | Measure the ROUTED region, not the page. What is inside `<main>`? |
| S22 | A control with NO handler — it calls nothing at all | Press it. Did anything a person can see change? `check:ui-coverage` cannot help: it finds a call resolving to no route, never a control that calls nothing. |
| S23 | A component declared INSIDE another component | Does this identity survive the parent's next render? If not, React remounts it and the caret goes with it. |
| S24 | A label that names a control it is not attached to | Can a screen reader — or a test — address this field by the name printed next to it? |
| S25 | A panel keeping its own list of a document's fields | Which list does the SERVER agree with? Every other copy will drift, in both directions. |
| S26 | A button calling the RIGHT route with a request that route refuses | `check:ui-coverage` proves the path and the method resolve. Does the call carry what the handler REQUIRES — a header, a required field? Press it and read the toast. |
| S27 | A limiter counting a REJECTED SESSION as a failed credential | Does the path it guards check a credential at all? A 401 from an expired token is not a guess. |
| S28 | A limiter on a router PREFIX rather than on the route | What ELSE does that prefix serve? A poll and a page load are not credential attempts. |
| S29 | An input that normalises to something plausible but WRONG | Type the thing people actually type. Does what lands equal what they meant? |
| S30 | A query that can match two POPULATIONS | Can this `WHERE` match a row of another kind? Which one does the planner hand back? |
| S31 | A migration guard that is idempotent but not CONVERGENT | Run it twice, then change the definition and run it again. Does the database end up saying what the file says? |
| S32 | The same security check in one of the two paths that need it | Which OTHER path reaches this without the middleware? |
| S33 | A harness that measures a server it did not start | Did THIS run bring up the thing it is asking? Something already on the port answers the readiness check, and the suite then seeds one database while asserting against another. |
| S34 | A tidy early return placed above the question it must not pre-empt | Does this guard clause change the ORDER of two questions? Refusing before the platform's own state is read is how a gate blames a person for an operator's unfinished setup. |

**S22 through S25 all came out of pressing controls rather than opening
screens, and each was invisible to every tier below a browser.**

**S28 is S27 one layer up, and it was live on every page load.** `authLimiter`
was moved off the session router because it counted an expired-token `GET /me`
as a failed login (S27). The SUBNET limiter beside it was left where it was — on
the `/api/v1/auth` prefix — and it is worse, because it counts every request,
success included: 4 × 8 = 32 per /24 per 30 minutes. Measured on a running
server: `GET /me` answered **429** from an address that had submitted no
credential at all, and most Indian mobile traffic sits behind carrier-grade NAT,
where a /24 is thousands of people. One person reloading a page would have
signed the rest of them out. **A limiter belongs on the route that submits the
credential, never on a prefix that also carries session and status paths** —
and the question that finds it is what ELSE that prefix serves.

**S30, S31 and S32 all came out of splitting one account into three**, and
each was invisible to every tier that was green at the time. §33.5 and §33.6
tell the whole story; the short forms are:

- **S30** — `linkTelegramToAccount` matched a user by mobile alone. Once a
  mobile could hold a player AND a staff account, a player's contact share
  linked the STAFF row and the bot's reset button offered an ADMIN's password to
  whoever held the phone. The fix is a predicate in the `WHERE`; the second
  refusal in the service is there because one place was not enough.
- **S31** — `DO $$ … EXCEPTION WHEN duplicate_object` does nothing when the
  constraint exists, which is wrong when its DEFINITION changed. The apply then
  stops at the failure, so statements BELOW it never run and the next boot meets
  a table missing a column. Drop and re-add anything whose definition can move.
- **S32** — the session cutoff was written into `authenticate` only.
  `GET /api/v1/auth/me` verifies its token inline and never calls that
  middleware, so a password reset changed the password and evicted nobody from
  the endpoint every page load uses to restore a session. One function, both
  callers.

**S29 was found by typing `+91 98765 43210` into a box with `+91` printed next
to it.** The handler was `digits(v, 10)`, which strips non-digits and truncates:
the result is `9198765432` — ten digits, starting with a 9, indistinguishable
from a real Indian mobile to every check on both sides. The account would be
created on a number that is not the player's, the Telegram contact share would
then match nothing FOREVER, and `users.mobile` is never mutable (§2), so support
could not fix it either. The player sits at the verification gate permanently
with no way to find out why.

Two things made it invisible. The value was PLAUSIBLE, so no validator objected
— `isValidMobile` passes it and so does the unique index. And the truncation
happened progressively, one keystroke at a time, so the `91` was already gone
before any normaliser could recognise it: the fix had to let the field hold
twelve digits and reduce at the end, not cap at ten.

**The question is not "is this input validated" but "does what lands equal what
they meant".** Type the thing people actually type — the country code that is
already printed beside the box, the leading zero, the spaces — and read the
value back.

**S27 locked users out of LOGGING OUT.** `authLimiter` — four FAILED attempts
per thirty minutes, keyed by IP, answering "Too many failed login attempts" — is
mounted on `/api/v1/auth`, which holds `/me`, `/logout` and `/health` and checks
NO CREDENTIAL. Measured: four unauthenticated `GET /me` calls, which is what a
panel does when a token expires, put all three paths at 429 for half an hour,
while `/api/admin/login` and `/api/merchant/auth/login` were untouched (their
own limiters, their own stores). So it stopped no brute force and instead
punished the one user who had done nothing wrong — S13 and S14 together, and
IP-keyed, so one person on shared wifi does it to everyone. The mount's own
comment had already made this argument and removed the CAPTCHA for it; the
limiter stayed. Fixed by not counting a rejected session check on a path that
verifies nothing — **the bound is unchanged**, and the test that matters asserts
a non-session failure still trips it at four.

**S26 is the gap between "a button calls a route" and "the route accepts the
call".** `POST /admin/merchants/:id/deduct` requires an `Idempotency-Key` and
answers 400 without one — only the caller can tell a redelivery from a second
deliberate deduction, so the server refuses to guess. The admin panel's
`deductWallet` never sent one. **"Deduct From Wallet" had therefore never once
worked**, and what the operator was shown as the reason was the protocol
message: "Idempotency-Key is required for this request. Send the SAME key when
retrying" — S14 on a money screen, on a failure they cannot act on. Every tier
was green: the route test sends the header, the gate checks that the path and
method resolve, and no one asked whether the CALL THE BUTTON MAKES is one the
route accepts. Assert the request, not just the URL.

- **S22** — the player's Profile had five rows, each ending in a `›` promising a
  screen, each a `<button>` with no `onClick` at all. Nothing fails, so nothing
  reports. Three named features this platform does not have; the other two named
  PAGES whose URLs an admin could already set and NOTHING read (§3) — the same
  hole from both ends, which is how it survived: each half looked like the other
  half's job.
- **S23** — `FakeWinnersManager` declared its field component inside itself, so
  it was a new component TYPE on every parent render. React unmounts and
  remounts it, and typing (which re-renders the parent) takes the caret with it.
  Typing "Rahul" left the field holding **"R"**. Eight fields, every one. A test
  that types ONE character passes, which is why it needs a real caret and more
  than one letter.
- **S24** — 124 labels sat next to the control they named with no `htmlFor` and
  no `id`. The text is on screen so it looks labelled; it is not ASSOCIATED. On
  System Settings that is thirty identical spin buttons to a screen reader, on
  the screen where §21 says an operator types the platform's business numbers.
  Untestable and unusable turn out to have one cause.
- **S25** — the admin Support Links screen kept its own list of ten fields;
  `SUPPORT_LINKS_SPEC` declares twelve different ones. Four it offered were never
  declared, six declared ones it never offered, and the player panel had a THIRD
  list naming seven. The PUT validates the patch as a whole, so the first
  undeclared key refused the entire save: **the screen had never once saved
  anything**, and the refusal named a Facebook field the admin had not touched.
  The fix is §2's own rule — the thing that DECLARES a setting is what makes it
  editable, and a panel can read that from the document the server sends rather
  than keeping a copy.

**S20 was live on two player screens and every tier was green.** The user
panel's `apiClient` deduplicated concurrent GETs by holding the `Response` and
handing the second caller `resp.clone().json()`. A `Response` may only be cloned
while its body is UNDISTURBED, and the first caller starts reading it on the
same tick the second wakes up — so they raced, and when the first won, the
second threw `Failed to execute 'clone' on 'Response': Response body is already
used`. On the wallet that landed in `loadMeta`'s catch and the balances, stake
ceiling and settlement rail were never set (a wallet of zeroes, no error shown);
on Refer & Earn it was rendered to the PLAYER as their error message. Share the
PARSED result, never a single-use object — and note that no route test can see
this, because no route test has two components in it.

**S19 is S16's mirror and cost a green suite.** The USDT scenario opened by
reading `usdtPricing` out of whatever database it ran against and asserting it
was positive. On a database somebody had priced, it passed for weeks. On a
fresh one it failed twice and reported the platform REFUSING BY NAME
(`USDT_RATE_UNSET`) — §25's deliberate no-fallback, working exactly as written —
as a defect. A scenario that needs a value SETS it, through the route a human
would use, and puts the old one back in a `finally`; that also turns a dead
ambient read into a real cross-panel assertion (the admin sets 90, the player
panel is told 90). Trap 10 already says this about `config_documents`; S19 is
the same rule stated from the reading side.

**S16 deserves its own note, because it is how several of the others hid.** A
test that stages an impossible row stops testing the handler and starts
testing the absence of a guard. Two fixtures staged a PAID deposit with no
payment reference — a row `mark-paid` cannot produce — and that is why nobody
noticed for months that one of the two confirm routes never checked for one.

---

## 33. Signing up is a FORM. Telegram verifies; it does not authenticate.

Owner decision, 2026-09-23. Signing up used to happen inside a Telegram bot —
/start, type your Aadhaar to the bot, share your contact — and signing in was a
six-digit code the same bot DMed. Every step depended on a third party that
suspends gambling bots, rate-limits at roughly **thirty messages a second per
bot**, and cannot message anybody who has not opened a chat with it first.

### 33.1 The order, which is the whole design

```
FORM      → the account EXISTS, with a password        (playerAuth.routes.js)
TELEGRAM  → contact share proves the number,
            channel join is the membership rule        (telegram.routes.js)
```

The account exists **before** Telegram is involved. So the contact share is
matched against a row that is already there (`linkTelegramToAccount`) rather
than creating one, and a contact that matches nothing is somebody who has not
filled the form yet — which is a sentence the bot can say.

- **The signup form** takes the Aadhaar number, the Aadhaar-linked mobile, a
  password, a confirmation, a captcha, and an invite code. The invite code is
  **pre-filled and non-editable** when the player arrived by a referral link,
  and the screen confirms whose it is: a code somebody retypes is a code that
  can be mistyped, and a mistyped code silently costs the referrer their
  earning.
- **The login form** takes the mobile, the password, a captcha, and a second
  factor where one is enrolled.
- **Nothing the bot can do grants access.** `telegramLogin.service.js`,
  `telegramOtp.service.js`, `telegram_login_tokens` and `telegram_login_codes`
  are deleted, not unmounted. That is the security half: a fleet of hundreds of
  tokens, any one of which could mint a session, is not a risk worth carrying
  for a convenience a password already provides.

### 33.2 The fleet, and why it is a fleet

One bot is a throughput ceiling, not a design. An operator runs as many sign-in
bots as they need — the owner's figure was 500 to 1,000 — added, replaced and
removed from the admin panel. Each account is assigned one **in rotation**:
"assign 1, assign 2, then 3rd, 4th, 5th and so on, and once it reaches all,
again start from 1" (owner). See §2 for the owner of that assignment.

Four things follow, and each was got wrong first:

1. **`live_slot` names `recovery` only.** Left naming `signin`, the partial
   unique index refuses the second live sign-in bot outright.
2. **The webhook is per-bot** (`/api/telegram/webhook/:botId`). Every bot has
   its own secret, and a shared path would check every delivery against the
   first bot's secret: 401 on all of them, every player on that bot stuck, and
   nothing anywhere saying why.
3. **Every reply is sent by the bot the update ARRIVED ON** (`sendAs`,
   `sendTemplate({ bot })`). Telegram refuses a message from a bot the player
   has not opened a chat with.
4. **`getLiveBot(role)` answers "give me A live bot"**, not "read the generated
   column" — which for a fleet is always NULL and would report a working fleet
   as "Telegram is not configured".

### 33.3 The gate blocks; it does not wait to be refused

`VerificationGateModal` ASKS on mount and on a timer, and blocks everything
until both halves hold. It was reactive, which was correct while Telegram was
also the signup — nobody could have an account without having been through the
bot. A form-created account has verified nothing, so a reactive gate lets
somebody wander the app until a tap fails. The owner's requirement is the
opposite: *"if not joined they can't see any other window."*

- **A channel replacement re-gates everyone, structurally.** Every cached
  membership is stamped with the generation it was observed in, so bumping the
  generation makes all of them stale at once. Nothing is swept and nothing is
  migrated. Measured.
- **A leave re-gates immediately**, from the `chat_member` webhook, same
  mechanism.
- **Two of the five reasons are the PLATFORM's state** (`no_bot`,
  `no_channel`) and say so, with no button — telling somebody to open a bot that
  does not exist is §32 S14 on the one screen they cannot get past, and a
  "check again" button there is §32 S22.
- **A contact CHANGE is detected only when evidence arrives**, and that is
  stated honestly rather than implied: Telegram pushes no event when somebody
  changes their number, so it becomes visible at the next contact share and
  nowhere else. What happens then is automatic (stand the proof down, re-gate)
  plus a human (`noteContactChange` alerts, and the player is told).

### 33.4 A limiter must guard a path that checks a credential

Twice now, measured on a running server, a limiter built for credential guesses
was applied to a path that verifies nothing:

| | what it did | what it cost |
|---|---|---|
| `authLimiter` on `/api/v1/auth` | counted an expired-token `GET /me` as a failed login | four page loads locked a player out of **logging out** (§32 S27) |
| `createSubnetLimiter('auth')` on the `/api/v1/auth` PREFIX | counted **every** request, 4 × 8 = 32 per /24 per 30 min | `GET /me` answered **429** from an address that had submitted no credential; most Indian mobile traffic is behind carrier-grade NAT, so a /24 is thousands of people |

Both now sit on the credential ROUTES, in `playerAuth.routes.js`. And signup
gets neither, because **a registration submits no secret**: nobody learns
anything by sending the form, so there is nothing to slow down. What is bounded
instead is how many **accounts** an address ends up with — `signupLimiter` and
`createSubnetLimiter('signup', { countOnly: 'successes' })`, both counting
successes, so a typo never costs the next attempt (§32 S13). Measured before
the split: three mistyped Aadhaar numbers answered *"too many attempts from your
network"* to somebody who had not yet submitted one valid form.

**The rule, stated for the next limiter:** before mounting one, name the
credential the path checks. If you cannot, it is the wrong limiter — or the
right limiter on the wrong mount.

### 33.5 Three entities, one column, and a forgotten password

Owner, 2026-09-24. **A player account, a staff account and a merchant account
are three separate things**, and one person may hold all three on one mobile
with three different passwords. Credentials for one panel do not work at
another. `users.account_type` is the owner (§2) and the doors read through it.

Three things this cost, all found by running it:

1. **Merchants were not as separate as they looked.** A merchant signup writes
   a `users` row for the login as well as a `merchants` row for the trading
   identity. Living in their own table made them look separate; without a type
   of their own that login row defaulted to `PLAYER` and the player door would
   have admitted a merchant's merchant password.
2. **A query that CAN match two populations eventually matches the wrong one.**
   `linkTelegramToAccount` matched by mobile alone. Measured: a player sharing
   their contact linked the STAFF row on the same number, and the bot's reset
   button then offered an ADMIN a password-reset link to somebody who had
   proved nothing but possession of the phone. The fix is a predicate in the
   `WHERE`, plus a second refusal in the service — one rule, two places,
   deliberately, because the consequence of being wrong is an account takeover.
3. **"Add the constraint if it is missing" is idempotent, not CONVERGENT.** A
   `DO $$ … EXCEPTION WHEN duplicate_object` guard does NOTHING when a
   constraint of that name exists — which is wrong the moment its DEFINITION
   changes. Widening the `account_type` CHECK to include `MERCHANT` was skipped
   for exactly that reason, every merchant signup then failed on a value the
   schema file plainly allows, and the apply stopped at that statement so a
   column further down was never created and the server booted against a table
   missing a column its own projection names. **A constraint whose definition
   may change is DROPPED and re-added.** A guard is only safe for one whose
   definition is fixed forever. The `UNIQUE` variant has a second mouth: it
   creates an INDEX of the same name, so a re-run can raise `duplicate_table`
   rather than `duplicate_object` and a guard catching one code re-raises.

### 33.6 A forgotten password

There is no player email, so the reset travels the only verified channel there
is: a bot, a contact share, and a link. It grants the right to **choose a
password** and never a session — see §2 and `passwordReset.service.js`.

- **It is offered, not sent.** A contact share is also the VERIFICATION step, so
  sending a link automatically would put a live credential in the chat of every
  player who was merely finishing their signup.
- **Setting it evicts every existing session**, in the same statement that
  writes the hash. The commonest reason somebody resets is that a session they
  did not open is holding their account, so a reset that leaves those alive is a
  gesture. See `sessions_valid_from` in §2 — and note that the check has to be
  in BOTH authenticated paths, because `/me` verifies its token inline.
- **The token is consumed before the password is validated.** A weak password
  therefore costs them the link, which is the right way round — a token that
  survives a failed attempt is one an attacker can grind a password policy
  against — and the message says so rather than leaving them to discover it.
- **The floor is the ACCOUNT'S floor** — 12 for staff and merchants, 8 for
  players — read off `account_type` rather than written here, or this becomes
  the third place the rule lives and the quiet failure is an admin resetting to
  an eight-character password their own signup form would have refused.

### 33.7 Three panels, three bots, three channels

Owner decision, 2026-09-24: *"two separate bots which handles merchant and
admin panel ... one bot with its own channel for merchant and one bot with its
own channel for admin thus it will be complete separate from user panel whether
its signup or login or account recovery."*

§33.5 made a player, a merchant and a staff account three separate ENTITIES on
one mobile. This makes their Telegram halves separate too, **on the same axis
and with the same vocabulary**: `audience` takes exactly the values
`users.account_type` takes, so an account's type IS its audience and there is
no second place where "which bot serves this person" is decided (§2).

- **A fleet per panel, a recovery bot per panel.** `live_slot` composes the
  audience into the slot value, so "exactly one live recovery bot" is a rule
  about one panel. With the bare role in there the second panel's recovery bot
  was refused on the INSERT, by a duplicate-key error naming an index whose
  name says nothing about audiences.
- **A webhook path per BOT, for recovery too.** It was one fixed path, which
  was right while there was one recovery bot. Three bots on one path is §33.2's
  defect exactly: every delivery checked against whichever secret resolved
  first, 401 for two of the three, and nothing anywhere saying why.
- **One channel active per panel.** Unscoped, activating the merchant channel
  deactivated the player one — and because a cached membership is stamped with
  the generation it was observed in, that silently re-gates the entire player
  base at the moment an operator believed they were configuring something else.
  Generations stay GLOBALLY unique, which makes a cross-panel stale answer
  unrepresentable rather than merely unlikely.
- **One Telegram account, one link per panel.** `telegram_identities` is keyed
  `(telegram_user_id, audience)`. One person opens all three bots from the same
  Telegram account — that is what a Telegram account IS — and a bare key made
  the second share impossible, answering "this Telegram account is already
  verifying a different account" and naming the link they had made minutes
  earlier.
- **The `'PLAYER'` literal in `linkTelegramToAccount` became the bot's own
  audience**, which is strictly stronger: a contact arriving at the merchant bot
  can only ever reach a MERCHANT account. §32 S30 stays dead, and the predicate
  and the door now say the same thing.
- **A reset link opens the panel it is for.** Sent to the player app, a staff
  reset is a single-use token spent on the wrong door, and the screen it reaches
  cannot say why.
- **The admin bot's three jobs** (owner): password reset, verifying the mobile
  on first login — which IS the gate — and carrying security alerts to the admin
  channel. `sendAlert` has two independent sinks now; an operator running the
  channel must not also have to stand up a webhook to receive anything.

**The BOOTSTRAP EXEMPTION, and why it is exactly this wide.** A literal reading
of "all three panels gate" deadlocks a fresh install: the screen that registers
the staff bot is on the admin panel, behind the gate that has nothing to check.
So staff — and only staff — pass while the staff surface is UNCONFIGURED, and
the moment a staff bot and channel exist they gate like everybody else,
including the admin who just configured it. It is returned as `bootstrap` and
rendered as a standing banner naming the screen that closes it, never a silent
pass: **an exemption nobody can see is a hole nobody removes.**

**What running it found, that no tier below a live server would have.**

| | what it was | what it cost |
|---|---|---|
| `seedAdmin` | wrote `is_admin = true` with no `account_type`, so the row sat in the PLAYER population | a browser pass opened the admin panel and was told to open the PLAYER fleet's bot. §32 S16 — a fixture describing an account the platform cannot produce |
| `seedMerchant` | wrote a `merchants` row and no `users` row, leaving `merchants.user_id` NULL | `GET /api/merchant/verification` answered 401, the gate rendered NOTHING, and the pass reported an un-gated merchant panel. The panel was right; the fixture was |
| `seedPlayer` | never linked Telegram | the e2e suite passed only on databases where nobody had configured a channel. Met one where somebody had, and four money scenarios answered 403. §32 S19 — reading whatever the database happened to hold |
| `test:e2e` | asked whether SOMETHING answered on its port | a server already on 8099 answered, the runner's own spawn never bound, and the suite seeded one database while asserting against another: 26 failures, every one true of the server being asked and false of the platform. §32 S33 |

A fifth was mine and caught in the same session: a tidy `if (!identity) return`
placed ABOVE the config read reversed the order of two questions, so every
unlinked player on an unconfigured platform was refused "link your Telegram
account" — an instruction naming a bot that does not exist. **56 pg failures,
every deposit and withdrawal route among them.** §32 S34.

---

## Commands

| Command | What it proves |
|---|---|
| `npm run check:no-mongo` | The single-store rule holds. **The definition of done.** |
| `npm run test:unit` | Money arithmetic, risk validation, cycle types, SSE, winners. |
| `npm run test:pg` | Money-path behaviour against a real PostgreSQL. |
| `npm run check:deps` | No circular imports, no boundary violations. |
| `npm run check:ui-coverage` | Every panel call reaches a real route. `--unused` lists endpoints no screen calls. |
| `npm run check:dead-code` | No export is referenced by nothing, and no module is imported by nothing. |
| `npm run check:settable` | Every order-lifecycle `set` names a column the writer accepts. |
| `npm run check:db-boundary` | No SQL, driver or relative reach past `#db`. |
| `npm run check:orphans` | Every identifier used is declared, imported or a parameter. |
| `npm run check:balance-reads` | A number that GATES a transfer is read from the rows the write will lock. |
| `npm run check:coherence` | Every column the repositories name exists, and no schema object is defined twice. |
| `npm run check:merchant-privacy` | A merchant is told the payout account — never the player's phone or UPI ID. |
| `npm run check:player-privacy` | A player is told where to pay — never the merchant's handle, QR or bank account. |
| `npm run check:payment-references` | Every external payment reference is claimed once, through one registry. |
| `npm run check:error-responses` | No 5xx hands the caller its own error text, and `serverError` still logs. |
| `npm run verify:capabilities` | Every claimed capability has its evidence on disk. |
| `npm run audit:map -- --check` | The security audit map's counts still match the code. |
| `npm run test:e2e` | The whole server, over real HTTP, as all three actors. |
| `npm run test:browser` | **Every screen in all three panels, opened in a real browser.** Needs a backend (`BB_BASE`) and starts the dev servers itself. |
| `npm run test:panel-split` | **The three-panel Telegram split, against a live server.** Three accounts on one mobile, one Telegram account, three bots — each link landing on its own row, each reset link opening its own panel. |
| `npm run test:panel-gates` | **The merchant and admin gates, opened in a real browser.** That they BLOCK, that Escape and the backdrop do not dismiss, that each names its own panel's bot, and that the staff bootstrap banner appears and then goes. |
| `npm run test:drive` | **Every control on every screen, pressed.** Reports THREW, 5xx, or INERT — a control that left the screen byte-identical. Inert is triage, not failure: read the list. |
| `npm run check:cors-headers` | Every header a panel SENDS is one CORS allows. A header the server has not agreed to is never sent — the browser cancels the request, so there is no status code and no log line for anything below a browser to see. |
| `npm run test:wallet-buttons` | Top Up and Deduct, pressed in a browser, asserted against the wallet AND the money record. |
| `npm run test:bet-button` | The bet card, pressed in a browser, cross-origin — the pass that found the CORS block. |
| `npm run test:mutate` | **Every control that CHANGES something, pressed against rows the run seeded.** Each case asserts the DATABASE and a BYSTANDER beside the target, and puts back anything platform-wide in a `finally`. Wants its own database (`bb_drive`) and a backend on it. |
