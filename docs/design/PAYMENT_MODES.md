# Payment modes — two P2P rails, one switch

> Read `CLAUDE.md` first. This document is subordinate to it.

The platform runs **one** of two P2P settlement rails at a time. An admin
switches between them from the panel. Neither rail is deleted when the other is
live: the whole point of the switch is that moving between them costs a button
press and no infrastructure work.

| | `P2P_UPI` (mode A) | `CASH_ATM` (mode B) |
|---|---|---|
| Buy, INR | Player pays merchant UPI, submits UTR | Player withdraws cash at ATM using a merchant-supplied link |
| Sell, INR | Merchant pays player's bank | Merchant deposits cash at a CDM, submits receipt |
| Amounts | Merchant min/max **range** | Fixed **denominations** |
| Assignment | Score-based pull (`selectBestMerchant`) | Link queue, first matching link wins |
| Merchant supplies | UPI ID or QR | Scanned ATM QR → payment link |

Mode A is what exists today and is not being rewritten. Mode B is new.

---

## 1. The switch is a versioned policy row

`payment_mode_policies`, in the same shape as `deposit_policies` and
`merchant_bonus_policies`: each row **is** a version, exactly one `ACTIVE` at a
time enforced by a partial unique index, append-only history, and every row
names `changed_by` and carries a `justification`.

**Not a feature flag.** `featureFlags.service.js` resolves from an env var and
an in-process `Map`. It does not survive a restart, it is not audited, and it
cannot answer "which rail was live when this order was created". A switch that
decides where a player's money goes is not a process-local boolean.

**Not `payment_gateway_configs.active_mode`.** That column is `P2P` /
`GATEWAY` / `BOTH` — merchant settlement versus a third-party gateway. **Both**
of the modes in this document are `P2P`. They are orthogonal axes and putting
two meanings on one column is how the config payload came apart before
(`CLAUDE.md`, "One owner per value").

### What the policy row owns

- `active_mode` — `P2P_UPI` or `CASH_ATM`.
- The three timers, **per mode**, admin-editable:
  - `assignment_wait_seconds` — how long an unassigned order waits before it fails.
  - `processing_window_seconds` — how long an assigned merchant has to act.
  - `utr_submit_seconds` — how long the player has to submit the UTR.
- Mode B only: `link_expiry_seconds`, `link_min_remaining_seconds`,
  `broadcast_visibility_seconds`.

Timers are policy, not constants. Nothing reads a hardcoded 15 or 30.

---

## 2. Every order snapshots the mode it was created under

`order_states.payment_mode`, plus the timer values in force at creation,
written by `createOrderRecord` and **immutable thereafter** (enforced by a
trigger, not a convention).

This is the single most important safety property of the switch. An admin
flipping the rail while 200 orders are in flight must not change the rules
those orders are running under: their timers, their variety, their assignment
path, and what the merchant owes. An order finishes under the rail it was born
on; the switch only decides what the **next** order looks like.

A consequence worth stating: after a flip, both rails are live simultaneously
until the last pre-flip order settles. Every worker and every screen must
branch on the order's own `payment_mode`, never on the current policy.

---

## 3. Mode A — `P2P_UPI` (what exists)

Unchanged in substance. The merchant registers a UPI ID or QR; the panel
auto-generates a per-order payment link from it and sends that to the player.
Assignment stays `merchantScoring.service.js`. Concurrency stays the
admin-editable caps already enforced in `assignmentCandidates` — both the
per-direction cap and `max_concurrent_orders`.

Amounts are a **range** (`min_order_paise` / `max_order_paise`). Mode A does
not use denominations.

---

## 4. Mode B — `CASH_ATM` (new)

### 4.0 Which way the cash actually moves

This is the crux of the rail and it is easy to derive backwards, so it is
written down. **Cash ends up in the merchant's hands on a BUY and leaves them on
a SELL.**

**BUY** — the merchant is standing at an ATM. They initiate a UPI cash
withdrawal; the ATM shows a QR, which yields a payment link for a fixed
denomination. That link goes into the queue. A player with a matching buy order
is handed it, pays it from their own UPI app, the ATM dispenses, and **the
merchant collects the cash**. The player has paid and receives tokens.

This is why the denominations are 500 / 1,000 / 5,000 / 10,000: they are ATM
dispense amounts, not a pricing decision.

**SELL** — the merchant now holds cash. They deposit it at a CDM **into the
player's bank account**, then submit the bank transaction id and a photo of the
CDM receipt. The player is paid to their bank, as on every rail.

So one merchant cycles naturally: take a buy, hold the cash, serve a sell with
it. That is also why a merchant holds **one order at a time in either
direction** rather than one per direction — the cash they are holding is the
same cash.

### 4.1 One merchant, one denomination

A merchant is approved for exactly ONE denomination and works only that. A
₹500 merchant places only ₹500 links, receives only ₹500 orders, and sees only
the ₹500 queue depth. There is no second approval.

The same denomination serves both directions. ₹40,000 is a fifth tier that only
ever receives withdrawal legs, because no buy order is that large.

### 4.2 The buy queue

The supply arrives before the demand, which inverts the assignment direction
used everywhere else on this platform:

1. A merchant scans the ATM QR and supplies the resulting link.
2. The link enters the queue with an expiry (`link_expiry_seconds`).
3. A buy order of that denomination claims it. First matching order wins.
4. A link with less than `link_min_remaining_seconds` left is not assignable —
   a player cannot reach the machine in time.

Claiming uses `FOR UPDATE SKIP LOCKED` so two orders cannot take one link.

**The amount is DECLARED by the merchant**, from their own approved
denomination — there is only one, so there is nothing to choose. No ATM QR
format is parsed. A merchant who attaches a link for the wrong amount is caught
by the player's dispute and the existing warning path.

**Broadcast, not polling.** A merchant sees, live, how many orders at **their
own denomination** are waiting for a link — never other denominations. Only
orders with no link yet are shown, because a link is claimed the instant it
exists, and only merchants with headroom now (or within two minutes) are told,
because a merchant whose tokens are in escrow cannot serve one anyway.

### 4.2b Rules the queue runs under

**One live link per merchant.** A merchant supplies one link and cannot supply
another until it is claimed or expires — they are standing at one machine doing
one withdrawal. Enforced by a partial unique index, so it is a property of the
table rather than a rule a writer keeps.

**An expired link owes nobody anything.** No money moved: the ATM transaction
simply times out. No compensation, no priority, no record beyond the expired
row. The broadcast is what keeps a merchant from wasting the trip, so the
broadcast has to be accurate — that is the load-bearing part of this choice.

### 4.3 The sell side, and the receipt



The merchant deposits cash at a CDM into the player's bank account and submits
the bank transaction id and a photo of the receipt.

**The receipt is write-only.** Once submitted, neither the player nor the
merchant who uploaded it can read it back — only an admin or a disputes
manager. So the upload screen must confirm clearly at the moment of submission,
and re-upload before submit must be allowed, because a mis-upload cannot be
checked afterwards by the person who made it.

**The merchant's click completes the order; the receipt is chased afterwards.**
A missing receipt flags the merchant rather than blocking the player.

That is only safe because of the hold that already exists. `withdrawalHold`
freezes BOTH sides for `disputeWindowSeconds` on every confirm: the player's
stake stays locked and the merchant's tokens do not exist yet, so until
settlement runs **no value has moved**. The click advances the order; it does
not release money.

So the rule this rail adds is: **a hold whose receipt never arrived must not
settle.** It goes to the dispute queue instead. Without that, "complete on the
click" is exactly the loss `withdrawalHold.service.js` was written to close — a
merchant asserting payment they never made — and setting `disputeWindowSeconds`
to its minimum would be enough to realise it.

### 4.4 Denominations are a set, not a range

`min_order_paise` / `max_order_paise` cannot express "500 and 10,000 but not
1,000", and in any case a Mode B merchant serves exactly one figure. Mode B uses
a dedicated column on the merchant; the range columns keep governing Mode A.

## 5. Amount rules (both modes)

**A player never types an INR amount.** Buy orders are chosen from the
denomination list — 500 / 1,000 / 5,000 / 10,000 — and nothing else is
accepted. The cap is therefore structural rather than a validation rule.

- **USDT is the only free-value input**, and it is deposit-only. The minimum is
  500 tokens, the same floor as the smallest INR denomination.
- **Every withdrawal pays out to a bank account**, on both rails. There is no
  USDT withdrawal.
- **₹40,000 is a withdrawal tier only.** It never appears on a buy.
- A player may place further buys **one at a time** — no aggregate cap, because
  the ceiling is about what an ATM dispenses, not about limiting the player.
  Velocity and AML thresholds carry that load, not this rule.

### The USDT price is admin-set, not a live feed

The admin sets a price per token and edits it at most once or twice a day, so it
is effectively fixed. The player enters how many **tokens** they want (minimum
500); the system converts at the current admin price, generates the BTCPay
payment link **and its QR**, and BTCPay watches the chain.

The rate is snapshotted onto the order at creation, like `rateUsed` already is,
so an admin editing the price cannot rewrite what a settled order charged.

### Withdrawal batch splitting

A withdrawal larger than one denomination splits into child orders under one
parent. The player's stake is locked **once, at the parent** — not once per
child.

Split rule, largest first: ₹100,000 → 40,000 + 40,000 + 10,000 + 10,000. Do not
go below 5,000 unless the remainder is itself under 5,000.

**The player sees one order that expands to its children.** The parent is the
withdrawal they asked for; expanding shows each leg and its state. Every list,
filter and export has to decide whether it counts parents or children, and the
answer is parents unless it is the dispute queue.

Assignment is partial-batch, partial-queue: legs that can be assigned now are,
the rest queue. An assigned leg has 15 minutes to process.

**A leg that cannot find a merchant stays queued rather than failing.** The
paid legs stay paid — a completed CDM deposit cannot be clawed back — and the
outstanding leg waits for capacity.

The cost of that is an unbounded token lock, so two things are required rather
than optional: a leg queued past the assignment window appears in an **admin
stalled-legs queue**, so somebody is accountable for it; and the **player may
cancel it themselves** and take those tokens back. An order with no deadline
and no owner is an order nobody is answerable for.

## 6. Timers, expiry and retry

- **UTR grace.** The transaction timer is the UTR deadline. If a player clicks
  *Paid* with under a minute left, they get a full minute from that click to
  submit the UTR.
- **Expiry is retryable.** An expired order shows a retry button. A **retried
  order outranks a first-time order** in assignment.
- **An order that never got a merchant owes nothing.** No assignment means no
  transaction happened; nobody is liable.
- **Silence after payment completes the order.** If the merchant asserted paid
  and the player raised no dispute inside the hold window, the order completes
  normally and no one is held responsible.

---

## 7. USDT deposits via BTCPay Server

BTCPay Server is the USDT rail. It issues a per-invoice address and watches the
chain itself, which removes the two problems the earlier design could not solve:
address derivation, and telling two players apart who send the same amount to
the same address.

Consequences:
- No HD wallet or chain watcher is built here.
- The merchant `usdt_wallet_address` column and its TRC20-only CHECK are not on
  this path. **Do not widen that CHECK for BEP20** — BTCPay holds the addresses.
- The BTCPay webhook is the confirmation, and it must be signature-verified and
  idempotent on the invoice id.

---

## 8. Privacy — what each side may see

**A merchant never sees:**
- the player's mobile number, in whole or in part;
- the player's UPI ID;
- anything from the CDM receipt after submitting it.

**A merchant sees, on a withdrawal only:** account number, IFSC, bank name and
the account holder's full name. Nothing else.

**A player never sees** the merchant's personal details — only the payment link.

### This must be an allowlist

`sanitizeMerchantOrder` is currently a **denylist** (`delete plain.userPhone`),
and it strips `userBankDetails` only when the order is a DEPOSIT. On a
WITHDRAWAL the merchant therefore receives `userBankDetails.upiId`, which the
rule above forbids.

A denylist fails open: the next PII column added to `order_states` is exposed by
default and no test fails. The projection becomes an **allowlist**, and a gate
refuses a merchant-facing order response that does not go through it.
