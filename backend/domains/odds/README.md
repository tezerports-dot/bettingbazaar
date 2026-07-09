# domains/odds/ — ODDS PLATFORM (BBEPS Phase 011 — DECLARED)

Product Platforms tier. No implementation yet — deliberately no fake
placeholder code (repo rule since Phase 003). This boundary exists so
odds work (pricing, margins — note: the cycle market is fixed 2x via SystemConfig.payoutMultiplier, which stays Business Policy-owned) lands HERE, gated by `FLAGS.ODDS_ENGINE` (default false),
with its eventBus events already reserved (sportsbook.* in
eventBus.service.js §catalog).

An implementation MUST follow the shared contracts:
- vocabulary from `domains/trading/tradingModels.js`
- validation via the Risk Platform (`assessBet`-style gates)
- limits/percentages from Business Policy (SystemConfig / policy docs)
- money movement via the Funding Platform; wallets via walletAuthority
- settlement: persist source records; R&S derives ledger entries
  (see tradingModels.js "Settlement integration contract")
