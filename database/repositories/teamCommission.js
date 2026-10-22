// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Order commission (owner, 2026-10-21; replaces the matched-volume cycle of
 * 2026-10-02).
 *
 * Every COMPLETED order a team served earns a percent of its tokens, paid as
 * tokens into that team's pool out of the platform's commission pool: a buy
 * (a player's deposit) `orderCommission.depositPercent`, a sell (a player's
 * withdrawal) `orderCommission.withdrawalPercent` — 5 and 5 by default, both
 * the admin's (Admin › Settings). Rounded down to the paisa. An agents' team
 * records 16% of each payment to its supervisor and the rest to its approved
 * members in equal parts; a merchant account records the whole payment to its
 * owner. The tokens themselves sit in the pool.
 *
 * ── Once per order ───────────────────────────────────────────────────────────
 * One `team_commissions` row per order, keyed by the order (`commission_id`
 * `tcm~<orderId>` and the unique `order_id`). A second payment for the same
 * order collides and moves nothing. The row records the order's tokens and
 * the rate it was paid at, in basis points, and its CHECK holds the sum to
 * them, so every writer pays exactly that.
 *
 * ── Never partial ────────────────────────────────────────────────────────────
 * The platform's commission pool is `MERCHANT_BONUS_POOL` in the accounting
 * ledger, which an admin funds from distributable revenue. A commission it
 * cannot cover in full is not paid; the order stays owed, and the sweep (or
 * the admin's next top-up) pays it whole (§26).
 *
 * ── One transaction, one payment at a time ───────────────────────────────────
 * The commission row, its shares, the ledger event, the pool credit and the
 * treasury movement commit together (§21). The commission pool's balance is a
 * gate read and then spent, so every payment takes the same advisory lock
 * first: the gate is a serialised write, not a snapshot (§32 S6, trap 18).
 */
import { pgQuery, withTransaction } from '../client.js';
import { getSystemConfig } from './config.js';
import { creditCommissionWithin, PoolRefused } from './teamPools.js';
import { recordEvent, accountBalancePaise } from './ledger.core.js';
import { ACCOUNTS as LEDGER, EVENT_TYPES, buildBonusIssuePostings } from '../../backend/domains/revenue/chartOfAccounts.js';

/** Of each payment, recorded to the supervisor; the rest to the members equally (owner). */
export const SUPERVISOR_SHARE_PERCENT = 16;
export const SHARE_ROLES = Object.freeze({ SUPERVISOR: 'SUPERVISOR', MEMBER: 'MEMBER', OWNER: 'OWNER' });

const PAY_LOCK = `SELECT pg_advisory_xact_lock(hashtext('bb_team_commission_pay'))`;
const toNum = (v) => Number(v ?? 0);
const bpOf = (percent, fallback) => {
  const n = Number(percent ?? fallback);
  return Number.isFinite(n) && n >= 0 && n <= 20 ? Math.round(n * 100) : Math.round(fallback * 100);
};

/**
 * The admin's two rates, in percent and in basis points (hundredths of a
 * percent), with the schema defaults (config.spec.js `orderCommission`).
 */
export function commissionRates(cfg) {
  const c = cfg?.orderCommission ?? {};
  const deposit = bpOf(c.depositPercent, 5);     // schema default: 5
  const withdrawal = bpOf(c.withdrawalPercent, 5); // schema default: 5
  return {
    depositPercent: deposit / 100, withdrawalPercent: withdrawal / 100,
    bp: { DEPOSIT: deposit, WITHDRAWAL: withdrawal },
  };
}

/** `bp` basis points of an order's tokens, rounded down to the paisa. The CHECK does the same sum. */
export function commissionFor(basePaise, bp) {
  const base = Number(basePaise);
  const rate = Number(bp);
  return base > 0 && rate > 0 ? Math.floor((base * rate) / 10000) : 0;
}

/**
 * The 16/84 split of one payment, adding up to it exactly. The members' part
 * is shared equally; the paise that do not divide go one each to the first
 * members by id, so the record never claims more or less than was paid. A
 * team with no approved members left records it all to the supervisor.
 */
export function splitShares(commissionPaise, supervisorId, memberIds) {
  const total = Number(commissionPaise);
  const supervisor = String(supervisorId);
  const members = [...new Set(memberIds.map(String))].filter((m) => m !== supervisor).sort();
  if (!members.length) return [{ merchantId: supervisor, role: SHARE_ROLES.SUPERVISOR, sharePaise: total }];
  const supervisorShare = Math.floor((total * SUPERVISOR_SHARE_PERCENT) / 100);
  const rest = total - supervisorShare;
  const each = Math.floor(rest / members.length);
  const extra = rest - each * members.length;
  return [
    { merchantId: supervisor, role: SHARE_ROLES.SUPERVISOR, sharePaise: supervisorShare },
    ...members.map((m, i) => ({ merchantId: m, role: SHARE_ROLES.MEMBER, sharePaise: each + (i < extra ? 1 : 0) })),
  ];
}

/**
 * A team's completed volume and its commission, as one SQL fragment: the
 * payment's sweep and every screen read the same one (§32 S11). `team` is the
 * SQL that names the team — a parameter or a column. Tokens, never fiat (trap
 * 15). `unpaid_*` are completed orders with no commission row yet.
 */
export const teamCommissionSql = (team) => `
  SELECT COALESCE(SUM(o.token_amount_paise) FILTER (WHERE o.order_type = 'DEPOSIT'), 0)    AS buys_paise,
         COALESCE(SUM(o.token_amount_paise) FILTER (WHERE o.order_type = 'WITHDRAWAL'), 0) AS sells_paise,
         COALESCE(SUM(o.token_amount_paise) FILTER (WHERE o.order_type = 'DEPOSIT' AND c.order_id IS NULL), 0)    AS unpaid_buys_paise,
         COALESCE(SUM(o.token_amount_paise) FILTER (WHERE o.order_type = 'WITHDRAWAL' AND c.order_id IS NULL), 0) AS unpaid_sells_paise,
         (SELECT COALESCE(SUM(commission_paise), 0) FROM team_commissions WHERE team_id = ${team}) AS paid_paise
    FROM order_states o
    LEFT JOIN team_commissions c ON c.order_id = o.order_id
   WHERE o.team_id = ${team} AND o.state = 'COMPLETED'`;

/**
 * A team's commission picture from a row carrying the columns above. The
 * rates are the admin's now; `owedPaise` is what the orders still unpaid earn
 * at them (rounded per direction, so it can read a paisa above the per-order
 * payments that settle it).
 */
export function toSummary(teamId, row, rates, { kind = 'AGENT' } = {}) {
  const r = rates ?? commissionRates(null);
  return {
    teamId: String(teamId),
    buysPaise: toNum(row?.buys_paise),
    sellsPaise: toNum(row?.sells_paise),
    paidPaise: toNum(row?.paid_paise),
    // Earned by orders already completed and not paid yet: the commission pool
    // could not cover it, or the payment after the completion did not run.
    // The sweep and the admin's next top-up pay it.
    owedPaise: commissionFor(row?.unpaid_buys_paise, r.bp.DEPOSIT) + commissionFor(row?.unpaid_sells_paise, r.bp.WITHDRAWAL),
    // The rule itself, so no screen keeps its own copy of the numbers (§4).
    depositPercent: r.depositPercent,
    withdrawalPercent: r.withdrawalPercent,
    supervisorSharePercent: kind === 'DIRECT' ? 0 : SUPERVISOR_SHARE_PERCENT,
  };
}

/**
 * Pay one completed order's commission into the pool of the team that served
 * it. Safe to call any number of times, from any path: an order already paid,
 * not completed, served by no team or at a rate of 0 moves nothing.
 *
 * Returns { ok: true, paid: true, commission, shares, pool }
 *       | { ok: true, paid: false, reason: 'not_completed' | 'no_team' | 'rate_zero' | 'too_small' | 'already_paid' }
 *       | { ok: false, reason: 'order_not_found' | 'pool_short' | <treasury reason>, … }
 */
export async function payOrderCommission(orderId, { actor = 'system' } = {}) {
  const oid = String(orderId);
  const rates = commissionRates(await getSystemConfig());
  try {
    return await withTransaction(async (client) => {
      await client.query(PAY_LOCK);
      const { rows: [order] } = await client.query(
        `SELECT o.order_id, o.order_type, o.state, o.token_amount_paise, o.team_id,
                t.kind, t.supervisor_id, t.owner_merchant_id
           FROM order_states o LEFT JOIN teams t ON t.team_id = o.team_id
          WHERE o.order_id = $1`, [oid]);
      if (!order) return { ok: false, reason: 'order_not_found' };
      if (order.state !== 'COMPLETED') return { ok: true, paid: false, reason: 'not_completed' };
      if (!order.team_id || !order.kind) return { ok: true, paid: false, reason: 'no_team' };
      const { rows: done } = await client.query('SELECT 1 FROM team_commissions WHERE order_id = $1', [oid]);
      if (done[0]) return { ok: true, paid: false, reason: 'already_paid' };

      const bp = rates.bp[order.order_type] ?? 0;
      if (bp <= 0) return { ok: true, paid: false, reason: 'rate_zero' };
      const base = toNum(order.token_amount_paise);
      const amount = commissionFor(base, bp);
      if (amount <= 0) return { ok: true, paid: false, reason: 'too_small' };

      const poolPaise = await accountBalancePaise(LEDGER.MERCHANT_BONUS_POOL.code, { client });
      if (poolPaise < amount) return { ok: false, reason: 'pool_short', owedPaise: amount, poolPaise };

      const teamId = order.team_id;
      const direct = order.kind === 'DIRECT';
      const commissionId = `tcm~${oid}`;
      const { rows: [paid] } = await client.query(
        `INSERT INTO team_commissions
           (commission_id, team_id, supervisor_id, order_id, order_type, base_paise, commission_bp, commission_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING created_at`,
        [commissionId, teamId, direct ? null : order.supervisor_id, oid, order.order_type, base, bp, amount]);

      let shares;
      if (direct) {
        shares = [{ merchantId: order.owner_merchant_id, role: SHARE_ROLES.OWNER, sharePaise: amount }];
      } else {
        const { rows: members } = await client.query(
          `SELECT merchant_id FROM team_members WHERE team_id = $1 AND status = 'APPROVED'`, [teamId]);
        shares = splitShares(amount, order.supervisor_id, members.map((m) => m.merchant_id));
      }
      await client.query(
        `INSERT INTO team_commission_shares (commission_id, merchant_id, role, share_paise)
         SELECT $1, s.merchant_id, s.role, s.share_paise
           FROM unnest($2::text[], $3::text[], $4::bigint[]) AS s(merchant_id, role, share_paise)`,
        [commissionId, shares.map((s) => s.merchantId), shares.map((s) => s.role), shares.map((s) => s.sharePaise)]);

      const label = order.order_type === 'DEPOSIT' ? 'deposit' : 'withdrawal';
      const event = await recordEvent({
        client,
        eventType: EVENT_TYPES.MERCHANT_BONUS_ISSUED,
        idempotencyKey: `acct_${commissionId}`,
        postings: buildBonusIssuePostings(amount).map((p) => ({ account: p.account, amountPaise: p.amountMinor })),
        refModel: 'Team', refId: teamId, amountPaise: amount,
        description: `Order commission: ${bp / 100}% of ${label} ${oid} (${base / 100} tokens)`,
      });
      // The commission row above is new, so its event cannot exist; one that
      // does was posted outside this module. Never pay against it twice.
      if (event.idempotent) throw new Error(`payOrderCommission: ledger already holds ${commissionId}`);

      const pool = await creditCommissionWithin(client, { teamId, commissionId, amountPaise: amount, actor });
      return {
        ok: true, paid: true,
        commission: {
          commissionId, teamId, orderId: oid, orderType: order.order_type,
          basePaise: base, commissionBp: bp, commissionPaise: amount, createdAt: paid.created_at,
        },
        shares, pool,
      };
    });
  } catch (e) {
    if (e instanceof PoolRefused) return { ok: false, reason: e.reason };
    // A payment for the same order landed first (the lock makes this a
    // replay, not a race): nothing moved here.
    if (e.code === '23505' && /team_commissions_(once_per_order|pkey)/.test(e.constraint ?? '')) {
      return { ok: true, paid: false, reason: 'already_paid' };
    }
    throw e;
  }
}

/**
 * Completed orders a team served with no commission yet, at a rate above 0 —
 * what the sweep pays, oldest first.
 */
export async function ordersOwed({ limit = 200 } = {}) {
  const { bp } = commissionRates(await getSystemConfig());
  const { rows } = await pgQuery(
    `SELECT o.order_id, o.team_id FROM order_states o
      WHERE o.state = 'COMPLETED' AND o.team_id IS NOT NULL
        AND ((o.order_type = 'DEPOSIT' AND $2::int > 0) OR (o.order_type = 'WITHDRAWAL' AND $3::int > 0))
        AND NOT EXISTS (SELECT 1 FROM team_commissions c WHERE c.order_id = o.order_id)
      ORDER BY o.completed_at NULLS FIRST, o.order_id LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000), bp.DEPOSIT, bp.WITHDRAWAL], 'team_commission_owed');
  return rows.map((r) => ({ orderId: r.order_id, teamId: r.team_id }));
}

/** Pay every order that is owed. One transaction per order; one refusal does not stop the rest. */
export async function payOwedCommissions({ actor = 'system:commission-sweep' } = {}) {
  const results = [];
  for (const { orderId, teamId } of await ordersOwed()) {
    try {
      const out = await payOrderCommission(orderId, { actor });
      results.push({ orderId, teamId, ...out });
      // The commission pool is short: every later order would be refused the
      // same way. Wait for the admin's top-up.
      if (out.reason === 'pool_short') break;
    } catch (e) {
      results.push({ orderId, teamId, ok: false, reason: 'error', error: e.message });
    }
  }
  return results;
}

/** One team's commission picture, for its supervisor, its members, its owner and the admin. */
export async function teamSummary(teamId) {
  const { rows } = await pgQuery(
    `SELECT v.*, (SELECT kind FROM teams WHERE team_id = $1) AS kind FROM (${teamCommissionSql('$1')}) v`,
    [String(teamId)], 'team_commission_summary');
  return toSummary(teamId, rows[0], commissionRates(await getSystemConfig()), { kind: rows[0]?.kind ?? 'AGENT' });
}

/**
 * A team's payments, newest first, each naming its order. With `merchantId`,
 * each payment also carries that merchant's own share (0 when they were not
 * in the team then).
 */
export async function listCommissions(teamId, { merchantId = null, limit = 20 } = {}) {
  const { rows } = await pgQuery(
    `SELECT c.commission_id, c.order_id, c.order_type, c.base_paise, c.commission_bp, c.commission_paise, c.created_at,
            COALESCE((SELECT s.share_paise FROM team_commission_shares s
                       WHERE s.commission_id = c.commission_id AND s.merchant_id = $2), 0) AS my_share_paise
       FROM team_commissions c
      WHERE c.team_id = $1
      ORDER BY c.created_at DESC, c.commission_id DESC
      LIMIT $3`,
    [String(teamId), merchantId === null ? null : String(merchantId), Math.min(Math.max(Number(limit) || 20, 1), 200)],
    'team_commission_list');
  return rows.map((r) => ({
    commissionId: r.commission_id,
    teamId: String(teamId),
    orderId: r.order_id ?? null,
    orderType: r.order_type ?? null,
    basePaise: toNum(r.base_paise),
    commissionPercent: r.commission_bp === null ? null : Number(r.commission_bp) / 100,
    commissionPaise: toNum(r.commission_paise),
    mySharePaise: toNum(r.my_share_paise),
    createdAt: r.created_at,
  }));
}

/** The shares recorded for one payment. */
export async function listShares(commissionId) {
  const { rows } = await pgQuery(
    `SELECT merchant_id, role, share_paise FROM team_commission_shares
      WHERE commission_id = $1 ORDER BY role DESC, merchant_id`,
    [String(commissionId)], 'team_commission_shares');
  return rows.map((r) => ({ merchantId: r.merchant_id, role: r.role, sharePaise: toNum(r.share_paise) }));
}

/** Everything recorded to one merchant across every payment, in paise. */
export async function earnedBy(merchantId) {
  const { rows } = await pgQuery(
    'SELECT COALESCE(SUM(share_paise), 0) AS paise FROM team_commission_shares WHERE merchant_id = $1',
    [String(merchantId)], 'team_commission_earned_by');
  return toNum(rows[0]?.paise);
}
