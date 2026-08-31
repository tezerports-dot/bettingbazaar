# Mirrors are scaffolding. This is the demolition plan.

Every financial domain currently grows four moving parts:

```
Mongo ──forward mirror──▶ Postgres ──reverse mirror──▶ Mongo
                  └──────reconciler───────┘
```

Two of those exist only to make a migration survivable. If they are still here
when the migration ends, the platform has **two financial databases forever** —
twice the write paths, twice the failure modes, and a reconciler whose job is to
paper over the fact that neither store is truly authoritative.

That is not the design. It is scaffolding, and scaffolding needs a date.

---

## The end state

| Store | Owns | Never holds |
|---|---|---|
| **PostgreSQL** | balances, ledgers, orders, settlements, treasury, reservations, every idempotency key | — |
| **MongoDB** | documents, KYC records, search, cache, analytics, history, notifications, chat | any number a money decision reads |

The test for "done": **deleting `dualWrite.js` and `reverseMirror.js` changes no
financial behaviour.** Until that is true for a domain, the domain is mid-migration.

## Why this cannot be one flip

The mirrors are what make each domain's cutover *reversible*. Removing them
before a domain has proven itself in production converts a revert (redeploy with
one environment variable) into a restore (backup, PITR, downtime, reconciliation
by hand). The cost of keeping them is complexity; the cost of removing them
early is an outage with no way back. So they come out per domain, on evidence.

## Per-domain demolition, in order

Each step is gated on the one before it. No domain skips ahead.

**1. Cut over.** `MONEY_AUTHORITY_<DOMAIN>=postgres`. Both mirrors still run —
forward stops mattering, reverse becomes load-bearing.

**2. Observe.** The reverse mirror and the reconciler run for a full observation
window with `bb_balance_drift_paise{path} == 0` and
`bb_pg_reconcile_consecutive_clean` climbing without reset. This is the window
in which a fallback is still one redeploy away.

**3. Delete the FORWARD mirror.** Once Postgres owns the writes, the Mongo→PG
direction has nothing left to carry: there are no Mongo-originated money writes
to mirror. Deleting it is the first irreversible step and the cheapest — it
removes a code path that is already dead.

*Gate:* the domain has been on Postgres for the observation window, and the
forward reconciler reports zero rows to backfill.

**4. Stop writing money to Mongo.** The reverse mirror goes. From here a
fallback is a restore, not a revert, so this is the step that needs a rehearsed
backup restoration behind it — not just a green dashboard.

*Gate:* backup restoration rehearsed for this domain's tables, and the
infrastructure drills in `PRODUCTION_CERTIFICATION_CHECKLIST.md` passed.

**5. Drop the Mongo money fields.** `Merchant.tokenBalance`,
`User.depositBalance`, the ledger collections. Reads move to Postgres or to a
projection that is explicitly labelled as non-authoritative.

*Gate:* no code reads the field. Enforced by grep in review, and by the field
being absent from the schema rather than merely unused.

**6. Delete the reconciler for that domain.** There is nothing left to compare.

## What Mongo keeps, and why that is not a compromise

Mongo remains the right store for what it is good at: documents with variable
shape, full-text search, denormalised read models, analytics, history nobody
transacts against. None of that needs ACID guarantees across rows, and none of
it is read by a decision that moves money.

The rule that keeps this honest: **if a number in Mongo can change what a money
operation does, it is authoritative, and it must not be in Mongo.** A displayed
balance is fine. A balance a guard compares against is not.

The merchant wallet is the current live example of the boundary. Its movements
are Postgres-authoritative when flipped, but display, scoring and assignment
eligibility still read the mirrored Mongo document. That is *tolerable* only
because the authoritative check is the debit itself, which refuses
transactionally — a stale read can misroute an order, never move money wrongly.
Step 5 for that domain means moving those reads, not just the writes.

## Cost of not doing this

Concretely, per domain left mid-migration:

- two write paths that can disagree, and a reconciler whose green light is the
  only thing telling you they don't
- a fire-and-forget mirror on every money write — failures are logged and
  alerted, never surfaced to the caller, by design
- every future schema change applied twice, in two shapes, with a mapping
  between them
- an onboarding cost: nobody can answer "where does the money live" with one
  sentence

Eleven domains × that is not a system anyone should operate.

## Tracking

`docs/PRODUCTION_CERTIFICATION_CHECKLIST.md` tracks progress *into* Postgres.
This document tracks progress *out of* Mongo. A domain is finished only when it
appears in both as complete — certified on the way in, demolished on the way out.

**Step 1 is configured for all eleven domains (2026-08-31), and no domain has
gone past it.** The demolition columns are still empty, and saying so is the
point: this plan exists before the mirrors multiply, not after.

What step 1 means here and what it does not:

- The eleven `MONEY_AUTHORITY_*` variables are documented in `.env.example` and
  a full cutover is pinned coherent by `backend/tests/unit/fullPostgresCutover.test.js`
  — every path capability-eligible, no path waiting on a dependency still in
  Mongo, and the whole set validating clean together.
- **Setting them is still a deploy-time act.** Committing the documentation
  does not flip anything; an operator sets them on the server, having run
  `npm run preflight:flip` first.
- **Both mirrors still run.** Forward stops mattering, reverse becomes
  load-bearing, and a fallback remains one redeploy away. That is the whole
  value of stopping at step 1.

Steps 3–6 are deliberately NOT taken, and the reason is not caution about
existing data. This platform is greenfield — `preflightFlip.js` says so itself,
and correctly refuses to demand a clean-migration signal that cannot exist when
both stores are empty. The gate on **step 4** is different in kind: it is a
*rehearsed backup restoration*, because that step converts a fallback from a
redeploy into a restore. Having no data today does not satisfy it — it only
moves the first time you need that restore to the first day you have real
players. Step 4 waits on the drill, not on the calendar.
