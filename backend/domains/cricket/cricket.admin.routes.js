// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricket.admin.routes.js — Admin › Cricket (owner, 2026-10-18), all under
 * `canManageGames`, every change audited. The settings (switch, spread, claim
 * margin, delay, windows, seeds) are `SystemConfig.cricket`, saved through
 * `/api/admin/system/config` like every other setting; this file holds what
 * is not a setting.
 *
 *   GET  /cricket                         the feeds' health, providers, followed series, matches
 *   PUT  /cricket/feed-token              { provider, token } (empty clears), stored encrypted
 *   PUT  /cricket/feed-provider           { provider } the one the fixture list is read from
 *   POST /cricket/sync                    read the fixture list now
 *   POST /cricket/matches/:id/publish     players see it; its toss and result polls open
 *   POST /cricket/matches/:id/unpublish   refused once anyone has bet on it
 *   PUT  /cricket/matches/order           { matchIds: top to bottom }
 *   POST /cricket/series/:id/follow       { seriesName } publish the series, now and later
 *   DELETE /cricket/series/:id/follow
 *   GET  /cricket/matches/:id/polls       every poll with its book
 *   POST /cricket/polls/:pollId/settle    { winningOptions: [key, …] } (several: a dead heat)
 *   POST /cricket/polls/:pollId/void      { reason }
 *   GET  /cricket/report(.xlsx)?from&to    the house's result per ended poll
 */
import { authenticate, express, hasPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { encryptField } from '../identity/fieldCrypto.util.js';
import { respondError, refusal } from '../../shared/httpError.js';
import { sendXlsx, oneTable, columnsOf, istText } from '../reporting/xlsx.util.js';
import { syncFixtures, openPublishedPolls, endPollByAdmin } from './cricketEngine.service.js';
import { FEED_PROVIDERS, feedProviderList } from './cricketFeed.js';
import { cricketOddsPublisher } from './cricketOddsPublisher.js';

const router = express.Router();
const ALLOWED = hasPermission('canManageGames');

const audit = (req, action, targetId, details) => db.audit.recordDetailed({
  performedBy: req.user.userId, action, category: 'GAMES',
  targetType: 'cricket', targetId: String(targetId), targetName: String(targetId), details,
  ip: req.ip, method: req.method, endpoint: req.originalUrl,
});

const REPORT_MAX_DAYS = 92;

/** A report window: `from` and `to` as dates; the last 7 days by default. */
function windowOf(query) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw refusal(400, 'INVALID_WINDOW', 'Send `from` before `to`, as dates.');
  }
  if (to - from > REPORT_MAX_DAYS * 24 * 3600 * 1000) {
    throw refusal(400, 'WINDOW_TOO_LONG', `A report covers at most ${REPORT_MAX_DAYS} days.`);
  }
  return { from, to };
}

router.get('/cricket', authenticate, ALLOWED, async (req, res) => {
  try {
    const [feed, follows, matches] = await Promise.all([
      db.cricket.getFeed(), db.cricket.listFollows(), db.cricket.listMatchesForAdmin({ sinceHours: req.query.sinceHours }),
    ]);
    res.json({ success: true, feed, feedProviders: feedProviderList(), follows, matches });
  } catch (error) {
    return respondError(res, error, 'GET /admin/cricket', { message: 'Could not load cricket.' });
  }
});

router.put('/cricket/feed-token', authenticate, ALLOWED, async (req, res) => {
  try {
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : 'SPORTMONKS';
    if (!FEED_PROVIDERS[provider]) throw refusal(400, 'UNKNOWN_PROVIDER', 'Pick one of the listed data providers.');
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (token && !/^[A-Za-z0-9]{20,200}$/.test(token)) {
      throw refusal(400, 'INVALID_TOKEN', 'Paste the API token exactly as the provider shows it (letters and digits).');
    }
    const feed = await db.cricket.setFeedToken({ provider, tokenEnc: token ? encryptField(token) : null, by: req.user.userId });
    await audit(req, token ? 'CRICKET_FEED_TOKEN_SET' : 'CRICKET_FEED_TOKEN_CLEARED', provider, {});
    res.json({ success: true, feed });
  } catch (error) {
    return respondError(res, error, 'PUT /admin/cricket/feed-token', { message: 'Could not save the token.' });
  }
});

router.put('/cricket/feed-provider', authenticate, ALLOWED, async (req, res) => {
  try {
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : '';
    if (!FEED_PROVIDERS[provider]) throw refusal(400, 'UNKNOWN_PROVIDER', 'Pick one of the listed data providers.');
    await db.cricket.setActiveFeed(provider);
    await audit(req, 'CRICKET_FEED_PROVIDER_SET', provider, {});
    res.json({ success: true, feed: await db.cricket.getFeed() });
  } catch (error) {
    return respondError(res, error, 'PUT /admin/cricket/feed-provider', { message: 'Could not switch the data provider.' });
  }
});

router.post('/cricket/sync', authenticate, ALLOWED, async (req, res) => {
  try {
    if (!(await db.cricket.getFeed()).tokenSet) throw refusal(409, 'CRICKET_FEED_NOT_SET', 'Save the data token first.');
    let result;
    try {
      result = await syncFixtures();
    } catch {
      // syncFixtures recorded the provider's answer on the feed row, which
      // this page shows; the response names no host or body (F-008).
      throw refusal(502, 'FEED_FAILED', 'The cricket feed did not answer. Its last error is shown under the data feed.');
    }
    await openPublishedPolls();
    res.json({ success: true, ...result, feed: await db.cricket.getFeed() });
  } catch (error) {
    return respondError(res, error, 'POST /admin/cricket/sync', { message: 'Could not read the fixtures.' });
  }
});

router.post('/cricket/matches/:matchId/publish', authenticate, ALLOWED, async (req, res) => {
  try {
    const match = await db.cricket.publishMatch(req.params.matchId, req.user.userId);
    if (!match) throw refusal(404, 'MATCH_NOT_FOUND', 'No such match.');
    await openPublishedPolls({ matchId: match.matchId });
    cricketOddsPublisher.markDirty(match.matchId);
    await audit(req, 'CRICKET_MATCH_PUBLISHED', match.matchId, { teams: `${match.teamA.name} v ${match.teamB.name}` });
    res.json({ success: true, match });
  } catch (error) {
    return respondError(res, error, 'POST /admin/cricket/matches/:matchId/publish', { message: 'Could not publish the match.' });
  }
});

router.post('/cricket/matches/:matchId/unpublish', authenticate, ALLOWED, async (req, res) => {
  try {
    const r = await db.cricket.unpublishMatch(req.params.matchId);
    if (!r.ok && r.reason === 'NOT_FOUND') throw refusal(404, 'MATCH_NOT_FOUND', 'No such match.');
    if (!r.ok) throw refusal(409, 'MATCH_HAS_BETS', 'Players have bet on this match, so it stays until its polls end. Void its polls first if it must go.');
    cricketOddsPublisher.markDirty(req.params.matchId);
    await audit(req, 'CRICKET_MATCH_UNPUBLISHED', req.params.matchId, {});
    res.json({ success: true });
  } catch (error) {
    return respondError(res, error, 'POST /admin/cricket/matches/:matchId/unpublish', { message: 'Could not unpublish the match.' });
  }
});

router.put('/cricket/matches/order', authenticate, ALLOWED, async (req, res) => {
  try {
    const r = await db.cricket.setDisplayOrder(req.body?.matchIds);
    if (!r.ok) throw refusal(400, 'UNKNOWN_MATCH', 'Only published matches can be ordered. Reload and try again.');
    await audit(req, 'CRICKET_MATCHES_REORDERED', 'ALL', { matchIds: req.body.matchIds });
    res.json({ success: true });
  } catch (error) {
    return respondError(res, error, 'PUT /admin/cricket/matches/order', { message: 'Could not save the order.' });
  }
});

router.post('/cricket/series/:seriesId/follow', authenticate, ALLOWED, async (req, res) => {
  try {
    const seriesName = typeof req.body?.seriesName === 'string' ? req.body.seriesName.slice(0, 200) : req.params.seriesId;
    const r = await db.cricket.followSeries({ seriesId: req.params.seriesId, seriesName, by: req.user.userId });
    await openPublishedPolls();
    await audit(req, 'CRICKET_SERIES_FOLLOWED', req.params.seriesId, { seriesName, published: r.published });
    res.json({ success: true, ...r });
  } catch (error) {
    return respondError(res, error, 'POST /admin/cricket/series/:seriesId/follow', { message: 'Could not follow the series.' });
  }
});

router.delete('/cricket/series/:seriesId/follow', authenticate, ALLOWED, async (req, res) => {
  try {
    const removed = await db.cricket.unfollowSeries(req.params.seriesId);
    if (removed) await audit(req, 'CRICKET_SERIES_UNFOLLOWED', req.params.seriesId, {});
    res.json({ success: true, removed });
  } catch (error) {
    return respondError(res, error, 'DELETE /admin/cricket/series/:seriesId/follow', { message: 'Could not stop following the series.' });
  }
});

router.get('/cricket/matches/:matchId/polls', authenticate, ALLOWED, async (req, res) => {
  try {
    const match = await db.cricket.getMatch(req.params.matchId);
    if (!match) throw refusal(404, 'MATCH_NOT_FOUND', 'No such match.');
    res.json({ success: true, match, polls: await db.cricket.adminPolls(match.matchId) });
  } catch (error) {
    return respondError(res, error, 'GET /admin/cricket/matches/:matchId/polls', { message: 'Could not load the polls.' });
  }
});

const ENDED_REFUSALS = Object.freeze({
  POLL_NOT_FOUND: [404, 'No such poll.'],
  ENDED: [409, 'This poll has already ended.'],
});

async function endByAdmin(req, res, how, action) {
  const before = await db.cricket.getPoll(req.params.pollId);
  if (!before) throw refusal(404, 'POLL_NOT_FOUND', 'No such poll.');
  if (how.winningOptions && !how.winningOptions.every((k) => before.options.some((o) => o.key === k))) {
    throw refusal(400, 'UNKNOWN_OPTION', 'That option is not in this poll.');
  }
  const r = await endPollByAdmin({ pollId: before.pollId, ...how });
  if (!r.ok) {
    const [status, message] = ENDED_REFUSALS[r.reason] ?? [409, 'The poll could not be ended. Reload and try again.'];
    throw refusal(status, r.reason, message);
  }
  await audit(req, action, before.pollId, { ...how, bets: r.payouts.length });
  res.json({ success: true, status: r.status, winningOptions: r.winningOptions, bets: r.payouts.length });
}

router.post('/cricket/polls/:pollId/settle', authenticate, ALLOWED, async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.winningOptions) ? req.body.winningOptions : [];
    const winningOptions = [...new Set(raw.filter((k) => typeof k === 'string' && k))];
    if (!winningOptions.length || winningOptions.length > 10) {
      throw refusal(400, 'INVALID_OPTION', 'Pick the winning option (several only for a dead heat).');
    }
    await endByAdmin(req, res, { winningOptions }, 'CRICKET_POLL_SETTLED');
  } catch (error) {
    return respondError(res, error, 'POST /admin/cricket/polls/:pollId/settle', { message: 'Could not settle the poll.' });
  }
});

router.post('/cricket/polls/:pollId/void', authenticate, ALLOWED, async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 200) : '';
    if (!reason) throw refusal(400, 'REASON_REQUIRED', 'Say why the poll is voided; players see it.');
    await endByAdmin(req, res, { voidReason: reason }, 'CRICKET_POLL_VOIDED');
  } catch (error) {
    return respondError(res, error, 'POST /admin/cricket/polls/:pollId/void', { message: 'Could not void the poll.' });
  }
});

router.get('/cricket/report', authenticate, ALLOWED, async (req, res) => {
  try {
    const { from, to } = windowOf(req.query);
    const rows = await db.cricket.pollReport({ from, to });
    const totals = rows.reduce((t, r) => ({
      stakesPaise: t.stakesPaise + r.stakesPaise, claimsPaidPaise: t.claimsPaidPaise + r.claimsPaidPaise,
      wonPaidPaise: t.wonPaidPaise + r.wonPaidPaise, feesPaise: t.feesPaise + r.feesPaise,
      houseNetPaise: t.houseNetPaise + r.houseNetPaise,
    }), { stakesPaise: 0, claimsPaidPaise: 0, wonPaidPaise: 0, feesPaise: 0, houseNetPaise: 0 });
    res.json({ success: true, from, to, polls: rows, totals });
  } catch (error) {
    return respondError(res, error, 'GET /admin/cricket/report', { message: 'Could not build the report.' });
  }
});

router.get('/cricket/report.xlsx', authenticate, ALLOWED, async (req, res) => {
  try {
    const { from, to } = windowOf(req.query);
    const rows = await db.cricket.pollReport({ from, to });
    const r2 = (paise) => Math.round(Number(paise) || 0) / 100;
    const table = rows.map((r) => ({
      settled_at: r.settledAt ? new Date(r.settledAt).toISOString() : '',
      match: r.match, poll: r.title, kind: r.kind, status: r.status, winner: r.winnerLabel ?? '',
      bets: r.bets, stakes: r2(r.stakesPaise), claims_paid: r2(r.claimsPaidPaise), wins_paid: r2(r.wonPaidPaise),
      fees: r2(r.feesPaise), refunded: r2(r.refundedPaise), house_net: r2(r.houseNetPaise),
    }));
    const day = (d) => d.toISOString().slice(0, 10);
    const money = ['stakes', 'claims_paid', 'wins_paid', 'fees', 'refunded', 'house_net'];
    sendXlsx(res, `cricket-polls-${day(from)}-${day(to)}.xlsx`, oneTable({
      name: 'Cricket polls', title: 'Cricket polls', subtitle: `${day(from)} to ${day(to)}. Downloaded ${istText(new Date())}`,
      accent: 'green', rows: table,
      columns: table.length ? columnsOf(table, { money }) : [{ key: 'settled_at', label: 'Settled at' }],
      totals: table.length ? Object.fromEntries(['bets', ...money].map((k) => [k, Math.round(table.reduce((sum, r) => sum + r[k], 0) * 100) / 100])) : undefined,
    }));
  } catch (error) {
    return respondError(res, error, 'GET /admin/cricket/report.xlsx', { message: 'Could not build the export.' });
  }
});

export default router;
