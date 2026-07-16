# Betting Bazaar Deep Security & Launch Readiness Review

Date: 2026-07-15
Scope: repository-level review of the Node/Express backend, user panel, admin panel, merchant panel, runtime configuration, payment/betting flows, upload/CDN paths, and production launch controls.

## Executive summary

This codebase already contains several strong controls: fail-fast production environment validation, centralized JWT signing and verification, Helmet/CSP, CORS allow-listing in production, global and sensitive-route rate limits, Mongo operator sanitization, request correlation, load shedding, Redis-backed limiters, and multiple integration/unit tests around money and auth paths.

Several code-level issues identified in the first review have now been remediated in this branch: private SSE routes revalidate revocation/current roles, account-recovery passwords use CSPRNG entropy, selected high-risk admin routes now enforce granular backend permissions, public SSE config is allow-listed, merchant bearer auth checks token revocation, and production refuses local-disk storage fallback. It should **still not be launched live until the remaining operational/legal blockers below are closed and independently re-tested**. The platform handles wagering, wallet balances, payment proof, merchant operations, KYC material, account recovery, and admin powers; a successful exploit can directly cause account takeover, unauthorized balance movements, privacy breaches, payment fraud, regulatory exposure, or service outage.

## Review methodology

- Enumerated repository structure and runtime entry points.
- Reviewed backend boot/middleware ordering, auth middleware, JWT utility, admin route aggregation, SSE channels, rate-limit tiers, upload paths, recovery flow, and production-readiness notes.
- Searched for risky patterns including token storage, secrets, mock/fake flows, `Math.random`, admin/sub-admin authorization, uploads, `dangerouslySetInnerHTML`, `innerHTML`, `eval`, direct URLs, and TODO/FIXME markers.
- Attempted automated checks with `npm audit` and Vitest.

## Critical findings

### C1. Secrets have already been exposed and must be rotated before launch

`PRODUCTION_READINESS.md` explicitly says all secrets must be rotated because they were exposed in chat, including JWT, order HMAC, MongoDB, Redis, S3, SMTP, metrics, and app secrets. If any old value is live, an attacker with those values can forge or replay trust boundaries depending on the secret type.

**Exploit impact:** forged sessions, payment-order tampering if HMAC material leaked, database compromise, object-storage compromise, SMTP abuse, metrics disclosure, and long-lived post-launch persistence.

**Required fix:** rotate every secret, revoke old credentials, audit access logs for use of old credentials, and document the rotation timestamp and owners in a private incident record.

### C2. Launch compliance appears unresolved for a wagering platform

The production-readiness notes state that licensing, responsible-gaming, secret rotation, and pentest items remain launch blockers. For a betting/wagering platform this is not only a legal concern; missing responsible-gaming and KYC/AML operational controls also expands abuse and fraud risk.

**Exploit impact:** account farming, underage or restricted-jurisdiction use, laundering through deposit/withdrawal loops, and operational shutdown risk.

**Required fix:** complete legal review, jurisdiction gating, KYC/AML operating procedures, responsible-gaming limits/self-exclusion, audit-retention policy, and an external penetration test before public traffic.

### C3. Admin SSE authentication trusts JWT claims without reloading the user — REMEDIATED

The admin SSE route verifies the token and checks `decoded.isAdmin`, `decoded.isSubAdmin`, or `decoded.isQueueManager`, then registers the connection. Unlike normal `authenticate`, it does not reload the user from MongoDB, check whether the user is blocked/locked, confirm the role is still current, or check token blacklist/revocation.

**Exploit impact:** a removed, blocked, or logged-out admin/sub-admin/queue-manager can continue opening sensitive live queue/KYC/admin streams until token expiry if they retain a token.

**Implemented fix:** the admin SSE path now checks token revocation, reloads the current user record, rejects blocked/locked users, and revalidates admin/sub-admin/queue-manager roles before registering the stream.

### C4. Merchant SSE has the same token revocation gap — REMEDIATED

The merchant SSE route verifies the token and confirms the merchant is active, but it does not check token blacklist or other revocation state. A stolen merchant token can keep receiving assigned-order/payment data until token expiry.

**Exploit impact:** leakage of payment queue, user/payment metadata, merchant order snapshots, and real-time order status.

**Implemented fix:** merchant SSE now rejects blacklisted/revoked tokens before loading merchant streams. Short-lived SSE-specific tokens remain a recommended future hardening item.

## High findings

### H1. Account recovery temporary passwords use `Math.random` — REMEDIATED

The admin approval flow generates a temporary password with `Math.random`. This is not cryptographically secure. Temporary recovery passwords are direct account-takeover credentials, so they must be generated with `crypto.randomInt` or `crypto.randomBytes`.

**Exploit impact:** predictable recovery passwords under weak entropy assumptions, especially if an attacker can observe timing and enough generated values.

**Implemented fix:** temporary recovery passwords are now generated with Node `crypto.randomInt` at a longer length. Expiration and reset-link replacement remain recommended hardening items.

### H2. Plaintext temporary passwords are returned to admins for out-of-band sharing

The recovery approval endpoint returns the temporary password in plaintext to the admin. Although it is shown once, this creates exposure in browser memory, screenshots, proxies, logs, support tooling, and admin compromise scenarios.

**Exploit impact:** admin workstation compromise or shoulder-surfing can become user account takeover.

**Required fix:** replace with a short-lived one-time reset link delivered through a verified channel, or require user-side reset after admin approval without showing a password to staff.

### H3. JWT bearer tokens are stored in browser localStorage in admin and merchant panels

Admin and merchant tokens are read from and written to localStorage. Any XSS in either panel, browser extension compromise, third-party script compromise, or malicious admin-entered content rendered unsafely can steal tokens.

**Exploit impact:** full admin/sub-admin/merchant session hijack until expiry or blacklist.

**Required fix:** migrate privileged panels to secure, HttpOnly, SameSite cookies with CSRF protection or a BFF session model; reduce token lifetime and add device/session management.

### H4. CSP still allows inline styles and broad HTTPS image/connect sources

The central CSP allows `'unsafe-inline'` styles, any HTTPS image source, and broad HTTPS/WebSocket connect targets. This may be operationally convenient, but it weakens containment if content injection occurs and makes data exfiltration harder to detect.

**Exploit impact:** easier UI redress/data exfiltration after XSS or content injection; unapproved external endpoints can receive browser-originated traffic.

**Required fix:** move to nonces/hashes for inline styles where possible, restrict `img-src` and `connect-src` to known CDN/API/SSE domains, and enforce report-only before blocking.

### H5. Sub-admin authorization is too coarse on many sensitive read/write paths — PARTIALLY REMEDIATED

Many routes use `isAdminOrSubAdmin` directly. The frontend has granular permissions, but backend enforcement appears inconsistent across KYC, disputes, payment queues, analytics, reports, and merchant scoring routes. Client-side permission checks do not protect APIs.

**Exploit impact:** a low-privilege sub-admin may access or mutate sensitive financial/KYC/payment workflows if they can call APIs directly.

**Implemented fix:** KYC routes now require `canVerifyKYC`, payment-queue reads require `canViewTransactions`, and payment/dispute mutation paths require `canResolveDisputes`. Remaining admin routes should continue being migrated to explicit server-side permissions with denied-role tests.

### H6. Metrics endpoint is safe only when `METRICS_TOKEN` is correctly configured

The production environment validator requires `METRICS_TOKEN`, and `/metrics` refuses production traffic when the token is missing. This is good, but metrics often include sensitive operational shape and should also be network-restricted.

**Exploit impact:** if token leaks or is weak, attackers gain operational insight useful for abuse timing and capacity attacks.

**Required fix:** keep the token requirement, use a high-entropy secret, rotate it, and restrict the endpoint at ingress/VPC/firewall to Prometheus only.

## Medium findings

### M1. Rate limits are present but global API limits may be too generous for unauthenticated abuse

The global `/api` tier allows 1000 requests per 15 minutes per key. Sensitive endpoints have stricter controls, but public endpoints, SSE connection churn, content endpoints, and support/RAG paths should be profiled separately before launch.

**Required fix:** create endpoint-specific abuse budgets for public, auth, payment, support, SSE, and admin APIs; run a load/abuse test with Redis enabled.

### M2. Upload and CDN flows need end-to-end MIME/content validation

Upload routes generate presigned URLs and accept confirm-upload URLs. Some admin app-asset paths constrain raster images, but every user/merchant/admin upload path should validate claimed MIME type, extension, object key prefix ownership, content length, malware scanning, and post-upload HEAD metadata.

**Required fix:** enforce allow-lists at presign time and confirm time, isolate buckets/prefixes by actor, reject SVG/HTML everywhere user content can render, and add asynchronous malware scanning for KYC/payment proofs.

### M3. Local disk storage fallback is dangerous in production-like multi-instance deployments — REMEDIATED FOR PRODUCTION

The app registers S3 when available and local disk otherwise. Production validation requires S3 bucket name, which helps, but any staging or mis-set production mode using local disk can lose uploads across replicas or restarts.

**Implemented fix:** production startup now fails when the S3-compatible storage provider is not fully available, preventing silent local-disk fallback in live deployments. Apply the same policy to staging if staging uses production-like scale.

### M4. Token blacklist checks run per request and can become a database pressure point

Normal auth checks query `TokenBlacklist` for every authenticated request. This provides revocation but can become a hot path and an availability target.

**Required fix:** move blacklist/session revocation lookups to Redis with TTL, cache negative lookups briefly, and keep Mongo as durable audit if needed.

### M5. Public SSE endpoint discloses cycle/config/branding data without auth — REMEDIATED FOR SYSTEM CONFIG

The public SSE route intentionally exposes cycle snapshots, system config, branding, and recent cycle history. Ensure `global.cachedSystemConfig` never contains operational secrets, internal flags, payment settings, or admin-only thresholds.

**Implemented fix:** public SSE `system_config` events now serialize only an explicit allow-list of public fields. Continue reviewing branding/cycle payloads whenever new fields are added.

## Architecture and launch-readiness recommendations

1. **Create a security gate checklist**: no launch until critical/high findings are closed, external pentest is complete, and secrets are rotated.
2. **Harden privileged sessions**: move admin/merchant auth away from localStorage bearer tokens; introduce short-lived access sessions, refresh rotation, device/session revocation, and MFA for admins.
3. **Server-side permission matrix**: make every admin route declare required permission(s), fail closed by default, and test the matrix.
4. **Money-path invariants**: add property/integration tests for all wallet transitions, deposits, withdrawals, bet placement, settlement, merchant assignment, disputes, and balance adjustments.
5. **Operational controls**: enable centralized structured logs, alerting, WAF/CDN rules, ingress ACLs for metrics/admin, backup restore drills, and incident runbooks.
6. **Privacy controls**: classify PII/KYC fields, encrypt highly sensitive fields at rest where possible, reduce admin visibility, and add audit logs for every read of KYC/payment proof material.
7. **Abuse testing**: run load tests and adversarial tests for login brute force, token replay, SSE connection churn, order assignment races, duplicate UTR/payment proof fraud, upload floods, and settlement concurrency.

## Positive controls observed

- Production env validation requires key secrets and infrastructure settings before boot.
- JWT signing/verifying is centralized, pins HS256, supports issuer/audience enforcement, and supports rotation keys.
- Normal authentication reloads users from Mongo and checks blocked/locked states.
- Helmet/CSP, CORS allow-listing, body-size limits, Mongo sanitization, request logging, metrics, rate limiting, and load shedding are mounted globally.
- Admin routes are grouped under an authenticated router by default.
- Tests exist for auth, JWT rotation, rate-limit store, Mongo sanitization, money/ledger/settlement, game engine, merchant wallet, and other critical domains.

## Automated check results during this review

- `npm audit --audit-level=moderate --omit=dev` could not complete because the npm registry audit endpoint returned HTTP 403 in this environment.
- `npm test -- --runInBand` failed because Vitest does not support Jest's `--runInBand` option.
- `npm test` passed after the remediation pass: 24 test files and 198 tests passed.
