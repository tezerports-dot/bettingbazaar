// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricketPolls.js — the vocabulary of cricket polls (owner, 2026-10-18;
 * docs/reference/CRICKET_OPINION_DESIGN.md §3): the poll kinds, each kind's
 * options, and how a reported fact (a toss, a result, a delivery, an over)
 * picks the winning option. Pure; the repository writes what this decides.
 */

export const POLL_KINDS = Object.freeze({
  TOSS: 'TOSS',
  MATCH_RESULT: 'MATCH_RESULT',
  OVER: 'OVER',
  BALL: 'BALL',
  TOP_BATSMAN: 'TOP_BATSMAN',
  TOP_BOWLER: 'TOP_BOWLER',
  POWERPLAY: 'POWERPLAY',
  MOST_SIXES: 'MOST_SIXES',
});

/**
 * The polls with one option per player of both squads (the playing XIs first,
 * then the rest of each squad, then "Any other player"), opened with the lineup.
 * Every player who can take part is an option, so the poll always has a winner
 * (owner, 2026-10-19; the man of the match poll was removed the same day).
 */
export const PLAYER_POLL_KINDS = Object.freeze([POLL_KINDS.TOP_BATSMAN, POLL_KINDS.TOP_BOWLER]);

/** The option that wins a player poll when the winner is on neither squad. */
export const OTHER_PLAYER = Object.freeze({ key: 'OTHER', label: 'Any other player' });

/**
 * Each kind's key in the settings: its switch (`cricket.polls.<key>`, whether
 * the engine opens it at all) and its seed (`cricket.seedRupees.<key>`).
 */
export const SEED_KEY = Object.freeze({
  TOSS: 'toss', MATCH_RESULT: 'matchResult', OVER: 'over', BALL: 'ball', TOP_BATSMAN: 'topBatsman', TOP_BOWLER: 'topBowler',
  POWERPLAY: 'powerplay', MOST_SIXES: 'mostSixes',
});

/** A delivery's outcome, in the priority it is judged: a wicket beats everything. */
export const BALL_OUTCOMES = Object.freeze([
  { key: 'DOT', label: '0 (dot ball)' },
  { key: 'R1', label: '1 run' },
  { key: 'R2', label: '2 runs' },
  { key: 'R3', label: '3 runs' },
  { key: 'R4', label: '4 runs' },
  { key: 'R5', label: '5 runs' },
  { key: 'R6_PLUS', label: '6+ runs' },
  { key: 'WIDE', label: 'Wide' },
  { key: 'NO_BALL', label: 'No ball' },
  { key: 'WICKET', label: 'Wicket' },
]);

/**
 * One delivery's outcome from the feed's facts: a wicket (any dismissal, a
 * run out off a no ball included) first, then a no ball, then a wide, then
 * the runs off the delivery (bat, byes and leg byes).
 */
export function deliveryOutcome({ wicket = false, noBall = false, wide = false, runs = 0 }) {
  if (wicket) return 'WICKET';
  if (noBall) return 'NO_BALL';
  if (wide) return 'WIDE';
  const r = Math.max(0, Math.trunc(Number(runs) || 0));
  if (r === 0) return 'DOT';
  if (r === 1) return 'R1';
  if (r === 2) return 'R2';
  if (r === 3) return 'R3';
  if (r === 4) return 'R4';
  if (r === 5) return 'R5';
  return 'R6_PLUS';
}

/** An over's result from the runs conceded in it, extras included. Zero is its own option. */
export function overOutcome(runs) {
  if (runs === 0) return 'ZERO';
  return runs % 2 === 1 ? 'ODD' : 'EVEN';
}

/** A provider's match type, as one of the formats the game knows. */
const FORMATS = Object.freeze({
  T20: 'T20', T20I: 'T20', T10: 'T10', ODI: 'ODI', 'LIST A': 'ODI', TEST: 'TEST', TEST_MATCH: 'TEST', '4DAY': 'TEST',
  'FIRST CLASS': 'TEST', 'T20 (WOMEN)': 'T20', T20IW: 'T20', ODIW: 'ODI',
});
export const formatOf = (type) => FORMATS[String(type ?? '').toUpperCase().replace(/\s+/g, ' ')] ?? 'OTHER';

/** Overs per innings by format, for opening the next innings' first over poll; null: no limit. */
export const OVERS_PER_INNINGS = Object.freeze({ T20: 20, T10: 10, ODI: 50, TEST: null, OTHER: null });

const teamName = (m, side) => (side === 'A' ? m.teamA.name : m.teamB.name);

/**
 * The powerplay of each limited-overs format: its overs and the runs ranges
 * players pick from (each range from its `min` up to the next one's). A
 * format with none (Test, other) has no powerplay poll.
 */
export const POWERPLAYS = Object.freeze({
  T20: { overs: 6, ranges: [0, 40, 50, 60, 70] },
  ODI: { overs: 10, ranges: [0, 40, 50, 60, 70] },
  T10: { overs: 3, ranges: [0, 25, 35, 45] },
});

const rangeKey = (min) => `R${min}`;
function rangeOptions(ranges) {
  return ranges.map((min, i) => {
    const next = ranges[i + 1];
    const label = i === 0 ? `Under ${next} runs` : next === undefined ? `${min}+ runs` : `${min} to ${next - 1} runs`;
    return { key: rangeKey(min), label };
  });
}

/** The powerplay option the runs scored in it fall in. */
export function powerplayOutcome(format, runs) {
  const { ranges } = POWERPLAYS[format];
  let pick = ranges[0];
  for (const min of ranges) if (runs >= min) pick = min;
  return rangeKey(pick);
}

/**
 * Every player who can be named in a player poll: the playing XIs first, then
 * the rest of each squad (a substitute, an impact player), each once.
 */
export function playersOf(match) {
  const seen = new Set();
  const out = [];
  for (const p of [...(match.lineup ?? []), ...(match.squads ?? [])]) {
    if (!p?.id || !p.team || seen.has(String(p.id))) continue;
    seen.add(String(p.id));
    out.push({ id: String(p.id), name: p.name, team: p.team, playing: (match.lineup ?? []).some((l) => String(l.id) === String(p.id)) });
  }
  return out;
}

/** Each kind's options for one match, in the order players see them. */
export function optionsFor(kind, match) {
  switch (kind) {
    case POLL_KINDS.TOSS:
      return ['A', 'B'].flatMap((s) => [
        { key: `${s}_BAT`, label: `${teamName(match, s)} win, bat` },
        { key: `${s}_BOWL`, label: `${teamName(match, s)} win, bowl` },
      ]);
    case POLL_KINDS.MATCH_RESULT:
      return [
        { key: 'A', label: `${teamName(match, 'A')} win` },
        { key: 'DRAW', label: 'Draw' },
        { key: 'B', label: `${teamName(match, 'B')} win` },
      ];
    case POLL_KINDS.OVER:
      return [{ key: 'ODD', label: 'Odd' }, { key: 'EVEN', label: 'Even' }, { key: 'ZERO', label: 'Zero (maiden)' }];
    case POLL_KINDS.BALL:
      return BALL_OUTCOMES.map((o) => ({ ...o }));
    case POLL_KINDS.TOP_BATSMAN:
    case POLL_KINDS.TOP_BOWLER: {
      const players = playersOf(match);
      if (!players.length) return [];
      return [
        ...players.map((p) => ({ key: `P${p.id}`, label: `${p.name} (${teamName(match, p.team)}${p.playing ? '' : ', squad'})` })),
        { ...OTHER_PLAYER },
      ];
    }
    case POLL_KINDS.POWERPLAY:
      return POWERPLAYS[match.format] ? rangeOptions(POWERPLAYS[match.format].ranges) : [];
    case POLL_KINDS.MOST_SIXES:
      return [
        { key: 'A', label: `${teamName(match, 'A')}` },
        { key: 'LEVEL', label: 'Level' },
        { key: 'B', label: `${teamName(match, 'B')}` },
      ];
    default:
      throw new Error(`unknown poll kind '${kind}'`);
  }
}

/** The poll's title, in players' words. */
export function titleFor(kind, { innings = 0, overNo = 0, seq = 0, ball = 0, format = null } = {}) {
  switch (kind) {
    case POLL_KINDS.TOSS: return 'Toss: who wins, and their choice';
    case POLL_KINDS.MATCH_RESULT: return 'Match result';
    case POLL_KINDS.OVER: return `Innings ${innings}, over ${overNo + 1}: odd, even or zero runs`;
    case POLL_KINDS.BALL: return ball ? `Innings ${innings}, over ${overNo + 1}, ball ${ball}` : `Next ball (delivery ${seq})`;
    case POLL_KINDS.TOP_BATSMAN: return 'Best batsman: most runs in the match';
    case POLL_KINDS.TOP_BOWLER: return 'Best bowler: most wickets in the match';
    case POLL_KINDS.POWERPLAY: return `Innings ${innings} powerplay: runs in overs 1 to ${POWERPLAYS[format]?.overs ?? '?'}`;
    case POLL_KINDS.MOST_SIXES: return 'Which team hits more sixes';
    default: throw new Error(`unknown poll kind '${kind}'`);
  }
}

/** The poll's id: one per match, kind and position (the table's own UNIQUE). */
export function pollIdFor(matchId, kind, { innings = 0, overNo = 0, seq = 0 } = {}) {
  return `${matchId}:${kind}:${innings}:${overNo}:${seq}`;
}

/**
 * The match-result poll's winning option from the feed's result: a tie and a
 * draw are one option, "Draw" (owner, 2026-10-19).
 */
export const matchResultOutcome = (result) => (result === 'TIE' ? 'DRAW' : result);

/** The toss poll's winning option. */
export const tossOutcome = (winner, elected) => `${winner}_${elected}`;

/**
 * The best batsman: most runs in the match (every innings added up); level on
 * runs, fewer balls faced. Players still level on both share the win (a dead
 * heat, as bookmakers settle it: each winning bet is paid its odds on its
 * stake divided by the number of winners). Nobody scored: [] (void).
 */
export function topBatsmen(batting = []) {
  const best = [...batting].filter((b) => b.runs > 0)
    .sort((a, b) => b.runs - a.runs || a.balls - b.balls);
  if (!best.length) return [];
  const [first] = best;
  return best.filter((b) => b.runs === first.runs && b.balls === first.balls).map((b) => b.playerId);
}

/**
 * The best bowler: most wickets in the match; level on wickets, fewer runs
 * conceded; still level, a dead heat. No wicket fell to a bowler: [] (void).
 */
export function topBowlers(bowling = []) {
  const best = [...bowling].filter((b) => b.wickets > 0)
    .sort((a, b) => b.wickets - a.wickets || a.runs - b.runs);
  if (!best.length) return [];
  const [first] = best;
  return best.filter((b) => b.wickets === first.wickets && b.runs === first.runs).map((b) => b.playerId);
}

/** Which team hit more sixes, from each team's total; level is its own option. */
export function mostSixesOutcome({ A = 0, B = 0 } = {}) {
  if (A === B) return 'LEVEL';
  return A > B ? 'A' : 'B';
}

/**
 * A player poll's winning options from the players named by the facts: each
 * named player's option, or "Any other player" for one on neither squad.
 */
export function playerOptionsFor(options, playerIds) {
  const keys = new Set(options.map((o) => o.key ?? o));
  return [...new Set(playerIds.map((id) => (keys.has(`P${id}`) ? `P${id}` : OTHER_PLAYER.key)))];
}

/**
 * Where the next ball is bowled, from the last delivery and the legal balls of
 * its over so far: a wide or a no ball is bowled again, so the count stays;
 * after the sixth legal ball the next over starts at ball 1.
 */
export function nextBallAfter({ innings, overNo }, legalBallsInOver) {
  return legalBallsInOver >= 6 ? { innings, overNo: overNo + 1, ball: 1 } : { innings, overNo, ball: legalBallsInOver + 1 };
}
