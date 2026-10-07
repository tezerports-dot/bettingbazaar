// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Team token pools (owner, 2026-10-02 — PROJECT_STATUS §3.10, Step 2b).
 *
 * A TEAM holds tokens; its members hold none. A supervisor asks the platform to
 * sell tokens into a team's pool (a BUY request) or to buy pool tokens back (a
 * SELL request), and an admin fulfils the request, recording what was paid.
 *
 * ── One owner, one transaction ───────────────────────────────────────────────
 * This module is the only writer of `team_pools`, `team_pool_entries` and the
 * treasury's TEAM_FLOAT. A fulfilment writes all of them — the pool row, its
 * ledger entry, the treasury movement, the request's status and the money the
 * platform got or gave — in ONE transaction. There is no second write that can
 * fail after the first committed (§21), and TEAM_FLOAT always equals the sum
 * of the pools.
 *
 * ── Guards are writes, not reads ─────────────────────────────────────────────
 * A buyback takes tokens only if the pool's `available` covers them, and that
 * test is the UPDATE's own WHERE under the row lock. Two buybacks racing for
 * the same tokens serialise on the row, and the second learns the answer from
 * whether its write landed (§32 S6, trap 18). A request is fulfilled at most
 * once because the status flip is `WHERE status = 'PENDING'` in the same
 * transaction.
 */
import { pgQuery, withTransaction } from '../client.js';
import { randomBytes } from 'node:crypto';
import { ACCOUNTS, postMovement } from './treasury.js';
import { lockWalletWithin } from './wallets.core.js';
import { creditBuyWithin, consumeWithdrawalStakeWithin, returnSettledStakeWithin } from './wallets.js';
import { recordConsideration, assertRecordable, DIRECTIONS } from './adminTokenConsiderations.js';

export const POOL_DIRECTIONS = Object.freeze({ BUY: 'BUY', SELL: 'SELL' });

const toNum = (v) => Number(v ?? 0);
const newRequestId = () => `tpr_${randomBytes(10).toString('hex')}`;

/** Thrown inside a transaction to unwind it and answer with a reason. */
class Refused extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function toPool(teamId, row) {
  const available = toNum(row?.available_paise);
  const held = toNum(row?.held_paise);
  return { teamId: String(teamId), availablePaise: available, heldPaise: held, totalPaise: available + held };
}

function toEntry(row) {
  return {
    id: Number(row.id),
    txId: row.tx_id,
    teamId: row.team_id,
    kind: row.kind,
    availableDeltaPaise: toNum(row.available_delta_paise),
    heldDeltaPaise: toNum(row.held_delta_paise),
    availableAfterPaise: toNum(row.available_after_paise),
    heldAfterPaise: toNum(row.held_after_paise),
    actor: row.actor,
    refId: row.ref_id,
    note: row.note,
    createdAt: row.created_at,
  };
}

function toRequest(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    teamId: row.team_id,
    teamName: row.team_name ?? null,
    supervisorId: row.supervisor_id,
    supervisorName: row.supervisor_name ?? null,
    direction: row.direction,
    tokenAmountPaise: toNum(row.token_amount_paise),
    status: row.status,
    note: row.note,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
  };
}

const REQUEST_SELECT = `
  SELECT r.*, t.name AS team_name, s.name AS supervisor_name
    FROM team_pool_requests r
    JOIN teams t ON t.team_id = r.team_id
    JOIN merchants s ON s.merchant_id = r.supervisor_id`;

/** A team's pool. A team that has never traded holds nothing. */
export async function getPool(teamId) {
  const { rows } = await pgQuery(
    'SELECT available_paise, held_paise FROM team_pools WHERE team_id = $1',
    [String(teamId)], 'team_pool_get');
  return toPool(teamId, rows[0]);
}

/** A team's pool ledger, newest first. */
export async function listEntries(teamId, { limit = 50 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM team_pool_entries WHERE team_id = $1
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [String(teamId), Math.min(Math.max(Number(limit) || 50, 1), 500)], 'team_pool_entries');
  return rows.map(toEntry);
}

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * A supervisor asks for a sale into, or a buyback from, one of THEIR teams.
 * Scoped by `supervisor_id` in the WHERE, so another supervisor's team id
 * matches nothing (trap 16). One pending request per team and direction — the
 * partial unique index refuses a second.
 */
export async function createRequest({ teamId, supervisorId, direction, tokenAmountPaise, note = null }) {
  if (!Object.values(POOL_DIRECTIONS).includes(direction)) {
    throw Object.assign(new Error('direction must be BUY or SELL.'), { status: 400 });
  }
  const amount = Number(tokenAmountPaise);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw Object.assign(new Error('Enter a whole number of tokens greater than zero.'), { status: 400 });
  }
  const cleanNote = note === null || note === undefined ? null : String(note).trim().slice(0, 500) || null;
  return withTransaction(async (client) => {
    const { rows: t } = await client.query(
      'SELECT team_id FROM teams WHERE team_id = $1 AND supervisor_id = $2',
      [String(teamId), String(supervisorId)]);
    if (!t[0]) return { ok: false, reason: 'team_not_found' };
    if (direction === POOL_DIRECTIONS.SELL) {
      // Asked now so the supervisor hears it now; asked AGAIN, as a write, at
      // fulfilment — this read is a courtesy, never the guard.
      const { rows: p } = await client.query(
        'SELECT available_paise FROM team_pools WHERE team_id = $1', [String(teamId)]);
      if (toNum(p[0]?.available_paise) < amount) return { ok: false, reason: 'pool_short' };
    }
    const requestId = newRequestId();
    try {
      await client.query('SAVEPOINT pool_request');
      await client.query(
        `INSERT INTO team_pool_requests (request_id, team_id, supervisor_id, direction, token_amount_paise, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [requestId, String(teamId), String(supervisorId), direction, amount, cleanNote]);
    } catch (e) {
      if (e?.code === '23505') {
        await client.query('ROLLBACK TO SAVEPOINT pool_request');
        return { ok: false, reason: 'request_pending' };
      }
      throw e;
    }
    return { ok: true, requestId };
  });
}

/** A supervisor withdraws their own pending request. */
export async function cancelRequest({ requestId, supervisorId }) {
  const { rowCount } = await pgQuery(
    `UPDATE team_pool_requests SET status = 'CANCELLED', decided_by = $2, decided_at = now()
      WHERE request_id = $1 AND supervisor_id = $2 AND status = 'PENDING'`,
    [String(requestId), String(supervisorId)], 'team_pool_request_cancel');
  return rowCount ? { ok: true } : { ok: false, reason: 'request_not_pending' };
}

export async function getRequest(requestId) {
  const { rows } = await pgQuery(`${REQUEST_SELECT} WHERE r.request_id = $1`,
    [String(requestId)], 'team_pool_request_get');
  return toRequest(rows[0]);
}

export async function listRequests({ status = null, teamId = null, supervisorId = null, limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `${REQUEST_SELECT}
      WHERE ($1::text IS NULL OR r.status = $1)
        AND ($2::text IS NULL OR r.team_id = $2)
        AND ($3::text IS NULL OR r.supervisor_id = $3)
      ORDER BY r.created_at DESC LIMIT $4`,
    [status, teamId, supervisorId, Math.min(Math.max(Number(limit) || 100, 1), 500)],
    'team_pool_request_list');
  return rows.map(toRequest);
}

/** An admin turns a request down. */
export async function rejectRequest({ requestId, actor, reason = null }) {
  const { rowCount } = await pgQuery(
    `UPDATE team_pool_requests
        SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3
      WHERE request_id = $1 AND status = 'PENDING'`,
    [String(requestId), String(actor), reason ? String(reason).slice(0, 500) : null],
    'team_pool_request_reject');
  return rowCount ? { ok: true } : { ok: false, reason: 'request_not_pending' };
}

/**
 * An admin fulfils a pending request: tokens move between the platform and the
 * team's pool, and what was paid is recorded — all in one transaction.
 *
 * `consideration` is `{ currency, fiatAmountMinor, rateUsed }`, already
 * resolved by the route. A BUY is money RECEIVED by the platform; a SELL is
 * money PAID, in rupees only (the CHECK on the considerations table says so).
 *
 * Returns `{ ok, pool }`, or `{ ok: false, reason }` with nothing moved:
 *   request_not_pending — already fulfilled, rejected or cancelled
 *   pool_short          — a SELL larger than the pool's available tokens
 *   supply_cap_exceeded — a BUY the platform's holding cannot cover
 */
export async function fulfilRequest({ requestId, actor, consideration }) {
  const movementId = `team_pool_${requestId}`;
  // Refused before anything is locked, with the operator's own wording.
  const preview = await getRequest(requestId);
  if (!preview) return { ok: false, reason: 'request_not_found' };
  const direction = preview.direction === POOL_DIRECTIONS.BUY ? DIRECTIONS.RECEIVED : DIRECTIONS.PAID;
  assertRecordable({
    movementId, merchantId: preview.supervisorId, direction,
    tokenAmountPaise: preview.tokenAmountPaise, recordedBy: actor, ...consideration,
  });

  try {
    return await withTransaction(async (client) => fulfilWithin(client, { requestId, actor, consideration, movementId, direction }));
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    throw e;
  }
}

async function fulfilWithin(client, { requestId, actor, consideration, movementId, direction }) {
  // The status flip IS the once-only guard: a second fulfilment, racing or
  // redelivered, matches no PENDING row and moves nothing.
  const { rows } = await client.query(
    `UPDATE team_pool_requests
        SET status = 'FULFILLED', decided_by = $2, decided_at = now()
      WHERE request_id = $1 AND status = 'PENDING'
      RETURNING team_id, supervisor_id, direction, token_amount_paise`,
    [String(requestId), String(actor)]);
  const req = rows[0];
  if (!req) throw new Refused('request_not_pending');
  const teamId = req.team_id;
  const amount = toNum(req.token_amount_paise);
  const isBuy = req.direction === POOL_DIRECTIONS.BUY;

  await client.query(
    'INSERT INTO team_pools (team_id) VALUES ($1) ON CONFLICT (team_id) DO NOTHING', [teamId]);
  // A sale adds; a buyback takes only what is available, decided by the
  // write itself.
  const { rows: pool } = await client.query(
    `UPDATE team_pools
        SET available_paise = available_paise + $2, updated_at = now()
      WHERE team_id = $1 AND available_paise + $2 >= 0
      RETURNING available_paise, held_paise`,
    [teamId, isBuy ? amount : -amount]);
  if (!pool[0]) throw new Refused('pool_short');

  const moved = await postMovement({
    client,
    movementId,
    operation: isBuy ? 'TEAM_POOL_SALE' : 'TEAM_POOL_BUYBACK',
    legs: isBuy
      ? { [ACCOUNTS.TOKEN_SUPPLY]: -amount, [ACCOUNTS.TEAM_FLOAT]: amount }
      : { [ACCOUNTS.TEAM_FLOAT]: -amount, [ACCOUNTS.TOKEN_SUPPLY]: amount },
    actor: String(actor), refModel: 'Team', refId: teamId,
    reason: isBuy ? 'Tokens sold into a team pool' : 'Team pool tokens bought back',
  });
  if (!moved.ok) throw new Refused(moved.reason);
  // The movement already exists, so this request's money already moved —
  // reachable only if the status flip above was bypassed. Refuse rather than
  // credit the pool a second time.
  if (moved.idempotent) throw new Refused('request_not_pending');

  await client.query(
    `INSERT INTO team_pool_entries
       (tx_id, team_id, kind, available_delta_paise, held_delta_paise,
        available_after_paise, held_after_paise, actor, ref_id)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8)`,
    [movementId, teamId, isBuy ? 'ADMIN_SALE' : 'ADMIN_BUYBACK', isBuy ? amount : -amount,
      toNum(pool[0].available_paise), toNum(pool[0].held_paise), String(actor), String(requestId)]);

  const { consideration: recorded } = await recordConsideration({
    client,
    movementId, merchantId: req.supervisor_id, teamId, direction,
    tokenAmountPaise: amount, recordedBy: actor, ...consideration,
  });

  return { ok: true, teamId, pool: toPool(teamId, pool[0]), consideration: recorded };
}

// ── Orders against the pool (Step 2c) ────────────────────────────────────────
//
// A BUY's tokens are HELD in the team's pool from the moment the order is
// assigned until it ends: spent when the merchant confirms the player paid,
// released back to `available` on any other ending. A SELL holds nothing; its
// tokens join the pool when it settles.
//
// The order row is the guard. `order_states.pool_held_paise` is what this
// order holds, and every hold, release and spend writes it in its own WHERE
// under the order's row lock — so a hold is taken once and ended once, however
// many paths race to end it (S6). Every movement leaves a `team_pool_entries`
// row naming the order (`ref_id`).

const entryTx = (kind, orderId) => `pool_${kind.toLowerCase()}_${orderId}_${randomBytes(6).toString('hex')}`;

async function writeEntry(client, { txId, teamId, kind, availableDelta, heldDelta, pool, actor, refId, note = null }) {
  await client.query(
    `INSERT INTO team_pool_entries
       (tx_id, team_id, kind, available_delta_paise, held_delta_paise,
        available_after_paise, held_after_paise, actor, ref_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [txId, teamId, kind, availableDelta, heldDelta,
      toNum(pool.available_paise), toNum(pool.held_paise), String(actor ?? 'system'), String(refId), note]);
}

/**
 * Hold a buy's tokens in its team's pool, INSIDE the caller's transaction —
 * the one that assigns the order (teamRouting.js). Throws `Refused` when the
 * pool cannot cover it or the order already holds something; the caller's
 * transaction unwinds with it, so an order is never assigned unheld.
 */
export async function holdForBuyWithin(client, { orderId, teamId, amountPaise, actor = 'assignment' }) {
  const amount = toNum(amountPaise);
  if (!Number.isInteger(amount) || amount <= 0) throw new TypeError(`holdForBuyWithin: bad amount ${amountPaise}`);
  await client.query('INSERT INTO team_pools (team_id) VALUES ($1) ON CONFLICT (team_id) DO NOTHING', [teamId]);
  const { rows: pool } = await client.query(
    `UPDATE team_pools
        SET available_paise = available_paise - $2, held_paise = held_paise + $2, updated_at = now()
      WHERE team_id = $1 AND available_paise >= $2
      RETURNING available_paise, held_paise`, [teamId, amount]);
  if (!pool[0]) throw new Refused('pool_short');
  const { rowCount } = await client.query(
    `UPDATE order_states SET team_id = $2, pool_held_paise = $3
      WHERE order_id = $1 AND pool_held_paise = 0`, [String(orderId), teamId, amount]);
  if (!rowCount) throw new Refused('already_held');
  await writeEntry(client, {
    txId: entryTx('BUY_HOLD', orderId), teamId, kind: 'BUY_HOLD',
    availableDelta: -amount, heldDelta: amount, pool: pool[0], actor, refId: orderId,
  });
}

/** Throws are how a caller's transaction learns "refused"; re-exported for teamRouting.js. */
export { Refused as PoolRefused };

/**
 * End a buy's hold WITHOUT spending it — the order was cancelled, expired,
 * refused or put back in the queue. The tokens go back to `available`.
 * A no-op on an order that holds nothing, so every ending path may call it.
 */
export async function releaseBuyHold(orderId, { actor = 'system', reason = null } = {}) {
  return withTransaction((client) => releaseBuyHoldWithin(client, orderId, { actor, reason }));
}

/**
 * The same release, INSIDE the caller's transaction — the one that moves the
 * order back to the queue when a member declines it, so the order is never
 * found queued while still holding a team's tokens.
 */
export async function releaseBuyHoldWithin(client, orderId, { actor = 'system', reason = null } = {}) {
  const { rows } = await client.query(
    `UPDATE order_states o SET pool_held_paise = 0
       FROM (SELECT order_id, team_id, pool_held_paise FROM order_states
              WHERE order_id = $1 AND pool_held_paise > 0 FOR UPDATE) prev
      WHERE o.order_id = prev.order_id
      RETURNING prev.team_id, prev.pool_held_paise`, [String(orderId)]);
  if (!rows[0]) return { ok: true, releasedPaise: 0 };
  const teamId = rows[0].team_id;
  const amount = toNum(rows[0].pool_held_paise);
  const { rows: pool } = await client.query(
    `UPDATE team_pools
        SET held_paise = held_paise - $2, available_paise = available_paise + $2, updated_at = now()
      WHERE team_id = $1 RETURNING available_paise, held_paise`, [teamId, amount]);
  await writeEntry(client, {
    txId: entryTx('BUY_RELEASE', orderId), teamId, kind: 'BUY_RELEASE',
    availableDelta: amount, heldDelta: -amount, pool: pool[0], actor, refId: orderId,
    note: reason ? String(reason).slice(0, 200) : null,
  });
  return { ok: true, releasedPaise: amount, teamId };
}

/**
 * Take an order off its team, INSIDE the caller's transaction — the requeue
 * that puts it back for routing (a member declined it, or a queue manager
 * moved it). A buy's hold comes off first, while the order still names the
 * pool it is in; then the team is cleared, so the next one is decided by
 * routing. One commit: the order is never found queued while still holding a
 * team's tokens, nor queued while still naming the team it left.
 */
export async function detachFromTeamWithin(client, orderId, { actor = 'system', reason = null } = {}) {
  const released = await releaseBuyHoldWithin(client, orderId, { actor, reason });
  await client.query('UPDATE order_states SET team_id = NULL WHERE order_id = $1', [String(orderId)]);
  return released;
}

/**
 * A completed BUY: the held tokens leave the pool AND reach the player, in one
 * transaction. Spends the hold when there is one; when the hold was already
 * released (a dispute resolved in the player's favour after expiry) it takes
 * the tokens from `available`, refused by the UPDATE's WHERE if the pool is
 * short. Once per order: a BUY_PAID entry for this order means it is done.
 *
 * ── Both sides, one commit (owner, 2026-10-07) ───────────────────────────────
 * The pool's spend, the player's credit (`wallets.creditBuyWithin`, split by
 * the locked order's own allocation) and TEAM_FLOAT → USER_FLOAT commit
 * together. They were two transactions, and between them the tokens were in
 * neither place — or, if the credit failed for good, in neither place for
 * good. The database now refuses either half alone. Locks: the order, the
 * pool, the player's wallet, then the treasury.
 *
 * `requireState` is the state (or states) the caller read the order in and is
 * about to complete it from. It is asked under the order's row lock, so an
 * order a member rejected, an expiry cancelled or a player disputed since the
 * caller read it is refused here (`order_state`) rather than paid out
 * underneath (§32 S6; security review, 2026-10-03). The spend also stamps
 * `pool_paid_at`, after which the order may only move to COMPLETED.
 *
 * Returns { ok, taken: 'hold' | 'available', userId, amountPaise,
 * depositPaise, reservePaise, balances } or { ok, alreadyTaken }, or
 * { ok: false, reason: 'no_team' | 'pool_short' | 'order_state' |
 * 'already_credited' | 'not_a_buy' } with nothing moved.
 */
export async function spendForBuy(orderId, { actor = 'system', requireState = null } = {}) {
  const oid = String(orderId);
  const states = requireState ? (Array.isArray(requireState) ? requireState : [requireState]) : null;
  try {
    return await withTransaction(async (client) => {
      const { rows: o } = await client.query(
        `SELECT team_id, user_id, order_type, pool_held_paise, token_amount_paise,
                deposit_allocation_paise, reserve_allocation_paise, state
           FROM order_states WHERE order_id = $1 FOR UPDATE`, [oid]);
      if (!o[0]) throw new Refused('not_found');
      if (o[0].order_type !== 'DEPOSIT') throw new Refused('not_a_buy');
      const { rows: done } = await client.query(
        `SELECT 1 FROM team_pool_entries WHERE ref_id = $1 AND kind = 'BUY_PAID' LIMIT 1`, [oid]);
      if (done[0]) return { ok: true, alreadyTaken: true };
      if (states && !states.includes(o[0].state)) throw new Refused('order_state');
      const teamId = o[0].team_id;
      if (!teamId) throw new Refused('no_team');
      const amount = toNum(o[0].token_amount_paise);
      const held = toNum(o[0].pool_held_paise);

      let pool; let taken;
      // The marker that holds the order to COMPLETED from here on, on the row
      // the transition writer re-reads under its lock.
      await client.query('UPDATE order_states SET pool_paid_at = now() WHERE order_id = $1', [oid]);
      if (held > 0) {
        await client.query('UPDATE order_states SET pool_held_paise = 0 WHERE order_id = $1', [oid]);
        ({ rows: pool } = await client.query(
          `UPDATE team_pools SET held_paise = held_paise - $2, updated_at = now()
            WHERE team_id = $1 RETURNING available_paise, held_paise`, [teamId, held]));
        taken = 'hold';
        // A hold is always the whole order; anything else is a defect worth refusing loudly.
        if (held !== amount) throw new Error(`spendForBuy: order ${oid} holds ${held}, owes ${amount}`);
        await writeEntry(client, {
          txId: `pool_buy_paid_${oid}`, teamId, kind: 'BUY_PAID',
          availableDelta: 0, heldDelta: -amount, pool: pool[0], actor, refId: oid,
        });
      } else {
        ({ rows: pool } = await client.query(
          `UPDATE team_pools SET available_paise = available_paise - $2, updated_at = now()
            WHERE team_id = $1 AND available_paise >= $2 RETURNING available_paise, held_paise`, [teamId, amount]));
        if (!pool[0]) throw new Refused('pool_short');
        taken = 'available';
        await writeEntry(client, {
          txId: `pool_buy_paid_${oid}`, teamId, kind: 'BUY_PAID',
          availableDelta: -amount, heldDelta: 0, pool: pool[0], actor, refId: oid,
        });
      }
      // The player's side, under their wallet lock (taken after the pool's).
      const wallet = await lockWalletWithin(client, o[0].user_id);
      const credited = await creditBuyWithin(wallet, {
        orderId: oid, amountPaise: amount,
        depositAllocationPaise: toNum(o[0].deposit_allocation_paise),
        reserveAllocationPaise: toNum(o[0].reserve_allocation_paise),
      });
      // Credited already, with no BUY_PAID beside it: a credit some other path
      // made. Paying the pool out now would hand the player the order twice.
      if (credited.idempotent) throw new Refused('already_credited');
      if (!credited.ok) throw new Refused(credited.refused ?? 'credit_refused');
      const moved = await postMovement({
        client, movementId: `team_buy_${oid}`, operation: 'TEAM_BUY_PAID',
        legs: { [ACCOUNTS.TEAM_FLOAT]: -amount, [ACCOUNTS.USER_FLOAT]: amount },
        actor: String(actor), refModel: 'PaymentOrder', refId: oid, reason: 'Team pool paid a player buy',
      });
      if (!moved.ok) throw new Refused(moved.reason);
      if (moved.idempotent) throw new Refused('already_credited');
      return {
        ok: true, taken, teamId, userId: String(o[0].user_id), amountPaise: amount,
        depositPaise: credited.split.depositPaise, reservePaise: credited.split.reservePaise,
        balances: credited.balancesAfterPaise,
      };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    throw e;
  }
}

/**
 * A SELL has settled: the player's locked stake is consumed and its tokens
 * join the team's pool. Once per order — the entry's tx_id is the order's, so
 * a replay is a no-op.
 *
 * ── Both sides, one commit (owner, 2026-10-07) ───────────────────────────────
 * The pool credit, the stake leaving the player's `locked`
 * (`wallets.consumeWithdrawalStakeWithin`, key `wd_release_<id>`) and
 * USER_FLOAT → TEAM_FLOAT commit together. They were two transactions with a
 * compensating reversal between them: until the second landed the tokens
 * were in the pool AND still the player's, and a failed reversal left them
 * there for good. The database now refuses either half alone. A stake already
 * refunded (`refund_<id>`) refuses the whole settlement (`refunded`).
 *
 * `requireState` is the settlement worker's gate: asked under the order's row
 * lock, so a dispute that moved the order since the worker read it is refused
 * here rather than settled underneath (§32 S6). An admin's release passes none
 * — its route has already moved the order through its own guarded transition.
 */
export async function creditSellToPool(orderId, { actor = 'system', requireState = null } = {}) {
  const oid = String(orderId);
  try {
    return await withTransaction(async (client) => {
      const { rows: o } = await client.query(
        `SELECT team_id, user_id, token_amount_paise, order_type, state FROM order_states WHERE order_id = $1 FOR UPDATE`, [oid]);
      if (!o[0]) throw new Refused('not_found');
      if (o[0].order_type !== 'WITHDRAWAL') throw new Refused('not_a_sell');
      const teamId = o[0].team_id;
      if (!teamId) throw new Refused('no_team');
      const amount = toNum(o[0].token_amount_paise);
      const { rows: done } = await client.query(
        `SELECT 1 FROM team_pool_entries WHERE tx_id = $1`, [`pool_sell_${oid}`]);
      if (done[0]) return { ok: true, alreadyCredited: true };
      if (requireState && o[0].state !== requireState) throw new Refused('order_state');
      await client.query('INSERT INTO team_pools (team_id) VALUES ($1) ON CONFLICT (team_id) DO NOTHING', [teamId]);
      const { rows: pool } = await client.query(
        `UPDATE team_pools SET available_paise = available_paise + $2, updated_at = now()
          WHERE team_id = $1 RETURNING available_paise, held_paise`, [teamId, amount]);
      await writeEntry(client, {
        txId: `pool_sell_${oid}`, teamId, kind: 'SELL_SETTLED',
        availableDelta: amount, heldDelta: 0, pool: pool[0], actor, refId: oid,
      });
      // The player's side, under their wallet lock (taken after the pool's).
      const wallet = await lockWalletWithin(client, o[0].user_id);
      const consumed = await consumeWithdrawalStakeWithin(wallet, { orderId: oid, amountPaise: amount });
      if (consumed.excluded) throw new Refused('refunded');
      // Consumed already with no pool credit beside it: a release some other
      // path made. Crediting the pool now would pay the team for it twice.
      if (consumed.idempotent) throw new Refused('stake_already_consumed');
      if (!consumed.ok) throw new Refused(consumed.refused ?? 'stake_not_locked');
      const moved = await postMovement({
        client, movementId: `team_sell_${oid}`, operation: 'TEAM_SELL_SETTLED',
        legs: { [ACCOUNTS.USER_FLOAT]: -amount, [ACCOUNTS.TEAM_FLOAT]: amount },
        actor: String(actor), refModel: 'PaymentOrder', refId: oid, reason: 'Player sell settled into a team pool',
      });
      if (!moved.ok) throw new Refused(moved.reason);
      if (moved.idempotent) throw new Refused('stake_already_consumed');
      return { ok: true, teamId, userId: String(o[0].user_id) };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    throw e;
  }
}

/**
 * Undo a settled SELL — an admin refunded it after the tokens reached the
 * pool. Takes them back out of `available` (refused by the UPDATE's WHERE if
 * the team has already used them, unless the platform covers it) and returns
 * the consumed stake to the player as winnings
 * (`wallets.returnSettledStakeWithin`, key `dispute_wd_refund_<id>`) — the
 * pool or the platform's holding, the player's wallet and USER_FLOAT in ONE
 * transaction (owner, 2026-10-07). Once per order.
 */
export async function reverseSellFromPool(orderId, { actor = 'system', reason = null, coverShortfall = false } = {}) {
  const oid = String(orderId);
  // The player's half, after the pool's: their wallet lock, then the credit.
  const returnStake = async (client, userId, amount) => {
    const wallet = await lockWalletWithin(client, userId);
    const returned = await returnSettledStakeWithin(wallet, { orderId: oid, amountPaise: amount });
    // Returned already with no reversal beside it: a return some other path
    // made. Taking the tokens from the pool now would refund the sell twice.
    if (returned.idempotent) throw new Refused('already_returned');
    if (!returned.ok) throw new Refused(returned.refused ?? 'return_refused');
    return returned;
  };
  try {
    return await withTransaction(async (client) => {
      const { rows: o } = await client.query(
        `SELECT team_id, user_id, token_amount_paise FROM order_states WHERE order_id = $1 FOR UPDATE`, [oid]);
      if (!o[0]) throw new Refused('not_found');
      const { rows: settled } = await client.query(
        `SELECT 1 FROM team_pool_entries WHERE tx_id = $1`, [`pool_sell_${oid}`]);
      if (!settled[0]) throw new Refused('not_settled');
      const { rows: done } = await client.query(
        `SELECT 1 FROM team_pool_entries WHERE tx_id = $1`, [`pool_sellrev_${oid}`]);
      if (done[0]) return { ok: true, alreadyReversed: true };
      // Covered by the platform already: the tokens are back on the user side,
      // so taking them from the pool now — refilled since — would return them twice.
      const { rows: covered } = await client.query(
        `SELECT 1 FROM treasury_entries WHERE movement_id = $1 LIMIT 1`, [`team_sell_cover_${oid}`]);
      if (covered[0]) return { ok: true, covered: true, alreadyCovered: true };
      const teamId = o[0].team_id;
      const amount = toNum(o[0].token_amount_paise);
      const { rows: pool } = await client.query(
        `UPDATE team_pools SET available_paise = available_paise - $2, updated_at = now()
          WHERE team_id = $1 AND available_paise >= $2 RETURNING available_paise, held_paise`, [teamId, amount]);
      if (!pool[0] && coverShortfall) {
        // A REFUND of a sell the team has already used. The player is made
        // whole regardless, so the PLATFORM covers it from its own holding —
        // TOKEN_SUPPLY → USER_FLOAT, a transfer and never a creation (§2) —
        // and the team is recovered from by a person. Without it the player's
        // wallet grows by tokens no account moved and USER_FLOAT stops
        // describing the wallets. Posted under the order's lock, so a refund
        // retried after the pool refills cannot ALSO take the tokens from it.
        const returned = await returnStake(client, o[0].user_id, amount);
        const moved = await postMovement({
          client, movementId: `team_sell_cover_${oid}`, operation: 'TEAM_SELL_REFUND_COVERED',
          legs: { [ACCOUNTS.TOKEN_SUPPLY]: -amount, [ACCOUNTS.USER_FLOAT]: amount },
          actor: String(actor), refModel: 'PaymentOrder', refId: oid,
          reason: reason || 'Refund of a settled sell the team had already used; covered by the platform',
        });
        if (!moved.ok) throw new Refused(moved.reason);
        if (moved.idempotent) throw new Refused('already_returned');
        return { ok: true, covered: true, teamId, userId: String(o[0].user_id), balances: returned.balancesAfterPaise };
      }
      if (!pool[0]) throw new Refused('pool_short');
      await writeEntry(client, {
        txId: `pool_sellrev_${oid}`, teamId, kind: 'SELL_REVERSED',
        availableDelta: -amount, heldDelta: 0, pool: pool[0], actor, refId: oid,
        note: reason ? String(reason).slice(0, 200) : null,
      });
      const returned = await returnStake(client, o[0].user_id, amount);
      const moved = await postMovement({
        client, movementId: `team_sell_rev_${oid}`, operation: 'TEAM_SELL_REVERSED',
        legs: { [ACCOUNTS.TEAM_FLOAT]: -amount, [ACCOUNTS.USER_FLOAT]: amount },
        actor: String(actor), refModel: 'PaymentOrder', refId: oid, reason: reason || 'Settled sell reversed',
      });
      if (!moved.ok) throw new Refused(moved.reason);
      if (moved.idempotent) throw new Refused('already_returned');
      return { ok: true, teamId, userId: String(o[0].user_id), balances: returned.balancesAfterPaise };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    throw e;
  }
}

/**
 * A team commission (Step 2e) joins the team's pool, INSIDE the transaction
 * that records it (`teamCommission.js`), so the commission row, its shares,
 * the ledger event and these tokens commit together or not at all (§21). The
 * tokens come from the platform's own holding, TOKEN_SUPPLY → TEAM_FLOAT: a
 * transfer, never a creation (§2); the accounting ledger's commission pool is
 * what pays for them. Throws `PoolRefused` to unwind the caller.
 */
export async function creditCommissionWithin(client, { teamId, commissionId, amountPaise, actor = 'system' }) {
  const paise = Number(amountPaise);
  if (!Number.isInteger(paise) || paise <= 0) throw new Error(`creditCommissionWithin: amount must be positive paise, got ${amountPaise}`);
  await client.query('INSERT INTO team_pools (team_id) VALUES ($1) ON CONFLICT (team_id) DO NOTHING', [teamId]);
  const { rows: pool } = await client.query(
    `UPDATE team_pools SET available_paise = available_paise + $2, updated_at = now()
      WHERE team_id = $1 RETURNING available_paise, held_paise`, [teamId, paise]);
  await writeEntry(client, {
    txId: `pool_commission_${commissionId}`, teamId, kind: 'COMMISSION',
    availableDelta: paise, heldDelta: 0, pool: pool[0], actor, refId: commissionId,
  });
  const moved = await postMovement({
    client, movementId: `team_commission_${commissionId}`, operation: 'TEAM_COMMISSION',
    legs: { [ACCOUNTS.TOKEN_SUPPLY]: -paise, [ACCOUNTS.TEAM_FLOAT]: paise },
    actor: String(actor), refModel: 'Team', refId: teamId, reason: 'Team commission paid into the pool',
  });
  if (!moved.ok) throw new Refused(moved.reason);
  // The movement already exists: this commission was paid. Reachable only if
  // the commission row's own once-only key was bypassed; never pay twice.
  if (moved.idempotent) throw new Refused('already_paid');
  return toPool(teamId, pool[0]);
}

/**
 * Holds whose order has ended without spending them — a path that forgot to
 * release. Released by the sweep; the list is the evidence of which path
 * forgot. A COMPLETED buy still holding is NOT here: its player was credited
 * and the hold is owed to them, so releasing it would hand the tokens back
 * to the team. `findCompletedUnspentBuys` reports those for a person.
 *
 * Nor is a REJECTED buy (2c+): it is a buy the member rejected as unpaid,
 * whose tokens stay in escrow while the player may still dispute. Releasing
 * it here would hand the team the tokens inside the player's window; the
 * window sweep (`rejectedBuyWindow.service.js`) releases it when it closes.
 */
export async function findStrandedBuyHolds({ limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT order_id, team_id, pool_held_paise, state FROM order_states
      WHERE pool_held_paise > 0 AND state IN ('CANCELLED', 'FAILED', 'PENDING_QUEUE')
      LIMIT $1`, [limit], 'team_pool_stranded_holds');
  return rows.map((r) => ({ orderId: r.order_id, teamId: r.team_id, heldPaise: toNum(r.pool_held_paise), state: r.state }));
}

/** COMPLETED buys whose hold was never spent — reported, never auto-fixed. */
export async function findCompletedUnspentBuys({ limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT order_id, team_id, pool_held_paise FROM order_states
      WHERE pool_held_paise > 0 AND state = 'COMPLETED' LIMIT $1`, [limit], 'team_pool_unspent_completed');
  return rows.map((r) => ({ orderId: r.order_id, teamId: r.team_id, heldPaise: toNum(r.pool_held_paise) }));
}
