# Rules background — why each rule in CLAUDE.md exists

**This is not a rules file.** The rules are in `CLAUDE.md` and only there; where
anything here disagrees with `CLAUDE.md`, `CLAUDE.md` wins.

On 2026-10-03 `CLAUDE.md` was trimmed to its rules, because every AI session
reads it on every step and it had grown to about 190 KB. Everything it said
before that trim is kept below, word for word, under the same section, trap
(§20) and shape (§32) numbers: the incidents, the measurements, and the owner
decisions behind each rule. Look up a rule's number here when you need to know
why it exists or what breaking it cost.

The text below is a snapshot as of that date. Some of it names code that Step 2c
later removed (per-merchant wallets, the deposit escrow, ranking, the cash-link
queue, the payment-mode policy); `docs/PROJECT_STATUS.md` §3.10 describes what
replaced it. New background for a rule goes under that rule's number here, in
the same change that edits the rule (`CLAUDE.md` §31.1).

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
14. **Ask every one of §32's questions of what you just wrote.** They are the shapes
    this codebase has actually produced, each with the question that finds it.
15. **If it fixes a vulnerability, sweep for the same SHAPE across the whole
    codebase and record the result** — including "swept, none found". A fix that
    closes one instance and leaves its siblings is how `setOrderFields` shipped
    the same defect three times (§21). The procedure and the register are in
    `docs/audit/SECURITY_AUDIT_MAP.md` §1 and §4.
16. **If it is a fix in money, game, verification or security code, take it
    through §37.** That means the root invariant, every path that reaches it,
    a test that the LEGITIMATE case still succeeds, and the neighbouring
    scenarios. A fix that is green against its own test is how F-043 locked
    every second player out of a shared round.

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
| **A value the PLATFORM writes, not an operator** | **Not in `config_documents` at all** (2g, 2026-10-04). Deriving the admin accept list from the spec is only safe if nothing in the spec is a platform value: `adminTokenSupply.minted` was the running total of tokens ever issued, checked against a 10-billion cap, and an operator who could set it to 0 would have re-authorised minting the whole supply. It was marked `internal(…)` so derived lists skipped it. Minting is gone (no token is ever created, every movement is a transfer), and the last internal value and the marker went with it. A future value the platform writes gets its own table and one writer, so the spec stays a list of settings. |
| **A board's ceiling on its earliest phase offset** | `maxMergeBeforeEndSec` on the cycle META (`domains/markets/cycleTypes.js`), reached through `MAX_MERGE_BEFORE_END_SEC`. §18.3's "phases must fit the block" is the half the ordering invariant cannot see, and it was two literals passed at one call site covering two of the three boards. The board it omitted was the 60-second one, where an oversized merge is easiest to enter. A new board declares its own value (§18.2). |
| The FLOOR on any order | `SystemConfig.minDeposit` / `minWithdrawal` — **both 500 tokens**, the same rule read from either end. The buy floor was 100 and the sell floor 500: one policy written as two numbers, drifted. A floor exists because every buy HOLDS a merchant's tokens for the length of its window (F-018), so an order too small to be worth that inventory still takes it out of circulation. |
| The CEILING on any order | **A buy: the team's pool**, and it is ENFORCED rather than checked: `holdForBuyWithin` holds the tokens in the transaction that assigns the order (2c; before 2c it was the merchant's own tokens, reserved by the deposit escrow). **A sell: the player's winnings**, locked in the same transaction as the order. There is no per-merchant order range: `merchants.min_order`/`max_order` were **removed 2026-09-10**, along with their columns, their admin route fields and their panel inputs. Nothing read them. The old assignment query never named either column; the only filter on them lived in an admin SCREEN, while a comment in `merchant.routes.js` said assignment filtered on them and was believed twice. Do not reintroduce a per-merchant range. |
| Consecutive-refusal cap, and who may not serve whom | `domains/merchant/merchantRefusal.service.js` — the ONE owner of "a merchant did not serve this order". **Whose fault an expiry is depends on the DIRECTION**: a BUY that expires before PAID is the PLAYER not paying and is not a refusal at all; a BUY that is PAID and unanswered, a SELL that expires, and any decline are the merchant's. Counting every expiry against the merchant suspended honest merchants for players who changed their minds. **There is no timer on any of it**: a suspension and a bar are lifted by an admin or sub-admin who reads the reason and reinstates, and `approveMerchant` zeroes `consecutive_rejections` in the same statement — left standing at the cap, the reinstated merchant is re-suspended by the very next refusal and the admin's decision lasts one order. A decline and an EXPIRED assignment are the same event and count identically, against the same streak and the same bar; they mix, so two lapses and a decline is three. The cap is `SystemConfig.merchantOrderLimits.maxConsecutiveRejections` (schema default 3); the pairs are `order_rejections`, applied in `assignmentCandidates`' WHERE so a barred merchant is never a candidate. The streak advances and is read in one `UPDATE … RETURNING`, and only a COMPLETED order resets it. See F-021. |
| **Who is a supervisor, and on which rail** | `merchants.is_supervisor` + `merchants.supervisor_rail` (`CASH` / `UPI_BANK` / `USDT`, CHECK — with `IS NOT NULL`, because `NULL IN (…)` passes a CHECK), set only by an admin through `PUT /api/admin/merchants/:id/supervisor` (`canManageTeams`). Vocabulary: `SUPERVISOR_RAILS` in `database/repositories/teams.js`. A rail is not changed, and the role not removed, while the supervisor runs any team. A supervisor is never a team member and a member never a supervisor — a trigger states it in both directions (owner, 2026-10-02, PROJECT_STATUS §3.10). |
| **Which team a merchant is in, and how many there may be** | `teams` + `team_members` via `database/repositories/teams.js`, the one writer. `team_members.merchant_id` is the PRIMARY KEY, so a second team is unrepresentable. `MAX_TEAMS` (4) per supervisor and `TEAM_SIZE` (10) per team are counted INSIDE the write under a lock on the parent row (§32 S6) — measured: 10 simultaneous creates leave 4, 15 simultaneous proposals leave 10. A supervisor proposes (PENDING), an admin approves; pending + approved never exceed ten. |
| **Whether a team may work** | `strength` in `teams.js` (`WORKING` / `GRACE` / `STOPPED`), computed by the DATABASE clock in IST from the approved count, `teams.short_since` and `teams.was_full`. A team works at ten; one that DROPS below keeps working until midnight IST of that day, then stops until it is full again (owner). A second departure does not restart the grace day; a team that has never had ten has none. Written in the same transaction as the membership change that moves it. Routing (Step 2c) reads it; nothing else may compute it. |
| **A member's online time** (Step 2f) | `merchant_online_sessions`, written only by triggers on `merchants.is_online`. The owner's red flag compares "active time", and the only thing the platform knows about a member's time is the Online switch: routing offers orders only to an online member, so time online is time the member could have been given work. A trigger rather than the route that flips the switch, because the switch is flipped by more than one path (the member's toggle, an admin, an approval) and a log kept by one of them is a log with holes nobody sees. A partial unique index keeps one open stretch per member; a stretch is closed once and never edited, so a figure already shown cannot be rewritten. A stretch ends at `GREATEST(started_at, clock_timestamp())`: an "offline" statement whose transaction began before a concurrent "online" committed would otherwise end the stretch before it began, and the CHECK would fail the switch itself. **A supervisor has no switch** (helper/harness-2, 2026-10-07): driving the merchant panel as a supervisor pressed "Go online" and the route took it, so the log opened a member's stretch for somebody who is not a member (owner, 2026-10-02: *a supervisor does no transactions*). The guard is in `setOnline`'s WHERE (trap 18), the row refuses it (`merchants_supervisor_never_online`) for any other writer, and `setSupervisorRole` switches the row off in the statement that makes the supervisor, so a member promoted while online cannot stay online as one. Going OFFLINE is never refused: a refusal there could strand a row online. The order directions (`accepts_deposits`/`accepts_withdrawals`) are refused the same way, since a direction on a row routing never reads is a switch that switches nothing. |
| **Red flags, and what they mean** (Step 2f) | `team_red_flags` via `teamOversight.evaluateRedFlags`. The owner (2026-10-02): a member whose transaction count AND active time are below the team average by the threshold (admin-editable, 25%) is flagged daily to the supervisor and admin, *flag only, the supervisor decides*. Both, not either: a member busy offline (orders, little online time) or idle online (online, few orders) is doing their job in one sense; only a member below on both is doing neither. The day is the IST day, bounded by the DATABASE clock. `team_red_flag_days` is claimed with `ON CONFLICT DO NOTHING RETURNING` in the same transaction as the flags (S6): two instances running the hourly job evaluate a day once, and a crash halfway leaves the day unclaimed rather than half-flagged. A team of one is skipped (it IS its average), and a member approved after the day ends is not counted against it. **Completions are read from `order_states.completed_at`**, not `order_transitions`: the sell settlement (`mirrorSettlementState`) moves PAID → COMPLETED in its own UPDATE and writes no transition row, and the first version of a commission-farming flag came out empty for exactly that reason. Trap 17 still holds: this is a flag, not a money gate. **There is no commission-farming flag.** 2f built one (a team's own buyer and seller betting against each other to grow `min(buys, sells)`), and the owner removed it on 2026-10-04: the 90:10 deposit/reserve split (reserve usable only as 1% of each bet) and the 1% winnings fee (in a ₹100 against ₹100 bet the winner gets 200 and pays 2, which is 1% from each side) make a farming round lose about ₹2 per ₹100 deposited, more than the commission it earns. |
| **What a supervisor sees of a member's order** (Step 2f) | `SUPERVISOR_ORDER_FIELDS`. The owner gave the supervisor every member's transaction log and the member's voice in disputes. Only an APPROVED member's: a supervisor can propose any merchant not in a team, and proposing must not open their history; and online time only from when they joined, since earlier time was not this team's and may have been another supervisor's. The supervisor pays nobody, so nothing that reaches the player belongs in it: no bank details, no reference, no proof, no player id. `check:merchant-privacy` holds the list to a subset of `MERCHANT_ORDER_FIELDS` with no bank field. Dispute reasons and rejection reasons are text a player typed, so a mobile number can be in them; `hideMobiles` replaces every Indian-mobile spelling before the supervisor sees it (owner, 2026-10-03: nobody's mobile number may be exposed anywhere). |
| **A supervisor's voice in a dispute** (Step 2f) | Chat sender `SUPERVISOR`. The owner: the supervisor *talks to the dispute manager on members' behalf*. Only while the order is DISPUTED: a decided dispute's thread is a record, and a message added after the decision reads as though it was weighed. The DISPUTED check, the team scope and a cap of 50 messages are all in the one INSERT, which share-locks the order row: a decision committing at the same moment either waits for the message or is seen by it (S6), and the cap stops a supervisor burying the dispute manager's messages past what a thread lists (security review, 2026-10-04). The CHECK `chat_messages_supervisor_no_mobile` refuses a supervisor message carrying a mobile in the row itself, so no path that writes a chat message can skip it; the route turns the refusal into a sentence the supervisor can act on. |
| **What a member sees of the team** (Step 2f) | `teamPerformanceFor`. The owner: members see their team's performance. The team's totals and average and the member's own figures, so a member can see where they stand; never a teammate's row, because a member who can see who is below average is a member who can be pressured by the others, and the red flag is for the supervisor to act on. **Not below three members** (security review, 2026-10-04): with two, the team's total less your own IS your teammate's, so the totals would hand over the row the rule withholds. A proposed member is not one of the team yet and is shown none of it. |
| **A mobile number in text, one rule** (Step 2f security review, 2026-10-04) | `mobileInText.js` and `bb_text_has_a_mobile`. The 2d pattern allowed one space, dot or dash between ASCII digits, so "98765  43210", "(987) 654-3210", "98765/43210", a Hindi-digit number and "0919876543210" all passed: a supervisor could post a mobile and a player's typed mobile reached the supervisor. The rule now reads every Indian script's digits (and Arabic-Indic, full-width) as digits and allows two separators; three, or a letter, end the run, so amounts like "9,000 + 5,000" are not read as one. Two copies are unavoidable (the row refuses for every writer; JavaScript answers with a sentence and hides in text it cannot refuse), so `mobileInTextPg` runs the same list through both. A merchant's username and a team's name are shown to other people and many people use their mobile as a username, so both are refused by the row. Supervisors additionally never see UPI handles or numbers of nine digits or more (a UTR, an account): they pay nobody, and §24 gives the player's detail only to the member who must pay them. Player messages and system notices are not in their thread at all; the notices carry staff names and escalation notes written for staff (S52). |
| **A team's token pool, and every movement in it** | `team_pools` + the append-only `team_pool_entries`, written only by `database/repositories/teamPools.js` (Step 2b). The pool belongs to the TEAM, not the supervisor. Tokens reach it only by an admin fulfilling a supervisor's `team_pool_requests` row — a TRANSFER from `TOKEN_SUPPLY` to `TEAM_FLOAT`, never a creation — and leave it the same way back. The request's `PENDING → FULFILLED` flip is the once-only guard and the buyback floor is the pool UPDATE's own `WHERE` (S6); both run in the one transaction that posts the treasury movement and the `admin_token_considerations` row (`team_id` set), so a payment is never recorded for tokens that did not move. Fulfilling is the money area `canFundMerchants`, not `canManageTeams`. `TEAM_FLOAT` must equal the sum of every pool — since 2026-10-07 the DATABASE holds it, in every transaction (the row below), and `reconcileAgainstSubLedgers` is a report an admin can run rather than the thing that would notice. |
| **Token conservation, and why it is the database's** (owner, 2026-10-07) | The owner's words: *"dont run the supply checks each minute i want these live atomic so no double spend could happen, idempotency or anything which make sure that 1 token can't be calculated or used twice."* A sweep finds drift; it cannot prevent it, and what it finds a minute later has already been spent twice. So the rules are in `schema.sql` ("TOKEN CONSERVATION, ENFORCED BY THE DATABASE") and a transaction that breaks one does not COMMIT.<br><br>**What was open before it.** `wallets` had no non-negative CHECK — the guard lived in `moveBalances`' WHERE, so every writer that did not go through it could overdraw a pocket, and `backupRestorePg` PINNED that absence in a test. `treasury_accounts` had no sign constraint, so `TOKEN_SUPPLY` could hold tokens it never released and `HOUSE_RESERVE` could pay out more than it won. Nothing forced a movement's legs to sum to zero in the TABLE (only `postMovement` checked, in JavaScript), nothing forced a balance to move with its entries, and nothing tied the wallets to `USER_FLOAT` or the pools to `TEAM_FLOAT`: bets, casino rounds, referral rewards and admin adjustments all moved a wallet with no treasury leg at all, so `USER_FLOAT` drifted from the wallets it is supposed to describe. `SystemConfig.adminTokenSupply.total` had no consumer that moved money. Several paths were two transactions with compensation between them (deposit completion, sell settlement and its reversal, bonuses), so in the window between them the tokens were in both places or in neither.<br><br>**How it is checked without summing a table.** An ordinary AFTER row trigger adds each row's change to a transaction-local setting (`set_config(…, true)`), one bucket per rule; a DEFERRABLE INITIALLY DEFERRED constraint trigger asks at COMMIT that every bucket is zero, and the first to run checks them all and clears `bb_cons.pending` so the rest return at once. Constant work per row, none per table size: measured at **0.4 ms per wallet credit** (median 4.9 ms with the guards against 4.5 ms without, run-to-run spread 0.4 ms), and the buckets unwind with the savepoint that unwound the row, which is what `postMovement`'s savepoint depends on. The cost that matters is not the triggers: every wallet movement now locks `USER_FLOAT` (and a game's, `HOUSE_RESERVE`), which serialises them — 50 credits to 50 different wallets at once take 186 ms, about 270 a second on one 4-core box.<br><br>**What it cannot see, said plainly.** `TRUNCATE` fires no row trigger, and a table owner can `SET session_replication_role = replica`. No application path does either; test cleanup does both deliberately. `wallet_ledger` is not reconciled against `wallets` per user, because a stake lock writes a ledger row while the wallet's total does not change — the two are not equal by construction. A player-to-player transfer would conserve and would not be audited by any of this; none exists. |
| Merchant settlement rail | `merchants.accepted_currencies` — **exactly one** entry, `INR` or `USDT`. Vocabulary in `domains/merchant/merchantCurrency.js` (`MERCHANT_CURRENCIES`, `merchantTypeOf`, `isUsdtAddress`). Do not re-declare the rail strings or a second address pattern. |
| Which rail an order settles on | `order_states.currency`, matched against the merchant's rail at assignment and at accept. |
| Which member serves an order | **Routed, both directions, never claimed** (2c, owner 2026-10-02): `teamRouting.routingCandidates` lists the eligible members of working teams on the order's rail, and `assignToTeam` takes one inside the order's own transition, re-counting their open orders under their row lock so two orders arriving together cannot both take a member's last place (S6). Fewest open orders first, then least recently assigned, so work spreads across the team. Before 2c a BUY was assigned by `tryAssignMerchant` ranking merchants by holdings (letting merchants claim a queued buy first-come had rewarded whoever polled hardest), a SELL could be claimed from an open pool, and a cash BUY was matched to a supplied link (`tryClaimCashLink`). 2c removed the ranking, the open pool and the link queue: an order nobody is free for waits `PENDING_QUEUE` and the sweep offers it again. The member's own "accept deposit/withdrawal orders" switches are read only here; for a window in 2c nothing read them and a member who switched buys off kept being handed buys (§32 S5). |
| An expired BUY order | **Nobody's fault, and still a signal — two of them.** `domains/payment/playerPaymentFailure.service.js` is the ONE owner and advances BOTH counts, so an expiry cannot be recorded against one party and forgotten against the other. It is neither a refusal nor an accusation: the player abandoned a purchase, which is ordinary, and the merchant did nothing. Two earlier versions got this wrong in opposite directions — one suspended honest merchants for players who changed their minds, the next marked the players. |
| Three unpaid buys by one PLAYER | `users.consecutive_payment_failures` (advanced and read in one statement); at `maxConsecutivePlayerPaymentFailures` (schema default 3) they cannot open a new order for `playerOrderLockMinutes` (60) — **on BOTH rails**, or a player locked out of buying just sells instead. `users.order_lock_until` is a TIMESTAMP written by the DATABASE's clock, so it expires on its own with no cron to fail, and `GREATEST` extends rather than shortens. Flagged for an admin too, **never auto-blocked**. Cleared by `moveDepositMoney` — where the money is known to have ARRIVED, not at PAID, or a false UTR would wipe the record. |
| Three unpaid buys against one MERCHANT | `merchants.consecutive_expiries` — **deliberately NOT `consecutive_rejections`**, because an expiry is not a refusal and must never reach the suspension cap. Three different players sent to one merchant, none able to pay, most likely means that merchant cannot BE paid (dead QR, closed handle) — invisible one order at a time. At `maxConsecutiveMerchantExpiries` (schema default 3) `assignment_paused_at` is set and they stop being a candidate on every path: `assignmentCandidates`, `cashSuppliersFor`, and the cash-link claim. **Not a suspension**: they keep their orders, balance and standing. **No timer** — `PUT /api/admin/merchants/:id/resume-assignment` lifts it, because a clock cannot tell whether the QR was fixed; `approveMerchant` clears it too, and both zero the count in the same statement. Any COMPLETED order clears the run by itself. |
| A merchant who ignores a PAID buy | `sweepUnansweredPaidDeposits`, every 2 minutes, against `SystemConfig.merchantOrderLimits.paidResponseMinutes` (schema default 30). The order goes to **DISPUTED** — the admin queue — never cancelled and never reassigned: the player paid THAT merchant's account, so only a person can decide. `disputeRaisedBy` is `'system'`, because a player who raised nothing must not appear to have. The silence counts as a refusal. This was the one window where the player's money was already gone and nothing was watching it. |
| **A cash player who taps Paid and never submits a reference** | `sweepUtrAfterPaid`, every 2 minutes, against `SystemConfig.merchantOrderLimits.utrAfterPaidMinutes` (schema default 15, bounded 2–60). **Only on the CASH_ATM rail**, because only there does PAID come before the reference. An ATM has a time limit: the player taps **Paid** so the merchant can press Continue on the machine, and the UTR arrives after, off the slip. So `PAID` with no `utr` is a state this rail deliberately creates, and two sweeps had to be split to tell the two silences apart — `sweepUnansweredPaidDeposits` (the MERCHANT ignoring evidence that exists) now requires `utr IS NOT NULL`, or it would have counted a refusal against a merchant who had been shown nothing. This one is the PLAYER's silence and goes through `playerPaymentFailure.service.js`, the one owner of "a buy nobody evidenced" — never through `merchantRefusal`. |
| Who may be given a CASH order | **Routing, plus the Ready switch** (2c): a cash buy goes only to a member who pressed Ready (they are at the machine), and the assignment switches Ready off, under the member's lock, so one press takes one order. A cash sell never goes to a member holding an open buy. Before 2c it was the claim query in `cashLinks.js`: a link was supplied minutes before it was claimed, so eligibility had to be asked at the claim, not at the supply, and for a while that query joined `merchants` not at all, so a merchant an admin had stopped kept being handed players through a link left behind. The link queue went in 2c; the QR is now scanned per order after the member accepts (2d, §2 "A cash buy's QR"). |
| Which CHAIN a USDT order settles on | `order_states.usdt_chain`, frozen by trigger. A merchant holds one address **per chain** (`usdt_address_trc20`, `usdt_address_bep20`). See §25. |
| The USDT quote | `order_states.rate_used` + `fiat_amount_paise`, written WITH the order and frozen by trigger. Assignment may not re-price. See §25. |
| USDT buy pricing | `SystemConfig.usdtPricing` — admin-set, both rates: `userMerchantBuyInr` (what a player pays, frozen on the order) and `merchantAdminBuyInr` (what a team pays for pool tokens, frozen on the pool sale). Both held to ONE sanity band, ₹10–₹1,000 per USDT, owned by `domains/configuration/tokenRates.js`, enforced by the admin route on save AND by the reader, which answers null (unset) outside it. 0 is the schema default for both and means unset; a USDT payment is then refused by name. There is no USDT sell rail. |
| The settlement rail in force | **None** (2c). Each supervisor is approved for one rail, and an order goes to the rail its size or currency serves (§2 "An order's payment rail"). Before 2c `payment_mode_policies` (one ACTIVE version, append-only) chose a platform-wide rail; it and `payment_gateway_configs` were dropped. Never a feature flag either: `featureFlags.service.js` is an env var and an in-process Map, which does not survive a restart and cannot say which rail was live when an order was created. |
| The rail an ORDER runs under | `order_states.payment_mode`, stamped at creation from the order's currency and size (`orderRails.paymentModeFor`, called by `createOrderRecord`) and **immutable by trigger**. Every worker and screen branches on the order's own value; an open order cannot change rail under the member serving it. |
| Merchant earnings | Before 2e: `merchant_commission_policies` + `merchant_commission_rates` (one row per variety), read by `domains/merchant/merchantCommission.service.js`, which owned no numbers. Since 2e: team commission (§26). Platform-funded from `MERCHANT_BONUS_POOL`, never deducted from users. Do not reintroduce `commissionRate`, a buy/sell spread, or a deposit-triggered commission. |
| **How many tokens exist, and where they are** | **`SystemConfig.adminTokenSupply.total` — 20,000,000,000, and NONE ARE EVER CREATED** (owner, 2026-09-23). The platform starts holding all of them; every movement after that is a TRANSFER — platform → merchant when a merchant buys inventory, merchant → player when a player buys, and back the other way when they sell. So `platform holding + every merchant wallet + every player wallet = total`, always, and that is an invariant the double-entry books prove rather than a promise a counter makes. `transferred` is what has left the platform's own holding (`internal`: an operator who could set it to 0 would be telling the platform it still holds tokens it has already given away); what it still holds is `total - transferred`. **Do not reintroduce minting.** The word survived in `reserveAdminMint`, "Approving one mints supply", and a 10-billion "cap" that read as a ceiling on creation — all of which described a model this platform does not have. |
| Merchant token balance mutations | **None** (2b/2c): a member holds no tokens; the TEAM's pool does (`teamPools.js`). `merchantWallet.service.js` and `merchant_wallets` went with per-merchant wallets. |
| **What the platform GOT, or GAVE, for an admin↔merchant token movement** | `admin_token_considerations` via `database/repositories/adminTokenConsiderations.js` — one row per movement, keyed BY the movement, so the money fact inherits the token movement's idempotency instead of inventing its own. The treasury says the tokens moved; nothing said what they moved FOR, so every P&L reading of the admin↔merchant leg was missing its revenue side and the books balanced in tokens while saying nothing about money. **Two amounts, deliberately** (trap 15): `fiat_amount_minor` is hundredths of the currency actually transacted — what a human is shown and what reconciles against a bank line or a chain explorer — and must NEVER be summed across currencies; `inr_equivalent_paise` is the same event in rupees and is the ONLY column anything may aggregate. `rate_used` is frozen on the row for §25's reason: an operator editing the USDT price must not restate a settled trade. The figure is **REQUIRED** on both routes and **0 is a real answer** meaning "no money changed hands" — absence and zero are different facts, and a nullable column could not tell them apart. USDT comes IN only; the platform buys its tokens back in rupees (owner, 2026-09-23), stated as a CHECK so the rule survives the next route that writes here. Validated BEFORE any token moves, because the row is written after the movement commits (§21). |
| Tokens held for a BUY | **HELD in the team's pool** (`order_states.pool_held_paise`, `team_pools.held_paise`) through `teamPools.js`, the one owner (2c): taken in the transaction that assigns, released on every ending and requeue, spent once by the completion. At most one live hold per order: the hold's UPDATE asks `pool_held_paise = 0`. **No gate may ADMIT an order by reading a balance** — a read in one statement acted on in another is a snapshot, and two orders arriving together both passed it. Taking the hold IS the check. Before 2c the hold was the merchant's own, in `merchant_settlements` via `depositEscrow.service.js` (F-018). |
| Whether a team's held tokens can be taken by anything else | **No.** Every other movement touches `available`; `held` moves only through the hold, release and spend in `teamPools.js`, each guarded in its own WHERE under the order's lock. A buyback (a supervisor's SELL request) takes only from `available`, so it cannot reach tokens promised to a player. |
| A hold left behind | `findStrandedBuyHolds()` + `findCompletedUnspentBuys()`, swept every 5 minutes by cron `team-pool-hold-sweep`. A hold left on an order that ended without spending it is RELEASED to the pool (a path forgot). A COMPLETED buy still holding is ALERTED, never fixed: its player was credited, so the tokens are owed to them, not to the team, and re-taking or releasing them would hide the path that forgot. |
| Wallet balance mutations (player) | `domains/wallet/walletAuthority.service.js` exclusively, **including a bet's stake lock**. A route may not move a balance. |
| Wallet balance READS | `walletAuthority.getBalances()`, reading the `wallets` row. No second copy of a balance exists or may be introduced. **Every read is classified display or decision** — see §9. |
| Money in/out of the ecosystem | `domains/funding/fundingAuthority.service.js`; rails are adapters in `providerRegistry.js`. Never owns accounting. |
| Settlement ledger / accounting events | `accounting_events`, written ONLY via `domains/revenue/revenueSettlement.service.js`. Append-only double-entry, integer paise, unique idempotency keys, balances always derived from postings and never stored. |
| External payment references (UTR, chain tx hash, CDM slip) | `utr_registry` via `claimPaymentReference()`. One reference, one order, for good. See §27. |
| **Which dependency advisories the audit gate tolerates** | `scripts/audit-exceptions.json`, enforced by `scripts/audit-gate.mjs` (CI's `audit` job, one run per lockfile). Otherwise it is `npm audit --audit-level=high`. Each entry is an owner decision for ONE advisory, and the gate stops honouring it by itself when the advisory's range changes, when any copy of the package stops being `dev: true` in that lockfile, or when a version outside the range is published. Delete the entry in the change that upgrades past it. The first entry is braces GHSA-vfj7-8cjw-p6xm (owner, 2026-10-03). |
| What a failed request tells its caller | `backend/shared/httpError.js`. `serverError` logs in full and answers with nothing; `callerError` keeps a refusal's own wording; `respondError` routes a `catch` that holds either, on the PRESENCE of `err.status` and never its value. A handler may not phrase a 5xx itself. |
| **Which addresses are refused before any route runs** | `ip_blocks` via `database/repositories/ipBlocks.js`; ENFORCED by `backend/middleware/ipBlocklist.js`, mounted in `server.js` before `securityMonitor`, the load shedder and every limiter, so a blocked client costs one in-memory lookup and never a database write. The rows are the truth and the in-memory list is a copy: it is loaded at boot (awaited), reloaded every 10 s and at once on the instance that changed it, and a failed reload keeps the last good list, because an empty list would unblock everyone at once. Expiry is the database's clock, in `liveBlocks()`, so no sweep is needed. The admin routes refuse a range wider than /16 (IPv4) or /48 (IPv6), loopback, and any range covering the admin's OWN address, because behind a proxy with `TRUST_PROXY` unset that address is the balancer, and the block would lock out everyone, including the admin who would lift it. The earlier `ipBlocker` had a table and no mount (F-030). **A deny-list is only real if a request is refused by it: its test mounts the middleware in front of a route.** **And the socket.io upgrade is a request too**: the engine answers it before Express runs, so `allowRequest` is `realtimeAdmission(app, …)`, which judges the address Express's own `req.ip` would (F-045). An IPv4 range written in IPv6-mapped form (`::ffff:10.0.0.0/104`) is held to the IPv4 floor in IPv4 terms, because the matcher applies it to plain IPv4 clients (F-046). |
| Order lifecycle state | `order_states.state` — `PENDING_QUEUE, ASSIGNED, PROCESSING, PAID, COMPLETED, DISPUTED, CANCELLED, FAILED, REJECTED`, enforced by CHECK. |
| **Where an order is CREATED, and its tamper tag** | `createOrderRecord` in `database/repositories/orders.record.js` — THE creation path, and it writes `order_hmac` in the same INSERT. `prepareOrderRecord` is the same statement, run inside a transaction another writer holds. There was a second path (`openOrder`) that was the only writer of the tag and had no production caller, so every live order was untagged and `orderAccessGuard` — which then passed untagged orders — never refused anything (F-024). The guard now refuses a missing tag whenever a secret is configured. Do not add a second creation path. |
| **A withdrawal's stake lock, and the order it is for** | ONE transaction: `debitWinningsForWithdrawal(…, { within: prepareOrderRecord(…) })` runs the order's INSERT under the wallet row lock after the movement. A lock with no order is money no expiry, cancel or refund can find — a second retry of one expired withdrawal locked the stake again and was refused only at the INSERT (F-025). |
| **The merchant's side of a completed BUY** | `moveDepositMoney`, which takes it ONCE through `teamPools.spendForBuy`: from the order's hold, and from the pool's `available` only when the hold was already released (a dispute decided for the player after expiry), refused by the UPDATE's WHERE if the pool is short. A BUY_PAID entry for the order means it is done. Completing a hold SPENDS it — there is no second debit beside it (§32 S41, F-026). Every route that completes a buy goes through it; none spends on its own. |
| **How an admin decision ends a withdrawal's money** | `withdrawalHold.endWithdrawal(orderId, 'REFUND' \| 'RELEASE')`, for every position the money can be in (not yet confirmed, HELD, settled). It moves money and the credit/escrow flags and NEVER the order's state — the route's guarded transition owns that. A withdrawal's stake is returned on ONE key, `refund_<orderId>` (`refundWithdrawal`), whichever path returns it; `creditWinnings` is never a refund of a stake (F-027). |
| Which fields the lifecycle may write | `SETTABLE` in the order writer. See §21. |
| **Whether a buy's tokens have been paid out, and what may follow** | `order_states.pool_paid_at`, stamped by `teamPools.spendForBuy` in the transaction that pays, after it asks `requireState` under the order's lock. Once set, `transition()` and `reassign()` refuse every move but `COMPLETED` (`pool_paid`); a COMPLETED buy may still be disputed, and that dispute can only end COMPLETED. `moveDepositMoney` REQUIRES `requireState`, and the admin APPROVE asks `canTransition` before any money moves. The money moves first on every completing route, so without this a reject, expiry or dispute landing in between left a REJECTED or CANCELLED buy whose player had been paid (security review, 2026-10-03). |
| **Which member may move an order** | The one it is assigned to: every member route passes `expectMerchant`, asked by `transition({ onlyMerchant })` under the order lock BEFORE the idempotent answer and again in the `WHERE` (`merchant_changed`). Asked after it, a member accepting an order an admin had handed to a colleague was told "already there" and their `set` took the order back (security review, 2026-10-03). |
| **Whether a game WIN may be paid at all** | **Only on a round the player bet on** (owner, 2026-10-01). Board games: a payout is the WON transition of a PENDING `bets` row, so it cannot exist without a bet. Casino, crash and sports: `recordCallback` in `database/repositories/casino.core.js` refuses a WIN without THIS player's standing stake on that round, under the round lock; `casino_rounds_win_needs_bet` states it in the data. Free-spin or promotional provider wins with no stake are refused by this rule (F-043). |
| **What a casino ROUND is** | **One player's stake on one provider's round id** — `casino_rounds_one_per_player`, UNIQUE `(provider_key, user_id, round_id)`, and every read and lock names all three (`getRound(roundId, { userId, providerKey })` throws without the player). NOT the round id alone: a crash round or a live table is one round id shared by everybody at it, and two providers can number rounds the same way. Keyed on the id alone, the rows first MERGED (a rollback was bounded by, and paid against, another player's stake) and then, under F-043's ownership refusal, every player after the first was refused (F-044). Whose stake it is, is the KEY, never a check made after the read. |
| Dispute resolution | `order_states` embedded dispute fields: the decision lives on the ORDER. Who LOST it is the next row. |
| **What the Dispute Manager can list** (helper/harness-2, 2026-10-07) | `DISPUTE_FILTERS` in `orders.record.js`. The screen kept its own four filters ("all", "DISPUTED", "RESOLVED", "ESCALATED") and opened on "all"; the queue widened only on `'ALL'` and read anything else as an order STATE, so the default view asked for state `all` and listed nothing, and two of the four asked for states the `order_states.state` CHECK forbids. Only "Open" ever listed a dispute (found by `test:mutate`'s `admin/disputes` cases). Now the queue owns the keys, what each selects and what each is called, and sends them with every answer, so the screen cannot drift from it (§5, S25). "Closed" asks the STATE (no longer DISPUTED, ever disputed), not `dispute_decision`, because the queue's approve/reject closes a dispute without writing one. The total is counted apart from the page in the same statement: read off the page's rows, a page past the end said there were none (S47). |
| **Whoever was wrong in a decided dispute** | `dispute_faults` (PK `order_id`) via `database/repositories/disputeFaults.js`, the one writer, called only by `domains/disputes/disputeOutcome.service.js` (`recordDisputeLoser`) from ALL THREE routes that decide a dispute — the Dispute Manager resolve, the Payment Control Centre resolve, and the queue action on a DISPUTED order (§32 S3). Only a PAYMENT dispute counts (security review, 2026-10-03): raised by the player or the platform (`disputeRaisedBy` `user`/`system`; a member's red flag is `merchant` and suspends nobody), from a buy `PAID` or `REJECTED` or a sell `PAID` or `COMPLETED` (`disputedFromState`, read off `order_transitions`). Then the loser is a function of the outcome (`partyAtFault`): a buy completed or a sell cancelled → the MEMBER (on a buy, only if they rejected it or were shown a reference); the other way → the PLAYER (owner, 2026-10-02 21:13: "the one who was wrong will be suspended completely"). The Dispute Manager shows the server's answer (`suspendsIfToUser`/`suspendsIfToMerchant`), never its own copy. One transaction writes the record, `lost_disputes + 1`, and the suspension (a player `is_blocked`; a member `SUSPENDED`); keyed by the order, so a replayed or concurrent decision counts once; a party with no row rolls it all back. Only an order that WAS DISPUTED when decided counts. At `HIGH_RISK_LOSSES` (3) `high_risk_at` is set and only a FULL ADMIN may lift: the guard is in the WHERE of `setBlocked` and `approveMerchant` (`mayLiftHighRisk`), never a read in the route (S6). A full admin's lift clears `high_risk_at` and keeps the count, so the next loss reopens review. The panel's old "penalty" field moved nothing and was removed. |
| **The escrow window after a member rejects a BUY as unpaid** | `order_states.dispute_window_until`, written by the DATABASE clock in the reject route's own transition (`now() + rejectedBuyDisputeMinutes`), and `domains/payment/rejectedBuyWindow.service.js`. The member cannot red-flag their own rejection: it is the player's to dispute. The buy waits in `REJECTED` with its pool hold intact; the player's dispute route checks the same column on the same clock under the order lock; the `rejected-buy-window` sweep (every minute) cancels an undisputed one and releases the hold. A dispute that lands first wins, and then the hold waits for the decision with no time limit. `SystemConfig.rejectedBuyDisputeMinutes` (schema default 15, bounded 5–1440, whole minutes: `int(…)` in the spec refuses a fraction on save). A REJECTED buy cannot be retried beside its open window. **From PAID only** (owner, 2026-10-07, answering 2g question 2): "payment not received" denies a payment the player CLAIMED, and before the Paid tap there is no claim. The 2g review found the route passing `expectFrom: ['PAID', 'PROCESSING']` and the rule table listing PENDING_QUEUE, ASSIGNED and PROCESSING as edges into REJECTED, so a member could reject an accepted buy the player had not paid yet: it went to REJECTED, opened a window, and warned and flagged a player who had said nothing (reproduced against a real database: 200, warning 1, flagged). The proof-upload route admitted PROCESSING too, and any order type (§32 S3). Fixed at the rule, not the route: `ALLOWED_FROM[REJECTED]` is `[PAID]`, so the transition's WHERE refuses an unpaid buy whatever calls it (trap 18); `unpaidRejectRefusal` reads the same table to word the refusal for both doors (400 `NOT_PAID_YET` while the buy can still become PAID, 409 past it), asked after ownership and before the reason and proof (S34). Before the tap the member's only course is to wait: an unpaid buy lapses, and whose lapse that is stays `playerCouldPay`'s question. |
| **The escrow window after a member marks a SELL paid** | `SystemConfig.withdrawalHoldMinutes` — schema default 60 AND floor 60 (owner: "at least 1 hour"), read by `withdrawalHold.service.js`. A zero-hold "settle at once" path no longer exists. The player is told the instant as `disputeUntil` (`playerOrderView.js`), never the merchant's credit status. |
| Cash denominations and USDT sizes | `domains/merchant/denominations.js`. The SQL CHECKs duplicate the lists by necessity; `merchantDenominationsPg.test.js` asserts the database agrees. Not admin-editable. |
| Referral reward, budget, member cap | `REFERRAL_REWARD_PAISE` in `domains/referral/referralRewards.js` (flat ₹25) and `referral_programmes`. A flat one-off per verified signup, two tiers, from a bounded pool — never a share of anyone's losses and never attached to settlement. |
| Referral earnings ledger and payout order | `domains/referral/referral.service.js` exclusively. Append-only, unique on `(sourceUserId, level)`; eligibility evaluated at payout. Pays strictly in joining-number order through `creditWinnings`. |
| Player contact details | **There are none beyond the mobile.** No player email exists; the bot never asks for one. `SupportLinks.email` and `merchants.email` are different things and stay. |
| **Whether the platform holds an identity number at all** | **It does not. KYC was removed entirely (owner, 2026-10-02)** — no Aadhaar, no `kyc_status`, no verification queue, no bulk export, no Aadhaar-based recovery. A player is a mobile, PROVED by a Telegram contact share, and a password. `identitySurfaceRemoved.test.js` asserts the absence: no code reads an Aadhaar off a request, nothing names a KYC column or table, and `schema.sql` drops the old ones on every boot. Do not reintroduce an identity number without an owner decision. `users.mobile` is never mutable — which is why the signup form normalises `+91` and a leading `0` off the number BEFORE it is written (§33). |
| Identity documents | **None are collected, stored or accepted** — not a document and, since 2026-10-02, not a number either. Do not add an upload path for one. |
| Upload categories that DO exist | `services/cdn.service.js` — P2P chat attachments, payment proofs, admin branding assets, CDM receipts — and Android release APKs, which the admin Android App page stores through `uploadBufferToS3` (one immutable object per version). Nothing else. "No identity documents, so remove the upload routes" would break deposits and disputes. |
| The live bot and official channel | `telegram_configs` (the active generation, owning the channel) plus the bot registry, composed by `activeConfig()` in `domains/telegram/telegramClient.js`. **The registry wins over a generation's embedded credentials.** A bot swap does NOT bump the generation; only a channel change does. The 30s cache in `activeConfig` is the only permitted cache. |
| **Which PANEL a bot, a channel or a Telegram link belongs to** | `audience` on `telegram_bots`, `telegram_configs`, `telegram_identities` and `telegram_recovery_sessions` — taking exactly the values `users.account_type` takes, so an account's TYPE **is** its audience and nothing else decides which bot serves whom (owner, 2026-09-24). Each panel gets its own sign-in FLEET and its own singular recovery bot: `live_slot` composes the audience in, or the one partial unique index refuses the second panel's recovery bot on the INSERT. Each gets its own channel, so `one_active_telegram_config` is unique on `(audience) WHERE active` — unscoped, activating the merchant channel deactivated the player one and re-gated every player. `telegram_identities` is keyed **(telegram_user_id, audience)**: one person opens all three bots from ONE Telegram account, which a bare key made impossible. Generations stay GLOBALLY unique across all three, which makes a cross-panel stale membership unrepresentable rather than merely unlikely. Every repository read that DECIDES something takes a required audience and THROWS without one, for the reason `getUserByMobile` does. |
| **The player app's origin** | `publicAppOrigin()` in `backend/config/publicAppOrigin.js`, the one reader of `PUBLIC_APP_ORIGIN`. It used to be `panelOrigin()` with an origin per panel, for staff and merchant reset links; the reset is finished in the Mini App since 2026-10-08 (§33.0), so no link to those panels is minted and the two variables went. |
| **What each audience is CALLED on a screen** | `PANEL_NAME` / `PANEL_NOUN` in `domains/identity/audiences.js`. `ACCOUNT_TYPES` owns the VALUES; this owns the words — kept apart so a renamed label cannot move the database's vocabulary. It exists because the channel-replacement route answered "Every player will be asked to join the new channel" whatever panel had just been flipped, which on the merchant screen is the sentence that makes somebody flip it back. |
| **Whether a STAFF account may pass its own gate before staff Telegram exists** | `verificationStateFor`'s `bootstrap`. STAFF only, and only while `no_bot` or `no_channel` — the screen that registers the staff bot is ON the admin panel, behind the gate that has nothing to check, so a literal reading of "all three panels gate" is a deadlock no account can break. It is RETURNED, never a silent pass, and the admin panel renders it as a standing banner naming the screen that closes it: an exemption nobody can see is one nobody removes. |
| **How many sign-in bots there are, and which one a player gets** | `telegram_bots` (role `signin`, any number ACTIVE) + `assignSigninBot` in `database/repositories/telegram.js`, wrapped by `domains/identity/signupVerification.service.js`. **`signin` is a FLEET; `recovery` is singular** — the generated `live_slot` column names recovery only, and the partial unique index enforces one live recovery bot. The rotation cursor is the SEQUENCE `telegram_signin_rotation`: `nextval - 1` modulo the live count, over the fleet ordered `added_at, bot_id`. The assignment is STORED on `users.telegram_bot_id` because the player is TOLD which bot to open, and re-resolved on every read so a retired bot's players move on their own. Retiring the LAST live sign-in bot is refused **in the statement**, by counting what would be left. |
| **Whether a player may use the app at all** | `domains/identity/signupVerification.service.js` — `verificationStateFor()`, served by `GET /api/v1/auth/verification`. It answers the contact share and the channel membership together and hands back ONE `reason` naming the one thing to do next. **Not two endpoints** — the panel reads `reason` and nothing else, because a screen deriving that from four booleans derives it differently from the next screen that tries. |
| **Which POPULATION a `users` row belongs to** | `users.account_type` — `PLAYER`, `STAFF` or `MERCHANT`, declared in `ACCOUNT_TYPES` (`database/repositories/users.js`) and enforced by `users_account_type_check`. **A mobile is unique PER TYPE** (`users_mobile_per_account_type`), so one person may hold all three with three different passwords, and the credentials for one do not work at another door (owner, 2026-09-24). `getUserByMobile` REQUIRES the type and throws without it: a default would have made every un-updated caller silently correct for players and silently wrong for the other two — failing only on the accounts that move money. **MERCHANT is in this column and that surprises people**: a merchant signup writes a `users` row (the login) as well as a `merchants` row (the trading identity), so merchants living in their own table does NOT make their login separate — without a type of their own that row defaulted to PLAYER and the player door admitted a merchant's merchant password. **An account is never moved between panels, and staff authority lives on STAFF rows only.** Owner, 2026-10-01: *"they are completely different panel so the user is different … if he has his admin account that account can only be used for admin activity and he will need separate accounts for both other panel."* So nothing promotes a player account, links it to a staff one, or changes a row's `account_type`; a person who plays and administers holds two accounts. Fixtures obey it too (§32 S16). — `users_staff_flags_need_staff` refuses `is_admin`, `is_sub_admin`, `is_queue_manager` or `is_mediator` on any other type, in the data (2026-10-01). The doors scope the LOGIN by type; the authority checks read flags off whatever row a SESSION belongs to, so a flag on a PLAYER row was staff authority riding a player's session (measured: the queue-manager grant took a player id, and that player then read the payment queue). |
| **Whether a session issued earlier is still valid** | `users.sessions_valid_from` + `sessionIsLive()` in `domains/identity/auth.middleware.js` (not revoked AND not issued before the cutoff), and `sessionSuperseded()` for the half a caller that has already checked revocation needs. Sessions are stateless PASETO and nothing holds a list of the ones outstanding, so this cutoff is the ONLY way to evict them; a password reset moves it to `now()` in the same statement that writes the hash. **Every path that verifies a token checks it**: `authenticate`, `GET /api/v1/auth/me` (inline), `merchantAuth`, both private SSE streams, and the three socket room joins. It was in two of those eight. After a reset, the pre-reset session went on answering 200 on `/me`, receiving the player's balance pushes, and holding the merchant's and the admin's live feeds (R6). A MERCHANT session's cutoff lives on the merchant's LOGIN row (`merchantLoginRow`), not on `merchants`. |
| **A merchant's password** | `users.password_hash` on the merchant's LOGIN row (§33.5), read by the one `loginHandler` (`getUserCredentials`) at the merchant door since Step 3. **Not on `merchants`**: that column was removed on 2026-09-30. It was a second copy, and the two had split. The password reset wrote `users` and the merchant door read `merchants`, so a merchant who reset was told it worked and was then refused the new password. |
| **A password reset** | `domains/identity/passwordReset.service.js` + `telegram.resetPasswordByContact`. There is no player email, so a reset travels the one channel Telegram has verified: a contact share in the Mini App. It sets a password and **never a session** (owner, 2026-09-24). Since 2026-10-08 it is set in the Mini App itself, for every panel, in the transaction that spends the proof, with every session evicted; there is no token, link or `password_resets` table (§33.0). |
| **Which door a password login arrived at** | `LOGIN_DOOR` in `backend/routes.js`, set by the MOUNT. One `loginHandler` serves both `/api/admin/login` (staff) and `/api/v1/auth/login` (players); they differ only in who they admit, and every other thing they do — reading the hash from the one function that returns it, the blocked refusal, the argon2 upgrade, issuing a challenge INSTEAD of a session — is identical and must stay identical. **The door scopes the READ by `account_type`**, so the separation is a predicate rather than a check made afterwards: the staff door never loads a player row at all, and a flipped `is_admin` cannot admit one. Checked on BOTH legs, so a challenge minted at one cannot be redeemed at the other — and on the 2FA leg the type is compared explicitly, because that leg reads by user id and the predicate never touched its query. |
| **Which panel a SESSION may be used at** | The door middleware, by `account_type` — `belongsElsewhere` / `refuseWrongPanel` in `domains/identity/auth.middleware.js`. **`authenticatePlayer`** guards every player route (payment, user, bet, support, game launch, profile picture, `/bonuses/my`, `/v1/auth/verification`) and admits a PLAYER session only; **`authenticate`** admits PLAYER and STAFF and never a MERCHANT; `/me` keeps the same rule inline (S32); the socket `join_user_room` admits a PLAYER to their own room only. A refusal is `403 WRONG_PANEL` naming the panel the account belongs to. The login doors scoped by type and the session door did not, so a session minted at one door worked at another's (§32 S51): a merchant's session read the player's projection of an order assigned to it, and a staff session created deposits in its own name — measured 200 on both (2026-10-01). `npm run test:pg -- playerDoorPg` presses every player route as a staff and a merchant session. |
| What the bot says | `TelegramTemplate` rows via `telegramTemplates.service.js`, with `DEFAULT_TEMPLATES` as fallback. A blank row means the shipped default, never silence. Do not hardcode a player-facing sentence in a route. **Which BOT sends it is a separate question** — `sendTemplate({ bot })`, always, on the sign-in fleet: a bot may only message somebody who has opened a chat with IT, so a reply from any other bot is refused by Telegram and reads to the player as a conversation that simply stopped. |
| What a valid mobile or referral code LOOKS like | `backend/domains/identity/signupFields.js`. Both ends import it — the form that takes what a person typed, and the contact share that takes what Telegram verified — because if they normalise a phone number differently the match fails for a player who did nothing wrong, silently. The user panel keeps a §5 MIRROR (`indianMobile` in `AuthModal.tsx`) because §15 forbids importing from `backend/`; change them in the same commit. |
| What a password may be | `backend/domains/identity/passwordPolicy.js` — `assertStaffPassword` (12) and `assertPlayerPassword` (8), ONE implementation with two floors. The floor is set by BLAST RADIUS: a staff password reads the whole player base and the ledger; a player's reaches one wallet. Everything above the floor is identical, deliberately — a second copy is where the degenerate-run check quietly stops being applied to players. |
| Notifications, all channels | `domains/communication/communication.service.js` `notify()`. Never write a notification row directly. |
| Transaction/bet validation and operational rules | `domains/risk/riskValidation.service.js` — the only place this logic lives. Configurable numbers stay in `SystemConfig`. |
| Cycle timing | `domains/markets/cycleGenerator.service.js` computes; `GAME_CORE.ts` mirrors for display math only. |
| Cycle-type vocabulary | `domains/markets/cycleTypes.js` — names only, never numbers. Throws on an unknown type rather than defaulting, because the ternaries it replaced failed silently. |
| Game catalogue | `games` + `game_categories`. No hardcoded game arrays anywhere. |
| Trading vocabulary | `domains/trading/tradingModels.js` |
| **What a sub-admin can be given, and what every staff route asks for** | `backend/domains/identity/staffPermissions.js` — 29 AREAS (`STAFF_PERMISSIONS`), one key per area of the admin panel, each with the label and description the Sub-admins screen shows, and `ADMIN_ONLY_AREAS`: the 7 routes no sub-admin can be given, each with its reason (they GRANT authority — sub-admins and queue managers). `PUT /users/:userId/roles` was the eighth, and was deleted 2026-10-01: no screen called it and it would set `is_admin` on any row. Every staff route asks `hasPermission(<area>)` and nothing weaker; `isAdminOrSubAdmin` ("are you staff at all") is deleted. Owner, 2026-10-01: *"the sub admin then can only do the work in those permissioned areas."* `npm run check:staff-permissions` reads the LIVE route stacks and fails the build on a staff route naming no area, an unlisted full-admin-only route, or a panel key the server does not declare. A grant is stored as every key true/false; an unknown key or a non-boolean is refused by name, and a body with no `permissions` is refused — ABSENT is not EMPTY (the panel sent the wrong shape and every save revoked everything). The admin panel renders the picker from `GET /api/admin/staff-permissions` and keeps only a §5 mirror of the keys (`utils/permissions.ts`). A grant is the account's row (`users.sub_admin_permissions`), read on every request. |
| **Which staff receive a live admin event** | `backend/domains/notification/staffEventAreas.js` — each admin event names the areas whose screens need it; the SSE admin stream filters per client and the socket admin room is one room per area. An undeclared event reaches full admins only. A permission change closes that account's streams on every instance (`closeAdminClientsFor`, `disconnectSockets`), so no stream outlives the grant it was opened under. Both transports delivered EVERYTHING to every staff account before (F-047). |
| Chat rules | Chat config document via `/api/chat/config` |
| Branding | The `Branding` document — see §13 |
| Social/support links | `SupportLinks` — **not** Branding |
| Auth tokens | One storage key per app (`auth_token` / `merchantToken` / `admin-auth`) |
| Realtime event names | `docs/reference/REALTIME_EVENTS.md` — see §12 |
| App version | `package.json`, read via `VITE_APP_VERSION`. Never a literal in a component. **The Android `versionName` is the same value** — `android-release.yml` reads `user-panel/package.json` and refuses a tag that disagrees. It was a free-text run input, so an APK could be labelled one version while its bundle reported another; the `versionCode` is the run number, which only increases. |
| **Which Android build players run, where its file is, and which versions may no longer run** | `android_releases` via `database/repositories/androidReleases.js`. Package, version and signing key are READ FROM THE FILE (`domains/distribution/apkInspector.js`), never typed, and the signature is VERIFIED there, not just read: every v2/v3 signer's content digest and signature are checked and its certificate must be the signing key, so a tampered or re-signed APK is refused at upload rather than by phones (R7). What an install is told — required / available / current — is `updateStatus` in `domains/distribution/androidRelease.shared.js`, and the app carries no copy of it. Everything is PER PACKAGE (`ANDROID_PACKAGE_ID`) — a release of another package governs nothing an install would accept, and it is what lets the route suite run hermetically (it once shared the platform's package and a mutation run published a foreign-key row nobody could delete: trap 10, again). The newest MANDATORY published release is the floor. **A published release can be HALTED** (R9): it stops being offered, downloaded or required, but STAYS published, because phones may run it, so the publish guard and the upload's early check (`getHighestPublished`) still count it. **The policy is asked FOR a phone's Android** (`?sdk=`, from the plugin's `sdkLevel`): a release whose `minSdk` the phone lacks is never offered to it nor allowed to set its floor, and below a mandatory release it cannot install the answer is `unsupported`, never an update it could not complete. The API-level-to-Android words live in `androidLabel` alone. `SystemConfig.androidUrl` was removed: a hand-typed link beside an uploaded release is a second owner. Publishing is guarded in the UPDATE's WHERE under an advisory lock (S6) — BOTH the version floor and the signing key: the upload's key check is a read, and two drafts with different keys uploaded before anything was published both pass it. The web `minVersion` gate does not apply inside the APK — a reload cannot update code that is inside the package. |
| **Where the player app's logo and splash come from** | `user-panel/src/services/brandAssets.ts`. An admin-uploaded slot is fetched from the SERVER (`apiUrl`); the placeholder is the mark `scripts/generate-icons.mjs` generates into every build. It replaced three copies of the same logo resolver. The launcher icon and the Android launch screen are compiled in and cannot follow a runtime upload — that is Android, not a gap. |

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
  subscriber for an unlisted event never fires and never errors. **And an event
  the server SENDS that the list omits is delivered to nobody**: swept
  2026-10-01, the server sent the merchant eight names and the panel listed six.
  `order_paid` — a player's Paid tap — never reached the merchant's screen while
  the paid-response clock ran against them, and a moved UTR deadline went out as
  `order_updated`, a typo variant of `order_update`. Compare BOTH lists: every
  `emitMerchantUpdate`/`emitAllMerchantsUpdate` name against the panel's.
- A socket room nobody joins is a third: the merchant panel has no socket
  client, so `io.to('merchant-<id>')` reached nobody and a resolved dispute
  stayed DISPUTED on the merchant's screen. Merchant pushes go through
  `emitMerchantUpdate`.

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

### 17.1 Stay on latest, and keep upgrading cheap

Owner, 2026-09-25: *"every version should be latest current so we dont face
those version bump issues, and always upgrade version as much fast and as much
easily as possible in a way that we dont need to rewrite entire code."*

A dependency you never upgrade is not "stable" — it is untested against the
last two years of its own fixes, and the migration debt compounds silently
until a single bump is a rewrite. The rule is the opposite: **upgrade
continuously, so no single upgrade is ever large.**

1. **Latest is the target for everything.** Every runtime and every dependency
   — root, backend and all three panels — tracks the latest current release.
   "It still works" is not a reason to sit on an old major; falling behind IS
   the version-bump problem this section exists to prevent.
2. **Patch and minor: apply on sight, gated only by green.** Same-major bumps
   are applied and kept whenever the full gate + test suite passes against them.
   There is no waiting for a quarter and no held register for these.
2a. **Nothing merges a dependency PR automatically. A person does.** Owner,
   2026-09-30. Dependabot still OPENS the PRs (`.github/dependabot.yml`), which
   is what keeps rule 1 cheap; merging one is a human pressing the button on a
   green PR. The workflow that ran `gh pr merge --auto` on every patch and minor
   bump was deleted. What it cost was measured on PR #184: each auto-merge
   rewrote the same `package.json` files under an open branch. The branch
   conflicted, GitHub runs no `pull_request` workflow on a PR it cannot merge,
   and so CI never ran on #184 from 09-17 to 09-30. Two gates went red in that
   window and nobody saw them. Green on its own PR says nothing about the PRs
   it lands underneath. Do not reinstate auto-merge, and do not tick "enable
   auto-merge" on a Dependabot PR.
3. **A major is gated by the suite, not deferred.** Take the major, run every
   gate and every test tier, and keep it if it is green. A major is HELD only
   when adopting it would require rewriting working code (a removed API, a
   changed default that touches many call sites) — never merely because it is a
   major. A held major goes in the register below **with the exact reason and
   the rewrite it would force**, so the hold is a decision somebody can see and
   revisit, not a silence. "We're behind on X" with no register entry is the
   defect.
4. **Design so a bump touches one file, not many.** Where a third-party surface
   is volatile (a build tool's config shape, an SDK's client constructor, a
   crypto primitive), reach it through one thin adapter this repo owns, so the
   next major is edited in that adapter and nowhere else. `manualChunks` moving
   from an object to a function in one `vite.config.ts` is the shape to aim for;
   the same change spread across thirty imports is the shape to design out. §2's
   one-owner rule is the same rule pointed at an external dependency.
5. **A bump is not done until the SUITE says so, and the §31 table names what
   ran.** A build passing is not a bump verified — run `test:unit`, `test:pg`,
   the gates, and a build AND typecheck of every panel, and record the numbers
   (§29: absence of a failing check is not evidence). A bump reported on a green
   `npm install` alone is the shape §31 exists to catch.
6. **Re-measure the request path after a bump, do not assume.** S38 (a pure-JS
   crypto primitive capping the platform at 30 req/s) was invisible to every
   test that makes one request at a time and was found only by timing the
   primitive. A dependency you upgrade is a dependency whose hot-path cost you
   re-check, because a minor release can move it in either direction.

**Held-major register** (update in the same change that adopts or re-holds one,
§31.1). Each row names the packages held below their newest MAJOR and the
rewrite adopting it would force — the hold is per package AND per panel, because
the panels are not on the same versions (admin is on Tailwind 4; merchant and
user are on 3). A row leaves this table the moment its blocker is gone — an
entry that outlives its reason is §14's stale artifact. The bumped stable
versions this pass took (Express 5, React 19, Vite 8, vitest 5, socket.io 4.8,
and the rest) are NOT here: they were adopted and verified, not held.

| Package | Held on | At major | Why held — the rewrite adopting the newer major would force |
|---|---|---|---|
| typescript | all 3 panels | 5.x | 7.x is the native ("Corsa") port, still preview — 5.9 is the latest STABLE and is what the panels run; revisit when 7.x ships stable |
| tailwindcss | merchant, user | 3.x | v4's engine change is a stylesheet + config rewrite; admin already migrated, these two are authored against v3's `@tailwind` directives |
| recharts | admin | 2.x | v3 renamed the chart-component prop surface every analytics screen passes |
| framer-motion | admin, user | 11.x | v12+ renamed the package and moved the `motion` import path used across many components |
| @hookform/resolvers | admin | 3.x | v4+ changed the resolver signature every form wires to |
| date-fns | admin | 3.x | v4's `TZDate` change alters how the cycle-timing displays parse offsets |

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

### 19.1 Conservation is the database's, and it is immediate (owner, 2026-10-07)

The seventh item, added when the owner refused a periodic reconciliation: *"dont
run the supply checks each minute i want these live atomic so no double spend
could happen."* The guards, what was open before them, how they are checked and
what they cannot see are in §2's *Token conservation* row.

Three consequences are worth stating as rules, because each of them was a defect
found while closing this:

1. **A wallet, pool or treasury write says where the tokens came from or went,
   in the same transaction.** Bets, casino rounds, referral rewards and admin
   adjustments each moved a wallet with no treasury leg; `USER_FLOAT` drifted
   from the wallets it describes and could go negative. The counterparty is now
   a required argument of the writer (`wallets.core`), so a caller cannot
   forget it — and a test's own funding has one too
   (`database/tests/_funding.js`), or the fixture would be staging a state the
   platform cannot reach (§32 S16).
2. **One transaction, not two with compensation.** Deposit completion, sell
   settlement and the reversal of a settled sell were each a pool write
   followed by a wallet write, with a `catch` that tried to undo the first. In
   the window between them the tokens were in both places or in neither, and a
   crash left them there for good. Each is now one transaction that commits or
   does not (§21 is the same rule for state and fields).
3. **A refusal is an answer, not an error.** A guard that only exists as a
   CHECK hands the caller a constraint violation, which becomes a 500 and a
   sentence nobody can act on. So the writer asks first, under the row's own
   lock, and returns a reason the route can phrase (`account_short`,
   `pool_short`, `insufficient`) — with the CHECK behind it as the property of
   the row that no writer can skip. Both, not either (§32 S6 for why the ask
   has to be under the lock).

The bonus pools are the standing exception worth knowing: `grantBonus` and
`clawBackBonus` now move tokens from and to a named pool in one transaction,
but **nothing in production calls them and no path funds those pools**, so a
grant is refused with `pool_movement_failed` until an owner decides what funds
them. That is recorded rather than worked around.

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

    **A mutant that disables a CHECK leaves the row its own probe wrote**, and
    that row is the one the restored CHECK then refuses to be re-added over: the
    schema apply stops at that statement and every later suite on that database
    fails before its first test — reported NOT-MEASURED, which is honest, but it
    measured nothing (M261, 2026-10-01). A test that probes a CHECK by writing
    the forbidden value puts the row back in a `finally`.

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
3. **A name in a comment is not a reference.** `check:dead-code` blanks
   comments before it counts anything — exports, own-file uses, imports. It
   used to count text, and a false sentence kept a security control reported
   as live: `ipBlocker` was mounted nowhere, its writer had no caller and no
   screen could block an address, and the only things naming it were comments
   saying it "runs on every request". A commented-out
   `// import { UTRManager } …` counted as an import and kept an unmounted admin
   page, with its passing suite, off the report. Measured 2026-09-30: 0 DEAD
   became 16, and 0 test-only modules became 1. Every one was deleted rather
   than wired, because none of them was a feature anybody could reach (§30).

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
   `domains/merchant/merchantOrderView.js` and `domains/payment/playerOrderView.js`,
   and for a player's own wallet history `domains/wallet/playerLedgerView.js`
   (an admin adjustment is "Credited/Debited by support"; the admin's note and
   staff id stay in the audit trail, §32 S52).
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

**Step 2d (owner, 2026-10-03): where to pay, and no mobiles.** Every UPI_BANK
order (50,000, 100,000, 500,000) is paid by bank transfer, so the player is
shown the assigned member's account (holder, number, IFSC, bank) and the member
is shown the player's on a sell. The owner's condition was that *nobody* sees
another person's mobile number. Building it found three places one could
reach the other side, all fixed with tests: the accept route wrote the
member's UPI handle into the order timeline the player reads; an admin's
display name in a dispute message fell back to their mobile; and a merchant
created without a username was named after their mobile. Check 6 of
`check:player-privacy` fails if `PLAYER_PAY_TO_BANK_FIELDS` ever names a
contact detail. Payments banks (Paytm, Airtel, Jio, Fino, NSDL, India Post)
use the mobile number as the account number, so a member or player banking
there would show it as their account: such an account is refused by the row,
told apart by the IFSC's bank code, and so is an account number equal to the
holder's own mobile at any bank (a ten-digit Kotak account is not a phone
number and is allowed). On a cash buy the player pays the ATM's own QR, so
its payee is the bank's ATM handle; a QR whose handle is a mobile number is a
person's, and is refused.

The security review before the push found two more ways through. The NAMES on
an account travel with it, so a mobile typed into the holder's or the bank's
name reached the other side the same way: refused by the same CHECKs
(`bb_text_has_a_mobile`), and in a cash QR's name and note (`pn`, `tn`), which
the player's UPI app shows. And the spelling: an IFSC typed in lower case or
with a space, or a number written 0091…, slipped past the first version of the
rule; both are normalised before the comparison now (§32 S29).

**Accept before pay (security review, 2026-10-03).** The first build showed the
player where to pay as soon as the order was ASSIGNED. ASSIGNED is the state in
which the member may still decline and an admin may still move the order (the
reject route and the admin reassign both say so), so a player could pay member
A's account, A decline, and the order and its tokens go to member B while the
money sat with A. The player is now shown the account, the QR or the USDT
address only from PROCESSING, the member's accept; "I've paid" before it is
refused by name before the reference is claimed (so the player can still use
it); the cash scan waits for the accept too; and the Paid move names the member
the player was shown on every rail, not only cash. A buy the member never
accepted gave the player nothing to pay, so its lapse counts on the member
alone. The player's screen says "Waiting for the member to accept…".

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

**Step 2d (owner, 2026-10-02 and 2026-10-03).** The ₹40,000 payout leg went with
withdrawal splitting: one size, one order, one payment. A USDT buy is priced in
the USDT the player sends (100 to 10,000 in steps of 100, the bounds
admin-editable), and the tokens follow from the frozen rate; before 2d it was
one of three token sizes and the USDT figure followed, so a player could not
ask for a round USDT amount.

---

## 26. Team commission

Owner, 2026-10-02 (`PROJECT_STATUS.md` §3.10, built in 2e, 2026-10-04). Merchants
hold no tokens after 2c, so pay goes to the TEAM: 10% of each rise in the team's
matched volume, into its pool, with a recorded 16/84 split so each person sees
what they earned. It replaced the per-variety engine below, which was deleted in
2c; the lessons that carried over are rules 3 and 4 (the mark is the rows, never
partial).

- **Why instant, and why a sweep too.** The owner wanted commission the moment
  the match rises, "even by 500". The payment runs after the order's commit, so
  it can fail on its own (pool short, a database error); the mark moves only
  with a payment, so nothing is lost and the 5-minute sweep and every funding
  pay what is owed.
- **Why an advisory lock.** The pool balance is read and then spent, and two
  teams completing at once both read the same balance. Taking one lock before
  the read makes it a serialised write (S6, trap 18); the UNIQUE keys on
  `(team, from)` and `(team, to)` still refuse a second payment of one rise if
  the lock is ever removed.
- **Why the split is a record.** The tokens are the team's, in its pool; the
  shares say who earned them. Paise that do not divide go one each to the first
  members by id, so the record adds up to exactly what was paid.
- **A reversal claws nothing back.** A settled sell can still be disputed and
  cancelled, which lowers matched volume below the mark. What was paid stays
  paid; the mark does not move down, so the team earns nothing again until its
  matched volume passes the old mark, which recovers the difference.
- **USDT.** There is no USDT sell rail, so a USDT team's sells are 0 and its
  matched volume never rises: it earns no commission. The owner was asked
  (2026-10-04) whether USDT buys should earn anything instead.

### Before 2e: merchant commission paid per variety of work

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
| Neighbours | For a FIX: which invariant does it restore, which paths reach it, what is the opposite-behaviour test, and which of §37.1's pairs were tested or ruled out with a reason? |
| Gates | Which ones ran, and what did they PRINT (§29)? |

**Rows nobody fills in are where the defects were.** Of everything found in the
2026-09 review, not one was a wrong calculation. They were: a route no button
called, a button calling no route, a panel rendering a field the server never
sent, a server sending a field no panel read, two routes admitting different
things, and a message that blamed the player. Six of the ten rows the table
had then. The eleventh, **Neighbours**, was added after F-044 (§37).

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
| S36 | A projection whose MAPPER names a column the query never SELECTs | Read the column list, not the mapper. `toX` reading `row.foo` proves nothing; `foo` has to be in the `SELECT`. The field is `undefined` — no error, no type complaint, and the consumer takes the `undefined` branch. |
| S37 | A response STREAM behind middleware that BUFFERS it | Ask it as the client a browser actually is. `curl -N` sends no `Accept-Encoding` and every browser sends one — so the check everybody makes by hand is the one case that works. Does anything between the write and the socket hold bytes back? |
| S38 | A pure-JS crypto primitive on the REQUEST path | How many of these per second, on one thread? Time the primitive itself, not the endpoint. A signature check nobody has measured is a throughput ceiling nobody knows about, and it is invisible to every test that makes one request at a time. |
| S39 | A RELATIVE path inside the bundled native shell | Where does this resolve when the page is `https://localhost`? Inside the APK a relative URL reaches the files in the PACKAGE, not the server — so an admin's upload never appears, and nothing errors. |
| S35 | A caller's mistake thrown WITHOUT a `status`, so it leaves as a 5xx | Does the first thing this handler does with the input carry `status: 400`? `respondError` routes on the PRESENCE of `err.status` (§2), so a bare `TypeError` from a helper becomes "Something went wrong" — and the user is told the platform broke for a request that will never work. |
| S40 | An assertion that reads a key that does not exist, on BOTH sides | Is every number this assertion compares one you can see is finite? `Number(undefined)` is NaN, NaN minus anything is NaN, and vitest's `toBe` is `Object.is` — under which **NaN IS NaN**. The assertion passes for any value. `assertionGuards.setup.js` now refuses it in every vitest config; `toBeNaN()` states a genuine expectation. |
| S41 | A second debit BESIDE a hold that already paid | Is this money already reserved somewhere — a hold, an escrow, a settlement — whose completion IS the payment? Completing a hold spends it; debiting `available` as well charges twice. One movement, one owner. |
| S42 | "Not X" read as "therefore Y" | List every state the else-branch can actually be in. "Not HELD" was read as "already settled" while a withdrawal disputed before its merchant confirmed is neither — its stake is still locked. A branch on a status must name what it handles, not what it excludes. |
| S43 | A comment counted as a caller | Strip the comments. Does anything still NAME it? And is the thing that names it a real call, or a sentence saying there is one? A comment claiming code runs is the one reference no test can falsify. |
| S44 | A refusal that is PAINTED but not ANNOUNCED | Does the message carry `role="alert"`/`"status"` or sit in an `aria-live` region? The player app's toasts did neither, so every bet-card refusal was silent to a screen reader, and the browser drive, which reads the same roles, filed the bet button as doing nothing. |
| S45 | A key narrower than the thing it identifies | What makes two of these the SAME thing? If the unique key names fewer columns than that, two different things share one row: their totals MERGE, or — once somebody notices and adds an ownership check — the second one is REFUSED. Both are the key's fault. A provider's round id is shared by every player at a crash or live table, so `casino_rounds.round_id UNIQUE` first paid one player's rollback against another's stake, then refused every player after the first (F-044). Fix the key; never patch around it with a check after the read. |
| S46 | A client method that calls a real route and that NO SCREEN calls | `check:ui-coverage` sees the client's request resolve and counts it covered. Does anything in the panel NAME the method? `npm run report:routes` lists every one. Found when the (since removed) Aadhaar resubmission route, its service and `resubmitAadhaar()` all existed and a rejected player was told to contact support. |
| S47 | A figure from one WINDOW or POPULATION under a caption naming another | Read the caption, then the field: is "today" today, and is "bets" PLAYER bets? The dashboard's "Bets Today" showed the all-time count including the house's phantom bets. Give a test's two windows DIFFERENT values, or it cannot tell which one a tile reads. |
| S48 | One state, two redirects: "not signed in" and "not permitted" sent to the same place | Does a signed-in account that lacks an area land on a screen that says so? Every admin route guard sent it to `/login`, so a sub-admin following a link was asked to sign in again. 2026-10-04 (2g): the merchant panel did the same to a merchant suspended mid-session: the 403 "Account suspended. Contact support." cleared the session and reloaded at a bare sign-in form, and they learned why only after typing their password. `api.logout(reason)` now carries the server's words to that form (`role="alert"`). The admin panel's `verifySession` has the same shape and is not yet fixed. |
| S49 | Authority read off a row whose POPULATION nobody checked | The door scoped the login by `account_type`; did anything scope the FLAG? A check that reads `isAdmin`/`isQueueManager` off the session's row grants it to whatever row holds it. A grant route taking a typed id is how a player's row came to hold one. State it in the data, then refuse it at the route with a sentence the admin can act on. |
| S50 | A status nothing reads | Which reads, doors and session checks ask about this value? `DELETED` was written by the delete route and asked about by nothing: the login refused BLOCKED only, so a deleted player signed in as before. A terminal state is real only where every door and every session check refuses it. |
| S51 | A door that scopes the LOGIN and not the SESSION | The login checked `account_type`; does the middleware every later request passes through? A token is signed by the same key whichever door minted it. Send a staff and a merchant session to every player route, and a player's to every staff route. Measured 2026-10-01: a merchant's session read a player's order and a staff session opened a deposit, both 200. |
| S52 | A note written for the AUDIT, rendered to its SUBJECT | Who was this text written for? Follow the column to every screen that renders it. An admin adjustment's reason — `[Admin:<staff id>] <note>`, which the admin form says "is written to the audit log" — was the title of the entry on the PLAYER's wallet history. The player's projection is `playerLedgerView.js`; the admin's own screen keeps the note. |

**S36 shut the whole platform's front door, and it was one missing word.**
`IDENTITY_COLUMNS` in `database/repositories/telegram.js` listed thirteen
columns and not `audience` — while `toIdentity` mapped `audience: row.audience`
faithfully. So every identity the repository has ever returned carried
`audience: undefined`.

`membershipFor` takes its scope from exactly that field (§2 — the row's
audience is half its primary key and therefore the one true answer), got
`undefined`, and returned `unconfigured`. The gate turns that into
`no_channel` — the reason that renders as the PLATFORM's own fault WITH NO
BUTTON, deliberately (§33.3). **MEASURED on a live server with all three
channels active and all three actors linked and members: every player and
every merchant was blocked out of the entire app, permanently, with nothing on
the screen they could act on.**

Three things hid it, and each is worth naming:

- **No error anywhere.** A missing column in a `SELECT` is not a mistake in
  SQL; the mapper simply reads `undefined` off a row that never had the key.
- **Every tier below a browser was green.** The server's channel gate fails
  OPEN on an unconfigured platform (the 2026-09-17 owner decision), so every
  API test, every route test and the whole e2e suite kept passing while the
  SCREEN was blocked. The two halves fail in OPPOSITE directions.
- **The admin panel looked fine.** STAFF pass `no_channel` through the
  bootstrap exemption (§33.7), so the one person who could have noticed was the
  one person it did not affect.

What found it: a browser drive reporting **168 of 176 controls UNREACHABLE**,
every one `elementHandle.click: Timeout 4000ms exceeded`. Nothing was broken;
a modal was over everything, correctly. The question that gets there is §0.5's
first — *does anything CALL this* — pointed at a column rather than a function:
**does the query actually FETCH what the mapper reads.**

Swept (§0.15) across `database/repositories/**`: every other mapper field is
either in its own file's `SELECT` list or comes off a `SELECT *`
(`bonuses.core.js`, `casino.core.js`, `settlements.js`), and `wallets.core.js`'s
`row.type`/`row.reason`/`row.refId` read a CALLER's object, not a database row.
One instance, fixed, with a pg test that fails without it.

**S37 made every realtime stream on the platform silent in every browser, and
the server logged them all as sent.** `app.use(compression())` had no filter.
The `compressible` package says `text/*` is compressible, so `text/event-stream`
was compressed — and zlib holds its output until roughly 16 KB has accumulated
or somebody calls `res.flush()`. **Nothing on the SSE path calls it.**

MEASURED three ways on a running server:

| how it was asked | what came back |
|---|---|
| `curl -N` (no `Accept-Encoding`) | the `retry:` line and the cycle snapshot, instantly — a perfect stream |
| `curl -N -H 'Accept-Encoding: gzip'` | **10 bytes in 12 seconds** — a gzip header and no member |
| Chromium, `new EventSource('/api/sse/events')` | `readyState` 1, no error, and **zero events in 12 seconds** |

So the player's live pools, the merchant's new-order push and the admin's
dispute push were all dead in every browser, on every panel, for as long as
`compression()` has been mounted. After the fix, the same browser receives
`cycle_snapshot` and `cycle_history`, and 200 concurrent streams open with a
p50 first frame of 211 ms while `/api/v1/health` still answers in 153 ms.

Three things hid it, and each is the reason to write the shape down:

- **The way a person checks an SSE endpoint is the one case that works.**
  `curl -N` sends no `Accept-Encoding`; every browser sends one. The manual
  check and the real client differ in exactly the header that breaks it.
- **A silent stream is indistinguishable from an idle one.** No error, no
  status code, `readyState` OPEN. The browser drive cannot see it, because a
  stream with nothing to say looks the same.
- **`res.flushHeaders()` is right there in the code and is a different thing.**
  It flushes the HEADERS. The body sat in zlib.

The fix is the compression FILTER, not a `res.flush()` after each write: there
are five write sites, and adding a flush to each is §21's shape exactly — a
second thing the author must remember, absent on the sixth. Swept (§0.15) for
the shape across the whole backend: the only incrementally written HTTP
responses are the SSE ones (`sseManager.service.js` and `sse.routes.js`, both
covered by the one filter); `backup.service.js`'s stream is an upload to S3,
not a response. One instance, one place, fixed.

**S38 capped this platform at 30 authenticated requests a second, and every
tier was green.** Token verification ran on tweetnacl's pure-JS Ed25519.
MEASURED, 1,000 verifications of a real token on this container:

| | per verification | per thread |
|---|---|---|
| tweetnacl (pure JS) | **39.3 ms** | 25/sec |
| `node:crypto` (native) | **0.16 ms** | ~6,300/sec |

39 ms of single-threaded CPU **per authenticated request, before any handler
ran.** It is why every authenticated ramp saturated at the same place while the
anonymous one did not — and the three numbers say it better than any argument:

| mix | before | after |
|---|---|---|
| public (no token) | 305 req/s | 305 req/s |
| player | 33 req/s | **588 req/s** |
| merchant | 35 req/s | **536 req/s** |
| admin | 31 req/s | **682 req/s** |

The wire format did not change — same `v2.public.`, same Ed25519 over the same
PAE encoding, same keys derived the same way — and that was VERIFIED in both
directions: a token signed by the old code verifies under the new one, and
tweetnacl verifies a token the new code signed. tweetnacl stays for the key
derivation so the key material and the rotation list are byte-for-byte what
they were; only sign and verify moved.

Why nothing caught it: every route test, every e2e scenario and every browser
pass makes requests ONE AT A TIME, where 39 ms is invisible. A load test is the
only tier that can see a per-request CPU cost, and until this session there were
no load numbers at all — only the harnesses, never run (§29: absence of a
failing check is not evidence when no check covers the claim).

**The same pass found the other half of the ceiling in one index.**
`/api/v1/winners` — public, unauthenticated, on the player home screen —
answered in **200 ms while every other public path answered in 2–4 ms**, and it
held the whole public mix at ~40 req/s by itself. `realWinners` asks for WON
bets settled in the last N hours ordered by payout, and nothing served it: a
Parallel Seq Scan of every bet ever placed. One partial index
(`bets_recent_winners_idx`) took the query from 171 ms to 40 ms, the endpoint
from 200 ms to 24 ms, and the public mix from ~40 to **305 req/s**.

And the admin leaderboard, on the 10-minute cron, was aggregating 2,000,000
bets with a `LEFT JOIN users` INSIDE the aggregate: a HashAggregate spilling
**126 MB to disk in 65 batches**, 2875 ms. Aggregating first and joining the
fifty survivors is the same result — `user_id` is the users PK, so the username
can only widen the group key, never split a group — and it parallelises: 1284 ms,
no spill.

**What the load pass does NOT say.** The client and the server share four cores
here, so every figure above is a FLOOR on a real deployment's ceiling, never a
capacity number. What IS transferable is the shape: after these three changes
the authenticated paths saturate on CPU at ~500–680 req/s per process with
p95 under 320 ms at 100 concurrent clients, the player-facing repository calls
are all under 100 ms at p95 (most under 3 ms) against 100,000 players and
2,000,000 bets, and what remains over 250 ms is admin analytics — full-table
aggregates on screens a handful of operators read.

**S39 hid every admin logo from the Android app, and the loading screen of
every install showed a broken image.** Screens wrote `/app-assets/logo.png`.
On the web that reaches the server, which serves the admin's upload; inside the
APK the page is `https://localhost`, so the same string reached the files
bundled INTO the package — where no `logo.png` exists — and the fallback,
`/logo.png`, did not exist either. Nothing threw, no test failed (jsdom resolves
relative paths against whatever it is told), and the web was fine. The admin's
`splash.png` slot was worse: nothing read it at all (S5). One helper now says
which images come from the server and which ship in the build
(`brandAssets.ts`). Swept (§0.15) across `user-panel/src`: one sibling —
`getAssetUrl`'s no-CDN fallback returned a relative path; it now goes through
`apiUrl` (latent in production, where uploads are absolute CDN URLs). The
download links already used `apiUrl`, and the bundled `/app-assets/icon-*.png`
are meant to be local.

**S41 destroyed the order's worth of tokens on every buy a merchant confirmed,
and S40 is why nobody saw it** (F-026, 2026-09-30). Every buy HOLDS the
merchant's tokens at attachment (`available → reserved`). The confirm route
then dispensed that hold — `complete` SPENDS it, `reserved −a` — and
`moveDepositMoney` debited `available −a` as well, on the belief that
dispensing put the tokens back in `available` first. MEASURED: a 1,000-token buy
cost the merchant 200,000 paise while the player received 100,000, and a
merchant whose tokens were all held for the order was refused ("insufficient
token inventory") after the hold was already spent, forever. The suite that
should have caught it asserted `after.availablePaise` and `after.reservedPaise`
— keys the balance object does not have — so both lines compared NaN with NaN
and passed for any balance. The fix is one owner (`moveDepositMoney` takes the
merchant side once, from the hold, via `dispenseForOrder`), and one gate
(`backend/tests/assertionGuards.setup.js`, loaded by all three vitest configs,
refuses a NaN-versus-NaN `toBe`/`toEqual`/`toStrictEqual`). Swept: with the
guard on, all 2,471 unit/pg/redis tests pass — those two lines were the only
instances.

**S42 was ten wrong cells out of eleven** (F-027). Three admin routes end a
withdrawal, and each read the money's position its own way: "not HELD" taken as
"already settled", a release that only cleared a flag, a refund credited beside
a lock that stayed. `withdrawalHold.endWithdrawal` now names all three positions
(not yet confirmed, HELD, settled) and every route calls it. The question that
finds S42 is mechanical to ask and was never asked: *what is actually in the
else-branch?*

**S45 was wrong in both directions, one fix apart** (F-044, 2026-10-01).
`casino_rounds.round_id` was UNIQUE on its own, so a provider round was one row
whoever staked on it. Every crash round and live table has many players on ONE
round id, so their callbacks MERGED: a rollback naming player B was bounded by,
and paid against, the stake player A had placed. F-043 saw the merge and added
an ownership check: a callback on a round owned by another player or provider
is refused. That closed the leak and refused every LEGITIMATE second player at
the table, and any second provider numbering its rounds from 1. The suite even
asserted it ("refuses a BET by another player onto an existing round"), and
every tier was green, because no provider is configured and so nothing
multiplayer has ever called the webhook. The key was the defect both times.
Keyed `(provider_key, user_id, round_id)`, each stake is its own row, the
ownership checks are unreachable by construction and are gone, and "a WIN needs
this player's own bet" is asked of the only row it could be about. **Before
adding a check that a row belongs to the caller, ask whether the caller should
have been able to reach that row at all.**

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

**S35 was found by getting a request body wrong.** `assertBuyIsLegal` passes its
argument straight to `rupeesToPaise`, which throws a bare `TypeError` on a NaN
— no `status`, so `respondError` routes it to `serverError`, which logs in full
and answers with nothing by design. MEASURED: a deposit with the amount under
any key but `tokenAmount` answered **500 "Something went wrong. Please try
again."** Every other refusal on that path is a 400 that names what to do
instead, exactly as §25 requires, and this one case skipped all of them.

**Swept (§0.15), and the result recorded: the sell and bet paths do NOT have
it.** Both reach `assertPositiveNumber`, which throws through `reject()` and so
carries `status: 400` — measured, a withdrawal with no amount answers *"400
Withdrawal amount must be a number."* The buy path was the only one, because
`assertBuyIsLegal` runs BEFORE `validateTokenPurchase` and reached
`rupeesToPaise` first. **The question is not "is the input validated" but
"which check gets there first, and does IT carry a status".**

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

### 33.0 Step 3 (owner, 2026-10-07) replaced 33.2, 33.3 and 33.7 below

Kept below as history; the rules are CLAUDE.md §33. The owner's words: "they
must verify and share contact on signup ... now they can do login without
telegram mini app but add also login with telegram button too", with the
answers: forgot password by sharing the Telegram contact in the Mini App (no
admin reset); 2FA is Telegram only, required for staff and merchants; delete
the sign-in fleet, rotation, recovery bots and templates and keep one Mini App
bot; drop the must-join-channel gate; keep security alerts for staff who linked
Telegram.

Why one bot is enough now: a bot no longer converses or signs anybody in by
itself. It signs `initData` and contacts the Mini App sends back, and the
server proves each one. Telegram suspending it costs a token swap in the admin
panel (`PUT /api/admin/telegram/bot`); links survive because they key on the
person's Telegram id, not the bot. Why the Mini App and not the Login Widget:
the widget serves one domain per bot, and three panels plus the app are not one
domain. Why staff keep the password with "Login with Telegram": a stolen or
borrowed phone must not be a staff session on its own.

Found while building it (2026-10-08): the staff security alerts posted through
`activeConfig`, which the channel removal deleted; the import failed inside a
catch and every alert went nowhere. And the referral report lost an import in
the same pass, caught by `check:orphans`.

**2026-10-08, the owner: "merchant and staff dont need captcha they will only
need 2FA".** The captcha stays on the player's signup and sign-in, the one door
with no Telegram approval behind a correct password. Staff and merchant panels
never sent a captcha token, so with Turnstile keyed their sign-in would have
been refused outright; now their door asks only for the password and then the
Telegram approval. The pace, the failure budget and the subnet limiter stay on
every door (`loginDoors.js`; `test:captcha-doors` checks both directions).

**2026-10-08, the reset is finished inside the Mini App, for every panel.**
Building the staff and merchant screens found that the reset LINK the Mini App
minted for them (`<panel>/#/reset/<token>`) opened a page only the player app
had: a merchant or admin who forgot their password was handed a dead link. The
person is already in the Mini App holding the proof, so the password is typed
there and set in the transaction that spends the proof; the token, its table
(`password_resets`), `POST /api/v1/auth/password/reset`, the player app's reset
page and the per-panel origins (`ADMIN_PANEL_ORIGIN`, `MERCHANT_PANEL_ORIGIN`)
went with it. One change in order: the password is now checked BEFORE the
proof is spent (it used to be after the token was consumed). That ordering was
right for a bearer token an attacker could replay against the policy; a Mini
App proof is single-use whatever the answer, and spending it on a refused
password would cost a real person the page they are on and buy an attacker
nothing. 33.6 below is kept as history.

Also found then: `telegram.sweepExpired` and `identity.sweepExpired` each said
a cron ran them, and nothing scheduled either, so every Mini App action left a
claimed-proof row forever (§32 S5). Both now run hourly as `credential-sweep`.

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

- **The signup form** takes the mobile on the player's Telegram account, a
  password, a confirmation, a captcha, and an invite code. There is no
  Aadhaar field: KYC was removed (owner, 2026-10-02), and the contact share
  is the only proof of identity the platform asks for. The invite code is
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
| `IDENTITY_COLUMNS` | mapped `audience` and never SELECTed it, so every identity read carried `audience: undefined` | `membershipFor` scoped on `undefined` and answered `unconfigured`, so the gate showed every player and merchant `no_channel` — the no-button reason — on a fully configured platform. §32 S36 |
| `test:e2e` | asked whether SOMETHING answered on its port | a server already on 8099 answered, the runner's own spawn never bound, and the suite seeded one database while asserting against another: 26 failures, every one true of the server being asked and false of the platform. §32 S33 |

A fifth was mine and caught in the same session: a tidy `if (!identity) return`
placed ABOVE the config read reversed the order of two questions, so every
unlinked player on an unconfigured platform was refused "link your Telegram
account" — an instruction naming a bot that does not exist. **56 pg failures,
every deposit and withdrawal route among them.** §32 S34.

---

## 34. `BB_RATE_LIMIT_RELAX` — a test facility, never a production setting

Added 2026-09-24, removed 2026-09-25 when it was believed to be temporary, and
restored 2026-09-30 at the owner's request as a standing facility for test
runs. It lives in `backend/config/security.config.js`.

**What it is.** `BB_RATE_LIMIT_RELAX=<n>` multiplies every `RATE_LIMIT_TIERS`
count by `n`. **Windows are untouched**: only the counts move, so the shape of
every limiter, and therefore what each one is for, is unchanged. It does not
touch a limiter's window, key, mount or `skipSuccessfulRequests`, so §32 S13,
S27 and S28 are unaffected by it.

**Why it exists.** A whole-stack browser pass presses about 1,300 controls
across 67 screens. The global backstop is 1,000 requests per 15 minutes, so
without it the pass spends hours waiting for windows to roll over instead of
pressing anything. Production behaviour must not be weakened to make a test
fast (§29), so the development server that pass runs against is relaxed, not
the limiter.

**The four guards, each verified by running it:**

| | proven by running it |
|---|---|
| Defaults to 1 | unset: `global` 1000, `auth` 4, `loginPace` 1, the committed numbers |
| Refused in production | `NODE_ENV=production BB_RATE_LIMIT_RELAX=50` does not boot: *"a test facility and is refused in production"* |
| Refuses nonsense | `BB_RATE_LIMIT_RELAX=nope`: *"must be a number >= 1"* |
| Pinned OFF where limits are asserted | every vitest config sets it to 1 in `test.env`, and `backend/tests/e2e/run.js` sets it to 1 in the server it spawns. With `200` in the shell: the limiter suites still pass (5/5, 19/19) and the pen test still sees the login limiter trip on the second attempt |

It prints a three-line warning at boot whenever it is above 1, because an
exemption nobody can see is a hole nobody removes (§33.7).

**How it must be used.** Set it in the environment of a DEVELOPMENT server
that a throughput-bound pass (`test:browser`, `test:drive`, `test:mutate`,
`test:forms`) runs against. Never in a committed env file, a Dockerfile, a CI
job or a deploy manifest. Finding it in one of those is the defect this
section exists to catch. Never set it on a server whose purpose is to measure
the limits: the pen test (`s8-pentest.js`) and the limiter suites are exactly
what it would make lie, which is why they pin it off themselves rather than
trusting the caller.

---

## 35. Coverage is a set of DIFFERENT claims. Never add them up.

Owner, 2026-09-24, correcting a session that was drifting: *"Don't let the
percentage become the goal."*

**The objective is: every meaningful behaviour has an appropriate test, or an
explicit reason why it cannot or should not have one.** It is not "get the
number to 100%".

The difference is not pedantic, and this session produced both mistakes inside
an hour:

- An `alert()` was reclassified from NEEDS_INPUT to SAID. That is a CORRECT
  reading of what happened — an alert tells, it does not ask — and it is **not
  equivalent to testing a mutation.** Nothing about the platform's state was
  proven by it.
- A button correctly disabled was counted as covered. A disabled control is
  **correct state**, and says nothing whatever about whether the feature
  behind it works.

Both were then folded into one `EXERCISED` bucket and divided by the total,
which produced a percentage that answers no question anybody has.

### 35.1 The categories, and what each one actually claims

| Kind | The claim | What it is NOT |
|---|---|---|
| **MUTATION** | state changed, asserted against the database, with a BYSTANDER row checked | not "the screen changed" — only `npm run test:mutate` can make this claim |
| **SCREEN_MOVED** | the press moved the routed region | not proof anything was written; a render is not a commit |
| **ANSWERED** | it called a route and the server answered, including a refusal that names what to fix | not a state change |
| **SAID** | the panel answered with an `alert()` — an informational outcome | **not evidence of a mutation** |
| **NO_OP_BY_DESIGN** | nothing should have happened and nothing did | not coverage of anything else |
| **INERT** | changed nothing AND called nothing — §32 S22 candidate | triage, read the list; never counted as pass or fail |
| **DISABLED** | correct STATE on arrival | the ENABLE transition is a separate test, and a separate row |
| **REPEAT** | a repeat of a name already pressed on this screen | an ASSUMPTION — true only if the first instance is representative. Row 40's button carries row 40's id |
| **DRIVEN_ELSEWHERE** | a mutating case exists for it | a POINTER, not a proof. Read that pass's output; a deferral whose case does not exist is unpressed with a reason |
| **NOT_REACHED** | not pressed, and not by choice | the honest number, and the only one worth driving down |

### 35.2 What the report must therefore do

`npm run report:controls` prints **one line per kind and no summed headline**,
and says in the table itself that state changes are not counted there. A
verdict belonging to no kind is printed as `UNCLASSIFIED` rather than
disappearing — a category nobody assigned is a number nobody checked.

**A large count is a question, not an achievement.** `REPEAT` at 574 (45%)
asks whether one instance really stands for fifty; `SAID` at 0 on a screen
full of informational paths asks whether anything was read at all.

### 35.3 Stated as a rule for the next change

Before reporting any control, feature or path as covered, name **which kind of
evidence** you have. If the honest answer is "it rendered" or "it was
correctly disabled" or "something else probably covers it", say that — those
are real and useful findings and they are not the same as "it works".

§29 already says a readiness claim is a claim about evidence. This is the same
rule pointed at coverage: **a percentage is not evidence, it is an average of
things that were never the same kind of claim.**

---

## 36. Horizontal scale is a config contract, not a code change

The app runs as N identical stateless processes behind a load balancer, and
everything that must be single-execution or cross-instance is already wired.
MEASURED 2026-09-25: two instances (8201/8202) against one database with
`REDIS_URL` set, plus a full authorized pen test of the live stack.

**What holds across instances, proven by running it:**

| Concern | Mechanism | Proof |
|---|---|---|
| Cron single-execution | `cron_locks` leader lock, one row per job, lease-expiring | 14 jobs, each held by exactly ONE of three instance ids |
| Settlement not double-run | `claimSettleable` `UPDATE … WHERE … FOR UPDATE SKIP LOCKED` + lease | 10 cycles settled with two engines live: 0 bets paid twice, 0 left unsettled |
| socket.io fan-out | `@socket.io/redis-adapter` (`realtimeBridge.js`) | a bet on 8202 reached an admin socket on 8201 |
| SSE fan-out | `SSEManager.attachRedis` Redis relay | same bridge |
| Rate-limit store | shared store when Redis is set | cross-instance, not per-process |
| Double-spend | `SELECT … FOR UPDATE` on the wallet row (§19) | 8×₹200 racing on a ₹1000 wallet → exactly 5 landed |

**The three things an operator MUST set, or the platform silently degrades:**

1. **`REDIS_URL`.** Without it every relay and the leader lock fall back to
   single-instance. Two instances with no Redis is TWO settlement engines with
   only the database lease between them — the lease still prevents double-pay
   (proven), but realtime does not cross instances. Multi-instance REQUIRES
   Redis.
2. **`TRUST_PROXY`.** Fails closed (`network.config.js`): unset, `req.ip` is the
   socket peer, which behind a load balancer is the BALANCER — so every user
   shares one rate-limit bucket. Set it to the proxy hop count (e.g. `1` behind
   one LB/Caddy). Failing closed is the right default — a spoofed
   `X-Forwarded-For` cannot forge an identity when ignored (MEASURED) — but it
   is WRONG left unset in production behind a proxy. **Enforced since
   2026-09-30:** production refuses to boot with `TRUST_PROXY` unset. `false` is
   a valid answer and silence is not, because only the operator knows whether
   a proxy is in front (`validateEnv.js`).
3. **`TURNSTILE_SECRET_KEY`.** Unset, the captcha on signup and login passes
   everything. Production refuses to boot without it unless
   `ALLOW_NO_CAPTCHA=true` states that running without one is intended: the
   same explicit-risk pattern as `ALLOW_INSECURE_PG_TLS`. A setting whose
   forgotten default is a hole is made a stated decision, not a default.

**Pen test, 2026-09-25 — authorized, pre-deployment, against the local stack.
Every finding VERIFIED live, in both directions where a gate was involved.**

| Class | Probe | Result |
|---|---|---|
| Dependency audit | `npm audit` | 1 moderate, `colord`, dev-only; no runtime advisory |
| Committed secrets | `git grep` + env templates | none |
| IDOR player↔player | A's token on B's bets/data/transactions/profile/bank-details | all 403, victim unchanged |
| Cross-panel escalation | player→admin, player→merchant, merchant→admin | all 403 |
| IDOR merchant↔merchant | A confirms/rejects/red-flags/CDMs B's order | all 404 (trap 16), order byte-identical |
| Token self-promotion | validly-signed player token with `isAdmin:true` forged in | 403 — authz reads the DB row, not the claim (F-001) |
| Token integrity | tampered / garbage / empty / ghost-user | 401,401,401,404 |
| Bad-amount abuse | negative, zero, fractional, NaN, over-balance, 1e9, 1e-3 | every one 400, named reason |
| Double-spend race | 8×₹200 concurrent on a ₹1000 wallet | 5 landed, ₹1000 staked, no overspend |
| SQL injection | OR-1=1, DROP TABLE, UNION SELECT password_hash in admin search | blocked; users table intact 628→628 |
| Stored XSS | `<script>` into username | 400; field validates; React escapes on render |
| Security headers | CSP, HSTS, X-Frame, nosniff, no X-Powered-By | present |
| CORS | Origin evil.example.com + credentials | dev reflects (NODE_ENV-guarded); production REJECTS (verified both ways) |

No HIGH or CRITICAL finding survived verification. The one code defect found
this pass was not a security hole: the player bet-history list reported every
bet's board as `null` (§32 S4) — fixed, with a pg test that fails without it.

**What the pen test did NOT and COULD NOT cover, named per §29:** a real
Turnstile round trip (no secret in the repo), a real Telegram bot (every token
answered Unauthorized, correctly), real bank/UPI/USDT rails, and anything
needing the platform actually deployed with TLS and a real proxy in front.

**The pen test is a scenario now, and it re-runs.** The 09-25 probes were
typed by hand and never committed, so the next change could re-open any of
them and nothing would notice. `backend/tests/e2e/scenarios/s8-pentest.js` runs
them, and the 09-30 additions, on every `npm run test:e2e` (`node
backend/tests/e2e/run.js s8` alone). Every probe that could move money or
change an account asserts the DATABASE before and after, not only the status.
A probe that could not reach the thing it tests is recorded as a NOTE saying
so, never as a pass (§32 S8): on a server with no casino provider configured,
the callback probes stop at 404 before any signature is checked.

**Full-codebase security sweep, 2026-09-30.** Found and fixed:

| Finding | Severity | Fix | Proof |
|---|---|---|---|
| A signed casino BET debited whichever player the payload named, with no session that player opened. Betby's launch token was unsigned base64 JSON; Pragmatic's was `md5(userId+secret)`, permanent | HIGH once a provider is live (none is configured) | BET requires the player's own live session with that provider; both tokens are now the random per-session id | casinoSessionBindingPg 8 cases, M157 |
| GCM decryption accepted a truncated tag (identity data, 2FA secrets): 2^32 forgery, not 2^128 | LOW (needs DB write) | `authTagLength: 16` pinned | 2 unit cases, M158, M159 |
| 28 admin-API methods shipped in the player bundle, one inventing a password client-side | LOW (server authorises every route) | deleted; `/admin/` paths in the player bundle 4 → 0 | tsc, 198 tests, bundle grep |
| `uuid` < 11.1.1 via Capacitor's iOS tooling (Dependabot alert #32) | MODERATE, dev-only | npm `overrides` scoped to `xcode` | npm audit 0 in all 4 lockfiles |
| The SQL audit gate saw 408 of 465 call sites | gate defect | classifies every call site | map 150/466, each new site read |

Checked and clean: all 4 lockfiles audit at 0 (dev included) and pass
`npm audit signatures`; gitleaks over all 788 commits and the tree found only
test fixtures and placeholders; the 42 unauthenticated routes (44 since 2026-09-30: `GET /api/app/android/update` and `GET /api/download/android`, both read-only public projections, read), both profile
routes (explicit allowlists), the phantom-bet gate, both Telegram webhooks and
the CSV export were read. semgrep (OWASP, node, react, jwt, typescript
rulesets; 458 files) raised 23 findings: the three above and 20 false
positives, each read. Not covered: the same four items listed above, plus
semgrep only partially parsed 9 TSX files (a bare `&` in JSX text).

---

## 37. A fix is proven against its NEIGHBOURS, not only against its own test

Owner, 2026-10-01, after the verification of PR #198: *"Prove that each
important fix addresses the underlying invariant and doesn't break adjacent
execution paths."*

**The problem this exists to stop.** Every fix in this repository already ends
in a failing-first test, a mutation and a green suite. F-043 had all three, and
it was still wrong. A provider's round id was unique on its own, so two players
on one crash round MERGED into one row. The fix added "refuse a callback on a
round another player owns", which closed the leak. It also refused every
legitimate second player at the table, and its own test wrote that down as
correct: *"refuses a BET by another player onto an existing round"*. B2 had the
same problem twice: the IP block covered HTTP but not the socket.io upgrade
(F-045), and its /16 floor judged how a range was WRITTEN, not what it covered
(F-046). In all three, the question in front of the fix was answered correctly.
The question next to it was never asked.

So this sequence stops too early:

```
find bug → fix bug → add regression test → tests green
```

For money, game, verification and security code, a fix goes through all of these:

| # | Step | What it means here | What it would have caught |
|---|---|---|---|
| 1 | Find the bug | Reproduce it FAILING first, against a real database (§1) | — |
| 2 | Understand the root cause | Name the INVARIANT that broke, not the line that misbehaved. §0.5 question 4: symptom or cause? | F-044: the invariant was "a round is one player's stake", and the key said otherwise |
| 3 | Identify every caller, path and state | Every route, worker, transport, retry and state that reaches this code. S32: which OTHER path gets here without the check? | F-045: socket.io reaches the server before Express |
| 4 | Fix the underlying invariant | Fix the key, the owner or the constraint. Do not add a check after the read (S45). A check layered on a wrong key turns one defect into another | F-044: the ownership check traded a leak for a lock-out |
| 5 | Add the regression test | The one that failed in step 1 now passes | — |
| 6 | Test the opposite behaviour | A fix that REFUSES something needs a test that the LEGITIMATE case still SUCCEEDS. A fix that ALLOWS something needs a test that the illegitimate case is still refused | F-043 tested the refusal only. "A second player with a valid session bets on the same round" was never run |
| 7 | Test the neighbouring scenarios | The pairs below: the closest variation where this fix would be wrong | F-044, F-045, F-046, all three |
| 8 | Mutation test | Break the fix on purpose and see a test fail (`scripts/mutation-check.mjs`). Cover the neighbour tests too, not only the regression test | — |
| 9 | Database / integration test | Through the real database and the real transport, never a mock of the boundary that carries money (§1) | F-045 needed a real socket.io server behind the real trust-proxy setting |
| 10 | Search for alternate paths around the fix | Can the same effect be reached another way: another spelling, another route, another transport, an older row? | F-046: `::ffff:10.0.0.0/104` is 10.0.0.0/8 spelled differently |
| 11 | Run the complete gates | Every tier and every gate, with the numbers printed (§29, §31) | — |
| 12 | Independent review | A second pass by someone who did NOT write the fix: a separate session or the owner. Until then the PR says *"not independently reviewed"* | PR #199's review is what found all three |

### 37.1 The question to ask of every fix

> **What is the closest scenario where this fix would accidentally be wrong?**

Answer it by walking these pairs and testing EVERY one that applies. Each pair
is a place where a defect here has already hidden, or nearly did:

| Pair | Ask |
|---|---|
| Single-player / multi-player | Can more than one person share the thing this keys on: a round, a table, a link, a pool? |
| Same user / different user | Does the fix still let the owner in and keep the stranger out, on the same row? |
| Same provider / different provider | Can two external systems use the same id for different things? |
| HTTP / WebSocket (and SSE, cron, webhook) | Which transports reach this state? Is the check on all of them? |
| IPv4 / IPv6, and every other spelling of one value | Is the input judged by what it MEANS, or by how it is written? (S29, F-046) |
| New database / existing database | Does the schema change converge on a database that already has rows (S31)? |
| First request / concurrent request | Is the guard a write the database serialises, or a read (S6, trap 18)? |
| Success / partial failure | If it fails halfway, what does the row say (S7, §21)? |
| Retry / duplicate request | Does a redelivery do the work twice, or refuse a legitimate retry? |

A pair that does not apply is written down as not applying, **with the reason**
(§31's n/a). A pair skipped in silence is the one that ships.

### 37.2 What "done" now requires

A fix in money, game, verification or security code is reported as done only
when the §31 table's **Neighbours** row names:

- the invariant it restores (step 2),
- the paths it found (step 3),
- the opposite-behaviour test (step 6),
- the pairs it tested and the ones it ruled out, with reasons (§37.1).

"Tests green" is not on that list. F-043 was green.

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
| `npm run check:staff-permissions` | Every staff route asks for an AREA an admin can grant (read off the live route stacks); full-admin-only routes are the listed, reasoned few; the admin panel names the same keys; and every gated SCREEN calls only its own area's routes or asks `can()` for the other one. |
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
| `npm run test:captcha-doors` | **Which doors challenge and which must not** (player signup and sign-in do; staff sign-in, merchant sign-in and merchant signup must not, owner 2026-10-08), against a server started with `TURNSTILE_SECRET_KEY` set. It refuses to report at all if the captcha is not switched on for that server, because then every door would read as unprotected and none of them would be. It does NOT prove a real Cloudflare challenge is solved — that needs a live key and a browser, and there is no Turnstile secret in this repository. |
| `npm run test:drive` | **Every control on every screen, pressed.** Reports THREW, 5xx, or INERT — a control that left the screen byte-identical. Inert is triage, not failure: read the list. By default it presses as the three default accounts; `BB_PROFILE=<name>` presses that profile's one panel AS that account (seeded as the inventory seeds it) and writes `drive.report.<name>.json`, leaving the default report alone. |
| `npm run report:controls` | Writes `docs/reference/PANEL_CONTROL_COVERAGE.md` from the control inventory and the drive report — per panel, per screen, per control. It prints BOTH artefacts' timestamps, so a table built from a stale half says so rather than reading as current. |
| `npm run report:workflows` | Writes `docs/reference/E2E_WORKFLOWS.md` — every end-to-end check, grouped by rail, with the actor whose screen would show it and what the platform actually answered. |
| `npm run check:cors-headers` | Every header a panel SENDS is one CORS allows. A header the server has not agreed to is never sent — the browser cancels the request, so there is no status code and no log line for anything below a browser to see. |
| `npm run test:bet-button` | The bet card, pressed in a browser, cross-origin — the pass that found the CORS block. |
| `npm run test:operations -- --cron --restore --sse` | **The operational half of readiness, and it is three different claims (§35).** `--cron` runs every one of the 14 recurring jobs and, for the six whose trigger row can be seeded, asserts that row MOVED — the other eight are reported as RAN, which is weaker and says so. `--restore` dumps, destroys and restores through the platform's OWN `dumpToFile`/`restoreFromFile`, then checks every table's row count AND that the ledger still conserves in the restored copy. `--sse` holds N real streams open and asks whether the server is still serving — the pass that found S37. |
| `npm run loadtest:scale -- --seed --queries` | **What the platform does when it is BIG.** Seeds a 100k-player database with millions of bets, orders and ledger events, then times the REAL repository calls the panels make against it (never a copied SQL string) and names every table being sequentially scanned. Refuses to run against any database but `bb_load`. |
| `npm run test:mutate` | **Every control that CHANGES something, pressed against rows the run seeded.** Each case asserts the DATABASE and a BYSTANDER beside the target, and puts back anything platform-wide in a `finally`. Wants its own database (`bb_drive`) and a backend on it. |
| `npm run report:routes` | **Which routes any test tier actually REACHED** — never reached, only ever refused, reached only in-process — and the client methods no screen calls (S46). Reads the hits each tier recorded with `BB_ROUTE_COVERAGE=<dir>/<tier>.jsonl`; the real server writes the route inventory at boot. Writes `docs/reference/ROUTE_COVERAGE.md`. |
| `npm run report:control-gaps` | **Controls that exist only for some account or state**, which the drive (pressing as the default accounts) has therefore never pressed. Run `BB_PROFILE=<name> npm run test:browser` per profile in `backend/tests/browser/profiles.js`, and `BB_VIEWPORT=phone`. Where a profile was also driven as itself (`BB_PROFILE=<name> npm run test:drive`), its only-here controls are classified by the §35 kind that press produced, kinds kept apart. Writes `docs/reference/CONTROL_COVERAGE_BY_ACCOUNT.md`. |
| `npm run test:ghost-mode` | GHOST MODE pressed as a phantom agent, ON and OFF, against the bet rows and the wallet. |
