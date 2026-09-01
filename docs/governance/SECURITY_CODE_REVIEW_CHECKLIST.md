# Betting Bazaar — AI-Assisted Security Code Review Checklist

Use this checklist when performing security reviews of Betting Bazaar. It is written as reviewer instructions, not as a generic topic list.

## Ground rules for reviewers

1. Every finding must cite a real file and line number; theoretical categories are not findings.
2. For every finding, state reachability: anonymous user, logged-in user, merchant, subadmin, admin-only, or queue-manager.
3. Verify middleware is actually imported, mounted, ordered correctly, and applied to the route under review.
4. Prefer end-to-end data-flow tracing over shallow keyword searches.
5. Treat check-then-act patterns as race conditions unless the check and write are one atomic database operation.
6. Use this finding format: **Title / Severity (Critical–Info) / File:line / Evidence / Reachability / Impact / Suggested fix.**

## Repository orientation

- Monorepo with `backend/` for Express 5, PostgreSQL (the only datastore — money, identity, config, content), Redis/ioredis/BullMQ, Kafka, Socket.io, and SSE; plus root, `admin-panel/`, and `merchant-panel/` React/Vite frontends.
- Backend code is domain-oriented under `backend/domains/<domain>/`, with shared middleware, services, and providers.
- Actor classes include user, merchant, subadmin, admin, and queue-manager. Review seams between roles carefully.
- User-content uploads use presigned S3-style direct-to-storage flows; review upload confirmation and persisted URL/key trust boundaries.
- Real-time state is delivered through both Socket.io and SSE. Treat them as independent authorization systems.
- Deployment can be self-hosted behind Caddy or direct on Railway; proxy-dependent controls must be checked against both paths.

## Review order

1. Money movement and game logic.
2. Authorization and real-time channels.
3. Injection and file handling.
4. Infrastructure, DoS, dependencies, and supply chain.
5. Observability, privilege separation, DR, testing, and CI.

## 1. Authentication and session management

- Confirm JWT verification pins allowed algorithms and rejects forged algorithm headers.
- Confirm missing JWT secrets fail startup instead of falling back to defaults.
- Confirm token expiry, refresh-token rotation, and server-side revocation/blacklist behavior.
- Confirm password hashing uses a modern KDF with sane cost parameters; legacy hashes must be verify-only with forced upgrade.
- Confirm consistent auth rate limiting across user, merchant, admin, and subadmin login surfaces.
- Confirm OTP/2FA secrets, replay protection, and backup-code handling.
- Confirm logout invalidates server-side state where applicable.

## 2. Authorization and access control

- For every route with `:id`, `:orderId`, `:userId`, or `:merchantId`, verify query-time ownership filters, not only role middleware.
- Review every Socket.io `join_*` handler and each SSE subscription endpoint. Rooms/channels must derive from verified-token claims, not client-supplied identifiers.
- Cross-reference the authorization matrix against actual middleware on admin routes, especially money-moving, config-changing, and secret-touching routes.
- Verify merchant cross-tenant isolation for orders, wallets, chats, and real-time channels.
- Confirm impersonation/admin-acts-as-user features are scoped and audit-logged.

## 3. Financial and wallet integrity

- Confirm all balance changes go through the designated wallet authority and ledger path.
- Search for escaped template interpolation such as ``\${`` in idempotency keys passed to credit/debit functions.
- For gift codes, coupons, bonuses, promo caps, and first-N-users resources, verify remaining-use checks and consumption happen in one atomic conditional update.
- Verify withdrawals atomically lock funds and enforce cutoffs server-side against wall-clock time.
- Verify deposit confirmation cannot be self-confirmed by users and payment references are unique.
- Confirm dispute resolution cannot double-credit or bypass independent evidence requirements.
- Confirm every balance-affecting action creates exactly one immutable ledger entry with before/after balances.

## 4. Core game and product logic

- Flag `Math.random()` in outcome-determining code; use CSPRNG APIs for gambling outcomes and tie-breakers.
- Trace a full round lifecycle from open to close, result declaration, and settlement; verify bet closure uses actual server time on every request.
- Verify result declaration and settlement are idempotent under retries, duplicate cron ticks, and crash recovery.
- Check payout and rounding math against the written spec where available.

## 5. Promotions, referrals, and merchant workflows

- Verify self-referral and circular-referral protections.
- Note whether multi-accounting signals exist, such as IP, device, or KYC correlation.
- Confirm bonus cooldowns are server-side and stored, and amounts cannot be negative or zero where invalid.
- Confirm manual merchant assignment paths are distinctly audit-logged and cannot routinely bypass fair assignment.

## 6. Input validation and injection

- Confirm prototype-pollution sanitization covers body, params, and query, runs after parsing and before routes, and blocks `__proto__`, `constructor`, and `prototype` keys.
- Confirm every query is parameterized, with no string-concatenated or template-built SQL. **A table or column name cannot be a parameter** — if one is dynamic, it must come from an allowlist, never from the request.
- Flag mass assignment where raw `req.body` reaches an insert or update without an explicit column allowlist.
- Confirm `BIGINT` money columns are cast at the read boundary. node-postgres returns them as **strings**, and an uncast comparison (`'900' >= 1000` is `true`) is a silently wrong authorization decision, not just a display bug.
- Check recursive merges of user-controlled objects into long-lived objects for prototype pollution.
- Confirm no server-side template injection, shell command injection, or ReDoS-prone user-input regexes.

## 7. File handling

- Confirm upload MIME allowlists are cross-checked with extensions and size limits are enforced at storage as well as the client.
- For confirm-upload routes, verify object existence and server-owned bucket/CDN prefixes instead of trusting client-supplied URLs or keys.
- Confirm filesystem path joins use safe containment checks: exact base path or `baseDir + path.sep` prefix.
- If archives are accepted, verify zip-slip protection and caps on extracted size and file count.
- Document the direct-to-storage malware-scanning tradeoff and whether async scanning exists for content served back to users.

## 8. Real-time channels

- Confirm unauthenticated connections receive no financial or PII-bearing data.
- Check for concurrent connection caps per IP/user.
- Check inbound socket event rate and size limits.

## 9. Network and infrastructure

- Check SSRF risk for outbound `fetch`, `axios`, and `http.request` targets derived from input or admin-configured records.
- Verify `trust proxy` matches both Caddy and direct Railway deployment paths.
- Verify CORS origin allowlists and credentials behavior.
- Confirm security headers are present consistently in both deployment paths.

## 10. Denial of service

- Confirm mutating endpoints with DB writes, external calls, or crypto work have rate limits.
- Flag unbounded `Model.find()` calls on route result sets that grow with production usage.
- Review expensive request-thread aggregations for pagination, caching, or background processing.
- Flag security controls that default off as explicit launch decisions.
- Confirm JSON body size limits are present on all parser mounts.

## 11. Database

- Verify indexes for hot-path filters and sorts against schemas.
- Confirm every money-affecting write puts the balance move and its ledger rows in **one transaction**. A balance the ledger cannot explain is a P1.
- Confirm the balance a decision is made from is read **inside** the lock that the write takes, not before it. A pre-read plus a guard is not equivalent — a replay can compute a different split, miss the unique-`tx_id` collision, and debit twice.
- Review long-held hot-path transactions for lock contention, and treat **any 40P01 deadlock as a bug**: it means something updates a row it also holds `FOR SHARE`.
- Confirm no code path reads a balance from one place and executes against another. There is one store; a second copy of a balance is a second writer waiting to disagree.

## 12. Secrets and cryptography

- Search for hardcoded keys, secrets, passwords, and high-entropy literals assigned to sensitive names.
- Confirm secrets come from environment/config providers with fail-fast validation.
- Verify key rotation behavior if supported.
- Confirm security-sensitive tokens use `crypto.randomBytes`, `crypto.randomUUID`, or equivalent CSPRNG APIs.

## 13. Dependency and supply chain

- Run `npm audit` in every package context with an independent lockfile: root, backend, admin panel, and merchant panel.
- Separate build-tooling advisories from runtime-reachable server advisories.
- Confirm lockfiles are committed and CI uses frozen/reproducible installs.
- Spot-check recently added dependencies for typosquatting.

## 14. Observability and audit trail

- Confirm logs do not include secrets, full tokens, passwords, or complete payment credentials.
- Confirm privileged actions create distinct, attributable audit entries for admins and subadmins.
- Confirm repeated auth failures, rate-limit trips, and WAF/filter blocks surface somewhere humans review.

## 15. Insider threat and privilege separation

- Check whether any single privileged role can unilaterally move money above meaningful thresholds without second approval.
- Verify actions against other admin/subadmin accounts are gated and logged.
- Confirm least-privilege claims in the authorization matrix match code in both directions.

## 16. Backup, restore, and disaster recovery

- Verify backups are checked by checksum or test restore, not only job exit status.
- Confirm a full restore has been executed and documented.
- Cross-check DR documentation against actual infrastructure capabilities.

## 17. Testing and CI

- Assess whether tests cover wallet, bet placement, settlement, and authorization-boundary paths.
- Confirm CI gates run tests, dependency audits, and linting on every change.
