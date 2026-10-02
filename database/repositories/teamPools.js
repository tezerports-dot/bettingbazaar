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
