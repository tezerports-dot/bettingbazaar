# Identity, access and referrals

**Status: built, tested, and the only path.** Rewritten 2026-09-23 when signup
and login moved from the Telegram bot to a FORM (CLAUDE.md §33, the rule file —
where this document and that one disagree, that one wins and this one is wrong).

This is the authoritative description of how somebody becomes a player, stays
one, gets their account back, and earns from inviting others.

---

## 1. The shape, in one paragraph

A player fills in a form: Aadhaar number, the Aadhaar-linked mobile, a password,
a confirmation, a captcha, and an invite code if a referral link brought them.
That creates the account and signs them in. They are then BLOCKED, by a popup
over every screen, until they have done two things in Telegram: opened the
sign-in bot **they were assigned** and tapped "Share my contact", and joined the
official channel. Verification of the Aadhaar itself happens later, in bulk,
against the issuing authority. Everything else — the money gates, the referral
credit — hangs off that.

**No document is uploaded, ever.** KYC is a twelve-digit number held as an HMAC
plus AES-256-GCM ciphertext.

---

## 2. What Telegram is for, and what it is NOT for

**For:** proving a phone number belongs to the person holding it. Telegram has
already verified the number on the account, and its share-contact button hands
it over on the player's own tap. Matching it against the number they typed on
the form is what turns a typed number into a proven one — which is why this
platform sends no SMS and buys no OTP gateway.

**Also for:** the official channel, which is a standing membership requirement
rather than a one-off.

**NOT for:** authentication. The bot cannot mint a session. It could until
2026-09-23, through a one-time link and a six-digit code, and both are deleted
along with the tables that held them — because the sign-in role is now a fleet
of hundreds of bot tokens, and a credential any one of them can issue is a
credential hundreds of tokens can issue.

---

## 3. Signup, step by step

```
  the form                                the platform
  ─────────                               ────────────
  Aadhaar (12 digits)          ──────▶    every field checked BY NAME
  Aadhaar-linked mobile                   password hashed (argon2id)
  password + confirm                      Aadhaar hashed + encrypted
  captcha (invisible)                     account written in ONE transaction
  invite code (pre-filled,                session issued
     non-editable, if a link
     brought them)

  the bot they were assigned              linkTelegramToAccount
  ──────────────────────────              matched on users.mobile
  tap "Share my contact"       ──────▶    contact PROVEN

  the channel                             chat_join_request → auto-approved
  ───────────                             chat_member       → membership cached
  tap the invite link          ──────▶    joining number claimed
                                          referrer's ₹25 booked
```

Three things about that diagram are load-bearing:

1. **The account exists before Telegram is involved.** So the contact share is
   matched against a row that is already there, rather than creating one — and a
   contact that matches nothing is somebody who has not filled the form yet,
   which is a sentence the bot can say (`not_registered`).
2. **The joining number is claimed at the CHANNEL JOIN, not at signup.** It
   orders the referral payout queue, so a form submitted in a loop must not
   consume positions ahead of people who verified — and must not pay anybody ₹25
   for each one.
3. **The invite code is resolved BEFORE the account is written.** A code that
   matches nobody is REFUSED by name. The path this replaced looked it up later
   and silently wrote null on a miss: the signup succeeded, the referrer never
   earned, and afterwards nobody could tell whether the code had been wrong or
   the payout had failed.

### 3.1 Which bot, and why there are many

One bot is a throughput ceiling: the Bot API allows roughly **thirty messages a
second per bot**, and every signup sends several. An operator runs as many
sign-in bots as they need — added, replaced and removed from the admin panel's
Bot Fleet screen — and each account is assigned one **in rotation**: 1, 2, 3, …
N, then 1 again.

- The assignment is STORED (`users.telegram_bot_id`) because the player is TOLD
  which bot to open. Recomputing it would send them to a different conversation
  on their next page load, while the one holding their contact share sat in the
  first bot.
- It is also RE-RESOLVED on every read, so a player whose bot was retired is
  moved to a live one with nothing to migrate and no sweep to run.
- Each bot has its own webhook path (`/api/telegram/webhook/:botId`) and its own
  secret, and **every reply is sent by the bot the update arrived on** — a bot
  may only message somebody who has opened a chat with IT.
- The **last** live sign-in bot cannot be retired. The refusal is in the
  statement, by counting what would be left.

---

## 4. Sessions and the login form

`POST /api/v1/auth/login` takes the mobile and the password, and answers with a
session — or, for an account with an authenticator enrolled, with a short-lived
**challenge instead of a session**, redeemed at `/login/2fa`.

- **One `loginHandler`, two doors.** The same function serves
  `/api/admin/login` (staff) and `/api/v1/auth/login` (players). They differ in
  exactly one thing, the guest list, and the MOUNT states it (`LOGIN_DOOR`).
  Writing the second as a second handler would have copied the credential read,
  the blocked refusal, the argon2 upgrade and the 2FA decision — and the copies
  drift, silently, and the one that stops challenging is the one nobody watches.
- **The door is checked AFTER the password**, so the 403 is only reachable by
  somebody who already knows it and the endpoint cannot be used to sort phone
  numbers into staff and non-staff. And on **both legs**, so a challenge minted
  at one door cannot be redeemed at the other.
- **One session issuer.** `issueSession` is the only place a session comes into
  existence, and the only place `auth_token` is set.
- **A wrong password and an unknown number are answered identically.** A login
  form that says "no such account" is a way to test whether a given person
  gambles here.

### 4.1 Which limiter guards what

| Route | Chain | Why |
|---|---|---|
| `/register` | signup limiter (counts SUCCESSES) + subnet limiter (successes) + captcha | A registration submits no secret. What is bounded is how many ACCOUNTS an address ends up with; a typo must never cost the next attempt |
| `/login` | pace → failure budget → subnet → surge → captcha | It checks a password. Pace first, so a throttled retry is not counted as a failed attempt |
| `/login/2fa` | pace → 2FA budget | Six digits is a 10⁶ space; no captcha, because the token was spent on the first leg and Turnstile tokens are single-use |
| `/verification`, `/me`, `/logout` | none | They check no credential. A limiter here 429s page loads — measured, twice (CLAUDE.md §33.4) |

---

## 5. The verification gate

A blocking popup over every screen, shown until both halves hold. It **asks**,
on mount and every 30 seconds, rather than waiting for the server to refuse
something — because a form-created account has verified nothing, and a reactive
gate would let somebody wander the app until a tap failed.

`GET /api/v1/auth/verification` is the one question. It answers the contact
share and the channel membership together and returns a single `reason`:

| `reason` | What the player is shown | Whose problem it is |
|---|---|---|
| `no_bot` | "Verification is not available yet" | the platform's — no button |
| `no_channel` | "Almost ready" | the platform's — no button |
| `share_contact` | "Open @their-own-bot", with a share-contact instruction | theirs |
| `contact_changed` | "Contact support" | the platform's — no loop to retry |
| `join_channel` | "Open the channel" | theirs |

The server-side refusals (`requireChannelMembership` on betting, deposits and
the wallet) are unchanged and still authoritative. The gate is what a player
sees instead of discovering them one tap at a time.

**"I've done it — check again"** reads the cache FIRST and only then asks
Telegram, once, after a 1.5-second grace. Joining a channel emits a
`chat_member` update that writes the cache for free within about a second, and
on a channel replacement this prompt appears for every logged-in player at the
same instant — so a live check per tap would aim the whole active user base at
the Bot API in the few seconds when everybody is trying to get back in.

### 5.1 Leaving, and the channel being replaced

- **A leave** arrives as a `chat_member` update, the cache flips, and the next
  request is gated. No sweep, no timer.
- **A replacement** bumps the config generation. Every cached membership is
  stamped with the generation it was observed in, so all of them become stale in
  the same instant and everybody is asked to join the new channel. Nothing is
  migrated and nothing is invalidated by hand — the staleness is structural.
  Measured.

### 5.2 What is NOT detected, stated plainly

Telegram pushes no event when somebody changes the phone number on their
account, and no field on an ordinary message carries the number. So a silent
change is invisible **until the next contact share**, and that is the honest
limit. What happens when evidence does arrive: the link is stood down, the
player is re-gated and told, and an admin is alerted (`noteContactChange`).

---

## 6. KYC

The Aadhaar submitted on the form is queued at `PENDING_APPROVAL` and verified
later, in bulk, by an admin. Deposits are allowed at `PENDING_APPROVAL`;
withdrawals are not.

A **rejected** player submits a corrected number on the panel
(`POST /api/v1/auth/kyc/resubmit`), on the same screen that told them they were
rejected — not in a chat, which is where it used to have to happen because the
account was born in one. The cap is `MAX_KYC_SUBMISSIONS` (3, the signup being
the first), and it is CLAIMED before any work in one statement that both checks
the cap and consumes an attempt: "submit a number, be told whether it is already
registered" is an enumeration oracle the moment it can be repeated freely.

A FAILED submission's row is DELETED, because `aadhaar_hash` is unique and a
typo would otherwise park a stranger's Aadhaar in that index and lock its owner
out forever.

**No identity document is collected, stored or accepted.** Do not add an upload
path for one.

---

## 7. Replacing a bot or the channel

**A sign-in bot** is added, promoted and retired freely from the Bot Fleet
screen. Promoting one ADDS it to the rotation and displaces nothing; retiring
one moves its players onto the rest at their next verification read. The screen
shows how many accounts each live bot carries, which is the figure an operator
is actually deciding about.

**The recovery bot is singular** — exactly one may be live, enforced by the
generated `live_slot` column and a partial unique index. It is the one path that
hands an account to a DIFFERENT Telegram account, so it stays one door somebody
can watch. Promoting a replacement stands the incumbent down in the same
transaction, so there is never a moment with two or none.

**The channel** is replaced by activating a new generation. Every player
re-joins (§5.1). Balances, KYC state and referral positions are untouched.

None of this needs a deploy: tokens, secrets and channel ids live in the
database, not in environment variables.

---

## 8. Account recovery

For somebody who has lost the Telegram account they verified with. They still
have their password, so they can sign in — what they cannot do is verify, because
one platform account may hold only one active Telegram identity and the old,
unreachable one is holding it.

So recovery **moves the link**, on its own bot with its own token, against the
same two proofs it always required: the Aadhaar on the account, and a contact
share of the same mobile. It issues no session — it cannot, and that is the
point of the change.

---


## 9. Referrals

`domains/referral/referral.service.js`, `domains/referral/referral.model.js`.

| Parameter | Value |
|---|---|
| Reward | **₹25** (`REFERRAL_REWARD_PAISE = 2500`) |
| Depth | 2 tiers — the direct referrer and *their* referrer |
| Budget | **₹400 crore** (`PROGRAMME_BUDGET_PAISE`) |
| Member cap | **8 crore** verified members (`PROGRAMME_MEMBER_CAP`) |

### The shared link never names a bot

A referrer shares **`https://<our-domain>/r/<code>`**, not a `t.me` URL.
`routes/referralRedirect.routes.js` resolves the live sign-up bot at the moment
of the tap and 302s to `t.me/<bot>?start=<code>`.

This is not indirection for its own sake. A link **leaves**: it is pasted into
WhatsApp, forwarded, screenshotted, and lives for months in places nobody can
reach. If it named a bot, then the day Telegram suspends that bot — the event
the entire fleet exists to survive — every link ever shared would be dead. The
invited player would see "this bot does not exist", and the referrer would lose
a signup they had earned, **silently**, because nobody reports that a link they
sent last month is broken.

Three consequences worth knowing:

- **302, never 301.** A permanent redirect would be cached by browsers and
  intermediaries against the bot that was live at the time, recreating the exact
  bug inside caches nobody can clear.
- **The code is validated before it is interpolated.** The destination is always
  `t.me` and always our own configured bot; a code that does not match the
  referral shape is dropped rather than passed through, and the visitor still
  reaches the bot — a mistyped link should not be a dead end.
- **With no bot configured it serves a page, not a redirect.** That is the state
  a fresh deployment sits in before the runbook's Phase 3.5, and the state a
  suspension leaves until a spare is promoted. The page says the link will keep
  working, so a referrer does not go asking for a new one.

The redirect is also the only place a **click** can be observed. A referrer who
has invited twenty people and signed up two cannot otherwise tell which half is
broken — nobody opening the link, or everybody opening it and stopping at the
bot. Clicks are deduplicated per viewer per code per 24 hours by a unique index
on `ReferralClick` (a link preview, the human's tap and a back-button retry are
one click, not three), and the viewer is a keyed hash of the address, never the
address, in rows that TTL out after a day.

### Attribution, and the START button

A code rides in the deep link (`t.me/<bot>?start=<code>`) and is captured by the
panel at boot into `localStorage` (`user-panel/src/services/referralCapture.ts`) — a visitor
rarely signs up in the first second, and by the time they open the bot the URL
has changed. First code wins, and it ages out after 90 days: without a lifetime,
a code picked up in March still credits a referrer in November.

**The invited player never types anything.** Telegram delivers the deep-link
payload as the argument to `/start`, and it survives the START button — a player
who has never opened the bot taps START once, and the bot receives
`/start <code>` at that moment with the referrer already attached. That single
tap is Telegram's own consent step (a bot may not message someone who has not
opened the conversation) and cannot be removed by anything on our side. It is
not a risk to attribution: the code rides in the payload, not in anything the
player is asked to enter.

**Attribution** (`recordEarningsFor`) walks at most two upline edges, filters
self-referral, and tolerates 11000 — the unique `(sourceUserId, level)` index
means the same signup cannot be credited twice however many times the write is
retried.

**The queue position is the SOURCE user's joining number**, not the earner's.
That is what makes "paid in joining order" mean "paid in the order the invited
players arrived", which is the promise the programme actually makes.

**Eligibility is checked at payout time, not at accrual.** A referrer whose KYC
is not yet verified still *accrues*; they simply cannot be *paid* until it is.
Checking at accrual would silently void earnings for anyone whose verification
landed a day late.

### Disbursal

`POST /api/admin/referral/disburse` takes **an amount and nothing else.** There
is deliberately no "pay this person" control:

- the queue pays strictly in joining order, which is what makes the programme
  defensible to everyone still waiting in it, and stops a disbursal from being a
  discretionary favour;
- **₹25 is never split.** A pool that runs out mid-queue stops at the last earner
  it can pay in full and reports the remainder unspent. Half a reward is not a
  reward; it is a support ticket and a broken promise;
- **blocked rows do not consume the pool.** Funding ₹1,00,000 pays ₹1,00,000 of
  *eligible* earnings regardless of how much sits blocked behind it. Blocked
  earners keep their place and become payable when eligibility returns;
- payment uses a deterministic `ref_<id>` transaction id, so a retried disbursal
  cannot pay the same earning twice.

Accounting-wise the programme is a **marketing expense against revenue**, not a
liability against the float.

---

## 10. Environment

| Variable | Required | Notes |
|---|---|---|
| `IDENTITY_ENCRYPTION_KEY` | **yes** | 32 bytes, base64. Aadhaar + bot-token ciphertext. A wrong or absent key makes every stored identity unreadable. `openssl rand -base64 32` |
| `IDENTITY_ENCRYPTION_PREVIOUS_KEYS` | no | Comma-separated, **decrypt-only**. Retire a key without a migration window |
| `AADHAAR_HMAC_SECRET` | yes | Uniqueness hash |
| `AADHAAR_HMAC_PREVIOUS_SECRETS` | no | Comma-separated rotation candidates |
| `TELEGRAM_MEMBERSHIP_TTL_MS` | no | How long a cached channel status is trusted (default 15 min) |
| `TELEGRAM_MEMBERSHIP_GRACE_MS` | no | Outage window from last confirmed membership (default 24h) |
| `TURNSTILE_SECRET_KEY` | no | Cloudflare Turnstile. **Unset = pass-through**, which is how every integration here ships |
| `PUBLIC_APP_ORIGIN` | yes | The webhook base each bot is registered against |

`TELEGRAM_LOGIN_TTL_MS` was removed with the login link (2026-09-23).

Bot tokens, webhook secrets and channel ids are **not** environment variables.
They live in `TelegramConfig` so they can be replaced from the admin panel
without a deploy — which is the entire point of §7.

---

## 11. What was removed, and why a reference to it is stale

If you find one of these named anywhere outside this section and the commit
history, the reference is out of date.

### Removed 2026-09-23 — the bot can no longer sign anybody in

| Removed | Replaced by |
|---|---|
| `domains/telegram/telegramLogin.service.js` | Nothing. `POST /api/v1/auth/login` |
| `domains/telegram/telegramOtp.service.js` | Nothing. Same |
| `domains/telegram/telegramOnboarding.service.js` | `identity/signupVerification.service.js` (completion) + `identity/aadhaarResubmission.service.js` (corrections) + `identity/signupFields.js` (the field rules) |
| `POST /api/telegram/exchange`, `/otp/request`, `/otp/verify` | `POST /api/v1/auth/login` |
| `GET /api/telegram/membership` | `GET /api/v1/auth/verification` — one answer to one question |
| `POST /api/telegram/webhook` (one path) | `POST /api/telegram/webhook/:botId` — one per bot, one secret each |
| tables `telegram_login_tokens`, `telegram_login_codes`, `telegram_pending_links` | Nothing. The form writes the account; there is no half-finished conversation to park |
| `pages/TelegramAuthPage.tsx` (the link landing page) | Nothing to land |
| `components/Modals/ChannelGateModal.tsx` | `VerificationGateModal.tsx` — proactive, and covers both halves |
| the `login_link` bot template | `verified` and `not_registered` |

### Removed 2026-08-25

| Removed | Replaced by |
|---|---|
| ~~`POST /api/v1/auth/register`, `/login`, `/login/2fa` (players)~~ | **Back, as of 2026-09-23.** They were removed when players had no password and restored when the form gave them one — see above |
| `routes/account-recovery.routes.js` + `accountRecovery.model.js` | The recovery bot (§8). The old flow issued a temporary **password**, so it was dead by construction once players stopped having one |
| `POST /api/user/kyc/:docType/upload-url` | Nothing. There is no document |
| `POST /api/user/:userId/kyc` | The bot takes the Aadhaar before the account exists |
| `GET /api/admin/kyc/:userId/document/:docType` | Nothing to view |
| `services/kycDocuments.service.js` + the private bucket | Nothing stores an identity document. The constraints a future implementation would have to satisfy are in §6a |
| `User.aadhaarHash`, `kycData.aadhaarNumber`, `nameOnAadhaar`, `nameOnPAN`, `panNumber`, `idProofKey`, `photoKey`, `idProofUrl`, `photoUrl` | `KycVerification` |
| `admin.service.js` approve/rejectKYC/getKYCQueue | `decideKyc` — they had no callers and raced |

**What stayed, and is not stale:** `loginHandler` / `loginTwoFactorHandler` at
`/api/admin/login` (staff), `password.util.js` (merchants and staff),
`/api/2fa` (mandatory for admins and sub-admins), and the KYC approve/reject
routes (the audited exception path).

The staff password door now **refuses any account without a staff role** —
checked *after* the password, so the 403 is only reachable by someone who already
knows it and the endpoint cannot be used to sort phone numbers into staff and
non-staff.

---

## 12. Tests

| File | Pins |
|---|---|
| `playerFormAuth.test.js` | The form is the door; NOTHING in the Telegram surface can grant access (the two services deleted, the two tables dropped, no `issueSession` import); one session issuer; the door stated as `LOGIN_DOOR` and checked on both legs, after the password |
| `playerAuthRoutes.test.js` | Signup and login through a real database: the row, a verifiable hash, every refusal naming its field, both duplicate refusals, referral attribution with a lower-case code, the identical answer for a wrong password and an unknown number, a challenge instead of a session — plus which limiter is mounted on which kind of path |
| `telegramRecoverySafety.test.js` | Search key is the phone; two factors required; one failure reason; re-link never re-creates |
| `kycBulkSafety.test.js` | Formula escaping; nothing to disk; no guessed verdicts; batch decisions go through the state machine; FAILED is mirrored |
| `kycDocumentPathRemoved.test.js` | No upload, no viewer, no identity data on `User`, one decision path |
| `fieldCryptoRotation.test.js` | Decrypt-only retired keys; rewrap |
| `schemaIndexConflicts.test.js` | No two indexes with the same key pattern and different options |
| `adminRouteContract.test.js` | The panel calls paths the server serves; `/kyc/bulk/*` and `/telegram/*` are not shadowed by wildcard patterns beside them |
| `telegramFleet.test.js` | Every sign-in bot gets its OWN webhook path (and the id is escaped, not pasted); recovery keeps one fixed path; outbound-only roles get no webhook; a template Telegram would refuse is caught on save; a player-chosen name cannot become markup |
| `telegramPg.test.js` (fleet suite) | Any number of live sign-in bots; the rotation CYCLES and starts again at the first; an assignment is KEPT; a retired bot's players MOVE; the last live sign-in bot cannot be retired; null when none is registered; loads cast off BIGINT |
| `VerificationGateModal.test.tsx` | It blocks on its own without waiting to be refused; no way to close it in any of three ways; it sends the player to THEIR OWN bot; cache before Telegram, once, after the grace; the platform's own unfinished state is never blamed on the player |
| `AuthModal.test.tsx` | Every field addressable by its printed label; every character kept; `+91` and a leading `0` stripped off the mobile; the invite code pre-filled and non-editable from a link, with a way out when it is dead; a 2FA challenge is a step, not an error |
| `channelGateOrdering.test.js` | The server-side gate asks whether a channel exists *before* blaming the player for not having joined one |
| `referralLinkStability.test.js` | A shared link follows a bot swap; the redirect is never cacheable and never an open redirect; the panel does not mint a `t.me/<bot>` link |
| `schemaPathWrites.test.js` | No write targets a column the table does not declare. PostgreSQL errors on an unknown column rather than discarding it silently — this test keeps that from being the *first* place anyone finds out, which is what caused six bugs here |
| `signupToLogin.test.js` | The SEAM, against a real PostgreSQL: what the form wrote is what `authenticate`, the mobile lookup and the credential lookup all find — and NO Telegram identity and NO joining number exist until the steps that create them |

Most of these assert **absence**, which no feature test can do: a happy-path
suite for bulk verification passes perfectly well with an upload endpoint still
mounted next to it.
