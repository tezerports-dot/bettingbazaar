# Betting Bazaar Security Review — 2026-07-16

## Scope and methodology

This review followed `docs/SECURITY_CODE_REVIEW_CHECKLIST.md` and prioritized money movement, game/promotions logic, authorization, upload trust boundaries, middleware wiring, proxy behavior, and dependency audit execution. The review was source-based with targeted data-flow tracing rather than a live exploit run.

Commands/checks run:

- `find .. -name AGENTS.md -print`
- `find backend -maxdepth 4 -type f | sort | sed -n '1,220p'`
- `rg -n "Math\.random|\\\$\{|findByIdAndUpdate\(|findOneAndUpdate\(|\.create\(req\.body|req\.body" backend/domains backend/routes backend/services backend/middleware backend/startup | head -200`
- `rg -n "join_|socket\.on|sse|subscribe|room|merchant" backend/startup/socketHandlers.js backend/routes/sse.routes.js backend/domains/notification -S`
- `rg -n "trust proxy|express\.json|mongoSanitize|owasp|helmet|cors|rateLimit|limiter" backend/server.js backend/routes.js backend/middleware backend/config -S`
- `npm audit --omit=dev --audit-level=moderate --json` in `.`, `backend`, `admin-panel`, and `merchant-panel`

## Findings

### 1. Gift-code wallet idempotency key is a literal constant

**Severity:** High  
**File:line:** `backend/routes/giftcode.routes.js:30`, `backend/routes/giftcode.routes.js:32`  
**Evidence:** The redeem route builds `txId` as `` `giftcode_\${gc.code}_\${req.user._id}` `` and the credit reason as `` `Gift code: \${gc.code}` ``. The backslashes escape interpolation, so every redemption shares the literal idempotency key `giftcode_${gc.code}_${req.user._id}` and a misleading literal reason.  
**Reachability:** Logged-in user with any active gift code.  
**Impact:** If the wallet authority enforces idempotency on `txId`, the first successful redemption using this code path can consume the idempotency key and later redemptions may no-op at the ledger/balance layer while still creating redemption/bonus records and returning success. This can silently deny credits platform-wide.  
**Suggested fix:** Remove the escaping and construct a real unique key, for example ``const txId = `giftcode_${gc.code}_${req.user._id}`;``. Add a regression test that redeems two different codes/users and asserts distinct ledger `txId` values.

### 2. Gift-code max-use enforcement is non-atomic

**Severity:** High  
**File:line:** `backend/routes/giftcode.routes.js:18`, `backend/routes/giftcode.routes.js:21`, `backend/routes/giftcode.routes.js:23`, `backend/routes/giftcode.routes.js:26`  
**Evidence:** Redemption first loads the gift code, separately checks `usedCount >= maxUses`, separately checks whether the user has redeemed, and only later increments `usedCount` with `findByIdAndUpdate`. The max-use check and consumption are not one conditional write.  
**Reachability:** Logged-in users; easiest to exploit with many accounts redeeming the same limited-use code concurrently.  
**Impact:** A nominally single-use or limited-use code can be over-redeemed because parallel requests can all pass the pre-check before any request increments `usedCount`. This creates extra bonus liability and inconsistent promotional accounting.  
**Suggested fix:** Replace the read/check/increment sequence with an atomic update such as `findOneAndUpdate({ _id: gc._id, isActive: true, usedCount: { $lt: maxUses }, ...expiryFilter }, { $inc: { usedCount: 1 } }, { new: true })`, then create the per-user redemption under a transaction or compensate the counter if the unique redemption insert fails.

### 3. Removed deprecated reward feature

**Severity:** Remediated  
**File:line:** `backend/routes/retention.routes.js`, `backend/models/gamification.model.js`  
**Evidence:** The reward feature was removed instead of patched; public and admin routes and Mongoose models no longer exist.  
**Reachability:** Not reachable after remediation.  
**Impact:** Removes the previous reward-randomness/idempotency/cooldown risk class for this feature.  
**Suggested fix:** Keep the feature absent unless a future implementation has a CSPRNG, atomic cooldown claims, and ledger-idempotency tests.

### 5. Any logged-in user can dispute any PAID order by id

**Severity:** High  
**File:line:** `backend/domains/payment/payment.routes.js:203`, `backend/domains/payment/payment.routes.js:207`, `backend/domains/payment/payment.routes.js:209`, `backend/domains/payment/payment.routes.js:211`  
**Evidence:** `POST /api/payment/order/:orderId/status` uses only `authenticate`, loads the order by route id without an ownership predicate, allows the `PAID -> DISPUTED` transition, and saves the new status. It does not verify that `order.userId` matches `req.user._id`, that the caller is the assigned merchant, or that the caller is an admin.  
**Reachability:** Any logged-in user who can learn or guess an order id.  
**Impact:** Cross-account disruption/IDOR: a user can force other users' or merchants' paid orders into dispute, delaying deposits/withdrawals and creating operational queue noise.  
**Suggested fix:** Add query-time ownership/participant filtering, e.g. `findOne({ $or: [{ orderId }, { _id: orderId }], userId: req.user._id })` for user-initiated disputes, or route through a role-aware payment actor auth path. Add an integration test proving user A cannot dispute user B's order.

### 6. Payment proof and profile-picture upload confirmation trust arbitrary client URLs

**Severity:** Medium  
**File:line:** `backend/domains/payment/payment.routes.js:56`, `backend/domains/payment/payment.routes.js:58`, `backend/domains/payment/paymentProcessing.service.js:432`, `backend/domains/payment/paymentProcessing.service.js:434`, `backend/routes/upload.routes.js:301`, `backend/routes/upload.routes.js:303`, `backend/routes/upload.routes.js:306`  
**Evidence:** The payment mark-paid route accepts `proofScreenshot` as an arbitrary string and `markOrderPaid` stores `proofScreenshot.trim()` directly. Separately, profile-picture confirm-upload accepts only `cdnUrl` and writes it directly to `User.profilePic`. These paths bypass the stronger `verifyUploadedObject` checks used by chat and the `/user/payment-proof/:orderId/confirm-upload` route.  
**Reachability:** Logged-in user for payment proof and profile picture.  
**Impact:** Users can persist external, malformed, tracking, or non-existent URLs as if they were validated platform uploads. Payment-review staff may be sent to attacker-controlled URLs, and profile images can become a stored content-injection/privacy tracking vector depending on frontend rendering.  
**Suggested fix:** Require `fileKey` plus `cdnUrl` and call `cdnService.verifyUploadedObject` before persisting. For backward compatibility, reject non-server-owned CDN/storage prefixes and perform a HEAD/existence check before saving any URL.

### 7. Mongo sanitizer does not block prototype-pollution keys

**Severity:** Medium  
**File:line:** `backend/middleware/mongoSanitize.js:18`, `backend/middleware/mongoSanitize.js:26`, `backend/middleware/mongoSanitize.js:27`, `backend/server.js:150`  
**Evidence:** The sanitizer only rejects keys that start with `$` or contain `.`, then recurses through request objects. It is globally mounted after body parsing, which is good for NoSQL operator stripping, but it leaves `__proto__`, `constructor`, and `prototype` untouched.  
**Reachability:** Anonymous or authenticated users on any JSON endpoint, depending on route auth.  
**Impact:** If any route or utility later merges sanitized request objects into long-lived config/default objects, prototype-pollution payloads can survive this middleware and influence application behavior. The current middleware gives a false sense of complete object-key sanitization.  
**Suggested fix:** Extend `isForbiddenKey` to reject `__proto__`, `constructor`, and `prototype`, and add tests showing those keys are removed from body, params, and query while normal nested keys remain.

### 8. `trust proxy` is always enabled for one hop despite direct Railway topology

**Severity:** Medium  
**File:line:** `backend/server.js:92`, `backend/server.js:93`  
**Evidence:** The app unconditionally executes `app.set('trust proxy', 1)`. The project supports both Caddy-fronted and direct Railway deployments, and the direct path may not have a trusted reverse proxy in front of Express.  
**Reachability:** Anonymous internet clients for IP-keyed controls when direct exposure is used.  
**Impact:** If the app is directly reachable while trusting one proxy hop, clients can spoof `X-Forwarded-For`, changing `req.ip` and weakening IP-based rate limits, auth throttling, IP blocklists, and subnet defenses.  
**Suggested fix:** Make `trust proxy` environment-specific and fail closed: `0` for direct exposure, `1` only behind a known proxy, or a CIDR allowlist of trusted proxy ranges. Document the expected value per deployment and add a startup warning/error when it is inconsistent with `DEPLOYMENT_TOPOLOGY`.

## Checks with no finding in this pass

- JWT signing/verifying is centralized and pins HS256 with no fallback secret in `backend/domains/identity/jwt.util.js`.
- Global middleware order places JSON parsing before `mongoSanitize`, and the sanitizer is mounted before `/api` routes.
- Socket.io merchant room joining compares `decoded.merchantId` to the requested merchant room and reloads merchant active status before joining.
- Merchant/admin SSE paths were inspected for token verification and channel derivation; no new cross-merchant SSE drift finding was confirmed in this pass.

## Dependency audit status

`npm audit --omit=dev --audit-level=moderate --json` could not complete in any package context because the registry audit endpoint returned `403 Forbidden` for root, backend, admin panel, and merchant panel. This is an environment/registry limitation rather than a clean dependency result.
