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

**Status: PARTIAL.** Covered by `check:balance-reads`, the pg suites, and the
mutation harness. A dedicated concurrency re-verification pass has **not** been
run in this audit.

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

**Status: NOT EXAMINED.**

### 2.18 Public-route data leakage

**What.** What the unauthenticated routes actually return.

**Why it matters in iGaming.** Leaderboards and winner lists are *designed* to
expose players; the question is how much. A username plus a win amount plus a
timestamp is a targeting list. `/api/app/bootstrap` and `/r/:code` (open
redirect) need their own look.

**Status: NOT EXAMINED.**

### 2.19 Admin 2FA enforcement

**What.** Whether every admin path really requires the second factor, or only the
login screen does.

**Status: NOT EXAMINED.**

### 2.20 Identifier predictability

**What.** Whether order, user or reference ids can be guessed or enumerated.

**Why it matters.** It sets the cost of every other flaw. An IDOR on random
128-bit ids is theoretical; the same IDOR on sequential ids is a script.

**Status: NOT EXAMINED.**

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
`OPEN` · high · broken access control · found 2026-09-10

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
`OPEN` · medium · distributed-state · found 2026-09-10

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
- **Not fixed** — small change, but it is the identity-recovery path.
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
`OPEN` · low · signature robustness · found 2026-09-10

`verifyWebhookSignature` computes the HMAC over `JSON.stringify(req.body)` — the
parsed body re-serialised — rather than the raw bytes the supplier signed. Key
order, whitespace and number formatting may differ.

**Not exploitable**: an attacker still cannot forge a signature without the
secret. It is a robustness defect — legitimate callbacks can fail verification —
recorded so it is not rediscovered as a suspected hole.

- **Shape:** verifying a signature over a re-encoding of the signed bytes.
- **Sweep query:** `grep -rn "createHmac" backend --include=*.js | grep -v tests`
- **Swept:** yes — this is the only webhook signature verifier.

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
- **Swept:** not yet. Queued in §6.


### F-008 — an unexpected failure told the caller what broke, and told nobody else
`PARTIALLY FIXED` · medium (four sites were unauthenticated) · information
disclosure · found 2026-09-10

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
    world-reachable and are **fixed**; the remaining ~19 are behind admin auth
    and are queued rather than changed in the same pass, because several of
    their messages may be deliberate and each needs reading.
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
- **Gate possible:** yes, and straightforward — fail on
  `res.status(5xx).json({ … message: err.message … })`. Queued in §6.


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
| Route declarations in `backend/**` | 316 |
| Reachable with **no auth middleware** | 40 |
| Gated `isAdminOrSubAdmin` with **no permission key** | 51 |
| — of those, **writes** (non-GET) | 4 |
| Carrying an explicit permission key | 18 |

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

- `POST /promo  (backend/domains/cms/content.admin.routes.js)`
- `POST /promo/upload-url  (backend/domains/cms/content.admin.routes.js)`
- `PUT /merchants/:merchantId/scoring  (backend/domains/merchant/merchant.assignment.routes.js)`
- `PUT /promo/:id  (backend/domains/cms/content.admin.routes.js)`

</details>

### SQL

| Measure | Count |
|---|---|
| `pgQuery` call sites | 392 |
| Parameters only (safe by construction) | 250 |
| Interpolating into statement text (each needs a reading) | 142 |

### Panel injection sinks

| Panel | .ts/.tsx files | `dangerouslySetInnerHTML` | `.innerHTML =` |
|---|---|---|---|
| `user-panel` | 90 | 0 | 0 |
| `admin-panel` | 90 | 0 | 0 |
| `merchant-panel` | 38 | 0 | 0 |

<!-- END GENERATED -->

---

## 6. Open queue

In the order it should be worked.

| # | Class | §2 | Why now |
|---|---|---|---|
| 1 | Client-side injection (XSS) | 2.14 | Chat, tickets and admin announcements all round-trip through panels; a stored XSS in the admin panel runs with an admin session. |
| 2 | File upload | 2.15 | Payment proofs are evidence in money disputes. |
| 3 | Secrets in responses | 2.16 | A spread defeats a key scan; needs a real sweep, not spot checks. |
| 4 | Transport, cookies, headers | 2.17 | `SameSite` is most of the CSRF defence for the cookie-auth panel. |
| 5 | Public-route data leakage | 2.18 | Leaderboards and winners are designed to expose players — how much? |
| 6 | Admin 2FA enforcement | 2.19 | |
| 7 | Identifier predictability | 2.20 | Sets the cost of every other flaw. |
| 8 | Money-path concurrency | 2.6 | Partial today; deserves a dedicated pass. |
| 9 | Gate for F-001 | §4 | Closes the class, not the instance. |
| 10 | Gate for the F-003 shape | §4 | A CHECK a handler can violate after a commit. |
| 11 | Gate for the F-006 shape | §4 | Any `*_url` / `*_link` written from `req.body` must pass through `shared/storedUrl.js`. |
| 12 | Sweep F-007 | §4 | Which other suites only pass in a particular order. |
| 13 | Finish F-008 | §4 | ~19 admin-side `500 + err.message` sites; each needs reading, some messages are deliberate. |
| 14 | Gate for the F-008 shape | §4 | Fail on `res.status(5xx).json({ message: err.message })`. |
