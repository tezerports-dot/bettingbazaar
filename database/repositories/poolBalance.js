// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * poolBalance.js — what the database's team-pool balance check says, and who
 * hears about it.
 *
 * Owner, 2026-10-04: the check is EVENT-based. At the commit of every
 * transaction that moves a team's pool, an order's hold or a pool entry, the
 * database asks whether that team still balances (`bb_team_pool_must_balance`
 * in schema.sql): the pool's held tokens equal the holds on its orders, and
 * the pool equals its own latest ledger entry. If not, it raises SQLSTATE
 * BB001 and the transaction rolls back, so no token is ever spent twice.
 *
 * This file is the one place that error is recognised, so every writer turns
 * it into the same refusal (`pool_out_of_balance`) and the same alert. A
 * refusal here means a code path broke the books, never that a member or a
 * player did something wrong: it is reported loudly and nothing moves.
 */

/** The SQLSTATE `bb_team_pool_must_balance` raises. */
export const POOL_OUT_OF_BALANCE = 'BB001';

/** The refusal every caller sees for it. */
export const POOL_OUT_OF_BALANCE_REASON = 'pool_out_of_balance';

export const isPoolImbalance = (error) => error?.code === POOL_OUT_OF_BALANCE;

/**
 * Say so, loudly, and never throw: the caller is already refusing. The
 * alerting service is loaded lazily because it reads the platform config, and
 * the database layer must not need it to load.
 */
export function reportPoolImbalance(error, context = {}) {
  const detail = String(error?.message ?? error).slice(0, 500);
  console.error('[team-pool] movement refused, the pool did not balance:', detail, JSON.stringify(context));
  import('../../backend/services/alerting.service.js')
    .then(({ sendAlert }) => sendAlert('team-pool-out-of-balance',
      'A team pool movement was refused because the pool did not balance — nothing moved; a code path needs fixing',
      { detail, ...context }))
    .catch(() => { /* the log line above is the record */ });
}
