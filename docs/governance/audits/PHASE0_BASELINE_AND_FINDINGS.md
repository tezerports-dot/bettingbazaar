# Phase 0 — Repository Baseline Assessment (Real Evidence)

**Authority chain (per your direction):** BBEPS (Phases 0–012) is now the constitutional
authority for this repository, superseding `docs/governance/04-GOVERNANCE.md` where they conflict.
`docs/governance/04-GOVERNANCE.md` is NOT deleted — it is retained as the implementation-level ruleset
that enforces BBEPS against this specific 316-file repo (see §3, "middle road").

**Method:** every claim below was checked against the actual uploaded repo
(`betting-bazaar-main`), not the spec's hypothetical inventory. Verification command included
per finding so you can re-run it in your Codespace.

---

## 1. Repository reality vs. BBEPS hypothesis

BBEPS Phase 0.3–0.5 was written generically (it doesn't know this codebase). Three of its
example assumptions don't hold here and are corrected below so they don't get acted on later:

| BBEPS assumption | Reality | Evidence |
|---|---|---|
| "Queue Manager removed by business, AI renamed it, queue remained conceptually alive" | **True, confirmed** — not hypothetical | `backend/routes/admin/queue.admin.routes.js` (manual `/queue/assign/:orderId`, role `isAdminOrSubAdminOrQueueManager`) ships *alongside* `merchantScoring.service.js` (the real auto-assignment algorithm). Frontend has a live `admin-panel/src/Pages/QueueManager/QueueDashboard.tsx`. |
| "Legacy Token Rate logic no longer reflects the business model" (Phase 2.4, listed as REMOVE candidate) | **False — Token Rate is a live, intentional business mechanic**, not legacy | `docs/governance/04-GOVERNANCE.md` §1 names `TokenRates` model as the sole authority for buy/sell rates and states "Merchant earnings model: Buy/sell spread only. `Merchant.commissionRate` is retired." The spread *is* the commission model. Do not remove `TokenRates`. |
| Domain model assumes a sportsbook (Leagues/Fixtures/Odds feeds) | **Partially false** — core product is a proprietary cycle/crash prediction game | `backend/gameEngine.js`, `backend/services/cycleGenerator.service.js`, `backend/models/cycle.model.js`, `GAME_CORE.ts`. `SportsPage.tsx` exists but is peripheral, not the core loop. BBEPS's "Betting/Sports Domain" needs a sibling **Game/Cycle Domain** that isn't in the spec's generic list — see §2. |

---

## 2. Capability classification (BBEPS §2.3/§2.4 matrix, applied to real files)

| Capability | BBEPS class | Real status | Evidence |
|---|---|---|---|
| Identity & Access | KEEP | Exists, single `auth.middleware.js`, JWT per panel | `backend/middleware/auth.middleware.js`, `models/auth.model.js` |
| User Management | KEEP | Exists | `models/user.model.js`, `routes/user.routes.js` |
| Wallet | KEEP, redesign | Exists, single-writer already enforced | GOVERNANCE §7: `walletAuthority.service.js` is sole write path — **this is already BBEPS Phase 008 §8.5 "Wallet as Projection" in spirit**, just not ledger-event-sourced yet |
| Payments | KEEP, redesign | Mid-migration | `paymentProcessing.service.js`, `paymentOrder.model.js`, P2P→Merchant migration 41/41 steps applied (`tools/.migration-state.json`) |
| Merchant Operations | **REDESIGN, in progress, one open drift item** | Auto-assignment (`merchantScoring.service.js`) is live; legacy manual queue path still parallel | See Finding F2 below |
| **Game/Cycle (not in BBEPS generic list)** | **NEW classification needed** | Core product loop | `gameEngine.js`, `cycleGenerator.service.js`, `cycle.model.js` |
| Betting | KEEP | Exists | `models/bet.model.js`, `routes/bet.routes.js` |
| Sports | EXPAND | Minimal — single page, no provider/odds-feed abstraction | `pages/SportsPage.tsx` only |
| Settlement | KEEP | Folded into `gameEngine.js` cycle resolution + `walletAuthority.service.js`, not yet isolated | — |
| Disputes | KEEP | Exists, already isolated per GOVERNANCE (`Dispute` model removed, resolution embedded in `PaymentOrder`) | `routes/admin/disputeResolution.admin.routes.js` |
| Support | KEEP | Minimal | — |
| Notifications | REDESIGN | Exists but scattered | `realtimeEmitters.js`, `sseManager.service.js`, `notification.model.js` |
| CMS | KEEP | Exists | `content.service.js`, `content.model.js`, `Branding` |
| Analytics | EXPAND | Exists, single route file | `routes/admin/analytics.admin.routes.js` |
| Configuration | **NEW domain, partially present** | `systemConfig.model.js` + `TokenRates` already centralize most financial policy | GOVERNANCE §5 already assigns config ownership — BBEPS Phase 006 mostly just formalizes what's there |
| Risk & Fraud | **NEW — not built** | Only a duplicate-UTR check exists, no scoring | `models/utrRegistry.model.js` |
| Telegram | **NEW — not built** | Field-level references only (a social link), no bot/mini-app | `systemConfig.model.js` (`supportLinks`) |

**Reading:** this is not a system that needs to be rebuilt. It's a system where ~12 of 16
BBEPS capabilities already exist and are reasonably owned. The honest gap is: one piece of
architectural drift (Merchant/Queue), two genuinely unbuilt domains (Risk, Telegram — both
explicitly "NEW" in BBEPS too, so no drift there), and a domain the spec didn't anticipate
(Game/Cycle).

---

## 3. Architecture decision: the "middle road"

Per your instruction, this does **not** mean creating `domains/`, `platform/`,
`infrastructure/` top-level folders and moving 316 files into them. That would be a parallel
architecture during the move (explicitly forbidden by the Lead Architect doc) and is not
justified by the actual gap found in §2.

**Decision:** BBEPS's domain-ownership *rules* are adopted immediately and fully (one owner
per capability, no direct cross-domain writes, no hardcoded business policy, every algorithm
versioned and documented). They are enforced **on the existing folder structure**
(`backend/services/*.service.js` = domain service, `backend/models/*.model.js` = domain
aggregate, `backend/routes/**` = domain API), not on a new tree. `docs/governance/04-GOVERNANCE.md` will be
revised (not deleted) to state explicitly that it implements BBEPS Phases 006/009/010/011
(Configuration, Workflow, Event, Algorithm governance) for this repo, and that BBEPS is the
senior document where the two ever disagree. I'll deliver that revision once you confirm
direction on this audit — flagging it now rather than silently rewriting your binding doc.

A literal `domains/` directory split becomes worth doing later **only if/when** a capability
needs independent deployment (BBEPS §4.9 already says this is "where practical," not
mandatory). Nothing in the current evidence justifies it today.

---

## 4. Critical findings

### F1 — Merchant approval → ACTIVE: code-level fix already present, unverified in production

**Status: NOT a current code bug.** Tracing the full path:

- `backend/routes/merchant.routes.js:102` — self-registration correctly creates the merchant
  at `status: 'PENDING'` (correct — unapproved merchants should not be assignable).
- `backend/routes/admin/merchants.admin.routes.js:252-268` — the approve endpoint
  (`PUT /api/admin/merchants/:merchantId/approve`) sets `status: 'ACTIVE'` **and**
  `merchantApprovalStatus: 'APPROVED'` in the same `findByIdAndUpdate`, tagged
  `// FIX B6-a: also update Merchant.status to 'ACTIVE'` — already fixed in a prior session.
- `admin-panel/src/services/api.ts:227` calls the matching endpoint — frontend/backend
  contract is correct.
- `backend/migrations/002-fix-everything.js` is a one-time backfill marked
  `MIGRATION STATUS: APPLIED — do not re-run`, which already corrected any historically
  stuck records (`status: 'ACTIVE', merchantApprovalStatus: 'APPROVED'` together).

**What's actually unverified:** whether `002-fix-everything.js` was run against the live
the deployed database, or only locally/staging. If it wasn't, stuck merchants could still exist in
production data even though the code path is now correct. I've written a read-only check —
`audit/verify-merchant-status-integrity.mjs` — run it against Railway to confirm. It makes
no writes.

```bash
# from repo root, with DATABASE_URL pointed at the deployed database
node audit/verify-merchant-status-integrity.mjs
```

If it reports zero mismatches, F1 is closed — no code change needed, and
`backend/migrations/002-fix-everything.js` can be deleted per GOVERNANCE §13 (Dead Artifact
Policy: applied migrations get deleted once confirmed). If it reports mismatches, that's a
one-line data fix (not a code fix), and I'll generate it from the script's actual output
rather than guessing.

### F2 — Legacy Queue Manager parallels the Merchant Assignment Algorithm

**Status: confirmed architectural drift**, matching BBEPS Phase 0 Risk A exactly.

`backend/routes/admin/queue.admin.routes.js` exposes manual assignment endpoints
(`/queue/assign/:orderId`, `/payment-orders/:id/assign`, `/payment-orders/:id/reassign`) gated
by a `QueueManager` role, fully independent of `merchantScoring.service.js`'s automated
selection. The frontend ships a dedicated `QueueManager/QueueDashboard.tsx` page.

BBEPS Phase 008 §8.11 says "There is no queue manager" as the *default* assignment path — but
Phase 007 §7.4 (Merchant Operations Workspace) explicitly keeps an "Exception Queue / Manual
Override" as a legitimate feature for when the algorithm can't assign. Those aren't
contradictory once you read both: **automatic assignment is the default and only path;
manual queue becomes the explicitly-scoped fallback for algorithm failures or admin
override, not a parallel everyday mechanism.**

Proposed reclassification (not deletion):
1. `queue.admin.routes.js` → rename conceptually to "Merchant Assignment Exception Handler,"
   owned by the Merchant domain (no separate Queue concept).
2. Gate every manual-assign endpoint so it only fires when `merchantScoring.service.js`
   returns `null` (no eligible merchant) or an admin explicitly overrides with a logged
   reason — not as a routine alternative.
3. Rename `QueueDashboard.tsx` → reflect "Exception Queue," update nav label.
4. Audit-log every manual assignment distinctly from algorithmic ones (BBEPS §11.12
   "Explainable Decisions" — manual overrides need their own audit trail entry).

This is a real, scoped piece of work — I have not implemented it yet pending your go-ahead,
since it touches a live admin role and two endpoints with write access to payment orders.

### F3 — Dead migration artifacts (safe to remove, verified)

Confirmed via `diff` and `grep` (commands below) — nothing in the live app imports these:

- `migration-files/` (10 files) — byte-identical to, or superseded by, what's already live in
  `backend/`. This was the staging source for `tools/domain_migration.py`, already fully
  applied (41/41 steps, `tools/.migration-state.json`).
- `payment-migration.zip`, `payment-migration.patch` (repo root) — same migration, archived
  forms. Not referenced anywhere.
- `backend/migrations/002-fix-everything.js` — self-marked APPLIED, pending F1's production
  verification before deletion (see above).

```bash
# verification commands (already run, included for your re-check)
grep -rn "migration-files" --include="*.js" --include="*.ts" --include="*.tsx" . | grep -v "^./migration-files\|node_modules\|migration-state\|migration-report"
grep -rln "payment-migration" --include="*.js" --include="*.sh" --include="*.json" . | grep -v node_modules
```

Both return empty. Cleanup script: `audit/cleanup-dead-artifacts.sh` (dry-run by default).

### F4 — `docs/governance/04-GOVERNANCE.md` predates this audit's authority decision

Its header currently says it's binding and supersedes `ARCHITECTURE.md`. It doesn't yet say
anything about BBEPS. Leaving that unstated risks a future session treating it as the top
authority again. I'm flagging this rather than silently editing your governance doc — say the
word and I'll patch the header to reflect the chain in §3.

---

## 5. What this audit covers vs. what's queued

Covered now, with real evidence: Architecture Inventory (§1-2), Domain Inventory (§2), Legacy
Feature Report (F2), Hardcoded Business Rule spot-check (Token Rate correction, §1),
Duplicate Logic check on migration-files vs backend (F3), Dead Code (F3, F4).

Not yet done, queued in this order once F1–F4 are resolved: full Hardcoded Business Rule
Report (every numeric literal in `backend/routes/**`, not just the ones I hit incidentally),
Circular Dependency Report (needs `madge` run against `backend/`), Workflow Inventory
(formalize Deposit/Withdrawal/Merchant/Bet state machines against BBEPS Phase 009 templates),
Event Inventory (catalog what `eventBus.service.js` actually publishes today vs BBEPS Phase
010's contract), Algorithm Inventory (formalize `merchantScoring.service.js` as `ALG-MER-001`
per Phase 011), Configuration Smell Report (find any business value not yet in
`SystemConfig`/`TokenRates`).

I didn't pad these out with placeholder content — each needs real grep/code work I haven't
done yet, and you said no TODOs presented as done.