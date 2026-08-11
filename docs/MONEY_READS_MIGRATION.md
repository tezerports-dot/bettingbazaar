# Moving money-domain READS onto PostgreSQL

**Goal:** the money paths stop depending on MongoDB. Chat, support, CMS, the
user profile and the other ~30 non-money domains stay in Mongo permanently, as
`schema.sql` line 5 has always said.

**This is not Phase C.** Phase C is removing MongoDB, and it is a different,
much larger project — see the scope note at the bottom.

---

## The state this starts from

Writes were routed domain by domain and all eleven paths are cutover-eligible.
Reads were left on the Mongo document, which the reverse mirror keeps current.
`walletAuthority.getBalances` says so at its definition:

> *Balance reads are scattered across the codebase as direct
> `user.depositBalance` property access, which silently keeps reading MongoDB
> whatever the switch says. Call sites move here incrementally.*

Measured 2026-08-11 over all 360 tracked JS files:

| | |
|---|---|
| money-model read calls in non-test source | **400** across 61 files |
| direct balance-property reads | **160** across 22 files |
| …of those, in the Postgres reader or the seam itself | ~50 |
| **real conversion target** | **~70 reads, ~10 files** |

Model name is not the filter — a `User.findById` for a username is not a money
read. What matters is whether a *money field* gates a decision.

## Why reads can be converted incrementally when writes could not

Routing a write half-way splits the lifecycle: some transitions authoritative in
one store, some in the other, which no reconciliation can tell apart from the
two stores genuinely disagreeing. That is why ORDERS and BETS each had to land
as one seam.

**Reads are monotonic.** A routed reader returns the Mongo value while Mongo owns
the path and the Postgres value after a flip, so a converted site behaves
identically today and correctly later. A half-converted read surface is strictly
better than an unconverted one — every converted site agrees with whichever
store is authoritative.

**That property depends entirely on the reader checking the resolver.**
`getMerchantTokenBalance` did not, and read Postgres unconditionally. Converting
a gate to it would have refused assignments on a mirror that may be stale or,
for a merchant predating the mirror, absent. **Before converting any call site,
verify its reader consults `isPostgresAuthoritative`.** A reader that ignores it
is the false-authority failure one layer down.

## Classify by consequence, not by model

| Class | A stale read means | Priority |
|---|---|---|
| **Gates a money decision** | wrong routing, wrong authorisation | convert first |
| **Displays money** | a number briefly out of date | convert second |
| **Non-money field on a money model** | nothing | leave in Mongo |

## Order of work

1. ~~**Merchant inventory eligibility**~~ — **done 2026-08-11.** Three gates in
   `merchant.assignment.routes.js` decide whether an order may be handed to a
   merchant; the registry names the consequence: *"a stale read can only
   misroute an order, never move money wrongly."* Misrouting is the failure.
   `getMerchantTokenBalance` was made authority-aware in the same change.
2. **Pre-bet balance check** — `bet.routes.js` (~16 reads). Reads the user's
   pockets to build the funding plan before placing. The debit itself refuses
   transactionally, so a stale read misprices the split rather than overspending
   — but it can produce a plan the authoritative store then rejects.
3. **Merchant scoring** — `merchantScoring.service.js`. **Has a design question
   this list does not answer:** line 112 is a Mongo *query filter*
   (`baseQuery.tokenBalance = { $gte: tokenAmount }`), not a read. Routing it
   means either querying Postgres for eligible ids and passing them into the
   Mongo query, or fetching candidates and filtering in memory. Decide before
   coding; both change the query's cost profile.
4. **Payment processing** — `paymentProcessing.service.js` (~10).
5. **User-facing balance display** — `user.routes.js`, `routes.js`,
   `realtimeEmitters.js`. Cosmetic staleness; convert once the gates are done.
6. **Admin/analytics** — `admin.service.js`, `analytics.admin.routes.js`,
   `reporting.service.js`. Largest count, lowest consequence. These are derived
   reporting over mirrors, and some are genuinely better served by Mongo
   aggregation. Decide per report rather than converting wholesale.

## Rules

- **Never convert a call site to a reader that does not check the resolver.**
  Fix the reader first. This is the one that already bit.
- **Report the number you gated on.** A refusal message quoting the mirror while
  gating on Postgres sends an operator chasing a discrepancy that is not there.
- **Watch the units.** Postgres is integer paise, Mongo is float rupees, and the
  comparisons are against rupee fields. A reader returning paise makes every
  balance look 100× larger and every gate pass — invisible until inventory runs
  out. There is a test for exactly this.
- **Mutation-test each conversion.** Both directions: the reader ignoring the
  resolver, and the call site going back to the document.

## Scope note: this is not "remove MongoDB"

| | |
|---|---|
| Mongoose models in the application | **52** |
| Postgres tables backing them | **23**, all money |

Postgres has no table for `User`, `SystemConfig`, `Cycle`, `Game`,
`Notification`, `SupportTicket`, `ChatMessage`, `Branding`, `GiftCode`,
`AuditLog`, `LeaderboardCache` and roughly twenty more. Removing MongoDB means
designing ~30 schemas and porting every read and write for domains that have
nothing to do with money — re-platforming the application, not finishing the
migration.

What this document describes is achievable and bounded: **the money paths stop
depending on Mongo.** Mongo keeps everything the schema always said it would.
