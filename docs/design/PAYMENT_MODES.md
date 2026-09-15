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

**An expired link owes no money, but buys priority once.** Nothing moved — the
ATM transaction simply times out — so there is no compensation. But the merchant
still drove there, so their NEXT link is claimed ahead of others at the same
denomination.

The credit is derived and BOOLEAN: "you have an expired link newer than your
last claimed one". A tally would need a decay rule and a cap to stop a merchant
farming priority by supplying links at dead hours; a boolean gives ten wasted
links exactly the priority of one, and a single successful claim consumes it.

The broadcast still has to be accurate — priority softens a wasted trip, it does
not pay for one.

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

**A missing receipt does NOT auto-dispute.** The hold settles normally when its
window passes; the absence only flags the merchant. A dispute happens when — and
only when — the player raises one inside the window.

The consequence, stated plainly because it is a real exposure: a merchant who
clicks paid, never deposits, and never uploads a receipt is settled by default
if the player does not notice inside `disputeWindowSeconds`. The dispute window
is therefore the only thing standing between that merchant and the money, and
shortening it shortens exactly that protection. The flag is what makes the
pattern visible after the fact rather than what prevents it.

**Both sides of "chased afterwards" are screens.** Completing the order and then
asking for paperwork means the moment to submit passes — an upload that failed,
an app closed at the machine, a slip not yet in hand — and the order is then
gone from every screen the merchant has. So there are two queues, and they are
the same fact from opposite ends:

| Who | Where | What it answers |
|---|---|---|
| Merchant | `GET /api/merchant/cdm-receipts/outstanding`, shown above their order queue | "Which of my payouts still needs a slip?" |
| Admin / disputes manager | `GET /api/admin/orders/cdm-receipts/missing`, the CDM Slips screen | "Who is not evidencing their payouts?" |

Without the merchant half the admin queue fills with items only the merchant can
clear and the merchant cannot reach. The merchant list carries three facts —
order id, cash amount, completion time — and deliberately not the player: a list
of paperwork owed is not an occasion to re-identify anybody. It reads
`cdm_receipt_url` only as `IS NULL`, so a merchant learns THAT they still owe a
slip and never what a submitted one says.

**Reading a slip is a click, never a page load.** Every read is written to the
audit log, so fetching one because a dispute screen opened would record a view
for every order anybody glanced at, and "who looked at this player's bank slip"
would stop having an answer. The dispute modal offers a button; the CDM Slips
screen takes an order id.

### 4.4 Denominations are a set, not a range

`min_order_paise` / `max_order_paise` cannot express "500 and 10,000 but not
1,000", and in any case a Mode B merchant serves exactly one figure. Mode B uses
a dedicated column on the merchant; the range columns keep governing Mode A.

## 5. Amount rules (both modes)

**A player never types an INR amount.** Buy orders are chosen from the
denomination list — 500 / 1,000 / 5,000 / 10,000 — and nothing else is
accepted. The cap is therefore structural rather than a validation rule.

- **USDT is denominated too, and is deposit-only.** A USDT buy is exactly
  50,000, 100,000 or 500,000 platform tokens (see §7). It was originally
  specified as a free-value input with a 500-token floor; that is no longer the
  case.
- **Every withdrawal pays out to a bank account**, on both rails. There is no
  USDT withdrawal.
- **₹40,000 is a withdrawal tier only.** It never appears on a buy.
- A player may place further buys **one at a time** — no aggregate cap, because
  the ceiling is about what an ATM dispenses, not about limiting the player.
  Velocity and AML thresholds carry that load, not this rule.

### The USDT price is admin-set, not a live feed

The admin sets a price per token and edits it at most once or twice a day, so it
is effectively fixed. The player **chooses one of the three token
denominations** (§7) and the system converts at the current admin price to show
what they must send.

The rate is snapshotted onto the order at creation and **frozen by a trigger**,
so an admin editing the price cannot rewrite what an agreed order charged — not
even on the assignment path minutes later, which used to re-read it. A purchase
that cannot be priced is refused by name (`USDT_RATE_UNSET`); there is no
fallback. The rate is bounded at both ends, because a misplaced decimal would
otherwise price the whole rail.

*(This paragraph originally described the player typing a free token amount with
a 500-token minimum and BTCPay generating the payment link and QR. Both are
superseded — see §7.)*

### Withdrawal batch splitting

A withdrawal larger than one denomination is created as **several separate
withdrawals** — not one order with child legs.

Split rule, largest first: ₹100,000 → 40,000 + 40,000 + 10,000 + 10,000. Do not
go below 5,000 unless the remainder is itself under 5,000.

#### Why flat siblings and not a parent with legs

The first implementation built a container: one parent row holding the escrow,
several child rows doing the work. It was correct, it passed, and it was the
wrong shape — for two reasons that only become visible once it exists.

**Every query had to choose.** Parent or legs? The answer differed for the
player's history, the open sell pool, the pending-withdrawal total, the user
stats, the dispute queue and the user-delete guard. Six places, each a silent
double-count or a silent omission if answered wrong — and one of them was a
money guard, where counting parents only would have let a player be deleted with
four legs live in the merchant queue. A relation every reader must reason about
is a tax on every future query, forever.

**A crash mid-creation left something incoherent.** A parent holding an escrow
with only some of its legs written is a withdrawal that does not add up, and no
row looks wrong.

Flat siblings have neither problem. Each part is an **ordinary withdrawal**: its
own escrow lock, its own assignment, its own timer, its own cancel, its own
dispute, its own release. Nothing downstream branches on whether an order came
from a split, because nothing can tell. And a crash after two of four leaves
exactly two valid withdrawals — money conserved, nothing dangling, nothing to
unwind.

#### The money, part by part

Each part debits its **own** amount against its **own** order id, under the
wallet's row lock, exactly as a single withdrawal does. There is no pooled lock
to reconcile and no compensating refund to get wrong.

That is also why nothing pre-checks the total: a pre-check is precisely what was
removed for racing the debit and double-counting escrow. If the wallet refuses
part three, parts one and two are complete withdrawals the player has, part
three's money never left winnings, and the response says so (`partial`).
Reversing the earlier parts would be a compensating action over money the player
is entitled to.

**The payout fee rides on the token side.** What reaches a machine must be a
denomination, so the split is computed on the cash figure and each part's fiat
is fixed by the ladder; the fee is spread across the parts' token amounts
(`shareFeeAcrossParts`), floored per part with the indivisible remainder added
to the largest. Two identities hold to the paise, and are asserted directly:

    sum(part.fiat)   = the cash the player receives
    sum(part.tokens) = the cash + the fee, charged exactly once

The container version could not do this — one lock for the whole withdrawal had
no leg to account for the fee — and refused to split at all while a fee was set.
That refusal is gone.

#### What ties the siblings together is a LABEL

`withdrawal_batch_ref` groups the orders that came from one request, so a player
is told "part 2 of 4" rather than finding four unexplained withdrawals at the
same second, and support can pull the set (`GET /api/payment/order/:id/batch`,
owner-scoped and re-checked per row — a batch ref is not a capability).

**Nothing branches on it.** No state is derived from it, no money reads it, no
assignment consults it. The moment something does, it has become the parent
relation again wearing a different name.

#### Waiting, and who is accountable for it

Assignment is partial-batch, partial-queue: parts that can be assigned now are,
the rest queue. A part that cannot find a merchant **stays queued rather than
failing** — the parts already paid stay paid, because a completed CDM deposit
cannot be clawed back.

The cost is a token lock with no deadline, so two things are required rather
than optional: a payout past the assignment window appears in the admin
**Stalled Payouts** queue (`GET /api/admin/orders/stalled-withdrawals`), and the
**player may cancel it themselves** through the ordinary cancel, because a part
is an ordinary withdrawal. An order with no deadline and no owner is an order
nobody is answerable for.

That queue is deliberately **not** split-specific: a stranded sibling is just a
queued withdrawal, so asking the general question covers it and every other
stuck payout with one query.

#### One constraint the operator has to know

**`maxWithdrawal` has to be raised for the split to mean anything.** It defaults
to ₹50,000 and the largest denomination is ₹40,000, so on a default
configuration the only split that exists is two parts, and the ₹100,000 example
above is refused before it reaches the splitter — by a limit that has nothing to
do with denominations. A platform running the cash rail raises this cap or the
feature is decoration.

## 6. Timers, expiry and retry

- **UTR grace.** The transaction timer is the UTR deadline. If a player clicks
  *Paid* with under a minute left, they get a full minute from that click to
  submit the UTR.
- **Expiry is retryable.** An expired order shows a retry button. A **retried
  order outranks a first-time order** in assignment.

  A retry is a NEW order, never a revival: CANCELLED is terminal, and reviving
  it would mean letting any cancelled order in the system come back to life. It
  runs the ordinary creation path, so every guard a first attempt passes it
  passes too — KYC, the limits, the denomination rule, the one-open-buy rule,
  and on a sell the escrow debit under the wallet's row lock. A partial UNIQUE
  on `retry_of_order_id` allows one retry per expired order: two live orders for
  one intent is two merchants on a buy, and on a sell the player's tokens locked
  twice.

  `assignment_priority` is the rank — higher first, age breaking the tie, so
  within a rank it stays first-come-first-served.

### A supplied link goes to whoever is already waiting

The link claim used to run exactly ONCE per order, at creation. An order created
when no merchant held a link at its denomination therefore **never got one** —
nothing looked again when the link it was waiting for was supplied a minute
later. The player watched a live order sit at PENDING_QUEUE until it expired
while a merchant stood at a machine with a link nobody took. Both sides waiting
for each other.

`matchWaitingOrdersToLinks` walks the waiting queue best-claim-first. It lives
with the ASSIGNMENT rather than with the link supply, because it must go through
the complete operation — claim the link, make its owner the order's merchant,
take the machine's deadline as the order's. The raw claim alone stamps a link id
onto an order that still has no merchant: a half-assignment, and worse than none
because the player sees a link and nobody is serving them.

It runs on supply (the latency) and on a 15-second sweep (the guarantee).

### One order at a time, on the link path too

`cash_link_one_live_per_merchant` stops a merchant holding two UNCLAIMED links.
It stops nothing once one is claimed — the row becomes CLAIMED, the partial
index no longer matches, and they may supply again while serving. And the
cash-link claim never goes through `selectBestMerchant`, so the concurrency cap
every other assignment obeys **was never consulted on this rail at all**:
supply → claimed → supply → claimed gave one merchant unbounded concurrent
orders.

Supply now refuses a merchant who is already working one (`ALREADY_SERVING`),
counting from the order rows through the same function the scorer uses.

> **Operator note.** `max_concurrent_orders` seeds to **3** on both rails. On the
> cash rail the answer is **1** — the notes a merchant is holding are the same
> notes, so two orders promise them twice. It is admin-editable per policy
> version and must be set to 1 when switching to the cash rail; the default does
> not match the rule.
- **An order that never got a merchant owes nothing.** No assignment means no
  transaction happened; nobody is liable.
- **Silence after payment completes the order.** If the merchant asserted paid
  and the player raised no dispute inside the hold window, the order completes
  normally and no one is held responsible.

---

## 7. USDT is a MERCHANT rail, on two chains

> **Superseded 2026-09-09.** This section described BTCPay Server as the USDT
> rail (shipped as B7, commit `5ba3f2c`). That was replaced by a merchant-served
> rail in `53d637c` and `59e6bdb`. The binding description is `CLAUDE.md` §25;
> what follows is the summary.

A player buys with USDT from a **USDT merchant**, by sending tokens to that
merchant's wallet and submitting the transaction id. There is no payment
processor, no invoice and no webhook — the counterparty is a person, and the rail
is the ordinary order lifecycle with a different currency on it.

- **Denominated in PLATFORM TOKENS** — exactly 50,000, 100,000 or 500,000. What
  the player *sends* is derived from the admin's rate at creation, so there is no
  second denomination list to drift when the rate changes.
- **The quote is the contract.** `rate_used` and `fiat_amount_paise` are written
  with the order and frozen by trigger; assignment may not re-price. A purchase
  that cannot be priced is refused by name (`USDT_RATE_UNSET`) — there is no
  fallback, because 0 gives Infinity USDT and 1 would sell 50,000 tokens for
  50,000 USDT.
- **A merchant holds one address PER CHAIN** (`usdt_address_trc20`,
  `usdt_address_bep20`). The single `usdt_wallet_address` column and its
  TRC20-only CHECK are gone: one column made Tron the only usable chain and made
  *which chain is this?* unanswerable. USDT sent to a Tron address from a BNB
  Smart Chain wallet is gone, and it is the only unrecoverable mistake this
  platform can make.
- **The player picks the network first**, before an order exists, because it
  decides which merchants can serve it. The chain is frozen on the row, the
  address and its network always travel together, and only the chain the order
  named is ever sent.
- **The transaction hash is claimed once**, through the same registry as a UTR
  and a CDM slip (`CLAUDE.md` §27).

---

## 8. Privacy — what each side may see

**A merchant never sees:**
- the player's mobile number, in whole or in part;
- the player's UPI ID;
- anything from the CDM receipt after submitting it.

**A merchant sees, on a withdrawal only:** account number, IFSC, bank name and
the account holder's full name. Nothing else.

**A player never sees** the merchant's personal details — only the payment link.

### This must be an allowlist — done, in both directions

**Built.** `sanitizeMerchantOrder` was a denylist that stripped the player's
payout details only on the DEPOSIT branch, so on every WITHDRAWAL the merchant
received the player's UPI ID. The other half had nothing at all: every
player-facing response carried the merchant's snapshot whole — UPI handle, QR,
bank account, IFSC, account-holder name and USDT address.

Both projections are now allowlists in one file each
(`domains/merchant/merchantOrderView.js`, `domains/payment/playerOrderView.js`),
enforced by `npm run check:merchant-privacy` and `npm run check:player-privacy`.
The rules, and the four traps the gates had to be widened for, are `CLAUDE.md`
§24.
