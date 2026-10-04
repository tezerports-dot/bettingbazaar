// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Team commission (owner, 2026-10-02 — PROJECT_STATUS §3.10, Step 2e).
 *
 * A team's MATCHED volume is min(completed buys, completed sells), in tokens.
 * Each time it rises above the team's high-water mark — even by 500 — 10% of
 * the rise is paid as tokens into the team's pool, out of the platform's
 * commission pool. 16% of each payment is recorded to the supervisor and 84%
 * to the approved members in equal parts, so each person sees what they
 * earned; the tokens themselves sit in the pool. It replaces the per-merchant,
 * per-variety engine (deleted in 2c).
 *
 * ── The mark is the rows ─────────────────────────────────────────────────────
 * One `team_commissions` row per rise, keyed by where it started and where it
 * ended. The mark is the highest `to_high_paise` the team has; nothing else
 * stores it, so it cannot disagree with what was paid (§26: the mark is read
 * from the idempotency key). A payment from a mark already paid from collides
 * on `team_commissions_from_once` and moves nothing.
 *
 * ── Never partial ────────────────────────────────────────────────────────────
 * The platform's commission pool is `MERCHANT_BONUS_POOL` in the accounting
 * ledger, which an admin funds from distributable revenue. A commission it
 * cannot cover in full is not paid and the mark does not move, so the next
 * completion — or the sweep, or the admin's next top-up — pays the whole rise
 * at once (§26: never partial-issue). Paying part and recording the whole
 * would under-pay for good.
 *
 * ── One transaction, one payment at a time ───────────────────────────────────
 * The commission row, its shares, the ledger event, the pool credit and the
 * treasury movement commit together (§21). The pool balance is a gate read and
 * then spent, so every payment takes the same advisory lock first: the gate is
 * a serialised write, not a snapshot (§32 S6, trap 18).
 */
import { pgQuery, withTransaction } from '../client.js';
import { creditCommissionWithin, PoolRefused } from './teamPools.js';
import { recordEvent, accountBalancePaise } from './ledger.core.js';
import { ACCOUNTS as LEDGER, EVENT_TYPES, buildBonusIssuePostings } from '../../backend/domains/revenue/chartOfAccounts.js';

/** Of each rise in matched volume, paid into the team's pool (owner). */
export const COMMISSION_PERCENT = 10;
/** Of each payment, recorded to the supervisor; the rest to the members equally (owner). */
export const SUPERVISOR_SHARE_PERCENT = 16;
export const SHARE_ROLES = Object.freeze({ SUPERVISOR: 'SUPERVISOR', MEMBER: 'MEMBER' });

const PAY_LOCK = `SELECT pg_advisory_xact_lock(hashtext('bb_team_commission_pay'))`;
const toNum = (v) => Number(v ?? 0);

/**
 * A team's completed volume in tokens, as one SQL fragment: the payment and
 * every screen read the same one (§32 S11). `team` is the SQL that names the
 * team — a parameter or a column. Tokens, never fiat (trap 15).
 */
export const teamVolumeSql = (team) => `
  SELECT COALESCE(SUM(token_amount_paise) FILTER (WHERE order_type = 'DEPOSIT'), 0)    AS buys_paise,
         COALESCE(SUM(token_amount_paise) FILTER (WHERE order_type = 'WITHDRAWAL'), 0) AS sells_paise
    FROM order_states WHERE team_id = ${team} AND state = 'COMPLETED'`;

/** The team's mark and what it has been paid in all. */
export const teamMarkSql = (team) => `
  SELECT COALESCE(MAX(to_high_paise), 0) AS high_paise, COALESCE(SUM(commission_paise), 0) AS paid_paise
    FROM team_commissions WHERE team_id = ${team}`;

/** 10% of the rise above the mark, rounded down to the paisa; 0 without a rise. The CHECK does the same sum. */
export function commissionFor(matchedPaise, highPaise) {
  const rise = Number(matchedPaise) - Number(highPaise);
  return rise > 0 ? Math.floor((rise * COMMISSION_PERCENT) / 100) : 0;
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

/** A team's commission picture from a row carrying the volume and mark columns above. */
export function toSummary(teamId, row) {
  const buys = toNum(row?.buys_paise);
  const sells = toNum(row?.sells_paise);
  const matched = Math.min(buys, sells);
  const high = toNum(row?.high_paise);
  return {
    teamId: String(teamId),
    buysPaise: buys,
    sellsPaise: sells,
    matchedPaise: matched,
    highPaise: high,
    paidPaise: toNum(row?.paid_paise),
    // Earned by volume already completed and not paid yet: the pool could not
    // cover it, or the payment after the completion did not run. The sweep and
    // the admin's next top-up pay it.
    owedPaise: commissionFor(matched, high),
    // The rule itself, so no screen keeps its own copy of the numbers (§4).
    commissionPercent: COMMISSION_PERCENT,
    supervisorSharePercent: SUPERVISOR_SHARE_PERCENT,
  };
}

/**
 * Pay whatever this team has earned and not been paid. Safe to call any number
 * of times, from any path: a call with nothing to pay changes nothing.
 *
 * Returns { ok: true, paid: true, commission, shares, pool }
 *       | { ok: true, paid: false, reason: 'no_rise' | 'rise_too_small' | 'already_paid' }
 *       | { ok: false, reason: 'team_not_found' | 'pool_short' | <treasury reason>, … }
 */
export async function payTeamCommission(teamId, { actor = 'system' } = {}) {
  const tid = String(teamId);
  try {
    return await withTransaction(async (client) => {
      await client.query(PAY_LOCK);
      const { rows: team } = await client.query(
        'SELECT team_id, supervisor_id FROM teams WHERE team_id = $1', [tid]);
      if (!team[0]) return { ok: false, reason: 'team_not_found' };
      // Read after the lock, so a completion that committed while this waited is counted.
      const { rows: [vol] } = await client.query(teamVolumeSql('$1'), [tid]);
      const { rows: [mark] } = await client.query(teamMarkSql('$1'), [tid]);
      const summary = toSummary(tid, { ...vol, ...mark });
      const amount = summary.owedPaise;
      if (amount <= 0) {
        return { ok: true, paid: false, reason: summary.matchedPaise > summary.highPaise ? 'rise_too_small' : 'no_rise', summary };
      }

      const poolPaise = await accountBalancePaise(LEDGER.MERCHANT_BONUS_POOL.code, { client });
      if (poolPaise < amount) return { ok: false, reason: 'pool_short', owedPaise: amount, poolPaise, summary };

      const commissionId = `tcm~${tid}~${summary.matchedPaise}`;
      const { rows: [paid] } = await client.query(
        `INSERT INTO team_commissions
           (commission_id, team_id, supervisor_id, from_high_paise, to_high_paise,
            buys_paise, sells_paise, commission_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [commissionId, tid, team[0].supervisor_id, summary.highPaise, summary.matchedPaise,
          summary.buysPaise, summary.sellsPaise, amount]);

      const { rows: members } = await client.query(
        `SELECT merchant_id FROM team_members WHERE team_id = $1 AND status = 'APPROVED'`, [tid]);
      const shares = splitShares(amount, team[0].supervisor_id, members.map((m) => m.merchant_id));
      await client.query(
        `INSERT INTO team_commission_shares (commission_id, merchant_id, role, share_paise)
         SELECT $1, s.merchant_id, s.role, s.share_paise
           FROM unnest($2::text[], $3::text[], $4::bigint[]) AS s(merchant_id, role, share_paise)`,
        [commissionId, shares.map((s) => s.merchantId), shares.map((s) => s.role), shares.map((s) => s.sharePaise)]);

      const event = await recordEvent({
        client,
        eventType: EVENT_TYPES.MERCHANT_BONUS_ISSUED,
        idempotencyKey: `acct_${commissionId}`,
        postings: buildBonusIssuePostings(amount).map((p) => ({ account: p.account, amountPaise: p.amountMinor })),
        refModel: 'Team', refId: tid, amountPaise: amount,
        description: `Team commission: ${COMMISSION_PERCENT}% of matched volume ${summary.highPaise / 100} → ${summary.matchedPaise / 100}`,
      });
      // The commission row above is new, so its event cannot exist; one that
      // does was posted outside this module. Never pay against it twice.
      if (event.idempotent) throw new Error(`payTeamCommission: ledger already holds ${commissionId}`);

      const pool = await creditCommissionWithin(client, { teamId: tid, commissionId, amountPaise: amount, actor });
      return {
        ok: true, paid: true,
        commission: {
          commissionId, teamId: tid, fromHighPaise: summary.highPaise, toHighPaise: summary.matchedPaise,
          commissionPaise: amount, createdAt: paid.created_at,
        },
        shares, pool,
      };
    });
  } catch (e) {
    if (e instanceof PoolRefused) return { ok: false, reason: e.reason };
    // A payment from the same mark landed first (the lock makes this a replay,
    // not a race): nothing moved here.
    if (e.code === '23505' && /team_commissions_(from|to)_once|team_commissions_pkey/.test(e.constraint ?? '')) {
      return { ok: true, paid: false, reason: 'already_paid' };
    }
    throw e;
  }
}

/** Teams whose completed volume has earned something not yet paid — what the sweep pays. */
export async function teamsOwed({ limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT t.team_id FROM teams t
       CROSS JOIN LATERAL (${teamVolumeSql('t.team_id')}) v
       CROSS JOIN LATERAL (${teamMarkSql('t.team_id')}) k
      WHERE LEAST(v.buys_paise, v.sells_paise) > k.high_paise
      ORDER BY t.team_id LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'team_commission_owed');
  return rows.map((r) => r.team_id);
}

/** Pay every team that is owed. One transaction per team; one team's refusal does not stop the rest. */
export async function payOwedCommissions({ actor = 'system:commission-sweep' } = {}) {
  const results = [];
  for (const teamId of await teamsOwed()) {
    try {
      results.push({ teamId, ...(await payTeamCommission(teamId, { actor })) });
    } catch (e) {
      results.push({ teamId, ok: false, reason: 'error', error: e.message });
    }
  }
  return results;
}

/** One team's commission picture, for its supervisor, its members and the admin. */
export async function teamSummary(teamId) {
  const { rows } = await pgQuery(
    `SELECT v.*, k.* FROM (${teamVolumeSql('$1')}) v, (${teamMarkSql('$1')}) k`,
    [String(teamId)], 'team_commission_summary');
  return toSummary(teamId, rows[0]);
}

/**
 * A team's payments, newest first, each with the shares recorded for it. With
 * `merchantId`, each payment also carries that merchant's own share (0 when
 * they were not in the team then).
 */
export async function listCommissions(teamId, { merchantId = null, limit = 20 } = {}) {
  const { rows } = await pgQuery(
    `SELECT c.commission_id, c.from_high_paise, c.to_high_paise, c.commission_paise, c.created_at,
            COALESCE((SELECT s.share_paise FROM team_commission_shares s
                       WHERE s.commission_id = c.commission_id AND s.merchant_id = $2), 0) AS my_share_paise
       FROM team_commissions c
      WHERE c.team_id = $1
      ORDER BY c.to_high_paise DESC
      LIMIT $3`,
    [String(teamId), merchantId === null ? null : String(merchantId), Math.min(Math.max(Number(limit) || 20, 1), 200)],
    'team_commission_list');
  return rows.map((r) => ({
    commissionId: r.commission_id,
    teamId: String(teamId),
    fromHighPaise: toNum(r.from_high_paise),
    toHighPaise: toNum(r.to_high_paise),
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
