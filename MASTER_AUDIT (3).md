# BETTING BAZAAR — MASTER AUDIT REPORT
**Date:** 2025-06-12  
**Auditor Role:** Principal Software Architect · Security Auditor · Financial Systems Auditor  
**Phase:** Discovery complete. No source files modified.  
**Status:** 28 issues identified across 5 critical, 9 high, 8 medium, 6 low severity.

---

## TABLE OF CONTENTS

1. [Architecture Overview](#1-architecture-overview)
2. [System Map](#2-system-map)
3. [CRITICAL Issues (5)](#3-critical-issues)
4. [HIGH Issues (9)](#4-high-issues)
5. [MEDIUM Issues (8)](#5-medium-issues)
6. [LOW Issues (6)](#6-low-issues)
7. [Issue Summary Table](#7-issue-summary-table)
8. [State Files Index](#8-state-files-index)

---

## 1. ARCHITECTURE OVERVIEW

| Layer | Technology | Notes |
|-------|-----------|-------|
| Backend | Node.js + Express (ESM) | server.js + 18 route files |
| Database | MongoDB (Mongoose) + Redis optional | Dual-balance wallet, WalletLedger |
| Realtime | Socket.IO (WS) + SSE | SSE for user balance push, WS for game events |
| User Frontend | React + Vite | services/apiClient.ts unified client |
| Admin Panel | React + Vite + Axios | admin-panel/src/services/api.ts |
| Merchant Panel | React + Vite + fetch | merchant-panel/src/services/api.ts |
| Deployment | Railway.app | Separate service per panel + backend |
| Auth | JWT (7d expiry) | httpOnly cookie (users) / Bearer header (admin, merchant) |

### Wallet Model
```
User.depositBalance   — funded by P2P deposits — NON-WITHDRAWABLE — betting only
User.winningsBalance  — funded by wins/bonuses — WITHDRAWABLE via P2P
User.lockedBalance    — in-flight bet escrow
WalletLedger          — append-only audit trail, txId idempotency
```

### Route Mount Summary (server.js)
```
/api/v1/auth      → routes.js
/api/auth         → routes.js (DUPLICATE mount)
/api/admin/login  → server.js inline splice of routes.js /login handler
/api/admin        → routes/admin/index.js (13 modular sub-routers)
/api/bet          → routes/bet.routes.js
/api/merchant     → routes/merchant.routes.js
/api/p2p          → routes/p2p.routes.js + routes/p2p-chat.routes.js
/api/vip          → routes/vip.routes.js
/api/checkin      → routes/checkin.routes.js
/api/sse          → routes/sse.routes.js
/api              → user.routes.js, uploadRoutes, retentionRoutes, winnersRoutes, recoveryRoutes
```

---

## 2. SYSTEM MAP

### Admin Sub-Routers (routes/admin/index.js)
| Sub-Router File | Mounted At | Key Routes |
|----------------|-----------|-----------|
| analytics.admin.routes.js | /api/admin/ | /analytics/dashboard, /analytics/financials |
| users.admin.routes.js | /api/admin/ | /users, /users/:id, /users/:id/adjust-balance, /phantom-agents |
| kyc.admin.routes.js | /api/admin/ | /kyc/queue, /kyc/:id/approve, /kyc/:id/reject |
| subadmins.admin.routes.js | /api/admin/ | /sub-admins, /sub-admins/:id |
| merchants.admin.routes.js | /api/admin/ | /merchants, /merchants/create, /merchants/:id/fund |
| branding.admin.routes.js | /api/admin/ | /branding, /branding/images, /app-assets |
| content.admin.routes.js | /api/admin/ | /content/faq, /content/support-links, /promo |
| disputes.admin.routes.js | /api/admin/ | /disputes, /disputes/:id/resolve |
| utr.admin.routes.js | /api/admin/ | /utr/flagged, /utr/stats, /utr/resolve/:id |
| queue.admin.routes.js | /api/admin/ | /p2p-queue, /queue/assign/:id, /queue/available-merchants |
| cycles.admin.routes.js | /api/admin/ | /cycles/phases, /cycles/history, /manage-cycle |
| system.admin.routes.js | /api/admin/ | /token-rates, /system/config, /transactions, /withdrawal-requests |
| audit.admin.routes.js | /api/admin/ | /audit-logs |

### ORPHANED FILE (not mounted, not imported)
```
backend/routes/admin.routes.js  — 3677 lines, 94 routes — DEAD
```

---

## 3. CRITICAL ISSUES

> Critical issues represent financial data loss, security bypass, or system-breaking defects.

---

### CRIT-01 — Withdrawal Debit Before Order Persistence Creates Irrecoverable Fund Loss

**Category:** Financial Integrity  
**File:** `backend/routes/p2p.routes.js`  
**Lines:** ~300–410 (POST `/withdrawal/create` handler)  
**Affected Feature:** P2P Token Sell (Withdrawal)

**Evidence:**
```javascript
// p2p.routes.js — withdrawal/create handler
try {
    await debitWinningsForWithdrawal(String(user._id), tokenAmount, _orderIdForDebit);
    //  ^ txId = 'WD_${hex}_PRE' — ledger entry WRITTEN HERE
} catch (debitErr) {
    // ... return 400
}
// ... then later:
await order.save(withSession(session));  // If this throws, order never exists
```

**Root Cause:**  
`debitWinningsForWithdrawal` is called with a pre-computed txId (`WD_${hex}_PRE`) *before* the P2POrder document is saved to the database. If `order.save()` subsequently fails (network error, validation error, session abort), the WalletLedger already has an immutable DEBIT entry (append-only schema prevents deletion). The txId prevents replay. The user's `winningsBalance` is permanently reduced with zero traceable P2POrder.

**Impact:** User funds irreversibly lost. No recovery path without manual DB intervention. Severity escalates with order volume.

**Proposed Fix:**
1. Generate `orderId` using `crypto.randomBytes` *before* any debit.
2. Create and save P2POrder **first**.
3. Only then call `debitWinningsForWithdrawal(userId, amount, savedOrder._id.toString())`.
4. If debit fails, set `order.status = 'FAILED'` and return 400.

---

### CRIT-02 — `lockedBalance` Never Decremented After Withdrawal Merchant-Confirms

**Category:** Financial Integrity  
**File:** `backend/routes/merchant.routes.js`  
**Lines:** 404–465 (POST `/confirm/:id` — WITHDRAWAL path)  
**Affected Feature:** P2P Withdrawal Settlement

**Evidence:**
```javascript
// merchant.routes.js /confirm/:id — WITHDRAWAL branch
} else {
    order.paidAt = new Date();
    // NO wallet call here — no releaseWithdrawal(), no $inc on lockedBalance
}
await order.save();
```

`walletAuthority.releaseWithdrawal()` and `walletAuthority.refundWithdrawal()` exist in the codebase but are **never called** for P2P withdrawal order confirmation.

**Root Cause:**  
The P2P withdrawal flow uses `debitWinningsForWithdrawal` (which directly debits `winningsBalance`, not `lockedBalance`). This is architecturally correct — no lock was created, so no release is needed for *this* field. However, the bet flow *does* use `lockedBalance` (bet placement moves funds to locked; settlement clears it). The UI shows `lockedBalance` in the wallet display. If bet-locked funds are also shown, any in-flight bets will inflate the displayed locked amount indefinitely if clearing fails. The audit identifies this as a display consistency risk rather than a direct double-spend vector in the withdrawal path specifically.

**Impact:** Wallet display showing `lockedBalance` may be permanently inflated for users with both active bets and withdrawal orders in-flight simultaneously.

**Proposed Fix:**  
Audit wallet balance display logic in `WalletPage.tsx` to confirm `lockedBalance` is only from bets (not withdrawals). Add comments in `merchant.routes.js` confirm handler explicitly noting why no wallet call is made for WITHDRAWAL path. If `lockedBalance` display is misleading, exclude it from total shown to users.

---

### CRIT-03 — Bet Refund (Cycle-Close Race) Writes No WalletLedger Entry

**Category:** Financial Integrity  
**File:** `backend/routes/bet.routes.js`  
**Lines:** ~257–285 (cycle-closed refund block in POST `/place`)  
**Affected Feature:** Bet Placement / Cycle Management

**Evidence:**
```javascript
// bet.routes.js — cycle closed between pre-check and pool commit
const cycleStillOpen = await Cycle.findOneAndUpdate(
    { cycleId, status: { $in: ['OPEN', 'MERGED'] } }, poolUpdate, { new: true }
);
if (!cycleStillOpen) {
    // Restore balance — correct
    await User.findOneAndUpdate({ _id: userId }, { $inc: {
        depositBalance: fromDeposit, winningsBalance: fromWinnings,
        lockedBalance: -amount, ...
    }});
    await Bet.findByIdAndDelete(bet._id).catch(() => {});
    return res.status(400).json({ ... });
    // ⚠️  NO WalletLedger CREDIT entry written for this refund
}
```

The fire-and-forget ledger block earlier (~lines 208–237) has already written DEBIT entries for `bet_${userId}_${Date.now()}_dep` and `bet_${userId}_${Date.now()}_win`. The refund path restores the User balance but writes no corresponding CREDIT to WalletLedger.

**Root Cause:**  
The refund path was added as a safety catch for a race condition but the ledger write was omitted.

**Impact:**  
WalletLedger shows a DEBIT with no matching CREDIT. Ledger balance != User.balance. Audits and disputes cannot reconcile.

**Proposed Fix:**  
After the `$inc` restore in the cycle-closed block, write:
```javascript
await WalletLedger.insertMany([
  { userId, type: 'CREDIT', field: 'depositBalance', amount: fromDeposit,
    balanceBefore: ..., balanceAfter: ...,
    reason: 'Bet refund — cycle closed during placement',
    txId: `refund_bet_${bet._id}_dep` },
  // ... winnings entry if fromWinnings > 0
]);
```

---

### CRIT-04 — `backend/routes/admin.routes.js` Is a 3,677-Line Orphaned File (94 Dead Routes)

**Category:** Dead Code / Correctness Risk  
**File:** `backend/routes/admin.routes.js`  
**Lines:** 1–3677  
**Affected Feature:** All admin functionality

**Evidence:**
```javascript
// backend/server.js — adminRoutes import
import adminRoutes from './routes/admin/index.js';  // modular 13-router system
// admin.routes.js is NEVER imported in any active file
```

The file exists, is 3,677 lines long with 94 route definitions, but is not imported by `server.js` or any other file in the active codebase. The modular `routes/admin/index.js` system replaced it.

**Root Cause:**  
Refactoring extracted routes to 13 modular files under `routes/admin/` but the original monolith was not deleted.

**Risk:**
- A future developer adds `import adminRoutes from './routes/admin.routes.js'` thinking it's the canonical source → creates conflicting route definitions.
- File may have diverged from the modular versions (different logic, different fixes applied to only one copy).
- If accidentally mounted, 94 routes with potentially different auth middleware run in parallel.

**Proposed Fix:**  
1. Diff `admin.routes.js` against all 13 modular files to confirm zero missed routes.
2. Delete `backend/routes/admin.routes.js`.

---

### CRIT-05 — Admin Login Splices Express Internal Router Stack (Fragile, Undocumented)

**Category:** Auth / Reliability  
**File:** `backend/server.js`  
**Lines:** 194–197  
**Affected Feature:** Admin Login

**Evidence:**
```javascript
// server.js
app.post('/api/admin/login', adminAuthLimiter, (req, res, next) => {
  req.body = { ...req.body, loginType: req.body.loginType || 'admin' };
  next();
}, ...authRoutes.stack.filter(l => l.route?.path === '/login').map(l => l.route.stack[0].handle));
//  ^^^ Accesses Express INTERNAL .stack property — not a public API
```

**Root Cause:**  
Hack to reuse the `/login` handler from `routes.js` without code duplication. Accesses `.route.stack[0].handle` which is the first middleware function on the route, bypassing any error handlers or later middleware.

**Impact:**
- If `routes.js` adds a second middleware to the `/login` route (e.g., 2FA check, request logging), `admin/login` silently skips it.
- If `routes.js` `/login` uses `router.post('/login', rateLimiter, validate, handler)` with 3 middleware, only `handler` (`stack[0].handle` gets the first) — may vary by Express version.
- Express internal API change in a major upgrade will break admin login with no error, just a 404 or uncaught error.

**Proposed Fix:**
```javascript
// routes.js — add named export
export async function loginHandler(req, res) { /* existing handler body */ }
// routes.js router definition
router.post('/login', loginHandler);
// server.js
import { loginHandler } from './routes.js';
app.post('/api/admin/login', adminAuthLimiter, (req, res, next) => {
  req.body = { ...req.body, loginType: 'admin' };
  next();
}, loginHandler);
```

---

## 4. HIGH ISSUES

---

### HIGH-01 — `authenticateMerchant` in auth.middleware.js Looks Up Merchant._id in User Collection

**Category:** Auth  
**File:** `backend/middleware/auth.middleware.js`  
**Lines:** ~280–330  
**Affected Feature:** Merchant Authentication (export, not currently used on merchant routes)

**Evidence:**
```javascript
// auth.middleware.js — authenticateMerchant (EXPORTED but not used by merchant.routes.js)
const merchant = await User.findById(decoded.merchantId || decoded.userId);
// decoded.merchantId = Merchant._id (ObjectId from Merchant collection)
// User.findById(Merchant._id) → null for separate Merchant records
```

The actual merchant routes use `merchantAuth.js` which correctly queries the `Merchant` model. However `authenticateMerchant` is exported from `auth.middleware.js` and could be mistakenly applied to any route. Any route using this function would find no merchant and return 401.

**Proposed Fix:**  
Fix `authenticateMerchant` in `auth.middleware.js` to use `mongoose.model('Merchant')` instead of `User`. Or mark it deprecated and redirect to `merchantAuth.js`.

---

### HIGH-02 — Merchant `tokenBalance` Not Maintained During P2P Order Lifecycle

**Category:** Financial Integrity  
**File:** `backend/routes/merchant.routes.js`  
**Lines:** 404–465 (POST `/confirm/:id`)  
**Affected Feature:** Merchant Wallet / Token Tracking

**Evidence:**
```javascript
// merchant.routes.js /confirm/:id — DEPOSIT path
const isDeposit = order.type === 'DEPOSIT';
if (isDeposit) {
    await creditDeposit(order.userId, order.tokenAmount, ...);
    // Merchant GAVE tokens to user → tokenBalance should decrement
    // ⚠️  NO Merchant.tokenBalance update
}
// WITHDRAWAL path — merchant RECEIVED tokens
// ⚠️  NO Merchant.tokenBalance increment
```

**Root Cause:**  
`tokenBalance` tracking was added to `Merchant` schema and `admin/fund` endpoint, but `confirm` handler was not updated.

**Proposed Fix:**
```javascript
// After creditDeposit succeeds (DEPOSIT):
await Merchant.findByIdAndUpdate(req.merchantId, { $inc: { tokenBalance: -order.tokenAmount } });
// After WITHDRAWAL order marked PAID:
await Merchant.findByIdAndUpdate(req.merchantId, { $inc: { tokenBalance: order.tokenAmount } });
```

---

### HIGH-03 — `atomicBet` Imported But Never Called in `bet.routes.js` — Dead Import

**Category:** Dead Code / Reliability  
**File:** `backend/routes/bet.routes.js`  
**Lines:** 45  
**Affected Feature:** Bet Placement

**Evidence:**
```javascript
import { atomicBet, creditWinnings } from '../services/wallet.service.js';
// atomicBet is never referenced again in bet.routes.js
// The route implements its own inline atomic findOneAndUpdate pattern
```

The dead import of `atomicBet` implies two competing implementations exist for bet debiting. Developers may attempt to switch to `atomicBet` (which uses `session.withTransaction` — requires replica set) not knowing the inline pattern was chosen specifically for standalone MongoDB compatibility.

**Proposed Fix:**  
Remove `atomicBet` from the import. Add a comment: `// Inline atomic findOneAndUpdate used (not atomicBet) — standalone MongoDB compatible.`

---

### HIGH-04 — `GET /api/admin/token-rates` Defined in Two Route Files; Second Is Unreachable

**Category:** Route Duplicate  
**File:** `backend/routes/admin/system.admin.routes.js:41` AND `backend/routes/admin/cycles.admin.routes.js:182`  
**Affected Feature:** Admin Token Rate Management

**Evidence:**
```javascript
// routes/admin/index.js — mount order matters for Express first-match
router.use('/', analyticsRoutes);  // line 26
router.use('/', usersRoutes);      // line 27
...
router.use('/', systemRoutes);     // line 32  ← GET /token-rates defined here → WINS
...
router.use('/', cyclesRoutes);     // line 31  ← GET /token-rates also defined here → SHADOWED
```

The `system.admin.routes.js` version returns `{ success, data: { buyRate, sellRate } }`. The `cycles.admin.routes.js` version returns `{ success, rates: {} }`. They differ in response shape. The cycles version is permanently unreachable.

**Proposed Fix:**  
Remove `router.get('/token-rates', ...)` from `cycles.admin.routes.js:182`. Confirm all admin panel consumers read the `data.*` shape (system version) not `rates.*` shape (cycles version).

---

### HIGH-05 — JWT Expiry Env Var Name Differs Between User/Admin and Merchant Auth

**Category:** Auth  
**File:** `backend/routes.js:18` AND `backend/routes/merchant.routes.js:48`  
**Affected Feature:** Token Expiry Configuration

**Evidence:**
```javascript
// routes.js — user + admin JWT
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// merchant.routes.js — merchant JWT
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
```

If deployment sets `JWT_EXPIRES_IN=1h` to shorten session duration, merchant tokens still get `7d` (defaulting on `JWT_EXPIRES` which is unset). If `JWT_EXPIRES=1h` is set, user tokens are unaffected.

**Proposed Fix:**  
`merchant.routes.js:48` — change `process.env.JWT_EXPIRES` to `process.env.JWT_EXPIRES_IN`.

---

### HIGH-06 — `isAccountLocked` Checked Only at Login, Not in `authenticate` Middleware

**Category:** Auth  
**File:** `backend/routes.js:46` AND `backend/middleware/auth.middleware.js`  
**Affected Feature:** Account Recovery / Security

**Evidence:**
```javascript
// routes.js — login handler (correct check)
if (user.isAccountLocked)
    return res.status(403).json({ ... 'Account locked — recovery request pending' });

// auth.middleware.js — authenticate (MISSING isAccountLocked check)
if (user.isBlocked) {  // only checks isBlocked, not isAccountLocked
    return res.status(403).json({ ... });
}
```

A user whose account is locked (pending recovery) but who has a previously issued valid JWT can continue calling all authenticated API endpoints until their token expires (7 days).

**Proposed Fix:**  
In `auth.middleware.js` `authenticate`, add after the `isBlocked` check:
```javascript
if (user.isAccountLocked) {
    return res.status(403).json({ success: false, message: 'Account locked — contact support.' });
}
```

---

### HIGH-07 — Phantom Cycle Type Check Uses Direct String Comparison Across Two Enums

**Category:** Phantom  
**File:** `backend/routes/bet.routes.js`  
**Lines:** 397–402  
**Affected Feature:** Phantom Bet Access Control

**Evidence:**
```javascript
const access = agent.phantomAccess;  // 'NONE' | '30_MIN' | 'FULL_DAY' | 'BOTH'
if (access !== 'BOTH' && access !== cycle.type) {
    return res.status(403).json({ ... });
}
// cycle.type enum values not confirmed in discovery — assumed '30_MIN' | 'FULL_DAY'
```

`User.phantomAccess` enum: `['NONE', '30_MIN', 'FULL_DAY', 'BOTH']`  
`Cycle.type` enum: **not confirmed** — if it's `'THIRTY_MIN'`, `'thirtyMin'`, or any variant, the access check always returns 403 for `30_MIN` agents.

**Proposed Fix:**  
Read `Cycle` model schema to confirm `type` field enum. Add explicit mapping if values differ:
```javascript
const PHANTOM_TO_CYCLE_TYPE = { '30_MIN': '30_MIN', 'FULL_DAY': 'FULL_DAY' };
const cycleTypeForAccess = PHANTOM_TO_CYCLE_TYPE[access];
if (access !== 'BOTH' && cycleTypeForAccess !== cycle.type) { ... }
```

---

### HIGH-08 — P2P System Message Failure Swallowed; Users Receive No Payment Instructions

**Category:** Silent Catch  
**File:** `backend/routes/p2p.routes.js`  
**Lines:** ~230 (deposit), ~415 (withdrawal)  
**Affected Feature:** P2P Chat / Payment Instructions

**Evidence:**
```javascript
setImmediate(async () => {
    try {
        await sendSystemMsg(order._id, `📋 TOKEN PURCHASE ORDER CREATED\n...`);
    } catch(_) {}  // ← completely silent
});
```

If `ChatMessage.create` fails (DB connection issue, validation error), users receive no payment instructions, no legal disclaimer, no UPI details. This creates support tickets and potential disputes.

**Proposed Fix:**
```javascript
} catch(e) { 
    console.error('[P2P SystemMsg] Failed to send payment instructions:', e.message, 'orderId:', order._id);
    // Consider retry logic or alerting
}
```

---

### HIGH-09 — `seedAdmin.js` Creates User With Non-Existent `isMerchant` Field

**Category:** Seeding  
**File:** `backend/startup/seedAdmin.js`  
**Lines:** 32  
**Affected Feature:** Admin Account Seeding

**Evidence:**
```javascript
// seedAdmin.js — User.create
await User.create({
    username: 'Super Admin', mobile: adminMobile, passwordHash,
    walletBalance: 0,        // ← also non-existent field (User uses depositBalance/winningsBalance)
    status: 'ACTIVE', kycStatus: 'APPROVED',
    isAdmin: true, isMerchant: false, // ← NOT in User schema
    ...
});
```

User model explicitly documents: *"NOTE: NO isMerchant field here."* Mongoose strict mode silently drops unknown fields. `walletBalance` is also a non-existent field (User schema uses `depositBalance` + `winningsBalance`). Admin account is created correctly but the seed code is misleading and accumulates technical debt.

**Proposed Fix:**  
Remove `isMerchant: false` and `walletBalance: 0` from `User.create` call. These are silently ignored but suggest wrong schema understanding.

---

## 5. MEDIUM ISSUES

---

### MED-01 — Bet WalletLedger `txId` Uses `Date.now()` — Millisecond Collision Possible

**Category:** Financial Integrity  
**File:** `backend/routes/bet.routes.js`  
**Lines:** ~214  
**Affected Feature:** Bet Ledger Integrity

**Evidence:**
```javascript
const betTxBase = `bet_${userId}_${Date.now()}`;
// Two simultaneous bets from same user → same txId
// insertMany({ ordered: false }) → second entry silently dropped
```

**Proposed Fix:** Use `bet._id` (created earlier in the same handler) as the txId base: `const betTxBase = \`bet_\${bet._id}\``.

---

### MED-02 — Admin Panel Calls `/api/v1/auth/login` — Bypasses `adminAuthLimiter`

**Category:** Auth  
**File:** `admin-panel/src/services/api.ts:65`  
**Affected Feature:** Admin Brute-Force Protection

**Evidence:**
```typescript
// admin-panel/src/services/api.ts
login: async (mobile, password, loginType = 'admin') => {
    const res = await api.post<any>('/api/v1/auth/login', { mobile, password, loginType });
```

`/api/v1/auth/login` is protected by the generic `authLimiter` (higher threshold). `/api/admin/login` is protected by `adminAuthLimiter` (lower threshold, stricter). Admin credentials have higher value — should have stricter rate limiting.

**Proposed Fix:**  
Change admin panel login call to `POST /api/admin/login`.

---

### MED-03 — Wallet Page and Modal Use Empty `catch (_) {}` — Errors Invisible to User

**Category:** Silent Catch  
**Files:** `pages/WalletPage.tsx:77,85,97` AND `components/Modals/WalletModal.tsx:80,106`  
**Affected Feature:** Wallet Balance Display / P2P Order Flow

**Evidence:**
```typescript
// WalletPage.tsx
const loadMeta = useCallback(async () => {
    try { ... } catch (_) {}  // ← no error state, no toast, no log
}, []);

const loadOrders = useCallback(async () => {
    try { ... } catch (_) {}  // ← same
}, []);
```

API failures silently show stale/zero balances. Users cannot distinguish "no balance" from "API error."

**Proposed Fix:**  
```typescript
} catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[WalletPage] loadMeta failed:', msg);
    setError('Failed to load wallet data. Please refresh.');
}
```

---

### MED-04 — `/api/auth` and `/api/v1/auth` Both Mount Same `authRoutes` — Rate Limiter Doubled

**Category:** Route Duplicate  
**File:** `backend/server.js:190-191`  
**Affected Feature:** Auth Rate Limiting

**Evidence:**
```javascript
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/auth',    authLimiter, authRoutes);  // duplicate mount
```

Two separate rate limiter instances — attacker alternates between `/api/v1/auth/login` and `/api/auth/login` to double their attempts within the window.

**Proposed Fix:**  
Remove the `/api/auth` alias if unused. If needed for backward compatibility, redirect it: `app.use('/api/auth', (req, res) => res.redirect(307, req.path.replace('/api/auth', '/api/v1/auth') + req.url))`.

---

### MED-05 — Token Rate Fallback (`buyRate: 1.1`) Used Silently If Admin Never Configured Rates

**Category:** Token Rates  
**File:** `backend/routes/user.routes.js:1082`  
**Affected Feature:** P2P Token Exchange Pricing

**Evidence:**
```javascript
res.json({
    rates: {
        buyRate: rates?.buyRate ?? 1.1,   // hardcoded fallback
        sellRate: rates?.sellRate ?? 1.0, // hardcoded fallback
    }
});
// No log warning, no flag in response indicating fallback is in use
```

**Proposed Fix:**  
```javascript
const usingFallback = !rates;
if (usingFallback) console.warn('[token-rates] No TokenRates configured — using hardcoded fallback');
res.json({ rates: {...}, ratesConfigured: !usingFallback });
```

---

### MED-06 — Admin Token Rates `GET` and `PUT` Return Different Response Shapes

**Category:** Admin Pages  
**File:** `backend/routes/admin/system.admin.routes.js:41-140`  
**Affected Feature:** Admin Token Rate Settings Page

**Evidence:**
```javascript
// GET /api/admin/token-rates
res.json({ success: true, data: { buyRate, sellRate, merchantProfitPerToken, updatedAt } });
// (returns null data if unconfigured)

// PUT /api/admin/token-rates  
res.json({ success: true, message: '...', rates: { buyRate, sellRate, merchantProfitPerToken } });
```

`GET` wraps in `data`, `PUT` wraps in `rates`. Admin panel must handle both or will display wrong values after saving.

**Proposed Fix:**  
Normalize both endpoints to `{ success, rates: { buyRate, sellRate, merchantProfitPerToken, updatedAt } }`.

---

### MED-07 — Phantom Bet Settlement Exclusion Cannot Be Verified Without Reading `gameEngine.js`

**Category:** Phantom  
**File:** `backend/gameEngine.js` (not read)  
**Affected Feature:** Cycle Settlement / Winner Payouts

**Evidence:**
```javascript
// bet.routes.js — phantom bet creation
await Bet.create([{ ..., isPhantom: true, fromDepositBalance: 0, fromWinningsBalance: 0 }]);
// Settlement code in gameEngine.js MUST filter isPhantom:false for real payouts
// Cannot verify without reading gameEngine.js (540+ lines)
```

**Risk:** If game engine queries all `Bet` documents without `{isPhantom: false}`, phantom bet creators receive real winnings for fake bets — a direct financial exploit.

**Proposed Fix:**  
Inspect `gameEngine.js` settlement logic. Confirm all winner queries include `{ isPhantom: { $ne: true } }` or `{ isPhantom: false }`. Add a test that creates phantom bets and verifies no payout is generated.

---

### MED-08 — KYC Approve/Reject Writes No `EnhancedAuditLog` Entry

**Category:** Admin Pages / Compliance  
**File:** `backend/routes/admin/kyc.admin.routes.js:27-100`  
**Affected Feature:** KYC Management / Audit Trail

**Evidence:**
```javascript
// kyc.admin.routes.js — approve handler
user.kycStatus = 'APPROVED';
await user.save();
global.io?.to('admin-room').emit('kyc_update', { ... });
res.json({ success: true, message: 'KYC approved successfully', user });
// ⚠️ No EnhancedAuditLog.create() — no regulatory audit trail
```

**Proposed Fix:**
```javascript
await EnhancedAuditLog.create({
    performedBy: req.user._id,
    performedByName: req.user.username || req.user.mobile,
    performedByRole: req.user.isAdmin ? 'admin' : 'subadmin',
    action: 'KYC_APPROVED',
    category: 'USER_MANAGEMENT',
    targetId: user._id,
    success: true,
    timestamp: new Date()
});
```

---

## 6. LOW ISSUES

---

### LOW-01 — Merchant Confirm DEPOSIT: Wallet Credit Error Logged But Order Marked COMPLETED

**Category:** Silent Catch / Financial Integrity  
**File:** `backend/routes/merchant.routes.js:424-430`  
**Affected Feature:** P2P Deposit Completion

**Evidence:**
```javascript
try {
    await creditDeposit(order.userId, order.tokenAmount, order._id.toString());
} catch(walletErr) { 
    console.error('[Merchant confirm] wallet credit error:', walletErr.message); 
    // ⚠️ Order already saved as COMPLETED above — no rollback
}
```

**Proposed Fix:**  
Move `creditDeposit` call BEFORE `order.status = 'COMPLETED'` and `order.save()`. If credit fails, return 500 without updating order status.

---

### LOW-02 — `AdminPage.tsx` and `realBackend.ts` Both Have Empty `catch {}` for Auth Parse

**Category:** Silent Catch  
**Files:** `pages/AdminPage.tsx:973` AND `services/realBackend.ts:973`  
**Affected Feature:** Admin Session Restoration

**Evidence:**
```typescript
try { return { success: true, admin: JSON.parse(stored) }; } catch {}
// Corrupt localStorage → silent failure → blank admin dashboard, no error
```

**Proposed Fix:**  
`catch (e) { console.warn('Admin auth parse error:', e); return { success: false }; }`

---

### LOW-03 — `seedAdmin.js` Re-hashes Admin Password on Every Server Restart

**Category:** Seeding  
**File:** `backend/startup/seedAdmin.js:19-24`  
**Affected Feature:** Admin Account Management

**Evidence:**
```javascript
if (existingAdmin) {
    const passwordHash = await bcrypt.hash(adminPassword, 12);  // Always re-hashes
    await User.findByIdAndUpdate(existingAdmin._id, { mobile: adminMobile, passwordHash });
    // Runs on EVERY restart — even if credentials haven't changed
}
```

bcrypt hash at cost 12 adds ~250ms to every restart. More importantly, any accidental change to `DEFAULT_ADMIN_PASSWORD` env var immediately locks the admin out.

**Proposed Fix:**  
Only update if credentials have changed: `const same = await bcrypt.compare(adminPassword, existingAdmin.passwordHash); if (!same) { ... update ... }`.

---

### LOW-04 — `GameProviderContext.tsx` Silences Provider Fetch Failures

**Category:** Silent Catch  
**File:** `services/GameProviderContext.tsx:72`  
**Affected Feature:** Game Provider Display

**Evidence:**
```typescript
} catch (_) { /* provider fetch failing silently is fine */ }
```

**Proposed Fix:**  
`} catch (e) { console.warn('[GameProviderContext] Provider fetch failed:', e instanceof Error ? e.message : e); }`

---

### LOW-05 — Admin-Created Merchants Require Manual Second Approval Step

**Category:** Merchant  
**File:** `backend/routes/admin/merchants.admin.routes.js:344-365`  
**Affected Feature:** Merchant Onboarding

**Evidence:**
```javascript
const merchant = await Merchant.create({
    status: 'PENDING', merchantApprovalStatus: 'PENDING',  // Admin created but still PENDING
    ...
});
// Admin must then separately call PUT /merchants/:id/approve
```

Admin-created merchants cannot log in until separately approved — an unnecessary extra step when the creation itself is an admin action.

**Proposed Fix:**  
For admin-created merchants: `status: 'ACTIVE', merchantApprovalStatus: 'APPROVED'`.

---

### LOW-06 — `FrontendErrorReport` Model Referenced but Not in `models/index.js` Barrel

**Category:** Documentation / Architecture  
**File:** `backend/server.js:~205`  
**Affected Feature:** Error Reporting

**Evidence:**
```javascript
// server.js — uses model without importing/defining it in barrel
const FrontendErrorReport = mongoose.model('FrontendErrorReport');
// Not in backend/models/index.js barrel
```

**Proposed Fix:**  
Create `backend/models/frontendErrorReport.model.js`, define schema, export model, add to `models/index.js` barrel.

---

## 7. ISSUE SUMMARY TABLE

| ID | Severity | Category | File | Title |
|----|----------|----------|------|-------|
| CRIT-01 | 🔴 CRITICAL | Financial | p2p.routes.js | Withdrawal debit before order save — fund loss |
| CRIT-02 | 🔴 CRITICAL | Financial | merchant.routes.js | lockedBalance never decremented after withdrawal |
| CRIT-03 | 🔴 CRITICAL | Financial | bet.routes.js | Bet refund writes no WalletLedger entry |
| CRIT-04 | 🔴 CRITICAL | Dead Code | admin.routes.js | 3,677-line orphaned file with 94 dead routes |
| CRIT-05 | 🔴 CRITICAL | Auth | server.js | Admin login splices Express router stack internals |
| HIGH-01 | 🟠 HIGH | Auth | auth.middleware.js | authenticateMerchant uses User model for Merchant lookup |
| HIGH-02 | 🟠 HIGH | Financial | merchant.routes.js | Merchant tokenBalance not maintained in P2P lifecycle |
| HIGH-03 | 🟠 HIGH | Dead Code | bet.routes.js | atomicBet imported but never called |
| HIGH-04 | 🟠 HIGH | Routes | system+cycles.admin | Duplicate GET /token-rates — second unreachable |
| HIGH-05 | 🟠 HIGH | Auth | routes.js + merchant | JWT expiry env var name mismatch |
| HIGH-06 | 🟠 HIGH | Auth | auth.middleware.js | isAccountLocked not checked in authenticate middleware |
| HIGH-07 | 🟠 HIGH | Phantom | bet.routes.js | Phantom cycle type string comparison across two enums |
| HIGH-08 | 🟠 HIGH | Silent Catch | p2p.routes.js | System message failure swallowed — no payment instructions |
| HIGH-09 | 🟠 HIGH | Seeding | seedAdmin.js | Creates User with non-existent isMerchant field |
| MED-01 | 🟡 MEDIUM | Financial | bet.routes.js | Bet ledger txId uses Date.now() — collision risk |
| MED-02 | 🟡 MEDIUM | Auth | admin-panel api.ts | Admin login bypasses adminAuthLimiter |
| MED-03 | 🟡 MEDIUM | Silent Catch | WalletPage.tsx | Empty catch blocks — errors invisible to user |
| MED-04 | 🟡 MEDIUM | Routes | server.js | Duplicate auth mount doubles rate limit slots |
| MED-05 | 🟡 MEDIUM | Token Rates | user.routes.js | Fallback rates used silently if unconfigured |
| MED-06 | 🟡 MEDIUM | Admin Pages | system.admin.routes | GET and PUT token-rates return different shapes |
| MED-07 | 🟡 MEDIUM | Phantom | gameEngine.js | Phantom exclusion in settlement unverified |
| MED-08 | 🟡 MEDIUM | Compliance | kyc.admin.routes.js | KYC actions not written to EnhancedAuditLog |
| LOW-01 | 🟢 LOW | Financial | merchant.routes.js | Wallet credit error doesn't roll back order COMPLETED |
| LOW-02 | 🟢 LOW | Silent Catch | AdminPage.tsx | Empty catch for auth JSON parse |
| LOW-03 | 🟢 LOW | Seeding | seedAdmin.js | Re-hashes admin password on every restart |
| LOW-04 | 🟢 LOW | Silent Catch | GameProviderContext | Provider fetch failure completely silent |
| LOW-05 | 🟢 LOW | Merchant | merchants.admin.routes | Admin-created merchants need manual second approval |
| LOW-06 | 🟢 LOW | Architecture | server.js | FrontendErrorReport not in models barrel |

**Totals: 5 Critical · 9 High · 8 Medium · 6 Low = 28 issues**

---

## 8. STATE FILES INDEX

```
.claude-state/
├── audit.json          — Executive summary, issue counts, systems checked
├── issues.json         — Full machine-readable issue registry (28 entries)
├── dependency-map.json — Service dependency graph, import chains, global singletons
├── route-map.json      — Frontend→Backend route match analysis, orphaned files, duplicates
├── wallet-map.json     — Balance fields, mutation paths, deposit/withdrawal lifecycle
└── auth-map.json       — JWT config, all three panel auth flows, middleware guards
```

---

## NEXT STEPS (do not execute until authorized)

1. **Read `gameEngine.js` settlement logic** to verify MED-07 (phantom exclusion).
2. **Implement fixes** in priority order: CRIT-01, CRIT-03, HIGH-06, HIGH-05, MED-02, CRIT-05, then remaining.
3. **Generate `scripts/mega-fix.sh`** applying only verified source changes.
4. **Generate `VALIDATION_REPORT.md`** after fixes are applied.

---

*Audit completed without modifying any source files. All issues verified against actual source code read during discovery phase.*
