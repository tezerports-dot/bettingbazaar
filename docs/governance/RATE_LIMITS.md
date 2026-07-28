# Rate limits — every throttle in the platform

<!-- GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. -->

Single source of truth: `backend/config/security.config.js` → `RATE_LIMIT_TIERS`.
Everything below is read from there; nothing hardcodes a number elsewhere.

All counters are shared across instances through Redis (`REDIS_URL`). Without
Redis each replica counts separately, so a 4-per-hour limit becomes 4 **per
replica** per hour — which is why `REDIS_URL` is required above one instance.

---

## The one thing to understand first

**Login limiters count FAILURES, not logins.**

Every login tier sets `skipSuccessfulRequests: true`. "4 per 30 minutes" does
not mean a player may only sign in four times — it means the **fifth wrong
password** is refused. A legitimate user switching devices ten times a day is
never affected; someone guessing passwords is stopped on the fifth attempt.

Counting successes would punish real users and do nothing extra against an
attacker, who by definition is only ever failing.

---

## Login and authentication

| What | Limit | Window | Keyed by | Counts |
|---|---|---|---|---|
| **Player login / register / recover** | 4 | 30 min | IP (IPv6 → /56) | failures |
| **Admin + sub-admin login** | 4 | 1 hour | IP | failures |
| **Merchant login** | 4 | 1 hour | IP | failures |
| **Second factor (OTP)** | 5 | 15 min | account, else IP | failures |

**Why admin and merchant are on the same tier.** A merchant account settles real
INR and USDT. Brute-forcing it is an attack on the settlement rail, not on one
player's balance, so it is not treated as a player-grade credential.

**Why the OTP tier is separate and tighter.** Once the password is correct, the
attacker is guessing six digits — a space of 10⁶. An allowance that is generous
for a password is dangerous for an OTP: 5 attempts is a 1-in-200,000 chance per
lockout window, where the password tier's arithmetic is very different.

**Scoping note.** Login limiters are mounted on the login PATH, never on a whole
router. `skipSuccessfulRequests` only skips 2xx, so a router-wide mount would
let every ordinary 4xx a working user collects — a validation error, a 404 —
count against their login budget and eventually lock them out of signing in.

**IPv6 note.** `ipKeyGenerator` normalises IPv6 to a /56 block, so one user
cannot rotate through the addresses their ISP hands them to reset the counter.

---

## Money and gameplay

| What | Limit | Window | Keyed by |
|---|---|---|---|
| **Bet placement** | 30 | 1 min | user (IP when unauthenticated) |
| **Bet placement, pre-auth IP guard** | 30 | 1 min | IP |
| **Withdrawal creation** | 5 | 1 hour | user |
| **Behavioural bet velocity** | `BET_BEHAVIOR_MAX_PER_MINUTE` | 1 min | user |

The pre-auth bet guard runs **before** authentication deliberately: it is cheap,
and it stops an unauthenticated flood from ever reaching the token verification
and database work behind it.

Phantom (equalizer) bets are exempt from the global backstop — they fire in
bursts by design to keep the display pool balanced. The route is separately
gated (`authenticate` + `phantomAccess` → 403 for everyone else) and load
shedding still bounds total in-flight work, so the exemption removes no real
DoS protection.

---

## General traffic

| What | Limit | Window | Keyed by |
|---|---|---|---|
| **Global `/api/*` backstop** | 1000 | 15 min | IP |
| **General API tier** | 100 | 1 min | IP |

---

## Defence layers that are not counters

These shed load rather than count it, and are configured in `ENV.md` §6:

| Layer | Control | Effect |
|---|---|---|
| **Load shed / bulkhead** | `LOAD_SHED_MAX_INFLIGHT` | 503 once concurrent requests exceed the ceiling |
| **Event-loop guard** | `LOAD_SHED_MAX_LAG_MS` | 503 once the event loop falls behind |
| **Per-IP defence** | `IP_DEFENSE_ENABLED` | per-IP budget, Redis-backed |
| **Per-subnet defence** | `IP_DEFENSE_SUBNET_MULT` | aggregates a /24 so a botnet in one range shares a budget |

---

## Changing a limit

Edit `RATE_LIMIT_TIERS` in `backend/config/security.config.js` and update the
table above in the same commit. Do not add a number at a call site — the tiers
exist so the whole policy is readable in one place.

**Before loosening a login tier**, remember what it protects: admin accounts on
this platform are password-plus-TOTP, and the rate limit is the outer wall in
front of both.
