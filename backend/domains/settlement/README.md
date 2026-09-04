# domains/settlement/

Empty by design. The two functions that lived here — `unlockLostBet` and
`executeSettlementBatch` — were extracted from `gameEngine.js` when settlement
still spanned two stores, and both existed to bridge that gap:

- `unlockLostBet` released a locked stake as a *separate* wallet call, because
  the bet's status was stamped in one store and its money moved in another.
- `executeSettlementBatch` grouped winners per user and carried a `onPg` flag,
  so one pass could not accidentally settle its losing side in one store and its
  winning side in the other.

Neither is needed now. `bets.core.winBet` / `loseBet` consume the locked stake,
credit the payout and stamp the row **in one transaction under one wallet lock**,
so a settled bet with no ledger row is structurally unrepresentable — and there
is no second store for a pass to drift into.

The orchestrator is `domains/markets/gameEngine.js`. It stays there because it
also owns the socket fan-out, the cache invalidation and the settlement run's
lifecycle; splitting the money out of it was what created the seam in the first
place.

Correctness now rests on the database — guarded transitions, unique keys and
`CHECK` constraints — rather than on idempotency keys alone. The keys are still
there; they are no longer the only thing standing between a resumed pass and a
double payout.
