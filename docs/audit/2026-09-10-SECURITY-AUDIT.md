# Security audit — full codebase, all three panels

**Status: IN PROGRESS.** Started 2026-09-09, on the single-store branch (the
branch name is not spelled out here — `check:no-mongo` scans this directory and
the name carries a forbidden string). This file is committed as it is written, per `CLAUDE.md` §17.4 — a session is ephemeral, the repository is not,
and an audit lost with its container has to be redone from nothing.

Scope asked for: every endpoint, every route, every modal, every panel
(user / admin / merchant), the cross-connections between them, and the
vulnerability classes an attacker would actually try.

**Read §4 before quoting a conclusion.** What has NOT been looked at yet is
listed there, and by `CLAUDE.md` §29 the absence of a finding in an area nobody
has examined is not evidence that the area is clean.

---

## 1. Method

Route inventory built mechanically rather than by reading files in order, so a
route cannot be missed by being in a file nobody opened:

- `319` route declarations parsed out of `backend/**` with their declared
  middleware chains (`router.<verb>(path, ...middleware, handler)`).
- Mount prefixes derived from `server.js`'s own `app.use` calls, not a
  hand-written table (`CLAUDE.md` §28: derive what a gate checks from the thing
  it is checking).
- Each class below was then run as a query over that inventory, and every hit
  was read by hand before being called a finding or dismissed.

Scripts are throwaway; the inventory is reproducible from the repo.

---

## 2. Findings

### 2.1 CONFIRMED — the sub-admin permission model is declared but only partly enforced

**Severity: high (broken access control).**

`hasPermission(key)` exists, is correct, and is applied to **15** routes.
**51 routes** are gated by bare `isAdminOrSubAdmin`, which asks only *are you a
sub-admin*, never *which permissions do you hold*.

Nine permission keys are defined (`admin-panel/src/utils/permissions.ts`:
`canViewAnalytics`, `canManageUsers`, `canManageMerchants`, `canVerifyKYC`,
`canViewTransactions`, `canResolveDisputes`, `canManageContent`,
`canManageSupport`, `canModerateChatPublic`). The admin panel's sidebar and
routes gate on them. **The server, on these 51, does not** — so for this set the
permission model is a client-side control, which is not a control.

A sub-admin created with only `canModerateChatPublic` can, today, by calling the
API directly:

**Write (4):**

| Route | What it does |
|---|---|
| `PUT /api/admin/merchants/:merchantId/scoring` | Sets `maxConcurrentOrders` / deposit / withdrawal caps — **how many orders a merchant may hold, which shapes where players' money is routed** |
| `POST /api/admin/promo` · `PUT /api/admin/promo/:id` · `POST /api/admin/promo/upload-url` | Publishes and edits player-facing promo content |

**Read (47), the ones that matter:**

| Route | What it discloses |
|---|---|
| `GET /api/admin/users/:userId` | Any player's full record |
| `GET /api/admin/users/:userId/transactions` | Any player's full financial history |
| `GET /api/admin/users` · `/users/flagged` | The whole player base |
| `GET /api/admin/revenue/ledger` · `/revenue/summary` | The platform's revenue ledger |
| `GET /api/admin/reports/financial` · `/settlement` · `/merchants` | Executive financials |
| `GET /api/admin/merchant-platform/:merchantId/wallet-ledger` | A merchant's money movements |
| `GET /api/admin/transactions` · `/system/config` | Platform-wide ledger and configuration |
| `GET /api/admin/analytics/*` (5) · `/operations/*` (2) · `/deposit-policy/*` · `/payment-mode/*` · `/merchant-commission-policy/*` | Policy, margins, operational posture |
| `GET /api/admin/giftcodes/:code/redemptions` · `/giftcodes/unpaid` | Promotion liabilities |

**Not yet decided:** which key each route should carry. That is an owner
decision about the role model, not a mechanical fix — `canViewAnalytics` and
`canViewTransactions` are plausibly different answers for
`GET /admin/transactions`. The scoring write is the one that should not wait: it
is a money-routing control reachable by every sub-admin.

**Recommended gate:** a check like the existing ones that fails the build when a
route under `/api/admin` carries `isAdminOrSubAdmin` without a permission key or
an explicit, reasoned entry in an allow list — so the next such route is a
failure rather than a silence.

### 2.2 CONFIRMED — account recovery keeps its half-finished state in process memory

**Severity: medium (availability + integrity of the recovery path, on >1 replica).**

`recoverySessions` in `backend/domains/telegram/telegram.routes.js:413` is a bare
`Map`, holding the Aadhaar a player sent to the recovery bot until they send
their contact card in a second message:

```js
const recoverySessions = new Map();   // telegramUserId -> { aadhaar, at }
```

**This platform is built for horizontal scale and says so.**
`startup/realtimeBridge.js` calls itself "THE keystone for horizontal scale";
`startup/validateEnv.js` requires `REDIS_URL` "at >1 replica"; cron is
leader-locked; admin seeding is idempotent "so two instances booting together
seed ONE admin"; the rate limiters take a Redis store. Every other piece of
cross-request state was moved off the process. **This one was not**, and it sits
in the identity-recovery path.

Three consequences behind a load balancer:

1. **Recovery silently fails.** The Aadhaar message lands on instance A and the
   contact message on instance B, which has no session and answers *"Please send
   your 12-digit Aadhaar number first."* The player has just sent it. Retrying
   lands them on a random instance, so it works intermittently and looks like
   their mistake — the worst shape a failure can take on a path somebody reaches
   only because they have already lost access to their account.
2. **`recoverySessions.clear()` at 10,000 entries wipes every in-flight
   recovery**, not just old ones. It is a size cap with no LRU behind it.
3. **A restart or deploy drops every in-flight recovery.**

There is also a data-handling point. §2 of `CLAUDE.md` says an Aadhaar is held as
an HMAC plus AES-256-GCM ciphertext. Here it is a plaintext string in the heap
for up to ten minutes — the one place in the platform where that is true.

**Fix:** move it to the store everything else uses. A short-TTL row (or a Redis
key) keyed on the Telegram user id, holding the Aadhaar the way the rest of the
platform holds one, with the TTL doing the expiry instead of a sweep and a cap.

---

### 2.3 CLEAR — SQL injection

**392 `pgQuery` call sites** examined: 250 pass parameters only, 142 interpolate
something into the SQL text. Every one of the 142 was traced. **None can carry a
request-supplied value into SQL.** They are, exhaustively:

- **Module-level column constants** — `${COLUMNS}`, `${IDENTITY_COLUMNS}`,
  `${BOT_PUBLIC}`, `${PENDING_COLUMNS}`, and `qualified('c')` /
  `COLUMNS.split(',').map(...)` derived from them.
- **Allowlist-mapped column names.** `toColumns(patch, 'updateUser')`,
  `setOrderFields`, `columnFor(field)` and `columnFor(pocket)` all **throw** on a
  key they do not know; `content.js`, `engagement.js` and `games.js` iterate the
  allowlist and pick from the patch, so a caller-supplied key never reaches the
  SQL at all — the strongest of the three shapes.
- **Ternaries between two literals** — `detailed ? 'enhanced_audit_logs' :
  'audit_logs'`, `withdrawal ? 'accepts_withdrawals' : 'accepts_deposits'`,
  the `sideClause` behind `side === 'WINNING' || side === 'LOSING'`.
- **Fixed spec objects** — `PRUNABLE[name].table` / `.where` in `operations.js`.
- **`$n` placeholders** built from `params.length`, including the guards in both
  wallet movers (`${column} = ${column} + ${placeholder}`).
- **Numerically clamped limits** — every `LIMIT ${...}` is
  `Math.min(Math.max(Number(x) || d, 1), cap)`, and `embeddingDim()` is
  integer-validated and capped at 4096.

No raw `client.query` / `pool.query` outside `#db` interpolates a value either
(`check:db-boundary` keeps SQL confined; this checked what the confined SQL does).

---

### 2.4 CLEAR — the Telegram identity root

This is what a session is ultimately minted from, so it was read end to end.

- **Both webhooks** verify `X-Telegram-Bot-Api-Secret-Token` with
  `crypto.timingSafeEqual` behind a length check, and answer a terse `401` that
  tells a prober nothing about which half was wrong.
- **The OTP is `crypto.randomInt(0, 1_000_000)`** — a CSPRNG with no modulo bias,
  and the file says why it is not `randomBytes % 1000000`. Stored as an
  HMAC-keyed hash, never plaintext.
- **Single use is atomic.** `consumeLoginCode` puts `consumed_at IS NULL AND
  expires_at > now() AND attempts < $3` inside the `UPDATE`'s own `WHERE`, so two
  concurrent redemptions cannot both win. A wrong code charges an attempt and
  **burns the code outright at the cap**, so a live code cannot be guessed at for
  the rest of its window.
- **No enumeration oracle anywhere.** `/otp/request` returns the same sentence
  whether or not the number exists and swallows errors *after* logging, because a
  500 would itself separate the two cases. `/otp/verify` returns one message for
  wrong, expired, already-used and out-of-attempts.
- **The login link token is 32 random bytes**, stored hashed, single-use through
  the same `consumed_at IS NULL` clause.
- **Every path re-reads the user row** and re-checks `isBlocked` / `status`,
  rather than trusting the claim minted five minutes earlier. All three entry
  points (link, OTP, staff password) call the same `issueSession`, so they cannot
  drift into granting different claims.

Noted and dismissed: `/api/telegram/exchange` carries no rate limiter where
`/otp/verify` does. A 256-bit single-use token is not brute-forceable and the
redemption is atomic, so this is a difference, not a gap.

---

## 3. Examined and found sound

Recorded so the next session does not re-derive them, and so a later change that
breaks one is visibly a regression.

### 3.1 Authentication middleware

- **`authenticate`** — PASETO verified through the single authority; rejects 2FA
  **challenge** tokens explicitly (without that check a challenge token *is* a
  session token and 2FA is bypassable with the password alone); revocation
  checked and **fails closed** on a database error; the account is re-read from
  the row and `isBlocked` re-checked, so a token minted before a block is dead;
  credentials are deliberately not loaded onto `req.user`, so no careless
  `res.json(req.user)` can leak a TOTP secret.
- **`merchantAuth`** — same, plus `isMerchant` + `merchantId` claims required,
  the merchant row re-read, and **both** `status` and `merchantApprovalStatus`
  re-checked on every request.
- **Cross-panel confusion: not reachable.** A player token fails `merchantAuth`
  (no `isMerchant` claim). A merchant token cannot reach admin routes: `isAdmin`
  reads `req.user.isAdmin` from the **users row**, never from the token.

### 3.2 IDOR

Every route that takes an id from the request was checked for whether it scopes
to the caller. **No unscoped non-admin route found.** Spot-verified by hand:

- `GET /api/v1/user/:id/data` and `GET /api/user/:userId/transactions` — explicit
  403 when the param is not the caller.
- `POST /api/merchant/accept/:id` — reads unscoped, then refuses immediately if
  the order belongs to another merchant; an order with **no** merchant is the
  open pool, which is the design.
- `POST /api/merchant/orders/:id/reject` — scoped, and the uploaded proof is
  bound to this merchant **and** this order, so a merchant cannot attach evidence
  staged against someone else's payout.
- `GET /api/merchant/stats` — scoped.

### 3.3 The three SSE streams

Auth is inside the handlers (EventSource cannot send headers), and it is done
properly: token verified, revocation checked, and then **re-checked against the
row** — a suspended merchant and a blocked admin are both cut off, not carried by
their old claims. The merchant stream goes through `toMerchantOrderViews`, so the
snapshot is the allowlisted projection rather than raw orders.

The public stream sends config through `toPublicSystemConfig`, a genuine
allowlist of 8 fields.

### 3.4 The casino provider wallet callback

`POST /api/game/wallet/:providerKey` is unauthenticated by necessity — the caller
is a supplier. It is HMAC-SHA256 signed and compared with `timingSafeEqual`, with
a length check first. Replay is handled by the thing underneath: the movement is
idempotent on the supplier's `tx_id` **inside the transaction**, so a redelivered
callback is a no-op rather than a second payment.

### 3.5 Login rate limiting

All three login paths are limited, and the merchant one is limited **at the
mount** (`server.js:517`) rather than on the router — which reads like a gap
until you check the mount order. It is correct: line 517 precedes line 518, and
`app.use` with a path prefix also covers `/auth/login/2fa`. Admin login carries
`loginPaceLimiter + adminAuthLimiter + subnet limiter + captcha`. Telegram OTP
request and verify each carry their own pace limiter.

**No duplicate or shadow login path exists** — checked, because a second one that
skips the limiter and the captcha is the classic way this control is lost.

---

## 4. COVERAGE

Ticked items have been examined and have a section above. **Nothing unticked has
been looked at** — by `CLAUDE.md` §29 that means nothing about those is claimed
in either direction.

- [x] **SQL injection** — DONE, §2.3. Clear: 392 call sites traced.
- [ ] **The three panels' frontends** — XSS (`dangerouslySetInnerHTML`,
      `innerHTML`), token storage, whether any screen is gated only in the client,
      modals that render fields they should not have.
- [ ] **File upload** — `services/cdn.service.js`, content-type and magic-byte
      checking, path traversal, signed-URL scope, the four upload categories.
- [ ] **Secrets in responses** — a sweep for credential columns reaching a
      response body across all 319 routes, not only the ones already known.
- [ ] **CORS, cookies, security headers** — `SameSite`, `Secure`, `httpOnly`,
      CSP, the allowed-origin list.
- [x] **Telegram auth flows** — done, §2.4 (sound) and §2.2 (the recovery-session
      finding).
- [ ] **The remaining public routes** — `/api/app/bootstrap`, `/r/:code` (open
      redirect), `/leaderboard/:period`, `/v1/winners`, `/v1/content/ai-analysis`
      (player identity leakage in a public list).
- [ ] **Money-path concurrency** — re-verification of settlement, withdrawal
      admission and merchant assignment under concurrent load.
- [ ] **The user panel end to end** — not opened at all yet.
- [ ] **Admin 2FA enforcement** — whether every admin path actually requires it.
- [ ] **Order id predictability** — enumeration cost across the order routes.

---

## 5. Provenance note — merchant bulk payouts

The owner reports having **rejected** the bulk-payout feature and found it still
present. Checked, because "which session put this back" is answerable from git
and should not be guessed:

- The routes and `backend/domains/merchant/bulkPayoutExport.js` were introduced by
  **`0cb9c85` — "Reachability: things that were built, merged, and never once ran
  (#171)"**, 2026-09-08, authored under the owner's account and **merged to
  `main`**. That commit is this branch's own branch point.
- `ecddb90` (a session on this branch) then modified it.
- No later commit restored it, and it was never deleted in any commit on any
  branch — `git log --diff-filter=D` over that path is empty.

So it arrived on `main` through a merged PR and stayed.

**Removed 2026-09-10 at the owner's decision.** Two things turned up while
mapping it for deletion:

- It was **never functional.** Nothing in the platform ever wrote
  `bulk_payout_date`, and the batch query filtered on that column — so
  `GET /bulk-payouts` and `/bulk-payouts/export` returned an empty batch for
  every merchant on every day this has run. Only `mark-paid` had coverage, and
  it takes explicit order ids rather than reading a batch. This was not an
  unreachable working feature; it was an unreachable broken one.
- **A correction to the first draft of this file**, which listed `batchRef`
  among the columns to remove with it. That was wrong. `withdrawal_batch_ref` is
  the SPLITTER's label — written by `paymentProcessing.service.js` when a payout
  too large for one denomination becomes several orders, and read by the
  stalled-withdrawals and dispute screens. The bulk-payout route merely accepted
  a `batchRef` **request parameter** of its own. The two are unrelated despite
  the shared word, and the column stays.

Gone: the three routes, `bulkPayoutExport.js`, both test files, the
`requireBulkPayoutsEnabled` guard, the `MERCHANT_BULK_PAYOUTS` flag, `istToday()`
and `bulkPayoutBatch()`, the three `bulk_payout_*` columns (dropped in
`schema.sql`), their entries in both order projections, and
`bulk_payout_completed` from the realtime registry.
