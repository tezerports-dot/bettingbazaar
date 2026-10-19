// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The cricket engine against a real PostgreSQL: one match read from the feed
 * again and again (`applyLiveState`, no network), the polls it opens, closes
 * and settles, and that a repeated reading changes nothing
 * (docs/reference/CRICKET_OPINION_DESIGN.md §3).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import * as cricket from '../repositories/cricket.js';
import { applyLiveState, openPublishedPolls } from '../../backend/domains/cricket/cricketEngine.service.js';
import { pollIdFor } from '../../backend/domains/cricket/cricketPolls.js';
import { fundWallet } from './_funding.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);
const CFG = { winningsFeePercent: 1, cricket: { enabled: true } };

const lineup = [
  { id: '11', name: 'Asha', team: 'A' }, { id: '12', name: 'Arun', team: 'A' },
  { id: '21', name: 'Bela', team: 'B' }, { id: '22', name: 'Bharat', team: 'B' },
];
let key = 0;
/** A delivery as the feed adapter returns it. */
const ball = (innings, overNo, outcome, runs, at = new Date()) => ({
  key: `${RUN}-${++key}`, innings, overNo, ballLabel: `${overNo}.x`, outcome, runs, at: at.toISOString(),
});
const statusOf = async (pollId) => (await pgQuery('SELECT status, winning_options FROM cricket_polls WHERE poll_id = $1', [pollId])).rows[0] ?? null;
const squads = [...lineup, { id: '13', name: 'Ajay', team: 'A' }, { id: '23', name: 'Bina', team: 'B' }];

describePg('the cricket engine', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('runs a match: toss, overs and next balls open and settle in turn, and the result ends the rest', async () => {
    const feedId = `${RUN}1`;
    await cricket.upsertFixtures([{
      feedId, seriesId: null, seriesName: 'S', format: 'T20', teamA: { id: '1', name: 'Alpha' }, teamB: { id: '2', name: 'Bravo' },
      venue: null, startsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    }]);
    const id = cricket.matchIdFor(feedId);
    await cricket.publishMatch(id, 'admin');
    await openPublishedPolls({ cfg: CFG, matchId: id });
    const P = (kind, pos = {}) => pollIdFor(id, kind, pos);
    expect((await statusOf(P('TOSS'))).status).toBe('OPEN');
    expect((await statusOf(P('MATCH_RESULT'))).status).toBe('OPEN');

    // A player backs Even on the first over before the toss is known… (it opens at the toss)
    const base = { status: 'LIVE', result: null, lineup, score: { innings: [] } };
    await applyLiveState(await cricket.getMatch(id), { ...base, squads, toss: { winner: 'B', elected: 'BOWL' }, deliveries: [] }, { cfg: CFG });
    expect(await statusOf(P('TOSS'))).toEqual({ status: 'SETTLED', winning_options: ['B_BOWL'] });
    expect(await statusOf(P('MOM'))).toBeNull();
    expect((await statusOf(P('TOP_BATSMAN'))).status).toBe('OPEN');
    expect((await statusOf(P('TOP_BOWLER'))).status).toBe('OPEN');
    expect((await statusOf(P('MOST_SIXES'))).status).toBe('OPEN');
    expect((await statusOf(P('POWERPLAY', { innings: 1 }))).status).toBe('OPEN');
    expect((await statusOf(P('OVER', { innings: 1, overNo: 0 }))).status).toBe('OPEN');
    // Every player of both squads, the XIs first, then "Any other player".
    const { rows: batOpts } = await pgQuery('SELECT option_key FROM cricket_poll_options WHERE poll_id = $1 ORDER BY sort', [P('TOP_BATSMAN')]);
    expect(batOpts.map((o) => o.option_key)).toEqual(['P11', 'P12', 'P21', 'P22', 'P13', 'P23', 'OTHER']);

    const u = `pg-crk-eng-${RUN}`;
    await fundWallet(u, 100_000, `crk-eng-${u}`);
    const placed = await cricket.placeBet({
      betId: `eng-${RUN}`, userId: u, pollId: P('OVER', { innings: 1, overNo: 0 }), optionKey: 'EVEN',
      stakePaise: 10_000, minOddsX100: 101, requestedAt: new Date().toISOString(), reserveBp: 0,
    });
    expect(placed.ok).toBe(true);
    // A bet on a bowler who will finish level with another (a dead heat).
    const bowler = await cricket.placeBet({
      betId: `eng-bw-${RUN}`, userId: u, pollId: P('TOP_BOWLER'), optionKey: 'P12',
      stakePaise: 10_000, minOddsX100: 101, requestedAt: new Date().toISOString(), reserveBp: 0,
    });
    expect(bowler.ok, JSON.stringify(bowler)).toBe(true);

    const over1 = [ball(1, 0, 'R1', 1), ball(1, 0, 'DOT', 0), ball(1, 0, 'R1', 1)];
    const t = { ...base, toss: { winner: 'B', elected: 'BOWL' } };
    await applyLiveState(await cricket.getMatch(id), { ...t, deliveries: over1 }, { cfg: CFG });
    // The first over stops taking bets at its first ball; the next over opens; ball 4 is next.
    expect((await statusOf(P('OVER', { innings: 1, overNo: 0 }))).status).toBe('CLOSED');
    expect((await statusOf(P('POWERPLAY', { innings: 1 }))).status).toBe('CLOSED');
    expect((await statusOf(P('OVER', { innings: 1, overNo: 1 }))).status).toBe('OPEN');
    expect((await statusOf(P('BALL', { seq: 4 }))).status).toBe('OPEN');
    const { rows: [b4] } = await pgQuery('SELECT title FROM cricket_polls WHERE poll_id = $1', [P('BALL', { seq: 4 })]);
    expect(b4.title).toBe('Innings 1, over 1, ball 4');

    // Read again: nothing changes.
    await applyLiveState(await cricket.getMatch(id), { ...t, deliveries: over1 }, { cfg: CFG });
    expect((await statusOf(P('BALL', { seq: 5 })))).toBeNull();

    // The second over starts: the first is settled on 2 runs → Even.
    const over2 = [...over1, ball(1, 1, 'R4', 4)];
    await applyLiveState(await cricket.getMatch(id), { ...t, deliveries: over2 }, { cfg: CFG });
    expect(await statusOf(P('OVER', { innings: 1, overNo: 0 }))).toEqual({ status: 'SETTLED', winning_options: ['EVEN'] });
    expect(await statusOf(P('BALL', { seq: 4 }))).toEqual({ status: 'SETTLED', winning_options: ['R4'] });
    const { rows: [b] } = await pgQuery('SELECT status FROM cricket_bets WHERE bet_id = $1', [`eng-${RUN}`]);
    expect(b.status).toBe('WON');

    // The result: match result settled, open next ball voided, overs and the
    // powerplay settled; a tie settles the result poll on Draw.
    await applyLiveState(await cricket.getMatch(id), {
      ...t, status: 'FINISHED', result: 'TIE', deliveries: over2,
      batting: [{ playerId: '11', runs: 30, balls: 20 }, { playerId: '21', runs: 30, balls: 18 }],
      bowling: [{ playerId: '12', wickets: 2, runs: 20 }, { playerId: '22', wickets: 2, runs: 20 }],
      sixes: { A: 3, B: 3 },
    }, { cfg: CFG });
    expect(await statusOf(P('MATCH_RESULT'))).toEqual({ status: 'SETTLED', winning_options: ['DRAW'] });
    expect((await statusOf(P('BALL', { seq: 5 }))).status).toBe('VOID');
    expect((await statusOf(P('OVER', { innings: 1, overNo: 1 }))).status).toBe('SETTLED');
    expect(await statusOf(P('POWERPLAY', { innings: 1 }))).toEqual({ status: 'SETTLED', winning_options: ['R0'] });
    expect(await statusOf(P('MOST_SIXES'))).toEqual({ status: 'SETTLED', winning_options: ['LEVEL'] });
    // Best batsman: level on runs, fewer balls wins. Best bowler: level on both, a dead heat.
    expect(await statusOf(P('TOP_BATSMAN'))).toEqual({ status: 'SETTLED', winning_options: ['P21'] });
    expect(await statusOf(P('TOP_BOWLER'))).toEqual({ status: 'SETTLED', winning_options: ['P12', 'P22'] });
    // The dead-heat bet is paid its odds on half its stake, less the fee on any profit.
    const { rows: [bw] } = await pgQuery('SELECT status, potential_paise, paid_paise, fee_paise, dead_heat FROM cricket_bets WHERE bet_id = $1', [`eng-bw-${RUN}`]);
    expect(bw).toMatchObject({ status: 'WON', dead_heat: 2 });
    expect(Number(bw.paid_paise) + Number(bw.fee_paise)).toBe(Math.floor(Number(bw.potential_paise) / 2));
    const { rows: open } = await pgQuery(`SELECT poll_id FROM cricket_polls WHERE match_id = $1 AND status IN ('OPEN', 'CLOSED')`, [id]);
    expect(open).toEqual([]);
  });

  it('opens only the poll kinds switched on', async () => {
    const feedId = `${RUN}2`;
    await cricket.upsertFixtures([{
      feedId, seriesId: null, seriesName: 'S', format: 'TEST', teamA: { id: '1', name: 'Alpha' }, teamB: { id: '2', name: 'Bravo' },
      venue: null, startsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    }]);
    const id = cricket.matchIdFor(feedId);
    await cricket.publishMatch(id, 'admin');
    const cfg = { ...CFG, cricket: { enabled: true, polls: { toss: false, mostSixes: false } } };
    await openPublishedPolls({ cfg, matchId: id });
    const P = (kind, pos = {}) => pollIdFor(id, kind, pos);
    expect(await statusOf(P('TOSS'))).toBeNull();
    expect((await statusOf(P('MATCH_RESULT'))).status).toBe('OPEN');
    await applyLiveState(await cricket.getMatch(id), {
      status: 'LIVE', result: null, lineup, squads, score: { innings: [] }, toss: { winner: 'A', elected: 'BAT' }, deliveries: [],
    }, { cfg });
    expect(await statusOf(P('MOST_SIXES'))).toBeNull();
    // A Test has no powerplay.
    expect(await statusOf(P('POWERPLAY', { innings: 1 }))).toBeNull();
    expect((await statusOf(P('TOP_BATSMAN'))).status).toBe('OPEN');
  });
});
