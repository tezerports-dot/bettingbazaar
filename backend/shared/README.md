# backend/shared/ — Platform Modules

Cross-cutting code that no single domain owns. Per BBEPS Phase 004 §4.6 "Shared Code
Policy": only generic, non-business-specific code belongs here. Business logic (deposit
rules, merchant rules, wallet rules) belongs in its owning domain, never here.

All folders below are **PLACEHOLDER** — structure only, nothing has been moved into them
yet. They exist so future migrations have a defined target instead of inventing a new
location each time.

| Folder | Intended purpose | Existing candidates (not yet moved) |
|---|---|---|
| `algorithms/` | The Algorithm Registry *mechanism* itself (BBEPS Phase 011) — versioning/documentation scaffolding for algorithms. NOT where domain-specific algorithms live — e.g. the merchant scoring algorithm stays in `domains/merchant/`, since BBEPS Phase 003 assigns it to the Merchant domain. This folder is for the cross-cutting registry pattern only, once one exists. | none yet |
| `workflows/` | Future Workflow Engine / state-machine definitions (BBEPS Phase 009). | none — workflows are currently implicit in route handler code |
| `policies/` | Cross-domain validation-rule *definitions* (e.g. "a percentage field must be 0–100"), distinct from the Configuration domain's stored *values*. | none yet |
| `events/` | Domain event bus (BBEPS Phase 010). | `services/eventBus.service.js` exists but has zero importers today — confirmed dead scaffolding from an earlier migration phase, not yet wired to anything. Candidate for this folder once actually used. |
| `validation/` | Generic input-validation helpers. | not yet audited for existing candidates |
| `infrastructure/` | Storage/cache/DB client wrappers not owned by any domain. | not yet audited for existing candidates |
| `security/` | Encryption, HMAC, rate-limiting helpers used across domains. | `middleware/security.js`, `middleware/order-crypto-access.js` are candidates but are also used by non-Merchant/Payment code — moving them is out of scope for this migration |
| `utilities/` | Generic helpers with no business meaning. | not yet audited for existing candidates |

Nothing has been moved into `shared/` in this migration. Populating it is future work,
done the same way as domain migrations: one module at a time, dependency-mapped first,
moved and verified as its own commit.
