# The security audit map

**This is the standing record of what has been examined, what has not, what was
found, and what was done about it.** It is meant to be read before any audit
work starts and updated in the same commit as any audit work that finishes.

It exists because an audit written once is wrong within a week and does not say
so. Someone adds a route with no auth and the prose still reads "40
unauthenticated routes, all reviewed" — and a reader cannot tell "examined and
clear" from "written before this code existed". At that point the document is
not evidence any more, it is decoration. `CLAUDE.md` §29 is the rule this
implements: absence of a failing check is not evidence of correctness when no
check covers the thing being claimed.

| | |
|---|---|
| Rules for the codebase | `CLAUDE.md` — the only rules file |
| What is built, what is left | `docs/PROJECT_STATUS.md` |
| The working audit log, dated | `docs/audit/2026-09-10-SECURITY-AUDIT.md` |
| **This file** | the map: classes, coverage, findings, sweeps |
| Keeps the numbers here honest | `npm run audit:map` |

---

## 0. How this file stays true

Three mechanisms, because prose alone does not.

1. **The numbers are derived, not typed.** §5 is written by
   `scripts/audit-map.mjs` from the codebase itself. `npm run audit:map --
   --check` fails when it drifts. A count that moved means a route, a query or a
   render sink appeared or vanished and somebody has to decide whether that is
   safe — **the gate cannot decide that, and does not pretend to.** It forces the
   reading; it does not replace it.
2. **Every class in §2 carries its own status and the date it was last run.** A
   class with status `NOT EXAMINED` means exactly that, and nothing about it may
   be claimed in either direction.
3. **Every finding gets a class sweep (§1).** Fixing one instance of a bug and
   leaving its siblings is how the same defect ships three times — this codebase
   has already done that with `setOrderFields` (`CLAUDE.md` §21).

### When you change code

- Ran audit work? Update the class row in §2 **and** add to §4.
- Fixed a vulnerability? §4 entry, **and the sweep in §1 is mandatory.**
- Touched routes, SQL, or a panel render? `npm run audit:map` and read the diff.

---

## 0.5 The failure mode of the AI doing this audit — read this before you start

**Every serious defect in this register was found only after the owner pushed
back. Not one surfaced from a first pass.** That is not a run of bad luck; it is
a reproducible failure mode, and it is written here because the next session
will have it too.

### What it looks like from the inside

The pattern is always the same, and it always feels like competence:

| The step | What it looks like | What it actually was |
|---|---|---|
| A gate is green | "This class is covered." | The gate measured something adjacent. `check:dead-code` counted a **test import** as a consumer, so an unused money mechanism read as live (F-018). |
| A test passes | "This behaviour is proven." | The test drove a route **no screen calls**, while the route users hit had no such test (F-017). |
| A comment explains a design | "Somebody decided this, so it holds." | The comment described the intent; the code had drifted from it. `merchant.routes.js` said *"the transition is the gate"* while that ordering was losing player money. |
| Two things do the same job | "Duplication — untidy, low priority." | They had **diverged**, and the one with no tests was the one in production (F-017). |
| A check exists | "Then the thing it checks is safe." | The check was a **snapshot**. Nothing kept its answer true afterwards (F-018). |

### The four questions that actually found things

Each of these, applied deliberately, produced a real defect in this codebase.
None of them is expensive. All four were skipped on the first pass.

1. **"Does anything actually CALL this?"**
   Not "does it exist", not "is it tested". Follow the path from a real button
   to the code. F-016 (a merchant could not set their own QR), F-017 (the money
   tests were on a dead route) and F-018 (the reservation mechanism has no
   callers) are all the same question, unasked.

2. **"Is this check a snapshot or a guarantee?"**
   A read that gates an action performed *later, in another request* is a
   snapshot. Ask what could change in between and what stops it. This is F-018
   exactly, and it is the same shape as §9's display-vs-decision rule one level
   up.

3. **"If this fails HALFWAY, what does the row say?"**
   Not "does it error" — what STATE is left, and can the user still act from it.
   F-017's whole severity was that the order read COMPLETED, which shut the
   dispute door. §21 is this question written down; it still got missed.

4. **"Am I fixing the symptom or the cause?"**
   State the chain out loud, upward, until it stops. F-017's fix was real and
   still only a symptom: the owner asked why an under-funded merchant held the
   order at all, and that question — not the fix — is what produced F-018.

### The rule that follows

**A finding is not finished when it is fixed. It is finished when you have
asked what had to be true for it to exist**, and checked whether that thing is
still true elsewhere. §1's class sweep searches sideways for the same shape;
this searches *upward* for the cause. Both are required, and the upward one is
the one that gets skipped, because a passing test at the bottom of the chain
feels like an answer.

### And the honest version of "verified"

§29 already forbids claiming readiness without naming the gate and its number.
This adds the other half: **naming a gate is not enough if nobody has asked what
the gate cannot see.** Every gate in this repository has a blind spot, several
are recorded above, and at least one of them was actively hiding a defect while
reporting green. When reporting a class as clear, say what was checked, by what,
**and what that check is structurally unable to notice.**

---

## 1. The class sweep — the rule that makes a fix worth something

**A vulnerability is never one line. It is one instance of a shape.**

When a defect is found, the fix is not finished until the codebase has been
searched for *every other place the same shape occurs*, and the result recorded —
including "swept, none found", which is the most valuable outcome to have written
down, because the next reader would otherwise redo it.

The procedure, every time:

1. **Name the shape**, not the line. Not "`getMerchantOrder` was swapped for
   `getOrderRecord` in the CDM handler" but *"a scoped reader was widened to an
   unscoped one to reach a field"*.
2. **Write the query that finds the shape** — a grep, a script, a gate. Put it in
   the §4 entry so it can be re-run.
3. **Run it over the whole codebase**, not the file you were in.
4. **Record every hit and its verdict**, including the ones that turned out fine
   and why.
5. **Ask whether a gate can hold it.** If the shape is mechanically detectable,
   a check under `scripts/` is worth more than a fix — the fix closes one
   instance, the gate closes the class forever. This is where
   `check:settable`, `check:merchant-privacy` and `check:payment-references`
   came from.
6. **If no gate is possible, say why** in the entry. "Not mechanisable because
   it needs a judgement about intent" is a real answer; silence is not.

Precedents in `CLAUDE.md` for why this is not optional: `setOrderFields` shipped
the same defect **three times in three files** (§21); the same
`fiat_amount_paise` currency confusion had **a second mouth** in an aggregate
nobody looked at (trap 15); a payment reference was claimed on one path and
written raw on two others (§27).

---

## 2. The examination catalogue

Every class of examination, why it matters here specifically, how to run it, and
where it stands. **Status values:** `CLEAR` (examined, nothing found) ·
`FINDING` (see §4) · `PARTIAL` · `NOT EXAMINED`.

### 2.1 Authentication — can an anonymous caller reach this?

**What.** Every route, and whether any middleware in its chain establishes an
identity.

**Why it matters.** The obvious answer. The non-obvious part is that *some routes
must be public* — health probes, webhooks, the login itself, the public cycle
feed — so the count is never zero and cannot be a gate on its own. The finding is
always "this specific one should not be public", which needs a person.

**How.** `npm run audit:map` lists every route with no auth middleware. Read each.
Watch for auth done *inside* the handler (the SSE streams do this, correctly,
because `EventSource` cannot send headers).

**Status: CLEAR** (2026-09-10). All 40 read. Every one is either legitimately
public or authenticates in-handler.

### 2.2 Authorization — the caller is *someone*, but are they *allowed*?

**What.** Whether the identity established is checked against what the route
does. In this codebase: full admin vs sub-admin vs which of the nine permission
keys.

**Why it matters.** This is the most common serious flaw in a real system, and it
is invisible to testing, because the panel only ever shows a user the buttons
their role allows — so the API is never exercised the way an attacker exercises
it. **A control enforced only in the client is not a control.**

**How.** `npm run audit:map` counts routes gated `isAdminOrSubAdmin` with no
permission key. Then read them: does this route do something every sub-admin
should be able to do?

**Status: FINDING — F-001** (2026-09-10). See §4.

### 2.3 IDOR — whose row is this?

**What.** Any route taking an id from the request, and whether the read or write
is scoped to the caller.

**Why it matters in iGaming specifically.** The ids are money. An order id is a
payout; a user id is a wallet and an Aadhaar; a merchant id is a float. And the
scoped/unscoped readers usually sit side by side with near-identical names, so
widening one to reach a field is a one-word edit that no test notices —
`CLAUDE.md` trap 16 is exactly that, and it let **any merchant attach their cash
slip to any payout**.

**How.** Extract each handler body; find `req.params.*Id` / `req.body.*Id`; check
the caller's own id appears *in the same call* that reads the row, not merely
somewhere in the function (an audit-log mention does not scope anything).

**Status: CLEAR** (2026-09-10). No unscoped non-admin route. Verified by hand:
`/v1/user/:id/data`, `/user/:userId/transactions` (explicit 403);
`/merchant/accept/:id` (403 unless unassigned — the open pool is the design);
`/merchant/orders/:id/reject` (scoped, and the proof is bound to merchant **and**
order); `/merchant/stats`.

### 2.4 Cross-surface token confusion

**What.** Whether a token minted for one audience is accepted by another —
player on merchant routes, merchant on admin routes, a 2FA *challenge* used as a
session.

**Why it matters.** Three panels signed with one key is the setup for it. The
challenge-token case is the sharpest: a challenge proves only that a password was
accepted, and if it is honoured as a session then **2FA is bypassable with the
password alone, while appearing to be enforced.**

**How.** Read `authenticate` and `merchantAuth` end to end; ask what claim each
requires and whether the privileged flag comes from the token or the row.

**Status: CLEAR** (2026-09-10). Challenge tokens rejected explicitly by both.
`isAdmin` reads the **users row**, never the token. Both re-read the row and
re-check `isBlocked` / merchant status on every request.

### 2.5 SQL injection

**What.** Every query, and whether request data can reach statement *text* rather
than a parameter.

**Why it matters.** `check:db-boundary` proves SQL is confined to `#db`. That is
a different claim from the SQL inside being parameterised, and it is easy to
mistake one for the other.

**How.** Find every `pgQuery` with a `${}` in the template. Trace each
interpolation to its source. Safe shapes: module-level column constants;
allowlist maps that **throw** on an unknown key (or better, iterate the allowlist
so a caller's key never reaches SQL at all); two-literal ternaries; `$n`
placeholders; numerically clamped limits.

**Status: CLEAR** (2026-09-10). 392 sites, 250 parameters-only, 142 interpolating
— all 142 traced, none can carry request data. Also checked: no raw
`client.query` outside `#db` interpolates a value.

### 2.6 Money-path integrity and concurrency

**What.** Whether a balance can be double-spent, a payout paid twice, or a
settlement lost to a race.

**Why it matters most here.** Every other class costs data; this one costs money
and cannot be reversed. `CLAUDE.md` §19 lists the six invariants that must hold
(integer paise in `BIGINT`, `SELECT … FOR UPDATE`, append-only double-entry,
unique `tx_id`, transition tables, `CHECK` constraints).

**How.** Read decisions and writes together. A check-then-act across two
statements is a race; the guard belongs *inside* the `UPDATE`'s `WHERE`. Idempotency
must be a unique constraint, not a prior read. Never mock the boundary that
carries money (`CLAUDE.md` §1) — test through it against a real database.

**Status: EXAMINED 2026-09-10 — the core holds; one reporting gap (F-015).**

**What was read, and what it says.** Every balance-mutating write in the
platform was traced to its guard:

| Path | How the guard is enforced | Verdict |
|---|---|---|
| Player wallet (`wallets.core.js`) | relative deltas (`col = col + $n`) with `AND col + $n >= 0` **in the UPDATE's WHERE**, ledger row in the same transaction, UNIQUE `tx_id` colliding inside it | correct |
| Merchant wallet (`merchantWallets.core.js`) | `SELECT … FOR UPDATE` on the row, same WHERE-clause guard, same in-transaction ledger | correct |
| Treasury (`treasury.js`) | reads `balanceBefore` in JS and writes an ABSOLUTE `balance_paise` — which would be a lost update — but the read is `SELECT … FOR UPDATE … ORDER BY account`, so the row is held for the whole transaction and the ordering removes the deadlock | correct, and the ORDER BY is load-bearing |
| Bonuses (`bonuses.core.js`) | pool movement first, then `applyMovementWithin`; refuses rather than partial-issuing | correct |
| Cycle pools | derived from `bets`, never stored on the `cycles` row (trap 4) | correct |

**What was newly PROVEN rather than read.** `merchantWalletPg.test.js` contained
**no concurrent exercise at all**, and the merchant's available balance is what
gates every deposit completion — a player has already sent real money by the
time `moveDepositMoney` asks whether the merchant can cover it. The design was
documented as correct and nothing had demonstrated it.

`database/tests/merchantWalletConcurrencyPg.test.js` now does, and it is
**mutation-proven rather than merely green**:

- guard deleted from the UPDATE's WHERE → **2 tests fail** (the balance lands at
  −50,000 with five confirmations paid from tokens that never existed);
- a `tx_id` collision made to report success → **1 test fails**.

It also guards the two ways a concurrency test lies. It asserts the pool can
actually hold its own fan-out, because a pool of one serialises the callers and
turns the whole file into a check that measures nothing (§24.6); and it
namespaces every merchant id, truncates nothing and asserts only over its own
rows (trap §20.10) — unlike the two sibling files, which TRUNCATE the shared
table and are safe only because `fileParallelism` is false.

**One thing the cleanup taught, worth keeping.** The file's first draft deleted
its own ledger rows in `afterAll` and the append-only trigger refused it. The
cleanup was changed to fit the invariant rather than the invariant worked
around: a ledger row is not a test fixture, and a suite that can delete one has
taught itself a capability production must never have.

**Still not covered, stated plainly (§29).** Settlement under concurrent bet
placement, and the crash-resume path, are exercised by `settlementEnginePg` and
`betPg` but not under a deliberate storm. This pass proved the wallet layer both
of those sit on; it did not prove the engine above it.

### 2.7 Privacy — both directions

**What.** What a merchant learns about a player, and what a player learns about a
merchant.

**Why it matters in P2P settlement.** The counterparty is a person, not a
processor. A merchant who learns a player's phone or UPI ID can contact them off
-platform; a player who copies a merchant's account number keeps it. Both have
happened here: `sanitizeMerchantOrder` was a denylist that stripped payout
details **only on the deposit branch**, so every withdrawal leaked the player's
UPI ID.

**How.** Each projection is an **allowlist in one file**, and the test asserts the
response's key set is a *subset* — so a new column fails without anyone adding a
line. A denylist admits the next column by default and its symptom is "too much";
an allowlist fails closed and its symptom is a blank field somebody notices.

**Status: CLEAR, and gated.** `check:merchant-privacy` · `check:player-privacy`.

### 2.8 External payment references

**What.** Every reference to a real-world transfer — bank UTR, chain tx hash, CDM
slip — and whether it is claimed exactly once.

**Why it matters.** One payment funding two orders is free money. The subtle part
is that the defect is a *column holding somebody else's reference*, not a
handler — which is why two paths (`cdm_transaction_id`, `usdt_tx_hash`) stayed
green under every handler-shaped check.

**How.** `check:payment-references`, matched **per field**.

**Status: CLEAR, and gated.** One instance fixed in this session — see F-004.

### 2.9 Rate limiting and brute force

**What.** Whether login, OTP, 2FA, withdrawal and order creation are paced.

**Why it matters.** And why it is easy to get wrong: a limiter can be mounted at
the **app** level rather than on the router (`server.js:517` does this for
merchant login), which reads like a gap until you check mount order. The opposite
error is worse — a second login path that skips the limiter and the captcha.

**How.** Inventory the limiters, then find every auth-shaped endpoint and check
mount order. Explicitly hunt for duplicate login paths.

**Status: CLEAR** (2026-09-10). All three logins paced; admin login also carries a
subnet limiter and a captcha; OTP request and verify each have their own bucket.
No duplicate or shadow login path exists.

### 2.10 Webhook authenticity

**What.** Every endpoint an outside system posts to.

**Why it matters.** They are unauthenticated by necessity and they move money.
The signature is the only thing between the open internet and a wallet write.

**How.** Verify: a signature is required; compared with `timingSafeEqual` behind a
length check; replay is handled. Replay protection can come from idempotency
rather than a nonce — the casino callback is idempotent on the supplier's `tx_id`
*inside the transaction*, so a redelivery is a no-op. That is a valid answer.

**Status: CLEAR** (2026-09-10). Casino wallet callback and both Telegram webhooks.
One robustness note recorded in F-005.

### 2.11 The identity root

**What.** Whatever a session is ultimately minted from. Here: Telegram + Aadhaar.

**Why it matters.** Everything else assumes it. A weak OTP or a
non-atomic single-use check undoes every control downstream.

**How.** Check: CSPRNG with no modulo bias; hashed at rest; single use enforced
*inside* the `UPDATE`'s `WHERE` (a read-then-write leaves a window both requests
pass); an attempt cap that burns the code; **no enumeration oracle** — the same
answer for wrong / expired / used / unknown, and errors swallowed after logging
so a 500 does not itself distinguish them; the user row re-read at redemption.

**Status: CLEAR** (2026-09-10), and notably well built. One finding on the
**recovery** path only — F-002.

### 2.12 Reachability — is it actually shipped?

**What.** Whether every panel call reaches a real route, and whether every route
is reached by a panel.

**Why it is a security class and not just hygiene.** A backend feature with no UI
is unreviewed attack surface that nobody is watching, and a panel call that 404s
renders an empty state indistinguishable from "no data" — five admin buttons did
nothing here for weeks, including a dispute queue that was permanently empty.
Both directions matter.

**How.** `npm run check:ui-coverage` (fails on a dead button) and `-- --unused`
(lists endpoints no screen calls — triage, not failure, because webhooks and SSE
belong on it).

**Status: CLEAR, and gated.**

### 2.13 State that must survive a restart or a second replica

**What.** Anything held in a module-level `Map`, a closure, or `global`, that a
*later request* depends on.

**Why it matters, and why it is easy to miss.** It works perfectly on one
machine. It fails only under a load balancer, only sometimes, and the failure
looks like user error. This platform is explicitly built for horizontal scale —
`realtimeBridge.js` calls itself "THE keystone for horizontal scale",
`validateEnv` demands `REDIS_URL` "at >1 replica" — so any in-process state is a
defect by default, not a shortcut.

**How.** Grep for `new Map()` / `new Set()` / `global.` at module scope, then ask
of each: *does a subsequent, separate request read this?* A cache that can be
rebuilt is fine. A step of a workflow is not.

**Status: FINDING — F-002** (2026-09-10). Swept; see the entry.

### 2.14 Client-side injection (XSS)

**What.** `dangerouslySetInnerHTML`, `.innerHTML =`, and anything rendering
server or user text as markup.

**Why it matters here.** Chat messages, support tickets, admin-authored
announcements, rejection reasons and merchant names all round-trip through the
panels. A stored XSS in the admin panel runs with an admin session.

**How.** `npm run audit:map` counts the sinks per panel. Every one needs a
reading: what reaches it, and is it sanitised at the point of render.

**Status: CLEAR** (2026-09-10). Zero `dangerouslySetInnerHTML` and zero
`.innerHTML =` across all 218 panel files; no `eval`, `new Function` or
`document.write`; every `window.location.href =` assigns a hardcoded literal.
`javascript:` URLs in a dynamic `href` are neutralised by React 19's
`sanitizeURL` — **verified in the shipped production build**
(`case "href": … value = sanitizeURL("" + value)`), not assumed from the version
number. Recorded as a dependency: the panels rely on a framework behaviour for
this, and any value that ever reaches a non-React surface (an email, the bot, a
PDF, a webview) has nothing behind it. The `javascript:` WAF rule that would be
the second layer is behind `FLAGS.WAF_FILTER`, **default off**.

### 2.15 File upload

**What.** `services/cdn.service.js` and the four upload categories (chat
attachments, payment proofs, branding assets, CDM receipts).

**Why it matters.** Content-type from the client is a claim, not a fact —
magic-byte detection is the check. A presigned URL scoped too widely lets a
caller overwrite someone else's object. Path traversal in a key writes outside
the prefix. And a payment proof is *evidence in a dispute*, so overwriting one is
tampering with a money decision.

**How.** Trace: who may request a URL, what the key is derived from, whether the
bytes are type-checked on arrival, whether the object is bound to the order and
actor that requested it (this codebase does bind — see `verifyUploadedObject`).

**Status: FINDING — F-006, fixed** (2026-09-10). The pipeline itself is strong:
MIME allowlist with no wildcards, extension↔MIME cross-check, an explicit
blocklist that names `.svg` / `.html` / `.js` with the reason ("XSS via CDN"),
the stored key's extension derived from the MIME rather than the filename,
filename charset and traversal checks, S3 enforcing both `ContentType` and
`ContentLength` on the presigned URL, and **magic-byte verification of the first
8 KB after upload**, with the object bound to uploader, order and category.

What was wrong was not the pipeline but who called it: six routes issue
presigned URLs and only one bound the stored URL back to the object. See F-006.

### 2.16 Secrets in responses

**What.** Credential columns reaching a response body.

**Why it matters.** The safest design is one this codebase already uses in
places: a reader that must be **asked for credentials by name**, so a handler
cannot leak what it never received. That is stronger than masking something you
did fetch.

**How.** Enumerate credential-bearing columns, then find every response that
spreads a row. **A spread defeats a key scan** (`CLAUDE.md` §24) — `{ ...order }`
names one permitted key and carries thirty forbidden ones.

**Status: CLEAR for credentials; FINDING for internal errors — F-008**
(2026-09-10).

**Credentials: clear, and the design is the reason.** All 27 reads of a
credential column across the whole data layer live in a function whose *name*
says what it returns — `getUserCredentials`, `getMerchantCredentials`,
`getActiveConfigSecrets`, `getActiveConfigWithSecrets`, `getLiveBotSecrets`,
`getBotSecrets`, `getProviderSecrets`, `getGatewaySecrets`, `getPendingAadhaar`,
`exportPending`. The ORDINARY mappers (`toUser`, `toMerchant`, …) emit none of
them, so a handler that spreads a whole row cannot leak a password hash however
careless the spread — which is the guarantee §24 says a key scan alone cannot
give you.

Every caller of those readers was then traced. The one that looked worst is
fine: `POST /api/game/launch` builds
`{ ...listed, ...openProviderSecrets(...) }` — decrypted provider credentials
spread into a local — but it uses them to sign and returns only
`{ success, launchUrl, sessionId }`.

**Internal error text: not clear.** See F-008.

### 2.17 Transport, cookies, headers

**What.** CORS origin list, cookie flags (`httpOnly`, `Secure`, `SameSite`), CSP,
HSTS.

**Why it matters.** `SameSite` on the session cookie is most of the CSRF defence
in an app with a cookie-auth panel. A permissive CORS origin with credentials
undoes it.

**Status: CLEAR, with one documented gap — F-009** (2026-09-10). The headers
were not read off the config and reasoned about; helmet was **invoked and its
output captured**, because `useDefaults` merges directives the config file never
names and reasoning about that is how you get it wrong.

What is actually emitted: `default-src 'self'` · `script-src 'self'` (**no
`unsafe-inline`, no `unsafe-eval`** — strict, and rare) · `script-src-attr
'none'` · `object-src 'none'` · `base-uri 'self'` · `form-action 'self'` ·
`frame-ancestors 'self'` · `upgrade-insecure-requests`, plus
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS with
`includeSubDomains`, `X-Frame-Options: SAMEORIGIN`, and COOP/CORP `same-origin`.
Helmet is mounted **before** the SPA handlers, and Express serves all three
panels' HTML, so the CSP lands on the document rather than uselessly on JSON.

**CSRF was already analysed here, correctly, and the analysis holds.** The
session cookie is `httpOnly` + `secure`, but `SameSite=None` in production
because the Capacitor/Android shell is a different origin — which removes
SameSite as a defence. CORS does not replace it: for a *simple request* the
browser SENDS the request and withholds only the response, so the mutation has
already happened. The mitigation is that **no urlencoded and no multipart parser
is mounted**, so a hidden auto-submitting form produces an empty `req.body`, and
anything sending real `application/json` triggers a preflight the allow-list
rejects. Re-verified rather than trusted: no multipart parser exists, and the
only `x-www-form-urlencoded` in the tree is **outbound** to Turnstile.
`server.js` labels this itself as "a vector fix, not a complete CSRF programme" —
that remains true and remains the honest description.

### 2.18 Public-route data leakage

**What.** What the unauthenticated routes actually return.

**Why it matters in iGaming.** Leaderboards and winner lists are *designed* to
expose players; the question is how much. A username plus a win amount plus a
timestamp is a targeting list. `/api/app/bootstrap` and `/r/:code` (open
redirect) need their own look.

**Status: FINDING — F-010, fixed** (2026-09-10). Each public route read for what
it actually returns:

| Route | Verdict |
|---|---|
| `GET /api/leaderboard/:period` | **Leaked `userId`** for the top 50, ordered by net profit — F-010, fixed. |
| `GET /api/v1/winners` | Clean, and the model for the fix: `realWinners` SELECTs `user_id` and its mapper simply never emits it. |
| `GET /r/:code` | **Not** an open redirect. The host is hardcoded `t.me`, both components go through `encodeURIComponent`, and the code must match `^[A-Za-z0-9_-]{4,32}$`. |
| `GET /api/app/bootstrap` | Clean — app name, origins, package ids, compliance booleans. All of it is on the store listing anyway. |
| `GET /api/v1/content/ai-analysis` | Clean — aggregate cycle results, no player data. |

### 2.19 Staff 2FA enforcement

**What.** Whether the second factor is actually required to hold a privileged
session, or only checked for accounts that happen to have enrolled.

**Why the distinction is the whole thing.** "2FA is mandatory for admins" and
"an admin who has enrolled must present a code" are different claims. The second
is a property of the login handler; the first needs a guard that refuses
privilege to an account with no second factor at all. A policy with no
enforcement point reads as a control on every page that mentions it.

**How.** Find the predicate that decides who must hold a factor, then find every
place it is CONSULTED. If the only consumers are the 2FA screens themselves, the
policy does not gate anything.

**Status: FINDING — F-011** (2026-09-10). See §4.

### 2.20 Identifier predictability

**What.** Whether order, user or reference ids can be guessed or enumerated.

**Why it matters.** It sets the cost of every other flaw. An IDOR on random
128-bit ids is theoretical; the same IDOR on sequential ids is a script.

**Status: EXAMINED 2026-09-10 — CLEAR except F-014.** What was actually
checked, so a later reader knows what this claim covers:

| Identifier | How it is made | Verdict |
|---|---|---|
| Order ids (`DEP_`, `WD_`, `MAT_`, `clk_`) | `crypto.randomBytes(12)` hex — 96 bits | fine |
| Every repository row id | `randomBytes(12)` in `users/engagement/content/social/referrals.js` | fine |
| Telegram login token | `randomBytes(32).toString('base64url')` — 256 bits | fine |
| Webhook secrets | `randomBytes(32)` hex | fine |
| Sign-in OTP | `crypto.randomInt(0, 1e6)` — **and 5 attempts, enforced in the UPDATE's own WHERE**, with the attempt charged against the live row and the row consumed at the cap | fine, and the attempt cap is what makes 20 bits enough |
| Referral code | 8 chars of a 31-char Crockford-ish alphabet from `randomBytes` — ~39 bits, with a slight modulo bias (256 % 31 = 8) | fine; a referral code is public by design and is not a bearer credential |
| `BIGSERIAL` primary keys | sequential | fine — none is a route parameter; every route keys on the random public id |
| Client idempotency keys (`Math.random`) | `k-<ms>-<random>` from the panels | **fine, and worth recording so it is not re-flagged**: the server builds `bet_${userId}_${clientKey}`, so the key is scoped by user and a guessed one cannot reach another player's bet |
| Confetti angles/delays | `Math.random` | fine — §11, UI-only |
| **Gift codes** | **`Math.random()` in the admin panel** | **F-014** |

Two unscoped `getOrderRecord(req.params.id)` reads were checked against trap
§20.16 and are both correct: `POST /merchant/accept/:id` must read unscoped
because an unassigned order is claimable from the open pool, and it follows with
an explicit `order.merchantId !== req.merchantId → 403`; the other is an admin
reassign route, where unscoped is the point.

Also found here and not a security finding, but a §14 dead artifact:
`user-panel/src/services/realBackend.ts:877` `resetMerchantPassword` returns
`'Merchant@' + Math.floor(100000 + Math.random() * 900000)`, `console.warn`s
"No backend route", and sets nothing. Nothing calls it. `check:dead-code` cannot
see it because it scans exported NAMES and this is a class method — the same
blind spot §22 describes for default exports.

### 2.21 Dead and unreachable code

**What.** Modules nothing imports, exports nothing references, guards that are
no-ops.

**Why it is a security class.** Because it lies. A no-op `commitOrEnd` reads as a
transaction. A locked-balance guard in a dead file made a test pass while the
**live** route would soft-delete a player with money in escrow (`CLAUDE.md` §22).
Dead code does not just fail to help; it reports safety that is not there.

**Status: CLEAR, and gated.** `check:dead-code` · `check:orphans` ·
`check:settable`.

---

## 3. What no gate here can do

Stated plainly so nobody reads a green run as more than it is.

- **It cannot tell safe from unsafe.** Every count in §5 is a prompt to read.
- **It cannot see intent.** A new public route may be a health probe or a
  takeover.
- **It cannot cover a class nobody has written down.** §2 is the coverage claim;
  anything absent from it is absent from the audit too.
- **A green CI run is not an audit.** CI was green on every commit while five
  admin buttons were dead, because nothing was looking for them.

---

## 4. Findings register

Every finding, open or closed, with its class sweep. **An entry without a sweep
is incomplete** (§1).

### F-001 — sub-admin permission model enforced only in the client
`PARTIALLY FIXED` · high · broken access control · found 2026-09-10 ·
**writes gated 2026-09-10; reads proposed, awaiting approval**

**The four writes are gated.** `PUT /api/admin/merchants/:merchantId/scoring` —
the one that shapes where a player's money is routed — now requires
`canManageMerchants`, and the three promo writes require `canManageContent` (or
its documented `canManageSupport` alias). `npm run audit:map` reports **0**
sub-admin writes without a permission key.

**The 47 reads are proposed, not shipped**, because the owner confirmed
sub-admin accounts are IN USE: gating a read a colleague depends on blanks their
screen mid-shift. The table is `docs/audit/SUBADMIN-PERMISSION-PROPOSAL.md`.

Its rows are not guesses. The admin panel's `NAV_GROUPS` already declares which
key each screen requires, so where a route is reached from a screen the proposed
key **is the key that screen is already gated on** — the server was the half
that was missing. 33 rows are confirmed that way; 11 map to screens the panel
already marks `adminOnly`; 3 are flagged ⚠ for the owner because no screen calls
them and the panel's own answer looks wrong (the gift-code reads sit under
`canManageContent`, which lets whoever edits FAQ pages read who was paid).


`hasPermission()` is correct and applied to some routes; the rest are gated by
bare `isAdminOrSubAdmin`, which asks only *are you a sub-admin* and never *which
of the nine keys do you hold*. The admin panel gates its sidebar on those keys,
so for that set the model is client-side only.

A sub-admin holding only `canModerateChatPublic` can read any player's record and
financial history, the revenue ledger, the financial reports and a merchant's
wallet ledger — and can **write** `PUT /api/admin/merchants/:merchantId/scoring`,
which sets merchant concurrency caps and so shapes where players' money is
routed.

- **Shape:** an authorization *tier* check standing in for a *permission* check.
- **Sweep query:** `npm run audit:map` — the count and the write list are in §5.
- **Swept:** yes, whole `backend/**`. Live counts in §5.
- **Not fixed.** Which key each route should carry is a decision about the role
  model, not a mechanical substitution. The scoring write is the one that should
  not wait.
- **Gate possible:** yes — fail the build on a route under `/api/admin` carrying
  `isAdminOrSubAdmin` with no permission key and no reasoned allow-list entry.
  Not yet written.

### F-002 — account recovery holds its half-finished state in process memory
`FIXED` · medium · distributed-state · found 2026-09-10 · fixed 2026-09-10

`recoverySessions` (`backend/domains/telegram/telegram.routes.js:413`) is a bare
`Map` holding the Aadhaar a player sent to the recovery bot until their second
message arrives. Behind a load balancer the two messages land on different
instances and the second answers *"Please send your 12-digit Aadhaar number
first"* to somebody who just did — intermittently, looking like their mistake, on
a path they only reach because they have already lost access. The size cap is a
`clear()` at 10,000, which wipes live sessions rather than old ones, and a deploy
drops every recovery in flight. It is also the one place an Aadhaar sits in the
heap as plaintext, against `CLAUDE.md` §2.

- **Shape:** module-scope mutable state that a *later, separate request* reads.
- **Sweep query:**
  `grep -rn "^const .* = new \(Map\|Set\)(\|^let .* = new \(Map\|Set\)(\|global\." backend --include=*.js | grep -v tests`
- **Swept:** see §4.1 below.
- **Fix:** `telegram_recovery_sessions` — one row per Telegram id, `expires_at`
  in the row, `ON CONFLICT DO UPDATE` so a corrected typo replaces rather than
  being refused, and a `cardinality(aadhaar_hashes) > 0` CHECK so an empty array
  cannot read as a live session that can never match.
- **It came out stronger than the Map, not merely equivalent**, and that was not
  the plan — it fell out of reading what the consumer actually does.
  `attemptRecovery` only ever *compared* the Aadhaar, so it never needed the
  number: the route now calls `hashAadhaarCandidates` at the bot boundary and
  stores **HMAC candidates, never the digits**. The plaintext lives for the
  length of one function call. The heap copy this finding was about does not
  exist in any form now, and what is at rest is stronger than the AES-256-GCM
  ciphertext onboarding holds.
- **Expiry is in the SELECT, not left to the sweep** — `expires_at > now()` in
  the read — so a sweep that is late, failed or was never scheduled cannot make
  a stale Aadhaar usable. The retention sweep only reclaims space.
- **Consumed on every outcome**, success or failure, so a wrong contact share
  cannot be retried against an Aadhaar the sender already proved.
- **What the fix broke, and why that was the tests working.** Two structural
  tests in `telegramRecoverySafety.test.js` and the exact-shape retention count
  in `telegramPg.test.js` went red. None was a false alarm: the first two pinned
  the *old* location of the hashing and the Map's own housekeeping, and the third
  exists precisely so a new expiring table cannot be reclaimed silently — its
  comment says so. All three were re-pinned on the new shape rather than relaxed.
- **Gate possible:** partly. A gate could flag new module-scope `Map`s in
  request-handling files; it cannot tell a rebuildable cache from a workflow step,
  so it would need an allow-list with stated reasons.

### F-003 — merchant token purchase could be filed but never approved
`FIXED` · medium · constraint-vs-handler mismatch · `a53ee5c`

The transaction hash was optional at creation, and
`merchant_token_orders_approved_has_hash` refuses to approve a purchase carrying
a `usdt_amount` with no transaction — which every merchant-created purchase does.
The approve path mints and credits **before** writing the status, so the merchant
was paid, the CHECK rejected the status write, the handler 500'd, and the order
sat PENDING with tokens delivered. The one-per-day index then locked the merchant
out of filing a corrected one.

- **Shape:** a handler accepting input a database constraint will later refuse,
  where the refusal lands *after* money has moved.
- **Fix:** hash required at creation; covered by 11 tests through a real database.
- **Sweep:** partial. `CLAUDE.md` §21 already documents this shape for
  `setOrderFields` (three shipped instances) and `check:settable` gates the
  column-name half. **The constraint half — a CHECK that a handler can violate
  only after a commit — is NOT gated and NOT swept.** Carried to §6.

### F-004 — deposits refused while KYC was `PENDING_APPROVAL`
`FIXED` · medium · gate/service disagreement · `716b749`

`requireLinkedKyc` admitted `PENDING_APPROVAL` by design; `createDepositOrder`
then refused anything but `APPROVED`. Failed closed, so nothing unsafe happened —
but no newly-onboarded player could fund an account.

- **Shape:** two independent statements of one authorisation rule.
- **Fix:** both predicates now come from one side-effect-free module,
  `domains/identity/kycGates.js`, imported by the middleware and the service.
- **Swept:** yes. This is `CLAUDE.md` §2's "one owner per value" applied to a
  *predicate* rather than a number. Searched for other route-guard/service pairs
  restating the same condition; none found beyond this one.

### F-005 — casino webhook verifies a re-serialisation, not the raw body
`FIXED` · low · signature robustness · found 2026-09-10 · fixed 2026-09-10

`verifyWebhookSignature` computes the HMAC over `JSON.stringify(req.body)` — the
parsed body re-serialised — rather than the raw bytes the supplier signed. Key
order, whitespace and number formatting may differ.

**Not exploitable**: an attacker still cannot forge a signature without the
secret. It is a robustness defect — legitimate callbacks can fail verification —
recorded so it is not rediscovered as a suspected hole.

- **Shape:** verifying a signature over a re-encoding of the signed bytes.
- **Sweep query:** `grep -rn "createHmac" backend --include=*.js | grep -v tests`
- **Swept:** yes — this is the only webhook signature verifier.
- **Fix:** `verifyWebhookSignature` now accepts **either** — raw bytes first,
  the re-serialisation second. A superset of the old behaviour, so no supplier
  already working is broken by the change; a supplier signing the bytes they
  actually sent now verifies too.
- **The raw body is captured for that path only.** `express.json`'s `verify`
  hook stashes `req.rawBody`, scoped by prefix to `/api/game/wallet/`. Retaining
  the raw buffer for every request on the platform to fix one verifier would
  trade a robustness defect for a memory cost on every route.

### F-006 — a URL from a request body, stored and later rendered to somebody else
`FIXED` · high (two of the five are payment instructions shown to players)
· stored-URL binding · found and fixed 2026-09-10

`PUT /api/merchant/profile` wrote `qrCodeUrl` straight through:
`update.qrCodeUrl = qrCodeUrl`. No check that it was a URL, on this platform's
CDN, or related to anything the merchant had uploaded. An upload route exists
(`POST /api/merchant/qr/upload-url`) but **nothing bound the stored value to
it** — so the upload was a suggestion, and any string was accepted.

`qrCodeUrl` is on the player's allowlist (`playerOrderView.js`). It is shown to
them as **where to pay**.

What that costs, worst first:

1. **It leaks the player to a third party.** Every player assigned to that
   merchant loads an image from a host of the merchant's choosing, which learns
   their IP, their user agent, and the moment they were shown a payment screen.
   §24 is about not publishing identity across the P2P boundary; this publishes
   the *player's*, to somebody the platform never chose.
2. **A payment instruction hosted elsewhere can change after anyone reviews it.**
   Approving a QR you do not host approves a URL, not an image.
3. **The byte check is skipped.** `verifyUploadedObject` reads the first 8 KB and
   matches magic bytes; a URL that never went through the upload flow was never
   a file this platform saw.

- **Shape:** *a URL accepted from a request body and stored for later rendering,
  without being bound to an object this platform holds.*
- **Sweep query:**
  `grep -rn "\(logoUrl\|qrCodeUrl\|cdnUrl\|panelUrl\|fileUrl\|paymentLink\)" backend --include=*.js | grep -v "/tests/" | grep "req\.body\|update\.\|patch\."`
- **Swept: yes — and the sweep found four more.** The QR was not the worst.

| Site | Reaches | Was | Now |
|---|---|---|---|
| `merchants.qr_code_url` | **players** — where to pay | any string | must be on this platform's CDN |
| `cash_links.payment_link` | **players** — where to pay (ATM rail) | any string, stored raw | must be a `upi:` intent **naming a payee** |
| `promos.file_url` | **players** — every slide | any string, on BOTH create and edit | must be on this platform's CDN |
| branding `confirm-upload` | **all three panels** | caller-supplied `cdnUrl`, recorded unread | bound via `verifyUploadedObject` |
| `merchants.panel_url` | a merchant | any string | `https:` only |
| profile picture | the player themselves | — | **already correct**: bound via `verifyUploadedObject` |

The last row is why this was fixable cleanly: `verifyUploadedObject` already did
exactly the right thing — re-derives the URL from the key and refuses a
mismatch, confirms the object carries the right owner and category prefix, reads
the bytes — and one path used it. The others simply never called it.

- **Fix:** one owner, `backend/shared/storedUrl.js`, with three assertions
  (`assertCdnAssetUrl`, `assertPaymentIntent`, `assertExternalHttpsUrl`), wired
  into all five sites. 16 unit tests plus a route test through a real database.
- **Two details worth keeping:**
  - The CDN check compares **parsed origins**, never `startsWith`. A prefix test
    on `https://cdn.example.com` accepts `https://cdn.example.com.evil.test/x`.
    There is a test for exactly that.
  - It **fails closed** with no CDN configured: with no CDN there is no such
    thing as "our own asset", so there is nothing it can honestly accept.
- **Validation is on WRITE, not read.** Rows written before this keep rendering;
  refusing them at read time would blank a live merchant's payment screen to fix
  a problem they did not cause. The gate is the door, not the window.
- **Gate possible:** yes, and worth writing — a check that any column named
  `*_url` / `*_link` written from `req.body` passes through this module. Not yet
  written; queued in §6.

### F-007 — `cashLinkRoutes.test.js` only passes when another file runs first
`OPEN` · low · test isolation · found 2026-09-10

Three tests in that file fail when it is run alone and pass in the full suite —
it depends on the payment-mode policy some earlier file leaves behind rather
than establishing its own.

Found while fixing F-006, and worth separating carefully: **these failures are
not caused by F-006's change.** Verified by stashing the change and re-running —
the same three fail on the untouched tree. Recorded rather than fixed so that the
next person who runs one file and sees red does not go looking for a bug in the
code under test.

- **Shape:** a test asserting something about global state it did not set.
  `CLAUDE.md` trap 10 names the same hazard from the other side — never assert a
  global invariant over a shared table; take a baseline and assert the delta.

**Swept 2026-09-10 — two more instances found, both fixed, and both were caught
by running the suite TWICE rather than once.** That is the method this class
needs: the shared database is never reset, so a suite that passes on a clean run
and fails on the next is the signature, and a single green run cannot see it.

1. **The telegram retention count, and my own change made it.** Adding
   `telegram_recovery_sessions` to `sweepExpired` meant `telegramPg.test.js`
   asserted an exact count over a table another file also writes. Rows that file
   left LIVE with a 600-second TTL are EXPIRED ten minutes later, so the next
   run's sweep counted them: the assertion drifted 1 → 16 across four runs.
   Fixed on both sides — the recovery file removes every row it creates, and the
   count now drains first, so it measures its own deletions rather than the
   history of the database.

2. **`merchantTokenSupplyRoutes.test.js`, where the safeguard was defeated by
   its own sanitiser.** The file builds a unique 64-hex tx hash precisely
   because `utr_registry` keeps a reference for GOOD (§27) — a hash used once
   can never be used again, on any database it has run against. But it built it
   as ``` `${RUN}${seq}`.replace(/[^0-9a-f]/gi, '') ``` padded with `'a'`, and
   `RUN` is `Math.random().toString(36)` — **base 36**, of whose 36 symbols that
   character class strips 20. Measured: ~45% of runs keep three characters or
   fewer of real uniqueness and ~3% keep one or none, at which point the
   "unique" hash is a run of `a`s identical to what an earlier degenerate run
   already claimed. The file then 409s on a database it passed against
   yesterday. Now `randomBytes(32).toString('hex')` — hex by construction, so
   there is nothing to filter.

   **Worth keeping as a general lesson: sanitising a value into a format can
   remove the property the value was there for.** The author knew about trap 10
   and wrote the guard; the guard silently threw away most of its own entropy.

`cashLinkRoutes.test.js` itself is still OPEN — it depends on a payment-mode
policy an earlier file leaves behind, which needs the file to establish its own
rather than a cleanup elsewhere.


### F-008 — an unexpected failure told the caller what broke, and told nobody else
`FIXED for the plain shape` · medium (four sites were unauthenticated) ·
information disclosure · found 2026-09-10 · plain shape closed 2026-09-10.
**A second shape fell out of the re-sweep and is carried separately as F-013 —
read that entry before treating this one as closed.**

`res.status(500).json({ success: false, message: err.message })` hands whatever
went wrong straight to whoever asked. From a Postgres driver that is a
constraint name, a column list, sometimes a statement fragment; from `fs` a
path; from a fetch an internal hostname and port.

Two things made it worse than it reads:

1. **Four of the sites need no authentication at all** — `GET /api/v1/tokens/rate`,
   `GET /api/v1/token/rates`, `GET /api/game/providers`, `GET /api/support/status`.
   Breaking one query there returns a piece of the schema to the open internet.
2. **None of those sites logged the error.** It went to the caller and nowhere
   else: the one party who could act on the failure never saw it, and the one
   party who should not, did.

- **Shape:** an *unexpected* failure answered with its own message, where a
  *deliberate* refusal and an internal fault are not distinguished.
- **Sweep query:**
  `grep -rnE 'message:\s*(err|e|error)\??\.message' backend --include=*.js | grep -v /tests/`
- **Swept: yes — 38 sites.** They split in two, and the split is the point:
  - **~13 are correct and must not change.** A refusal somebody *wrote* for a
    caller to read — "That code is not valid", "A QR code must be uploaded here
    first", "This UTR was already used" — carries a `status` and often a `code`,
    and its wording is the feature. `callerError()` is for those.
  - **~25 are `500` with an internal message.** Six were player- or
    world-reachable and were fixed first; the rest were queued, because several
    of their messages may be deliberate and each needed reading. **That queue is
    now empty** — 21 further sites across 9 files were read and converted on
    2026-09-10, and the sweep query returns **zero** outside `httpError.js`
    itself.
  - **A correction to the first pass, recorded rather than quietly amended.**
    The "six player- or world-reachable" count was wrong: `POST
    /api/payment/order/:orderId/dispute` is player-facing and was in the queued
    pile. The miscount came from reading the route table rather than each
    router's own mounts. It changes nothing now that all of them are converted,
    but it is the kind of error a register exists to keep visible.
- **Fix:** one owner, `backend/shared/httpError.js`, with the two cases as two
  *separate functions* so a handler has to say which kind of failure it is
  holding rather than defaulting into leaking. `serverError()` logs in full and
  answers with nothing; `callerError()` takes the status and code from the error
  so a handler cannot drift from them.
- **A detail worth keeping:** the profile-picture confirm path was not simply
  converted. `verifyUploadedObject` throws messages the caller *should* read
  ("Uploaded object owner mismatch", "does not match its declared type") and
  those are the caller's mistake — so that path now answers `400` with the
  wording intact and reserves `500` for everything else.
- **The last two sites are middleware, not routes**, and are worth naming:
  `checkResourcePermission` and the merchant-auth forward in
  `auth.middleware.js`. A leak in an *authorisation* middleware answers before
  any handler runs, on every route the middleware guards — so it is the widest
  instance of the shape and the last one a route-by-route reading would find.
- **Gate possible:** yes, and straightforward — fail on
  `res.status(5xx).json({ … message: err.message … })`. Queued in §6. **The gate
  must cover F-013's shape too**, or it will report this class as closed while
  the larger half of it is still open.


### F-009 — the casino game frame cannot load, and asks for camera and microphone
`PARTIALLY FIXED` — part 2 fixed, part 1 is an open decision · low security /
medium functional · CSP and permissions policy · found 2026-09-10

Two problems in the same `<iframe>`, found by capturing helmet's real output
rather than reading the config.

**1. `frame-src` is not set anywhere.** It therefore falls back to `default-src
'self'`, so an `<iframe>` pointing at a third-party game provider is blocked by
the platform's own CSP. `user-panel/src/pages/CasinoPage.tsx:95` renders exactly
that, and `/casino` is a mounted route — a player reaches the page and gets an
empty frame. `POST /api/game/launch` builds and signs a launch URL that no
browser will load. This is the CSP being *stricter* than the app, not weaker,
so it is a functionality defect (§28: built, merged, and unable to work) rather
than a hole.

**Deliberately not "fixed" here.** The wrong fix is `frame-src https:`, which
would let any origin be framed and trade a broken feature for a real weakening.
The right fix is `frame-src` limited to the configured provider origins — and
those are **admin-set at runtime** (`game_providers.api_url`), which a static
CSP cannot enumerate. That tension is the decision, and it is the owner's:
either build the CSP per-response from the enabled providers, or accept a
narrow static list that an admin cannot extend without a deploy.

**2. The frame is granted `camera` and `microphone`.**
`allow="fullscreen autoplay camera microphone"` on a frame whose origin is
supplied by an admin and operated by a third party. No casino game needs either,
and the grant is the platform's to give — a compromised or hostile provider
inherits it.

- **Shape:** a permission granted to an embedded third-party origin that the
  embedded content does not need.
- **Sweep query:** `grep -rn "<iframe" user-panel/src admin-panel/src merchant-panel/src`
- **Swept:** yes. This is the **only** iframe in all three panels.
- **Part 2 is fixed** (2026-09-10): the frame is now
  `allow="fullscreen autoplay"`. Removing a grant cannot break a game that never
  had a use for it, and the grant was the platform's to give — a hostile or
  compromised provider inherited it for free.
- **Part 1 is still open, and deliberately.** It is a decision about how CSP and
  runtime-configurable provider origins reconcile, not a patch. Leaving it
  recorded as open is the honest state: `/casino` renders an empty frame today.


### F-010 — the public leaderboard published the internal user id
`FIXED` · medium · identifier exposure · found and fixed 2026-09-10

`GET /api/leaderboard/:period` needs no authentication and returned the
repository row whole. Each of the top fifty entries carried `userId` —
**the internal identifier every user-scoped API takes** — beside the username,
total staked, total won and net profit.

The leaderboard is not really the problem. **Identifier exposure sets the price
of every other flaw.** An IDOR against random ids is a theory; the same IDOR
against fifty ids the platform hands out, ordered by how much money each player
has, is a script. It is also the join key that makes correlating one player
across endpoints possible — and this is an iGaming platform, so "the fifty
biggest winners, with their internal ids and their balances" is a targeting list
the platform was publishing itself.

The panel never needed it: `userId` was used as a React `key` and nothing else,
and `rank` is unique within the board.

- **Shape:** an internal identifier reaching an unauthenticated response.
- **Sweep query:** read every route in §5's unauthenticated list for what it
  returns, not just whether it should be public.
- **Swept: yes — all 40.** The table in §2.18 records each. The leaderboard was
  the only one; `/v1/winners` right beside it already had the correct shape.
- **Fix:** `backend/domains/analytics/leaderboardPublicView.js` — an allowlist
  projection, in one file, like `cyclePublicView.js` and the two order views
  (§24.1). The repository stops emitting `userId` **and** the public boundary
  filters, because the entries are cached as JSONB in `leaderboard_cache`:
  stripping only at rebuild would keep publishing it until the next scheduled
  run. Six tests, and the one that matters asserts the **key set is a subset**
  of the allowlist (§24.2), so a column added to the aggregate upstream fails
  without anybody remembering to add a line.
- **Also fixed here, §23:** the panel's `LeaderboardEntry` declared `_id?` that
  the server has never sent, so `e._id || e.userId` always fell through — a type
  that typechecks and is `undefined` at runtime. The interface now mirrors
  `PUBLIC_LEADERBOARD_FIELDS` with a citing comment.


### F-011 — mandatory staff 2FA has no server-side enforcement point
`PARTIALLY FIXED` · high · authentication · found 2026-09-10 · steps 1 and 3
shipped at the owner's direction; step 2 (the guard) remains their switch

**Shipped 2026-09-10.** The session token now carries `amr` — `['pwd','otp']`
when a factor was presented, `['pwd']` when it was not — as a CLAIM rather than
a lookup, minted in `issueSession`, which is the only place a session is made.
Nothing gates on it yet; it is what makes the guard a one-line check when it is
switched on. And `issueSession` now returns `mustEnroll2FA` for any account
`requires2FA()` covers that has not enrolled, so the admin panel can route to
enrolment the way the merchant panel already does.

**Also shipped: the password floor** (see F-012), because the two are the same
credential and fixing one without the other leaves the chain intact.

**Still open — step 2, the guard.** An account that must hold a factor should
reach only `/api/2fa/setup` and `/api/2fa/activate` until it enrols. Not
switched on because it locks out every staff account that has not enrolled, the
seeded admin first. It is now a small, safe change: `amr` is on the token and
the panel prompts.


`requires2FA(user)` in `domains/identity/twoFactor.routes.js` decides who must
hold a second factor, and it is carefully written — it keys on `isAdmin` /
`isSubAdmin`, the same flags the route guards use, and its own comment explains
that deriving the policy from `roles` alone was a real hole.

**It is consulted in three places, all inside that same file** — twice to
report status, once to refuse a *disable*. **No route guard anywhere reads it.**

And `loginHandler` (`routes.js`) branches like this:

```js
if (user.twoFactorEnabled) { …issue a challenge, stop here… }
return issueSession(user, res);   // not enrolled → full admin session, password only
```

So the second factor is required of accounts that **already enrolled**, and an
admin who never enrols holds a password-only session over the entire admin
surface — permanently, and silently. `seedAdmin` does not enrol either, so the
bootstrapped admin is in exactly that state from the first boot.

The same shape reaches the merchant surface more weakly:
`issueMerchantSession(merchant, res, { mustEnroll2FA: true })` exists and the
merchant panel routes on it — but that is a **panel** behaviour. The server
issues a full merchant session regardless, so a merchant calling the API
directly is password-only too. Nothing server-side reads `mustEnroll2FA`.

- **Shape:** a security policy whose only consumers are the screens that
  configure it.
- **Sweep query:** `grep -rn "requires2FA\|mustEnroll2FA" backend --include=*.js | grep -v /tests/`
- **Swept: yes.** Three consumers of `requires2FA`, all in `twoFactor.routes.js`;
  one producer of `mustEnroll2FA` and no server-side consumer.

**Why this is not fixed here.** The obvious fix — refuse a privileged session
without a second factor — **can lock the owner out of their own platform**, and
the seeded admin is precisely the account it would lock out first. That is not a
call to make on somebody's behalf at 3am, and the codebase already shows the
author weighing it: the merchant comment says a hard refusal "would lock out
every existing merchant the moment this deploys".

**The shape that resolves it safely**, for whenever it is decided:

1. Keep issuing the session, but stamp the token with whether a factor was
   presented (a claim, not a lookup — so the check is free and cannot drift).
2. A guard on the privileged surfaces that, for an account `requires2FA()` says
   must hold one, permits **only** the enrolment endpoints (`/api/2fa/setup`,
   `/api/2fa/activate`) and refuses everything else. That is a lockout the owner
   can walk out of with an authenticator app, not one that needs database
   surgery.
3. `mustEnroll2FA` on the admin session too, so the admin panel routes to
   enrolment the way the merchant panel already does.

The order matters: (1) and (3) are safe to ship on their own and make (2) a
one-line switch once the owner has enrolled.


### F-012 — any password was accepted for a staff account
`FIXED` · high · authentication · found and fixed 2026-09-10

`POST /api/admin/sub-admins`, merchant signup, admin-creates-merchant and the
seeded admin each took whatever `password` they were given and hashed it. There
was **no strength rule anywhere in the backend** — one character was accepted.

Found by asking what F-001 and F-011 connect to rather than reading them
separately, and the connection is the finding: an admin mints a sub-admin with a
one-character password → nothing makes it enrol a second factor (F-011) → its
token lasts 24 hours → and it reaches 51 admin routes with no permission key
checked (F-001), including every player's financial history. **The weakest
credential the platform can mint reads the whole player base.**

What does NOT make it worse, stated so the severity is not overstated: online
brute force is bounded — admin login carries a pace limiter, a subnet limiter
and a captcha, hashing is argon2id, and the login limiters count failures only.
The realistic path is a reused password found in a breach corpus, or a phished
one, and a length floor is what makes both meaningfully harder.

- **Shape:** a credential-setting endpoint with no policy behind it.
- **Sweep query:** `grep -rn "hashPassword(" backend --include=*.js | grep -v /tests/`
- **Swept: yes — 8 sites, and the split matters.** Five SET a new password and
  are now gated: sub-admin create, merchant signup, admin-creates-merchant, and
  `seedAdmin` (×2). **Two RE-HASH an already-verified password** to upgrade a
  legacy bcrypt hash on login — `routes.js:103` and `merchant.routes.js:239` —
  and are deliberately NOT gated, because a floor there would lock out every
  existing account whose password predates the rule. The eighth is the utility's
  own doc comment.
- **Fix:** one owner, `backend/domains/identity/passwordPolicy.js`. Length floor
  of 12, no composition requirements (NIST SP 800-63B advises against them —
  they produce `Password1!`), plus refusals for shapes weak at any length.
- **`seedAdmin` WARNS instead of refusing**, deliberately: refusing to boot on a
  weak seed password bricks a running deployment on the deploy that adds the
  rule. The routes that create accounts refuse; the seeder tells the operator to
  change what already exists.

**Two things the tests caught that are worth keeping:**

- **The first blocklist matched as a SUBSTRING** and refused
  `a-long-enough-password-123` — a 26-character passphrase — because "password"
  appears inside it. That is exactly the composition-rule mistake the policy's
  own header warns against, arriving through the back door: it punishes a long
  memorable phrase while a short cryptic one passes. It matches the alphabetic
  CORE now (digits and punctuation stripped), so `password123` is refused and a
  real passphrase is not.
- **A test helper that could not tell a crash from a refusal.** It returned every
  caught error, so when the refactor above left a `ReferenceError` in the context
  check, every `toBeTruthy()` assertion still passed and the file went green
  while the function was broken. The pg route suite caught it. The helper now
  re-throws anything that is not a `WEAK_PASSWORD` refusal.

### 4.1 Sweep result for F-002 (module-scope state)

Run 2026-09-10. Recorded because "swept, none found" is worth as much as a hit.

<!-- BEGIN SWEEP F-002 -->
Query:

```
grep -rn "^const .* = new \(Map\|Set\)(\|^let .* = new \(Map\|Set\)(\|^global\.\|globalThis\." \
  backend --include=*.js | grep -v "/tests/"
```

26 hits. The question asked of each was *does a later, separate request depend on
this for correctness?* — not merely *is it mutable*.

| Verdict | Sites | Why it is fine |
|---|---|---|
| **Frozen vocabulary** | `runtimeRole` VALID_ROLES · `validateEnv` ×3 placeholder sets · `inputSanitize` PROTOTYPE_POLLUTION_KEYS · `outboundGuard` ×2 · `networkClient` REDIRECT_STATUSES · `cdn.service` BLOCKED_EXTENSIONS · `twoFactor.routes` MANDATORY_2FA_ROLES · `telegramTemplates` ALLOWED_TAGS · `telegramMembership` JOINED · `retry` RETRYABLE_STATUS · `retention.routes` ANNOUNCEMENT_KINDS · `server.js` _ASSET_UPLOAD_PATHS | Read-only constants. Never written after load. |
| **Process singletons** | `global.io` · `global.sseManager` | One object per process, by design; the Redis bridge is what makes them reach across instances. |
| **Registration tables** | `jobQueue.processors` · `serviceRegistry.services` | Populated at boot from code, not from requests. |
| **Redis-backed, Map is only a handle cache** | `ipDefense.surgeStores` | Holds `createRateLimitStore('rl:surge:…')` handles. The counters are in Redis. |
| **Redis-first with a memory fallback** | `behavioralRateLimit.buckets` | `redisSlidingWindowAllow(...) ?? memoryAllow(...)` — Redis is the authority; the Map only carries the degraded path when Redis is down. Correct shape. |
| **Per-instance by stated decision** | `alerting.lastSent` | Carries its own comment: "per-instance; duplicates across instances are acceptable for v1". A decision, recorded. |
| **Debounce, not a gate** | `telegram.routes.lastLiveCheck` | Floors how often a user can trigger an outbound Telegram membership call. Per-instance means up to N× the API calls — a cost, not a control. Degrades safely. |
| **Already documented as a defect** | `featureFlags._overrides` | `CLAUDE.md` §2 names it: "an env var and an in-process Map: it does not survive a restart and cannot say which rail was live when an order was created". Which is exactly why `payment_mode_policies` and not a flag owns the settlement rail. Not a new finding. |
| **THE FINDING** | `telegram.routes.recoverySessions` | The only one where a **later, separate request** reads state a previous request wrote, with no store behind it. |

**Result: F-002 is the only instance of its shape.** Everything else is a
constant, a singleton, a boot-time registry, a Redis-backed store, a documented
per-instance decision, or an already-known defect with its own owner.

Worth keeping: the two healthy patterns here are the ones to copy when fixing
F-002 — `behavioralRateLimit`'s Redis-first-with-fallback, and `alerting`'s
*stated* acceptance of per-instance behaviour. A third option, silence, is what
F-002 currently has.
<!-- END SWEEP F-002 -->

### F-013 — the same leak, written as a status fallback — the shape F-008's sweep had no bucket for
`FIXED` · medium · information disclosure · found 2026-09-10 by re-running
F-008's own sweep query after F-008 was closed · fixed 2026-09-10

```js
res.status(err.status || 500).json({ success: false, message: err.message })
```

**26 sites, 9 files.** This is not a set of sites the F-008 sweep missed — they
were all *in* the 38 it found. It is a set the sweep **classified wrongly**, and
that distinction is the whole finding.

F-008 split its hits in two: a deliberate refusal somebody wrote for a caller to
read (keep the wording), or an internal fault answered with its own message
(replace it). This shape is **neither, because it is both** — the very same
expression is a correct caller-error when the thrown error carries `.status` and
a raw internal leak when it does not. A binary sort had nowhere to put it, so it
went in the "carries a status, therefore deliberate" pile and left with a clean
bill.

**The rule that follows:** *when a sweep sorts its hits into buckets, the hit
that satisfies two buckets at once is the one to look at hardest.* A sweep that
counts is worth little; a sweep that classifies is only worth as much as its
classifier.

Two things make it more than bookkeeping:

1. **It is on the money path, unauthenticated by nothing but a player login.**
   `POST /api/payment/deposit/create` and `POST /api/payment/withdrawal/create`
   are both this shape. `requestDeposit`/`requestWithdrawal` reach the repository
   layer, so an unexpected Postgres fault — a constraint name, a column list, a
   statement fragment — is returned verbatim to any signed-up player.
2. **Those two catch blocks do not log.** Same second half as F-008, on the two
   busiest routes on the platform: the failure reaches the one party who must not
   see it and never reaches the party who could fix it. A deposit path failing in
   production would be invisible in the logs while every affected player is
   holding the reason.

- **Shape:** one expression serving both the deliberate-refusal and the
  unexpected-fault case, discriminated by a property the thrower may simply not
  have set.
- **Sweep query:**
  `grep -rnE 'status\((err|error|e)\??\.(status|statusCode)\s*\|\|\s*500\)' backend --include=*.js`
- **Swept: yes — 30 hits, and they are not all defects.** The four in
  `reporting.admin.routes.js` already do the right thing inline —
  `message: error.status ? error.message : 'Failed to build …'` — which is the
  discrimination the other 26 are missing. One more is the route test harness.
  **The correct pattern already exists in this codebase**; this is adoption, not
  design.
- **Reach:** ~6 player-facing (payment, support), ~4 merchant-facing (upload,
  merchant admin), the rest admin.
- **Fix:** `respondError(res, err, where, { message, passthrough })` in
  `shared/httpError.js`, and **all 30 sites converted** — the 26 defects plus
  the 4 already-correct `reporting.admin.routes.js` sites, which discriminated
  properly but still logged nothing on the 500 branch. The sweep query returns
  zero outside the owner file.
- **The discriminator is the PRESENCE of `.status`, never its value**, and that
  is a deliberate choice worth stating. Several services throw a real 503 whose
  wording is the feature — `USDT_RATE_UNSET`, "Funding provider is not active",
  "RAG retrieval not configured" — and §25's rule that a refusal names its own
  reason applies to a 5xx exactly as to a 400. What separates the two cases is
  whether anybody *decided* the answer; an unset `.status` is how "nobody did"
  reads. A Postgres error carries `.code` (a SQLSTATE) but never a `.status`, so
  it cannot pass as a refusal.
- **The fields the panels read are kept, and kept on the refusal branch only.**
  `passthrough` names them per site — `cutoffPassed`/`balance` on withdrawal
  creation, `originalOrderId` on mark-paid, `expiresAt` on the UTR grace claim —
  and copies each only when the thrower actually set it. An absent key is not
  the same answer as `null` to a panel branching on it, and an unclassified
  fault has no business populating any of them.
- **Gate:** `npm run check:error-responses`
  (`scripts/verify-error-responses.mjs`) — **one gate for F-008 and F-013
  together**, which is the point rather than a convenience. A gate written for
  the plain `status(500)` form alone goes green over all 26 fallback sites and
  reports the class CLOSED, which is worse than no gate (§29). It brackets each
  `.json(` payload rather than regex-spanning it, blanks comments first
  (trap §24.6), leaves the discriminated `err.status ? … : …` form alone, and
  excludes `httpError.js` by path the way `verify-no-mongo.mjs` excludes itself.
- **The gate was proved against all four cases before being trusted**, not
  merely observed to pass: the plain 500 form caught, the `|| 500` fallback
  caught, the correct discriminated form left quiet, and — the half easiest to
  lose — deleting the `console.error` from `serverError()` caught. A future edit
  that keeps the signature and drops the logging would otherwise leave every
  converted site silent with every check still green, which is the half of
  F-008 that was worse than the disclosure.

### F-014 — a bearer credential for real money, minted by `Math.random()` in a panel
`FIXED by removal` · medium · weak randomness / one-owner violation · found and
removed 2026-09-10 · found by examining class 2.20

```tsx
// admin-panel/src/Pages/Promotions/GiftCodes.tsx:61
const generate = () => setForm(f => ({ ...f, code: Math.random().toString(36).slice(2,10).toUpperCase() }));
```

A gift code is a **bearer credential**: presenting the string credited real
money to the presenter's `depositBalance` out of `BONUS_POOL`. It was generated
client-side, by a non-CSPRNG, in a panel — three separate problems in one line.

Four connected facts made it a finding rather than a lint:

1. **`Math.random()` is V8's xorshift128+**, not a CSPRNG. Its 128-bit state is
   recoverable from a small number of outputs; codes minted in one admin session
   are not independent of each other. Length was never the issue — predictability
   was.
2. **Nothing on the server set a floor.** `createGiftCode` accepted any non-empty
   string, so a hand-typed campaign code was equally acceptable.
3. **Redemption had no route-level rate limit** — only the global `/api/`
   backstop of 1,000 per 15 minutes per IP.
4. **The refusal was an oracle.** `NOT_FOUND` was distinguishable from
   `INACTIVE`, `EXPIRED`, `FULLY_REDEEMED` and `ALREADY_REDEEMED` — good UX, and
   also a positive-existence signal for walking the code space.

Together: ~4,000 guesses an hour per IP against a space nothing bounded, for a
string that pays out. Bounded in loss by `max_uses` and by the pool, so not
catastrophic — but the whole point of a promotional code is that it reaches the
person it was meant for.

**It is also a §2 violation independent of any of that.** A security value's
owner is never a panel. Every other identifier on this platform comes from
`crypto.randomBytes` on the server (see the table in §2.20); this one did not.

- **Shape:** a security-relevant value generated in a frontend, by
  `Math.random()`.
- **Sweep query:** `grep -rn "Math.random" user-panel/src admin-panel/src merchant-panel/src`
- **Swept: yes — 9 hits, and the classification is the useful part.**
  - **The gift code** — this finding.
  - **`resetMerchantPassword`** (`user-panel/src/services/realBackend.ts:877`)
    builds `'Merchant@' + Math.floor(100000 + Math.random() * 900000)`,
    `console.warn`s *"No backend route"*, and **sets nothing**. Nothing calls it.
    A §14 dead artifact rather than a live weakness — but note **why no gate saw
    it**: `check:dead-code` scans exported NAMES, and this is a class method, the
    same blind spot §22 records for default exports.
  - **Idempotency keys** (`admin-panel/src/services/api.ts:48`,
    `user-panel/src/services/realBackend.ts:494`) — **benign, and recorded here
    so nobody re-flags them.** The server builds `bet_${userId}_${clientKey}`, so
    the key is scoped by user; a guessed one cannot reach another player's bet,
    and a same-user collision needs a millisecond tie *and* a 52-bit match.
  - **Confetti geometry** (`BettingCard.tsx`) — §11, UI-only.
- **Fix: removed entirely**, on the owner's decision — the feature was not worth
  the surface. Routes, repository functions, both tables, both panel screens,
  every nav entry, the `GIFT_CODE` bonus record type and every doc reference are
  gone. `check:ui-coverage` and `check:dead-code` prove nothing is left pointing
  at any of it.
- **What deliberately stays:** `bonus_grants` rows with `ref_model = 'GiftCode'`.
  That is money that actually moved, and the ledger is append-only (§19) — a
  payout is not unmade by retiring the thing that triggered it. Those rows read
  correctly without the tables, because a grant carries its own `kind` and
  `amount_paise` and never joins back to the code.
- **The `GIFT_CODE` record type was removed too, and that is the load-bearing
  part of the cleanup.** A mapped record type with no route behind it is a pool
  the treasury can be asked to fund for a reason nobody can trigger — the same
  defect as an admin-editable field with no consumer (§3). The test that used
  `GIFT_CODE` as its example of a *mapped* type now asserts it is `undefined`.
- **Gate possible:** yes, and it is worth having — fail on `Math.random()` in any
  panel outside an allow-list of presentational files. Queued in §6, because the
  allow-list needs stated reasons per entry rather than being a silencer (§22.1).

### F-015 — the deposit that cannot be credited tells the platform nothing
`FIXED` · low-medium · observability on the money path · found and fixed
2026-09-10 while examining class 2.6

```js
// backend/domains/payment/depositCredit.js:116
if (!debited) return { ok: false, reason: 'merchant_insufficient', … };
```

**Nothing in the codebase reads that reason.** Both call sites answer the same
`400 { message: 'Merchant insufficient token balance' }` and do nothing else —
no `sendAlert`, no notification, no log line.

**The money is safe and that is not in question.** `moveDepositMoney` refuses
BEFORE the order advances, every movement is keyed on the order id, and the
order stays PAID and retryable. No tokens are created and the player is not
debited twice. This is a reporting finding, not a ledger one.

**What makes it worth fixing anyway is the state the player is left in.** PAID
means the player has already sent real money and submitted a UTR. At that
moment:

- the **merchant** is told clearly, and can act on it by topping up;
- the **player** is told nothing and sees an order that simply does not advance;
- the **platform** learns nothing at all;
- `expireOrders` deliberately does not cover PAID — correctly, since
  auto-cancelling a paid order would strand the payment — so nothing sweeps it;
- the only route out is the player noticing and pressing dispute.

**The strongest argument is eight lines further down the same function.** The
sibling branch — the order moved but the transition was refused — carries the
comment *"It must be loud rather than silent"* and calls `console.error`. That
case is rarer and less consequential than this one, and it is the one that
shouts. Within a single function, the ordinary failure is quiet and the exotic
one is loud.

**How an order reaches a merchant who cannot fund it.** Two ways, and the
severity split between them matters:

1. **A check-then-act at assignment.** `inventoryRefusal()` reads
   `getMerchantTokenBalance` and the caller assigns in a separate statement —
   no lock, no guard in the WHERE. `listAssignableMerchants` deliberately does
   not filter on balance (its comment explains why: the balance lives in
   `merchant_wallets` and a predicate here would be the old stored-`tokenBalance`
   defect one layer down), so every assignment path decides this way.
   **Heavily mitigated, and this should not be overstated:**
   `maxConcurrentDepositOrders` defaults to **1**, so a merchant holds one active
   deposit at a time and the race needs two assignments in the same instant.
2. **Ordinary drift, which needs no race at all.** The balance can fall between
   assignment and confirmation because the merchant funded a withdrawal, an
   admin deducted, or a token order settled. This is the common path and no
   concurrency guard would prevent it.

- **Shape:** a money-path failure whose only report is an HTTP status to the one
  party who caused it.
- **Sweep query:**
  `grep -rn "reason: '" backend/domains/payment backend/domains/merchant --include=*.js | grep -v /tests/`
- **Swept:** not yet — the question is which other refusals on a money path are
  returned and never reported. Queued in §6.
- **Fixed: alert AND tell the player** (owner's decision, 2026-09-10).
  `reportUncreditableDeposit()` in `depositCredit.js`, so both call sites get it
  from the one place the money decision already lives.
- **Three choices in it that a later reader should not undo:**
  1. **Nothing in the reporting may throw.** It runs immediately before a
     refusal the caller must still return; an exception here would turn a clean
     400 into a 500 and lose the reason the caller branches on. Reporting a
     problem must never create a worse one.
  2. **The alert key is per MERCHANT** — not global, not per order. `sendAlert`
     holds a 10-minute cooldown per key: a global key would swallow a second
     merchant running dry, a per-order key would defeat the cooldown and page on
     every retry. One merchant being short IS one incident.
  3. **`console.error` as well as the alert**, because `sendAlert` returns
     silently when no webhook is configured — by design — and a deployment
     without one must still leave the operator a record, or the whole fix is
     conditional on a setting nobody may have set.
- **What the player is told, and what they are not.** That we have their payment,
  that it is being completed, and that a dispute is the route out if it does not
  clear. Not the merchant, not "out of tokens": §24 points both ways, and telling
  a player their counterparty is short invites them to think the money is gone
  when the order is retryable and the payment is claimed.
- **Tests:** `backend/tests/unit/depositUncreditableReport.test.js`, six, and
  mutation-proven — removing the reporting call fails 3, and keying the alert per
  ORDER instead of per merchant fails 1. It also pins the mirror: a healthy
  deposit reports NOTHING, because an alert on a working path trains whoever
  reads them to ignore the channel.

### F-016 — a UPI merchant cannot set the QR players are meant to scan
`FIXED by removal` · low security / medium functional · shipped-means-reachable
(§28) · found and removed 2026-09-10 verifying Mode A / Mode B completeness

Two halves that only bite together, which is why neither gate saw it:

1. `POST /api/merchant/qr/upload-url` is a complete presigned-upload path —
   MIME allowlist, 5 MB cap, `category: 'merchant-qr'` — and **no screen calls
   it.** It is on `check:ui-coverage --unused`.
2. `ProfileSettings.tsx` offers a **plain text box**, "Payment QR image URL",
   placeholder `https://…`, that PUTs whatever is typed.

Separately each looks fine. Together they are a dead end, because F-006's fix
correctly bound the stored value to the platform's own CDN
(`assertCdnAssetUrl`) — so the text box now rejects every URL a merchant could
type, and the only thing that mints an acceptable URL is the route with no UI.
The refusal even reads *"A QR code must be uploaded here first"*, and there is
nowhere to upload it.

**The code says so itself.** The comment above the validation reads: *"An upload
route exists (POST /api/merchant/qr/upload-url) but nothing bound the stored
value to it, so the upload was a suggestion."* The fix bound the value and left
the suggestion unbuilt.

**Severity, stated honestly.** Mode A still works: the player is given
`payTo.paymentLink`, the `upi://pay` intent built from the merchant's UPI ID, so
they can still pay. What is lost is the scannable image the design intends —
degraded, not broken. It is recorded as *functional* rather than a hole because
nothing is exposed; the merchant simply cannot complete their own profile.

**Why no gate caught it.** `check:ui-coverage` fails on a panel call reaching no
route — the reverse direction. A route no panel calls is `--unused`, which is
triage and not failure, correctly, because webhooks and SSE live there. This is
the case §28.2 names: *"either work someone forgot to finish or code to delete."*

- **Shape:** a stored value constrained to something only an unreachable route
  can produce.
- **Sweep query:** compare `check:ui-coverage --unused` against
  `services/cdn.service.js`'s upload categories.
- **Swept: yes — this is the only one.** The other three categories are all
  reachable: CDM receipt and reject-proof both go through
  `merchant-panel/src/constants.ts` with a working presigned-PUT helper the QR
  screen could reuse as-is, and branding uploads through the admin panel.
- **Fixed by removing the QR entirely** (owner's decision, 2026-09-10), which
  is the better answer than wiring the upload: `upiPaymentLink()` already builds
  a **dynamic** `upi://pay?pa=…&am=…&tn=…&tr=<orderId>` per order, with that
  order's amount in it, so the player taps and their own UPI app opens filled
  in. A stored image is a SECOND, STATIC way of saying the same thing, and being
  static it cannot carry the amount — which is the whole point. A merchant now
  supplies a UPI ID on the INR rail and nothing else.
  Route, CDN category, profile field, `merchants.qr_code_url`, the snapshot
  field, both panel types and every doc reference are gone.
- `assertCdnAssetUrl` deliberately STAYS: the carousel slide images use it, so
  removing the QR created no dead code, and the shape it refuses is general.
- One fixture keeps `qrCodeUrl` on purpose —
  `playerOrderPrivacyRoutes.test.js` plants it in the snapshot and asserts the
  player projection drops it. It is a regression guard now rather than a live
  field: the projection is an ALLOWLIST (§24.1), and what is being proved is
  that an unknown key is dropped, which must still hold if anybody puts a QR
  back.

### F-017 — the deposit-confirm money invariants are proven against the door nobody uses
`FIXED` · **HIGH — it was hiding a live money-loss defect, now proven and
fixed** · found 2026-09-10 while deleting an orphan route, fixed the same day

> **Read this first.** The duplication was the symptom. Explaining it turned up
> the reason it mattered: the untested implementation lost player money, and a
> test written to demonstrate it did. See "What the duplication was hiding".

There are **two** deposit-confirm implementations, not one:

| Route | Auth | How it moves the money | Real-DB money tests |
|---|---|---|---|
| `POST /api/payment/deposit/:orderId/confirm` | `paymentActorAuth` (merchant **or** admin) | calls `moveDepositMoney()` | **16**, in `paymentRoutes.test.js` — conservation, the split, idempotency, a 4-way confirm race |
| `POST /api/merchant/confirm/:id` | `merchantAuth` | **reimplements** debit-then-credit inline, sharing only `depositCreditSplit()` | authorization and validation only |

**The first is on `check:ui-coverage --unused` — no screen calls it. The second
is what the merchant panel uses.** So every assertion that a deposit conserves,
that a double-tap credits once, and that four racing confirms do not overpay is
made against code no merchant reaches, while the code they do reach has none of
them.

This is §22.2 at the level of a route rather than a module: *a test that names a
path is not evidence until something imports that path.* It is also §28 — a
route test proves a handler works and can never prove anything calls it.

**A correction, recorded rather than quietly amended.** In commit `46e05ea` I
described these as *"both go through `moveDepositMoney`, so the MONEY always had
one owner (§5)"*. That is **wrong**. Only the unreachable route and the admin
queue override call `moveDepositMoney`; the merchant route has its own sequence.
The owner's decision to delete the orphan was taken on that description, so the
deletion was reverted pending this entry rather than carried out on a wrong
premise.

**It had a live consequence, now fixed.** F-015's reporting was added inside
`moveDepositMoney`, so it covered the admin override and the unreachable route
and **missed the path merchants actually use**. `reportUncreditableDeposit` is
exported now and called from both refusals.

### What the duplication was hiding

The two implementations disagreed about **the order of the money and the
status**, and only one of them was right.

```
moveDepositMoney  (the unreachable route, and the admin override)
    1. debit the merchant        ← refuses here, nothing else has happened
    2. credit the player
    3. release the UTR
    4. caller sets COMPLETED     ← the LAST thing

POST /api/merchant/confirm/:id  (what merchants actually use)
    1. completeOrder -> COMPLETED   ← the FIRST thing, and it commits
    2. debit the merchant        ← refuses HERE, after the status is already set
    3. credit the player         ← never reached
```

So a merchant with too few tokens pressing confirm produced:

| | |
|---|---|
| The order | **COMPLETED** |
| The merchant's tokens | untouched |
| The player's wallet | **untouched — they paid real money and got nothing** |
| The player's order history | reads as a **successful** deposit |
| `expireOrders` | skips COMPLETED — nothing sweeps it |
| The dispute route | `if (order.status !== 'PAID') return 400` — **they cannot even raise it** |

That is §21 in its own recorded words: *"the release button marked a disputed
deposit COMPLETED and never credited the player, then told the admin it had
failed. The order left the DISPUTED queue, so nothing remained to show it had
gone wrong."* The same shape, in a fourth place, on the busiest money route.

**Proven, not argued.** `backend/tests/routes/depositConfirmUnderfundedPg.test.js`
drives the real route against a real database: before the fix the order read
`COMPLETED` while the player held `0 paise`, and the dispute gate refused them.
The assertions are written as the CORRECT expectation, so they failed before and
pass after — a test asserting the observed behaviour would have locked the
defect in.

**Fixed by option 1**: the merchant route now calls `moveDepositMoney`, so the
money moves first and the transition is last. One owner for the sequence, and
the ordering that survives a failure at any point — every movement is keyed on
the order id, so a refusal or a crash leaves a **PAID** order that is both
retryable and still disputable.

- **The compensating refund went with it, and that is the point, not a
  casualty.** The merchant route refunded the merchant when the user credit
  threw. It needed to, because its ordering had already declared the order
  finished — there was something to unwind. Under money-first ordering nothing
  has been declared, so the next confirm simply replays: the keyed debit is a
  no-op and the credit retries. `depositCredit.js`'s header argues exactly this —
  detect and repair, never compensate and hope.
- **Double-tap is still handled**, by what was always handling it: the canonical
  `mw_dep_deduct_<orderId>` / `dep_complete_<orderId>` keys, plus
  `completeOrder`'s own idempotency. The old comment conceded this — *"only the
  canonical txIds on the wallet calls stopped the second one, which means the
  protection lived in a different domain from the decision."*
- **F-015's reporting now reaches this path for free**, since it lives inside
  `moveDepositMoney`. The export added for the inline branch is no longer needed
  there.

### Still open: where the 16 tests live

The orphan route was NOT deleted. Its 16 real-database assertions —
conservation, the split, idempotency, a four-way confirm race — are still the
only ones of their kind, and they cannot simply be repointed: they drive the
route as an **admin**, and the merchant route is merchant-only (the admin
equivalent is `paymentOrder.routes.js`, a third caller). Now that both live
paths share `moveDepositMoney`, porting them is a smaller job than it was, but
it is still a job.

- **Shape:** two implementations of one money sequence, with the tests on the
  unreachable one.
- **Sweep query:** cross `check:ui-coverage --unused` against the files the
  route-test suites import.
- **Swept:** not yet — the question is which other suites test an unreachable
  route. Queued in §6.

### F-018 — merchant eligibility is checked but never HELD, and the mechanism to hold it is unused
`OPEN` · **HIGH — this is the root cause F-017 was a symptom of** · design gap ·
found 2026-09-10 when the owner rejected the F-017 fix as treating a symptom

**The owner's objection was correct and this entry exists because of it.** F-017
fixed what happens when an under-funded merchant confirms a deposit. The right
question is why an under-funded merchant is holding a PAID deposit at all.

**Eligibility IS checked, on every path — that part is built and correct:**

| Path | Guard |
|---|---|
| Automatic assignment | `merchantScoring` reads the candidates' balances and excludes on them |
| Admin assign / reassign | `inventoryRefusal()` — `getMerchantTokenBalance() >= tokenAmount` |
| Merchant accepts from the open pool | `availableTokens < order.tokenAmount → 400` |

**But every one of them is a SNAPSHOT, not a HOLD.** The tokens stay in the
merchant's `available` pocket, spendable on anything else, for the entire life
of the order. Between assignment and confirmation the same tokens can be:

- consumed by a **second deposit** the merchant is also serving,
- paid out to fund a **withdrawal**,
- removed by an **admin deduction**,
- spent on the merchant's own token purchase.

The eligibility answer was true when it was given and nothing keeps it true.
That is the whole distance between "checked" and "guaranteed".

**The mechanism to close it already exists, fully built, and is called by
NOTHING:**

```
reserveForSettlement   available → reserved     (at assignment)
completeReservation    reserved  → settlement   (at confirmation)
cancelReservation      reserved  → available    (on expiry / reject / reassign)
```

`grep -rn "reserveForSettlement\|completeReservation\|cancelReservation" backend --include=*.js | grep -v /tests/` returns **nothing**. The merchant wallet's
three-pocket design — `available` / `reserved` / `settlement`, with
`liability = reserved + settlement` — exists precisely for this and the deposit
flow never touches it.

### Why no gate caught it, which is its own finding

`check:dead-code` classifies an export three ways: referenced in its own file
(`over`, informational), referenced only by **tests** (`testOnly`,
informational), or referenced by nothing (`dead`, **fails the build**).

These three are imported by `merchantWalletPg.test.js`, so they land in
`testOnly` and the build stays green. **A test import is counted as a
consumer.** For a helper that is reasonable; for a money mechanism it is the
§22 blind spot restated one level up — §22.2 says *"a test that reads a file's
source is not a consumer of it"*, and this is the same mistake with `import`
instead of `readFileSync`.

**80 exports are currently in that bucket.** They have never been triaged. At
least one of them is a money mechanism the platform needs and does not use.

- **Shape:** a guard whose answer is computed once and then relied on later,
  with nothing preventing the world from changing in between — and, separately,
  a gate that accepts a test as evidence of use.
- **Sweep query (the guard):** every `getMerchantTokenBalance` /
  `getBalances` read whose result gates an action completed by a LATER request.
- **Sweep query (the gate):** triage all 80 `testOnly` exports; anything that
  moves money or state is a finding, not an informational row.
- **Not fixed — it is a design change, not a patch**, and it touches every
  assignment path plus expiry, rejection and reassignment (each needs its
  `cancelReservation`). Options are in §6.

### F-019 — the dispute belonged to the wrong party, in both directions at once
`FIXED` · **HIGH** · authorization / recourse · found 2026-09-10 when the owner
stated the intended model

Two halves of one mistake, and they compounded:

| | Was | Should be, and now is |
|---|---|---|
| **Player** | `if (order.status !== 'PAID') return 400` | may dispute from **PAID or COMPLETED**, on **both** buys and sells |
| **Merchant** | a full dispute route admitting `PROCESSING`, `PAID`, `COMPLETED` | **no dispute at all** — decline, reject-with-proof, or red-flag |

**A dispute is the instrument of the party who is OWED**, and on this platform
that is always the player. A merchant who is short simply does not confirm; what
they are entitled to assert is that a transaction FAILED.

**Why the player half is the severe one.** An order reading `COMPLETED` is the
shape a player has no other way to challenge — and the narrower rule meant any
defect that moved an order to `COMPLETED` without paying them **also removed
their only recourse**, while the order left every queue that would have shown
it. That is not hypothetical: it is exactly what F-017 did, and the reason F-017
was severe rather than untidy.

**The rule table was right the whole time.** `ALLOWED_FROM` has always admitted
`DISPUTED` from `PROCESSING`, `PAID` and `COMPLETED`, with the comment *"A
dispute can be raised on anything not yet final, including COMPLETED — that is
precisely when disputes happen."* The routes were narrower than the rule on one
side and wider on the other. **The rule table describes the TRANSITION; who may
ask for it is a route's job**, and there is now one route that does.

- **The ten-minute wait now applies to a `PAID` order only.** It exists so a
  player does not dispute a deposit the merchant is still working. A `COMPLETED`
  order has had its outcome declared, so there is nothing left to wait for —
  making somebody wait to report that a finished order did not pay them is the
  window a defect hides in.
- **The merchant panel had the right route defined and the wrong one wired.**
  `ENDPOINTS.ORDERS_EXTRA.RED_FLAG` existed in `constants.ts` **with no caller**,
  while the Dispute button POSTed the dispute route. The button is now Flag and
  calls red-flag. Another built-and-unused path, found the same way as F-018.
- **Red-flag deliberately STAYS and is not a dispute.** A merchant reporting a
  suspicious order is not claiming they are owed; they are saying this must not
  settle until somebody looks. It does move the order to `DISPUTED` so it lands
  in the admin queue, which is one state serving two questions — noted below.
- **Tests:** `backend/tests/routes/disputeOwnershipPg.test.js`, nine, against a
  real database, and mutation-proven: narrowing the player back to `PAID` fails
  three. Two existing suites asserted the old model and were repointed rather
  than relaxed — one asserted `only dispute PAID`, the other tested the merchant
  dispute route that no longer exists.

**Open question this leaves** (§7 — one state field per logical question):
`DISPUTED` now carries two different meanings — *a player says they are owed*
and *a merchant says this looks fraudulent*. They need different queues and
possibly different outcomes, and today an admin sees them mixed. Worth a
decision, not urgent.

### F-020 — a disputed withdrawal settled itself anyway
`FIXED` · **HIGH — real money, and it defeated the control that exists to stop
exactly this** · found 2026-09-10 while checking what the owner's dispute model
implies for a sell

**The hold is the sell rail's whole safety design.** A merchant asserting they
sent the money settles nothing: the order reaches `PAID`, the merchant's credit
is `HELD`, the player's stake stays locked, and a worker settles it once the
window closes. Until it closes neither side has moved — which is what makes a
dispute a **reversal** rather than a clawback.

The player's reason for disputing a sell is precisely this: *the merchant
clicked paid and nothing arrived in my bank.*

**And the worker paid the merchant anyway.** The dispute writes
`disputeReason`, `disputeRaisedAt`, `disputeRaisedBy` and moves the STATE. It
deliberately does not touch `merchant_credit_status`. But:

- `findDueHolds` selected on `merchant_credit_status = 'HELD'` and the deadline,
  **with no filter on state at all**;
- `settleHold` guarded only on `merchantCreditStatus !== 'HELD'`;
- `mirrorSettlement`'s UPDATE is `WHERE order_id = $1` — no state guard either.

So a disputed withdrawal stayed HELD, stayed due, and settled on schedule: the
player's locked stake consumed, the merchant credited, **while the dispute was
open and unresolved.** The dispute then concerned money that had already gone —
the exact thing the hold exists to prevent.

### The test passed for the wrong reason first, and that is the part to keep

The first version of the proof **passed**, and it was wrong. It set
`escrowLocked: true` on the row and left `lockedBalance` at zero, so
`settleHold` reached `releaseWithdrawal`, which threw *"lockedBalance would go
negative"*, the settlement reversed, and every assertion read that as the
dispute having stopped it. In production, where the stake is real, it proceeded.

It was caught by asking **why** a green result was green — §0.5's own rule
landing on the file written to demonstrate §0.5's point. With a genuinely locked
stake the test failed immediately, naming `RELEASED`.

**The lesson, stated for the next reader: a fixture that omits a precondition
does not weaken a test, it INVERTS it** — the code under test fails for a reason
that has nothing to do with the property, and the assertion reads that failure
as success.

- **Shape:** a guard placed on one field of a row while the thing that changes
  is a different field of the same row.
- **Fix:** `AND state = 'PAID'` in `findDueHolds`'s WHERE — where a money guard
  belongs — plus an explicit `if (order.state === 'DISPUTED') return false;` in
  `settleHold`, because it is exported and callable directly.
- **Both guards are pinned INDEPENDENTLY.** Each covers the other, so a test
  that only drove the sweep could not tell you when one regressed; there is a
  separate test that calls `settleHold` directly. Removing either now fails
  exactly one test.
- **Swept:** `mirrorSettlement` still has no state guard in its UPDATE and is
  reached only from `settleHold`, which is now guarded. Recorded rather than
  changed — adding a second guard there needs a decision about what a settlement
  whose order moved underneath it should do, and that is not this fix.
- **A fixture elsewhere was aligned, not relaxed.** `newDomains.test.js` built a
  held withdrawal with no state, so it sat at the default — a HELD credit
  without `PAID`, which the merchant confirm never produces. It now says `PAID`,
  which is what the code actually writes.

---

## 5. Derived coverage — regenerated, never typed

<!-- BEGIN GENERATED: npm run audit:map -->

> Everything between these markers is DERIVED from the codebase by
> `scripts/audit-map.mjs`. Do not hand-edit it — `npm run audit:map -- --check`
> runs in CI and fails when it drifts, which is the point: a number here
> that nobody re-derived is a number that stopped being evidence.

### Routes

| Measure | Count |
|---|---|
| Route declarations in `backend/**` | 308 |
| Reachable with **no auth middleware** | 40 |
| Gated `isAdminOrSubAdmin` with **no permission key** | 44 |
| — of those, **writes** (non-GET) | 0 |
| Carrying an explicit permission key | 22 |

A count moving is not by itself a defect — it is a prompt to read the
new route and decide. Each of the three questions is defined in §2.

<details><summary>Every route with no auth middleware (read each one before dismissing it)</summary>

- `GET /admin/events  (backend/routes/sse.routes.js)`
- `GET /announcements  (backend/routes/retention.routes.js)`
- `GET /assetlinks.json  (backend/routes/wellKnown.routes.js)`
- `GET /bootstrap  (backend/routes/app-bootstrap.routes.js)`
- `GET /categories  (backend/domains/gameRegistry/gameRegistry.routes.js)`
- `GET /cycles/:cycleId  (backend/domains/user/user.routes.js)`
- `GET /cycles/active  (backend/domains/user/user.routes.js)`
- `GET /events  (backend/routes/sse.routes.js)`
- `GET /games  (backend/domains/gameRegistry/gameRegistry.routes.js)`
- `GET /health  (backend/routes.js)`
- `GET /leaderboard/:period  (backend/routes/retention.routes.js)`
- `GET /me  (backend/routes.js)`
- `GET /merchant/events  (backend/routes/sse.routes.js)`
- `GET /providers  (backend/domains/casino/gameProvider.routes.js)`
- `GET /public-config  (backend/domains/telegram/telegram.routes.js)`
- `GET /r/:code  (backend/routes/referralRedirect.routes.js)`
- `GET /stats  (backend/routes/sse.routes.js)`
- `GET /status  (backend/domains/support/support.routes.js)`
- `GET /v1/branding  (backend/domains/user/user.routes.js)`
- `GET /v1/content/ai-analysis  (backend/domains/user/user.routes.js)`
- `GET /v1/content/faq  (backend/domains/user/user.routes.js)`
- `GET /v1/content/promo/:location  (backend/domains/user/user.routes.js)`
- `GET /v1/content/support-links  (backend/domains/user/user.routes.js)`
- `GET /v1/game/cycle/:type/:startTime  (backend/domains/user/user.routes.js)`
- `GET /v1/game/cycles/history  (backend/domains/user/user.routes.js)`
- `GET /v1/system/config  (backend/domains/user/user.routes.js)`
- `GET /v1/system/time  (backend/domains/user/user.routes.js)`
- `GET /v1/token/rates  (backend/domains/user/user.routes.js)`
- `GET /v1/tokens/rate  (backend/domains/user/user.routes.js)`
- `GET /v1/winners  (backend/routes/winners.routes.js)`
- `POST /auth/login  (backend/domains/merchant/merchant.routes.js)`
- `POST /auth/login/2fa  (backend/domains/merchant/merchant.routes.js)`
- `POST /auth/signup  (backend/domains/merchant/merchant.routes.js)`
- `POST /exchange  (backend/domains/telegram/telegram.routes.js)`
- `POST /logout  (backend/routes.js)`
- `POST /otp/request  (backend/domains/telegram/telegram.routes.js)`
- `POST /otp/verify  (backend/domains/telegram/telegram.routes.js)`
- `POST /recovery/webhook  (backend/domains/telegram/telegram.routes.js)`
- `POST /wallet/:providerKey  (backend/domains/casino/gameProvider.routes.js)`
- `POST /webhook  (backend/domains/telegram/telegram.routes.js)`

</details>

<details><summary>Writes any sub-admin can make without holding a permission key</summary>

- _none_

</details>

### SQL

| Measure | Count |
|---|---|
| `pgQuery` call sites | 391 |
| Parameters only (safe by construction) | 250 |
| Interpolating into statement text (each needs a reading) | 141 |

### Panel injection sinks

| Panel | .ts/.tsx files | `dangerouslySetInnerHTML` | `.innerHTML =` |
|---|---|---|---|
| `user-panel` | 89 | 0 | 0 |
| `admin-panel` | 89 | 0 | 0 |
| `merchant-panel` | 38 | 0 | 0 |

<!-- END GENERATED -->

---

## 6. Open queue

In the order it should be worked.

| # | Class | §2 | Why now |
|---|---|---|---|
| 0 | ~~Decide F-015~~ | §4 | **Done 2026-09-10** — alert plus player notification. The sweep for other silently-returned money-path refusals is still open. |
| 0 | ~~Decide F-016~~ | §4 | **Done 2026-09-10** — the QR was removed entirely; the dynamic UPI intent already did the job better. |
| 0 | **Merchant abuse caps — NOT IMPLEMENTED** | §4 | The owner's model has caps on rejects and temporary suspension. `dispute_rate` exists and softly lowers a merchant's assignment score; there is **no reject-rate column, no cap, and no auto-suspension** — `suspendMerchant` is manual-admin only. |
| 0 | State guard on `mirrorSettlement` | §4 | Its UPDATE is `WHERE order_id = $1`. Safe today because its only caller is guarded (F-020), but it would overwrite a state that moved underneath it. |
| 0 | Split the two meanings of DISPUTED | §4 | F-019 left `DISPUTED` carrying both *the player is owed* and *the merchant smells fraud*. Different queues, possibly different outcomes. |
| 0 | **Decide F-018 — reserve the merchant's tokens at assignment** | §4 | The root cause. `reserveForSettlement`/`completeReservation`/`cancelReservation` are built and called by nothing. Needs: reserve at assign/accept, complete at confirm, cancel on expiry/reject/reassign. |
| 0 | Triage the 80 `testOnly` exports | §4 | `check:dead-code` treats a TEST import as a consumer, which is how an unused money mechanism stayed green. Anything in that bucket that moves money or state is a finding, not an informational row. |
| 0 | Port F-017's 16 tests | §4 | The ordering defect is FIXED and both live paths now share `moveDepositMoney`. What remains is re-homing the orphan route's 16 real-DB money assertions onto the two reachable doors, then deleting it. |
| 0 | Gate for the F-014 shape | §4 | Fail on `Math.random()` in a panel outside an allow-list of presentational files, each entry carrying a stated reason. |
| 1 | Client-side injection (XSS) | 2.14 | Chat, tickets and admin announcements all round-trip through panels; a stored XSS in the admin panel runs with an admin session. |
| 2 | File upload | 2.15 | Payment proofs are evidence in money disputes. |
| 3 | Secrets in responses | 2.16 | A spread defeats a key scan; needs a real sweep, not spot checks. |
| 4 | Transport, cookies, headers | 2.17 | `SameSite` is most of the CSRF defence for the cookie-auth panel. |
| 5 | Public-route data leakage | 2.18 | Leaderboards and winners are designed to expose players — how much? |
| 6 | Admin 2FA enforcement | 2.19 | |
| 7 | ~~Identifier predictability~~ | 2.20 | **Done 2026-09-10** — clear except F-014; the per-identifier table is in §2.20. |
| 8 | ~~Money-path concurrency~~ | 2.6 | **Done 2026-09-10** — every balance write traced to its guard, and the merchant wallet now has a mutation-proven concurrency suite. Settlement-under-storm and crash-resume remain uncovered; §2.6 says so. |
| 9 | Gate for F-001 | §4 | Closes the class, not the instance. |
| 10 | Gate for the F-003 shape | §4 | A CHECK a handler can violate after a commit. |
| 11 | Gate for the F-006 shape | §4 | Any `*_url` / `*_link` written from `req.body` must pass through `shared/storedUrl.js`. |
| 12 | Sweep F-007 | §4 | **Swept 2026-09-10** — two instances found and fixed (see F-007). `cashLinkRoutes.test.js` itself still open. The method that finds these is running the suite TWICE; a single green run cannot see the class. |
| 13 | ~~Finish F-008~~ | §4 | **Done 2026-09-10.** All 21 remaining sites converted; the sweep returns zero. |
| 14 | ~~Gate for the F-008 **and F-013** shapes~~ | §4 | **Done 2026-09-10** — `check:error-responses`, one gate for both forms, proved against all four cases including the deleted-log case. |
| 14b | ~~Decide F-013~~ | §4 | **Done 2026-09-10.** All 30 sites through `respondError`; the panel-read fields ride the refusal branch by name. |
| 15 | **Decide F-011 — staff 2FA** | §4 | **Highest open item.** A password-only admin session is the whole platform. Fix shape and the lockout risk are in the entry; steps 1 and 3 are safe to ship alone. |
| 15 | Decide F-009's `frame-src` | §4 | Per-response CSP from enabled providers, or a static list an admin cannot extend. Owner's call. |
