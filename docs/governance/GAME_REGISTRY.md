# Game Registry — from application to platform (2026-07-11)

**The question this answers:** does Betting Bazaar add games as *code* (a React
page + routes per game) or as *data* (a catalogue an admin edits)? Enterprise
platforms (Stake, BC.Game, Roobet) do the latter — a provider sends game
metadata, the platform stores it, a generic card renders it, no deploy. This
domain makes Betting Bazaar do the same.

## What existed vs. what was missing (audited in-repo)

Betting Bazaar already had the **provider + plumbing half** of a registry and was
missing the **catalogue half**:

| Layer | Before | Now |
|---|---|---|
| Provider registry (credentials, enable/disable) | ✅ `GameProvider`, admin-CRUD | unchanged — reused |
| Launch / session | ✅ `POST /api/game/launch` → `GameSession` | unchanged — reused |
| Wallet + history from provider callbacks | ✅ `walletAuthority` + `GameTransaction` (idempotent) | unchanged — reused |
| **Per-game metadata** | ❌ hardcoded arrays in `CasinoPage.tsx`/`CrashPage.tsx` | ✅ `Game` documents |
| **Categories** | ❌ hardcoded `CATEGORIES` + fixed provider enum | ✅ `GameCategory` (admin-created) |
| **Metadata-driven UI** | ❌ bespoke pages with inline catalogues | ✅ generic cards from `GET /api/game/games` |

The two hardcoded arrays (`GAME_CATALOGUE`, `CRASH_GAMES`) were **migrated into
the registry and deleted**. The registry is now the **sole authority** for the
game catalogue (docs/governance/04-GOVERNANCE.md §1).

## Schema (the game IS the data)

**`Game`** — one document per game:
`slug, name, providerKey, categorySlug, launchStrategy` (`PROVIDER_GAME` |
`PROVIDER_LOBBY` | `INTERNAL_ROUTE` | `EXTERNAL_URL`), `externalGameId,
launchUrl, thumbnail, banner, badge, rtp, tags[], minBet, maxBet, status`
(`ACTIVE`|`MAINTENANCE`|`INACTIVE`), `featured, order`, audit fields.

**`GameCategory`** — admin-created, dynamic: `slug, name, icon, order, enabled`.
Categories build the user-panel nav/filters at runtime; nothing about them is
hardcoded.

Both are **soft references** by key/slug to `GameProvider` (domains/casino) and
each other, so a provider rename or a category change never orphans a game
harder than a re-point.

## APIs

Public (users):
- `GET /api/game/games` — catalogue, filterable by `category`, `provider`,
  `featured`, `tag`, `q`. Users see `ACTIVE` + `MAINTENANCE` only.
- `GET /api/game/categories` — enabled categories + live game counts.

Admin (`isAdmin`; reads allow sub-admin):
- `GET/POST/PUT/DELETE /api/game/admin/games[/:id]`
- `GET/POST/PUT/DELETE /api/game/admin/categories[/:id]` (category delete refuses
  while games still reference it — no orphans).

Admin UI: **Game Registry** page (admin panel → Games group) — table + editors
for games and categories, provider dropdown sourced from the existing provider
registry.

## How new things plug in — *no architectural change*

- **New third-party provider**: configure the `GameProvider` (existing page),
  then add its `Game` docs. Launch reuses `/api/game/launch`. Later, a provider
  `listGames()` sync can upsert `Game` docs automatically — the `externalGameId`
  + `PROVIDER_GAME` strategy already model that; only the adapter is new.
- **New in-house game** (a second original beside the Delhi/Bombay cycle):
  a `Game` with `providerKey:''`, `launchStrategy:'INTERNAL_ROUTE'`,
  `launchUrl:'/your-game'`. It reuses wallet, settlement, history, analytics,
  notifications, reporting; only the game-specific engine is written. (The cycle
  game is already seeded as exactly such a `Game`.)
- **New category / filter / nav item**: an admin `GameCategory`. The user panel
  renders it from `/api/game/categories` — no code.

## Migration & safety

- One-time idempotent seed (`gameRegistry.seed.js`) populates the catalogue from
  the ex-hardcoded arrays + the cycle game, **only when the collections are
  empty** — it never overwrites admin edits.
- Provider gating is preserved: a game shows/launches only when its provider is
  enabled (`useGameProviders`); in-house games are always available.
- `MAINTENANCE` renders a locked card; `INACTIVE` is hidden from users.

## Deliberately deferred (the "full platform" tier, not built here)

This is the **foundation**. Not yet built, each additive on this schema with no
rework: per-game **regions/geo-visibility**, per-game **feature flags**, provider
**game-sync adapters** (auto-import via `listGames()`), fully **dynamic nav
generation** everywhere (home tiles, not just the two lobbies), per-game **SEO**,
and casino **GGR ledger** integration (derive R&S entries from `GameTransaction`
— already queued in docs/governance/04-GOVERNANCE.md). Adding any of them is new fields/an
adapter, not a new architecture.
