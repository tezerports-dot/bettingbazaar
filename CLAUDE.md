# CLAUDE.md — BettingBazaar

**This file outranks every other document in this repository, including
`docs/governance/04-GOVERNANCE.md` and the BBEPS specification it cites.** Where
any document disagrees with this file, this file wins and the other document is
wrong and must be corrected.

---

## The rule

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

---

## Exit criteria

The migration is complete when, and only when, all of the following hold. These
are counted mechanically by `npm run check:no-mongo`; the numbers in parentheses
are the baseline measured before removal began.

1. Zero `mongoose.model()` call sites (currently 520 outside tests).
2. Zero files importing `mongoose` or `models/index.js` (currently 100).
3. `mongoose` and `mongodb-memory-server` out of `package.json`; `MONGODB_URI`
   out of every script and env file.
4. The integration test tier gone.
5. Zero MongoDB references in code comments (currently ~600 lines).
6. Zero MongoDB references in `docs/` and governance (currently 24 files).
7. No money decision read from one store and executed in another.
8. `BalanceAdjustment`, `BlockedIP` and `ChatMessage` are referenced through
   `mongoose.model()` in five files and DEFINED NOWHERE — every call throws
   `MissingSchemaError` today, so the admin retention route, the IP-block check
   in `middleware/security.js`, and three chat endpoints are dead. Build them in
   PostgreSQL or delete the routes. `BlockedIP` is a real security control that
   is currently absent — flag that to the owner rather than silently dropping
   it.

### The gate

```
npm run check:no-mongo
```

Non-zero exit with a per-file report while any count is above zero. Run it after
every removal pass; **the numbers must only go down.** It runs in CI and is the
definition of done.

It also prints progress as a percentage of the references that existed before
removal began — per check and overall — from baselines measured with the same
script at commit `6e66b52`.

**That printed figure is the only progress number to quote.** An estimate made
from memory carries its own denominator, and two estimates taken a day apart are
not comparable: reporting 65% and then 62% looked like regress while every
single count was in fact still falling. If somebody asks how far along the
migration is, run the gate and read the number off it.

`scripts/verify-no-mongo.mjs` is the only file permitted to name the forbidden
strings, because it is the thing that forbids them. It excludes itself by path.
Nothing else is exempt — not a comment, not a variable name, not a doc.

---

## Do not claim readiness

Until `check:no-mongo` reports zero on every count and the suites run green
against PostgreSQL alone, this platform is not ready to take money. No
individual green check says otherwise. Do not describe the platform as ready,
migrated, or production-capable before then.

---

## What is being kept

The financial core in PostgreSQL is good and stays exactly as it is:

- Integer paise in `BIGINT` — never floats, never a decimal string in arithmetic.
- Row-level wallet locking (`SELECT … FOR UPDATE`) around every balance mutation.
- An append-only, double-entry ledger.
- Unique `tx_id` idempotency gates.
- `*_transitions` audit tables.
- `CHECK` constraints that make an impossible row impossible.

Only the migration scaffolding around that core is being removed. If a change
would weaken any of the six properties above, it is wrong regardless of what
else it achieves.

---

## Traps — already found and paid for. Do not rediscover them.

Each of these cost a CI round trip. They are recorded so the next reader does not
pay again.

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
7. **Classify every balance read as display or decision.** Money decisions read
   from the wrong store were found in three places: bet-placement affordability,
   withdrawal admission (`paymentProcessing.service.js`), and merchant
   assignment (`merchantScoring.service.js`, which filtered candidates by a
   document-store `tokenBalance`). A display read may be stale; a decision read
   may not.
8. **`createWithdrawalOrder` and `selectBestMerchant` decide where a player's
   money goes and had zero tests.** They stay covered.
9. **CI log noise buries the failure.** PostgreSQL logs every refused `ERROR`
   with its full statement, and the concurrency suites provoke those on purpose.
   The runner dumps the whole container log at teardown, pushing vitest output
   and failure annotations out of the retrievable window. Set
   `log_min_error_statement=panic` and `log_min_messages=fatal` at runtime
   before the suites run. A service container has no `command:` key — use
   `ALTER SYSTEM` + `pg_reload_conf()` in a step.

10. **A mutation run leaves its rows behind.** `mutation-check.mjs` reverts the
    source file; it does not revert the database. So a mutant that disables a
    guard creates exactly the rows that guard exists to prevent, and they stay
    there. A ₹7,770 cash-rail order — an amount no ATM dispenses and the
    denomination gate refuses — sat in `order_states` because the mutant
    disabling that gate had run once.

    The consequence is a rule, not a curiosity: **never assert a global
    invariant over a shared table.** A test that walks everything a query
    returns and asserts each row is well-formed is asserting something about
    every other process that has ever touched that database, including the
    mutation harness deliberately creating malformed data. Take a baseline,
    create your own rows, and assert the delta.


11. **A gate that reads printed prose will eventually read it wrong.** The
    mutation harness decided KILLED vs SURVIVED by regexing vitest's summary
    line out of stdout. That line is prose: its wording depends on the reporter,
    ANSI colour codes sit between the words the pattern needs adjacent, and
    which stream it lands on depends on whether the runner looks like a
    terminal. M49 measured 22 tests on every local run and came back NOT
    MEASURED in CI, on a check that had been green for weeks.

    A machine-readable result exists (`--reporter=json --outputFile`); read
    that. And a non-zero exit is not by itself evidence a mutation was killed —
    a mutant that makes a module unparseable also exits non-zero, which is the
    mirror image of crediting a suite that never ran.

---

## Working rules

- **Read the whole path before changing part of it** — endpoint, service, store
  access and fixtures together. A route rewritten without its service is a bug
  with a green test.
- **Do not accommodate; remove.**
- **Derive, do not duplicate.** One owner per value (`04-GOVERNANCE.md` §1
  still governs this).
- **Money is integer paise, everywhere, in `BIGINT`.**

---

## Shipped means reachable

A backend that works and a panel that calls it are two different facts, and this
repository has repeatedly had one without the other. Every check here passed
while five admin buttons hit paths the server has never served: the request
404'd, the component caught it, and the screen rendered its empty state —
indistinguishable from "no data". Nobody saw a stack trace. Nobody saw a red
test. The dispute queue was permanently empty, release and refund did nothing,
merchant scoring silently failed while reporting that the *limits* had failed,
and every merchant's order history read "No orders found" however busy they were.

A route test proves a handler works. It can never prove anything calls it.

1. **A panel call that resolves to no route is a live defect**, not a loose end.
   `npm run check:ui-coverage` fails the build on one. Three of the five above
   shared a single cause — handlers moved out from under a `/queue` prefix and
   the panel was never updated — so this is drift, and drift recurs.
2. **A backend feature with no UI is not shipped.** It is built, tested, merged
   and unreachable. `check:ui-coverage --unused` lists these; the list is
   triage, not failure, because webhooks and SSE belong on it. Anything else on
   it is either work someone forgot to finish or code to delete.
3. **Do not describe a screen as working without following its calls to a
   route.** Reading the handler is not enough. Reading the component is not
   enough. The two must be checked against each other.

## A write that follows a commit must not be able to fail

The order lifecycle moves the STATE first and writes the accompanying fields
SECOND, deliberately: an order must never be found in a new state without the
facts that justify it. The price of that ordering is that anything wrong in the
second write happens **after the first has already committed** — the order
moves, the handler's `catch` returns a 500, and everything it meant to do next,
including moving money, never runs.

`setOrderFields` throws on a field name it does not know. That has shipped
**three times, in three files**, and every check in this repository was green
each time:

- `resolvedAt` / `resolvedBy` in `disputeResolution.admin.routes.js` — every
  admin dispute resolution failed.
- `updatedAt` in the merchant reject handler — 500 on every call, and no screen
  called it, so nothing noticed.
- `resolutionNotes` + `updatedAt` in `paymentOrder.routes.js` — the admin
  panel's release button marked a **disputed deposit COMPLETED and never
  credited the player**, then told the admin it had failed. The order left the
  DISPUTED queue, so nothing remained to show it had gone wrong.

`npm run check:settable` refuses the whole class at build time. It reads
`SETTABLE` from the one file that defines it and checks every `set: { … }`
literal in `backend/`. It cannot see whether the values are right or whether the
money moved — those need a test through the real database.

The same shape exists outside the lifecycle: a column that is `NOT NULL` refuses
an explicit `null`, and `updateUser` passes values straight through. That is how
`unblock?resetWarnings=true` 500'd *after* the unblock committed, leaving
`is_blocked` false with `status` still `BLOCKED` — an account sign-in refused
and the request guards admitted. **Before writing `null`, check the column.**

## Code nothing imports is not code

`check:dead-code` scans exported names. A default export is named at the import
site, so a module whose only export is a `default` was exempt from every check
in it. `backend/services/admin.service.js` was exactly that: 380 lines
duplicating live block/unblock/delete/sub-admin routes, holding two writes of
`null` into a `NOT NULL` column — and holding a locked-balance guard the LIVE
delete route did not have, while `moneyDecisionsReadTheWallet.test.js` asserted
that guard **against the dead file** and passed. The live route would
soft-delete a player with a withdrawal still in escrow.

Two rules follow, both now mechanical:

1. **A module nothing imports is dead**, whatever it exports.
   `check:dead-code` reports orphan modules and fails on them. Deliberate
   exceptions go in `ORPHAN_ALLOW` **with a stated reason** — adding a line
   there is a decision, not a silencer.
2. **A test that reads a file's source is not a consumer of it.** Asserting a
   money guard against unreachable code is worse than having no assertion,
   because it reports the guard as present. When a test names a path, check that
   something *imports* that path.

## A type that lies is worse than no type

`admin-panel/src/types.ts` declared `User._id`. The server has never sent one:
the users repository and the KYC queue query both emit `userId`. TypeScript
could not catch it, because **the interface was the thing that was wrong** —
every `u._id` typechecked and was `undefined` at runtime.

What that produced, none of it looking like an error:

- Every user-scoped call from the admin panel built
  `/api/admin/users/undefined/…`. Block, unblock, delete, balance adjust, roles
  and phantom access all 404'd into a caught error and an empty state.
- On the KYC screen, `setSelectedId(u._id)` stored `undefined`, so
  `find(u => u._id === selectedId)` matched the **first** row every time —
  a reviewer clicking the fifth player read the first player's record — and
  `active = selected?._id === u._id` rendered **every** row highlighted.
  Approving grants full withdrawal access.

The fix that found every call site was renaming the field in the interface and
letting `tsc` list them. A search would have missed one, and a missed one is a
silent 404. **When a panel type names an id, check it against what the mapper
actually emits** — `toOrder` and the merchants mapper alias `_id` deliberately;
`toUser` does not.

Two related failures worth the same suspicion:

- `req.user?.id` in three rate limiters. `authenticate` sets `req.user` from the
  users repository, which returns `userId`. So every limiter silently fell
  through to its IP fallback — including the withdrawal cap and the 2FA
  brute-force guard, whose comment described the account-takeover it was no
  longer preventing. Per-IP throttles CGNAT'd players together and limits nobody
  willing to reconnect.
- `.save()` on a repository row. It is a TypeError, the route's `catch` turns it
  into a 500, and nothing is written. `check:settable` refuses `.save`,
  `.populate`, `.toObject` and `.lean` outside a `typeof … === 'function'` guard.

## One owner per value, mechanically

`04-GOVERNANCE.md` §1 has always said derive, do not duplicate. Say it here in
the form it keeps being violated: **the same payload assembled in two places
drifts, and it drifts silently.**

The system-config payload was built twice — once in `socketHandlers.js`, once in
`GET /api/v1/system/config` — with independently written fallbacks. They had
already diverged: the socket carried `webUrl`/`androidUrl`/`iosUrl`, the HTTP
route carried `kycRequired`/`registrationEnabled`, and a client got a different
answer about the platform depending on which one it happened to ask.

A value an operator can edit is only config if **every** consumer reads the same
owner. Two builders with matching defaults are not one owner; they are one bug
waiting for the next field.

## No path that only works on one machine

`verify-ui-coverage.mjs` shipped with `const ROOT = '/home/user/bettingbazaar'`
— the author's own checkout, baked in. It passed locally and could not run
anywhere else; CI died at the first `readFileSync`. Derive a root from
`import.meta.url`, read a location from configuration, and never write an
absolute path that assumes a particular machine. Running a script from the repo
root is not evidence it runs — run it from somewhere else.

## Do not call it perfect

`Do not claim readiness` above governs the money path. This governs everything
else, and it is the rule most often broken here.

**"Clean", "complete", "perfect", "nothing missing" and "production-ready" are
claims about evidence, not impressions.** Every one of them requires naming the
gate that was run and the number it printed. A green CI run is not that claim:
CI was green on every commit while all five dead buttons were live, because
nothing was looking for them.

When asked whether something is finished, answer with what was checked and what
was **not**. An honest "I verified the handlers; I never checked that a button
calls them" is worth more than a confident summary, and this session is the
proof: that exact unasked question was hiding five defects, a duplicated config
payload, and 71 endpoints no screen reaches.

Absence of a failing check is not evidence of correctness when no check covers
the thing being claimed.

---

## A denylist protecting a person fails open

`sanitizeMerchantOrder` deleted `userPhone` and `merchantSnapshot`, and deleted
the player's payout destinations only on the DEPOSIT branch. So on **every
withdrawal** the merchant received `userBankDetails.upiId`, copied straight from
the player's profile — and the merchant panel had a render waiting for it
(`OrderCard`'s "Send to user UPI"), while its order search matched on
`order.userPhone`, letting a merchant look a player up by phone number.

Three separate checks were green throughout. None of them was looking.

**A merchant may see the bank account a withdrawal pays and the name on it.
Nothing else identifies the player to them** — not the phone number in whole or
in part, not the UPI ID (which resolves to both), not a CDM receipt after it is
submitted. **A player never sees the merchant's personal details** — only the
payment link.

Three rules follow, all mechanical via `check:merchant-privacy`:

1. **The projection is an allowlist, and it lives in one file.**
   `backend/domains/merchant/merchantOrderView.js` is the only shape a merchant
   receives. A denylist admits the next column added to `order_states` by
   default and the mistake is always "too much"; an allowlist fails closed, and
   its symptom is a blank field somebody notices.
2. **Assert the key set, not the field.** A test that checks `userPhone` is
   absent is the denylist again, written as a test. The suite asserts the
   response's keys are a **subset** of the declared allowlist, so a new leak
   fails without anybody adding a line.
3. **A field the panel's type names is a field somebody will render.** The gate
   reads the forbidden list from the server module and fails if
   `merchant-panel/src/types.ts` declares any of them.

The same audit found two fields the panel read that no responder has ever sent:
`shortId` (declared non-optional) and `rejectionReason` — the server calls it
`rejectedReason`, so **every rejection rendered its generic fallback and the
merchant never saw the reason**. Same class as `User._id`; same fix — rename in
the interface and let `tsc` list the call sites.

---

## The same rule points BOTH ways

`sanitizeMerchantOrder` was one half. The other half had nothing at all: every
player-facing response carried `merchantSnapshot` **whole** — the merchant's UPI
handle, their QR image, their bank account number, IFSC and the name on it, and
their USDT settlement address — on order creation, on the order fetch, on the
dispute response, on the assignment socket push, and every few seconds on the
status poll. The player's screen rendered the handle in a copy-to-clipboard row.
None of the bank fields is needed to pay a UPI handle. A player could read, copy
and keep a merchant's account number from a single deposit.

**A player sees where to pay and nothing about who they are paying** — a payment
link, an opaque `Merchant #<ref>`, a deadline. `backend/domains/payment/
playerOrderView.js` is that shape, an allowlist for the same reason the merchant
one is, and `npm run check:player-privacy` enforces it.

Three things this cost, all of them findings a route-file scan could not make:

1. **A gate that reads one file protects one file.** `check:merchant-privacy`
   scanned `merchant.routes.js` and was green for as long as it existed, while
   `paymentProcessing.service.js` spread the WHOLE order — `...order` — onto the
   merchant's stream at assignment, and `sse.routes.js` pushed `page.orders`
   RAW in `merchant_orders_snapshot`, to every merchant, on every connect. Both
   carried the player's phone number, their bank details, the treasury split and
   the risk verdicts on them. **A channel is a responder wherever it is
   written**: both gates now read the whole backend for pushes, not a list of
   route files.
2. **A spread defeats a key scan.** `{ ...order, server_ts: Date.now() }` names
   one permitted key and carries thirty forbidden ones. Both gates read spreads
   separately; on a player response a spread is permitted only from a producer
   whose returned `order` the gate has itself verified, and the chain to it —
   `res.json({ ...result })` ← `requestDeposit` ← `adapter.createDeposit` ←
   `createDepositOrder` — is stated in the gate rather than assumed.
3. **The link has one owner and the client is not it.** The panel used to build
   the `upi://pay` intent from `merchantSnapshot.upiId`, which is WHY it had to
   be given the handle. Building it on the server (`paymentLink.js`) is what
   makes the rule structural: there is nothing left in the payload to build one
   from. Note honestly what this does not do — a `upi://pay` intent carries the
   payee, so the payer's own banking app will show it. The platform stops
   publishing the merchant's identity; it cannot hide a payee from a payer.

And a fourth, which is trap 11 in a new costume: **an apostrophe in a comment is
an opening quote to a bracket counter.** `// one owner of the player's shape`
swallowed the rest of a return literal, and the producer check reported no
`order` key in a function that plainly returns one — a check measuring zero
things, reading exactly like a pass. Every scan blanks comments first
(`scripts/lib/privacyLists.mjs`), and a producer that yields nothing to check is
now a failure rather than a silence.

---

## A webhook that mints

The USDT rail has no merchant. Above the ₹10,000 INR ceiling a player pays the
platform's BTCPay Server directly and the tokens are **minted** — `TOKEN_SUPPLY
→ USER_FLOAT`, under the same supply cap as any other mint. So
`POST /api/payment/usdt/webhook` is a route with **no session** that creates
money, and everything about it follows from that.

1. **The HMAC is the whole of the authentication, and it is over the RAW
   BYTES.** `domains/casino/webhookSignature.js` digests
   `JSON.stringify(body)` — a re-serialisation — and its own header records
   that as a known limitation. It is not repeated: `usesRawBody` (one owner,
   `domains/funding/webhookRawBody.js`) is read by both `server.js` and the
   webhook's own suite, because a JSON parser reaching that route first makes
   the digest `[object Object]` and refuses **every legitimate callback** while
   a route test mounting its own raw parser stays green.
2. **A missing signature is a REJECT and an unconfigured secret is a REJECT.**
   Unverifiable and authentic are not the same thing.
3. **A valid signature does not mean a fresh request.** Anyone who captures one
   signed body can replay it forever, and BTCPay retries on its own. Freshness
   is not the HMAC's job: the guarded transition and the UNIQUE `tx_id` on
   `usdt_deposits` are what stop a second credit, with the wallet's own
   `dep_complete_<id>` gate underneath.
4. **The callback names an invoice. It never names an AMOUNT.** `token_paise`
   is written when the invoice is created, from the rate live at that moment,
   and the credit reads the ROW. Trap 7 applied to an external system: the
   number that gates a transfer is read from the rows the write will lock.
5. **Settled and credited are different facts**, and `credited_at` is what
   separates them. The gap is the crash window — a player who paid and whose
   wallet has not moved — and it is a row an operator can find
   (`GET /api/admin/usdt-deposits/uncredited`) rather than a silence they
   cannot. Reconciliation READS BTCPay; it does not credit, because a second
   money path beside the webhook is how `moveDepositMoney` came to exist.

### Two gates that were measuring the author, not the code

Both were found by adding one router, and both had the same shape: **a gate
holding its own copy of something the code already states.**

- `check:ui-coverage` mapped router file → mount prefix in a hand-written
  table. A new router mounted and served was reported as eight DEAD BUTTONS,
  because the table had never heard of it. The prefixes are derived from
  `server.js`'s own `import` and `app.use` now — which immediately found five
  routes the table had been missing in the other direction.
- `check:settable` compared every `set: { … }` in the backend against the
  ORDER lifecycle's `SETTABLE`. The day a second lifecycle arrived it reported
  that one's perfectly valid `set` as a field the order writer would refuse: a
  false failure, which is how a gate loses the reader's trust and gets
  silenced. A `set` is now checked against **the writer it is handed to**
  (aliases and ternary callees resolved), and a `set` handed to a writer the
  gate does not know is reported as unattributed rather than passed.

**A gate whose failure mode is "the author forgot to update me" reports the
author.** Derive what it checks from the thing it is checking.

---

## Commands

| Command | What it proves |
|---|---|
| `npm run check:no-mongo` | The single-store rule holds. **The definition of done.** |
| `npm run test:unit` | Money arithmetic, risk validation, cycle types, SSE, winners. |
| `npm run test:pg` | Money-path behaviour against a real PostgreSQL. |
| `npm run check:deps` | No circular imports, no governance boundary violations. |
| `npm run check:ui-coverage` | Every panel call reaches a real route. `--unused` lists endpoints no screen calls. |
| `npm run check:dead-code` | No export is referenced by nothing, and no module is imported by nothing. `--all` lists test-only and over-exported ones. |
| `npm run check:settable` | Every order-lifecycle `set` names a column the writer accepts — the write that runs after the state has already committed. |
| `npm run check:db-boundary` | No SQL, driver or relative reach past `#db`. |
| `npm run check:orphans` | Every identifier used is declared, imported or a parameter. |
| `npm run check:balance-reads` | Trap 7, mechanically: a number that GATES a transfer is read from the rows the write will lock. |
| `npm run check:coherence` | Every column the repositories name exists in the schema. |
| `npm run check:merchant-privacy` | A merchant is told the payout account and the name on it — never the player's phone or UPI ID. |
| `npm run check:player-privacy` | A player is told where to pay — never the merchant's UPI handle, QR, bank account or the name on it. |
| `npm run verify:capabilities` | Every claimed capability has its evidence on disk. |
