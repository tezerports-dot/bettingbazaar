// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/cricket.js — cricket opinion polls (owner, 2026-10-18;
 * docs/reference/CRICKET_OPINION_DESIGN.md). The one writer of `cricket_feed`,
 * `cricket_series_follows`, `cricket_matches`, `cricket_deliveries`,
 * `cricket_polls`, `cricket_poll_options` and `cricket_bets` (schema.sql
 * "CRICKET OPINION POLLS").
 *
 * ── Money ───────────────────────────────────────────────────────────────────
 * A stake leaves the player's pockets (split by the board rule) to the house
 * in the transaction that writes the bet; a claim, a win or a refund comes
 * back from the house into winnings (a refund returns each part to the pocket
 * it came from). Every one is `wallets.core.applyMovementWithin` with the
 * house as counterparty, so USER_FLOAT and HOUSE_RESERVE move with it
 * (§2 *Token conservation*).
 *
 * ── Locks, in this order everywhere ─────────────────────────────────────────
 * the player's wallet, then the poll rows (by id), then their options. A bet,
 * a claim and a settlement all take the wallet first, so a settlement (every
 * winner's wallet, sorted, then the poll) never waits on a bet that holds the
 * poll and wants a wallet.
 *
 * ── The book ────────────────────────────────────────────────────────────────
 * `cricketPricing.js` prices a bet or a claim from the rows locked here; the
 * schema refuses at COMMIT a poll whose book would cost the house more than
 * its seed (`bb_cricket_book_bound`), whoever wrote it.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';
import { applyMovementWithin, lockWalletWithin } from './wallets.core.js';
import { recordGameEventWithin } from './rtp.js';
import { splitStakeMinor } from '../../backend/domains/risk/stakeFunding.js';
import { quoteBet, quoteClaim, displayOddsX100, winningsFeePaise } from '../../backend/domains/cricket/cricketPricing.js';

export const CRICKET_GAME_KEY = 'CRICKET';
const AUDIENCE = 'VIP';
const num = (v) => Number(v ?? 0);
const refuse = (reason, extra = {}) => ({ commit: false, value: { ok: false, reason, ...extra } });

/** One transaction; the callback returns { commit, value }. */
async function inTx(fn) {
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;
  try {
    await client.query('BEGIN');
    const { commit, value } = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    client.release(failure ?? undefined);
  }
}

// ── The feed's token and health ──────────────────────────────────────────────

/** What the admin may see of the feed: never the token. */
export async function getFeed() {
  const { rows } = await pgQuery('SELECT * FROM cricket_feed WHERE id = 1', [], 'cricket_feed_read');
  const r = rows[0];
  return {
    provider: r?.provider ?? 'SPORTMONKS',
    tokenSet: !!r?.token_enc,
    setBy: r?.set_by ?? null,
    setAt: r?.set_at ?? null,
    lastOkAt: r?.last_ok_at ?? null,
    lastError: r?.last_error ?? null,
    lastErrorAt: r?.last_error_at ?? null,
  };
}

/** The stored ciphertext, for the feed adapter alone (it decrypts). */
export async function feedTokenCiphertext() {
  const { rows } = await pgQuery('SELECT token_enc FROM cricket_feed WHERE id = 1', [], 'cricket_feed_token');
  return rows[0]?.token_enc ?? null;
}

/** Save (or clear, with null) the encrypted token. */
export async function setFeedToken({ tokenEnc, by }) {
  await pgQuery(
    `INSERT INTO cricket_feed (id, token_enc, set_by, set_at) VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET token_enc = EXCLUDED.token_enc, set_by = EXCLUDED.set_by,
       set_at = EXCLUDED.set_at, last_error = NULL, last_error_at = NULL`,
    [tokenEnc, String(by)], 'cricket_feed_set',
  );
  return getFeed();
}

/** The feed's last answer, for the admin page. */
export async function recordFeedResult({ ok, error = null }) {
  await pgQuery(
    ok
      ? `INSERT INTO cricket_feed (id, last_ok_at) VALUES (1, now())
         ON CONFLICT (id) DO UPDATE SET last_ok_at = now()`
      : `INSERT INTO cricket_feed (id, last_error, last_error_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now()`,
    ok ? [] : [String(error).slice(0, 500)], 'cricket_feed_result',
  );
}

// ── Series the admin follows ─────────────────────────────────────────────────

export async function listFollows() {
  const { rows } = await pgQuery('SELECT * FROM cricket_series_follows ORDER BY followed_at', [], 'cricket_follows');
  return rows.map((r) => ({ seriesId: r.series_id, seriesName: r.series_name, followedBy: r.followed_by, followedAt: r.followed_at }));
}

/** Follow a series and publish every fixture of it already listed. */
export async function followSeries({ seriesId, seriesName, by }) {
  return inTx(async (client) => {
    await client.query(
      `INSERT INTO cricket_series_follows (series_id, series_name, followed_by) VALUES ($1,$2,$3)
       ON CONFLICT (series_id) DO NOTHING`,
      [String(seriesId), String(seriesName || seriesId), String(by)],
    );
    const { rowCount } = await client.query(
      `UPDATE cricket_matches SET published = TRUE, published_at = now(), published_by = $2, updated_at = now()
        WHERE series_id = $1 AND NOT published`,
      [String(seriesId), String(by)],
    );
    return { commit: true, value: { published: rowCount } };
  });
}

export async function unfollowSeries(seriesId) {
  const { rowCount } = await pgQuery('DELETE FROM cricket_series_follows WHERE series_id = $1', [String(seriesId)], 'cricket_unfollow');
  return rowCount > 0;
}

// ── Matches ──────────────────────────────────────────────────────────────────

function toMatch(r) {
  if (!r) return null;
  return {
    matchId: r.match_id,
    feedFixtureId: r.feed_fixture_id,
    seriesId: r.series_id,
    seriesName: r.series_name,
    format: r.format,
    teamA: { id: r.team_a_id, name: r.team_a_name, code: r.team_a_code, logo: r.team_a_logo },
    teamB: { id: r.team_b_id, name: r.team_b_name, code: r.team_b_code, logo: r.team_b_logo },
    venue: r.venue,
    startsAt: r.starts_at,
    status: r.status,
    published: r.published,
    publishedAt: r.published_at,
    displayOrder: r.display_order === null ? null : num(r.display_order),
    toss: r.toss_winner ? { winner: r.toss_winner, elected: r.toss_elected } : null,
    result: r.result,
    manOfMatchId: r.man_of_match_id,
    lineup: r.lineup ?? [],
    score: r.score ?? {},
    lastEventAt: r.last_event_at,
    finishedAt: r.finished_at,
  };
}

export const matchIdFor = (feedFixtureId) => `CM${String(feedFixtureId).replace(/[^A-Za-z0-9]/g, '')}`;

/**
 * Fixtures the feed lists, added or refreshed (names, start, series). A new
 * fixture of a followed series is published as it arrives. Facts that move
 * during play (status, toss, result) are `applyMatchFacts`'s.
 */
export async function upsertFixtures(fixtures) {
  let added = 0;
  for (const f of fixtures) {
    const { rows } = await pgQuery(
      `INSERT INTO cricket_matches
         (match_id, feed_fixture_id, series_id, series_name, format, team_a_id, team_a_name, team_a_code,
          team_a_logo, team_b_id, team_b_name, team_b_code, team_b_logo, venue, starts_at,
          published, published_at, published_by)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
              f.series_id IS NOT NULL, CASE WHEN f.series_id IS NOT NULL THEN now() END,
              CASE WHEN f.series_id IS NOT NULL THEN f.followed_by END
         FROM (SELECT NULL) x LEFT JOIN cricket_series_follows f ON f.series_id = $3
       ON CONFLICT (feed_fixture_id) DO UPDATE SET
         series_id = EXCLUDED.series_id, series_name = EXCLUDED.series_name, format = EXCLUDED.format,
         team_a_name = EXCLUDED.team_a_name, team_a_code = EXCLUDED.team_a_code, team_a_logo = EXCLUDED.team_a_logo,
         team_b_name = EXCLUDED.team_b_name, team_b_code = EXCLUDED.team_b_code, team_b_logo = EXCLUDED.team_b_logo,
         venue = EXCLUDED.venue, starts_at = EXCLUDED.starts_at, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [matchIdFor(f.feedId), String(f.feedId), f.seriesId ? String(f.seriesId) : null, f.seriesName ?? null,
        f.format, String(f.teamA.id), f.teamA.name, f.teamA.code ?? null, f.teamA.logo ?? null,
        String(f.teamB.id), f.teamB.name, f.teamB.code ?? null, f.teamB.logo ?? null, f.venue ?? null, f.startsAt],
      'cricket_fixture_upsert',
    );
    if (rows[0]?.inserted) added += 1;
  }
  return { added };
}

export async function getMatch(matchId) {
  const { rows } = await pgQuery('SELECT * FROM cricket_matches WHERE match_id = $1', [String(matchId)], 'cricket_match_get');
  return toMatch(rows[0]);
}

/** Every match the admin can pick from: upcoming and recent, published or not. */
export async function listMatchesForAdmin({ sinceHours = 48 } = {}) {
  const { rows } = await pgQuery(
    `SELECT m.*,
            (SELECT COALESCE(SUM(p.stakes_paise), 0) FROM cricket_polls p WHERE p.match_id = m.match_id) AS stakes_paise,
            (SELECT COUNT(*) FROM cricket_bets b WHERE b.match_id = m.match_id) AS bet_count
       FROM cricket_matches m
      WHERE m.starts_at > now() - make_interval(hours => $1) OR m.published
      ORDER BY m.published DESC, m.display_order NULLS LAST, m.starts_at
      LIMIT 500`,
    [Math.min(Math.max(Number(sinceHours) || 48, 1), 24 * 30)], 'cricket_matches_admin',
  );
  return rows.map((r) => ({ ...toMatch(r), stakesPaise: num(r.stakes_paise), betCount: num(r.bet_count) }));
}

/**
 * The matches players see, in the admin's order: ordered ones first, top to
 * bottom, then the rest by start time. A finished match stays for six hours.
 */
export async function listPlayerMatches() {
  const { rows } = await pgQuery(
    `SELECT * FROM cricket_matches
      WHERE published AND (finished_at IS NULL OR finished_at > now() - interval '6 hours')
      ORDER BY display_order NULLS LAST, starts_at
      LIMIT 100`,
    [], 'cricket_matches_player',
  );
  return rows.map(toMatch);
}

/** Matches the live sync follows: published, not over, starting within two hours or under way. */
export async function listMatchesToSync() {
  const { rows } = await pgQuery(
    `SELECT * FROM cricket_matches
      WHERE published AND status NOT IN ('FINISHED', 'ABANDONED')
        AND starts_at < now() + interval '2 hours'
      ORDER BY starts_at LIMIT 50`,
    [], 'cricket_matches_sync',
  );
  return rows.map(toMatch);
}

/** Finished matches whose man of the match is still awaited. */
export async function listMatchesAwaitingMom() {
  const { rows } = await pgQuery(
    `SELECT m.* FROM cricket_matches m
      WHERE m.published AND m.status = 'FINISHED'
        AND EXISTS (SELECT 1 FROM cricket_polls p WHERE p.match_id = m.match_id AND p.kind = 'MOM' AND p.status IN ('OPEN', 'CLOSED'))
      ORDER BY m.finished_at LIMIT 50`,
    [], 'cricket_matches_mom',
  );
  return rows.map(toMatch);
}

export async function publishMatch(matchId, by) {
  const { rows } = await pgQuery(
    `UPDATE cricket_matches SET published = TRUE, published_at = now(), published_by = $2, updated_at = now()
      WHERE match_id = $1 AND NOT published RETURNING *`,
    [String(matchId), String(by)], 'cricket_publish',
  );
  return toMatch(rows[0]) ?? getMatch(matchId);
}

/**
 * Take a match off the players' list. Refused once anyone has bet on it: its
 * polls must run to their end. Its untouched polls go with it.
 */
export async function unpublishMatch(matchId) {
  return inTx(async (client) => {
    const { rows: m } = await client.query('SELECT match_id FROM cricket_matches WHERE match_id = $1 FOR UPDATE', [String(matchId)]);
    if (!m[0]) return refuse('NOT_FOUND');
    const { rows: b } = await client.query('SELECT 1 FROM cricket_bets WHERE match_id = $1 LIMIT 1', [String(matchId)]);
    if (b[0]) return refuse('MATCH_HAS_BETS');
    await client.query('DELETE FROM cricket_poll_options WHERE poll_id IN (SELECT poll_id FROM cricket_polls WHERE match_id = $1)', [String(matchId)]);
    await client.query('DELETE FROM cricket_polls WHERE match_id = $1', [String(matchId)]);
    await client.query(
      `UPDATE cricket_matches SET published = FALSE, published_at = NULL, published_by = NULL,
              display_order = NULL, updated_at = now() WHERE match_id = $1`,
      [String(matchId)],
    );
    return { commit: true, value: { ok: true } };
  });
}

/**
 * The admin's order, top to bottom: each listed match takes its place; every
 * other match goes back to start-time order.
 */
export async function setDisplayOrder(matchIds) {
  if (!Array.isArray(matchIds) || matchIds.some((id) => typeof id !== 'string')) {
    throw Object.assign(new Error('Send the match ids, top to bottom.'), { status: 400, code: 'INVALID_ORDER' });
  }
  if (new Set(matchIds).size !== matchIds.length) {
    throw Object.assign(new Error('A match is listed twice.'), { status: 400, code: 'INVALID_ORDER' });
  }
  return inTx(async (client) => {
    await client.query('UPDATE cricket_matches SET display_order = NULL WHERE display_order IS NOT NULL');
    const { rowCount } = await client.query(
      `UPDATE cricket_matches m SET display_order = o.n - 1, updated_at = now()
         FROM unnest($1::text[]) WITH ORDINALITY AS o(id, n)
        WHERE m.match_id = o.id AND m.published`,
      [matchIds],
    );
    if (rowCount !== matchIds.length) {
      return refuse('UNKNOWN_MATCH');
    }
    return { commit: true, value: { ok: true } };
  });
}

/**
 * The facts the feed reported, written as they stand. `eventAt` moves the
 * match's last event time (a delivery or a toss), which refuses every bet and
 * claim pressed before it and still waiting its delay.
 */
export async function applyMatchFacts(matchId, facts) {
  const sets = ['updated_at = now()'];
  const params = [String(matchId)];
  const put = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (facts.status) put('status', facts.status);
  if (facts.toss) { put('toss_winner', facts.toss.winner); put('toss_elected', facts.toss.elected); }
  if (facts.result) put('result', facts.result);
  if (facts.manOfMatchId) put('man_of_match_id', String(facts.manOfMatchId));
  if (facts.lineup) put('lineup', JSON.stringify(facts.lineup));
  if (facts.score) put('score', JSON.stringify(facts.score));
  if (facts.status === 'FINISHED' || facts.status === 'ABANDONED') sets.push('finished_at = COALESCE(finished_at, now())');
  if (facts.eventAt) { params.push(facts.eventAt); sets.push(`last_event_at = GREATEST(COALESCE(last_event_at, $${params.length}), $${params.length})`); }
  const { rows } = await pgQuery(
    `UPDATE cricket_matches SET ${sets.join(', ')} WHERE match_id = $1 RETURNING *`, params, 'cricket_match_facts');
  return toMatch(rows[0]);
}

// ── Deliveries ───────────────────────────────────────────────────────────────

/**
 * Record each delivery not seen before, in order, numbering them 1, 2, 3…
 * per match. Returns the ones that are new.
 */
export async function recordDeliveries(matchId, deliveries) {
  return inTx(async (client) => {
    await client.query('SELECT 1 FROM cricket_matches WHERE match_id = $1 FOR UPDATE', [String(matchId)]);
    const { rows: seen } = await client.query(
      'SELECT delivery_key, seq FROM cricket_deliveries WHERE match_id = $1', [String(matchId)]);
    const known = new Set(seen.map((r) => r.delivery_key));
    let seq = seen.reduce((m, r) => Math.max(m, num(r.seq)), 0);
    const fresh = [];
    for (const d of deliveries) {
      if (known.has(d.key)) continue;
      seq += 1;
      await client.query(
        `INSERT INTO cricket_deliveries (match_id, seq, delivery_key, innings, over_no, ball_label, outcome, runs, feed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [String(matchId), seq, d.key, d.innings, d.overNo, d.ballLabel, d.outcome, d.runs, d.at ?? null],
      );
      known.add(d.key);
      fresh.push({ ...d, seq });
    }
    if (fresh.length) {
      await client.query(
        'UPDATE cricket_matches SET last_event_at = GREATEST(COALESCE(last_event_at, now()), now()), updated_at = now() WHERE match_id = $1',
        [String(matchId)]);
    }
    return { commit: true, value: fresh };
  });
}

/** Runs conceded in one over, extras included, and how many deliveries it had. */
export async function overRuns(matchId, innings, overNo) {
  const { rows } = await pgQuery(
    `SELECT COALESCE(SUM(runs), 0) AS runs, COUNT(*) AS balls,
            COUNT(*) FILTER (WHERE outcome NOT IN ('WIDE', 'NO_BALL')) AS legal
       FROM cricket_deliveries
      WHERE match_id = $1 AND innings = $2 AND over_no = $3`,
    [String(matchId), innings, overNo], 'cricket_over_runs',
  );
  return { runs: num(rows[0].runs), deliveries: num(rows[0].balls), legal: num(rows[0].legal) };
}

export async function lastDelivery(matchId) {
  const { rows } = await pgQuery(
    'SELECT * FROM cricket_deliveries WHERE match_id = $1 ORDER BY seq DESC LIMIT 1', [String(matchId)], 'cricket_delivery_last');
  const r = rows[0];
  return r ? { seq: num(r.seq), innings: num(r.innings), overNo: num(r.over_no), ballLabel: r.ball_label, outcome: r.outcome, runs: num(r.runs) } : null;
}

// ── Polls ────────────────────────────────────────────────────────────────────

function toPoll(r, options = []) {
  const pools = Object.fromEntries(options.map((o) => [o.option_key, num(o.pool_paise)]));
  const odds = options.length ? displayOddsX100({ spreadBp: num(r.spread_bp), seedPaise: num(r.seed_paise), pools }) : {};
  return {
    pollId: r.poll_id,
    matchId: r.match_id,
    kind: r.kind,
    innings: num(r.innings),
    overNo: num(r.over_no),
    seq: num(r.seq),
    title: r.title,
    status: r.status,
    spreadBp: num(r.spread_bp),
    seedPaise: num(r.seed_paise),
    openedAt: r.opened_at,
    closesAt: r.closes_at,
    closedAt: r.closed_at,
    settledAt: r.settled_at,
    winningOption: r.winning_option,
    voidReason: r.void_reason,
    options: options.map((o) => ({
      key: o.option_key, label: o.label,
      // The pool the odds read: the seed plus real live stakes (§11 mirror in the player app).
      poolPaise: num(r.seed_paise) + num(o.pool_paise),
      oddsX100: odds[o.option_key],
    })),
  };
}

/** The admin's view adds the real money and the book per option. */
function toAdminPoll(r, options) {
  const p = toPoll(r, options);
  const bound = num(r.seed_paise) * num(r.option_count);
  return {
    ...p,
    stakesPaise: num(r.stakes_paise),
    claimsPaidPaise: num(r.claims_paid_paise),
    wonPaidPaise: num(r.won_paid_paise),
    feesPaise: num(r.fees_paise),
    refundedPaise: num(r.refunded_paise),
    maxLossPaise: bound,
    book: options.map((o) => ({
      key: o.option_key, label: o.label,
      realPoolPaise: num(o.pool_paise),
      liabilityPaise: num(o.liability_paise),
      ifWinsPaise: num(r.stakes_paise) - num(r.claims_paid_paise) - num(o.liability_paise),
    })),
  };
}

async function pollsWithOptions(where, params, label, mapper = toPoll) {
  const { rows } = await pgQuery(`SELECT * FROM cricket_polls WHERE ${where}`, params, `${label}_polls`);
  if (!rows.length) return [];
  const { rows: opts } = await pgQuery(
    'SELECT * FROM cricket_poll_options WHERE poll_id = ANY($1) ORDER BY sort', [rows.map((r) => r.poll_id)], `${label}_options`);
  const byPoll = new Map();
  for (const o of opts) {
    if (!byPoll.has(o.poll_id)) byPoll.set(o.poll_id, []);
    byPoll.get(o.poll_id).push(o);
  }
  return rows.map((r) => mapper(r, byPoll.get(r.poll_id) ?? []));
}

const POLL_ORDER = `ORDER BY CASE kind WHEN 'BALL' THEN 0 WHEN 'OVER' THEN 1 WHEN 'MATCH_RESULT' THEN 2 WHEN 'TOSS' THEN 3 ELSE 4 END, seq DESC, innings DESC, over_no DESC`;

/**
 * A match's polls for players (owner, 2026-10-18: no long list of balls and
 * overs). The toss, result and man-of-the-match polls, plus, for next-ball and
 * over polls, only the last one ended, the one in play and the one taking
 * bets: a ball poll is live while it takes bets and its successor opens when
 * the ball lands; an over poll takes bets during the over before it, so the
 * over being bowled (CLOSED) is "live" and the OPEN one is "next".
 */
export async function playerPolls(matchId) {
  return pollsWithOptions(
    `match_id = $1 AND (kind IN ('TOSS', 'MATCH_RESULT', 'MOM', 'TOP_BATSMAN', 'TOP_BOWLER') OR status IN ('OPEN', 'CLOSED')
       OR poll_id IN (SELECT DISTINCT ON (kind) poll_id FROM cricket_polls
                       WHERE match_id = $1 AND kind IN ('BALL', 'OVER') AND status IN ('SETTLED', 'VOID')
                       ORDER BY kind, innings DESC, over_no DESC, seq DESC))
     ${POLL_ORDER} LIMIT 12`,
    [String(matchId)], 'cricket_player');
}

/** Every poll of a match, with its book, for the admin. */
export async function adminPolls(matchId) {
  return pollsWithOptions(`match_id = $1 ${POLL_ORDER} LIMIT 500`, [String(matchId)], 'cricket_admin', toAdminPoll);
}

export async function getPoll(pollId) {
  const [p] = await pollsWithOptions('poll_id = $1', [String(pollId)], 'cricket_poll_get');
  return p ?? null;
}

/** Polls of a match still OPEN or CLOSED (not ended), by kind. */
export async function unendedPolls(matchId) {
  const { rows } = await pgQuery(
    `SELECT poll_id, kind, innings, over_no, seq, status, closes_at FROM cricket_polls
      WHERE match_id = $1 AND status IN ('OPEN', 'CLOSED')`, [String(matchId)], 'cricket_unended');
  return rows.map((r) => ({ pollId: r.poll_id, kind: r.kind, innings: num(r.innings), overNo: num(r.over_no), seq: num(r.seq), status: r.status, closesAt: r.closes_at }));
}

/**
 * Open a poll once (its position is UNIQUE): the spread and seed are frozen on
 * it. Returns the poll, or null when it already existed.
 */
export async function openPoll({ pollId, matchId, kind, innings = 0, overNo = 0, seq = 0, title, closesAt = null, spreadBp, seedPaise, options }) {
  if (!Array.isArray(options) || options.length < 2) return null;
  return inTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO cricket_polls (poll_id, match_id, kind, innings, over_no, seq, title, closes_at, spread_bp, seed_paise, option_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING RETURNING poll_id`,
      [pollId, String(matchId), kind, innings, overNo, seq, title, closesAt, spreadBp, seedPaise, options.length],
    );
    if (!rows[0]) return { commit: false, value: null };
    await client.query(
      `INSERT INTO cricket_poll_options (poll_id, option_key, label, sort)
       SELECT $1, o.key, o.label, o.n - 1 FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS o(key, label, n)`,
      [pollId, options.map((o) => o.key), options.map((o) => o.label)],
    );
    return { commit: true, value: pollId };
  });
}

/** Stop a poll taking bets and claims. Idempotent. */
export async function closePoll(pollId) {
  const { rowCount } = await pgQuery(
    `UPDATE cricket_polls SET status = 'CLOSED', closed_at = now() WHERE poll_id = $1 AND status = 'OPEN'`,
    [String(pollId)], 'cricket_poll_close');
  return rowCount > 0;
}

/** Every OPEN poll whose closing time has passed, closed. Returns their match ids. */
export async function closeDuePolls() {
  const { rows } = await pgQuery(
    `UPDATE cricket_polls SET status = 'CLOSED', closed_at = now()
      WHERE status = 'OPEN' AND closes_at IS NOT NULL AND closes_at <= now()
      RETURNING match_id`, [], 'cricket_poll_close_due');
  return [...new Set(rows.map((r) => r.match_id))];
}

// ── Bets ─────────────────────────────────────────────────────────────────────

function toBet(r) {
  return {
    betId: r.bet_id,
    userId: r.user_id,
    pollId: r.poll_id,
    matchId: r.match_id,
    optionKey: r.option_key,
    stakePaise: num(r.stake_paise),
    oddsX100: num(r.odds_x100),
    potentialPaise: num(r.potential_paise),
    status: r.status,
    paidPaise: num(r.paid_paise),
    feePaise: num(r.fee_paise),
    placedAt: r.placed_at,
    endedAt: r.ended_at,
  };
}

async function lockPollBook(client, pollId) {
  const { rows } = await client.query('SELECT * FROM cricket_polls WHERE poll_id = $1 FOR UPDATE', [String(pollId)]);
  if (!rows[0]) return null;
  const { rows: opts } = await client.query(
    'SELECT * FROM cricket_poll_options WHERE poll_id = $1 ORDER BY option_key FOR UPDATE', [String(pollId)]);
  return bookOf(rows[0], opts);
}

function bookOf(row, opts) {
  return {
    row,
    book: {
      seedPaise: num(row.seed_paise), optionCount: num(row.option_count),
      stakesPaise: num(row.stakes_paise), claimsPaidPaise: num(row.claims_paid_paise),
    },
    spreadBp: num(row.spread_bp),
    pools: Object.fromEntries(opts.map((o) => [o.option_key, num(o.pool_paise)])),
    liabilities: Object.fromEntries(opts.map((o) => [o.option_key, num(o.liability_paise)])),
    labels: Object.fromEntries(opts.map((o) => [o.option_key, o.label])),
  };
}

/** Whether a poll still takes bets and claims for a press made at `requestedAt`. */
async function admissionOf(client, poll, requestedAt) {
  if (poll.status !== 'OPEN') return 'POLL_CLOSED';
  if (poll.closes_at && new Date(poll.closes_at) <= new Date()) return 'POLL_CLOSED';
  const { rows } = await client.query('SELECT last_event_at, published FROM cricket_matches WHERE match_id = $1', [poll.match_id]);
  if (!rows[0]?.published) return 'POLL_CLOSED';
  if (rows[0].last_event_at && new Date(rows[0].last_event_at) > new Date(requestedAt)) return 'EVENT_DURING_DELAY';
  return null;
}

/**
 * Place a bet, at the odds the poll gives NOW (its own stake counted, cut to
 * the book's bound), if they are at least `minOddsX100`. Keyed by `betId`, so
 * a retry answers the bet already placed.
 *
 * @returns {ok:true, bet, balances, idempotent?} | {ok:false, reason, quote?}
 *   reasons: POLL_NOT_FOUND, POLL_CLOSED, EVENT_DURING_DELAY, UNKNOWN_OPTION,
 *   OPTION_SUSPENDED, ODDS_CHANGED (with the new quote), insufficient
 */
export async function placeBet({ betId, userId, pollId, optionKey, stakePaise, minOddsX100, requestedAt, reserveBp }) {
  return inTx(async (client) => {
    const ctx = await lockWalletWithin(client, userId);
    const { rows: prior } = await client.query('SELECT * FROM cricket_bets WHERE bet_id = $1', [betId]);
    if (prior[0]) {
      if (prior[0].user_id !== String(userId)) return refuse('BET_ID_TAKEN');
      return { commit: false, value: { ok: true, idempotent: true, bet: toBet(prior[0]), balances: ctx.balances } };
    }
    const locked = await lockPollBook(client, pollId);
    if (!locked) return refuse('POLL_NOT_FOUND');
    const shut = await admissionOf(client, locked.row, requestedAt);
    if (shut) return refuse(shut);
    if (!(optionKey in locked.pools)) return refuse('UNKNOWN_OPTION');

    const quote = quoteBet({ spreadBp: locked.spreadBp, book: locked.book, pools: locked.pools, liabilities: locked.liabilities, optionKey, stakePaise });
    if (!quote.ok) return refuse(quote.reason);
    if (quote.oddsX100 < minOddsX100) return refuse('ODDS_CHANGED', { quote: { oddsX100: quote.oddsX100, potentialPaise: quote.potentialPaise } });

    const split = splitStakeMinor({
      amountMinor: stakePaise, reserveBp,
      depositMinor: ctx.balances.depositBalance, winningsMinor: ctx.balances.winningsBalance, reserveMinor: ctx.balances.reserveBalance,
    });
    if (!split) return refuse('insufficient');
    const parts = [
      { field: 'reserveBalance', amountPaise: split.fromReserveMinor },
      { field: 'depositBalance', amountPaise: split.fromDepositMinor },
      { field: 'winningsBalance', amountPaise: split.fromWinningsMinor },
    ].filter((p) => p.amountPaise > 0);

    const { rows: ins } = await client.query(
      `INSERT INTO cricket_bets (bet_id, user_id, poll_id, match_id, option_key, stake_paise, odds_x100, potential_paise,
                                 from_reserve_paise, from_deposit_paise, from_winnings_paise, requested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [betId, String(userId), pollId, locked.row.match_id, optionKey, stakePaise, quote.oddsX100, quote.potentialPaise,
        split.fromReserveMinor, split.fromDepositMinor, split.fromWinningsMinor, requestedAt],
    );
    const reason = `Cricket: ${locked.labels[optionKey]} @ ${(quote.oddsX100 / 100).toFixed(2)}`;
    const moved = await applyMovementWithin(ctx, {
      legs: parts.map((p) => ({ field: p.field, deltaPaise: 0 - p.amountPaise })),
      ledger: parts.map((p, i) => ({
        txId: i === 0 ? `cricket_bet_${betId}` : `cricket_bet:${p.field}:${betId}`,
        field: p.field, amountPaise: 0 - p.amountPaise, type: 'DEBIT', reason, refId: betId,
      })),
      counterparty: { house: true, operation: 'CRICKET_BET', reason, refModel: 'CricketBet', refId: betId },
    });
    if (!moved.ok || moved.idempotent) return refuse(moved.insufficient ? 'insufficient' : (moved.refused ?? 'insufficient'));

    await client.query(
      `UPDATE cricket_poll_options SET pool_paise = pool_paise + $3, liability_paise = liability_paise + $4
        WHERE poll_id = $1 AND option_key = $2`,
      [pollId, optionKey, stakePaise, quote.potentialPaise]);
    await client.query('UPDATE cricket_polls SET stakes_paise = stakes_paise + $2 WHERE poll_id = $1', [pollId, stakePaise]);
    return { commit: true, value: { ok: true, bet: toBet(ins[0]), balances: moved.balancesAfterPaise } };
  });
}

/** What a bet would get now (a read, not binding: the bet is priced again when it executes). */
export async function quoteBetNow({ pollId, optionKey, stakePaise }) {
  const { rows } = await pgQuery('SELECT * FROM cricket_polls WHERE poll_id = $1', [String(pollId)], 'cricket_quote_poll');
  if (!rows[0]) return { ok: false, reason: 'POLL_NOT_FOUND' };
  if (rows[0].status !== 'OPEN') return { ok: false, reason: 'POLL_CLOSED' };
  const { rows: opts } = await pgQuery('SELECT * FROM cricket_poll_options WHERE poll_id = $1', [String(pollId)], 'cricket_quote_opts');
  const b = bookOf(rows[0], opts);
  return quoteBet({ spreadBp: b.spreadBp, book: b.book, pools: b.pools, liabilities: b.liabilities, optionKey, stakePaise });
}

/**
 * What claiming these positions would pay now, priced position by position
 * against the book as the earlier claims leave it. Shared by the quote (a
 * read) and the claim (under the locks).
 */
function priceClaims(bets, books, { claimMarginBp, feeBp }) {
  const lines = [];
  for (const bet of bets) {
    const b = books.get(bet.poll_id);
    const q = quoteClaim({
      book: b.book, pools: b.pools, liabilities: b.liabilities, claimMarginBp, feeBp,
      bet: { optionKey: bet.option_key, stakePaise: num(bet.stake_paise), potentialPaise: num(bet.potential_paise) },
    });
    // The claim's effect on the book, for the next position on this poll.
    b.pools[bet.option_key] -= num(bet.stake_paise);
    b.liabilities[bet.option_key] -= num(bet.potential_paise);
    b.book.claimsPaidPaise += q.netPaise;
    lines.push({ bet, ...q });
  }
  return lines;
}

const claimableWhere = `b.user_id = $1 AND b.status = 'OPEN' AND p.status = 'OPEN' AND (p.closes_at IS NULL OR p.closes_at > now())`;

/**
 * A player's claimable bets. A bet placed less than `holdSec` seconds before
 * the claim was pressed (`pressedAt`; now for a quote) is left out of a match's Claim all, and named by id it
 * refuses the claim (CLAIM_TOO_SOON), so nobody places and claims in one
 * instant (owner, 2026-10-18).
 *
 * @returns {{bets: object[], tooSoon: boolean}}
 */
async function claimableBets(run, userId, { matchId = null, betIds = null, holdSec = 0, pressedAt = null }) {
  const params = [String(userId), holdSec, pressedAt];
  let where = claimableWhere;
  if (matchId) { params.push(String(matchId)); where += ` AND b.match_id = $${params.length}`; }
  if (betIds) { params.push(betIds.map(String)); where += ` AND b.bet_id = ANY($${params.length})`; }
  const { rows } = await run(
    `SELECT b.*, b.placed_at > COALESCE($3::timestamptz, now()) - make_interval(secs => $2::int) AS too_soon
       FROM cricket_bets b JOIN cricket_polls p ON p.poll_id = b.poll_id
      WHERE ${where} ORDER BY b.poll_id, b.bet_id`, params, 'cricket_claimable');
  return { bets: rows.filter((r) => !r.too_soon), tooSoon: rows.some((r) => r.too_soon) };
}

/** A quote for claiming (a read, not binding): each position and the total. */
export async function quoteClaims({ userId, matchId = null, betIds = null, holdSec = 0, claimMarginBp, feeBp }) {
  const { bets } = await claimableBets(pgQuery, userId, { matchId, betIds, holdSec });
  if (!bets.length) return { lines: [], totalNetPaise: 0, totalStakePaise: 0 };
  const pollIds = [...new Set(bets.map((b) => b.poll_id))];
  const { rows: polls } = await pgQuery('SELECT * FROM cricket_polls WHERE poll_id = ANY($1)', [pollIds], 'cricket_claim_quote_polls');
  const { rows: opts } = await pgQuery('SELECT * FROM cricket_poll_options WHERE poll_id = ANY($1)', [pollIds], 'cricket_claim_quote_opts');
  const books = new Map(polls.map((p) => [p.poll_id, bookOf(p, opts.filter((o) => o.poll_id === p.poll_id))]));
  const lines = priceClaims(bets, books, { claimMarginBp, feeBp });
  return summarise(lines);
}

function summarise(lines) {
  return {
    lines: lines.map((l) => ({
      betId: l.bet.bet_id, pollId: l.bet.poll_id, optionKey: l.bet.option_key,
      stakePaise: num(l.bet.stake_paise), grossPaise: l.grossPaise, feePaise: l.feePaise, netPaise: l.netPaise,
    })),
    totalNetPaise: lines.reduce((t, l) => t + l.netPaise, 0),
    totalStakePaise: lines.reduce((t, l) => t + num(l.bet.stake_paise), 0),
  };
}

/**
 * Claim open positions (one bet, or every claimable one of a match) at what
 * the pools give NOW, if the total is at least `minTotalNetPaise`; the player
 * is paid the whole claim or nothing.
 *
 * @returns {ok:true, claimed, totalNetPaise, balances} | {ok:false, reason, quote?}
 *   reasons: NOTHING_TO_CLAIM, CLAIM_TOO_SOON, POLL_CLOSED, EVENT_DURING_DELAY, QUOTE_CHANGED
 */
export async function claimPositions({ userId, matchId = null, betIds = null, holdSec = 0, minTotalNetPaise, requestedAt, claimMarginBp, feeBp }) {
  return inTx(async (client) => {
    const ctx = await lockWalletWithin(client, userId);
    const run = (sql, params) => client.query(sql, params);
    const { bets: candidates, tooSoon } = await claimableBets(run, userId, { matchId, betIds, holdSec, pressedAt: requestedAt });
    if (betIds && tooSoon) return refuse('CLAIM_TOO_SOON');
    if (!candidates.length) return refuse(tooSoon ? 'CLAIM_TOO_SOON' : 'NOTHING_TO_CLAIM');
    if (betIds && candidates.length !== new Set(betIds).size) return refuse('POLL_CLOSED');

    const pollIds = [...new Set(candidates.map((b) => b.poll_id))].sort();
    const books = new Map();
    for (const pollId of pollIds) {
      const locked = await lockPollBook(client, pollId);
      const shut = await admissionOf(client, locked.row, requestedAt);
      if (shut) return refuse(shut);
      books.set(pollId, locked);
    }
    // Re-read the bets under the poll locks: a settlement cannot have ended
    // them (the polls are OPEN), and this player's wallet lock keeps every
    // other claim of theirs out.
    const { rows: bets } = await client.query(
      `SELECT * FROM cricket_bets WHERE bet_id = ANY($1) AND status = 'OPEN' ORDER BY poll_id, bet_id FOR UPDATE`,
      [candidates.map((b) => b.bet_id)]);
    const lines = priceClaims(bets, books, { claimMarginBp, feeBp });
    const quote = summarise(lines);
    if (quote.totalNetPaise < minTotalNetPaise) return refuse('QUOTE_CHANGED', { quote });

    for (const l of lines) {
      await client.query(
        `UPDATE cricket_bets SET status = 'CLAIMED', paid_paise = $2, fee_paise = $3, ended_at = now() WHERE bet_id = $1`,
        [l.bet.bet_id, l.netPaise, l.feePaise]);
      await client.query(
        `UPDATE cricket_poll_options SET pool_paise = pool_paise - $3, liability_paise = liability_paise - $4
          WHERE poll_id = $1 AND option_key = $2`,
        [l.bet.poll_id, l.bet.option_key, num(l.bet.stake_paise), num(l.bet.potential_paise)]);
      await client.query(
        'UPDATE cricket_polls SET claims_paid_paise = claims_paid_paise + $2, fees_paise = fees_paise + $3 WHERE poll_id = $1',
        [l.bet.poll_id, l.netPaise, l.feePaise]);
    }
    const paying = lines.filter((l) => l.netPaise > 0);
    let balances = ctx.balances;
    if (paying.length) {
      const moved = await applyMovementWithin(ctx, {
        legs: [{ field: 'winningsBalance', deltaPaise: paying.reduce((t, l) => t + l.netPaise, 0) }],
        ledger: paying.map((l) => ({
          txId: `cricket_claim_${l.bet.bet_id}`, field: 'winningsBalance', amountPaise: l.netPaise, type: 'CREDIT',
          reason: `Cricket claim: ${books.get(l.bet.poll_id).labels[l.bet.option_key]}`, refId: l.bet.bet_id,
        })),
        counterparty: { house: true, operation: 'CRICKET_CLAIM', reason: 'Cricket claim', refModel: 'CricketBet', refId: paying[0].bet.bet_id },
      });
      if (!moved.ok || moved.idempotent) return refuse(moved.refused ?? 'CLAIM_REFUSED');
      balances = moved.balancesAfterPaise;
    }
    return { commit: true, value: { ok: true, claimed: quote.lines, totalNetPaise: quote.totalNetPaise, balances } };
  });
}

// ── Settlement ───────────────────────────────────────────────────────────────

/**
 * End a poll: settle it on `winningOption`, or void it (`voidReason`), paying
 * every OPEN bet in one transaction. A winning bet gets its payout less the
 * winnings fee into winnings; a losing one ends LOST; a void (or a bet pressed
 * at or after `voidPressedFrom`, the moment the decided delivery was recorded
 * by the feed) gets each part of its stake back to the pocket it came from.
 * Writes the poll's RTP entry. Idempotent: an ended poll answers `ENDED`.
 *
 * @returns {ok:true, payouts:[{userId, betId, paidPaise, status}]} | {ok:false, reason}
 */
export async function endPoll({ pollId, winningOption = null, voidReason = null, voidPressedFrom = null, feeBp }) {
  if ((winningOption === null) === (voidReason === null)) throw new Error('endPoll: name a winning option or a void reason, not both');
  // Close first, on its own: from here no bet or claim can reach this poll, so
  // the set of OPEN bets read below is the set settled.
  await pgQuery(`UPDATE cricket_polls SET status = 'CLOSED', closed_at = now() WHERE poll_id = $1 AND status = 'OPEN'`,
    [String(pollId)], 'cricket_poll_close_for_end');
  const { rows: who } = await pgQuery(
    `SELECT DISTINCT user_id FROM cricket_bets WHERE poll_id = $1 AND status = 'OPEN' ORDER BY user_id`,
    [String(pollId)], 'cricket_end_bettors');

  return inTx(async (client) => {
    const wallets = new Map();
    for (const { user_id: uid } of who) wallets.set(uid, await lockWalletWithin(client, uid));
    const locked = await lockPollBook(client, pollId);
    if (!locked) return refuse('POLL_NOT_FOUND');
    if (['SETTLED', 'VOID'].includes(locked.row.status)) return refuse('ENDED');
    if (winningOption !== null && !(winningOption in locked.pools)) {
      // The fact names no option (a man of the match not on the list): void.
      voidReason = 'The result is not one of the options';
      winningOption = null;
    }
    const { rows: bets } = await client.query(
      `SELECT * FROM cricket_bets WHERE poll_id = $1 AND status = 'OPEN' ORDER BY user_id, bet_id FOR UPDATE`, [String(pollId)]);
    const payouts = [];
    let won = 0; let fees = 0; let refunded = 0;
    const cutoff = voidPressedFrom ? new Date(voidPressedFrom) : null;

    for (const bet of bets) {
      const stake = num(bet.stake_paise);
      const late = cutoff && new Date(bet.requested_at) >= cutoff;
      const ctx = wallets.get(bet.user_id);
      let status; let paid = 0; let fee = 0;
      if (voidReason !== null || late) {
        status = 'VOID'; paid = stake; refunded += stake;
        const parts = [
          { field: 'reserveBalance', amountPaise: num(bet.from_reserve_paise) },
          { field: 'depositBalance', amountPaise: num(bet.from_deposit_paise) },
          { field: 'winningsBalance', amountPaise: num(bet.from_winnings_paise) },
        ].filter((p) => p.amountPaise > 0);
        const moved = await applyMovementWithin(ctx, {
          legs: parts.map((p) => ({ field: p.field, deltaPaise: p.amountPaise })),
          ledger: parts.map((p, i) => ({
            txId: i === 0 ? `cricket_refund_${bet.bet_id}` : `cricket_refund:${p.field}:${bet.bet_id}`,
            field: p.field, amountPaise: p.amountPaise, type: 'CREDIT',
            reason: late ? 'Cricket bet void: placed after the ball was bowled' : `Cricket poll void: ${voidReason}`, refId: bet.bet_id,
          })),
          counterparty: { house: true, operation: 'CRICKET_REFUND', reason: 'Cricket refund', refModel: 'CricketBet', refId: bet.bet_id },
        });
        if (!moved.ok || moved.idempotent) return refuse(moved.refused ?? 'REFUND_REFUSED');
      } else if (bet.option_key === winningOption) {
        const gross = num(bet.potential_paise);
        fee = winningsFeePaise(gross, stake, feeBp);
        paid = gross - fee; status = 'WON'; won += paid; fees += fee;
        const moved = await applyMovementWithin(ctx, {
          legs: [{ field: 'winningsBalance', deltaPaise: paid }],
          ledger: [{ txId: `cricket_win_${bet.bet_id}`, field: 'winningsBalance', amountPaise: paid, type: 'CREDIT',
            reason: `Cricket win: ${locked.labels[winningOption]}`, refId: bet.bet_id }],
          counterparty: { house: true, operation: 'CRICKET_WIN', reason: 'Cricket win', refModel: 'CricketBet', refId: bet.bet_id },
        });
        if (!moved.ok || moved.idempotent) return refuse(moved.refused ?? 'PAYOUT_REFUSED');
      } else {
        status = 'LOST';
      }
      await client.query(
        `UPDATE cricket_bets SET status = $2, paid_paise = $3, fee_paise = $4, ended_at = now() WHERE bet_id = $1`,
        [bet.bet_id, status, paid, fee]);
      payouts.push({ userId: bet.user_id, betId: bet.bet_id, status, paidPaise: paid, stakePaise: stake });
    }

    await client.query(
      `UPDATE cricket_poll_options SET pool_paise = 0, liability_paise = 0 WHERE poll_id = $1`, [String(pollId)]);
    const { rows: [ended] } = await client.query(
      `UPDATE cricket_polls SET status = $2, winning_option = $3, void_reason = $4, settled_at = now(),
              closed_at = COALESCE(closed_at, now()),
              won_paid_paise = won_paid_paise + $5, fees_paise = fees_paise + $6,
              refunded_paise = refunded_paise + $7, stakes_paise = stakes_paise - $7
        WHERE poll_id = $1 RETURNING *`,
      [String(pollId), voidReason !== null ? 'VOID' : 'SETTLED', winningOption, voidReason, won, fees, refunded]);

    // RTP (rtp.js): real stakes kept against what went back to players.
    if (num(ended.stakes_paise) > 0) {
      await recordGameEventWithin(client, {
        gameKey: CRICKET_GAME_KEY, audience: AUDIENCE, refId: `CRK:${pollId}`,
        poolPaise: num(ended.stakes_paise), paidBackPaise: num(ended.won_paid_paise) + num(ended.claims_paid_paise),
      });
    }
    return { commit: true, value: { ok: true, status: ended.status, winningOption, payouts, matchId: ended.match_id } };
  });
}

// ── A player's own ───────────────────────────────────────────────────────────

/** A player's bets, newest first; on one match, or all. */
export async function playerBets(userId, { matchId = null, limit = 200 } = {}) {
  const params = [String(userId), Math.min(Math.max(Number(limit) || 200, 1), 1000)];
  let where = 'b.user_id = $1';
  if (matchId) { params.push(String(matchId)); where += ` AND b.match_id = $${params.length}`; }
  const { rows } = await pgQuery(
    `SELECT b.*, o.label AS option_label, p.title AS poll_title, p.kind, p.status AS poll_status,
            m.team_a_name, m.team_b_name
       FROM cricket_bets b
       JOIN cricket_poll_options o ON o.poll_id = b.poll_id AND o.option_key = b.option_key
       JOIN cricket_polls p ON p.poll_id = b.poll_id
       JOIN cricket_matches m ON m.match_id = b.match_id
      WHERE ${where} ORDER BY b.placed_at DESC LIMIT $2`,
    params, 'cricket_player_bets');
  return rows.map((r) => ({
    ...toBet(r), optionLabel: r.option_label, pollTitle: r.poll_title, pollKind: r.kind, pollStatus: r.poll_status,
    matchName: `${r.team_a_name} v ${r.team_b_name}`,
  }));
}

// ── Reports ──────────────────────────────────────────────────────────────────

/**
 * The house's result per settled poll in a window (stakes kept − wins −
 * claims, fees inside it), for the admin's report and its CSV.
 */
export async function pollReport({ from, to, limit = 5000 }) {
  const { rows } = await pgQuery(
    `SELECT p.poll_id, p.match_id, p.kind, p.title, p.status, p.winning_option, p.settled_at,
            p.stakes_paise, p.claims_paid_paise, p.won_paid_paise, p.fees_paise, p.refunded_paise,
            m.team_a_name, m.team_b_name,
            (SELECT o.label FROM cricket_poll_options o WHERE o.poll_id = p.poll_id AND o.option_key = p.winning_option) AS winner_label,
            (SELECT COUNT(*) FROM cricket_bets b WHERE b.poll_id = p.poll_id) AS bets
       FROM cricket_polls p JOIN cricket_matches m ON m.match_id = p.match_id
      WHERE p.status IN ('SETTLED', 'VOID') AND p.settled_at >= $1 AND p.settled_at < $2
      ORDER BY p.settled_at DESC LIMIT $3`,
    [from, to, Math.min(Math.max(Number(limit) || 5000, 1), 50000)], 'cricket_poll_report');
  return rows.map((r) => ({
    pollId: r.poll_id, matchId: r.match_id, match: `${r.team_a_name} v ${r.team_b_name}`,
    kind: r.kind, title: r.title, status: r.status, winningOption: r.winning_option, winnerLabel: r.winner_label ?? r.winning_option, settledAt: r.settled_at,
    bets: num(r.bets), stakesPaise: num(r.stakes_paise), claimsPaidPaise: num(r.claims_paid_paise),
    wonPaidPaise: num(r.won_paid_paise), feesPaise: num(r.fees_paise), refundedPaise: num(r.refunded_paise),
    houseNetPaise: num(r.stakes_paise) - num(r.claims_paid_paise) - num(r.won_paid_paise),
  }));
}
