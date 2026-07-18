# Future Capabilities Record

This document exists so unbuilt work is tracked honestly, without fabricating
placeholder architecture (empty domain folders, fake interfaces) that implies
something exists when it doesn't. Per explicit direction: only migrate or scaffold
code that actually exists; record everything else here instead.

## Architecture decision (2026-07-03, approved): Platforms, not narrow domains

For capabilities with a genuine "one contract, many interchangeable implementations"
shape, group them under a Platform umbrella rather than one narrow domain per
implementation. Confirmed against real research, not adopted on faith:

- **Provider/Adapter pattern** is standard in this exact industry — sportsbook
  operators integrate multiple odds providers, payment gateways, and KYC vendors
  through a unified adapter interface, letting providers be swapped without
  rebuilding infrastructure. `backend/providers/{payment,casino,sportsbook}/*.interface.js`
  already exists in this repo as abandoned scaffolding for exactly this — an earlier
  session started this direction and didn't finish it.
- **Policy/Rules Engine pattern** is standard for decoupling business logic from
  code: rules become versioned, testable, business-editable assets rather than
  scattered conditionals. This is what BBEPS Phase 006's Configuration Domain
  already described — Business Policy Platform is the same idea, renamed and
  widened in scope, not a competing architecture.

**Operations Platform is orchestration only — it does not own data.** Confirmed
explicitly (2026-07-03): it presents Configuration/Workflow/Algorithms/Providers/
Finance/Marketing/Analytics/Monitoring/Audit/Security/CMS without owning any of
their underlying state. This is BBEPS Phase 007 (Enterprise Control Center) under
a different name — it does not reopen the "admin owns data" anti-pattern already
rejected when `domains/admin/` was deliberately not created.

**No impact on the 13 already-migrated domains.** Merchant, Payment, Wallet,
Betting, Game, Identity, User, Disputes, Analytics, CMS, Settlement are unaffected
— they're not part of the platform-grouping candidates below. Configuration is the
one exception: it conceptually becomes part of Business Policy Platform, but the
physical folder restructure is its own future migration (same dependency-trace
discipline as every other domain move), not done as part of this planning update.

---

## Communication Platform
Telegram · Live Chat · Public Chat · Notifications · Email · SMS · Broadcast ·
Announcement · Support Messaging · Moderation

**Confirmed state:** `domains/notification/` (SSE push) is the only piece that
exists. Telegram bot/channel management and live public chat are confirmed
requirements (2026-07-02 direction), zero implementation today.

## Risk Platform
Fraud Rules · AML · Merchant Risk · Withdrawal Risk · Device Fingerprint ·
Velocity Rules · Behaviour Analysis · Auto Review · Manual Review · Audit Signals

**Confirmed state:** only a duplicate-UTR check exists (`utrRegistry.model.js`).
BBEPS itself classifies this as a NEW capability, not a migration target.

## Provider Platform
Sportsbook Provider · Casino Provider · Odds Provider · Live Score Provider ·
Fantasy Provider · Virtual Sports · Esports · Trading API

**Confirmed state:** `backend/providers/{payment,casino,sportsbook}/*.interface.js`
+ `registry.js` exist with zero importers — the abandoned scaffolding mentioned
above. `gameProvider.model.js`/`game-providers.routes.js` are third-party
casino/game-provider integrations, not sports fixtures/odds. The actual core
product is the cycle/crash engine (`domains/game/`), not a sportsbook.

## Core Infrastructure Architecture
L4-multiplexed SNI passthrough · End-to-end encryption (E2EE) · Transparent
Proxy Protocol v2 client-IP preservation · Owned-service edge isolation ·
Deployment-topology documentation

**Future edge topology, with backend support available now:** the opt-in backend
PROXY protocol v2 parser and listener integration are already delivered for
trusted deployments that enable them explicitly. The full HAProxy edge
deployment topology remains future, undeployed infrastructure work reserved for
a legally registered software/company workstream serving licensed operators.
The safe target architecture is ordinary Layer-4 stream routing that selects an
owned backend by TLS SNI before application decryption, preserves cryptographic
integrity end-to-end, and forwards true client metadata to trusted downstream
applications via PROXY protocol v2 without modifying encrypted payloads.
No consumer-edge alternative transport is application code today. Any future
edge-networking proposal for a legal software company must be documented as a
licensed, provider-approved, jurisdiction-reviewed infrastructure workstream
with operator sign-off before any implementation is considered.
Future review-gate topics may include owned-domain lifecycle management,
licensed-jurisdiction geo routing, CDN/WAF policy, bot-abuse signals, private
origin/VPC isolation, authenticated edge-to-origin tunnels, state continuity
during planned domain migrations, and multi-cloud availability. These topics
are compliance and resilience review inputs only; they must not be framed or
implemented as traffic disguise, scanner deception, or regulatory-block bypass.

Before implementation, the workstream needs a written design covering licensed
jurisdiction, provider contracts, DNS/domain ownership, audit logging,
abuse-monitoring signals, client-IP parsing, incident response, rollback,
operator sign-off, and how downstream applications validate trusted proxy
boundaries. Application-domain code should continue to expose normal
owned-service contracts; edge routing must be documented as deployment topology
rather than hidden inside product domains. The initial HAProxy template lives in
`deploy/haproxy/core-infra-l4-passthrough.cfg` for software-company adaptation.

## Business Policy Platform
Commission · Wallet · Reserve · Deposit · Withdrawal · Merchant · Settlement ·
USDT · Bonus · VIP · Betting Policies

**Confirmed state:** data model exists (`domains/configuration/` — SystemConfig,
TokenRates). The actual platform (versioning, approval workflow, effective dates,
rollback, admin UI with explanations/simulations/audit history) does not exist —
this is the current active phase, see `PHASE_STATUS.md`.

## Algorithm Registry
Merchant Assignment · Settlement · Odds Calculation · Exposure · Commission ·
Reserve Wallet · Risk Score · Bonus Engine · VIP Progression

**Confirmed state:** merchant scoring (`domains/merchant/merchantScoring.service.js`)
has real documentation after the maxConcurrentOrders bug fix, but no formal
registry (versioning, parameter/input separation, simulation) exists. This is
BBEPS Phase 011, unchanged by the platform reorganization — it reinforces this
phase rather than replacing it.

## Operations Platform (replaces "Admin Panel" as a concept)
Configuration · Workflow · Algorithms · Providers · Users · Finance · Marketing ·
Analytics · Monitoring · Audit · Security · CMS

**Orchestration only, confirmed 2026-07-03 — does not own data.** Equivalent to
BBEPS Phase 007 (Enterprise Control Center). The existing `routes/admin/*.js`
files remain the correct home for this layer.

## Agent / Reseller Hierarchy
**Confirmed requirement, researched against real industry patterns:**
- Western iGaming: Operator → Super Master Agent → Master Agent → Agent → Player.
  Credit flows down, commission flows up, each tier creates only the tier below.
- Asian cricket-exchange panel model (closer match to requested naming):
  Owner/Mother Panel → Admin → Super Master → Master → Agent/Dealer → end user.
  Tokens/credit flow down; bulk withdrawal/deposit tooling scoped by panel level.

Tightly coupled to Wallet (credit delegation is a ledger operation) and Identity
(role-scoped accounts). Needs its own design pass before any code — same standard
applied to Settlement's extraction.

## UI/UX Design System
Dark-first, neon gradient accents, glassmorphism, glowing borders, 3D coin/token
elements, gradient CTAs (reference image, 2026-06-28). Not started — Operations
Platform / Phase 007 territory, deliberately untouched during structural work.
