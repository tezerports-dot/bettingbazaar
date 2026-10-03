// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which team member serves an order (redesign Step 2c, PROJECT_STATUS §3.10).
 *
 * ── The rule (owner, 2026-10-02) ─────────────────────────────────────────────
 * An order goes to a MEMBER of a TEAM whose supervisor is approved for the
 * order's rail, and only while that team is working (ten members, or short
 * since today in IST). Inside the eligible members, the one with the fewest
 * open orders; ties to whoever was assigned least recently.
 *
 *   CASH buy  — the member must have pressed Ready (they are at the machine);
 *               the assignment switches Ready off.
 *   CASH sell — not to a member holding an open buy.
 *   USDT      — the member must hold an address on the order's chain.
 *   any buy   — the team's pool must cover it, and it is HELD in the pool in
 *               the same transaction that assigns the order.
 *
 * ── Why the member is re-checked under a lock ────────────────────────────────
 * The candidate query is a READ. Two orders arriving together would both see
 * a member with one free place and both take it (§32 S6). So each candidate
 * is taken inside the order's own transition: the member's row is locked, the
 * open orders are COUNTED AGAIN in a new statement — which sees every
 * assignment committed before the lock was granted — and only then is the
 * order moved. A refusal unwinds the move and the next candidate is tried.
 */
import { pgQuery } from '../client.js';
import { STRENGTH_SQL } from './teams.js';
import { RAILS, railOf } from './orderRails.js';
import { holdForBuyWithin, PoolRefused } from './teamPools.js';
import { transitionOrder } from './orders.js';
import { USDT_CHAIN_SPEC } from '../../backend/domains/merchant/merchantCurrency.js';

export { RAILS, railOf, PAYMENT_MODES, paymentModeFor } from './orderRails.js';

const OPEN_STATES = ['ASSIGNED', 'PROCESSING', 'PAID'];

/**
 * The routing settings, with the schema defaults (config.spec.js teamRouting)
 * for any key absent from the stored document.
 */
export function routingSettings(cfg) {
  const t = cfg?.teamRouting ?? {};
  const c = t.concurrency ?? {};
  const p = t.processingWindowSeconds ?? {};
  return {
    concurrency: {
      CASH: Number(c.CASH ?? 1),          // schema default: 1
      UPI_BANK: Number(c.UPI_BANK ?? 3),  // schema default: 3
      USDT: Number(c.USDT ?? 3),          // schema default: 3
    },
    assignmentWaitSeconds: Number(t.assignmentWaitSeconds ?? 1500),   // schema default: 1500
    processingWindowSeconds: {
      CASH: Number(p.CASH ?? 900),          // schema default: 900
      UPI_BANK: Number(p.UPI_BANK ?? 900),  // schema default: 900
      USDT: Number(p.USDT ?? 900),          // schema default: 900
    },
    utrSubmitSeconds: Number(t.utrSubmitSeconds ?? 60),  // schema default: 60
  };
}

/**
 * The eligible members for an order, best first. A READ — the caller takes a
 * candidate only through `assignToTeam`, which re-checks under a lock.
 *
 * A member's own two switches — "Accept deposit orders" / "Accept withdrawal
 * orders", `merchants.accepts_deposits` / `accepts_withdrawals`, written by
 * PUT /api/merchant/preferences and the admin's capabilities route — are read
 * HERE, per direction. They are the only consumer: 2c deleted the assignment
 * query and the accept check that used to read them, and for that window a
 * member who switched buys off was told it saved and kept being handed buys
 * (§3, §32 S5).
 */
export async function routingCandidates(order, { cap, barredMerchantIds = [], limit = 20 }) {
  const rail = railOf(order);
  const isBuy = order.type === 'DEPOSIT';
  const amount = Number(order.tokenAmountPaise);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new TypeError(`routingCandidates: order ${order.orderId} has no token amount in paise`);
  }
  let chainColumn = null;
  if (rail === RAILS.USDT) {
    chainColumn = USDT_CHAIN_SPEC[order.usdtChain]?.column ?? null;
    // An unknown chain is a throw, not an empty list: "nobody is free" would
    // be the wrong sentence on a malformed order.
    if (!chainColumn) throw new TypeError(`routingCandidates: unknown usdtChain '${order.usdtChain}'`);
  }
  const barred = [...new Set((barredMerchantIds || []).filter(Boolean).map(String))];

  const { rows } = await pgQuery(
    `WITH open AS (
       SELECT merchant_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE order_type = 'DEPOSIT')::int AS buys
         FROM order_states
        WHERE merchant_id IS NOT NULL AND state = ANY($7)
        GROUP BY merchant_id)
     SELECT m.merchant_id, t.team_id, COALESCE(o.total, 0) AS open_total
       FROM team_members tm
       JOIN teams t     ON t.team_id = tm.team_id
       JOIN merchants s ON s.merchant_id = t.supervisor_id
       JOIN merchants m ON m.merchant_id = tm.merchant_id
       LEFT JOIN team_pools p ON p.team_id = t.team_id
       LEFT JOIN open o ON o.merchant_id = m.merchant_id
       CROSS JOIN LATERAL (
         SELECT count(*) FILTER (WHERE status = 'APPROVED')::int AS approved_count
           FROM team_members WHERE team_id = t.team_id) c
      WHERE tm.status = 'APPROVED'
        AND s.supervisor_rail = $1
        AND (${STRENGTH_SQL}) IN ('WORKING', 'GRACE')
        AND m.status = 'ACTIVE'
        AND m.merchant_approval_status = 'APPROVED'
        AND m.is_online
        AND m.assignment_paused_at IS NULL
        AND (CASE WHEN $3 THEN m.accepts_deposits ELSE m.accepts_withdrawals END)
        AND COALESCE(o.total, 0) < $2
        AND (NOT $3 OR COALESCE(p.available_paise, 0) >= $4)
        AND (NOT ($3 AND $1 = 'CASH') OR m.cash_ready)
        AND (NOT (NOT $3 AND $1 = 'CASH') OR COALESCE(o.buys, 0) = 0)
        AND NOT (m.merchant_id = ANY($5))
        ${chainColumn ? `AND m.${chainColumn} IS NOT NULL AND m.${chainColumn} <> ''` : ''}
      ORDER BY COALESCE(o.total, 0) ASC, m.last_assigned_at ASC NULLS FIRST, m.merchant_id
      LIMIT $6`,
    [rail, cap, isBuy, amount, barred, limit, OPEN_STATES], 'team_routing_candidates');
  return rows.map((r) => ({ merchantId: r.merchant_id, teamId: r.team_id, openOrders: Number(r.open_total) }));
}

/**
 * Assign a PENDING_QUEUE order to the best eligible member, holding a buy's
 * tokens in the team's pool in the same transaction.
 *
 * `set` carries the fields written with the move (snapshot, expiry, rate) —
 * `buildSet(candidate)` is called per candidate, because the snapshot names
 * the member.
 *
 * Returns { ok: true, order, merchantId, teamId } or { ok: false, reason }:
 *   no_candidate — nobody eligible (the order stays queued)
 *   not_queued   — another path already moved it
 */
export async function assignToTeam(order, { cap, barredMerchantIds = [], buildSet, actor = 'assignment' }) {
  const rail = railOf(order);
  const isBuy = order.type === 'DEPOSIT';
  const candidates = await routingCandidates(order, { cap, barredMerchantIds });
  let lastRefusal = 'no_candidate';

  for (const cand of candidates) {
    const set = { ...(await buildSet(cand)), merchantId: cand.merchantId };
    let moved;
    try {
      moved = await transitionOrder(order.orderId, 'ASSIGNED', {
        set, actor, reason: `Assigned to a member of team ${cand.teamId}`,
        within: async (client) => {
          // The member, locked: every assignment to them serialises here.
          const { rows: m } = await client.query(
            `SELECT is_online, cash_ready, status FROM merchants WHERE merchant_id = $1 FOR UPDATE`,
            [cand.merchantId]);
          if (!m[0]?.is_online || m[0].status !== 'ACTIVE') throw new PoolRefused('member_unavailable');
          if (isBuy && rail === RAILS.CASH && !m[0].cash_ready) throw new PoolRefused('member_not_ready');
          // Counted AGAIN, in a statement that starts after the lock: it sees
          // every assignment committed before this one was allowed to proceed.
          const { rows: c } = await client.query(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE order_type = 'DEPOSIT')::int AS buys
               FROM order_states
              WHERE merchant_id = $1 AND state = ANY($2) AND order_id <> $3`,
            [cand.merchantId, OPEN_STATES, String(order.orderId)]);
          if (c[0].total >= cap) throw new PoolRefused('member_busy');
          if (!isBuy && rail === RAILS.CASH && c[0].buys > 0) throw new PoolRefused('member_has_cash_buy');

          if (isBuy) {
            await holdForBuyWithin(client, {
              orderId: order.orderId, teamId: cand.teamId, amountPaise: order.tokenAmountPaise, actor,
            });
          } else {
            await client.query('UPDATE order_states SET team_id = $2 WHERE order_id = $1',
              [String(order.orderId), cand.teamId]);
          }
          await client.query(
            `UPDATE merchants
                SET last_assigned_at = now(),
                    cash_ready = CASE WHEN $2 THEN FALSE ELSE cash_ready END
              WHERE merchant_id = $1`,
            [cand.merchantId, isBuy && rail === RAILS.CASH]);
        },
      });
    } catch (e) {
      if (e instanceof PoolRefused) { lastRefusal = e.reason; continue; }
      throw e;
    }
    if (!moved.ok) return { ok: false, reason: 'not_queued' };
    if (moved.idempotent) return { ok: false, reason: 'not_queued' };
    return { ok: true, order: moved.order, merchantId: cand.merchantId, teamId: cand.teamId };
  }
  return { ok: false, reason: lastRefusal };
}

/** A CASH member says they are at the machine, or no longer are. */
export async function setCashReady(merchantId, ready) {
  const { rows } = await pgQuery(
    `UPDATE merchants SET cash_ready = $2
      WHERE merchant_id = $1
        AND EXISTS (SELECT 1 FROM team_members tm JOIN teams t ON t.team_id = tm.team_id
                      JOIN merchants s ON s.merchant_id = t.supervisor_id
                     WHERE tm.merchant_id = $1 AND tm.status = 'APPROVED' AND s.supervisor_rail = 'CASH')
      RETURNING cash_ready`,
    [String(merchantId), Boolean(ready)], 'team_routing_cash_ready');
  return rows[0] ? { ok: true, ready: rows[0].cash_ready } : { ok: false, reason: 'not_cash_member' };
}
