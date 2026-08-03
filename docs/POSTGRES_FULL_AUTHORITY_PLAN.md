# PostgreSQL full financial authority — migration plan

**Status: `POSTGRES_FULL_FINANCIAL_AUTHORITY = NOT READY`** — 1 of 10 paths
implemented. Current state per path: `docs/FINANCIAL_DOMAIN_MATRIX.md`.

This is a financial migration, not an environment-variable change. Scope is
**months**, not a release. This document sequences it and records what is done.

---

## Done: the false-authority gate (§1)

The one part that had to land before anything else, because it makes every
later step safe to do incrementally.

**The problem.** `moneyAuthority.js` declared four paths; only `wallet` had an
implementation. `MONEY_AUTHORITY_LEDGER=postgres` was accepted, passed the
coherence check, and changed nothing — while the config, the boot log and the
`bb_money_authority_postgres` gauge all reported a cutover that had not
happened. Five other money paths (merchant wallet, merchant settlement, admin
issuance, bets, settlements, bonuses) were not modelled at all, so their absence
was invisible.

**What now exists** in `backend/postgres/moneyAuthority.js`:

- A **capability registry**: per path, `implemented` / `dualWrite` /
  `reconciled` / `rollback`, with notes and the derived `cutoverEligible`.
- **All 10 money paths declared**, including the six that were missing.
- `authorityFor()` **returns `mongo` for an ineligible path** regardless of
  configuration — fails safe for scripts, workers and anything that skips boot
  validation.
- `validateAuthorityConfig()` makes a production boot **refuse to start** with
  the specific missing capabilities named.
- `authorityMatrix()` exposes capability alongside `effective`, so health and
  metrics report where money *actually* lives.
- `fullFinancialAuthorityStatus()` returns the READY/NOT READY verdict.

**Evidence** (`5efa7fd`+): 448 unit tests pass, including 11 new authority
tests. Boot verified twice — `MONEY_AUTHORITY_LEDGER=postgres` exits 1 with
`'ledger' is NOT eligible for cutover — missing: implemented`; the eligible
`wallet` path still boots and flips.

**Residual risk.** The registry is hand-maintained. A `true` set without the
backing code would restore the exact hazard this removes. Treat a capability
flag change as a money change: it needs the reviewer to see the reader, the
writer, the reconciliation query and the rollback path.

---

## Sequencing — and one decision needed

The brief proposes: ledger → merchant wallet → orders → bets → bonuses →
**user wallet last**.

The existing `dependsOn` graph says the opposite: **wallet first**, because
ledger/orders/kyc are derived from balances and cannot be authoritative while
balances are not.

**Both are defensible and they conflict.** Wallet-last is safer in that the
highest-traffic path moves once everything else is proven. Wallet-first is what
the code encodes, and what the one implemented path was built for.

I have **not** silently resequenced the graph — inverting it changes validation
for the only currently-eligible path, and that is a decision, not a refactor.
The paths added here follow the existing numbering.

**Recommendation:** keep wallet-first. The dependency argument is real — a
ledger entry that describes a balance change must be written by whoever owns the
balance, or a single settlement spans two sources of truth. If you prefer
wallet-last, the ledger must first be made independent of balance ownership
(entries carrying their own before/after rather than deriving them), which is
additional design work, not a reordering.

## Per-domain sequence

For each domain, in order. Do not start step *n+1* before *n* is evidenced.

1. **Contract and invariants** — what must be true after every operation.
2. **Schema + implementation** — integer smallest units; balance and ledger in
   one transaction; idempotency key unique-indexed.
3. **Regression and concurrency tests** against real PostgreSQL.
4. **Dual-write** with durable failure recording (not `.catch(() => {})` —
   see M-3).
5. **Backfill** historical data.
6. **Continuous reconciliation** proving agreement.
7. **Shadow reads** — read both, serve Mongo, count mismatches.
8. **Cut over reads.**
9. **Cut over writes** — flip the capability flag, then the env var.
10. **Keep reverse mirror** for the observation period.
11. **Remove Mongo authority** only after that period is clean.

## Remaining work, largest first

| Domain | Why it is next | Rough shape |
|---|---|---|
| **Financial ledger foundation** | Everything else posts to it | Constraints so malformed entries cannot insert; conservation triggers already exist |
| **Merchant wallet** | Largest gap; blocks any real authority claim | Port the reserve→move→complete shape from `merchantWallet.service.js`, not `_mongoBetStake`'s |
| **Payment orders** | State machine + out-of-order provider callbacks | Expected-previous-state transitions; immutable history; ledger in the same transaction |
| **Bets + stake reservation** | Must fix M-2/M-4 in the design | Idempotency key from stable request identity; lifecycle states enforced by constraint |
| **Bonuses and commissions** | Depends on ledger + wallet | — |
| **User wallet cutover** | Already implemented; gated on reconciliation | Flip last per the recommendation above |

## Cutover gate

Full authority may be enabled only when **all** hold:

- [ ] Every financial path has a real PostgreSQL implementation
- [ ] All financial call sites route through the authority resolver
- [ ] All concurrency suites pass
- [ ] Infrastructure resilience certification passes
- [ ] Continuous reconciliation reports zero unexplained mismatches
- [ ] Backup restoration rehearsed
- [ ] Rollback rehearsed
- [ ] Multi-instance load testing passes
- [ ] Monitoring and alerts active
- [ ] The registry reports every path `cutoverEligible`

Until then the status stays `NOT READY`, and the code makes it impossible to
claim otherwise through configuration.

## Related

- `docs/FINANCIAL_DOMAIN_MATRIX.md` — current per-path state
- `docs/MONGO_MONEY_AUDIT.md` — M-1 fixed, M-2/M-4 open, both due in the bets port
- `docs/CONCURRENCY_CERTIFICATION.md` — what is proven, what needs staging
- `docs/PRODUCTION_ARCHITECTURE.md` — why the wallet flip waits until after launch
