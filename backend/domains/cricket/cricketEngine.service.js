// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricketEngine.service.js — runs the cricket polls from the feed's facts
 * (owner, 2026-10-18; docs/reference/CRICKET_OPINION_DESIGN.md §3).
 *
 *   syncFixtures()   cron, every 10 minutes: the fixture list
 *   syncLive()       cron, every 4 seconds: each published match under way
 *   applyLiveState() what one fetch of a match means for its polls; no network,
 *                    so the tests drive it directly
 *
 * When each poll takes bets:
 *   TOSS          from publication; closes `tossCloseMinutes` before the start
 *                 or at the toss
 *   MATCH_RESULT  from publication to the result
 *   TOP_BATSMAN,  from the playing XIs to the result; settled at the result
 *   TOP_BOWLER    from the scorecard (most runs; most wickets), a dead heat
 *                 when level
 *   MOST_SIXES    from the playing XIs to the result, from the scorecard
 *   POWERPLAY n   innings 1 from the toss, innings 2 from the innings break,
 *                 to the innings' first ball; settled once its overs are bowled
 *   (TOP_BATSMAN and TOP_BOWLER list both full squads and "Any other
 *   player", so a named winner is always an option.)
 *   Each kind opens only while its switch is on (`cricket.polls`).
 *   OVER n        from the first ball of over n−1 to the first ball of over n
 *   BALL k        from delivery k−1's report for `nextBallWindowSec`, or to
 *                 delivery k; a bet pressed at or after the moment delivery k
 *                 was recorded by the feed is void
 *
 * Every write goes through `db.cricket` (the one writer); the odds players see
 * are pushed by `cricketOddsPublisher`, at most once a second per match.
 */
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import { cricketSettingsOf } from './cricketSettings.js';
import {
  POLL_KINDS, PLAYER_POLL_KINDS, SEED_KEY, OVERS_PER_INNINGS, optionsFor, titleFor, pollIdFor, tossOutcome, overOutcome,
  nextBallAfter, topBatsmen, matchResultOutcome, topBowlers, playerOptionsFor, POWERPLAYS, powerplayOutcome, mostSixesOutcome,
} from './cricketPolls.js';
import { fetchUpcoming, fetchLive, fetchSquads } from './cricketFeed.js';
import { emitToPlayer, emitWalletUpdate } from '../notification/realtimeEmitters.js';
import { cricketOddsPublisher } from './cricketOddsPublisher.js';

/** The fee every game's winners pay (`SystemConfig.winningsFeePercent`, schema default 1). */
export const feeBpOf = (cfg) => Math.round(Number(cfg?.winningsFeePercent ?? 1) * 100); // schema default: 1

/** The spread a poll opening now is frozen at: lowered while the Cricket RTP fund is on and above zero. */
async function spreadForNewPoll(settings) {
  const fund = await db.rtp.getFund(db.cricket.CRICKET_GAME_KEY, 'VIP');
  if (fund?.enabled && fund.balancePaise > 0) return Math.max(0, settings.spreadBp - settings.rtpBoostBp);
  return settings.spreadBp;
}

async function open(match, kind, pos, { settings, spreadBp, closesAt = null, titlePos = pos }) {
  if (settings.pollsOn?.[SEED_KEY[kind]] === false) return null;
  const options = optionsFor(kind, match);
  return db.cricket.openPoll({
    pollId: pollIdFor(match.matchId, kind, pos), matchId: match.matchId, kind,
    innings: pos.innings ?? 0, overNo: pos.overNo ?? 0, seq: pos.seq ?? 0,
    title: titleFor(kind, { ...titlePos, format: match.format }), closesAt, spreadBp,
    seedPaise: settings.seedPaise[SEED_KEY[kind]], options,
  });
}

/** End a poll and tell its players; the payouts reach wallets in the poll's own transaction. */
async function end(pollId, how, feeBp) {
  const r = await db.cricket.endPoll({ pollId, feeBp, ...how });
  if (!r.ok) return r;
  const byUser = new Map();
  for (const p of r.payouts) {
    const u = byUser.get(p.userId) ?? { stakedPaise: 0, paidPaise: 0 };
    u.stakedPaise += p.stakePaise; u.paidPaise += p.paidPaise;
    byUser.set(p.userId, u);
  }
  for (const [userId, u] of byUser) {
    emitToPlayer(userId, 'cricket_settled', { pollId, matchId: r.matchId, status: r.status, winningOptions: r.winningOptions, ...u });
    if (u.paidPaise > 0) emitWalletUpdate(userId).catch(() => {});
  }
  return r;
}

/**
 * An admin's settle or void of one poll (Admin › Cricket), for when the feed
 * is wrong or silent; the same ending, payouts and notices as the engine's.
 */
export async function endPollByAdmin({ pollId, winningOptions = null, voidReason = null }) {
  const cfg = await getSystemConfig();
  const r = await end(pollId, winningOptions?.length ? { winningOptions } : { voidReason: voidReason || 'Voided by the admin' }, feeBpOf(cfg));
  if (r.ok) cricketOddsPublisher.markDirty(r.matchId);
  return r;
}

/** The toss and result polls a published match takes bets on from publication. */
async function openStandingPolls(match, ctx, now) {
  if (match.result || ['FINISHED', 'ABANDONED'].includes(match.status)) return false;
  const tossCloses = new Date(new Date(match.startsAt).getTime() - ctx.settings.tossCloseMs);
  const toss = !match.toss && tossCloses > now ? await open(match, POLL_KINDS.TOSS, {}, { ...ctx, closesAt: tossCloses }) : null;
  const result = await open(match, POLL_KINDS.MATCH_RESULT, {}, ctx);
  return Boolean(toss || result);
}

/** Every published match's standing polls, opened (a publish, and each tick). */
export async function openPublishedPolls({ cfg = null, now = new Date(), matchId = null } = {}) {
  cfg ??= await getSystemConfig();
  const settings = cricketSettingsOf(cfg);
  const ctx = { settings, spreadBp: await spreadForNewPoll(settings) };
  const matches = matchId ? [await db.cricket.getMatch(matchId)].filter(Boolean) : await db.cricket.listPlayerMatches();
  for (const m of matches) {
    if (!m.published) continue;
    if (await openStandingPolls(m, ctx, now)) cricketOddsPublisher.markDirty(m.matchId);
  }
}

const after = (a, b) => a.innings > b.innings || (a.innings === b.innings && a.overNo > b.overNo);

/**
 * What one reading of a match means. Idempotent: polls open once (their
 * position is unique), deliveries are recorded once, and an ended poll answers
 * ENDED, so a repeated or overlapping reading changes nothing.
 */
export async function applyLiveState(match, state, { cfg = null, now = new Date() } = {}) {
  cfg ??= await getSystemConfig();
  const settings = cricketSettingsOf(cfg);
  const feeBp = feeBpOf(cfg);
  const spreadBp = await spreadForNewPoll(settings);
  const ctx = { settings, spreadBp };
  const mid = match.matchId;

  if (!state.toss && !state.result) await openStandingPolls(match, ctx, now);

  const tossNew = state.toss && !match.toss;
  const updated = await db.cricket.applyMatchFacts(mid, {
    status: state.status, toss: state.toss, result: state.result,
    lineup: state.lineup?.length ? state.lineup : null, squads: state.squads?.length ? state.squads : null, score: state.score,
    eventAt: tossNew ? now.toISOString() : null,
  });
  const m = updated ?? match;

  if (state.toss) {
    await end(pollIdFor(mid, POLL_KINDS.TOSS, {}), { winningOption: tossOutcome(state.toss.winner, state.toss.elected) }, feeBp);
    if (m.lineup?.length && !state.result) {
      for (const kind of PLAYER_POLL_KINDS) await open(m, kind, {}, ctx);
      await open(m, POLL_KINDS.MOST_SIXES, {}, ctx);
    }
    if (!state.result && POWERPLAYS[m.format] && !(await db.cricket.lastDelivery(mid))) {
      await open(m, POLL_KINDS.POWERPLAY, { innings: 1 }, ctx);
    }
  }

  const maxOvers = OVERS_PER_INNINGS[m.format] ?? null;
  const lastInnings = m.format === 'TEST' ? 4 : 2;
  const nextOverAfter = (innings, overNo) => (maxOvers !== null && overNo + 1 >= maxOvers
    ? (innings < lastInnings ? { innings: innings + 1, overNo: 0 } : null)
    : { innings, overNo: overNo + 1 });

  // The first over of the match opens with the toss.
  if (state.toss && !state.result && !(await db.cricket.lastDelivery(mid))) {
    await open(m, POLL_KINDS.OVER, { innings: 1, overNo: 0 }, ctx);
  }

  const fresh = await db.cricket.recordDeliveries(mid, state.deliveries ?? []);
  for (const d of fresh) {
    // An innings' powerplay poll stops taking bets at its first ball, and is
    // decided once a ball past it (or a later innings) is bowled.
    await db.cricket.closePoll(pollIdFor(mid, POLL_KINDS.POWERPLAY, { innings: d.innings }));
    await settlePowerplays(m, d, feeBp);
    // The next-ball poll this delivery decides.
    await end(pollIdFor(mid, POLL_KINDS.BALL, { seq: d.seq }), { winningOption: d.outcome, voidPressedFrom: d.at }, feeBp);
    // Its over stops taking bets; every earlier over is complete.
    await db.cricket.closePoll(pollIdFor(mid, POLL_KINDS.OVER, { innings: d.innings, overNo: d.overNo }));
    await settleOversBefore(mid, d, feeBp);
    const next = nextOverAfter(d.innings, d.overNo);
    if (next && !state.result) await open(m, POLL_KINDS.OVER, next, ctx);
  }
  const last = fresh.at(-1);
  if (last && !state.result && state.status !== 'INNINGS_BREAK') {
    const { legal } = await db.cricket.overRuns(mid, last.innings, last.overNo);
    await open(m, POLL_KINDS.BALL, { seq: last.seq + 1 }, {
      ...ctx, closesAt: new Date(now.getTime() + settings.nextBallWindowMs), titlePos: nextBallAfter(last, legal),
    });
  }

  if (state.status === 'INNINGS_BREAK') {
    const ld = await db.cricket.lastDelivery(mid);
    if (ld) {
      await settleOversBefore(mid, { innings: ld.innings + 1, overNo: 0 }, feeBp);
      await voidOpen(mid, POLL_KINDS.BALL, 'The innings ended', feeBp);
      await settlePowerplays(m, { innings: ld.innings + 1, overNo: 0 }, feeBp);
      if (ld.innings < lastInnings) {
        await open(m, POLL_KINDS.OVER, { innings: ld.innings + 1, overNo: 0 }, ctx);
        if (POWERPLAYS[m.format]) await open(m, POLL_KINDS.POWERPLAY, { innings: ld.innings + 1 }, ctx);
      }
    }
  }

  if (state.result === 'NO_RESULT') {
    for (const p of await db.cricket.unendedPolls(mid)) await end(p.pollId, { voidReason: 'No result' }, feeBp);
  } else if (state.result) {
    await end(pollIdFor(mid, POLL_KINDS.MATCH_RESULT, {}), { winningOption: matchResultOutcome(state.result) }, feeBp);
    await settleOversBefore(mid, { innings: 99, overNo: 0 }, feeBp);
    await settlePowerplays(m, { innings: 99, overNo: 0 }, feeBp);
    await voidOpen(mid, POLL_KINDS.BALL, 'The match ended', feeBp);
    await voidOpen(mid, POLL_KINDS.TOSS, 'The toss was not reported', feeBp);
    await voidOpen(mid, POLL_KINDS.POWERPLAY, 'The innings was not played', feeBp);
    await settleFromFigures(mid, POLL_KINDS.TOP_BATSMAN, state.batting, topBatsmen, feeBp);
    await settleFromFigures(mid, POLL_KINDS.TOP_BOWLER, state.bowling, topBowlers, feeBp);
    const sixesPoll = pollIdFor(mid, POLL_KINDS.MOST_SIXES, {});
    if (state.sixes) await end(sixesPoll, { winningOption: mostSixesOutcome(state.sixes) }, feeBp);
    else await end(sixesPoll, { voidReason: 'The scorecard was not reported' }, feeBp);
  }
  cricketOddsPublisher.markDirty(mid);
  return { deliveries: fresh.length };
}

/** A player poll won by the players the facts name; one on neither squad wins "Any other player". */
async function settlePlayerPoll(matchId, kind, playerIds, feeBp) {
  const pollId = pollIdFor(matchId, kind, {});
  const poll = await db.cricket.getPoll(pollId);
  if (!poll || ['SETTLED', 'VOID'].includes(poll.status)) return null;
  return end(pollId, { winningOptions: playerOptionsFor(poll.options, playerIds) }, feeBp);
}

/**
 * Best batsman or bowler, at the result, from the scorecard: the player ahead
 * wins; players level on both figures share it (a dead heat). Void only when
 * there is no scorecard, or nobody scored a run (took a wicket).
 */
async function settleFromFigures(matchId, kind, figures, pickWinners, feeBp) {
  const pollId = pollIdFor(matchId, kind, {});
  if (!figures?.length) return end(pollId, { voidReason: 'The scorecard was not reported' }, feeBp);
  const winners = pickWinners(figures);
  if (!winners.length) {
    return end(pollId, { voidReason: kind === POLL_KINDS.TOP_BOWLER ? 'No wicket fell to a bowler' : 'Nobody scored a run' }, feeBp);
  }
  return settlePlayerPoll(matchId, kind, winners, feeBp);
}

/**
 * Settle each innings' powerplay poll once play is past it: a ball after its
 * last over, or a later innings (`pos`). The runs are every run conceded in
 * those overs, extras included.
 */
async function settlePowerplays(match, pos, feeBp) {
  const pp = POWERPLAYS[match.format];
  if (!pp) return;
  for (const p of await db.cricket.unendedPolls(match.matchId)) {
    if (p.kind !== POLL_KINDS.POWERPLAY) continue;
    const past = pos.innings > p.innings || (pos.innings === p.innings && pos.overNo >= pp.overs);
    if (!past) continue;
    const { runs, deliveries } = await db.cricket.inningsRuns(match.matchId, p.innings, pp.overs);
    await end(p.pollId, deliveries === 0 ? { voidReason: 'The innings was not played' } : { winningOption: powerplayOutcome(match.format, runs) }, feeBp);
  }
}

/** Settle every over poll still running before `pos` from the deliveries bowled in it. */
async function settleOversBefore(matchId, pos, feeBp) {
  for (const p of await db.cricket.unendedPolls(matchId)) {
    if (p.kind !== POLL_KINDS.OVER || !after(pos, p)) continue;
    const { runs, deliveries } = await db.cricket.overRuns(matchId, p.innings, p.overNo);
    await end(p.pollId, deliveries === 0 ? { voidReason: 'The over was not bowled' } : { winningOption: overOutcome(runs) }, feeBp);
  }
}

async function voidOpen(matchId, kind, reason, feeBp) {
  for (const p of await db.cricket.unendedPolls(matchId)) {
    if (p.kind === kind) await end(p.pollId, { voidReason: reason }, feeBp);
  }
}

// Squads are read at most this often per match until the provider lists them.
const SQUADS_RETRY_MS = 10 * 60_000;
const squadsTriedAt = new Map();

/** The active provider's fixture list, every 10 minutes, while its token is saved. */
export async function syncFixtures({ fetchImpl } = {}) {
  const feed = await db.cricket.getFeed();
  if (!feed.tokenSet) return { skipped: 'no token' };
  try {
    const fixtures = await fetchUpcoming({ fetchImpl });
    const r = await db.cricket.upsertFixtures(fixtures);
    await db.cricket.recordFeedResult({ provider: feed.provider, ok: true });
    return { fixtures: fixtures.length, ...r };
  } catch (e) {
    await db.cricket.recordFeedResult({ provider: feed.provider, ok: false, error: e.message });
    throw e;
  }
}

/**
 * Every published match under way, read and applied; then the polls whose time
 * is up are closed.
 */
export async function syncLive({ fetchImpl } = {}) {
  const cfg = await getSystemConfig();
  for (const id of await db.cricket.closeDuePolls()) cricketOddsPublisher.markDirty(id);
  await openPublishedPolls({ cfg });
  if (!(await db.cricket.getFeed()).anyTokenSet) return { skipped: 'no token' };
  const readOk = new Set();
  for (const match of await db.cricket.listMatchesToSync()) {
    try {
      const state = await fetchLive(match, { fetchImpl });
      // Both squads, read once, so the player polls can list every player.
      if (!match.squads?.length && !state.result && (squadsTriedAt.get(match.matchId) ?? 0) + SQUADS_RETRY_MS <= Date.now()) {
        squadsTriedAt.set(match.matchId, Date.now());
        const squads = await fetchSquads(match, { fetchImpl }).catch((e) => {
          console.error(`[cricket] ${match.matchId} squads:`, e.message);
          return [];
        });
        state.squads = squads.length ? squads : state.bench;
      }
      await applyLiveState(match, state, { cfg });
      readOk.add(match.feedProvider);
    } catch (e) {
      await db.cricket.recordFeedResult({ provider: match.feedProvider, ok: false, error: `${match.matchId}: ${e.message}` });
      console.error(`[cricket] ${match.matchId}:`, e.message);
    }
  }
  for (const provider of readOk) await db.cricket.recordFeedResult({ provider, ok: true });
  return { read: readOk.size };
}
