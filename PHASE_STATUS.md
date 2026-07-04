# Phase Status — Canonical Project State

**This file, not conversation history, is the source of truth for project state.**
Update it after every significant change. If this file and a chat summary disagree,
this file wins — that's the point of it existing.

Last updated: 2026-07-03

---

## BBEPS Phase Status

| Phase | Status | Evidence |
|---|---|---|
| 0 — Repository Baseline Assessment | Locked | audit/PHASE0_BASELINE_AND_FINDINGS.md |
| 002 — Capability Inventory | Locked (one open caveat) | Capability table in Phase 0 doc; "no orphaned functionality" being closed incrementally as each domain migration traces its own files |
| 003 — Domain Discovery & Bounded Contexts | Substantively complete | 13 domains with real code have enforced bounded contexts |
| 004 — Target Enterprise Architecture | Decision locked, execution complete for existing code | backend/domains/ + backend/shared/ inside the existing app |
| 005 — Technology Strategy | Corrected 2026-07-03 | Originally under-scoped (language choice only). Now includes real research: Provider/Adapter pattern and Policy/Rules-Engine pattern both confirmed as standard, industry-proven fits for this platform. See FUTURE_CAPABILITIES.md architecture decision. |
| 006 — Configuration Engine / Business Policy Platform | Data model done, platform not built | domains/configuration/ holds SystemConfig/TokenRates. Renamed in direction (not yet in code) to Business Policy Platform per 2026-07-03 decision — same underlying phase, wider scope. THIS IS THE CURRENT ACTIVE PHASE. |
| 007 — Enterprise Control Center / Operations Platform | Not started | Confirmed as orchestration-only, does not own data (2026-07-03) |
| 008 — Financial Core (ledger-first) | Not started | Wallet has correct single-writer authority; not the same as ledger-event-sourcing |
| 009 — Workflow Engine | Not started | — |
| 010 — Event Architecture | Not started | eventBus.service.js exists, zero importers |
| 011 — Algorithm Registry | Not started | Merchant scoring has real docs post-bugfix; reinforced (not replaced) by the platform-architecture decision |
| 012 — Business Process Catalog | Not started | — |

---

## Domain Migration Status

**Migrated (13):** Merchant, Payment, Configuration, Wallet, Betting, Game, Identity,
User, Disputes, Analytics, Notification, CMS, Settlement (partial by design — see
domains/settlement/README.md)

**Not domains — recorded as Platform capabilities, not fake placeholders:**
Communication, Risk, Provider, Business Policy (expanded), Algorithm Registry,
Operations Platform, Agent/Reseller Hierarchy — see FUTURE_CAPABILITIES.md for the
full architecture decision and reasoning.

---

## Known Open Items

1. Merchant `maxConcurrentOrders` data backfill — code fix confirmed live;
   production backfill confirmation was never closed out.
2. `PaymentGatewayConfig` (backend/models/payment.model.js) — confirmed intentional
   future third-party gateway scaffolding, not a bug, not yet wired in.
3. No MongoDB transactions in the settlement flow — correctness relies on
   idempotency keys, not atomicity. Documented, not changed.
4. `backend/debug-merchant-query.mjs` and `check-merchants.mjs` — stray debug
   scripts, not imported anywhere, safe to delete, not yet removed.
5. Phase 002 "no orphaned functionality" — verified at capability level only.

---

## Current Active Phase

**Business Policy Platform** (BBEPS Phase 006, renamed/widened per 2026-07-03
decision). Goal: no business constant remains hardcoded in a service when
configuration is appropriate — merchant commission, reserve ratio, deposit split,
withdrawal rules, USDT rate, algorithm parameters, betting limits, KYC policy, risk
thresholds, feature toggles, notification templates, and more, admin-editable with
validation, defaults, examples, and audit history.

**Foundation built (2026-07-03):** `domains/configuration/configVersion.model.js`
and `configVersioning.service.js` — per-field versioning with immediate/scheduled/
approval-gated writes, rollback that creates new history rather than deleting old,
and a scheduled-apply function ready to wire into `cronJobs.js`. Verified with a
control-flow mock test (no live DB available in this environment — `mongodb-memory-
server`'s binary download is blocked by the sandbox's network allowlist, same
constraint as live DB access) covering all three write paths: immediate apply,
future-dated scheduling, and approval-gated holds — each confirmed to leave the live
config untouched until its condition is met, and to produce a genuinely distinct
status from the others (a real design gap — conflating "pending approval" with
"scheduled" — was caught and fixed during this build, not shipped).

**Not yet done, explicitly out of scope for this piece:**
- No admin route/API exposes this service yet — it's the write-path infrastructure, not a feature.
- No existing config writes were retrofitted to use it (the Merchant Pool's direct `SystemConfig.findOneAndUpdate` still bypasses this) — that's a deliberate, separate decision per the service's own scope note, not silently changed.
- `applyScheduledConfigChanges()` is not wired into `cronJobs.js` yet.

**Next concrete step:** build the first real admin-facing config field on top of
this (a genuine BBEPS §6.14 "Simulation Mode" candidate would be the reserve ratio
or deposit split, since those have the clearest before/after financial impact to
show an admin), verified end-to-end, before building more of the platform on an
unproven foundation.
