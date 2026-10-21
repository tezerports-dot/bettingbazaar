// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which team member serves an order (redesign Step 2c, PROJECT_STATUS §3.10).
 *
 * ── The rule (owner, 2026-10-02) ─────────────────────────────────────────────
 * An order goes to an APPROVED MEMBER of a TEAM whose supervisor is approved
 * for the order's rail. A team works with any number of approved members from
 * one to ten (owner, Phase A): there is no team-level gate, because a team
 * with no approved member has nobody this query can return.
 *
 * Inside the eligible members, best first (owner, Phase A):
 *   1. the highest `routing_priority` (1–5, the admin's, default 3);
 *   2. then the fastest average response (`avg_response_minutes`);
 *   3. then the fewest open orders;
 *   4. then whoever has waited longest since their last assignment.
 *
 *   CASH buy  — the member must have pressed Ready (they are at the machine);
 *               the assignment switches Ready off.
 *   CASH sell — not to a member holding an open buy.
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
import { RAILS, railOf } from './orderRails.js';
import { holdForBuyWithin, PoolRefused } from './teamPools.js';
import { leastUsedDepositAccount, takeDepositAccountWithin } from './merchantPaymentAccounts.js';
import { transitionOrder } from './orders.js';

export { RAILS, railOf, PAYMENT_MODES, paymentModeFor, routedToMerchants } from './orderRails.js';

const OPEN_STATES = ['PROCESSING', 'PAID'];

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
    },
    assignmentWaitSeconds: Number(t.assignmentWaitSeconds ?? 1500),   // schema default: 1500
    processingWindowSeconds: {
      CASH: Number(p.CASH ?? 900),          // schema default: 900
      UPI_BANK: Number(p.UPI_BANK ?? 900),  // schema default: 900
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
  // A USDT buy is paid to the platform (owner, 2026-10-18); no member serves one.
  if (rail === RAILS.USDT) {
    throw new TypeError(`routingCandidates: order ${order.orderId} is a USDT buy, which no member serves`);
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
      WHERE tm.status = 'APPROVED'
        AND s.supervisor_rail = $1
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
        -- A UPI/bank buy is paid by bank transfer to the member's own account
        -- (owner, 2026-10-03), so a member without one is not a candidate: the
        -- player would be shown nowhere to pay and take the expiry for it.
        AND (NOT ($3 AND $1 = 'UPI_BANK') OR (
              COALESCE(m.bank_account_no, '') <> '' AND COALESCE(m.bank_ifsc, '') <> ''
          AND COALESCE(m.bank_account_holder_name, '') <> ''))
      ORDER BY m.routing_priority DESC,
               m.avg_response_minutes ASC NULLS LAST,
               COALESCE(o.total, 0) ASC,
               m.last_assigned_at ASC NULLS FIRST,
               m.merchant_id
      LIMIT $6`,
    [rail, cap, isBuy, amount, barred, limit, OPEN_STATES], 'team_routing_candidates');
  return rows.map((r) => ({ merchantId: r.merchant_id, teamId: r.team_id, openOrders: Number(r.open_total) }));
}

/**
 * Assign a PENDING_QUEUE order to the best eligible member, holding a buy's
 * tokens in the team's pool in the same transaction. The order is STARTED
 * (PROCESSING) by that move: there is no accept step (owner, 2026-10-17).
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
      moved = await transitionOrder(order.orderId, 'PROCESSING', {
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

// ═════════════════════════════════════════════════════════════════════════════
// Merchant accounts (owner, 2026-10-11 — Phase B)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * An INR order stamped MERCHANTS (`order_states.inr_routing`, stamped with
 * the routing the admin chose for its size and direction at creation) goes to a MERCHANT ACCOUNT — a DIRECT team's
 * owner — instead of an agent. Eligible: the owner is online, ACTIVE and
 * approved, an INR merchant, switched on for the direction, under the
 * per-direction cap (`merchantRouting.concurrency`), not barred from this
 * order or player, and has an ACTIVE payment account for the direction
 * (`accepts_deposits` for a buy, `pays_withdrawals` for a sell). On a buy the
 * pool hold is the check, taken in the assigning transaction as for a team.
 *
 * Best first, as for agents: `routing_priority` DESC, the average response
 * ASC, the open orders in this direction ASC, then whoever has waited longest.
 */

/** The merchant-account routing settings, with the schema defaults (config.spec.js merchantRouting). */
export function merchantRoutingSettings(cfg) {
  const r = cfg?.merchantRouting ?? {};
  const c = r.concurrency ?? {};
  const p = r.processingWindowSeconds ?? {};
  return {
    concurrency: {
      DEPOSIT: Number(c.DEPOSIT ?? 10),       // schema default: 10
      WITHDRAWAL: Number(c.WITHDRAWAL ?? 10), // schema default: 10
    },
    assignmentWaitSeconds: Number(r.assignmentWaitSeconds ?? 1500), // schema default: 1500
    processingWindowSeconds: {
      DEPOSIT: Number(p.DEPOSIT ?? 900),       // schema default: 900
      WITHDRAWAL: Number(p.WITHDRAWAL ?? 900), // schema default: 900
    },
  };
}

/** The eligible merchant accounts for an order, best first. A READ; `assignToDirect` re-checks under a lock. */
export async function directCandidates(order, { cap, barredMerchantIds = [], limit = 20 }) {
  const isBuy = order.type === 'DEPOSIT';
  const amount = Number(order.tokenAmountPaise);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new TypeError(`directCandidates: order ${order.orderId} has no token amount in paise`);
  }
  const barred = [...new Set((barredMerchantIds || []).filter(Boolean).map(String))];
  const { rows } = await pgQuery(
    `WITH open_by_direction AS (
       SELECT merchant_id,
              count(*) FILTER (WHERE order_type = 'DEPOSIT')::int    AS buys_open,
              count(*) FILTER (WHERE order_type = 'WITHDRAWAL')::int AS sells_open
         FROM order_states
        WHERE merchant_id IS NOT NULL AND state = ANY($6)
        GROUP BY merchant_id)
     SELECT owner.merchant_id, t.team_id,
            COALESCE(CASE WHEN $2 THEN ob.buys_open ELSE ob.sells_open END, 0) AS open_this_way
       FROM teams t
       JOIN merchants owner ON owner.merchant_id = t.owner_merchant_id
       LEFT JOIN team_pools pool ON pool.team_id = t.team_id
       LEFT JOIN open_by_direction ob ON ob.merchant_id = owner.merchant_id
      WHERE t.kind = 'DIRECT'
        AND owner.status = 'ACTIVE'
        AND owner.merchant_approval_status = 'APPROVED'
        AND owner.is_online
        AND owner.assignment_paused_at IS NULL
        AND (CASE WHEN $2 THEN owner.accepts_deposits ELSE owner.accepts_withdrawals END)
        AND COALESCE(CASE WHEN $2 THEN ob.buys_open ELSE ob.sells_open END, 0) < $1
        AND (NOT $2 OR COALESCE(pool.available_paise, 0) >= $3)
        AND NOT (owner.merchant_id = ANY($4))
        AND EXISTS (SELECT 1 FROM merchant_payment_accounts acct
                     WHERE acct.merchant_id = owner.merchant_id AND acct.status = 'ACTIVE'
                       AND (CASE WHEN $2 THEN acct.accepts_deposits ELSE acct.pays_withdrawals END)
                       AND ($3 / 100)::int = ANY (CASE WHEN $2 THEN acct.buy_sizes ELSE acct.sell_sizes END))
      ORDER BY owner.routing_priority DESC,
               owner.avg_response_minutes ASC NULLS LAST,
               open_this_way ASC,
               owner.last_assigned_at ASC NULLS FIRST,
               owner.merchant_id
      LIMIT $5`,
    [cap, isBuy, amount, barred, limit, OPEN_STATES], 'direct_routing_candidates');
  return rows.map((r) => ({ merchantId: r.merchant_id, teamId: r.team_id, openOrders: Number(r.open_this_way) }));
}

/**
 * Assign a PENDING_QUEUE order to the best eligible merchant account. On a
 * buy: the payment account (least recently used) is taken under its lock and
 * named on the order, and the tokens are HELD in the merchant account's pool —
 * all in the transaction that moves the order. `buildSet(candidate, account)`
 * builds the snapshot naming both.
 *
 * Returns { ok: true, order, merchantId, teamId, payAccountId } or
 * { ok: false, reason: 'no_candidate' | 'no_pay_account' | 'merchant_busy' |
 * 'pool_short' | 'member_unavailable' | 'not_queued' }.
 */
export async function assignToDirect(order, { cap, barredMerchantIds = [], buildSet, actor = 'assignment' }) {
  const isBuy = order.type === 'DEPOSIT';
  const oid = String(order.orderId);
  const candidates = await directCandidates(order, { cap, barredMerchantIds });
  // The order's size in tokens: the account must take it (owner, 2026-10-20).
  const sizeTokens = Number(order.tokenAmountPaise) / 100;
  let lastRefusal = 'no_candidate';

  for (const cand of candidates) {
    const account = isBuy ? await leastUsedDepositAccount(cand.merchantId, sizeTokens) : null;
    if (isBuy && !account) { lastRefusal = 'no_pay_account'; continue; }
    const set = { ...(await buildSet(cand, account)), merchantId: cand.merchantId };
    let moved;
    try {
      moved = await transitionOrder(oid, 'PROCESSING', {
        set, actor, reason: `Assigned to merchant account ${cand.teamId}`,
        within: async (client) => {
          const { rows: owner } = await client.query(
            `SELECT is_online, status FROM merchants WHERE merchant_id = $1 FOR UPDATE`, [cand.merchantId]);
          if (!owner[0]?.is_online || owner[0].status !== 'ACTIVE') throw new PoolRefused('member_unavailable');
          // Counted AGAIN after the lock, in this direction only.
          const { rows: open } = await client.query(
            `SELECT count(*)::int AS n FROM order_states
              WHERE merchant_id = $1 AND state = ANY($2) AND order_type = $3 AND order_id <> $4`,
            [cand.merchantId, OPEN_STATES, order.type, oid]);
          if (open[0].n >= cap) throw new PoolRefused('merchant_busy');
          if (isBuy) {
            const taken = await takeDepositAccountWithin(client, cand.merchantId, account.accountId, sizeTokens);
            if (!taken) throw new PoolRefused('no_pay_account');
            await holdForBuyWithin(client, {
              orderId: oid, teamId: cand.teamId, amountPaise: order.tokenAmountPaise, actor,
            });
            await client.query('UPDATE order_states SET pay_account_id = $2 WHERE order_id = $1',
              [oid, account.accountId]);
          } else {
            await client.query('UPDATE order_states SET team_id = $2 WHERE order_id = $1 AND team_id IS NULL',
              [oid, cand.teamId]);
          }
          await client.query('UPDATE merchants SET last_assigned_at = now() WHERE merchant_id = $1', [cand.merchantId]);
        },
      });
    } catch (e) {
      if (e instanceof PoolRefused) { lastRefusal = e.reason; continue; }
      throw e;
    }
    if (!moved.ok || moved.idempotent) return { ok: false, reason: 'not_queued' };
    return {
      ok: true, order: moved.order, merchantId: cand.merchantId, teamId: cand.teamId,
      payAccountId: account?.accountId ?? null,
    };
  }
  return { ok: false, reason: lastRefusal };
}
