// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Auto house bets: a phantom agent's plan per board and side (owner,
 * 2026-10-15). The one writer of `phantom_auto_plans` (schema.sql "AUTO HOUSE
 * BETS"); the rules are backend/domains/markets/houseBets.js.
 */
import { pgQuery } from '../client.js';
import {
  AUTO_BET_STEPS_MAX, AUTO_BET_MIN_RUPEES, AUTO_BET_MAX_RUPEES,
} from '../../backend/domains/markets/houseBets.js';

const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'AUTO_BETS_INVALID' });

const toPlan = (r) => ({
  boardKey: r.board_key,
  side: r.side,
  amounts: (r.amounts_paise || []).map((p) => Number(p) / 100),
  enabled: r.enabled,
  startsAt: r.starts_at,
  updatedAt: r.updated_at,
});

/**
 * The sizes as typed, checked whole: whole rupees, each within the bounds,
 * 1 to AUTO_BET_STEPS_MAX of them. Throws a 400 naming the first wrong one.
 */
export function normaliseAmounts(amounts) {
  if (!Array.isArray(amounts) || amounts.length < 1) throw bad('Add at least one bet size.');
  if (amounts.length > AUTO_BET_STEPS_MAX) throw bad(`A plan holds at most ${AUTO_BET_STEPS_MAX} bet sizes; this one has ${amounts.length}.`);
  return amounts.map((v, i) => {
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isInteger(n) || n < AUTO_BET_MIN_RUPEES || n > AUTO_BET_MAX_RUPEES) {
      throw bad(`Size ${i + 1} (${JSON.stringify(v)}) must be a whole number of rupees from ${AUTO_BET_MIN_RUPEES} to ${AUTO_BET_MAX_RUPEES.toLocaleString('en-IN')}.`);
    }
    return n * 100;
  });
}

/** This agent's plans, every board and side. */
export async function listFor(userId) {
  const { rows } = await pgQuery(
    `SELECT * FROM phantom_auto_plans WHERE user_id = $1 ORDER BY board_key, side`,
    [String(userId)], 'phantom_auto_list_for',
  );
  return rows.map(toPlan);
}

/**
 * Save one plan (insert or replace). Saving restarts it from now: the next
 * bet is the first size of the list, at the next second.
 */
export async function savePlan({ userId, boardKey, side, amounts, enabled }) {
  const paise = normaliseAmounts(amounts);
  const { rows } = await pgQuery(
    `INSERT INTO phantom_auto_plans (user_id, board_key, side, amounts_paise, enabled, starts_at, updated_at)
     VALUES ($1, $2, $3, $4::bigint[], $5, now(), now())
     ON CONFLICT (user_id, board_key, side) DO UPDATE
        SET amounts_paise = EXCLUDED.amounts_paise, enabled = EXCLUDED.enabled,
            starts_at = now(), updated_at = now()
     RETURNING *`,
    [String(userId), String(boardKey), String(side), paise, enabled !== false],
    'phantom_auto_save',
  );
  return toPlan(rows[0]);
}

/**
 * Every plan that should be betting now: switched on, its owner an unblocked
 * player who still holds phantom access to that board (or BOTH). Asked on
 * every tick, so revoking access or blocking the agent stops its plans at once.
 */
export async function runnablePlans() {
  const { rows } = await pgQuery(
    `SELECT p.user_id, p.board_key, p.side, p.amounts_paise, p.starts_at
       FROM phantom_auto_plans p
       JOIN users u ON u.user_id = p.user_id
      WHERE p.enabled
        AND u.account_type = 'PLAYER' AND NOT u.is_blocked
        AND (u.phantom_access = 'BOTH' OR u.phantom_access = p.board_key)`,
    [], 'phantom_auto_runnable',
  );
  return rows.map((r) => ({
    userId: r.user_id,
    boardKey: r.board_key,
    side: r.side,
    amountsPaise: r.amounts_paise.map(Number),
    startsAtMs: new Date(r.starts_at).getTime(),
  }));
}
