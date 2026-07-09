# Audit Findings — 2026-07-09

A single-session audit of workflow, money accounting, security, and scale.
Static analysis of the real code (no live attacks were run against production —
that would disrupt real users, and reading the code finds more anyway).

Severity: 🔴 critical (money/security) · 🟠 high · 🟡 medium · 🟢 done this session

---

## 🟢 FIXED THIS SESSION (redeploy on Railway to get these)

1. **Production crash — 3 broken dynamic `import()` paths.** `../models/`
   resolved to the nonexistent `domains/models/`. Crashed every SSE
   `cycle_snapshot` and every 30-min cycle creation. **This was almost
   certainly the cause of "winner not showing in user panel"** — the user
   app gets ALL cycle state (winner included) from that snapshot, and it was
   dying on every connect. A CI test now resolves every dynamic import so
   this can't recur.
2. **Reserve balance credited with no ledger trail** — raw `$inc`, no audit
   record. Now via `walletAuthority.creditReserve` (idempotent, ledgered).
3. **Dead test suite** — vitest pointed at a path that no longer existed;
   `npm test` had been finding nothing. 51 unit tests now green + CI.
4. **Missing DB indexes** on User (`referredBy`, `kycStatus`, `username`,
   `createdAt`) — were full table scans.

---

## 🔴 CONFIRMED — needs fixing

### F-1  Token "minting" in the merchant deposit-confirm path
`merchant.routes.js` deposit confirm does, in order:
1. `creditDeposit(user, tokenAmount)` — credits the user FIRST.
2. `debitMerchantTokens({ …, allowOverdraft: true }).catch(log)` — debits the
   merchant, but overdraft is allowed and any error is swallowed.

**Consequence:** if the merchant lacks balance (or the debit errors), the user
is credited anyway and the merchant is not properly debited → the platform's
total token liability rises with no matching merchant reduction. That is
exactly the "new tokens minted instead of transferred" problem you described.
The correct order is **debit merchant first (hard-fail if insufficient), then
credit user**, atomically. Note the *approve* path and `payment.routes.js`
already do this correctly with a `$gte` guard + rollback — only the
merchant-confirm path is loose. Fix: make merchant-confirm mirror them.

### F-2  Settlement unlocks bypass the wallet authority
`domains/settlement/settlementService.js` still mutates
`lockedBalance/lockedDepositAmount/lockedWinningsAmount` with raw `$inc`
(§7 violation). Needs a `walletAuthority` unlock method + an integration
test of the full settle-under-concurrency flow before changing (delicate
hot path — do NOT change blind).

### F-3  Rate limiting is in-memory (won't survive horizontal scale)
`middleware/security.js` uses `express-rate-limit` with the default
MemoryStore. The moment you run more than one backend instance (required for
1M DAU), each instance has its own counter → limits are effectively N× looser
and brute-force protection weakens. Needs a Redis store (you already have
Redis provisioned). This is a hard blocker for horizontal scaling.

---

## 🟠 HIGH — workflow / "everything from admin panel" gaps

- **W-1  FAQ hardcoded** — not admin-editable. Should be a CMS document with
  admin CRUD + the user panel reading from the API (matches your
  "everything configurable from admin" goal).
- **W-2  KYC approve/reject has no document preview** — admin must be able to
  see the uploaded ID (S3/CDN URL) before deciding. Approving KYC blind is
  both a UX and a compliance problem.
- **W-3  Recover-account entry point missing on login/signup** — the backend
  `accountRecovery.model.js` exists; the UI just never links to it.
- **W-4  Public chat / Telegram** — needs a decision: wire it to a real
  purpose or gate it behind a flag / remove. Right now it's ambiguous surface.

---

## 🟡 MEDIUM — correctness / consistency

- **M-1  Non-atomic money across documents generally.** Several money flows
  do balance mutation + status change + secondary effects without a single
  transaction, relying on idempotency keys. Defensible, but UNTESTED under
  concurrency. The integration-test harness I set up is the prerequisite to
  prove these; that work is the real path to "unhackable"-grade money code.
- **M-2  bcrypt cost inconsistency** — mostly 12 (good), sub-admin creation
  uses 10. Standardize on 12.
- **M-3  Forced-result note (CORRECTION):** admin "force result" DOES pay out
  — the gameEngine tick settles `RESULT_DECLARED, isSettled:PENDING` cycles
  automatically. (An earlier note of mine said otherwise; that was wrong.)
  Payout is async (a few seconds after the admin action), which is fine.

---

## ✅ Verified GOOD (not everything is broken)

- Passwords hashed with bcrypt (cost 12 in the main paths).
- IDOR protection present — e.g. order fetch checks `order.userId === req.user`.
- Admin routes are auth-gated (only the intentionally-public GET branding is open).
- JWT crashes if the secret is missing; no secrets committed to the repo.
- The double-entry settlement ledger design is sound and now unit-tested.
- Withdrawal has a pending-total double-spend guard.

---

## 🔌 Plugins / services you must set up (no fakes)

These are declared-but-inactive in the code and need real credentials/config:
1. **Email / SMS / Push** (Communication Platform channels) — pick providers
   (e.g. an SMTP/email API, an SMS gateway, web-push keys), add credentials as
   Railway env vars, implement each channel adapter's `send()`.
2. **USDT deposits + treasury** — needs a TRON node/API + address management
   before the `USDT_TRC20` funding adapter can go live.
3. **Payment gateway** (optional) — only if you want non-P2P deposits.
4. **Redis rate-limit store** — you have Redis; just wire the store (F-3).
I will not wire these against your live systems using the leaked credentials —
rotate them first, then I can implement the adapters and you paste the fresh
keys into Railway (never into chat).

---

## Next-session priority order (my recommendation)
1. Rotate all secrets (you) + confirm.
2. F-1 token-minting fix (money correctness).
3. Integration tests for the money flows, then F-2 settlement unlock behind them.
4. F-3 Redis rate limiter (scale blocker).
5. W-1..W-4 admin/workflow gaps.
6. UI/UX pass.
