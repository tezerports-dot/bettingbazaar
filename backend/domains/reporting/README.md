# domains/reporting/ — REPORTING PLATFORM (BBEPS Phase 012)

Enterprise Services tier. Read-only reports DERIVED from the authoritative
records — stores nothing, mutates nothing, re-computes no business math.

| Report | Endpoint | Source of truth |
|---|---|---|
| Financial (per-account movement + per-event-type totals) | GET /api/admin/reports/financial | Settlement ledger (AccountingEvent) |
| Settlement (daily activity) | GET /api/admin/reports/settlement | Settlement ledger |
| Merchant (funding volume + bonuses per merchant) | GET /api/admin/reports/merchants | PaymentOrders + bonus ledger events |
| Regulatory export (one CSV row per journal posting) | GET /api/admin/reports/ledger-export?format=csv | Settlement ledger |

Treasury reporting lives on the Operations overview (derived account
balances); deeper treasury reports slot here as the Treasury Platform
(Enterprise Services tier) fills out.
