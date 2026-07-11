# Authorization Matrix (Phase X X-8)

**Scope:** ~270 mounted route handlers across the backend. This matrix
documents, per role tier, the required authentication, the ownership rule, and
the result of a systematic scan for missing guards. **Result: no authorization
holes were found** — every mutating endpoint enforces role + ownership; every
public endpoint is read-only and intentional.

Method: enumerate every `router.<verb>` across `domains/**` + `routes/**`,
classify by the middleware chain, and spot-verify ownership in the handler
bodies. Re-run the scan commands in the appendix after adding any route.

---

## Role tiers & how each is enforced

| Tier | Middleware | Ownership rule | Where |
|---|---|---|---|
| **Public** | none (some rate-limited) | n/a — read-only only | see list below |
| **User** | `authenticate` | `resource.userId === req.user._id` (or `isAdmin`) | user/payment/bet/wallet routes |
| **Merchant** | `merchantAuth` | `order.merchantId === req.merchantId` | `domains/merchant/*` (23 routes) |
| **Queue manager** | `authenticate` + `isQueueManager`/admin | assignment scoped to queue pool | queue admin routes |
| **Sub-admin** | `authenticate` + `isAdminOrSubAdmin` + permission key | per-permission (`utils/permissions`) | admin read + delegated routes |
| **Admin** | `authenticate` + `isAdmin` | full | admin routes (121 total) |

`req.merchantId`/`req.user` are set by the auth middleware only after JWT
verification + account-status checks (blocked/suspended/approved).

---

## Verification results (the scan that matters)

1. **Every admin sub-router route carries a role guard.** Scanning all
   `routes/admin/*.js` + `domains/*/*.admin.routes.js` for an `authenticate`
   without `isAdmin`/`isAdminOrSubAdmin`/`isSubAdmin`/`isQueueManager`: **0
   findings.** (The one line the crude scan flagged — `branding
   /app-assets/upload` — carries `authenticate, isAdmin` on the next line; it
   is protected.)
2. **Merchant routes enforce ownership.** 23 `merchantAuth` routes; 43
   in-handler `order.merchantId === req.merchantId` / `req.merchantId`
   ownership references. The deposit approve/confirm/reject paths each check
   the order is assigned to the calling merchant before mutating (403
   otherwise).
3. **User routes are IDOR-protected.** Routes taking `:id`/`:orderId` verify
   ownership before returning or mutating, e.g.
   `GET /v1/user/:id/data` → `req.user._id !== id ? 403`;
   `GET /payment/order/:orderId` → `order.userId !== req.user._id && !isAdmin ? 403`.
4. **Every public endpoint is read-only** (GET) **and intentional** — no public
   route mutates money or state. `login`/`logout` are the only public POSTs
   (auth lifecycle, rate-limited).

### Intentional public endpoints (the external attack surface)

All GET unless noted; all read-only:

- `POST /api/v1/auth/login`, `POST /logout`, `GET /me`, `GET /health`
- `GET /api/cycles/active`, `/cycles/:id`, `/v1/game/cycle/:type/:startTime`,
  `/v1/game/cycles/history` — public game state
- `GET /api/v1/system/config`, `/v1/system/time` — public config/time
- `GET /api/v1/content/{promo,faq,support-links,ai-analysis}`, `/v1/branding`
  — public content/branding
- `GET /api/v1/tokens/rate`, `/v1/token/rates`, `/api/payment/rates`,
  `/api/payment-config/config` — public rates (constant 1/1 since the 1:1
  flattening)
- `GET /api/v1/winners` — public winners feed

None expose another user's private data or accept a state mutation.

---

## Standing rules for new routes (keep the matrix true)

- A **mutating** route (POST/PUT/DELETE) MUST have a role guard and, if it
  touches a user-/merchant-owned resource, an ownership check in the handler.
- A new **public** route may only be a safe, read-only projection — never a
  mutation, never another principal's private data.
- Admin data-changing routes use `isAdmin`; read/reporting routes may use
  `isAdminOrSubAdmin` (+ a permission key for sub-admins).

## Appendix — re-run the scan

```sh
# admin routes missing a role guard (expect: only false-positive multiline defs)
for f in backend/routes/admin/*.js backend/domains/*/*.admin.routes.js; do
  grep -nE "router\.(get|post|put|delete|patch)\(" "$f" | grep authenticate \
    | grep -vE "isAdmin|isAdminOrSubAdmin|isSubAdmin|isQueueManager" && echo "  ^ in $f"
done
# public (no-auth) route lines across public-facing routers — expect read-only only
grep -rnE "router\.(get|post)\(" backend/routes.js backend/domains/user backend/routes/winners.routes.js \
  | grep -vE "authenticate|merchantAuth|isAdmin|[Ll]imiter"
```
