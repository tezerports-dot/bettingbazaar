// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/boards.js — the board games, one row each (owner, 2026-10-08:
 * "admins can create any number of board games, each with its own timer, and
 * set their order on the home page"). The one writer of `boards`.
 *
 * A board is everything its cycles run by: the timer (an INTERVAL that tiles
 * the hour, or one DAILY block from an IST hour), the four phase offsets, the
 * stake bounds and the home-page position. The schema refuses a board the
 * engine cannot run (`boards_timer_runs`, `boards_phases_ordered`,
 * `boards_stakes`); this file checks the same rules first so the admin is told
 * which field is wrong, in words (S14), rather than meeting a constraint name.
 *
 * The key and id prefix are derived from the name at creation and never
 * change (trigger `boards_identity_fixed`): every cycle the board ever ran is
 * named by them. A board is switched off, never deleted.
 */
import { pgQuery, withTransaction } from '../client.js';

export const BOARD_KINDS = Object.freeze(['INTERVAL', 'DAILY']);
/** A DAILY board's block, in minutes. */
export const DAILY_DURATION_MIN = 1440;
/** The interval lengths that tile the hour: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60. */
export const INTERVAL_DURATIONS_MIN = Object.freeze(
  Array.from({ length: 60 }, (_, i) => i + 1).filter((d) => 60 % d === 0),
);
export const PHASE_FIELDS = Object.freeze([
  'mergeBeforeEndSec', 'equalizerBeforeEndSec', 'closeBeforeEndSec', 'celebrateBeforeEndSec',
]);
const NAME_MAX = 40;

const bad = (message, code = 'INVALID_BOARD') => Object.assign(new Error(message), { status: 400, code });

const COLUMNS = `board_key, name, kind, duration_min, anchor_hour_ist, merge_sec, equalizer_sec,
  close_sec, celebrate_sec, min_bet_paise, max_bet_paise, id_prefix, enabled, home_order,
  created_at, updated_at`;

/** Row → board. Stakes are whole rupees for the routes, paise kept beside them (trap 5). */
export function toBoard(r) {
  if (!r) return null;
  const minBetPaise = Number(r.min_bet_paise);
  const maxBetPaise = Number(r.max_bet_paise);
  return {
    key: r.board_key,
    name: r.name,
    kind: r.kind,
    durationMin: Number(r.duration_min),
    anchorHourIst: r.anchor_hour_ist == null ? null : Number(r.anchor_hour_ist),
    phases: {
      mergeBeforeEndSec: Number(r.merge_sec),
      equalizerBeforeEndSec: Number(r.equalizer_sec),
      closeBeforeEndSec: Number(r.close_sec),
      celebrateBeforeEndSec: Number(r.celebrate_sec),
    },
    minBetPaise, maxBetPaise,
    minBet: minBetPaise / 100,
    maxBet: maxBetPaise / 100,
    idPrefix: r.id_prefix,
    enabled: r.enabled === true,
    homeOrder: Number(r.home_order),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Every board in home-page order; `enabledOnly` for what players see. */
export async function listBoards({ enabledOnly = false } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM boards ${enabledOnly ? 'WHERE enabled' : ''}
      ORDER BY home_order, board_key`,
    [], 'boards_list',
  );
  return rows.map(toBoard);
}

export async function getBoard(key) {
  const { rows } = await pgQuery(`SELECT ${COLUMNS} FROM boards WHERE board_key = $1`,
    [String(key ?? '')], 'boards_get');
  return toBoard(rows[0]);
}

/** Key from a name: 'Five minute!' → 'FIVE_MINUTE'. */
export function keyFromName(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24)
    .replace(/_+$/, '');
}

/** Cycle-id prefix from a key: no underscore, so `PREFIX_G_<ms>` stays unambiguous. */
export function prefixFromKey(key) {
  return key.replace(/_/g, '').slice(0, 12);
}

function wholeRupees(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100_000_000) {
    throw bad(`${label} must be a whole number of rupees from 1 to 10,00,00,000.`);
  }
  return n * 100;
}

/**
 * Check a whole board (an existing one with the patch applied, or a new one)
 * and return its column values. Throws 400 naming the field.
 */
function validated(b) {
  const name = String(b.name ?? '').trim();
  if (!name || name.length > NAME_MAX) throw bad(`The board name must be 1 to ${NAME_MAX} characters.`);
  if (!BOARD_KINDS.includes(b.kind)) throw bad('The timer must be INTERVAL (repeating) or DAILY.');

  let durationMin; let anchorHourIst = null;
  if (b.kind === 'INTERVAL') {
    durationMin = Number(b.durationMin);
    if (!INTERVAL_DURATIONS_MIN.includes(durationMin)) {
      throw bad(`A repeating board's round must last ${INTERVAL_DURATIONS_MIN.join(', ')} minutes, so rounds tile the hour.`);
    }
  } else {
    durationMin = DAILY_DURATION_MIN;
    anchorHourIst = Number(b.anchorHourIst);
    if (!Number.isInteger(anchorHourIst) || anchorHourIst < 0 || anchorHourIst > 23) {
      throw bad('A daily board starts on a whole hour, 0 to 23 (India time).');
    }
  }

  const p = b.phases ?? {};
  for (const f of PHASE_FIELDS) {
    if (!Number.isInteger(p[f]) || p[f] < 0) throw bad(`${f} must be a whole number of seconds, 0 or more.`);
  }
  if (!(p.mergeBeforeEndSec > p.equalizerBeforeEndSec && p.equalizerBeforeEndSec > p.closeBeforeEndSec
        && p.closeBeforeEndSec > p.celebrateBeforeEndSec)) {
    throw bad('The phase times must strictly decrease: merge > equalizer > close > celebrate.');
  }
  if (p.mergeBeforeEndSec >= durationMin * 60) {
    throw bad(`The merge must come less than ${durationMin * 60} seconds before the end, so it falls inside the round.`);
  }

  const minBetPaise = b.minBetPaise ?? wholeRupees(b.minBet, 'The minimum bet');
  const maxBetPaise = b.maxBetPaise ?? wholeRupees(b.maxBet, 'The maximum bet');
  if (minBetPaise > maxBetPaise) throw bad('The minimum bet cannot be above the maximum bet.');

  return { name, kind: b.kind, durationMin, anchorHourIst, phases: p, minBetPaise, maxBetPaise };
}

/** A constraint the code checks above, reaching the database anyway (a race, or a mobile in the name). */
function constraintAnswer(err) {
  if (err?.code === '23505') {
    return Object.assign(new Error('A board with that name already exists. Choose another name.'),
      { status: 409, code: 'BOARD_EXISTS' });
  }
  if (err?.code === '23514' && err.constraint === 'boards_name_not_a_mobile') {
    return bad('A board name may not contain a mobile number.');
  }
  if (err?.code === '23514') return bad('That board cannot run with these settings.');
  return err;
}

/**
 * Create a board. Its key and id prefix come from the name; it joins the end
 * of the home page. Enabled unless `enabled: false`.
 */
export async function createBoard(input) {
  const v = validated(input ?? {});
  const key = keyFromName(v.name);
  if (!key) throw bad('The board name needs at least one letter or digit.');
  const prefix = prefixFromKey(key);
  if (!prefix) throw bad('The board name needs at least one letter or digit.');
  try {
    const { rows } = await pgQuery(
      `INSERT INTO boards (board_key, name, kind, duration_min, anchor_hour_ist, merge_sec,
                           equalizer_sec, close_sec, celebrate_sec, min_bet_paise, max_bet_paise,
                           id_prefix, enabled, home_order)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
              COALESCE((SELECT MAX(home_order) + 1 FROM boards), 0)
       RETURNING ${COLUMNS}`,
      [key, v.name, v.kind, v.durationMin, v.anchorHourIst,
        v.phases.mergeBeforeEndSec, v.phases.equalizerBeforeEndSec,
        v.phases.closeBeforeEndSec, v.phases.celebrateBeforeEndSec,
        v.minBetPaise, v.maxBetPaise, prefix, input.enabled !== false],
      'boards_create',
    );
    return toBoard(rows[0]);
  } catch (err) { throw constraintAnswer(err); }
}

/**
 * Change a board's name, timer length, phases, stakes or switch. The kind is
 * fixed (a DAILY board never becomes INTERVAL). A changed timer applies from
 * the board's next round; the round already open keeps its own start and end.
 */
export async function updateBoard(key, patch = {}) {
  if (patch.kind !== undefined || patch.key !== undefined || patch.idPrefix !== undefined) {
    throw bad("A board's timer kind and key never change. Create a new board instead.");
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw bad('enabled must be true or false.');
  }
  return withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT ${COLUMNS} FROM boards WHERE board_key = $1 FOR UPDATE`, [String(key)]);
    const cur = toBoard(rows[0]);
    if (!cur) return null;
    const merged = {
      name: patch.name ?? cur.name,
      kind: cur.kind,
      durationMin: patch.durationMin ?? cur.durationMin,
      anchorHourIst: patch.anchorHourIst ?? cur.anchorHourIst,
      phases: { ...cur.phases, ...(patch.phases ?? {}) },
      minBetPaise: patch.minBet === undefined ? cur.minBetPaise : wholeRupees(patch.minBet, 'The minimum bet'),
      maxBetPaise: patch.maxBet === undefined ? cur.maxBetPaise : wholeRupees(patch.maxBet, 'The maximum bet'),
    };
    const v = validated(merged);
    try {
      const out = await client.query(
        `UPDATE boards SET name = $2, duration_min = $3, anchor_hour_ist = $4, merge_sec = $5,
                equalizer_sec = $6, close_sec = $7, celebrate_sec = $8, min_bet_paise = $9,
                max_bet_paise = $10, enabled = $11
          WHERE board_key = $1 RETURNING ${COLUMNS}`,
        [cur.key, v.name, v.durationMin, v.anchorHourIst,
          v.phases.mergeBeforeEndSec, v.phases.equalizerBeforeEndSec,
          v.phases.closeBeforeEndSec, v.phases.celebrateBeforeEndSec,
          v.minBetPaise, v.maxBetPaise, patch.enabled ?? cur.enabled],
      );
      return toBoard(out.rows[0]);
    } catch (err) { throw constraintAnswer(err); }
  });
}

/**
 * Set the home-page order: `keys` is EVERY board, first to last. A list that
 * misses or repeats a board is refused, so no board is left without a place.
 */
export async function setHomeOrder(keys) {
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string') || new Set(keys).size !== keys.length) {
    throw bad('The order must list each board once.', 'INVALID_BOARD_ORDER');
  }
  return withTransaction(async (client) => {
    // Lock every board so a board created meanwhile cannot miss the check.
    await client.query('LOCK TABLE boards IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await client.query('SELECT board_key FROM boards');
    const all = new Set(rows.map((r) => r.board_key));
    if (all.size !== keys.length || keys.some((k) => !all.has(k))) {
      throw bad('The order must list each board once.', 'INVALID_BOARD_ORDER');
    }
    await client.query(
      `UPDATE boards b SET home_order = o.pos - 1
         FROM unnest($1::text[]) WITH ORDINALITY AS o(key, pos)
        WHERE b.board_key = o.key AND b.home_order IS DISTINCT FROM o.pos - 1`,
      [keys],
    );
    const out = await client.query(`SELECT ${COLUMNS} FROM boards ORDER BY home_order, board_key`);
    return out.rows.map(toBoard);
  });
}

