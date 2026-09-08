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

### 4.1 Buy (player receives cash from an ATM)

The direction is inverted from mode A. In mode A an order arrives and the
system picks a merchant. Here the **supply arrives first**:

1. A merchant scans an ATM cash-withdrawal QR. The panel turns it into a link.
2. The link enters a queue with an expiry (`link_expiry_seconds`).
3. An order of that denomination claims the link. First matching order wins.
4. A link with less than `link_min_remaining_seconds` left is not assignable.

Claiming uses `FOR UPDATE SKIP LOCKED` so two orders cannot take one link.

**Broadcast, not polling.** Merchants who are eligible to supply are shown, live,
how many orders are waiting for a link at each denomination — so they know when
supplying is worth it. The broadcast shows only:

- orders that have **no link yet** (a link is auto-assigned the instant it
  exists, so an order with a link is never advertised), and
- to merchants whose tokens are **not** in escrow lock — that is, merchants with
  headroom now, or headroom arriving within the next two minutes.

### 4.2 Sell (merchant deposits cash at a CDM)

The merchant deposits cash at a CDM and submits **a transaction ID and a photo
of the CDM receipt**.

That receipt is **admin-only**. It is never returned to the player and never
returned to the merchant after submission — only an admin or a disputes manager
can read it. This is a storage and projection rule, enforced at the reader.

### 4.3 Denominations

Mode B merchants serve a **set**, not a range: 500 / 1,000 / 5,000 / 10,000,
plus 40,000 for withdrawals only. `min_order_paise` / `max_order_paise` cannot
express "500 and 10,000 but not 1,000", so mode B uses a
`merchant_denominations` child table. The range columns keep governing mode A.

---

## 5. Amount rules (both modes)

- **Buy, INR: capped at ₹10,000 per transaction.** Above that the player buys
  with USDT instead.
- **USDT is deposit-only.** There is no USDT withdrawal on either rail.
- **Every withdrawal pays out to a bank account**, whatever the mode.
- **₹40,000 is a withdrawal denomination only.** It never appears on a buy.

### Withdrawal batch splitting

A withdrawal larger than one denomination splits into child orders under one
parent. The player's stake is locked **once, at the parent** — not once per
child.

Split rule, largest first:
- Prefer the largest denominations. ₹100,000 → 40,000 + 40,000 + 10,000 + 10,000.
- Do not go below 5,000 unless the remainder itself is under 5,000.

Assignment is partial-batch, partial-queue: children that can be assigned now
are assigned now; the rest queue. The parent still has the full completion
window. Children unassigned at `assignment_wait_seconds` go `FAILED`, and the
player may retry.

---

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
