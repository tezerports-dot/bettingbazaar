# domains/betting/ — MIGRATED

Owns bet creation, validation, lifecycle. bet.model.js (schema), bet.routes.js
(placement/history endpoints). Moved 2026-07-02.

Deliberately does NOT include gameEngine.js / cycleGenerator.service.js /
cycle.model.js — those are the core cycle/crash engine, a separate and larger
domain (domains/game/, still a placeholder), kept as its own future migration
rather than bundled here.

Full domain map: see ../README.md.
