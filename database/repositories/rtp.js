// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/rtp.js — the RTP (return to player) fund and the house bets it
 * pays for (owner, 2026-10-17). The one writer of `rtp_funds`,
 * `rtp_fund_entries` and the round row's `house_bet_*` columns (schema.sql
 * "RTP FUND AND HOUSE BETS").
 *
 * One fund per game and profile (VIP, GENERAL), off until an admin switches it
 * on. Every round settled while it is on (or that carries a house bet) adds one
 * entry, in the transaction that marks the round settled:
 *
 *   delta = rate × real player pool − paid back to players (before the fee)
 *
 * A lopsided round adds to the fund; a close round, where players got back
 * more than the rate, takes from it and may leave it negative. A house bet is
 * the fund paying back: placed only when the fund, less what earlier house
 * bets still waiting for settlement set aside, covers the round's whole cost
 * and stays at zero or above. So only natural close rounds can make it
 * negative. The house bet itself is never in the pool and moves no tokens.
 */
import { pgQuery, withTransaction } from '../client.js';

export const RTP_AUDIENCES = Object.freeze(['VIP', 'GENERAL']);
export const DEFAULT_RTP_RATE_BP = 8000;

/**
 * In-house games that are not boards, each with its own fund per profile it
 * plays (owner, 2026-10-18: every game's RTP is its own). Cricket plays the
 * VIP wallet only. A board may not take one of these keys (`boards.js`).
 */
export const IN_HOUSE_GAMES = Object.freeze([
  Object.freeze({ key: 'CRICKET', name: 'Cricket', audiences: Object.freeze(['VIP']) }),
]);
export const IN_HOUSE_GAME_KEYS = Object.freeze(IN_HOUSE_GAMES.map((g) => g.key));

const bad = (message, code = 'INVALID_RTP') => Object.assign(new Error(message), { status: 400, code });
const num = (v) => Number(v ?? 0);

function toFund(r) {
  return {
    gameKey: r.game_key,
    audience: r.audience,
    enabled: r.enabled === true,
    rateBp: num(r.rate_bp),
    ratePercent: num(r.rate_bp) / 100,
    balancePaise: num(r.balance_paise),
    roundsHelped: num(r.rounds_helped),
    returnedPaise: num(r.returned_paise),
    updatedBy: r.updated_by ?? null,
    updatedAt: r.updated_at,
  };
}

function toEntry(r) {
  return {
    id: num(r.id),
    gameKey: r.game_key,
    audience: r.audience,
    cycleId: r.cycle_id,
    rateBp: num(r.rate_bp),
    poolPaise: num(r.pool_paise),
    paidBackPaise: num(r.paid_back_paise),
    deltaPaise: num(r.delta_paise),
    balanceAfterPaise: num(r.balance_after_paise),
    houseBetPaise: num(r.house_bet_paise),
    createdAt: r.created_at,
  };
}

/** What the fund owes for a round: rate × pool, floored to the paisa (the schema's own formula). */
export const owedPaise = (rateBp, poolPaise) => Math.floor((rateBp * poolPaise) / 10000);

/**
 * Every fund that has ever been set, by game then profile, with the rounds a
 * house bet helped and what the fund returned in them, derived from the entries.
 */
export async function listFunds() {
  const { rows } = await pgQuery(
    `SELECT f.*, COALESCE(h.rounds, 0) AS rounds_helped, COALESCE(h.returned, 0) AS returned_paise
       FROM rtp_funds f
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS rounds, SUM(GREATEST(0, -e.delta_paise)) AS returned
           FROM rtp_fund_entries e
          WHERE e.game_key = f.game_key AND e.audience = f.audience AND e.house_bet_paise > 0) h ON TRUE
      ORDER BY f.game_key, f.audience`,
    [], 'rtp_funds_list',
  );
  return rows.map(toFund);
}

/** One fund, or null when it was never set (which reads as off). */
export async function getFund(gameKey, audience) {
  const { rows } = await pgQuery(
    'SELECT * FROM rtp_funds WHERE game_key = $1 AND audience = $2',
    [String(gameKey), String(audience)], 'rtp_fund_read',
  );
  return rows[0] ? toFund(rows[0]) : null;
}

/**
 * The admin's switch and rate for one game and profile. The rate is a percent
 * with at most two decimals (80, 92.5); stored in basis points.
 */
export async function saveSettings({ gameKey, audience, enabled, ratePercent, by = null }) {
  if (typeof gameKey !== 'string' || !gameKey.trim()) throw bad('Name the game.');
  if (!RTP_AUDIENCES.includes(audience)) throw bad('The profile must be VIP or GENERAL.');
  if (typeof enabled !== 'boolean') throw bad('Say whether RTP is on or off.');
  const rate = Number(ratePercent);
  const rateBp = Math.round(rate * 100);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100 || Math.abs(rate * 100 - rateBp) > 1e-6) {
    throw bad('The RTP rate must be a percent from 0 to 100, with at most two decimals.');
  }
  const { rows } = await pgQuery(
    `INSERT INTO rtp_funds (game_key, audience, enabled, rate_bp, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (game_key, audience) DO UPDATE
       SET enabled = EXCLUDED.enabled, rate_bp = EXCLUDED.rate_bp,
           updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [gameKey.trim(), audience, enabled, rateBp, by], 'rtp_fund_save',
  );
  return toFund(rows[0]);
}

/** A fund's latest entries, newest first. */
export async function listEntries(gameKey, audience, { limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM rtp_fund_entries WHERE game_key = $1 AND audience = $2
      ORDER BY id DESC LIMIT $3`,
    [String(gameKey), String(audience), Math.min(Math.max(Number(limit) || 200, 1), 5000)],
    'rtp_fund_entries_list',
  );
  return rows.map(toEntry);
}

/** What house bets placed but not yet settled have set aside from this fund. */
const RESERVED_SQL = `SELECT COALESCE(SUM(c.house_bet_reserved_paise), 0) AS reserved
   FROM cycles c
  WHERE c.cycle_type = $1 AND c.audience = $2 AND c.house_bet_side IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM rtp_fund_entries e WHERE e.cycle_id = c.cycle_id)`;

/**
 * The fund as a house-bet decision reads it: on or off, the rate, and what is
 * free to spend (balance less what unsettled house bets set aside). A read
 * only; `placeHouseBet` asks again under the fund's lock.
 */
export async function fundForRound(gameKey, audience) {
  const fund = await getFund(gameKey, audience);
  if (!fund?.enabled) return null;
  const { rows } = await pgQuery(RESERVED_SQL, [String(gameKey), String(audience)], 'rtp_fund_reserved');
  return { ...fund, availablePaise: fund.balancePaise - num(rows[0].reserved) };
}

/**
 * Place a round's house bet: the last bet of the round, once betting has
 * closed and before the winner is chosen. One per round, written once.
 *
 * `reservedPaise` is what the round will take from the fund if it settles as
 * planned (paid back − rate × pool, at least 0). Under the fund's row lock the
 * fund must still be on and cover it, staying at zero or above; otherwise
 * nothing is written and the round runs as it would have.
 *
 * @returns {{ok:true, houseBet}} | {{ok:false, reason, houseBet?}}
 */
export async function placeHouseBet({ cycleId, side, stakePaise, reservedPaise }) {
  if (!['DELHI', 'BOMBAY'].includes(side)) throw new Error(`placeHouseBet: unknown side '${side}'`);
  if (!Number.isInteger(stakePaise) || stakePaise <= 0) throw new TypeError('placeHouseBet: stakePaise must be a positive integer');
  if (!Number.isInteger(reservedPaise) || reservedPaise < 0) throw new TypeError('placeHouseBet: reservedPaise must be a non-negative integer');

  return withTransaction(async (client) => {
    const { rows: cyc } = await client.query(
      `SELECT cycle_type, audience, status, winner, house_bet_side, house_bet_paise
         FROM cycles WHERE cycle_id = $1 FOR UPDATE`,
      [String(cycleId)],
    );
    const c = cyc[0];
    if (!c) return { ok: false, reason: 'NOT_FOUND' };
    if (c.house_bet_side) {
      return { ok: false, reason: 'ALREADY_PLACED', houseBet: { side: c.house_bet_side, stakePaise: num(c.house_bet_paise) } };
    }
    if (c.status !== 'CLOSED' || c.winner !== null) return { ok: false, reason: 'NOT_CLOSED', status: c.status };

    const { rows: f } = await client.query(
      'SELECT enabled, balance_paise FROM rtp_funds WHERE game_key = $1 AND audience = $2 FOR UPDATE',
      [c.cycle_type, c.audience],
    );
    if (!f[0]?.enabled) return { ok: false, reason: 'RTP_OFF' };
    const { rows: r } = await client.query(RESERVED_SQL, [c.cycle_type, c.audience]);
    const available = num(f[0].balance_paise) - num(r[0].reserved);
    if (available - reservedPaise < 0) return { ok: false, reason: 'FUND_SHORT', availablePaise: available };

    await client.query(
      `UPDATE cycles SET house_bet_side = $2, house_bet_paise = $3, house_bet_reserved_paise = $4, updated_at = now()
        WHERE cycle_id = $1`,
      [String(cycleId), side, stakePaise, reservedPaise],
    );
    return { ok: true, houseBet: { side, stakePaise } };
  });
}

/**
 * The round's fund entry, inside the transaction that marks it settled
 * (`markets.markSettled`), so a round is counted exactly once: the entry is
 * UNIQUE per round and the balance moves only when it is new.
 *
 * Written when the fund is on, or when the round carries a house bet (an admin
 * switching RTP off after the bet was placed does not erase what it cost).
 * The pool is real player stakes only; the house bet is never part of it.
 */
export async function recordRoundWithin(client, cycleId) {
  const { rows: cyc } = await client.query(
    `SELECT cycle_type, audience, total_paid_out_paise, total_platform_fees_paise, house_bet_side, house_bet_paise
       FROM cycles WHERE cycle_id = $1`,
    [String(cycleId)],
  );
  const c = cyc[0];
  if (!c) return null;
  const { rows: f } = await client.query(
    'SELECT enabled, rate_bp, balance_paise FROM rtp_funds WHERE game_key = $1 AND audience = $2 FOR UPDATE',
    [c.cycle_type, c.audience],
  );
  const fund = f[0];
  const helped = c.house_bet_side !== null;
  if (!fund || (!fund.enabled && !helped)) return null;

  const { rows: p } = await client.query(
    `SELECT COALESCE(SUM(stake_paise), 0) AS pool FROM bets
      WHERE cycle_id = $1 AND NOT is_phantom AND status NOT IN ('REFUNDED', 'VOID')`,
    [String(cycleId)],
  );
  return appendEntryWithin(client, {
    gameKey: c.cycle_type, audience: c.audience, refId: String(cycleId), fund,
    poolPaise: num(p[0].pool), // Before the fee (owner, 2026-10-19): the 1% fee is the house's, never returned through the fund.
    paidBackPaise: num(c.total_paid_out_paise) + num(c.total_platform_fees_paise), houseBetPaise: num(c.house_bet_paise),
  });
}

/** One entry and the balance it moves, under the fund's lock the caller took. Once per `refId`. */
async function appendEntryWithin(client, { gameKey, audience, refId, fund, poolPaise, paidBackPaise, houseBetPaise = 0 }) {
  const rateBp = num(fund.rate_bp);
  const deltaPaise = owedPaise(rateBp, poolPaise) - paidBackPaise;
  const balanceAfter = num(fund.balance_paise) + deltaPaise;
  const { rows: ins } = await client.query(
    `INSERT INTO rtp_fund_entries
       (game_key, audience, cycle_id, rate_bp, pool_paise, paid_back_paise, delta_paise, balance_after_paise, house_bet_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (cycle_id) DO NOTHING
     RETURNING *`,
    [gameKey, audience, refId, rateBp, poolPaise, paidBackPaise, deltaPaise, balanceAfter, houseBetPaise],
  );
  if (!ins[0]) return null;
  await client.query(
    'UPDATE rtp_funds SET balance_paise = $3, updated_at = now() WHERE game_key = $1 AND audience = $2',
    [gameKey, audience, balanceAfter],
  );
  return toEntry(ins[0]);
}

/**
 * An in-house game's settled event (a cricket poll), inside the transaction
 * that settles it: rate × real stakes − paid back to players (wins and claims,
 * net of the fee). Written while the fund is on; once per `refId`.
 */
export async function recordGameEventWithin(client, { gameKey, audience, refId, poolPaise, paidBackPaise }) {
  const { rows: f } = await client.query(
    'SELECT enabled, rate_bp, balance_paise FROM rtp_funds WHERE game_key = $1 AND audience = $2 FOR UPDATE',
    [String(gameKey), String(audience)],
  );
  if (!f[0]?.enabled) return null;
  return appendEntryWithin(client, { gameKey, audience, refId: String(refId), fund: f[0], poolPaise, paidBackPaise });
}
