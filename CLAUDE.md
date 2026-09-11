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
| SLOs, runbooks, on-call | `docs/reference/SRE_AND_OPERATIONS.md` |
| Branding field → consumer table | `docs/reference/BRANDING.md` |
| Machine-checked capability registry | `platform/capabilities.yaml` (`npm run verify:capabilities`) |
| What has been security-audited, and what has not | `docs/audit/SECURITY_AUDIT_MAP.md` (`npm run audit:map`) |
| **How this audit keeps missing things, and the four questions that find them** | `docs/audit/SECURITY_AUDIT_MAP.md` **§0.5 — read before trusting a green check** |
| **Every defect SHAPE found so far, how wide you must search to see it, and what actually found it** | `docs/audit/SECURITY_AUDIT_MAP.md` **§4.0 — the shape index. Read it before auditing anything.** |

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
13. **If it fixes a vulnerability, sweep for the same SHAPE across the whole
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
| Who may be given a CASH order | The claim query in `database/repositories/cashLinks.js`, which now asks every question `assignmentCandidates` asks on the UPI rail — ACTIVE, APPROVED, online, accepts buys, the merchant's own rail and tier, both concurrency caps, and the `order_rejections` bar. It joined `merchants` not at all before, under a comment saying so deliberately, so a merchant an admin had stopped kept being handed players through a link they had left behind. **A link is supplied minutes before it is claimed: eligibility is a question about the claim, not about the supply.** |
| Which CHAIN a USDT order settles on | `order_states.usdt_chain`, frozen by trigger. A merchant holds one address **per chain** (`usdt_address_trc20`, `usdt_address_bep20`). See §25. |
| The USDT quote | `order_states.rate_used` + `fiat_amount_paise`, written WITH the order and frozen by trigger. Assignment may not re-price. See §25. |
| USDT buy pricing | `SystemConfig.usdtPricing` — admin-set, bounded at both ends. There is no USDT sell rail. |
| The settlement rail in force | `payment_mode_policies` — one ACTIVE version, append-only, justified. **Not** a feature flag (`featureFlags.service.js` is an env var and an in-process Map: it does not survive a restart and cannot say which rail was live when an order was created). **Not** `payment_gateway_configs.active_mode`, which is P2P vs a third-party gateway — both rails here are P2P. |
| The rail an ORDER runs under | `order_states.payment_mode`, stamped at creation by `stampForNewOrder` and **immutable by trigger**. Every worker and screen branches on the order's own value, never the current policy. |
| Merchant earnings | `merchant_commission_policies` + `merchant_commission_rates` (one row per variety), read by `domains/merchant/merchantCommission.service.js`, which owns no numbers. Platform-funded from `MERCHANT_BONUS_POOL`, never deducted from users. Do not reintroduce `commissionRate`, a buy/sell spread, or a deposit-triggered commission. See §26. |
| Merchant token balance mutations | `domains/merchant/merchantWallet.service.js` exclusively — idempotent `tx_id`. |
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
| Aadhaar mutability | An APPROVED Aadhaar is immutable. A REJECTED one may be replaced through the bot up to `MAX_KYC_SUBMISSIONS`. A FAILED submission's row is DELETED, because `aadhaar_hash` is unique and a typo would otherwise park a stranger's Aadhaar in that index and lock its owner out forever. `users.mobile` is never mutable. |
| Identity documents | **None are collected, stored or accepted.** KYC is a 12-digit Aadhaar number held as an HMAC plus AES-256-GCM ciphertext. Do not add an upload path for one. |
| Upload categories that DO exist | `services/cdn.service.js` — P2P chat attachments, payment proofs, admin branding assets, CDM receipts. Nothing else. "No KYC documents, so remove the upload routes" would break deposits and disputes. |
| The live bot and official channel | `telegram_configs` (the active generation, owning the channel) plus the bot registry, composed by `activeConfig()` in `domains/telegram/telegramClient.js`. **The registry wins over a generation's embedded credentials.** A bot swap does NOT bump the generation; only a channel change does. The 30s cache in `activeConfig` is the only permitted cache. |
| What the bot says | `TelegramTemplate` rows via `telegramTemplates.service.js`, with `DEFAULT_TEMPLATES` as fallback. A blank row means the shipped default, never silence. Do not hardcode a player-facing sentence in a route. |
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
  with `grep -ro "D4AF37" user-panel/src admin-panel/src merchant-panel/src | wc -l`.
  The merchant panel is already at zero.
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
