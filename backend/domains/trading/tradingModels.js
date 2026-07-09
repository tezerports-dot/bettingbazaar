// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Shared Trading Models (BBEPS Phase 011).
//
// The canonical trading vocabulary shared by every Product Platform
// (Markets today; Sportsbook/Casino/Games/Event/Odds as they come live).
// One name per concept — the same single-source discipline as
// 04-GOVERNANCE.md §11 for socket events and the R&S chart of accounts.
//
// LIVE CONSUMERS: domains/markets/bet.routes.js (sides + statuses),
// domains/markets/gameEngine.js (settlement statuses). New products import
// from here instead of re-declaring their own strings.

// ── Market sides (the two-sided cycle market) ─────────────────────────────────
export const MARKET_SIDES = Object.freeze(['DELHI', 'BOMBAY']);

export function oppositeSide(side) {
  if (!MARKET_SIDES.includes(side)) throw new Error(`Unknown market side '${side}'`);
  return side === 'DELHI' ? 'BOMBAY' : 'DELHI';
}

// ── Position (bet) lifecycle ──────────────────────────────────────────────────
// Mirrors domains/markets/bet.model.js `status` enum — that schema is the
// storage authority; this is the shared cross-product vocabulary.
export const POSITION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  WON:     'WON',
  LOST:    'LOST',
});

// ── Market-instance settlement lifecycle ──────────────────────────────────────
// Mirrors domains/markets/cycle.model.js `isSettled` enum.
export const SETTLEMENT_STATUS = Object.freeze({
  PENDING:    'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED:  'COMPLETED',
});

// ── Settlement integration contract (how a product plugs into R&S) ──────────
// Not code — a documented contract every product follows:
//   1. The product persists SOURCE RECORDS of financial outcomes (Markets:
//      settled Cycles with netProfit; Casino: GameTransactions; future
//      Sportsbook: settled sports bets).
//   2. The Revenue & Settlement Platform DERIVES append-only ledger entries
//      from those records via idempotent reconciliation (see
//      revenueSettlement.service.js) — products never write accounting.
//   3. Wallet effects go through walletAuthority / merchantWallet only.
