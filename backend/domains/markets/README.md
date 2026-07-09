# domains/markets/ — MARKETS PLATFORM (BBEPS Phase 011)

The flagship product: the proprietary two-sided cycle market
(DELHI/BOMBAY). Consolidated 2026-07-09 from the former domains/game/
(engine, cycle generator, cycle model) and domains/betting/ (bet model,
placement routes) — one product, one platform, per the Product Platforms
tier of the accepted four-tier architecture (ENTERPRISE_DECISIONS.md).

| File | Role |
|---|---|
| `cycle.model.js` | Market lifecycle document (a cycle IS a market instance) |
| `cycleGenerator.service.js` | Market scheduling (30-min + full-day cycles) |
| `bet.model.js` / `bet.routes.js` | Position (bet) schema + placement endpoints |
| `gameEngine.js` | Settlement engine: payouts, unlocks, netProfit per cycle |

Core-platform consumption (no duplicate logic — Phase 011 rule):
- **Business Policy**: bet limits + payout multiplier from SystemConfig.
- **Risk**: `assessBet` gates every placement (validation, multiples-of-10,
  opposite-side restriction).
- **Revenue & Settlement**: settled cycles become BET_CYCLE_SETTLED ledger
  events via the R&S reconciler (settlement integration — a new product
  plugs in the same way: emit/complete source records, R&S derives).
- **Funding**: token balances bet here arrive/leave only via the Funding
  Platform.
- **Merchant**: no direct coupling (merchant flows live behind Funding).

Shared trading vocabulary (sides, statuses) comes from `domains/trading/`.
