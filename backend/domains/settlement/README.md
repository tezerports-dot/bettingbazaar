# domains/settlement/ — PARTIALLY MIGRATED
Owns win/loss calculation and result processing per BBEPS Phase 003 section 3.3.
unlockLostBet and executeSettlementBatch extracted from gameEngine.js on 2026-07-03.
processPayoutsOptimized (the orchestrator) deliberately stays in domains/game/ --
it also handles sockets/cache/commissions, which is a real design task to split,
not a mechanical move. No MongoDB transactions in this flow -- correctness relies
on idempotency keys, not atomicity. This was true before extraction.
Full domain map: see ../README.md.
