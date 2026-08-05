# Authentication transport and CSRF — design decision

The CSRF **vector** is closed (the global urlencoded parser is gone, so a
cross-site `<form>` reaches no handler with a usable body). The **design** that
made it possible is still in place. This proposes the structural fix.

---

## 1. Threat model

**What an attacker can do.** Get a logged-in user to visit a page they control —
an ad, a forum post, a link in chat. That page then issues requests to the
platform from the victim's browser.

**Why that is dangerous here.** `auth_token` is issued with `sameSite: 'none'`
(`backend/routes.js`), so the browser attaches it to **cross-site** requests, and
`extractToken` accepts the cookie as proof of identity:

```js
return req.cookies?.auth_token
    || req.headers.authorization?.replace('Bearer ', '')
    || null;
```

CORS does not prevent this. For a *simple request* the browser **sends** the
request and only withholds the **response** — by the time CORS applies, the
deposit, withdrawal or bet has already executed. CORS protects data
confidentiality, not state changes.

**What is out of scope.** XSS. If an attacker runs script on our origin, every
option below fails — a token in `localStorage` is readable and an `httpOnly`
cookie can be ridden by same-origin `fetch`. CSRF defence assumes the origin is
not already compromised.

---

## 2. The fact that decides this

**Every client already authenticates with `Authorization: Bearer`.** The cookie
is redundant everywhere:

| Client | Transport | Cookie needed? |
|---|---|---|
| User panel | `Authorization: Bearer` (`apiClient.ts:72`), token in `localStorage` | No — also sends `credentials: 'include'`, but the header is what authenticates |
| Admin panel | `Authorization: Bearer` via axios interceptor; `withCredentials: false` | **No — cookies explicitly disabled** |
| Merchant panel | `Authorization: Bearer` (`api.ts:59`) | No |
| Android / Capacitor | Same user-panel bundle → same Bearer header | No |
| PWA | Same bundle | No |
| **SSE** | `?token=<PASETO>` query param — `EventSource` cannot set headers | **No** |

Login returns the token in the JSON body *and* sets the cookie
(`routes.js:147-148`). Clients store the body token. The cookie is written, sent
back, and accepted — but nothing needs it.

**So the CSRF exposure exists to serve no client.**

---

## 3. Options

### A. Cookie auth + synchronizer CSRF tokens
Server issues a per-session token, every state-changing request echoes it.
Robust and well understood. Requires a token endpoint, storage, refresh-on-
rotation, and changes to **every mutating call in all three panels**. Solves a
problem we would be choosing to keep.

### B. Double-submit cookie
Same value in a cookie and a header; server compares. No server-side state, but
still touches every client, and it is weakened by subdomain-scoped cookie
injection — relevant if staging and production share a parent domain.

### C. Authorization header only — **recommended**
Stop accepting the cookie. A cross-site attacker **cannot set a custom header**
without triggering a preflight, and the CORS allow-list rejects the preflight.
CSRF becomes structurally impossible rather than defended against.

Cost: nearly zero, because every client already sends the header.

### D. `sameSite: 'lax'`
Would fix the browser case, but `lax` is not sent cross-site, and the Capacitor
shell is a different origin — so this breaks the native app while adding nothing
the header approach does not already give.

---

## 4. Recommendation

**Option C.** Make the `Authorization` header the only accepted transport.

```js
// backend/routes.js — extractToken
function extractToken(req) {
  return req.headers.authorization?.replace('Bearer ', '') || null;
}
```

Then stop setting the cookie at `routes.js:147` and `:322`.

**Why this is the right call for this codebase specifically:**

1. **No client change required.** All five surfaces already send the header. This
   is deleting an unused, dangerous code path — not a migration.
2. **It removes the vulnerability class**, rather than adding a control that
   must itself be maintained and can be misconfigured.
3. **It matches the panels' own posture** — the admin panel already sets
   `withCredentials: false`, i.e. it decided cookies were not its auth mechanism.
4. **SSE is unaffected** — it never used the cookie.

**The tradeoff, stated honestly.** An `httpOnly` cookie is not readable by
JavaScript, so under XSS it is marginally harder to *exfiltrate* than a
`localStorage` token. That is a real difference. But it is not a difference this
system currently benefits from: the same token is already in `localStorage` on
all three panels, so XSS already yields it. Choosing C gives up nothing that is
actually held today, and removes an exposure that is.

If cookie auth is ever genuinely wanted (e.g. to get the token out of
`localStorage`), it must arrive **together with** option A — never on its own.

---

## 5. Migration plan

Low risk, but it is an auth change, so stage it.

**Step 1 — Observe (1 week).** Add a counter incremented when a request
authenticates *only* by cookie:

```js
if (!req.headers.authorization && req.cookies?.auth_token) {
  cookieOnlyAuth.inc({ path: req.path });
}
```

Deploy and watch. The analysis above predicts **zero**. If it is not zero, that
counter names the client to fix first — do not proceed until it is zero.

**Step 2 — Stop accepting the cookie.** Change `extractToken` to header-only.
Keep *setting* the cookie for one release so a rollback does not log everyone
out.

**Step 2b — Prove it, per endpoint.** Changing `extractToken` is necessary but
not sufficient evidence. Middleware accumulates: a route with its own auth
shim, a merchant or SSE path that reads `req.cookies` directly, or a handler
that trusts `req.user` populated somewhere else, can each leave a hole that a
single-function change does not close.

Add a suite that **enumerates the mounted router stack** and, for every
state-changing route (POST/PUT/PATCH/DELETE), issues a request carrying **only**
the cookie — no `Authorization` header — and asserts 401/403. Enumerating the
stack rather than listing paths by hand is the point: a new route added later is
covered automatically, whereas a hand-written list silently stops covering the
thing it was written for.

```js
// Sketch — walk app._router.stack, collect {method, path}, then for each:
const res = await request(app)[method](path).set('Cookie', `auth_token=${validToken}`);
expect([401, 403]).toContain(res.status);
```

Grep as a second check, not the primary one:
`grep -rn "req.cookies" backend --include=*.js` should return nothing outside
`cookieParser` setup.

**Step 3 — Stop setting it.** Remove the `res.cookie` calls and `COOKIE_OPTS`.
Ship a `res.clearCookie('auth_token')` on login and logout for one release so
stale cookies do not linger in browsers.

**Step 4 — Restore the parser if wanted.** With cookies no longer accepted,
`express.urlencoded` is no longer a CSRF vector. It is still unnecessary, so
leave it out; the regression test in
`backend/tests/unit/csrfSimpleRequestSurface.test.js` should stay either way.

**Rollback:** revert step 2. Because step 3 lags a release behind, cookies still
exist in browsers throughout the risky window.

## 6. Backward compatibility

| Surface | Impact |
|---|---|
| Web panels | None — already header-based |
| Existing sessions | None — the token in `localStorage` keeps working; only the *cookie copy* stops being accepted |
| SSE | None — query-param token |
| Android (installed builds) | None — same bundle, same header |
| Provider webhooks | None — HMAC-signed, not session-authenticated |

**The one real risk** is a client that authenticates by cookie alone and was
missed. Step 1 exists precisely to find it before it becomes an outage. Do not
skip it because the table above looks clean — the table is analysis, and step 1
is measurement.

## 7. Android implications

The Capacitor shell loads the user-panel bundle from `https://localhost`, making
every API call cross-origin. That is *why* `sameSite: 'none'` was set. Under
option C the question disappears: a header is not subject to `SameSite` at all,
and the shell already sends one.

Two things still matter for the native build:

- **`ALLOWED_ORIGINS` must include the shell's origin**, or the preflight fails.
  This is already required today.
- **Token storage.** `localStorage` inside the WebView is app-private, so it is
  not the same exposure as a browser. Moving it to Capacitor secure storage is a
  worthwhile hardening, independent of this decision.

## 8. Status

**NOT IMPLEMENTED.** This is a proposal. The vector fix is shipped; the
structural change above needs the owner's decision and the step-1 measurement
before any code moves.
