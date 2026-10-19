// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricket.routes.js — the player's cricket API (owner, 2026-10-18), mounted at
 * /api/v1/cricket. Reads are public (the odds are no secret); a bet, a claim
 * and a player's own positions need a player session.
 *
 *   GET  /matches                   the published matches, in the admin's order
 *   GET  /matches/:matchId          one match and its polls (pools and odds)
 *   GET  /me/bets?matchId=          the player's bets
 *   POST /quote/bet                 { pollId, optionKey, stake } → odds now (not binding)
 *   POST /bets                      { pollId, optionKey, stake, minOdds } + Idempotency-Key
 *   POST /quote/claim               { matchId } | { betIds } → each position's value now
 *   POST /claims                    { matchId } | { betIds }, { minTotal }
 *
 * A bet and a claim wait the in-play delay (`cricket.inPlayDelaySec`) after the
 * press before they execute; the repository refuses one if a match event
 * reached the server in that wait, or if the figure fell below what the
 * player confirmed, and answers with the new figure.
 */
import express from 'express';
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import { authenticatePlayer } from '../identity/auth.middleware.js';
import { betLimiter } from '../../middleware/security.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyKey.js';
import { respondError, refusal } from '../../shared/httpError.js';
import { reserveBasisPoints } from '../risk/stakeFunding.js';
import { cricketSettingsOf, cricketPublicSettings } from './cricketSettings.js';
import { feeBpOf } from './cricketEngine.service.js';
import { cricketOddsPublisher } from './cricketOddsPublisher.js';
import { emitWalletUpdate } from '../notification/realtimeEmitters.js';

const router = express.Router();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** What a refusal tells the player, and the status it answers with. */
const REFUSALS = Object.freeze({
  POLL_NOT_FOUND: [404, 'This poll no longer exists.'],
  POLL_CLOSED: [409, 'This poll has closed.'],
  EVENT_DURING_DELAY: [409, 'The match moved while your request waited. Check the new figure and confirm again.'],
  UNKNOWN_OPTION: [400, 'That option is not in this poll.'],
  OPTION_SUSPENDED: [409, 'This option is not taking bets right now. Try a smaller stake or another option.'],
  ODDS_CHANGED: [409, 'The odds changed. Check the new odds and confirm again.'],
  QUOTE_CHANGED: [409, 'The figure changed. Check the new figure and confirm again.'],
  CLAIM_TOO_SOON: [409, 'A new bet can be claimed a moment after it is placed. Try again in a second or two.'],
  NOTHING_TO_CLAIM: [409, 'There is nothing to claim: no open position in a poll still taking claims.'],
  insufficient: [400, 'Your balance is too low for this bet.'],
  BET_ID_TAKEN: [409, 'Send a new Idempotency-Key for a new bet.'],
});

function refused(res, r) {
  const [status, message] = REFUSALS[r.reason] ?? [409, 'This could not be done. Please try again.'];
  return res.status(status).json({ success: false, code: r.reason, message, quote: r.quote ?? null });
}

const rupees = (paise) => paise / 100;

async function liveSettings() {
  const cfg = await getSystemConfig();
  const s = cricketSettingsOf(cfg);
  if (!s.enabled) throw refusal(409, 'GAME_SWITCHED_OFF', 'Cricket is switched off.');
  return { cfg, s };
}

/** A whole number of tokens within the game's bounds, in paise. */
function stakeFrom(body, s) {
  const stake = Number(body?.stake);
  if (!Number.isInteger(stake) || stake * 100 < s.minStakePaise || stake * 100 > s.maxStakePaise) {
    throw refusal(400, 'INVALID_STAKE', `A stake is a whole number from ${s.minStakePaise / 100} to ${s.maxStakePaise / 100}.`);
  }
  return stake * 100;
}

const publicMatch = (m) => ({
  matchId: m.matchId, seriesName: m.seriesName, format: m.format, teamA: m.teamA, teamB: m.teamB,
  venue: m.venue, startsAt: m.startsAt, status: m.status, toss: m.toss, result: m.result,
  score: m.score, lineup: m.lineup,
});

router.get('/matches', async (req, res) => {
  try {
    const cfg = await getSystemConfig();
    const settings = cricketPublicSettings(cfg);
    if (!settings.enabled) return res.json({ success: true, settings, matches: [] });
    const matches = await db.cricket.listPlayerMatches();
    const withPolls = await Promise.all(matches.map(async (m) => ({ ...publicMatch(m), polls: await db.cricket.playerPolls(m.matchId) })));
    res.json({ success: true, settings, matches: withPolls });
  } catch (error) {
    return respondError(res, error, 'GET /v1/cricket/matches', { message: 'Could not load the matches.' });
  }
});

router.get('/matches/:matchId', async (req, res) => {
  try {
    const m = await db.cricket.getMatch(req.params.matchId);
    if (!m?.published) throw refusal(404, 'MATCH_NOT_FOUND', 'No such match.');
    res.json({ success: true, match: publicMatch(m), polls: await db.cricket.playerPolls(m.matchId) });
  } catch (error) {
    return respondError(res, error, 'GET /v1/cricket/matches/:matchId', { message: 'Could not load the match.' });
  }
});

router.get('/me/bets', authenticatePlayer, async (req, res) => {
  try {
    const bets = await db.cricket.playerBets(req.user.userId, { matchId: req.query.matchId || null });
    res.json({ success: true, bets });
  } catch (error) {
    return respondError(res, error, 'GET /v1/cricket/me/bets', { message: 'Could not load your bets.' });
  }
});

router.post('/quote/bet', authenticatePlayer, async (req, res) => {
  try {
    const { s } = await liveSettings();
    const q = await db.cricket.quoteBetNow({ pollId: String(req.body?.pollId ?? ''), optionKey: String(req.body?.optionKey ?? ''), stakePaise: stakeFrom(req.body, s) });
    if (!q.ok) return refused(res, q);
    res.json({ success: true, oddsX100: q.oddsX100, potentialPaise: q.potentialPaise, delaySec: s.inPlayDelayMs / 1000 });
  } catch (error) {
    return respondError(res, error, 'POST /v1/cricket/quote/bet', { message: 'Could not price the bet.' });
  }
});

router.post('/bets', authenticatePlayer, betLimiter, async (req, res) => {
  const requestedAt = new Date().toISOString();
  try {
    const key = requireIdempotencyKey(req);
    const { cfg, s } = await liveSettings();
    const stakePaise = stakeFrom(req.body, s);
    const minOdds = Number(req.body?.minOdds);
    if (!Number.isInteger(minOdds) || minOdds < 101) throw refusal(400, 'INVALID_MIN_ODDS', 'Send the odds you confirmed (×100, at least 101).');
    await sleep(s.inPlayDelayMs);
    const r = await db.cricket.placeBet({
      betId: `CB-${req.user.userId}-${key}`, userId: req.user.userId,
      pollId: String(req.body?.pollId ?? ''), optionKey: String(req.body?.optionKey ?? ''),
      stakePaise, minOddsX100: minOdds, requestedAt, reserveBp: reserveBasisPoints(cfg.betReservePercent ?? 1), // schema default: 1
    });
    if (!r.ok) return refused(res, r);
    if (!r.idempotent) {
      cricketOddsPublisher.markDirty(r.bet.matchId);
      emitWalletUpdate(req.user.userId).catch(() => {});
    }
    res.status(r.idempotent ? 200 : 201).json({ success: true, idempotent: !!r.idempotent, bet: r.bet });
  } catch (error) {
    return respondError(res, error, 'POST /v1/cricket/bets', { message: 'Could not place the bet.' });
  }
});

function claimTarget(body) {
  if (Array.isArray(body?.betIds) && body.betIds.length && body.betIds.length <= 200 && body.betIds.every((x) => typeof x === 'string')) {
    return { betIds: body.betIds };
  }
  if (typeof body?.matchId === 'string' && body.matchId) return { matchId: body.matchId };
  throw refusal(400, 'INVALID_CLAIM', 'Name the match, or the bets, to claim.');
}

router.post('/quote/claim', authenticatePlayer, async (req, res) => {
  try {
    const { cfg, s } = await liveSettings();
    const q = await db.cricket.quoteClaims({ userId: req.user.userId, ...claimTarget(req.body), holdSec: s.claimHoldSec, feeBp: feeBpOf(cfg) });
    res.json({ success: true, ...q, delaySec: s.inPlayDelayMs / 1000, totalNet: rupees(q.totalNetPaise) });
  } catch (error) {
    return respondError(res, error, 'POST /v1/cricket/quote/claim', { message: 'Could not price the claim.' });
  }
});

router.post('/claims', authenticatePlayer, betLimiter, async (req, res) => {
  const requestedAt = new Date().toISOString();
  try {
    const { cfg, s } = await liveSettings();
    const target = claimTarget(req.body);
    const minTotal = Number(req.body?.minTotalPaise);
    if (!Number.isInteger(minTotal) || minTotal < 0) throw refusal(400, 'INVALID_MIN_TOTAL', 'Send the figure you confirmed, in paise.');
    await sleep(s.inPlayDelayMs);
    const r = await db.cricket.claimPositions({
      userId: req.user.userId, ...target, minTotalNetPaise: minTotal, requestedAt,
      holdSec: s.claimHoldSec, feeBp: feeBpOf(cfg),
    });
    if (!r.ok) return refused(res, r);
    for (const id of new Set(r.claimed.map((l) => l.pollId.split(':')[0]))) cricketOddsPublisher.markDirty(id);
    emitWalletUpdate(req.user.userId).catch(() => {});
    res.json({ success: true, claimed: r.claimed, totalNetPaise: r.totalNetPaise });
  } catch (error) {
    return respondError(res, error, 'POST /v1/cricket/claims', { message: 'Could not claim.' });
  }
});

export default router;
