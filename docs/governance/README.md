# Governance Documentation Hub

This folder is the single home for Betting Bazaar governance, enterprise-readiness, operating, and future-migration documentation. Keep governance markdown here so developers, auditors, and contractors can receive policy context without receiving the full source tree.

## Launch-readiness answer

The repository is arranged as a modular monolith with separate user, admin, and merchant panels, a backend domain layer, deployment assets, and centralized governance. That is a strong enterprise-grade shape, but **launch readiness still depends on the open items and production checks tracked in this folder**. Before launch, review:

1. `LAUNCH_READINESS.md` — the top-level "app is ready vs infra/ops you must do" checklist.
2. `04-GOVERNANCE.md` §19 (Capability Matrix) — and `platform/capabilities.yaml` — for implemented capabilities, active gaps, and planned capabilities.
3. `SECURITY_CODE_REVIEW_CHECKLIST.md` for release security review.
4. `DISASTER_RECOVERY.md`, `04-GOVERNANCE.md` §21 (SRE), and `RETENTION_POLICY.md` for operations readiness.

## Folder map

| File | Purpose |
|---|---|
| `04-GOVERNANCE.md` | Binding repository rules + ownership / no-hardcode / no-duplicate rules + event-name authority (§§0–16), **and** the consolidated architecture reference (2026-07-22): Portability (§17), Hybrid Architecture / 1M-DAU plan (§18), Capability Matrix (§19), Enterprise Decision Log (§20), SRE & Operations (§21). |
| `FULL_STACK_AND_CLIENT_DELIVERY.md` | The whole stack in one page (runtimes, domains, datastores, transports, security, CI/deploy), all three panels side by side, and the **website / PWA / Android delivery matrix** per panel — what ships today, what does not, and the complete per-panel feature inventory. |
| `LAUNCH_READINESS.md` | "App is ready" vs "infra/ops you must do" launch checklist. |
| `ENV.md` | Mandatory + optional environment variables — what to set before boot. |
| `AUTHORIZATION_MATRIX.md` | Role/permission and access-control reference. |
| `DISASTER_RECOVERY.md` | Backup, restore, and incident recovery guidance. |
| `RETENTION_POLICY.md` | Data retention and deletion policy. |
| `GAME_REGISTRY.md` | Game catalogue governance and ownership. |
| `NATIVE_APP_DISTRIBUTION_POLICY.md` | Mobile/native app distribution policy. |
| `SECURITY_CODE_REVIEW_CHECKLIST.md` | Pre-release and PR security review checklist. |
| `audits/PHASE0_BASELINE_AND_FINDINGS.md` | Baseline audit evidence and findings. |

## Enterprise-grade arrangement rules

- Governance markdown belongs in `docs/governance/` only.
- Product/design docs belong in `design/` unless they become binding governance.
- Deployment how-to docs belong in `deploy/` unless they become operational policy.
- Domain-specific implementation notes stay near the code they govern, for example `backend/domains/*/README.md`.
- New extracted services must receive their own folder with a small README, API contract, env vars, owners, and deployment notes before code moves out of the monolith.

## Developer handoff without sharing the whole codebase

When outside developers need to add or estimate work, share the smallest package that covers their task:

1. This `docs/governance/` folder.
2. The specific bounded domain folder they will touch, for example `backend/domains/support/`.
3. The public contract they must integrate with: route file, DTO/types, event names, or README.
4. A sanitized `.env.example` subset for only the variables needed by their task.
5. Test fixtures or API examples, never production secrets or full database dumps.

This keeps intellectual property and security exposure lower while still giving developers enough context to work correctly.
