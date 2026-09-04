// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/engagement.js — check-ins, gift codes, bonuses, notifications,
 * the leaderboard and the marketing carousel.
 *
 * Two of these MOVE MONEY — a gift-code redemption and a bonus grant — and both
 * follow the same rule as every other money path here: the cap is enforced by
 * the row, the claim and the check are one statement, and the caller credits
 * the wallet only after this module says the claim succeeded.
 */
import { pgQuery, getPool, connectGuarded } from '../client.js';
import { randomBytes } from 'node:crypto';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';

const newId = () => randomBytes(12).toString('hex');

// ── Daily check-in ──────────────────────────────────────────────────────────

const toCheckIn = (r) => (r ? {
  userId: r.user_id,
  currentStreak: r.current_streak, longestStreak: r.longest_streak,
  totalCheckIns: Number(r.total_check_ins),
  lastCheckIn: r.last_check_in_date,
  totalEarned: paiseToRupees(Number(r.total_earned_paise)),
  updatedAt: r.updated_at,
} : null);

export async function getCheckIn(userId) {
  const { rows } = await pgQuery(
    'SELECT * FROM check_ins WHERE user_id = $1', [String(userId)], 'checkin_get',
  );
  return toCheckIn(rows[0]);
}

/**
 * Claim today's check-in.
 *
 * ONE STATEMENT does all of it: refuses a second claim today, continues the
 * streak if yesterday was claimed and restarts it otherwise, and raises the
 * high-water mark. A read-then-write lets a double-tap claim twice — and the
 * reward is money.
 *
 * The date comparison is on DATE, not on a timestamp: "have they checked in
 * today" is a question about the day, and a timestamp comparison makes the
 * answer depend on the hour they last claimed.
 */
export async function claimCheckIn(userId, { rewardRupees = 0 } = {}) {
  const rewardPaise = rupeesToPaise(rewardRupees || 0);
  const { rows } = await pgQuery(
    `INSERT INTO check_ins (user_id, current_streak, longest_streak, total_check_ins,
                            last_check_in_date, total_earned_paise)
     VALUES ($1, 1, 1, 1, CURRENT_DATE, $2)
     ON CONFLICT (user_id) DO UPDATE SET
       current_streak = CASE
         WHEN check_ins.last_check_in_date = CURRENT_DATE - 1 THEN check_ins.current_streak + 1
         ELSE 1 END,
       longest_streak = GREATEST(check_ins.longest_streak, CASE
         WHEN check_ins.last_check_in_date = CURRENT_DATE - 1 THEN check_ins.current_streak + 1
         ELSE 1 END),
       total_check_ins = check_ins.total_check_ins + 1,
       last_check_in_date = CURRENT_DATE,
       total_earned_paise = check_ins.total_earned_paise + EXCLUDED.total_earned_paise,
       updated_at = now()
       -- Already claimed today: the UPDATE matches nothing and RETURNING is empty.
       WHERE check_ins.last_check_in_date IS DISTINCT FROM CURRENT_DATE
     RETURNING *`,
    [String(userId), rewardPaise], 'checkin_claim',
  );
  return rows[0]
    ? { ok: true, checkIn: toCheckIn(rows[0]) }
    : { ok: false, reason: 'ALREADY_CHECKED_IN_TODAY', checkIn: await getCheckIn(userId) };
}

// ── Gift codes ──────────────────────────────────────────────────────────────

const toGiftCode = (r) => (r ? {
  code: r.code, amount: paiseToRupees(Number(r.amount_paise)),
  amountPaise: Number(r.amount_paise), bonusType: r.bonus_type,
  maxUses: r.max_uses, usedCount: r.used_count,
  expiresAt: r.expires_at, isActive: r.is_active, note: r.note,
  createdBy: r.created_by, createdAt: r.created_at,
} : null);

export async function createGiftCode({
  code, amountRupees, bonusType = 'DEPOSIT', maxUses = 1, expiresAt = null,
  note = '', createdBy = null,
}) {
  if (!code) throw new Error('createGiftCode requires a code');
  const { rows } = await pgQuery(
    `INSERT INTO gift_codes (code, amount_paise, bonus_type, max_uses, expires_at, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [String(code).toUpperCase(), rupeesToPaise(amountRupees), String(bonusType),
      Math.max(Number(maxUses) || 1, 1), expiresAt, String(note), createdBy],
    'giftcode_create',
  );
  return toGiftCode(rows[0]);
}

export async function getGiftCode(code) {
  const { rows } = await pgQuery(
    'SELECT * FROM gift_codes WHERE code = $1', [String(code).toUpperCase()], 'giftcode_get',
  );
  return toGiftCode(rows[0]);
}

/**
 * Redeem a code for a player.
 *
 * ── The two races this closes ───────────────────────────────────────────────
 * A single-use code paid out twice under the document model, because the check
 * ("is used_count < max_uses?") and the increment were separate operations and
 * two requests could both pass the check. And one player could redeem a
 * multi-use code repeatedly, because "has this player already redeemed?" was
 * also a pre-read.
 *
 * Both are now decided by the database in ONE transaction: the redemption row's
 * UNIQUE (code, user_id) refuses the second attempt by the same player, and the
 * gift code's `used_count <= max_uses` CHECK refuses the increment past the cap.
 * The caller credits the wallet only after this returns ok.
 */
export async function redeemGiftCode(code, userId) {
  const upper = String(code).toUpperCase();
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');

    // Claim a use. The WHERE is the entire eligibility rule, evaluated against
    // the row as it is at this instant — active, unexpired, and under its cap.
    const claimed = await client.query(
      `UPDATE gift_codes SET used_count = used_count + 1
        WHERE code = $1 AND is_active
          AND (expires_at IS NULL OR expires_at > now())
          AND used_count < max_uses
        RETURNING code, amount_paise, bonus_type`,
      [upper],
    );
    if (!claimed.rows.length) {
      // WHY the refusal, read on THIS client rather than a fresh one.
      //
      // The first draft called `getGiftCode` here — a second pooled connection,
      // requested while still holding the first. Under a redemption storm every
      // client in the pool ends up doing that at once and the pool deadlocks:
      // each connection waits for a connection that will not be released until
      // it gets one. Never ask the pool for a client while holding one.
      const state = await client.query(
        `SELECT is_active, expires_at, used_count, max_uses FROM gift_codes WHERE code = $1`,
        [upper],
      );
      await client.query('ROLLBACK');
      const row = state.rows[0];
      if (!row) return { ok: false, reason: 'NOT_FOUND' };
      if (!row.is_active) return { ok: false, reason: 'INACTIVE' };
      if (row.expires_at && new Date(row.expires_at) <= new Date()) {
        return { ok: false, reason: 'EXPIRED' };
      }
      return { ok: false, reason: 'FULLY_REDEEMED' };
    }

    // …and record WHO used it. The unique constraint is what stops one player
    // consuming several uses of the same code.
    const row = claimed.rows[0];
    try {
      const redemption = await client.query(
        `INSERT INTO gift_code_redemptions (code, user_id, amount_paise)
         VALUES ($1, $2, $3) RETURNING id, redeemed_at`,
        [upper, String(userId), row.amount_paise],
      );
      await client.query('COMMIT');
      return {
        ok: true,
        redemptionId: Number(redemption.rows[0].id),
        // The NORMALISED code, so a caller building an idempotency key from it
        // produces the same key whatever case the player typed.
        code: row.code,
        amount: paiseToRupees(Number(row.amount_paise)),
        amountPaise: Number(row.amount_paise),
        bonusType: row.bonus_type,
        redeemedAt: redemption.rows[0].redeemed_at,
      };
    } catch (e) {
      // The use is rolled back with the redemption, so the code is not
      // consumed by an attempt that did not pay anything out.
      await client.query('ROLLBACK');
      if (e.code === '23505') return { ok: false, reason: 'ALREADY_REDEEMED' };
      throw e;
    }
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    client.release(failure ?? undefined);
  }
}

export async function listGiftCodes({ activeOnly = false, limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM gift_codes ${activeOnly ? 'WHERE is_active' : ''}
      ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'giftcode_list',
  );
  return rows.map(toGiftCode);
}

export async function setGiftCodeActive(code, isActive) {
  const { rows } = await pgQuery(
    'UPDATE gift_codes SET is_active = $2 WHERE code = $1 RETURNING *',
    [String(code).toUpperCase(), Boolean(isActive)], 'giftcode_set_active',
  );
  return toGiftCode(rows[0]);
}

/**
 * Redemptions whose reward never reached the player.
 *
 * ── Why this exists instead of a compensating delete ────────────────────────
 * The route used to undo a redemption when the credit failed: delete the
 * redemption row, decrement `usedCount`, tell the player nothing happened.
 * Three writes to unwind one, each able to fail on its own, and a crash between
 * any two leaves the code burned with nobody paid.
 *
 * The redemption is committed FIRST and the credit is keyed on it, so a failed
 * credit is retryable rather than reversible — and this query is how it gets
 * retried. It finds redemptions with no matching ledger row: money owed, and
 * the exact list a reconciliation job works through.
 *
 * That is the standard shape for a payout that spans two commits: detect and
 * repair, never compensate and hope.
 */
export async function findUnpaidRedemptions({ olderThanMinutes = 5, limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT r.id, r.code, r.user_id, r.amount_paise, r.redeemed_at
       FROM gift_code_redemptions r
      WHERE r.redeemed_at < now() - ($1 || ' minutes')::interval
        AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger l
           WHERE l.user_id = r.user_id
             AND l.tx_id = 'giftcode_' || r.code || '_' || r.user_id)
      ORDER BY r.redeemed_at ASC
      LIMIT $2`,
    [String(Math.max(Number(olderThanMinutes) || 5, 0)),
      Math.min(Math.max(Number(limit) || 200, 1), 1000)],
    'giftcode_unpaid',
  );
  return rows.map((r) => ({
    id: Number(r.id), code: r.code, userId: r.user_id,
    amount: paiseToRupees(Number(r.amount_paise)),
    amountPaise: Number(r.amount_paise),
    redeemedAt: r.redeemed_at,
    // The key the credit is made under, so a repair reproduces it exactly and
    // a replay collides rather than paying twice.
    txId: `giftcode_${r.code}_${r.user_id}`,
  }));
}

export async function listRedemptions({ code = null, userId = null, limit = 200 } = {}) {
  const where = []; const params = [];
  if (code) { params.push(String(code).toUpperCase()); where.push(`code = $${params.length}`); }
  if (userId) { params.push(String(userId)); where.push(`user_id = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT * FROM gift_code_redemptions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY redeemed_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`,
    params, 'giftcode_redemptions',
  );
  return rows.map((r) => ({
    id: Number(r.id), code: r.code, userId: r.user_id,
    amount: paiseToRupees(Number(r.amount_paise)), redeemedAt: r.redeemed_at,
  }));
}

// ── Bonus records ───────────────────────────────────────────────────────────

/**
 * Record a bonus.
 *
 * Append-only by trigger: this is the record a player disputes against, and one
 * that can be edited afterwards settles nothing. `bonus_id` is UNIQUE so a
 * retried grant collides rather than recording twice.
 */
export async function recordBonus({ bonusId = null, userId, bonusType, amountRupees, description = '', refId = null }) {
  if (!userId || !bonusType) throw new Error('recordBonus requires a userId and a bonusType');
  const { rows } = await pgQuery(
    `INSERT INTO bonus_records (bonus_id, user_id, bonus_type, amount_paise, description, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (bonus_id) DO NOTHING
     RETURNING id, bonus_id, created_at`,
    [String(bonusId || newId()), String(userId), String(bonusType),
      rupeesToPaise(amountRupees), String(description), refId], 'bonus_record',
  );
  return rows[0]
    ? { ok: true, id: Number(rows[0].id), bonusId: rows[0].bonus_id, createdAt: rows[0].created_at }
    : { ok: true, idempotent: true };
}

export async function listBonuses({ userId = null, bonusType = null, limit = 100 } = {}) {
  const where = []; const params = [];
  if (userId) { params.push(String(userId)); where.push(`user_id = $${params.length}`); }
  if (bonusType) { params.push(String(bonusType)); where.push(`bonus_type = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT * FROM bonus_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    params, 'bonus_list',
  );
  return rows.map((r) => ({
    id: Number(r.id), bonusId: r.bonus_id, userId: r.user_id,
    type: r.bonus_type, amount: paiseToRupees(Number(r.amount_paise)),
    description: r.description, refId: r.ref_id, createdAt: r.created_at,
  }));
}

/**
 * One page of a player's bonus history, with its total from the same query.
 *
 * `find()` plus a separate `countDocuments()` are two reads of a table that
 * accepts a new bonus between them, so the total described a different instant
 * than the page. `COUNT(*) OVER ()` counts the same filtered set in the same
 * snapshot.
 */
export async function pageBonuses({ userId, bonusType = null, page = 1, limit = 30 } = {}) {
  if (!userId) throw new Error('pageBonuses requires a userId');
  const params = [String(userId)];
  const where = ['user_id = $1'];
  if (bonusType) { params.push(String(bonusType)); where.push(`bonus_type = $${params.length}`); }

  const size = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const offset = Math.max((Number(page) || 1) - 1, 0) * size;
  params.push(size, offset);

  const { rows } = await pgQuery(
    `SELECT *, COUNT(*) OVER () AS total_rows FROM bonus_records
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, 'bonus_page',
  );
  return {
    total: rows.length ? Number(rows[0].total_rows) : 0,
    page: Math.max(Number(page) || 1, 1),
    limit: size,
    records: rows.map((r) => ({
      id: Number(r.id), bonusId: r.bonus_id, userId: r.user_id,
      type: r.bonus_type, amount: paiseToRupees(Number(r.amount_paise)),
      description: r.description, refId: r.ref_id, createdAt: r.created_at,
    })),
  };
}

// ── Notifications ───────────────────────────────────────────────────────────

const toNotification = (r) => (r ? {
  id: Number(r.id), userId: r.user_id, type: r.kind, title: r.title,
  message: r.message, actionUrl: r.action_url, actionLabel: r.action_label,
  relatedId: r.related_id, relatedType: r.related_type,
  isRead: r.is_read, readAt: r.read_at,
  createdAt: r.created_at, expiresAt: r.expires_at,
} : null);

export async function notify({
  userId, kind = 'INFO', title, message = '', actionUrl = null, actionLabel = null,
  relatedId = null, relatedType = null, expiresAt = null,
}) {
  if (!userId || !title) throw new Error('notify requires a userId and a title');
  const { rows } = await pgQuery(
    `INSERT INTO notifications (user_id, kind, title, message, action_url, action_label,
       related_id, related_type, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [String(userId), String(kind), String(title), String(message),
      actionUrl, actionLabel, relatedId, relatedType, expiresAt], 'notification_create',
  );
  return toNotification(rows[0]);
}

/** Send one notification to many players in a single round trip. */
export async function notifyMany(userIds, spec) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return 0;
  const { rowCount } = await pgQuery(
    `INSERT INTO notifications (user_id, kind, title, message, action_url, action_label, expires_at)
     SELECT uid, $2, $3, $4, $5, $6, $7 FROM unnest($1::text[]) AS uid`,
    [ids, String(spec.kind || 'INFO'), String(spec.title), String(spec.message || ''),
      spec.actionUrl ?? null, spec.actionLabel ?? null, spec.expiresAt ?? null],
    'notification_broadcast',
  );
  return rowCount;
}

/** A player's inbox. Expired notifications are filtered by the READ. */
export async function listNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM notifications
      WHERE user_id = $1
        AND (expires_at IS NULL OR expires_at > now())
        ${unreadOnly ? 'AND NOT is_read' : ''}
      ORDER BY created_at DESC LIMIT $2`,
    [String(userId), Math.min(Math.max(Number(limit) || 50, 1), 200)], 'notification_list',
  );
  return rows.map(toNotification);
}

export async function unreadCount(userId) {
  const { rows } = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE user_id = $1 AND NOT is_read AND (expires_at IS NULL OR expires_at > now())`,
    [String(userId)], 'notification_unread_count',
  );
  return rows[0].n;
}

/** Mark read. The flag and its timestamp move together — the CHECK requires it. */
export async function markRead(userId, { ids = null } = {}) {
  const { rowCount } = await pgQuery(
    `UPDATE notifications SET is_read = TRUE, read_at = now()
      WHERE user_id = $1 AND NOT is_read
        ${ids ? 'AND id = ANY($2::bigint[])' : ''}`,
    ids ? [String(userId), ids.map(Number)] : [String(userId)], 'notification_mark_read',
  );
  return rowCount;
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

/**
 * Store a rebuilt leaderboard.
 *
 * Genuinely a CACHE. It is derived from bets and settlements, rebuilt on a
 * schedule, and nothing reads it to make a decision — so losing it costs a
 * rebuild rather than a fact. That is why it is a JSONB blob and not a table.
 */
export async function putLeaderboard(period, entries) {
  const { rows } = await pgQuery(
    `INSERT INTO leaderboard_cache (period, entries, generated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (period) DO UPDATE SET entries = EXCLUDED.entries, generated_at = now()
     RETURNING period, generated_at`,
    [String(period), JSON.stringify(entries ?? [])], 'leaderboard_put',
  );
  return { period: rows[0].period, generatedAt: rows[0].generated_at };
}

export async function getLeaderboard(period) {
  const { rows } = await pgQuery(
    'SELECT entries, generated_at FROM leaderboard_cache WHERE period = $1',
    [String(period)], 'leaderboard_get',
  );
  return rows[0] ? { entries: rows[0].entries, generatedAt: rows[0].generated_at } : null;
}

// ── Marketing carousel ──────────────────────────────────────────────────────

const toFakeWinner = (r) => (r ? {
  id: Number(r.id), displayName: r.display_name, profilePic: r.profile_pic,
  city: r.city, amount: paiseToRupees(Number(r.amount_paise)),
  game: r.game, badge: r.badge, userId: r.user_id,
  isPublic: r.is_public, sortOrder: r.sort_order, displayTime: r.display_time,
  createdBy: r.created_by, createdAt: r.created_at,
} : null);

/**
 * Add a display winner to the carousel.
 *
 * These are NOT players and carry no money. `userId` stays nullable and is not
 * a foreign key, deliberately: attaching one to a real account would put a
 * fabricated payout next to a real person's name.
 */
export async function addFakeWinner(spec) {
  const { rows } = await pgQuery(
    `INSERT INTO fake_winners (display_name, profile_pic, city, amount_paise, game,
       badge, user_id, is_public, sort_order, display_time, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [String(spec.displayName), spec.profilePic ?? null, spec.city ?? null,
      rupeesToPaise(spec.amountRupees || 0), spec.game ?? null, spec.badge ?? null,
      spec.userId ?? null, spec.isPublic !== false, Number(spec.sortOrder) || 0,
      spec.displayTime ?? null, spec.createdBy ?? null], 'fake_winner_add',
  );
  return toFakeWinner(rows[0]);
}

export async function listFakeWinners({ publicOnly = true, limit = 50 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM fake_winners ${publicOnly ? 'WHERE is_public' : ''}
      ORDER BY sort_order, display_time DESC NULLS LAST LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)], 'fake_winner_list',
  );
  return rows.map(toFakeWinner);
}

/**
 * Real winners: settled winning bets in a window, with the player attached.
 *
 * ── The query that never matched ────────────────────────────────────────────
 * The public feed filtered on `isWinner` and `winAmount`, two fields that have
 * NEVER existed on a bet — it is `status = 'WON'` and a payout. So the query
 * matched nothing and the winners feed showed ONLY the curated entries. A
 * marketing carousel with no real winners in it, indefinitely, and nothing to
 * say so: an empty result from a wrong field looks exactly like a quiet day.
 *
 * The payout is the NET figure actually credited, after the winnings fee. The
 * gross would overstate what a player received on a public page.
 */
export async function realWinners({ sinceHours = 24, limit = 20 } = {}) {
  const { rows } = await pgQuery(
    `SELECT b.bet_id, b.user_id, b.cycle_id, b.side, b.payout_paise, b.settled_at,
            COALESCE(u.username, 'Player') AS username,
            COALESCE(u.profile_pic, '')    AS profile_pic
       FROM bets b
       LEFT JOIN users u ON u.user_id = b.user_id
      WHERE b.status = 'WON'
        AND b.settled_at IS NOT NULL
        AND b.settled_at >= now() - ($1 || ' hours')::interval
        AND b.payout_paise > 0
      ORDER BY b.payout_paise DESC
      LIMIT $2`,
    [String(Math.max(Number(sinceHours) || 24, 1)),
      Math.min(Math.max(Number(limit) || 20, 1), 100)],
    'engagement_real_winners',
  );
  return rows.map((r) => ({
    displayName: r.username,
    profilePic: r.profile_pic,
    amount: paiseToRupees(Number(r.payout_paise)),
    game: 'Delhi/Bombay',
    cycleId: r.cycle_id,
    side: r.side,
    city: '',
    displayTime: r.settled_at,
    isReal: true,
  }));
}

/** Curated carousel entries inside a window, newest first. */
export async function curatedWinners({ sinceHours = 24, limit = 50 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM fake_winners
      WHERE is_public
        AND display_time >= now() - ($1 || ' hours')::interval
      ORDER BY sort_order ASC, display_time DESC
      LIMIT $2`,
    [String(Math.max(Number(sinceHours) || 24, 1)),
      Math.min(Math.max(Number(limit) || 50, 1), 200)],
    'engagement_curated_winners',
  );
  return rows.map((r) => ({ ...toFakeWinner(r), isReal: false }));
}

/** Edit a curated entry. Returns null for an id that does not exist. */
export async function updateFakeWinner(id, patch = {}) {
  const COLUMN = {
    displayName: 'display_name', profilePic: 'profile_pic', city: 'city',
    game: 'game', badge: 'badge', isPublic: 'is_public',
    sortOrder: 'sort_order', displayTime: 'display_time',
  };
  const sets = []; const params = [Number(id)];
  for (const [key, column] of Object.entries(COLUMN)) {
    if (patch[key] === undefined) continue;
    params.push(column === 'sort_order' ? (Number(patch[key]) || 0)
      : column === 'is_public' ? Boolean(patch[key]) : patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (patch.amount !== undefined) {
    params.push(rupeesToPaise(patch.amount));
    sets.push(`amount_paise = $${params.length}`);
  }
  if (!sets.length) {
    const { rows } = await pgQuery('SELECT * FROM fake_winners WHERE id = $1', [Number(id)], 'fake_winner_get');
    return toFakeWinner(rows[0]);
  }
  const { rows } = await pgQuery(
    `UPDATE fake_winners SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params, 'fake_winner_update',
  );
  return toFakeWinner(rows[0]);
}

export async function deleteFakeWinner(id) {
  const { rowCount } = await pgQuery(
    'DELETE FROM fake_winners WHERE id = $1', [Number(id)], 'fake_winner_delete',
  );
  return rowCount > 0;
}
