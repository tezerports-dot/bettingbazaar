# Governance documentation

**Rules are not here.** Every binding rule in this repository lives in one file:
`CLAUDE.md` at the repository root. This folder holds policy and operational
reference that supports those rules.

Two files that used to live here are gone, on 2026-09-09:

- `04-GOVERNANCE.md` — its rules merged into `CLAUDE.md`; its reference material
  and history moved to `docs/reference/` (see the map below). It was a second
  rule file with overlapping authority, and it had drifted: its ownership table
  still named modules that had been deleted.
- `LAUNCH_READINESS.md` — its engineering claims had gone stale (it described the
  platform as it was before the cash and USDT rails existed). Its durable
  content — the compliance gate, the load test, the PITR rehearsal — is in
  `docs/PROJECT_STATUS.md` with the rest of the open work.

## Where things are

| What you want | Where |
|---|---|
| **Any rule** | `CLAUDE.md` (repository root) |
| What is built, what is left | `docs/PROJECT_STATUS.md` |
| Why a decision was made, dated | `docs/reference/DECISION_LOG.md` |
| Realtime event names | `docs/reference/REALTIME_EVENTS.md` |
| Architecture, portability, capabilities | `docs/reference/ARCHITECTURE.md` |
| SLOs, runbooks, on-call | `docs/reference/SRE_AND_OPERATIONS.md` |
| Branding field → consumer | `docs/reference/BRANDING.md` |
| Machine-checked capabilities | `platform/capabilities.yaml` (`npm run verify:capabilities`) |

## This folder

| File | Purpose |
|---|---|
| `FULL_STACK_AND_CLIENT_DELIVERY.md` | The whole stack in one page, all three panels side by side, and the website / PWA / Android delivery matrix per panel. |
| `ENV.md` | Mandatory and optional environment variables — what to set before boot. |
| `AUTHORIZATION_MATRIX.md` | Role, permission and access-control reference. |
| `DISASTER_RECOVERY.md` | Backup, restore and incident recovery. |
| `RETENTION_POLICY.md` | Data retention and deletion policy. |
| `RATE_LIMITS.md` | Rate-limit tiers and their reasoning. |
| `LATENCY.md` | Latency budgets. |
| `GAME_REGISTRY.md` | Game catalogue governance. |
| `NATIVE_APP_DISTRIBUTION_POLICY.md` | Mobile and native distribution policy, including the jurisdiction analysis. |
| `ANDROID_RELEASE_SETUP.md` | Android signing, release workflow and on-device checks. |
| `SECURITY_CODE_REVIEW_CHECKLIST.md` | Pre-release and PR security review checklist. |
| `audits/PHASE0_BASELINE_AND_FINDINGS.md` | Baseline audit evidence and findings. |

## Where documents belong

- A **rule** goes in `CLAUDE.md`. Nowhere else. If you find a rule stated in
  another file, that file is wrong — move the rule and leave a pointer.
- Reference data and history go in `docs/reference/`.
- Status and open work go in `docs/PROJECT_STATUS.md`, updated in the same
  change that moves the work.
- Policy and operational guidance go here.
- Product and design docs go in `design/` or `docs/design/`.
- Deployment how-to goes in `deploy/`.
- Domain implementation notes stay next to the code, as `backend/domains/*/README.md`.

## Handing work to an outside developer

Share the smallest package that covers the task:

1. `CLAUDE.md`, and this folder.
2. The bounded domain folder they will touch, e.g. `backend/domains/support/`.
3. The contract they integrate with: route file, types, event names, README.
4. A sanitized `.env.example` subset for only the variables their task needs.
5. Test fixtures or API examples — never production secrets or database dumps.
