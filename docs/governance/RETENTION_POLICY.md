# Data Retention Policy (Phase X X-7)

**Goal:** keep the database from growing without bound while **never** losing
financial, audit, or user data. High-volume *operational* records are pruned
after a window; everything money- or identity-related is kept **forever**.

Enforced by `backend/domains/operations/retention.service.js` (a daily,
leader-locked cron worker) and configured by `SystemConfig.retentionMonths`
(default **6**, admin-editable, range 1–120). Runs on demand via
`POST /api/admin/operations/retention/run` (`{dryRun:true}` previews counts;
`{dryRun:false}` deletes).

---

## PRUNED — high-volume operational data (after `retentionMonths`)

| Collection | Eligibility | Why it's safe to delete |
|---|---|---|
| `Bet` | status ∈ {WON, LOST, REFUNDED} **and** older than the window | The money outcome is already in `Transaction` (BET_PLACED/BET_WIN) + `WalletLedger`, and the cycle's net is in the `AccountingEvent` ledger. Individual settled bets are display/history only after that. **PENDING bets are never pruned.** |
| `Cycle` | isSettled = COMPLETED **and** `settledAt` older than the window | Its net result was recorded as a `BET_CYCLE_SETTLED` ledger event within 60s of settling — months before pruning. The reconciler only scans not-yet-recorded cycles, so a pruned one is simply never re-scanned. |
| `FrontendErrorReport` | `ts` older than the window | Pure client-side diagnostic noise. |

**Batched deletes** (5 000/batch) so a large backlog never locks a collection
in one operation.

## KEPT FOREVER — never reachable by the retention worker

Financial, audit, and identity data. These models do **not** appear in the
worker's prunable plan — that is a structural guarantee, not a config choice:

- `AccountingEvent` — the append-only double-entry ledger (immutable by design).
- `WalletLedger`, `MerchantWalletLedger` — per-account money movements.
- `Transaction` — user-facing money history.
- `PaymentOrder` — deposit AND withdrawal records (both are orders; the separate
  `WithdrawalRequest` collection was removed 2026-08-24 with the parallel
  withdrawal system it backed).
- `EnhancedAuditLog`, `AuditLog` — the audit trail.
- `User`, `Merchant`, `CommissionRecord`, policy/config documents.

## Safety rails

- **30-day hard floor:** nothing younger than 30 days is ever deleted, even if
  `retentionMonths` is misconfigured — the floor can only make the window
  *longer*, never shorter.
- **Settled-only:** in-flight records (PENDING bets, non-completed cycles) are
  excluded regardless of age.
- **Leader-locked + idempotent:** one instance prunes per day; re-running finds
  nothing new.
- **Preview first:** the admin endpoint defaults to `dryRun` (count only).

## Future option (not built)

Cold-archive-then-delete: stream pruned operational rows to object storage
(S3-compatible) before deleting, for offline analytics. Deliberately not built
— it needs a storage target decision; the current policy is prune-in-place,
which is what "clear the data that takes too much space" asked for while the
financial system of record stays complete.
