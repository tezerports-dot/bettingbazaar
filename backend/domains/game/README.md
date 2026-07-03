# domains/game/ — MIGRATED

Owns the proprietary cycle/crash prediction engine — the actual core product.
gameEngine.js (payout/settlement), cycleGenerator.service.js (scheduling),
cycle.model.js (schema). Moved 2026-07-02.

cache.service.js stays in backend/services/ — genuinely shared, not Game-exclusive.

Full domain map: see ../README.md.
