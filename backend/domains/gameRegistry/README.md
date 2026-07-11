# domains/gameRegistry/ — GAME REGISTRY (Game Management)

The **sole authority for the game catalogue**: games, categories, and their
display/launch metadata. Games are DATA, not code — adding one is a `Game`
document, not a new React page. Introduced 2026-07-11 to turn the fixed casino/
crash lobbies (hardcoded `GAME_CATALOGUE` / `CRASH_GAMES` arrays that lived in
the frontend) into an admin-driven registry. Those arrays have been removed; the
user-panel lobbies now render generically from `GET /api/game/games`.

| File | Role |
|---|---|
| `game.model.js` | `Game` (per-game metadata) + `GameCategory` (dynamic categories) |
| `gameRegistry.routes.js` | Public `GET /games` + `/categories`; admin CRUD for games + categories |
| `gameRegistry.seed.js` | One-time seed from the ex-hardcoded catalogue + the in-house cycle game (no-op once populated) |

## Boundaries — references, never duplicates

This domain owns catalogue **metadata only**. It reuses the existing spine:

- **Providers**: `GameProvider` (domains/casino) stays the provider authority
  (credentials, enable/disable). `Game.providerKey` is a soft reference to it.
  The registry does not store or duplicate provider logic.
- **Launch / sessions / wallet / transactions**: launching a registry game calls
  the existing `POST /api/game/launch` (domains/casino), which creates the
  `GameSession` and settles provider callbacks through `walletAuthority` +
  `GameTransaction`. The registry adds no money movement of its own.
- **Feature flags**: `FLAGS.LIVE_CASINO` / `GAMES_PLATFORM` gate visibility, same
  as before.

## Future-proofing (no architectural change needed to add games)

- **New third-party provider**: add the `GameProvider` (existing page), then add
  its `Game` documents (or, later, a provider `listGames()` sync upserts them —
  the `externalGameId` + `PROVIDER_GAME` launch strategy already model this).
- **New in-house game** (e.g. a second original alongside the cycle game): a
  `Game` with `providerKey: ''` and `launchStrategy: 'INTERNAL_ROUTE'`. It reuses
  wallet/history/settlement/analytics; only the game-specific engine is new.
- **New category / nav / filters**: an admin `GameCategory` — the user panel
  builds chips/nav from `GET /api/game/categories` at runtime.
