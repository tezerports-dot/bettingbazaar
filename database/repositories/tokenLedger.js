// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The token ledger read as profit and loss: every token the platform gained or
 * gave away, movement by movement (owner, 2026-10-17: "the ledger should track
 * every token flow, each single token; that is how we get the real net profit
 * or loss").
 *
 * Read only, owning no value (§2). The record is `treasury_entries`, the
 * append-only double entry every token movement already writes in its own
 * transaction (one per bet settled, casino transaction, bonus, commission,
 * pool trade and order), held whole at COMMIT by the conservation triggers
 * (§19). This module copies none of it; it classifies it.
 *
 * The PLATFORM side of a movement is the sum of its legs on the platform's own
 * accounts: TOKEN_SUPPLY (a contra, negative by what has been released), the
 * HOUSE_RESERVE a lost stake goes to, and the platform pools. USER_FLOAT
 * (wallets) and TEAM_FLOAT (team pools) are the other side. Positive = the
 * platform holds more tokens after the movement than before.
 *
 *   GAME_BOARD, GAME_CASINO,  what the house kept or paid (revenue)
 *   GAME_CRICKET
 *   BONUS, COMMISSION,        tokens given away (costs); a platform-covered
 *   PLATFORM_COVER            sell refund is a cost until a person recovers it
 *   ADJUSTMENT                an admin's balance adjustment
 *   POOL_TRADE                tokens sold to or bought back from a team pool,
 *                             for the money in `admin_token_considerations`,
 *                             or sold to a player for USDT received on chain
 *                             (`USDT_BUY_PAID`, usdtDeposits.js): an exchange,
 *                             never profit
 *   PLAYER_TRADE              a pool paying a buy or taking a sell: zero for
 *                             the platform
 *   COMPENSATION              a losing team's pool paying a player after a
 *                             dispute: zero for the platform
 *   INTERNAL                  platform account to platform account: zero
 *   UNCLASSIFIED              an operation this list does not name, shown so
 *                             that a new producer cannot hide in the totals
 *
 * Profit in tokens = every kind but POOL_TRADE, PLAYER_TRADE and INTERNAL.
 * The cash check: what teams paid for pool tokens, less what was paid back,
 * less the tokens still out in pools and wallets (each owed back at ₹1), is
 * the same figure measured from the money side.
 */
import { pgQuery } from '../client.js';
import { paiseToRupees } from '../../backend/shared/money.js';

/** Accounts on the platform's side of a movement. */
export const PLATFORM_ACCOUNTS = Object.freeze([
  'TOKEN_SUPPLY', 'HOUSE_RESERVE', 'COMMISSION_POOL', 'BONUS_POOL', 'REFERRAL_POOL', 'OPERATIONAL_FLOAT',
]);

/** Kinds, in the order the screen and the CSV list them. */
export const TOKEN_FLOW_KINDS = Object.freeze([
  'GAME_BOARD', 'GAME_CASINO', 'GAME_CRICKET', 'BONUS', 'COMMISSION', 'PLATFORM_COVER', 'ADJUSTMENT',
  'POOL_TRADE', 'PLAYER_TRADE', 'COMPENSATION', 'INTERNAL', 'UNCLASSIFIED',
]);

/** Kinds that are profit or loss; the rest are exchanges or internal. */
export const PROFIT_KINDS = Object.freeze(['GAME_BOARD', 'GAME_CASINO', 'GAME_CRICKET', 'BONUS', 'COMMISSION', 'PLATFORM_COVER', 'ADJUSTMENT']);

/** How many movements one CSV export may carry. */
export const MOVEMENTS_EXPORT_MAX = 200_000;

/**
 * An operation's kind, in SQL, from the operation names the producers write:
 * `BET_<state>` (bets.core), `CASINO_<type>` (casino.core), `CRICKET_<type>`
 * (cricket.js: bet, claim, win, refund), `PROMO_CREDITED`
 * (promo.js), `WINNINGS_CREDITED` (wallets.creditWinnings), `PAYOUT_<pool>` and
 * `CLAWBACK_<pool>` (bonuses.core), `TEAM_COMMISSION`, `TEAM_SELL_REFUND_COVERED`,
 * `TEAM_POOL_SALE`/`_BUYBACK`, `TEAM_BUY_PAID`, `TEAM_SELL_*` (teamPools),
 * `USDT_BUY_PAID` (usdtDeposits),
 * `ADMIN_ADJUSTMENT_<type>` (balanceAdjustments), `ALLOCATE_*`/`RETURN_*`
 * (treasury, platform to platform).
 */
export const KIND_SQL = `CASE
    WHEN operation LIKE 'BET\\_%' THEN 'GAME_BOARD'
    WHEN operation LIKE 'CASINO\\_%' THEN 'GAME_CASINO'
    WHEN operation LIKE 'CRICKET\\_%' THEN 'GAME_CRICKET'
    WHEN operation IN ('PROMO_CREDITED', 'WINNINGS_CREDITED')
      OR operation LIKE 'PAYOUT\\_%' OR operation LIKE 'CLAWBACK\\_%' THEN 'BONUS'
    WHEN operation = 'TEAM_COMMISSION' THEN 'COMMISSION'
    WHEN operation = 'TEAM_SELL_REFUND_COVERED' THEN 'PLATFORM_COVER'
    WHEN operation LIKE 'ADMIN\\_ADJUSTMENT\\_%' THEN 'ADJUSTMENT'
    WHEN operation IN ('TEAM_POOL_SALE', 'TEAM_POOL_BUYBACK', 'USDT_BUY_PAID') THEN 'POOL_TRADE'
    WHEN operation = 'TEAM_BUY_PAID' OR operation LIKE 'TEAM\\_SELL\\_%' THEN 'PLAYER_TRADE'
    WHEN operation = 'DISPUTE_COMPENSATION' THEN 'COMPENSATION'
    WHEN operation LIKE 'ALLOCATE\\_%' OR operation LIKE 'RETURN\\_%' THEN 'INTERNAL'
    ELSE 'UNCLASSIFIED' END`;

const PLATFORM_LIST = PLATFORM_ACCOUNTS.map((a) => `'${a}'`).join(', ');

/** IST-day window on a timestamp column; `$1`/`$2` are `YYYY-MM-DD` or null. */
const inWindow = (col) => `($1::date IS NULL OR ${col} >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata')
      AND ($2::date IS NULL OR ${col} < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;

/** One row per movement: its legs by account and the platform's side. */
const MOVEMENTS_SQL = `
  SELECT movement_id,
         MIN(created_at) AS created_at,
         MIN(operation) AS operation,
         MIN(ref_model) AS ref_model, MIN(ref_id) AS ref_id, MIN(actor) AS actor, MIN(reason) AS reason,
         COALESCE(SUM(amount_paise) FILTER (WHERE account = 'TOKEN_SUPPLY'), 0)  AS token_supply,
         COALESCE(SUM(amount_paise) FILTER (WHERE account = 'HOUSE_RESERVE'), 0) AS house_reserve,
         COALESCE(SUM(amount_paise) FILTER (WHERE account IN ('COMMISSION_POOL', 'BONUS_POOL',
                       'REFERRAL_POOL', 'OPERATIONAL_FLOAT')), 0)                AS platform_pools,
         COALESCE(SUM(amount_paise) FILTER (WHERE account = 'USER_FLOAT'), 0)    AS user_float,
         COALESCE(SUM(amount_paise) FILTER (WHERE account = 'TEAM_FLOAT'), 0)    AS team_float,
         COALESCE(SUM(amount_paise) FILTER (WHERE account IN (${PLATFORM_LIST})), 0) AS platform_net
    FROM treasury_entries
   WHERE ${inWindow('created_at')}
   GROUP BY movement_id`;

const num = (v) => Number(v ?? 0);

/**
 * The platform's token profit and loss over IST days `from`..`to`, by kind and
 * by operation, with the cash check.
 */
export async function tokenProfit({ from = null, to = null } = {}) {
  const params = [from, to];
  const [byOp, cash, usdtCash, outstanding] = await Promise.all([
    pgQuery(
      `SELECT ${KIND_SQL} AS kind, operation,
              COUNT(*)::int AS movements,
              SUM(platform_net) AS platform_net,
              SUM(user_float) AS user_float, SUM(team_float) AS team_float
         FROM (${MOVEMENTS_SQL}) m
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      params, 'token_ledger_profit'),
    pgQuery(
      `SELECT COALESCE(SUM(inr_equivalent_paise) FILTER (WHERE direction = 'RECEIVED'), 0) AS received,
              COALESCE(SUM(inr_equivalent_paise) FILTER (WHERE direction = 'PAID'), 0)     AS paid
         FROM admin_token_considerations WHERE ${inWindow('created_at')}`,
      params, 'token_ledger_cash'),
    // What players paid the platform in USDT, at the INR value they bought
    // (their tokens, 1 token = ₹1; the USDT figure is on each order).
    pgQuery(
      `SELECT COALESCE(SUM(-amount_paise), 0) AS received
         FROM treasury_entries
        WHERE operation = 'USDT_BUY_PAID' AND account = 'TOKEN_SUPPLY' AND ${inWindow('created_at')}`,
      params, 'token_ledger_cash_usdt'),
    // Tokens out in pools and wallets NOW: what the platform owes back.
    pgQuery(
      `SELECT COALESCE(SUM(balance_paise) FILTER (WHERE account = 'USER_FLOAT'), 0) AS wallets,
              COALESCE(SUM(balance_paise) FILTER (WHERE account = 'TEAM_FLOAT'), 0) AS pools
         FROM treasury_accounts`,
      [], 'token_ledger_outstanding'),
  ]);

  const kinds = Object.fromEntries(TOKEN_FLOW_KINDS.map((k) => [k, { tokens: 0, movements: 0, operations: [] }]));
  for (const r of byOp.rows) {
    const k = kinds[r.kind] ?? kinds.UNCLASSIFIED;
    k.tokens += num(r.platform_net);
    k.movements += r.movements;
    k.operations.push({
      operation: r.operation, movements: r.movements,
      tokens: paiseToRupees(num(r.platform_net)),
      wallets: paiseToRupees(num(r.user_float)), pools: paiseToRupees(num(r.team_float)),
    });
  }
  const profitPaise = PROFIT_KINDS.reduce((s, k) => s + kinds[k].tokens, 0);
  const c = cash.rows[0];
  const o = outstanding.rows[0];
  return {
    kinds: TOKEN_FLOW_KINDS.map((kind) => ({
      kind, profit: PROFIT_KINDS.includes(kind),
      tokens: paiseToRupees(kinds[kind].tokens), movements: kinds[kind].movements,
      operations: kinds[kind].operations,
    })),
    netProfit: paiseToRupees(profitPaise),
    unclassifiedMovements: kinds.UNCLASSIFIED.movements,
    cash: {
      receivedFromTeams: paiseToRupees(num(c.received)),
      receivedFromPlayersUsdt: paiseToRupees(num(usdtCash.rows[0].received)),
      paidToTeams: paiseToRupees(num(c.paid)),
      net: paiseToRupees(num(c.received) + num(usdtCash.rows[0].received) - num(c.paid)),
    },
    // Not windowed: a balance is a balance now.
    outstandingNow: {
      wallets: paiseToRupees(num(o.wallets)),
      pools: paiseToRupees(num(o.pools)),
      total: paiseToRupees(num(o.wallets) + num(o.pools)),
    },
  };
}

/**
 * Every movement in the window, newest first, one row each, with its legs.
 * `search` matches a movement id, ref id (an order, bet, team or grant) or
 * actor exactly; `kind` narrows to one kind.
 */
export async function tokenMovements({ from = null, to = null, kind = null, search = null, limit = 100, offset = 0 } = {}) {
  if (kind != null && !TOKEN_FLOW_KINDS.includes(kind)) {
    throw Object.assign(new Error(`Unknown kind '${kind}'. Known: ${TOKEN_FLOW_KINDS.join(', ')}.`),
      { status: 400, code: 'UNKNOWN_KIND' });
  }
  const lim = Math.max(1, Math.min(Number(limit) || 100, MOVEMENTS_EXPORT_MAX));
  const off = Math.max(0, Number(offset) || 0);
  const { rows } = await pgQuery(
    `SELECT m.*, ${KIND_SQL} AS kind, COUNT(*) OVER () AS total
       FROM (${MOVEMENTS_SQL}) m
      WHERE ($3::text IS NULL OR ${KIND_SQL} = $3::text)
        AND ($4::text IS NULL OR m.movement_id = $4::text OR m.ref_id = $4::text OR m.actor = $4::text)
      ORDER BY m.created_at DESC, m.movement_id DESC
      LIMIT $5::int OFFSET $6::int`,
    [from, to, kind, search ? String(search).trim() : null, lim, off], 'token_ledger_movements');
  return {
    total: rows[0] ? Number(rows[0].total) : 0,
    rows: rows.map(toMovementRow),
  };
}

/** A movement row as the screen and the CSV carry it. Rupees, 1 token = ₹1. */
export function toMovementRow(r) {
  return {
    movementId: r.movement_id,
    at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    kind: r.kind,
    operation: r.operation,
    refModel: r.ref_model ?? null,
    refId: r.ref_id ?? null,
    actor: r.actor ?? null,
    reason: r.reason ?? null,
    tokenSupply: paiseToRupees(num(r.token_supply)),
    houseReserve: paiseToRupees(num(r.house_reserve)),
    platformPools: paiseToRupees(num(r.platform_pools)),
    wallets: paiseToRupees(num(r.user_float)),
    teamPools: paiseToRupees(num(r.team_float)),
    platformNet: paiseToRupees(num(r.platform_net)),
  };
}
