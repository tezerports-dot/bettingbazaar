// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/boardRules.js — which version of the board rules a player has
 * accepted (`users.board_rules_version`, this file the one writer). The text
 * and its version are `backend/domains/markets/boardRules.js`.
 */
import { pgQuery } from '../client.js';

/** The version this player last accepted; 0 if never (schema default: 0). */
export async function acceptedVersion(userId) {
  const { rows } = await pgQuery(
    `SELECT board_rules_version FROM users WHERE user_id = $1 AND account_type = 'PLAYER'`,
    [String(userId)], 'board_rules_read',
  );
  return rows[0] ? Number(rows[0].board_rules_version) : 0;
}

/**
 * Record that a player accepted `version`. Never moves backwards: accepting
 * an older text again leaves the newer acceptance in place.
 */
export async function accept(userId, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw Object.assign(new Error('Invalid rules version'), { status: 400 });
  }
  const { rows } = await pgQuery(
    `UPDATE users SET board_rules_version = GREATEST(board_rules_version, $2)
      WHERE user_id = $1 AND account_type = 'PLAYER' RETURNING board_rules_version`,
    [String(userId), version], 'board_rules_accept',
  );
  return rows[0] ? { ok: true, version: Number(rows[0].board_rules_version) } : { ok: false };
}
