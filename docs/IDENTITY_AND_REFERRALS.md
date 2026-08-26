# Identity, access and referrals

**Status: built, tested, and the only path.** The password login, the KYC
document upload, and the admin recovery queue that used to sit beside these were
removed on 2026-08-25 — not deprecated, removed. If you find a reference to one,
it is stale; see "What was removed" at the end.

This is the authoritative description of how somebody becomes a player, stays
one, gets their account back, and earns from inviting others.

---

## 1. The shape, in one paragraph

A player never types a password and never uploads a document. They open a
Telegram bot, send their Aadhaar **number**, tap "share my contact" to prove the
phone, and join the official channel. The bot then sends a one-time link that
opens the app already signed in. Verification of the Aadhaar happens later, in
bulk, against the issuing authority. Everything else — the session, the money
gates, the referral credit — hangs off that one flow.

```
Telegram bot                     Backend                        Player's browser
────────────                     ───────                        ────────────────
/start  ─────────────────────▶  TelegramPendingLink
                                (carries ?start=<referral code>)
"123412341234"  ─────────────▶  KycVerification (encrypted + HMAC)
share contact   ─────────────▶  User created, phone proved
joins channel   ─────────────▶  joining number assigned, referrals recorded
                ◀────────────   one-time link
                                                    ─────────▶  POST /api/telegram/exchange
                                                    ◀─────────  session cookie
```

---

## 2. Why Telegram, and what it actually buys

Three things, none of which is convenience:

**The phone number is proved, not claimed.** Telegram's contact share is a
first-party assertion from Telegram that this account holds this number. An SMS
OTP proves the same thing but costs money per attempt, fails in ways users blame
on us, and is the single most attacked surface in Indian fintech. The contact
share is free and unforgeable by the sender. `completeContactShare` still
refuses a *forwarded* card by comparing `contact.user_id` against the sender's
id — a forwarded contact is someone else's number, and accepting one would hand
over an account.

**There is no password to steal.** No credential stuffing from another site's
breach, no reset-flow phishing, no "must contain a symbol" support load, no
hash to leak. The account is reachable only by controlling the Telegram account,
and Telegram's own security is better than any password policy we could enforce.

**Channel membership becomes enforceable.** The platform's audience and its
access control are the same list, and it stays current without polling — see §5.

The cost is a hard dependency on one company, which is why replacing the bot is
a first-class operation rather than a code change (§7).

---

## 3. Signup, step by step

`domains/telegram/telegramOnboarding.service.js`.

| Step | What happens | Where the guarantee is |
|---|---|---|
| `/start` | `TelegramPendingLink` created, carrying any `?start=<code>` referral payload | TTL index — an abandoned signup expires rather than accumulating |
| Aadhaar sent | Hashed (HMAC) and encrypted (AES-256-GCM); pending row updated | Courtesy duplicate check, but the **unique index on `KycVerification.aadhaarHash`** is the actual gate |
| Contact shared | **`User` is created here**, phone recorded, `TelegramIdentity` linked | Partial-unique `one_active_identity_per_phone`; forwarded-contact guard |
| Channel joined | Joining number assigned, referral edges written, login link sent | `nextJoiningNumber()` is an atomic `$inc` — no two players share a position |

**Why the account is created at the contact step and not at `/start`:** an
account that exists before the phone is proved is an account somebody can create
for a number they do not hold. Creating it at contact-share means every `User`
row in the database has a proved phone behind it, with no cleanup job required.

**Why the joining number is assigned at completion and not at creation:** the
number is the referral queue's position and it must be scarce and ordered. If it
were handed out at `/start`, anyone could burn through positions by starting the
bot repeatedly, and the queue would be full of accounts that never finished.

**One Aadhaar, one account.** Enforced by the database, not by a lookup. The
service does check first, for a friendly message, but two simultaneous signups
with the same number both pass that check — and one of them then fails the
unique index, which is the outcome that matters. Error 11000 is caught and
reported as "already registered".

---

## 4. Sessions

`domains/telegram/telegramLogin.service.js`, `domains/telegram/telegram.routes.js`.

The bot cannot set a cookie in a browser, so it hands out something the browser
can trade. That token travels through a chat, which means it can be
screenshotted, forwarded, or read over a shoulder, so it is built to be worth as
little as possible for as short a time as possible:

- **single use**, enforced by a `consumedAt: null` filter *inside* the
  `findOneAndUpdate` that redeems it. Two simultaneous redemptions both run the
  update; only one matches a document. Reading first and marking used second
  would leave a window where both requests see it unconsumed — the same TOCTOU
  shape as the withdrawal bug this codebase already paid for;
- **minutes**, swept by a TTL index (`TELEGRAM_LOGIN_TTL_MS`, default 5 min);
- **stored as a SHA-256 hash**, so a database dump yields nothing redeemable;
- **bound** to the Telegram account it was issued for;
- **carried in the URL fragment**, not the query string. A fragment is never sent
  to the server, so the one credential in the link stays out of access logs, out
  of the reverse proxy's log, and out of the `Referer` header the browser
  attaches to whatever the page loads next.

Every failure — expired, already used, never valid — returns one indistinguishable
answer. There is nothing a retry could learn, and the fix is always a fresh
`/start`.

`POST /api/telegram/exchange` calls **`issueSession`**, imported from
`routes.js`, rather than minting its own. That is deliberate: staff password
login, staff post-2FA login and Telegram login all reach the same function, so
proving who you are changes **when** you get a session, never **what** it
contains. Three copies would be a standing invitation for one door to grant
claims the others refuse.

---

## 5. The channel gate

`domains/telegram/telegramMembership.js`, `middleware/requireChannelMembership.js`.

Mounted on the three money paths, and only those:

```
POST /api/bet/place              requireChannelMembership({ action: 'place a bet' })
POST /api/payment/deposit/create requireChannelMembership({ action: 'add funds' })
POST /api/payment/withdrawal/create requireChannelMembership({ action: 'withdraw' })
```

Reads are not gated. Someone who left the channel can still see their balance,
their history and the result of a round they already played — locking them out of
their own record would be a support queue, not a control.

**Event-driven, not polled.** Telegram sends a `chat_member` update when someone
joins or leaves, and that update is the cache's primary writer. Polling
`getChatMember` per request would be one Telegram API call on every bet: at 10k
DAU that is both a rate-limit problem and a latency problem, and Telegram being
slow would make betting slow.

**The outage policy is a bounded window.** If Telegram is unreachable and the
cache is cold, the middleware allows the action for `TELEGRAM_MEMBERSHIP_GRACE_MS`
(default 24h) **measured from the last CONFIRMED membership**, then refuses.
The two alternatives are both worse: fail-closed means a Telegram outage stops
the whole platform taking money, and fail-open indefinitely means the gate
silently stops existing the first time an outage goes unnoticed. A bounded window
absorbs a real outage and expires on its own.

Staff are exempt — an admin does not join the player channel to do their job.

**Generations invalidate the cache.** A cached "joined" verdict from the previous
channel is meaningless after a replacement, so each identity records the
generation its verdict was formed under and a mismatch is treated as unknown.

---

## 6. KYC

`domains/identity/kycVerification.model.js`, `domains/identity/kycBulk.service.js`.

The Aadhaar **number** is the entire submission. It is stored twice, for two
different jobs:

| Form | Purpose | Reversible? |
|---|---|---|
| `aadhaarHash` — HMAC-SHA256 | uniqueness; "does this Aadhaar have an account" | No |
| `aadhaarEncrypted` — AES-256-GCM | the bulk export to the verifier | Yes, with the key |

The hash cannot be used for the export (it is one-way) and the ciphertext cannot
be used for the unique index (GCM is randomised — the same input encrypts
differently every time). Hence both.

Both support rotation. `hashAadhaarCandidates` checks retired HMAC secrets
(`AADHAAR_HMAC_PREVIOUS_SECRETS`) so a rotation does not lock every existing
player out of recovery; `IDENTITY_ENCRYPTION_PREVIOUS_KEYS` is decrypt-only, so a
key can be retired without a migration window.

### The export/import cycle

`GET /api/admin/kyc/bulk/export` → verifier puts YES/NO in a column →
`POST /api/admin/kyc/bulk/import`.

Everything about this path assumes the file is dangerous:

- **CSV formula injection** — every cell beginning `=`, `+`, `-` or `@` is
  escaped. The verifier opens this file in Excel or Sheets by definition, and
  those execute such a cell.
- **Never written to disk** server-side. There is no file to forget about and no
  bucket to misconfigure. It streams as an attachment with `Cache-Control:
  no-store, private`.
- **An audit row per batch**, naming the admin, on both export and import.
- **Undecryptable rows are skipped, not exported blank.** A blank Aadhaar comes
  back NO and permanently fails an innocent player.
- **Unrecognised verdicts stay PENDING and are reported.** Defaulting to VERIFIED
  activates payouts on an unchecked identity; defaulting to FAILED voids an
  innocent player's upline commissions. Both are worse than stopping.
- **Only `PENDING_VERIFICATION` rows move**, so re-importing the same file is a
  no-op rather than a way to overturn a settled verdict.

**Verdicts reach the `User` through `decideKyc`, not a bulk write.** A batch is
not a reason to skip the state machine — it is a reason to apply it ten thousand
times. That is what gets the legal-transition guard, the reviewer field, the
rejection reason landing in the field the player is actually shown, and the
Mongo/Postgres authority resolution. **Both** verdicts are mirrored: without the
FAILED half, a player whose Aadhaar did not check out keeps `PENDING_APPROVAL`
forever — never able to withdraw, never told why, and absent from the queue
because their verification row says the batch already handled them.

Manual approve/reject survives in the admin panel as the **exception path** —
for a case the batch got wrong, or one that cannot wait for the next run. It
goes through the same `decideKyc`, so there is exactly one place a KYC status
changes.

---

## 7. Replacing the bot or the channel

`routes/admin/telegram.admin.routes.js`, admin panel → **Telegram Setup**.

Telegram suspends gambling bots. The bot is the only way a player signs up or
signs in, so a suspension is a total outage of both — and if fixing it required a
code change and a deploy of three applications, that outage would be measured in
hours, during a period when nobody can join.

So it is a form. Paste a token, activate. Specifically:

- the token is **verified against Telegram before anything is stored**. A config
  with a dead token takes sign-in down until someone notices, and the failure
  looks like "the bot stopped working" rather than "the value pasted was wrong";
- deactivate-old and activate-new happen in **one transaction**. The partial
  unique index refuses two active configs, so two steps would either fail or
  leave a window with none active;
- **a webhook failure does not unwind the config.** The row is correct and an
  operator can retry; rolling back would leave the platform on a bot that may
  already be dead. It is reported loudly instead;
- **existing players are unaffected.** Identities key on the person's *Telegram*
  user id, which belongs to Telegram, not to our bot. Balances, history, referral
  trees and joining numbers all survive untouched;
- **tokens are write-only.** There is no read path for one anywhere in the
  platform. An operator changing a bot supplies a fresh value.

`GET /api/telegram/public-config` is how the panels learn the current
`@username` — public and unauthenticated, because it is what an anonymous visitor
needs in order to sign in at all, and it carries nothing that is not already
public the moment the bot exists. Baking the username into the frontend would
mean a rebuild before anyone could sign up again.

### 7a. The bot fleet — spares registered before the incident

`domains/telegram/telegramBots.service.js`, `TelegramBot`.

The activation form above can replace a dead bot **only if the operator already
has a working token in hand.** At 3am that means opening @BotFather, creating a
bot, naming it, copying a token and pasting it — with signup and login dead
throughout.

The fleet moves all of that to *before* the incident. A spare is registered and
**verified against Telegram** while everything is calm, and parked as `STANDBY`.
The incident response is then `promote(id)`: one click.

Roles: `signin`, `recovery`, `broadcast`, `moderation`, `generic`. Sign-in and
recovery are **singular** — exactly one of each may be live, because both are
addressed by an inbound webhook whose updates are authenticated against *the*
live bot's secret, and two live bots would mean the check compared against
whichever row a non-deterministic read returned first. That is enforced by the
database: a derived `liveSlot` field, maintained by a pre-validate hook, under a
sparse unique index. Broadcast, moderation and generic bots are outbound-only, so
any number may be live.

Consequences worth knowing:

- **Promotion never bumps the generation.** A bot swap invalidates nothing —
  identities key on the *person's* Telegram id — so forcing every player to
  re-join the channel to fix a problem that never touched the channel would be
  pure damage. Only a **channel** change bumps the generation.
- **The registry wins over the credentials embedded in a generation.** Both can
  name a sign-in bot; they answer different questions ("what was live when this
  generation was created" vs "what is live now"). `activeConfig()` reads the
  registry first and falls back to the embedded fields, which is what an install
  that never registered a spare has.
- **Writers must use `.save()`, not `updateOne`.** Mongoose runs no middleware
  for update operations, so an `updateOne` that changed `status` would leave a
  stale `liveSlot` behind and the index would guard nothing.
- **Database first, webhook second.** The two writes cannot be made atomic across
  two systems. Webhook-first would leave Telegram delivering as the new bot while
  we authenticate against the old secret — every update rejected 401, with the
  panel showing the old bot as live and nothing revealing the cause.
  Database-first leaves a correct row with no delivery: loud, obvious, and fixed
  by a retry button.

### 7b. Replacing the channel alone

`POST /api/admin/telegram/channel`.

In an incident the bot and the channel are almost never the same event — a
channel is deleted while the bot is fine. Requiring a working bot token to be
re-pasted in order to fix an unrelated channel is one more way to fail under
pressure, so this endpoint takes a channel and nothing else and carries the
current bot arrangement forward.

It bumps the generation, and **that is the entire migration.** Every cached
membership records the generation it was observed in, so all of them become
stale by construction; the next protected request each player makes returns
`403 CHANNEL_MEMBERSHIP_REQUIRED` carrying the new invite link, which the user
panel raises as a prompt that cannot be dismissed
(`user-panel/src/components/Modals/ChannelGateModal.tsx`). Accounts, balances,
KYC state, referral positions and joining numbers are untouched — none of them is
keyed on the channel.

The prompt reads the **cache** first (`GET /api/telegram/membership`) and only
asks Telegram on an explicit second attempt, floored per user. On a flip the
prompt appears for every logged-in player at once; joining a channel emits a
`chat_member` update that writes the cache within about a second for free, so
polling `getChatMember` on every tap would aim the whole active user base at the
Bot API in the same few seconds — and at the bot everyone is simultaneously
trying to sign in through.

### 7c. What the bot says

`domains/telegram/telegramTemplates.service.js`, admin panel → **Bot messages**.

The welcome message carries the requirement that a player's Telegram account be
on the mobile linked to their Aadhaar. Getting it wrong does not arrive as a bug
report; it arrives weeks later as a pile of failed verifications. So the copy is
data, editable without a deploy, with the shipped wording as the fallback.

Three rules make it safe to hand to an operator:

1. **A blank row means "use the default", never "send nothing".** Silence after
   `/start` is indistinguishable from a broken platform.
2. **Substituted values are HTML-escaped** — including `"`, because a template
   may put a placeholder inside an attribute. One of the values is the player's
   own Telegram first name, which they choose.
3. **If Telegram refuses a custom template as malformed, the default is sent
   instead.** An admin's stray `<div>` must not be able to take signup offline,
   which is exactly what it would do — silently, since the failure is a 400 on a
   fire-and-forget send nobody is watching. The markup is also checked on save,
   so the usual case is caught where the admin can see it.

---

## 8. Account recovery

`domains/telegram/telegramRecovery.service.js`. **A second bot, on its own token
and its own webhook secret.**

This path exists for exactly one situation: the Telegram account is gone
(deleted, or taken over) while the person still controls the **phone number** it
was registered on. That is the only case the ordinary route cannot serve, because
the ordinary route authenticates the Telegram account.

Recovery hands one person's account to a different Telegram identity, which is
precisely the shape a successful takeover has. What separates the two:

1. **Two factors, both required.** Control of the phone (proved by Telegram's own
   contact share, not typed) *and* knowledge of the Aadhaar registered to that
   account. Someone with a recycled SIM has the phone but not the Aadhaar;
   someone with a scraped Aadhaar cannot receive on the number.
2. **The account is found by PHONE.** The Aadhaar is only ever *compared* against
   the account the phone already resolved to. Looking an account up **by** Aadhaar
   would make the bot an oracle for "does this Aadhaar have an account here" —
   the exact flaw removed from the old recovery route.
3. **One failure reason for every genuine mismatch.** Distinguishing "no account
   on this number" from "wrong Aadhaar" lets a recycled SIM reveal whether a
   number is registered, and a leaked Aadhaar list reveal which numbers it
   belongs to.
4. **It re-links; it never creates.** Balance, history, KYC verdict, referral
   tree and joining number belong to the `User`, and the `User` is untouched.
   Retire-old and link-new happen in one transaction, because the phone's unique
   index is partial on `contactActive` and two steps would leave the account with
   two live identities or none.
5. **Every grant raises an alert.** A pattern of them is visible without anyone
   having to think to look.

A separate bot because a compromised primary bot must not be able to hand out
other people's accounts, which it could if recovery shared its credentials.

---

## 9. Referrals

`domains/referral/referral.service.js`, `domains/referral/referral.model.js`.

| Parameter | Value |
|---|---|
| Reward | **₹25** (`REFERRAL_REWARD_PAISE = 2500`) |
| Depth | 2 tiers — the direct referrer and *their* referrer |
| Budget | **₹400 crore** (`PROGRAMME_BUDGET_PAISE`) |
| Member cap | **8 crore** verified members (`PROGRAMME_MEMBER_CAP`) |

A code rides in the deep link (`t.me/<bot>?start=<code>`) and is captured by the
panel at boot into `localStorage` (`user-panel/src/services/referralCapture.ts`) — a visitor
rarely signs up in the first second, and by the time they open the bot the URL
has changed. First code wins, and it ages out after 90 days: without a lifetime,
a code picked up in March still credits a referrer in November.

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
| `TELEGRAM_LOGIN_TTL_MS` | no | Login-link lifetime (default 5 min) |
| `TELEGRAM_MEMBERSHIP_GRACE_MS` | no | Outage window from last confirmed membership (default 24h) |
| `PUBLIC_APP_ORIGIN` | yes | Where login links point, and the webhook base |

Bot tokens, webhook secrets and channel ids are **not** environment variables.
They live in `TelegramConfig` so they can be replaced from the admin panel
without a deploy — which is the entire point of §7.

---

## 11. What was removed, and why a reference to it is stale

Removed 2026-08-25. If you find one of these named anywhere outside this section
and the commit history, the reference is out of date.

| Removed | Replaced by |
|---|---|
| `POST /api/v1/auth/register`, `/login`, `/login/2fa` (players) | The bot. Players have no password |
| `routes/account-recovery.routes.js` + `accountRecovery.model.js` | The recovery bot (§8). The old flow issued a temporary **password**, so it was dead by construction once players stopped having one |
| `POST /api/user/kyc/:docType/upload-url` | Nothing. There is no document |
| `POST /api/user/:userId/kyc` | The bot takes the Aadhaar before the account exists |
| `GET /api/admin/kyc/:userId/document/:docType` | Nothing to view |
| `services/kycDocuments.service.js` + the private bucket | See `KYC_DOCUMENT_STORAGE.md` for the record |
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
| `telegramOnlyAuth.test.js` | The player password surface is gone and stays gone; one session issuer; staff-only door on both legs |
| `telegramRecoverySafety.test.js` | Search key is the phone; two factors required; one failure reason; re-link never re-creates |
| `kycBulkSafety.test.js` | Formula escaping; nothing to disk; no guessed verdicts; batch decisions go through the state machine; FAILED is mirrored |
| `kycDocumentPathRemoved.test.js` | No upload, no viewer, no identity data on `User`, one decision path |
| `fieldCryptoRotation.test.js` | Decrypt-only retired keys; rewrap |
| `schemaIndexConflicts.test.js` | No two indexes with the same key pattern and different options |
| `adminRouteContract.test.js` | The panel calls paths the server serves; `/kyc/bulk/*` and `/telegram/*` are not shadowed by wildcard patterns beside them |
| `telegramFleet.test.js` | One live bot per singular role, via the derived `liveSlot` and its sparse unique index; outbound-only roles get no webhook; a template Telegram would refuse is caught on save; a player-chosen name cannot become markup |
| `channelGateOrdering.test.js` | The gate asks whether a channel exists *before* blaming the player for not having joined one |

Most of these assert **absence**, which no feature test can do: a happy-path
suite for bulk verification passes perfectly well with an upload endpoint still
mounted next to it.
