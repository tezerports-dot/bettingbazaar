// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The cricket game's pure parts (owner, 2026-10-18): the pricing arithmetic,
 * the poll vocabulary and the feed adapter's parsing. The money paths are
 * proven against PostgreSQL in database/tests/cricketPg.test.js.
 */
import { describe, it, expect } from 'vitest';
import {
  displayOddsX100, quoteBet, quoteClaim, winningsFeePaise, MIN_ODDS_X100,
} from '../../domains/cricket/cricketPricing.js';
import {
  deliveryOutcome, overOutcome, optionsFor, tossOutcome, pollIdFor, POLL_KINDS,
  titleFor, nextBallAfter, topBatsmen, topBowlers, formatOf, playersOf, playerOptionsFor, powerplayOutcome, mostSixesOutcome,
  matchResultOutcome,
} from '../../domains/cricket/cricketPolls.js';
import { parseBall, parseLiveState, statusOf } from '../../domains/cricket/feeds/sportmonks.js';

const book = (o) => ({ seedPaise: 0, optionCount: 3, stakesPaise: 0, claimsPaidPaise: 0, ...o });

describe('cricket odds', () => {
  it("are the owner's example: 1,000 / 2,000 / 200 with a 10 % spread read 2.88 / 1.44 / 14.40", () => {
    const odds = displayOddsX100({ spreadBp: 1000, seedPaise: 0, pools: { A: 100_000, B: 200_000, TIE: 20_000 } });
    expect(odds).toEqual({ A: 288, B: 144, TIE: 1440 });
  });

  it('open an empty poll at (1 − spread) × options, whatever the seed', () => {
    for (const n of [2, 3, 4, 10]) {
      const pools = Object.fromEntries(Array.from({ length: n }, (_, i) => [`O${i}`, 0]));
      for (const seedPaise of [100, 50_000]) {
        expect(Object.values(displayOddsX100({ spreadBp: 1000, seedPaise, pools }))).toEqual(Array(n).fill(90 * n));
      }
    }
  });

  it('never show below 1.01', () => {
    expect(displayOddsX100({ spreadBp: 1000, seedPaise: 1, pools: { A: 1_000_000, B: 0 } }).A).toBe(MIN_ODDS_X100);
  });

  it('price a bet with its own stake in the pool', () => {
    const q = quoteBet({
      spreadBp: 1000, book: book({ seedPaise: 50_000 }), pools: { A: 0, B: 0, TIE: 0 },
      liabilities: { A: 0, B: 0, TIE: 0 }, optionKey: 'A', stakePaise: 10_000,
    });
    expect(q).toMatchObject({ ok: true, oddsX100: 240, potentialPaise: 24_000, capped: false });
  });

  it('cut a bet to the book bound so a drip-feed cannot cost the house more than its seed', () => {
    // 10,000 on B; small bets on A at A's high price, priced one after another.
    const seed = 1_000;
    const pools = { A: 0, B: 1_000_000, TIE: 0 };
    const liabilities = { A: 0, B: 1_000_000 * 0.95, TIE: 0 };
    const b = book({ seedPaise: seed, stakesPaise: 1_000_000 });
    let paidIfA = 0;
    for (let i = 0; i < 400; i += 1) {
      const q = quoteBet({ spreadBp: 1000, book: b, pools, liabilities, optionKey: 'A', stakePaise: 10_000 });
      if (!q.ok) break;
      pools.A += 10_000; liabilities.A += q.potentialPaise; b.stakesPaise += 10_000; paidIfA = liabilities.A;
      expect(b.stakesPaise - liabilities.A).toBeGreaterThanOrEqual(-seed * 3);
    }
    expect(paidIfA - b.stakesPaise).toBeLessThanOrEqual(seed * 3);
  });

  it('refuse an unknown option and a stake that is not a whole positive paisa count', () => {
    const base = { spreadBp: 1000, book: book({ seedPaise: 100 }), pools: { A: 0, B: 0 }, liabilities: { A: 0, B: 0 } };
    expect(quoteBet({ ...base, optionKey: 'X', stakePaise: 100 }).reason).toBe('UNKNOWN_OPTION');
    expect(quoteBet({ ...base, optionKey: 'A', stakePaise: 0 }).reason).toBe('BAD_STAKE');
    expect(quoteBet({ ...base, optionKey: 'A', stakePaise: 1.5 }).reason).toBe('BAD_STAKE');
  });
});

describe('the winnings fee', () => {
  it('is the percent of the whole payout, stake and profit together, rounded down', () => {
    expect(winningsFeePaise(20_000, 100)).toBe(200);
    expect(winningsFeePaise(10_050, 100)).toBe(100);
    expect(winningsFeePaise(99, 100)).toBe(0);
    expect(winningsFeePaise(0, 100)).toBe(0);
  });
});

describe('a claim', () => {
  const pools = { A: 300_000, B: 100_000 };
  const bet = { optionKey: 'A', stakePaise: 100_000, potentialPaise: 180_000 };
  it("is the payout times the option's share without this stake, less the fee on the whole of it", () => {
    const liabilities = { A: 180_000 + 200_000, B: 150_000 };
    const q = quoteClaim({ book: book({ seedPaise: 0, optionCount: 2, stakesPaise: 400_000 }), pools, liabilities, bet, feeBp: 100 });
    // share = 200,000 / 300,000; fair = 120,000 (no claim margin); fee 1 % of 120,000 = 1,200.
    expect(q).toEqual({ grossPaise: 120_000, feePaise: 1_200, netPaise: 118_800 });
  });

  it('takes the fee on a claim below the stake too', () => {
    const q = quoteClaim({ book: book({ seedPaise: 0, optionCount: 2, stakesPaise: 400_000 }), pools: { A: 150_000, B: 250_000 },
      liabilities: { A: 180_000, B: 150_000 }, bet, feeBp: 100 });
    // share = 50,000 / 300,000; fair = 30,000 (below the 100,000 stake); fee 300.
    expect(q).toEqual({ grossPaise: 30_000, feePaise: 300, netPaise: 29_700 });
  });

  it('is held to what the book can pay without breaking its bound', () => {
    const liabilities = { A: 180_000 + 200_000, B: 400_000 };
    const q = quoteClaim({ book: book({ seedPaise: 0, optionCount: 2, stakesPaise: 400_000 }), pools, liabilities, bet, feeBp: 100 });
    expect(q.netPaise).toBe(0);
  });

  it('never pays more than the potential payout', () => {
    const q = quoteClaim({
      book: book({ seedPaise: 0, optionCount: 2, stakesPaise: 10_100_000 }), pools: { A: 10_000_000, B: 100_000 },
      liabilities: { A: 100_000, B: 0 }, bet: { optionKey: 'A', stakePaise: 50_000, potentialPaise: 100_000 }, feeBp: 0,
    });
    expect(q.grossPaise).toBeLessThanOrEqual(100_000);
  });
});

describe('cricket polls', () => {
  it('judge a delivery: wicket, then no ball, then wide, then runs off it', () => {
    expect(deliveryOutcome({ wicket: true, noBall: true })).toBe('WICKET');
    expect(deliveryOutcome({ noBall: true, runs: 4 })).toBe('NO_BALL');
    expect(deliveryOutcome({ wide: true })).toBe('WIDE');
    expect(deliveryOutcome({ runs: 0 })).toBe('DOT');
    expect(deliveryOutcome({ runs: 5 })).toBe('R5');
    expect(deliveryOutcome({ runs: 6 })).toBe('R6_PLUS');
    expect(deliveryOutcome({ runs: 7 })).toBe('R6_PLUS');
  });

  it('offer the next ball as 0 to 5 runs, 6+, wide, no ball and wicket, in that order', () => {
    expect(optionsFor(POLL_KINDS.BALL, {}).map((o) => o.label)).toEqual(
      ['0 (dot ball)', '1 run', '2 runs', '3 runs', '4 runs', '5 runs', '6+ runs', 'Wide', 'No ball', 'Wicket']);
  });

  it('name the next ball by innings, over and ball: a wide is bowled again, the seventh legal ball starts the next over', () => {
    expect(nextBallAfter({ innings: 1, overNo: 2 }, 3)).toEqual({ innings: 1, overNo: 2, ball: 4 });
    expect(nextBallAfter({ innings: 2, overNo: 4 }, 6)).toEqual({ innings: 2, overNo: 5, ball: 1 });
    expect(titleFor(POLL_KINDS.BALL, { innings: 1, overNo: 2, ball: 4 })).toBe('Innings 1, over 3, ball 4');
  });

  it('pick the best batsman by runs, then fewer balls; level on both is a dead heat', () => {
    expect(topBatsmen([{ playerId: '1', runs: 50, balls: 40 }, { playerId: '2', runs: 50, balls: 35 }, { playerId: '3', runs: 12, balls: 5 }])).toEqual(['2']);
    expect(topBatsmen([{ playerId: '1', runs: 50, balls: 40 }, { playerId: '2', runs: 50, balls: 40 }, { playerId: '3', runs: 9, balls: 4 }])).toEqual(['1', '2']);
    expect(topBatsmen([{ playerId: '1', runs: 0, balls: 3 }])).toEqual([]);
    expect(topBatsmen([])).toEqual([]);
  });

  it('pick the best bowler by wickets, then fewer runs; level on both is a dead heat; no wicket is no winner', () => {
    expect(topBowlers([{ playerId: '1', wickets: 3, runs: 30 }, { playerId: '2', wickets: 3, runs: 22 }, { playerId: '3', wickets: 1, runs: 5 }])).toEqual(['2']);
    expect(topBowlers([{ playerId: '1', wickets: 2, runs: 20 }, { playerId: '2', wickets: 2, runs: 20 }])).toEqual(['1', '2']);
    expect(topBowlers([{ playerId: '1', wickets: 0, runs: 10 }])).toEqual([]);
  });

  it('list both full squads, XIs first, and "Any other player" in every player poll', () => {
    const lineup = Array.from({ length: 22 }, (_, i) => ({ id: String(i), name: `P${i}`, team: i < 11 ? 'A' : 'B' }));
    const squads = [...lineup, { id: '50', name: 'Bench A', team: 'A' }, { id: '51', name: 'Bench B', team: 'B' }];
    const m = { teamA: { name: 'Alpha' }, teamB: { name: 'Bravo' }, lineup, squads };
    for (const kind of [POLL_KINDS.TOP_BATSMAN, POLL_KINDS.TOP_BOWLER]) {
      const opts = optionsFor(kind, m);
      expect(opts).toHaveLength(25);
      expect(opts.slice(-3).map((o) => o.label)).toEqual(['Bench A (Alpha, squad)', 'Bench B (Bravo, squad)', 'Any other player']);
      expect(opts[0].label).toBe('P0 (Alpha)');
    }
    expect(playersOf(m).filter((p) => p.playing)).toHaveLength(22);
  });

  it('name a winner on neither squad "Any other player", never a void', () => {
    const options = [{ key: 'P1' }, { key: 'P2' }, { key: 'OTHER' }];
    expect(playerOptionsFor(options, ['2'])).toEqual(['P2']);
    expect(playerOptionsFor(options, ['99'])).toEqual(['OTHER']);
    expect(playerOptionsFor(options, ['1', '2'])).toEqual(['P1', 'P2']);
  });

  it('offer powerplay runs in ranges by format, and no powerplay in a Test', () => {
    const m = { teamA: { name: 'Alpha' }, teamB: { name: 'Bravo' }, format: 'T20' };
    expect(optionsFor(POLL_KINDS.POWERPLAY, m).map((o) => o.label)).toEqual(['Under 40 runs', '40 to 49 runs', '50 to 59 runs', '60 to 69 runs', '70+ runs']);
    expect(optionsFor(POLL_KINDS.POWERPLAY, { ...m, format: 'TEST' })).toEqual([]);
    expect([powerplayOutcome('T20', 0), powerplayOutcome('T20', 39), powerplayOutcome('T20', 40), powerplayOutcome('T20', 88)]).toEqual(['R0', 'R0', 'R40', 'R70']);
    expect(titleFor(POLL_KINDS.POWERPLAY, { innings: 2, format: 'ODI' })).toBe('Innings 2 powerplay: runs in overs 1 to 10');
  });

  it('judge which team hit more sixes, level being its own option', () => {
    expect([mostSixesOutcome({ A: 9, B: 4 }), mostSixesOutcome({ A: 2, B: 7 }), mostSixesOutcome({ A: 5, B: 5 })]).toEqual(['A', 'B', 'LEVEL']);
  });

  it('judge an over: zero is its own option, not even', () => {
    expect([overOutcome(0), overOutcome(1), overOutcome(2), overOutcome(13)]).toEqual(['ZERO', 'ODD', 'EVEN', 'ODD']);
  });

  it('give the toss four options and a Test match a draw', () => {
    const m = { teamA: { name: 'Alpha' }, teamB: { name: 'Bravo' }, format: 'T20', lineup: [] };
    expect(optionsFor(POLL_KINDS.TOSS, m).map((o) => o.key).sort()).toEqual(['A_BAT', 'A_BOWL', 'B_BAT', 'B_BOWL']);
    expect(optionsFor(POLL_KINDS.MATCH_RESULT, m).map((o) => o.key)).toEqual(['A', 'DRAW', 'B']);
    expect(optionsFor(POLL_KINDS.MATCH_RESULT, { ...m, format: 'TEST' }).map((o) => o.key)).toEqual(['A', 'DRAW', 'B']);
    expect(optionsFor(POLL_KINDS.MATCH_RESULT, m)[1].label).toBe('Draw');
    // A tie and a draw are one option.
    expect(['A', 'TIE', 'DRAW', 'B'].map(matchResultOutcome)).toEqual(['A', 'DRAW', 'DRAW', 'B']);
    expect(tossOutcome('B', 'BOWL')).toBe('B_BOWL');
    expect(pollIdFor('CM1', 'OVER', { innings: 1, overNo: 4 })).toBe('CM1:OVER:1:4:0');
  });
});

describe('the cricket feed adapter', () => {
  it('reads the provider status in the game\'s words', () => {
    expect(statusOf('NS')).toBe('SCHEDULED');
    expect(statusOf('1st Innings')).toBe('LIVE');
    expect(statusOf('Innings Break')).toBe('INNINGS_BREAK');
    expect(statusOf('Finished')).toBe('FINISHED');
    expect(statusOf('Aban.')).toBe('ABANDONED');
    expect(formatOf('T20I')).toBe('T20');
  });

  it('reads a ball: runs conceded for the over, outcome from the delivery', () => {
    const four = parseBall({ id: 9, ball: 3.2, scoreboard: 'S1', score: { runs: 4, ball: true, name: '4 Runs' } });
    expect(four).toMatchObject({ innings: 1, overNo: 3, outcome: 'R4', runs: 4 });
    const wide = parseBall({ id: 10, ball: 3.3, scoreboard: 'S2', score: { runs: 0, ball: false, name: 'Wide', noball: 0, bye: 0 } });
    expect(wide).toMatchObject({ innings: 2, outcome: 'WIDE' });
    const nb = parseBall({ id: 11, ball: 3.3, scoreboard: 'S1', score: { runs: 2, noball: 1, noball_runs: 0, ball: false, name: 'No Ball' } });
    expect(nb).toMatchObject({ outcome: 'NO_BALL', runs: 3 });
    const out = parseBall({ id: 12, ball: 3.4, scoreboard: 'S1', score: { runs: 0, is_wicket: true, ball: true } });
    expect(out.outcome).toBe('WICKET');
  });

  it('reads the toss, the winner and the playing XIs by side', () => {
    const s = parseLiveState({
      status: 'Finished', localteam_id: 1, visitorteam_id: 2, toss_won_team_id: 2, elected: 'batting', winner_team_id: 1,
      man_of_match_id: 77,
      lineup: [{ id: 5, fullname: 'P One', lineup: { team_id: 1 } }, { id: 6, fullname: 'Sub', lineup: { team_id: 2, substitution: true } }],
      balls: [], scoreboards: [],
    });
    expect(s).toMatchObject({ status: 'FINISHED', toss: { winner: 'B', elected: 'BAT' }, result: 'A', manOfMatchId: '77' });
    expect(s.lineup).toEqual([{ id: '5', name: 'P One', team: 'A' }]);
    expect(s.bench).toEqual([{ id: '6', name: 'Sub', team: 'B' }]);
  });

  it("adds up each player's runs, balls and wickets across innings", () => {
    const s = parseLiveState({
      status: 'Finished', localteam_id: 1, visitorteam_id: 2,
      batting: [{ player_id: 5, team_id: 1, score: 40, ball: 30, six_x: 2 }, { player_id: 5, team_id: 1, score: 12, ball: 9, six_x: 1 }, { player_id: 6, team_id: 2, score: 7, ball: 4, six_x: 0 }],
      bowling: [{ player_id: 6, wickets: 2, runs: 30 }, { player_id: 6, wickets: 1, runs: 10 }],
    });
    expect(s.batting).toEqual([{ playerId: '5', runs: 52, balls: 39 }, { playerId: '6', runs: 7, balls: 4 }]);
    expect(s.bowling).toEqual([{ playerId: '6', wickets: 3, runs: 40 }]);
    expect(s.sixes).toEqual({ A: 3, B: 0 });
  });
});

describe('the EntitySport adapter', () => {
  it('reads a fixture, its toss, result, award, figures and sixes', async () => {
    const es = await import('../../domains/cricket/feeds/entitysport.js');
    const f = es.parseFixture({ match_id: 59790, competition: { cid: 127181, title: 'The Ashes' }, teama: { team_id: 490, name: 'England', short_name: 'ENG' },
      teamb: { team_id: 5, name: 'Australia' }, format_str: 'Test', timestamp_start: 1690452000, venue: { name: 'The Oval' } });
    expect(f).toMatchObject({ feedId: '59790', seriesId: '127181', seriesName: 'The Ashes', format: 'TEST', teamA: { id: '490', name: 'England', code: 'ENG' }, venue: 'The Oval' });
    const card = es.parseScorecard({
      status: 2, teama: { team_id: 490 }, teamb: { team_id: 5 }, toss: { winner: 5, decision: 2 }, winning_team_id: 490,
      man_of_the_match: { pid: 49029 },
      innings: [
        { number: 1, batting_team_id: 490, scores: '283/10', batsmen: [{ batsman_id: '1', runs: '40', balls_faced: '30', sixes: '2' }], bowlers: [{ bowler_id: '9', wickets: '3', runs_conceded: '40' }] },
        { number: 2, batting_team_id: 5, scores: '200/9', batsmen: [{ batsman_id: '9', runs: '12', balls_faced: '10', sixes: '1' }], bowlers: [{ bowler_id: '1', wickets: '1', runs_conceded: '20' }] },
      ],
    });
    expect(card).toMatchObject({ status: 'FINISHED', toss: { winner: 'B', elected: 'BOWL' }, result: 'A', manOfMatchId: '49029', sixes: { A: 2, B: 1 } });
    expect(card.batting).toEqual([{ playerId: '1', runs: 40, balls: 30 }, { playerId: '9', runs: 12, balls: 10 }]);
    expect(card.bowling).toEqual([{ playerId: '9', wickets: 3, runs: 40 }, { playerId: '1', wickets: 1, runs: 20 }]);
  });

  it('reads deliveries (a wide, a six, a wicket) and skips over ends', async () => {
    const es = await import('../../domains/cricket/feeds/entitysport.js');
    const balls = es.parseCommentary({ inning: { number: 2 }, commentaries: [
      { event_id: '1', event: 'ball', over: '0', ball: '1', run: 1, bat_run: '0', wide_run: '1', wideball: true, noball: false },
      { event_id: '2', event: 'ball', over: '0', ball: '1', run: 6, bat_run: '6', six: true },
      { event_id: '3', event: 'overend', over: '0' },
      { event_id: '4', event: 'wicket', over: '1', ball: '1', run: 0, bat_run: '0' },
    ] });
    expect(balls.map((b) => [b.innings, b.overNo, b.outcome, b.runs])).toEqual([[2, 0, 'WIDE', 1], [2, 0, 'R6_PLUS', 6], [2, 1, 'WICKET', 0]]);
  });

  it('splits the squads into the XIs and the rest', async () => {
    const es = await import('../../domains/cricket/feeds/entitysport.js');
    const { lineup, bench } = es.parseSquads({ teama: { squads: [{ player_id: '1', name: 'A1', playing11: 'true' }, { player_id: '2', name: 'A2', playing11: 'false' }] },
      teamb: { squads: [{ player_id: '3', name: 'B1', playing11: 'true' }] } });
    expect(lineup).toEqual([{ id: '1', name: 'A1', team: 'A' }, { id: '3', name: 'B1', team: 'B' }]);
    expect(bench).toEqual([{ id: '2', name: 'A2', team: 'A' }]);
  });
});

describe('what players are told of cricket', () => {
  it('keeps the tab as coming soon while the game is off, and drops coming soon once it is on', async () => {
    const { cricketPublicSettings } = await import('../../domains/cricket/cricketSettings.js');
    expect(cricketPublicSettings({})).toMatchObject({ enabled: false, comingSoon: true, claimHoldSec: 2 });
    expect(cricketPublicSettings({ cricket: { comingSoon: false } }).comingSoon).toBe(false);
    expect(cricketPublicSettings({ cricket: { enabled: true, comingSoon: true } })).toMatchObject({ enabled: true, comingSoon: false });
  });
});
