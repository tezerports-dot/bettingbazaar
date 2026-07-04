# domains/settlement/ — PARTIALLY MIGRATED
unlockLostBet and executeSettlementBatch extracted from gameEngine.js. The
orchestrator (processPayoutsOptimized) stays in domains/game/ — it also handles
sockets/cache/commissions. No MongoDB transactions in this flow; correctness
relies on idempotency keys, not atomicity.
