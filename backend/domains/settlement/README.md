# domains/settlement/ — PARTIALLY MIGRATED
unlockLostBet and executeSettlementBatch extracted from gameEngine.js. The
orchestrator (processPayoutsOptimized) stays in domains/game/ — it also handles
sockets/cache/commissions. Correctness
relies on idempotency keys, not atomicity.
