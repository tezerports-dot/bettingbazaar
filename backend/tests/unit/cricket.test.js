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
  titleFor, nextBallAfter, topBatsman, topBowler,
} from '../../domains/cricket/cricketPolls.js';
import { parseBall, parseLiveState, statusOf, formatOf } from '../../domains/cricket/cricketFeed.js';

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
  it('is charged only on a payout above the stake, and never takes it below the stake', () => {
    expect(winningsFeePaise(20_000, 10_000, 100)).toBe(200);
    expect(winningsFeePaise(10_000, 10_000, 100)).toBe(0);
    expect(winningsFeePaise(9_000, 10_000, 100)).toBe(0);
    expect(winningsFeePaise(10_050, 10_000, 100)).toBe(50);
  });
});

describe('a claim', () => {
  const pools = { A: 300_000, B: 100_000 };
  const bet = { optionKey: 'A', stakePaise: 100_000, potentialPaise: 180_000 };
  it("is the payout times the option's share without this stake, less the margin and the fee", () => {
    const liabilities = { A: 180_000 + 200_000, B: 150_000 };
    const q = quoteClaim({ book: book({ seedPaise: 0, optionCount: 2, stakesPaise: 400_000 }), pools, liabilities, bet, claimMarginBp: 500, feeBp: 100 });
    // share = 200,000 / 300,000; fair = 120,000; less 5 % = 114,000; fee 1 % of 114,000 = 1,140.
    expect(q).toEqual({ grossPaise: 114_000, feePaise: 1_140, netPaise: 112_860 });
  });

  it('is held to what the book can pay without breaking its bound', () => {
    const liabilities = { A: 180_000 + 200_000, B: 400_000 };
    const q = quoteClaim({ book: book({ seedPaise: 0, optionCount: 2, stakesPaise: 400_000 }), pools, liabilities, bet, claimMarginBp: 500, feeBp: 100 });
    expect(q.netPaise).toBe(0);
  });

  it('never pays more than the potential payout', () => {
    const q = quoteClaim({
      book: book({ seedPaise: 0, optionCount: 2, stakesPaise: 10_100_000 }), pools: { A: 10_000_000, B: 100_000 },
      liabilities: { A: 100_000, B: 0 }, bet: { optionKey: 'A', stakePaise: 50_000, potentialPaise: 100_000 }, claimMarginBp: 0, feeBp: 0,
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

  it('pick the best batsman by runs, then fewer balls; level on both is no winner', () => {
    expect(topBatsman([{ playerId: '1', runs: 50, balls: 40 }, { playerId: '2', runs: 50, balls: 35 }, { playerId: '3', runs: 12, balls: 5 }])).toBe('2');
    expect(topBatsman([{ playerId: '1', runs: 50, balls: 40 }, { playerId: '2', runs: 50, balls: 40 }])).toBeNull();
    expect(topBatsman([{ playerId: '1', runs: 0, balls: 3 }])).toBeNull();
    expect(topBatsman([])).toBeNull();
  });

  it('pick the best bowler by wickets, then fewer runs; no wicket, or level on both, is no winner', () => {
    expect(topBowler([{ playerId: '1', wickets: 3, runs: 30 }, { playerId: '2', wickets: 3, runs: 22 }, { playerId: '3', wickets: 1, runs: 5 }])).toBe('2');
    expect(topBowler([{ playerId: '1', wickets: 2, runs: 20 }, { playerId: '2', wickets: 2, runs: 20 }])).toBeNull();
    expect(topBowler([{ playerId: '1', wickets: 0, runs: 10 }])).toBeNull();
  });

  it('offer every player of the playing XIs in the man of the match, best batsman and best bowler polls', () => {
    const m = { teamA: { name: 'Alpha' }, teamB: { name: 'Bravo' }, lineup: Array.from({ length: 22 }, (_, i) => ({ id: String(i), name: `P${i}`, team: i < 11 ? 'A' : 'B' })) };
    for (const kind of [POLL_KINDS.MOM, POLL_KINDS.TOP_BATSMAN, POLL_KINDS.TOP_BOWLER]) expect(optionsFor(kind, m)).toHaveLength(22);
  });

  it('judge an over: zero is its own option, not even', () => {
    expect([overOutcome(0), overOutcome(1), overOutcome(2), overOutcome(13)]).toEqual(['ZERO', 'ODD', 'EVEN', 'ODD']);
  });

  it('give the toss four options and a Test match a draw', () => {
    const m = { teamA: { name: 'Alpha' }, teamB: { name: 'Bravo' }, format: 'T20', lineup: [] };
    expect(optionsFor(POLL_KINDS.TOSS, m).map((o) => o.key).sort()).toEqual(['A_BAT', 'A_BOWL', 'B_BAT', 'B_BOWL']);
    expect(optionsFor(POLL_KINDS.MATCH_RESULT, m).map((o) => o.key)).toEqual(['A', 'TIE', 'B']);
    expect(optionsFor(POLL_KINDS.MATCH_RESULT, { ...m, format: 'TEST' }).map((o) => o.key)).toEqual(['A', 'TIE', 'DRAW', 'B']);
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
  });

  it("adds up each player's runs, balls and wickets across innings", () => {
    const s = parseLiveState({
      status: 'Finished', localteam_id: 1, visitorteam_id: 2,
      batting: [{ player_id: 5, score: 40, ball: 30 }, { player_id: 5, score: 12, ball: 9 }, { player_id: 6, score: 7, ball: 4 }],
      bowling: [{ player_id: 6, wickets: 2, runs: 30 }, { player_id: 6, wickets: 1, runs: 10 }],
    });
    expect(s.batting).toEqual([{ playerId: '5', runs: 52, balls: 39 }, { playerId: '6', runs: 7, balls: 4 }]);
    expect(s.bowling).toEqual([{ playerId: '6', wickets: 3, runs: 40 }]);
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
