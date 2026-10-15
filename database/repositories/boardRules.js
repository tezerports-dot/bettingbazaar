// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/boardRules.js — the board rules text and who accepted which
 * version. The one writer of `board_rules_texts` (an admin's publish, a new
 * version each time) and of `users.board_rules_version`. With no text
 * published, the current text is the built-in `DEFAULT_BOARD_RULES` at
 * `BOARD_RULES_BASE_VERSION` (`backend/domains/markets/boardRules.js`).
 */
import { pgQuery } from '../client.js';
import {
  BOARD_RULES_BASE_VERSION, DEFAULT_BOARD_RULES, normaliseBoardRulesDraft,
} from '../../backend/domains/markets/boardRules.js';

// The current version, as SQL, so a guard can ask it in its own statement.
const CURRENT_VERSION_SQL = `COALESCE((SELECT max(version) FROM board_rules_texts), ${BOARD_RULES_BASE_VERSION})`;

/** The text players are shown now: the newest published, else the built-in. */
export async function currentText() {
  const { rows } = await pgQuery(
    `SELECT version, heading, intro, sections FROM board_rules_texts ORDER BY version DESC LIMIT 1`,
    [], 'board_rules_text',
  );
  if (!rows[0]) return { version: BOARD_RULES_BASE_VERSION, ...DEFAULT_BOARD_RULES, sections: [...DEFAULT_BOARD_RULES.sections] };
  const r = rows[0];
  return { version: Number(r.version), heading: r.heading, intro: r.intro, sections: r.sections };
}

/** The version a player must have accepted to bet. */
export async function currentVersion() {
  const { rows } = await pgQuery(`SELECT ${CURRENT_VERSION_SQL} AS v`, [], 'board_rules_version_current');
  return Number(rows[0].v);
}

/** The version this player last accepted; 0 if never (schema default: 0). */
export async function acceptedVersion(userId) {
  const { rows } = await pgQuery(
    `SELECT board_rules_version FROM users WHERE user_id = $1 AND account_type = 'PLAYER'`,
    [String(userId)], 'board_rules_read',
  );
  return rows[0] ? Number(rows[0].board_rules_version) : 0;
}

/** Whether this player has accepted the current version, in one statement. */
export async function acceptsCurrent(userId) {
  const { rows } = await pgQuery(
    `SELECT board_rules_version >= ${CURRENT_VERSION_SQL} AS ok
       FROM users WHERE user_id = $1 AND account_type = 'PLAYER'`,
    [String(userId)], 'board_rules_accepts_current',
  );
  return rows[0]?.ok === true;
}

/**
 * Record that a player accepted `version`, only while it is still the current
 * one (asked in the WHERE, so a publish between the read and the write is not
 * recorded as accepted). Never moves backwards.
 * @returns {{ ok: true, version: number } | { ok: false, reason: 'changed' | 'not_found' }}
 */
export async function accept(userId, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw Object.assign(new Error('Invalid rules version'), { status: 400 });
  }
  const { rows } = await pgQuery(
    `UPDATE users SET board_rules_version = GREATEST(board_rules_version, $2)
      WHERE user_id = $1 AND account_type = 'PLAYER' AND $2 = ${CURRENT_VERSION_SQL}
      RETURNING board_rules_version`,
    [String(userId), version], 'board_rules_accept',
  );
  if (rows[0]) return { ok: true, version: Number(rows[0].board_rules_version) };
  const { rows: player } = await pgQuery(
    `SELECT 1 FROM users WHERE user_id = $1 AND account_type = 'PLAYER'`, [String(userId)], 'board_rules_player_exists',
  );
  return { ok: false, reason: player.length ? 'changed' : 'not_found' };
}

/**
 * Publish an admin's text as the next version. Every player is asked to
 * accept it before their next bet. Two publishes at once: one wins, the other
 * is refused 409 rather than numbered over it.
 */
export async function publish(draft, publishedBy) {
  const text = normaliseBoardRulesDraft(draft);
  const { rows } = await pgQuery(
    `INSERT INTO board_rules_texts (version, heading, intro, sections, published_by)
     SELECT ${CURRENT_VERSION_SQL} + 1, $1, $2, $3::jsonb, $4
     ON CONFLICT (version) DO NOTHING
     RETURNING version, heading, intro, sections, published_at`,
    [text.heading, text.intro, JSON.stringify(text.sections), publishedBy ? String(publishedBy) : null],
    'board_rules_publish',
  );
  if (!rows[0]) {
    throw Object.assign(new Error('Someone else published the rules at the same moment. Reload and try again.'),
      { status: 409, code: 'BOARD_RULES_PUBLISH_RACE' });
  }
  const r = rows[0];
  return { version: Number(r.version), heading: r.heading, intro: r.intro, sections: r.sections, publishedAt: r.published_at };
}

/** The published versions, newest first (the built-in text is not a row). */
export async function history(limit = 20) {
  const { rows } = await pgQuery(
    `SELECT version, heading, published_by, published_at FROM board_rules_texts
      ORDER BY version DESC LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit) || 20))], 'board_rules_history',
  );
  return rows.map((r) => ({ version: Number(r.version), heading: r.heading, publishedBy: r.published_by, publishedAt: r.published_at }));
}
