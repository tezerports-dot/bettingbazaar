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
  MOM: 'MOM',
});

/** Which seed setting each kind reads (`cricket.seedRupees.<key>`). */
export const SEED_KEY = Object.freeze({
  TOSS: 'toss', MATCH_RESULT: 'matchResult', OVER: 'over', BALL: 'ball', MOM: 'manOfMatch',
});

/** A delivery's outcome, in the priority it is judged: a wicket beats everything. */
export const BALL_OUTCOMES = Object.freeze([
  { key: 'DOT', label: 'Dot ball' },
  { key: 'R1', label: '1 run' },
  { key: 'R2', label: '2 runs' },
  { key: 'R3', label: '3 runs' },
  { key: 'R4', label: '4 runs' },
  { key: 'R6', label: '6 runs' },
  { key: 'R_OTHER', label: '5 or 7+ runs' },
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
  if (r === 6) return 'R6';
  return 'R_OTHER';
}

/** An over's result from the runs conceded in it, extras included. Zero is its own option. */
export function overOutcome(runs) {
  if (runs === 0) return 'ZERO';
  return runs % 2 === 1 ? 'ODD' : 'EVEN';
}

/** Overs per innings by format, for opening the next innings' first over poll; null: no limit. */
export const OVERS_PER_INNINGS = Object.freeze({ T20: 20, T10: 10, ODI: 50, TEST: null, OTHER: null });

const teamName = (m, side) => (side === 'A' ? m.teamA.name : m.teamB.name);

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
        { key: 'TIE', label: 'Tie' },
        ...(match.format === 'TEST' ? [{ key: 'DRAW', label: 'Draw' }] : []),
        { key: 'B', label: `${teamName(match, 'B')} win` },
      ];
    case POLL_KINDS.OVER:
      return [{ key: 'ODD', label: 'Odd' }, { key: 'EVEN', label: 'Even' }, { key: 'ZERO', label: 'Zero (maiden)' }];
    case POLL_KINDS.BALL:
      return BALL_OUTCOMES.map((o) => ({ ...o }));
    case POLL_KINDS.MOM:
      return (match.lineup ?? []).map((p) => ({ key: `P${p.id}`, label: `${p.name} (${teamName(match, p.team)})` }));
    default:
      throw new Error(`unknown poll kind '${kind}'`);
  }
}

/** The poll's title, in players' words. */
export function titleFor(kind, { innings = 0, overNo = 0, seq = 0 } = {}) {
  switch (kind) {
    case POLL_KINDS.TOSS: return 'Toss: who wins, and their choice';
    case POLL_KINDS.MATCH_RESULT: return 'Match result';
    case POLL_KINDS.OVER: return `Innings ${innings}, over ${overNo + 1}: odd, even or zero runs`;
    case POLL_KINDS.BALL: return `Next ball (delivery ${seq})`;
    case POLL_KINDS.MOM: return 'Man of the match';
    default: throw new Error(`unknown poll kind '${kind}'`);
  }
}

/** The poll's id: one per match, kind and position (the table's own UNIQUE). */
export function pollIdFor(matchId, kind, { innings = 0, overNo = 0, seq = 0 } = {}) {
  return `${matchId}:${kind}:${innings}:${overNo}:${seq}`;
}

/** The toss poll's winning option. */
export const tossOutcome = (winner, elected) => `${winner}_${elected}`;
