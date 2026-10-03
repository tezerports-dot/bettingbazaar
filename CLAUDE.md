# CLAUDE.md — the single rules file for BettingBazaar

**This is the only file in this repository that states rules.** Every source file
cites it; where anything disagrees with it, this file wins and the other thing
is corrected.

It holds rules only. **Why each rule exists (the incidents, measurements and
owner decisions) is in `docs/reference/RULES_BACKGROUND.md` under the same §,
trap and S number.** Read that when you need the reason; it is never rules.

| What you want | Where it is |
|---|---|
| What is built, and what is left | `docs/PROJECT_STATUS.md` |
| Realtime event names | `docs/reference/REALTIME_EVENTS.md` |
| Dated decisions | `docs/reference/DECISION_LOG.md` |
| Architecture; capability registry | `docs/reference/ARCHITECTURE.md`; `platform/capabilities.yaml` |
| Every workflow / every screen and button | `docs/reference/OPERATIONS_MAP.html` / `PANEL_WORKFLOWS.html` |
| Generated reports (never edit by hand) | `docs/reference/`: `E2E_WORKFLOWS.md`, `PANEL_CONTROL_COVERAGE.md`, `ROUTE_COVERAGE.md`, `CONTROL_COVERAGE_BY_ACCOUNT.md` (see Commands) |
| SLOs, runbooks, on-call | `docs/reference/SRE_AND_OPERATIONS.md` |
| Android signing, build, publish | `docs/governance/ANDROID_RELEASE_SETUP.md` |
| Branding field → consumer | `docs/reference/BRANDING.md` |
| Security audit map, its blind spots (§0.5), the shape index (§4.0) | `docs/audit/SECURITY_AUDIT_MAP.md` |

---

## 0.0 This platform is NOT DEPLOYED. There are no users.

No live accounts, money or merchants. No migration, back-compatibility or
"existing users": **build the target state and delete what it replaces** (§30).
When the first real deposit is near, rewrite this section first (§29).

---

## 0. Before you edit anything

1. Read this file to the end.
2. Identify which section governs your change.
3. Confirm it violates no rule here.
4. A new authority for a value goes in §2.
5. Removing a file: confirm nothing imports it (`npm run check:dead-code`).
6. A new realtime event: check `docs/reference/REALTIME_EVENTS.md` for typo variants and add yours.
7. Branding: read §13. 8. Wallet: read §9. 9. A new cycle type, board or game: follow §18.
10. A new route, query, or panel render of server text: run `npm run audit:map` and read the diff.
11. Before trusting a green check, ask `SECURITY_AUDIT_MAP.md` §0.5's four questions: *does anything CALL this; is this check a snapshot or a guarantee; if it fails halfway what does the row say; symptom or cause?*
12. Before looking for anything, read `SECURITY_AUDIT_MAP.md` §4.0 for how wide the search must be (including *plus the clock* and *plus the business model*).
13. Before reporting done, fill in §31's table.
14. Ask every §32 question of what you wrote.
15. A vulnerability fix: sweep the whole codebase for the same SHAPE and record the result, even "none found" (`SECURITY_AUDIT_MAP.md` §1, §4).
16. A fix in money, game, verification or security code goes through §37.

**AI sessions:** verify target text exists, by exact string, before patching; if you cannot, say so. Commit any plan or research that gates work in the session that makes it; only commits survive (§17.4).

---

## 1. The rule

**PostgreSQL is the only datastore.** No second store, mirror, dual write, sync,
shim or ODM; a doc describing one is wrong. Code that needs one is unmigrated:
migrate it.

- A failing test is never a reason for a document-store fixture.
- A money decision reads the same rows it writes.
- Never mock the boundary that carries money; test it against a real database.
- Removal happens in sweeping passes, not call site by call site.
- Gate: `npm run check:no-mongo` (CI). Quote only its printed percentage. Only
  `scripts/verify-no-mongo.mjs` (and this file) may name the forbidden strings.

---

## 2. One owner per value

Each value has exactly one owner; nothing else stores, computes or defaults it.
Owners are PostgreSQL tables reached through `database/repositories/`, or
exported constants. `SystemConfig.x` lives in `config_documents`, declared in
`database/spec/config.spec.js`.

**⚠2c**: Step 2c removed the owner the old row named (per-merchant wallets,
escrow, ranking, cash-link queue, payment-mode policy → team routing and pool
holds). Until 2g rewrites the row, the design is `docs/PROJECT_STATUS.md` §3.10;
the principle stated still holds.

| Value | Owner and rule |
|---|---|
| Token price | Fixed 1 token = ₹1; never configurable. |
| Deposit/reserve split | `deposit_policies` via `domains/configuration/depositPolicy.service.js`; one ACTIVE version per currency. |
| Bet min/max per cycle type | `SystemConfig.betLimits` |
| Cycle phase defaults | `DEFAULT_CYCLE_PHASES` (the schema default); runtime `SystemConfig.cyclePhases`. |
| Cycle-history feed | `domains/markets/cycleHistory.service.js`, the one query; rows via `publicCycleView`; the server caps the window. |
| Analytics window | `ANALYTICS_WINDOW` (`user-panel/src/constants.ts`), a target; the server caps it. |
| Platform deposit/withdrawal limits | `SystemConfig` |
| Whether a number is admin-editable | Declared in `SYSTEM_CONFIG_SPEC`; the admin GET/PUT derive from the spec. Never a hand-written field list. |
| A config value the PLATFORM writes ⚠2c | Marked `internal(…)` in the spec; derived accept lists skip it. |
| A board's earliest-phase ceiling | `maxMergeBeforeEndSec` on the cycle META (§18). |
| Order floor | `SystemConfig.minDeposit` / `minWithdrawal` (500 tokens each). |
| Order ceiling ⚠2c | The tokens held, enforced by a hold taken at assignment. No per-merchant order range. |
| Refusals; who may not serve whom | `domains/merchant/merchantRefusal.service.js`. A BUY expiring before PAID is the player's, not a refusal; an unanswered PAID buy, an expired SELL and any decline count on one streak. Cap `merchantOrderLimits.maxConsecutiveRejections`; bars in `order_rejections`. Advanced and read in one statement; only COMPLETED resets; no timer, an admin lifts it. |
| Supervisor and rail | `merchants.is_supervisor` + `supervisor_rail`, set only by `PUT /api/admin/merchants/:id/supervisor`. Rail fixed while running a team. A supervisor is never a member, and vice versa. |
| Team membership, limits | `database/repositories/teams.js`, the one writer; one team per merchant (PK). `MAX_TEAMS` 4, `TEAM_SIZE` 10, counted inside the write under a parent-row lock (S6). Supervisor proposes, admin approves. |
| Whether a team may work | `strength` in `teams.js` (`WORKING`/`GRACE`/`STOPPED`) from the DATABASE clock in IST; below ten it works until midnight IST, then stops until full. Only routing reads it. |
| Team token pools | `team_pools` + append-only `team_pool_entries`, written only by `database/repositories/teamPools.js`. Tokens move only as transfers to/from `TOKEN_SUPPLY` on a fulfilled `team_pool_requests` row, in one transaction with the treasury movement and `admin_token_considerations`; guards in the UPDATE's WHERE. Fulfilling needs `canFundMerchants`, not `canManageTeams`. `TEAM_FLOAT` = sum of pools (`reconcileAgainstSubLedgers`). |
| Merchant rail | `merchants.accepted_currencies`, exactly one of `INR`/`USDT`; vocabulary `domains/merchant/merchantCurrency.js`. |
| An order's currency | `order_states.currency`, matched to the merchant's rail at assignment and accept. |
| How an order reaches a merchant ⚠2c | A BUY is assigned, never claimed first-come; a SELL may be claimed from the open pool. |
| Unpaid BUYs | `domains/payment/playerPaymentFailure.service.js`, which advances both counts below. |
| Three unpaid buys by a player | `users.consecutive_payment_failures`; at the cap `users.order_lock_until` (DATABASE clock, `GREATEST`) blocks new orders on BOTH rails. Flagged, never auto-blocked. Cleared only when money ARRIVES (`moveDepositMoney`). |
| Three unpaid buys at a merchant | `merchants.consecutive_expiries`, never the refusal count. At the cap `assignment_paused_at` stops assignment on every path; not a suspension; an admin or any COMPLETED order clears it. |
| A PAID buy ignored | `sweepUnansweredPaidDeposits` (needs a UTR) → DISPUTED with `disputeRaisedBy='system'`, counted as a refusal; never cancelled or reassigned. |
| Cash Paid with no reference | `sweepUtrAfterPaid`, CASH_ATM only; the PLAYER's silence (`playerPaymentFailure`). |
| Who may get a CASH order ⚠2c | Asked at the claim, with every question normal assignment asks. |
| USDT chain and quote | `order_states.usdt_chain`, `rate_used`, `fiat_amount_paise`: written with the order, frozen by trigger (§25). |
| USDT pricing | `SystemConfig.usdtPricing` (`userMerchantBuyInr`, `merchantAdminBuyInr`); band ₹10–₹1,000 owned by `domains/configuration/tokenRates.js`, enforced on save and on read; 0 = unset = refused by name. No USDT sell rail. |
| An order's payment rail ⚠2c | Fixed on the order; everything branches on the order's own value, never a feature flag or `payment_gateway_configs.active_mode`. |
| Merchant earnings ⚠2c (2e) | Platform-funded; never from users, a spread or a deposit trigger (§26). |
| Token supply | `SystemConfig.adminTokenSupply.total` (20 billion). None are ever created; every movement is a transfer, and the books prove holding + pools + wallets = total. |
| Merchant/pool token movements ⚠2c | One writer, idempotent `tx_id`. |
| What an admin↔merchant/team token movement was FOR | `admin_token_considerations` (`database/repositories/adminTokenConsiderations.js`), one row keyed by the movement. Never sum `fiat_amount_minor` across currencies; aggregate `inr_equivalent_paise`. Figure required, 0 allowed. USDT in only. Validated before tokens move. |
| Tokens held for an order ⚠2c | One owner holds them from attachment, releases on every terminal outcome, consumes on confirm; one live hold per order. Never admit an order by reading a balance: taking the hold IS the check. An unheld order is reported, never silently re-held. |
| Player balance changes | `domains/wallet/walletAuthority.service.js` only, stake locks included. |
| Player balance reads | `walletAuthority.getBalances()`; classified display or decision (§9). |
| Money in/out of the ecosystem | `domains/funding/fundingAuthority.service.js`; rails are adapters in `providerRegistry.js`. |
| The ledger | `accounting_events`, written only via `domains/revenue/revenueSettlement.service.js`: append-only double entry, integer paise, unique idempotency keys, balances derived. |
| Payment references | `utr_registry` via `claimPaymentReference()` (§27). |
| Error responses | `backend/shared/httpError.js`; `respondError` routes on the presence of `err.status`. A handler never phrases a 5xx. |
| Blocked addresses | `ip_blocks` (`database/repositories/ipBlocks.js`), enforced by `backend/middleware/ipBlocklist.js` before all other middleware and by `realtimeAdmission` for socket.io. A failed reload keeps the last good list. Ranges judged by what they cover; never wider than /16 or /48, loopback, or the admin's own address. |
| Order state | `order_states.state` (CHECK). |
| Order creation, tamper tag | `createOrderRecord` (`database/repositories/orders.record.js`), writing `order_hmac` in the same INSERT. No second creation path. |
| A withdrawal's stake lock | Same transaction as its order: `debitWinningsForWithdrawal(…, { within: prepareOrderRecord(…) })`. |
| Merchant side of a completed BUY | `moveDepositMoney`, once, from the hold; no second debit (S41). |
| Ending a withdrawal's money | `withdrawalHold.endWithdrawal(orderId, 'REFUND' \| 'RELEASE')` for every position; never moves order state. One refund key, `refund_<orderId>`. |
| Fields the lifecycle may write | `SETTABLE` in the order writer (§21). |
| Whether a game WIN may be paid | Only against this player's own stake on that round (`bets` WON transition; casino `recordCallback` + `casino_rounds_win_needs_bet`). |
| A casino round | Keyed `(provider_key, user_id, round_id)`; every read and lock names all three. |
| Dispute decisions | Embedded on `order_states`. |
| Who lost a dispute | `dispute_faults` via `database/repositories/disputeFaults.js`, called only by `recordDisputeLoser` from all three deciding routes. Buy completed or sell cancelled → member; else player. Record, count and suspension in one transaction keyed by order. At 3 losses only a full admin may lift (`mayLiftHighRisk` in the WHERE). |
| Window after a rejected BUY | `order_states.dispute_window_until` (DATABASE clock, set in the reject transition), `domains/payment/rejectedBuyWindow.service.js`, `SystemConfig.rejectedBuyDisputeMinutes`. The hold stays until the window lapses or a dispute is decided. |
| Window after a SELL is marked paid | `SystemConfig.withdrawalHoldMinutes` (default and floor 60), via `withdrawalHold.service.js`; the player sees `disputeUntil`. |
| Cash denominations, USDT sizes | `domains/merchant/denominations.js` (SQL CHECKs mirror it, tested). Not admin-editable. |
| Referral rewards | `REFERRAL_REWARD_PAISE` (flat ₹25) + `referral_programmes`; ledger and payout via `domains/referral/referral.service.js` only. Never a share of losses or tied to settlement. |
| Player identity | A Telegram-proven mobile plus a password. No email, no KYC, no Aadhaar, no identity document or upload path (owner, 2026-10-02; `identitySurfaceRemoved.test.js`). `users.mobile` is immutable. |
| Upload categories | `services/cdn.service.js`: chat attachments, payment proofs, branding assets, CDM receipts, Android APKs. Nothing else. |
| Live bot and channel | `activeConfig()` (`domains/telegram/telegramClient.js`) over `telegram_configs` + the bot registry; the registry wins; its 30 s cache is the only cache. |
| Which panel a bot/channel/link serves | `audience` on the Telegram tables, equal to `users.account_type`; each panel has its own fleet, recovery bot and channel. A deciding read requires an audience. |
| Panel origins for minted links | `panelOrigin()` (`backend/config/panelOrigins.js`). |
| A panel's name on screen | `PANEL_NAME`/`PANEL_NOUN` (`domains/identity/audiences.js`). |
| Sign-in bot assignment | `assignSigninBot` (`database/repositories/telegram.js`): sign-in is a rotating fleet, recovery is singular; stored on `users.telegram_bot_id`. The last live sign-in bot cannot be retired. |
| Whether a player may use the app | `verificationStateFor()` (`GET /api/v1/auth/verification`), one `reason`; the panel reads only that. Staff `bootstrap` per §33. |
| An account's population | `users.account_type` (`PLAYER`/`STAFF`/`MERCHANT`); mobile unique per type; `getUserByMobile` requires the type. Never move, promote or link an account across panels; staff flags only on STAFF rows. |
| Whether a session is still valid | `sessions_valid_from` + `sessionIsLive()` (`domains/identity/auth.middleware.js`), on EVERY path that verifies a token (middleware, `/me`, `merchantAuth`, SSE, socket joins). |
| A merchant's password | `users.password_hash` on its login row, never on `merchants`. |
| Password reset | `domains/identity/passwordReset.service.js`: from the account's own audience bot; grants choosing a password, never a session; hashed, single-use, expiring, in the URL fragment. |
| Login doors | `LOGIN_DOOR` (`backend/routes.js`), one `loginHandler`; the read is scoped by `account_type` on both legs. |
| Which panel a session may use | `belongsElsewhere`/`refuseWrongPanel`: `authenticatePlayer` on every player route; `authenticate` never admits MERCHANT; `403 WRONG_PANEL` (S51). |
| What the bot says | `TelegramTemplate` rows (`telegramTemplates.service.js`), sent by the player's own bot (`sendTemplate({ bot })`). No hardcoded sentence in a route. |
| Valid mobile, referral code | `backend/domains/identity/signupFields.js`; the panel mirror (`indianMobile`) changes in the same commit. |
| Password policy | `backend/domains/identity/passwordPolicy.js`; floors 12 staff, 8 player. |
| Notifications | `notify()` (`domains/communication/communication.service.js`); never write a notification row directly. |
| Transaction and bet validation | `domains/risk/riskValidation.service.js`. |
| Cycle timing / vocabulary | `cycleGenerator.service.js` computes (`GAME_CORE.ts` display only); `cycleTypes.js` names only, throws on unknown. |
| Games | `games` + `game_categories`; no hardcoded game arrays. Trading vocabulary: `domains/trading/tradingModels.js`. |
| Staff areas | `backend/domains/identity/staffPermissions.js`; every staff route asks `hasPermission(<area>)` and nothing weaker. A grant stores every key; an unknown, non-boolean or absent `permissions` is refused. |
| Which staff get an admin event | `backend/domains/notification/staffEventAreas.js`; undeclared events reach full admins only; a permission change closes that account's streams. |
| Chat rules; branding; support links | Chat config (`/api/chat/config`); `Branding` (§13); `SupportLinks` (not Branding). |
| Auth token storage | One key per app: `auth_token`, `merchantToken`, `admin-auth`. |
| App version | `package.json` via `VITE_APP_VERSION`; Android `versionName` must match it. |
| Android releases | `android_releases` (`database/repositories/androidReleases.js`): package, version and key read from the APK, signature verified; installs are told `updateStatus` (`androidRelease.shared.js`) per phone SDK; publish guarded in the UPDATE's WHERE. No hand-typed download URL. |
| Player app logo and splash | `user-panel/src/services/brandAssets.ts`. |

---

## 3. Forbidden patterns

- A frontend business value with a backend config equivalent; a `??` fallback
  other than the schema default.
- An admin-editable field with no real consumer (ship the consumer with it).
- A shadow table; a frontend mirror with zero consumers; a second write path
  to a single-writer value.
- One change emitted under two event names; a private realtime channel without
  a verified backend registration route; a version literal in a component.

---

## 4. No hardcoded business values

- Business numbers come from database-backed config. A `??` fallback equals the
  schema default and cites it in a comment.
- Colours, fonts, logo paths and app names come from `Branding`, through
  `--brand-primary|secondary|accent` and the derived `--brand-*-rgb` (for tints:
  `rgba(var(--brand-primary-rgb), 0.25)`), or `localStorage.app_branding`.
  Never a hex in a component. One branding applier per panel.
- A literal colour is allowed only as the token's declaration, a
  `var(--brand-x, #hex)` fallback, or a placeholder citing the schema default.
- Count with `npm run report:branding` (fails the build above zero), never by
  grepping a hex.
- Permission keys, status enums and event names come from a shared module.

---

## 5. No duplicates

- Search for an existing constant, enum or config field and extend it.
- A frontend mirror of a backend enum cites the backend file and field in a
  comment and has a §2 entry.
- Never assemble the same payload in two places.

---

## 6. Configuration ownership

- `SystemConfig` owns platform-wide limits. No per-merchant order caps.
- A config field's default lives in one place (the column `DEFAULT` in
  `database/schema.sql`, or one exported constant), and every `??` beside it
  says `// schema default: <n>`.
- Client-side config caches state their staleness window.

## 7. Workflow ownership

- One state field per logical question. Cron jobs run against the table the
  real workflow populates.

## 8. Route ownership

- The merchant panel derives paths from `ROUTES` (`merchant-panel/src/constants.ts`).
  Admin and user panels use literals (constants there are open work). A
  constants module nobody imports is deleted.

## 9. Balance ownership

- All balance reads and writes go through `walletAuthority.service.js`; no raw
  increment or read-then-write.
- Settlement computes amounts, calls the wallet authority, and pays no
  commission. Referrals never touch settlement.
- Classify every balance read as display or decision. A number that GATES a
  transfer is read from the rows the write will lock (`check:balance-reads`).

## 10. Admin ownership

- Every admin settings field wires to a real consumer in the same change. The
  admin panel applies its own branding. Dashboard stats read the table the
  workflow writes.

## 11. Allowed exceptions

- A UI-only frontend constant never used for server validation, commented
  citing §11. A migration duplicate for the shortest window, removed by the
  change that completes it. Display-only timing mirrors.

---

## 12. Realtime events

- One name per logical change, unique across socket.io, SSE and
  `realtimeEmitters.js`. Every new event is added to `REALTIME_EVENTS.md` in the
  same change.
- `emitMerchantUpdate('*', …)` reaches nobody: use `broadcastToMerchants`.
- The panel SSE client hears only names in its own list: compare BOTH lists
  when adding or renaming an event.
- Merchant pushes go through `emitMerchantUpdate` (the merchant panel has no
  socket client).

## 13. Branding

- The `Branding` row is the single source. `sendBranding()` in
  `socketHandlers.js` alone builds the branding payload; saving re-emits the
  full document.
- Each panel on the event: store `localStorage.app_branding`, apply the CSS
  variables, set `document.title` from its own panel-name field.
- Logo URLs: strip the CDN base's trailing slash and the path's leading slash.

## 14. Dead artifact policy

No committed artifact describes an unapplied fix. Patch and fix scripts are
applied and deleted; a migration script is deleted once applied or carries
`// STATUS: PENDING`; a TODO citing a fix is resolved with the fix.

## 15. Monorepo structure

Three frontends, one backend. No panel imports another panel's `src/` or
`backend/`; shared config comes from the API or socket. Each panel owns its
`package.json`, build config, auth key and version. No frontend package in the
root `package.json`.

## 16. Every source file cites this file

Within its first 10 lines, added on first edit if missing:

```
// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
```

---

## 17. Runtime currency, reproducibility, and durable artifacts

1. Production runs supported LTS runtimes and dependency majors; EOL in
   production is a blocker. CI runs the versions production runs.
2. Production installs from the committed lockfile (`npm ci`).
3. Re-run the architecture comparison quarterly or on a stack EOL.
4. Research and plans that gate work are committed in the session that makes
   them; the plan lives in `docs/PROJECT_STATUS.md`.

### 17.1 Stay on latest

1. Every runtime and dependency tracks the latest release.
2. Patch and minor bumps are applied when every gate and suite passes.
2a. A person merges every dependency PR. Never enable auto-merge.
3. A major is held only if adopting it forces rewriting working code, and then
   it goes in the register below with the reason.
4. Reach a volatile third-party surface through one thin adapter.
5. A bump is done when `test:unit`, `test:pg`, the gates, and every panel's build
   and typecheck pass, recorded in §31's table.
6. Re-measure the request path after a bump (S38).

Held-major register (a row leaves when its blocker is gone):

| Package | Held on | Major | Rewrite the newer major forces |
|---|---|---|---|
| typescript | all panels | 5.x | 7.x is a preview |
| eslint | admin | 8.x | flat config replaces `.eslintrc` |
| tailwindcss | merchant, user | 3.x | v4 stylesheet and config rewrite |
| recharts | admin | 2.x | v3 renamed chart props |
| framer-motion | admin, user | 11.x | v12 renamed the package and `motion` import |
| @hookform/resolvers | admin | 3.x | v4 resolver signature |
| date-fns | admin | 3.x | v4 `TZDate` changes offset parsing |

---

## 18. Adding a cycle type, board or game

A new board inherits the money system and re-implements none of it.

- **18.1 Inherited, never given a per-type case:** funding split, reserve, fee,
  multiplier, settlement, payout, idempotency, crash resume, ledger, realtime
  snapshots and pools, bet rate limits, caches, cron, retention, reconciliation.
  Needing a case there means a type-specific branch exists: fix the branch.
- **18.2 Declared per type:** (1) a `META` entry in `cycleTypes.js`;
  (2) `DEFAULT_CYCLE_PHASES.<phasesKey>`; (2a) `maxMergeBeforeEndSec`;
  (3) `SystemConfig.betLimits.<limitsKey>`, even if equal to another's;
  (4) the phantom-access enum; (5) frontend enum, chips and phase map as §5
  mirrors; (6) `cycleTypes.test.js` loops; (7) a lifecycle test if its phases
  differ by an order of magnitude.
- **18.3 Invariants:** `merge > equalizer > close > celebrate >= 0` and
  `merge < duration`; phases fit the block; celebration lock and next-cycle
  timer derive from the type's own offset; a still-OPEN cycle may complete
  directly (keep that tolerance); unknown types fail loudly, broadcast paths
  skip the row.
- **18.4** Re-run the load test before enabling a high-frequency board.

## 19. The financial core stays

Integer paise in `BIGINT`; `SELECT … FOR UPDATE` around every balance mutation;
append-only double-entry ledger; unique `tx_id` idempotency; `*_transitions`
audit tables; `CHECK` constraints. A change that weakens any of these is wrong.

---

## 20. Traps — already paid for

1. `computeWinningsPayout()` has no `payout`; read `net`.
2. Take the owner from the row, not the argument.
3. Write a cycle's winner BEFORE its status; never settle a cycle with no winner.
4. Never store real pool totals on `cycles` (deadlock); derive from `bets`.
5. node-postgres returns `BIGINT` as a string; cast once where the row is read.
6. Reconstruct counters from rows, never in memory.
7. Classify balance reads (§9).
8. Withdrawal creation and merchant selection stay covered by tests.
9. Before the concurrency suites, CI sets `log_min_error_statement=panic` and `log_min_messages=fatal` (`ALTER SYSTEM` + `pg_reload_conf()`).
10. Never assert a global invariant over a shared table: baseline, own rows,
    assert the delta. A test that writes config restores it in `afterAll`
    outside any assertion and compares against what it stored. A CHECK probe
    removes its row in a `finally`.
11. A gate reads machine-readable output (`--reporter=json`), never prose.
12. Never edit a file while a mutation run is in flight.
13. A mutation anchor matches exactly once.
14. Define each schema object once (`CREATE OR REPLACE` twice keeps the last).
15. `fiat_amount_paise` is in the ORDER's currency: the ledger posts the INR
    equivalent, renders go through `formatOrderFiat`, aggregates use
    `token_amount_paise`.
16. A merchant-scoped read is a permission: widen the scoped reader, never
    reach past it.
17. `transition()` does not write `completed_at`; money gates ask the ledger.
18. A guard read in one statement and acted on in another is a snapshot: put it
    in the `UPDATE`'s `WHERE`.
19. Check the recipient can receive BEFORE writing the record; a 404 is not a
    rollback.

## 21. A write that follows a commit must not be able to fail

- State moves first, fields second, so the second write must not be able to
  throw (`check:settable`). Prove values and money with a real-database test.
- Values from one decision are written in one call that validates the whole
  patch first (`setConfigFields`), never a loop committing per field.
- A spec refusal carries `status: 400` at the throw.
- Check a column is nullable before writing `null`.

## 22. Code nothing imports is not code

A module nothing imports is dead (exceptions in `ORPHAN_ALLOW` with a reason). A
test reading a file's source is not a consumer. A name in a comment is not a
reference.

## 23. A type that lies is worse than no type

Check a panel type's fields against what the mapper actually emits; rename in
the interface and let `tsc` find the call sites. Read `userId`, not
`req.user?.id`. No `.save()`/`.populate()`/`.toObject()`/`.lean()` on rows.

## 24. Privacy points BOTH ways

A merchant sees only the payout account and the name on it. A player sees where
to pay, an opaque `Merchant #<ref>` and a deadline.

1. Each projection is an allowlist in one file (`merchantOrderView.js`,
   `playerOrderView.js`, `playerLedgerView.js`).
2. Tests assert the response's key set is a subset of the allowlist.
3. No panel type declares a forbidden field.
4. Every channel that sends data is checked, across the whole backend.
5. A spread only from a producer the gate verified.
6. Gates blank comments before scanning; a producer with nothing to check fails.

`npm run check:merchant-privacy` · `npm run check:player-privacy`

## 25. USDT

- A USDT buy is exactly 50,000, 100,000 or 500,000 tokens; the USDT amount is
  derived from the admin rate at creation and frozen with the order. Unpriced is
  refused by name (`USDT_RATE_UNSET`), no fallback.
- Chains are not interchangeable: an address per chain; the player picks the
  network before the order; address and network always travel together; only
  the order's chain is sent; the chain is frozen; a merchant without that
  chain's address is not a candidate (guard in the assignment query).
- ₹10,000 (one CASH_ATM buy) and ₹40,000 (one payout leg) are ATM limits only.
- A refusal names that rail's own valid choices.

## 26. Merchant commission ⚠2c (2e replaces)

Step 2e's team commission (`PROJECT_STATUS.md` §3.10) replaces this engine.
Until then: paid once on matched volume above a high-water mark from a
platform-funded pool; match and mark per variety; an unpriced variety earns
nothing and is reported; read the mark from the idempotency key; key separator
`~`; never partial-issue; check the recipient exists first.

## 27. One payment, one claim

UTRs, chain hashes and CDM slips share `utr_registry`; one reference, one order,
for good. `claimPaymentReference()` throws; `check:payment-references` checks
per field. References are uppercased first. Refusals use the submitter's words.

## 28. Shipped means reachable

1. A panel call resolving to no route is a live defect (`check:ui-coverage`).
2. A backend feature with no UI is not shipped; read `--unused`.
3. A screen works only once its calls are followed to a route.
- Derive what a gate checks from the code it checks; a false failure is a gate
  defect. No path that works on only one machine (`import.meta.url`).

## 29. Do not claim readiness

Not ready for money until `check:no-mongo` is zero and the suites pass on
PostgreSQL alone. "Clean", "complete", "perfect", "production-ready" require the
gate run and its printed number. Say what was checked and what was **not**.
Absence of a failing check is not evidence when no check covers the claim.

## 30. Working rules

Read the whole path (endpoint, service, store, fixtures) before changing part.
Do not accommodate; remove. Derive, do not duplicate. Money is integer paise in
`BIGINT`.

---

## 31. Every change reports what it covered

A change is done only when its author gives this table (commit message or reply),
each row **done** (and how), **n/a** (and why) or **NOT DONE**:

| Front | Question |
|---|---|
| Data layer | Does it exist, with one owner (§2)? |
| Backend route | Does it work through a real database? |
| Route ADMISSION | Does every route reaching this state admit the same things? |
| Panel UI | Is there a screen, rendering the new field? |
| The button | Does a control actually CALL it (`check:ui-coverage`, `--unused` read)? |
| Cross-panel | What do the other two panels show after it? |
| Failure path | What does the user see on refusal; can they act on it? |
| Money | Debit AND credit asserted against a real database? |
| Tests | Which tier, how many; does a mutation of the fix fail them? |
| Neighbours | For a FIX: invariant, paths, opposite-behaviour test, §37.1 pairs. |
| Gates | Which ran, and what did they print? |

**31.1** The change that invalidates a rule, this table or §32 updates it in the
same commit; a new shape is added to §32 with its question; background goes in
`RULES_BACKGROUND.md` under the same number.

---

## 32. The shapes that keep shipping here

Ask each question of the change in front of you.

| # | Shape | Question |
|---|---|---|
| S1 | Button calls a missing route | Does this path resolve, with this METHOD? |
| S2 | Route no button calls | Unfinished, or a hole only the UI hides? |
| S3 | Two routes, one state, different admission | What does the other one refuse? |
| S4 | Consumer outlives producer | Does anything still WRITE what this reads? |
| S5 | Producer outlives consumer | Does anything still READ what this writes? |
| S6 | Guard you can pass twice | A read acted on later, or a serialised write? |
| S7 | Write after commit can fail | If the second write throws, what does the row say? |
| S8 | Gate measuring a fraction | Make it fail on purpose. Does it? |
| S9 | Type names a field never sent | Check the mapper. |
| S10 | Type omits a field that is sent | Check the emitter. |
| S11 | Same value assembled twice | Which is the owner? |
| S12 | Default disagrees with the spec | Does every fallback equal the schema default? |
| S13 | Refusal costs the next attempt | Does the limiter bound effects or attempts? |
| S14 | Message blames the user for platform state | Can the reader act on it? |
| S15 | Aggregate across currencies | Is the column in the order's currency? |
| S16 | Fixture production cannot produce | Could the platform create this row? |
| S17 | Admin decision no other panel reflects | What do merchant and player see? |
| S18 | Silent no-op after a committed write | Can the recipient receive first? |
| S19 | Test asserts a precondition it never set | Did this run create that state? Set it and restore it. |
| S20 | Shared single-use resource | Can two callers both consume it? Share the parsed result. |
| S21 | Shell renders, content failed | What is inside `<main>`? |
| S22 | Control with no handler | Press it. Did anything visible change? |
| S23 | Component declared inside a component | Does its identity survive the parent's render? |
| S24 | Label not attached to its control | Addressable by its printed name (`htmlFor`/`id`)? |
| S25 | Panel keeps its own list of fields | Read the list from the server's document. |
| S26 | Right route, request it refuses | Does the call carry every required header and field? |
| S27 | Limiter counts a rejected session | Does the path check a credential at all? |
| S28 | Limiter on a router prefix | What else does that prefix serve? |
| S29 | Input normalised to plausible-but-wrong | Type what people type; does it land as meant? |
| S30 | Query matches two populations | Can this WHERE match another kind of row? |
| S31 | Migration idempotent, not convergent | Change the definition and re-run: does it converge? |
| S32 | Security check on only one path | Which other path skips the middleware? |
| S33 | Harness measures a server it did not start | Did this run start what it asks? |
| S34 | Early return pre-empts a question | Does this guard change the order of questions? |
| S35 | Caller mistake thrown without `status` | Does the first check on the input carry `status: 400`? |
| S36 | Mapper reads a column not SELECTed | Read the column list. |
| S37 | Stream behind a buffering middleware | Ask as a browser (with `Accept-Encoding`). |
| S38 | Pure-JS crypto on the request path | Time the primitive per thread. |
| S39 | Relative path in the native shell | Where does it resolve at `https://localhost`? |
| S40 | Assertion on a missing key both sides | Is every compared number finite? |
| S41 | Second debit beside a hold | Is this money already reserved? |
| S42 | "Not X" read as "therefore Y" | List every state the else-branch can be in. |
| S43 | Comment counted as a caller | Strip comments; does a real call remain? |
| S44 | Refusal painted, not announced | `role="alert"`/`status` or `aria-live`? |
| S45 | Key narrower than the thing | What makes two the SAME? Fix the key, not a later check. |
| S46 | Client method no screen calls | Does the panel name it? (`report:routes`) |
| S47 | Figure from another window or population | Is "today" today; are "bets" player bets? |
| S48 | "Not signed in" = "not permitted" | Does a lacking account see a screen saying so? |
| S49 | Authority read off an unchecked population | Is the FLAG scoped, not just the login? |
| S50 | Status nothing reads | Which doors and session checks ask about it? |
| S51 | Login scoped, session not | Send each session type to every other panel's routes. |
| S52 | Audit note shown to its subject | Who was this text written for? |

---

## 33. Signing up is a FORM. Telegram verifies; it does not authenticate.

- **33.1 The form creates the account** (mobile, password, confirmation, captcha,
  invite code; a referral link's code is pre-filled and locked). Telegram then
  proves the number (contact share matched to an existing row) and enforces
  channel membership. Login is mobile, password, captcha and any second factor.
  **Nothing a bot does grants a session.**
- **33.2 Fleet:** sign-in bots rotate (§2); `live_slot` names `recovery` only; a
  webhook path and secret per bot; replies come from the bot the update arrived
  on; `getLiveBot(role)` returns any live bot.
- **33.3 The gate** (`VerificationGateModal`) asks on mount and on a timer and
  blocks everything until both halves hold. A channel change re-gates everyone
  via the generation; a leave re-gates at once; `no_bot`/`no_channel` are the
  platform's state and show no button; a changed contact is acted on when the
  next share arrives.
- **33.4 Limiters guard credentials:** credential limiters sit on the credential
  routes, never the `/api/v1/auth` prefix. Signup submits no secret: it bounds
  accounts per address, counting successes only. Before mounting a limiter,
  name the credential the path checks.
- **33.5 Three entities:** player, staff and merchant accounts are separate, even on
  one mobile. A query that can match two populations gets a predicate in the
  WHERE, plus a second refusal where takeover is possible. A constraint whose
  definition may change is dropped and re-added.
- **33.6 Password reset:** offered, not sent; setting it evicts every session in the
  same statement (checked on both authenticated paths); the token is consumed
  before the password is validated; the floor is the account type's.
- **33.7 Three panels, three bots, three channels** (owner, 2026-09-24): per panel a
  fleet, a recovery bot, a webhook per bot, one active channel; identities keyed
  `(telegram_user_id, audience)`; a reset link opens its own panel; the admin bot
  resets passwords, verifies first login and carries security alerts.
- **Bootstrap exemption:** staff alone pass while the staff surface is
  unconfigured, shown as a standing banner naming the screen that closes it.
- Seed fixtures produce real accounts (`account_type`, a merchant's `users` row,
  a linked Telegram).

## 34. `BB_RATE_LIMIT_RELAX` — test facility only

Multiplies every `RATE_LIMIT_TIERS` count (never windows, keys or mounts);
default 1; production refuses to boot with it; rejects non-numbers; pinned to 1
in every vitest config and in `backend/tests/e2e/run.js`; warns at boot. Set it
only on a development server for `test:browser`/`drive`/`mutate`/`forms`; never
in a committed env file, Dockerfile, CI job or manifest, or on a server measuring
limits.

## 35. Coverage is a set of DIFFERENT claims. Never add them up.

Goal: every meaningful behaviour has a test, or a stated reason it has none.
**35.1** Kinds: **MUTATION** (state asserted in the database, bystander checked; only
`test:mutate`), **SCREEN_MOVED**, **ANSWERED**, **SAID** (an `alert()`; not a
mutation), **NO_OP_BY_DESIGN**, **INERT** (triage), **DISABLED** (state only),
**REPEAT** (an assumption), **DRIVEN_ELSEWHERE** (a pointer), **NOT_REACHED**
(the honest number). **35.2** `report:controls` prints one line per kind, no total, and
`UNCLASSIFIED` for the rest. **35.3** Name the kind of evidence you have; a percentage is
not evidence.

## 36. Horizontal scale is a config contract

Cron leader lock (`cron_locks`), settlement claim (`FOR UPDATE SKIP LOCKED` +
lease), socket.io Redis adapter, SSE Redis relay, shared rate-limit store, and
wallet row locks already make N instances safe. An operator MUST set
`REDIS_URL` (for more than one instance), `TRUST_PROXY` (production refuses to
boot without it) and `TURNSTILE_SECRET_KEY` (or `ALLOW_NO_CAPTCHA=true`). Pen
test probes live in `backend/tests/e2e/scenarios/s8-pentest.js`, assert the
database before and after, and record an unreachable probe as a NOTE, never a
pass.

---

## 37. A fix is proven against its NEIGHBOURS

For money, game, verification and security code: (1) reproduce it failing
against a real database; (2) name the broken INVARIANT; (3) find every caller,
path, transport, retry and state that reaches it; (4) fix the invariant (key,
owner, constraint), never a check after the read; (5) regression test;
(6) test the opposite behaviour, so a refusal still lets the legitimate case
through; (7) test the neighbouring pairs below; (8) mutation-test the fix and its
neighbours; (9) test through the real database and transport; (10) look for
alternate paths around it; (11) run every gate and tier; (12) independent review,
or the PR says *"not independently reviewed"*.

**37.1** Ask *what is the closest scenario where this fix would be wrong?* Test
each pair that applies and write down why any does not: single/multi-player;
same/different user; same/different provider; HTTP/WebSocket/SSE/cron/webhook;
IPv4/IPv6 and every spelling of a value; new/existing database;
first/concurrent request; success/partial failure; retry/duplicate.

**37.2** Done means §31's Neighbours row names the invariant, the paths, the
opposite-behaviour test and the pairs. "Tests green" is not enough.

## Commands

Gates: `check:no-mongo` (definition of done) · `check:deps` · `check:ui-coverage`
(`--unused`) · `check:dead-code` · `check:settable` · `check:db-boundary` ·
`check:orphans` · `check:staff-permissions` · `check:balance-reads` ·
`check:coherence` · `check:merchant-privacy` · `check:player-privacy` ·
`check:payment-references` · `check:error-responses` · `check:cors-headers` ·
`verify:capabilities` · `audit:map -- --check` · `report:branding`.

Tests: `test:unit` · `test:pg` (real PostgreSQL) · `test:e2e` (whole server,
three actors, pen test) · `test:browser` (every screen; needs `BB_BASE`) ·
`test:panel-split` · `test:panel-gates` · `test:captcha-doors` · `test:drive`
(every control pressed) · `test:mutate` (database + bystander; `bb_drive`) ·
`test:wallet-buttons` · `test:bet-button` · `test:ghost-mode` ·
`test:operations -- --cron --restore --sse` · `loadtest:scale -- --seed
--queries` (`bb_load` only).

Reports (write `docs/reference/`): `report:controls`, `report:workflows`,
`report:routes` (`BB_ROUTE_COVERAGE=<dir>/<tier>.jsonl`), `report:control-gaps`
(`BB_PROFILE`, `BB_VIEWPORT=phone`).
