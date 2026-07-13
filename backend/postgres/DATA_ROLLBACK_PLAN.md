# Hybrid-DB Data Rollback Plan (plan step 6 — required deliverable) — 2026-07-13

Distinct from `tools/rollback.sh` (a CODE checkpoint script): this is how we
fall back **without losing money data** if the Postgres adoption goes wrong at
any phase. Test the relevant drill on staging before that phase touches
production.

## Phase A — dual-write live, Mongo still write-first + read path (TODAY's code)
Postgres is a mirror; Mongo remains authoritative for reads and the app's
behavior. Rollback is trivial and lossless:
1. Unset `DATABASE_URL` (or leave it — mirrors are fire-safe either way).
2. Nothing else changes; no data was ever only-in-Postgres.
3. Re-adoption later: `npm run reconcile:pg -- --all --backfill` restores the
   mirror from Mongo, which never stopped being complete.
**Drill:** unset the env on staging mid-traffic; verify zero user impact;
re-enable; run backfill; run reconcile → exit 0.

## Phase B — cutover window (Postgres authoritative for a path, Mongo mirrored)
The cutover flips a path's READS (and conflict resolution) to Postgres while
keeping a reverse-mirror into Mongo (the dual-write inverts: PG-first, Mongo
mirror). The plan's rule holds: at most ONE store is ever a place a write can
originate from per path.
Rollback (falling back to Mongo-as-truth) without losing the PG-window writes:
1. Freeze the path (maintenance mode) — bounded seconds, not minutes.
2. Run the reverse reconcile for the window: every PG row since cutover-start
   missing in Mongo is written back (the mirrors are keyed — `tx_id` /
   `idempotency_key` — so replay into Mongo is idempotent against its unique
   indexes; this is the same backfill machinery run in the other direction).
3. Verify: reconcile reports zero missing on BOTH sides for the window; the
   Mongo trial balance (`getTrialBalance`) equals the PG trial balance.
4. Flip the path's reads back to Mongo; unfreeze; Postgres returns to mirror
   status. Root-cause before re-attempting cutover.
**RPO for this rollback: zero** — both stores hold every write because
dual-write never stopped in either direction during the window.

## Phase C — steady state (Mongo write path removed for money tables)
Mongo is a read-only downstream mirror (kept for reporting) or dropped for
these tables. Falling back now = restoring a service, not flipping a flag:
1. Postgres PITR (WAL) restores the money tables to the desired moment.
2. If Mongo mirrors were kept: they remain a warm read copy for the app while
   PG restores (read-only degradation, no money writes accepted).
3. Full drill required on staging BEFORE any path enters Phase C — this is the
   plan's precondition for step 5, not an afterthought.

## Invariants that make all of this safe
- Every mirror is **idempotent by key** — replays in either direction cannot
  double-write (unique `tx_id` / `idempotency_key` / `mongo_id` + Mongo's own
  unique indexes).
- The ledger is **append-only in both stores** (Mongo middleware; PG triggers)
  — rollbacks never rewrite history, only re-copy missing rows.
- `npm run reconcile:pg` is the single trust gate; a phase transition requires
  it passing repeatedly (plan step 5's precondition), and it is runnable on
  demand forever — this layer is permanent architecture, not scaffolding.
