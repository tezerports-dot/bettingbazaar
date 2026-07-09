# domains/operations/ — OPERATIONS PLATFORM (BBEPS Phase 012)

Core Enterprise tier. ORCHESTRATION-ONLY — owns NO data (locked 2026-07-03).

| Capability | Where |
|---|---|
| Enterprise dashboard | GET /api/admin/operations/overview — settlement, treasury, funding, risk, policy, merchant, communication, and product-flag monitoring, every number read live from its owning platform |
| Configuration console index | GET /api/admin/operations/config-catalog — every configurable business value + owning authority + edit endpoint. If a value isn't here, it must not exist as a business constant in code (§2/§3) |
| Policy management / merchant ops / monitoring surfaces | The owning platforms' admin routes (deposit-policy, merchant-bonus-policy, revenue, merchant-platform, communication) — Operations aggregates, never duplicates |

The admin-panel UI for these endpoints is Enterprise UI/UX scope
(EXECUTION_QUEUE.md).
