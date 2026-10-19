// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * feeds/entitysport.js — the EntitySport Cricket API v2 adapter
 * (https://www.doc.entitysport.com; owner, 2026-10-19), reached only through
 * `cricketFeed.js` (the one door; CLAUDE.md §17.1.4). Turns the provider's
 * answers into the same provider-free shapes the Sportmonks adapter gives the
 * engine. Team A is the provider's `teama`. The token is handed in by the
 * door, decrypted, per call.
 *
 * Built from the field names in EntitySport's documented sample answers; not
 * yet run against a live account, so the first live match should be watched
 * on Admin › Cricket (the feed's last error is shown there).
 *
 *   /matches/?status=1             fixtures (1 upcoming, 3 live, 2 completed, 4 abandoned)
 *   /matches/{id}/scorecard        status, toss, result, man of the match, innings figures
 *   /matches/{id}/squads           both squads, `playing11` marking the XIs
 *   /matches/{id}/innings/{n}/commentary   the deliveries of one innings
 */
import { deliveryOutcome, formatOf } from '../cricketPolls.js';

export const KEY = 'ENTITYSPORT';
export const LABEL = 'EntitySport Cricket';

const BASE = 'https://restapi.entitysport.com/v2';
const TIMEOUT_MS = 10_000;

const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));
const yes = (v) => v === true || v === 'true' || v === 1 || v === '1';
const listOf = (x) => (Array.isArray(x) ? x : []);

const team = (t, side) => ({
  id: String(t?.team_id ?? side),
  name: String(t?.name ?? `Team ${side}`),
  code: t?.short_name ?? null,
  logo: typeof t?.logo_url === 'string' && t.logo_url.startsWith('https://') ? t.logo_url : null,
});

/** A fixture as the match list stores it. */
export function parseFixture(m) {
  const start = m.timestamp_start ? new Date(Number(m.timestamp_start) * 1000) : new Date(`${m.date_start}Z`);
  return {
    feedId: String(m.match_id),
    seriesId: m.competition?.cid !== undefined && m.competition?.cid !== null ? String(m.competition.cid) : null,
    seriesName: m.competition?.title ?? null,
    format: formatOf(m.format_str),
    teamA: team(m.teama, 'A'),
    teamB: team(m.teamb, 'B'),
    venue: m.venue?.name ?? null,
    startsAt: start.toISOString(),
  };
}

/** The provider's status, in the game's words. */
export function statusOf(m) {
  const s = Number(m?.status);
  if (s === 2) return 'FINISHED';
  if (s === 4) return 'ABANDONED';
  if (s === 3) return /innings break/i.test(String(m?.game_state_str ?? m?.status_note ?? '')) ? 'INNINGS_BREAK' : 'LIVE';
  return 'SCHEDULED';
}

const sideOf = (m, teamId) => (String(teamId) === String(m?.teama?.team_id) ? 'A'
  : String(teamId) === String(m?.teamb?.team_id) ? 'B' : null);

/**
 * One delivery from an innings' commentary. `runs` is everything conceded on
 * it (what an over adds up); the outcome is judged from the facts.
 */
export function parseBall(c, innings) {
  const wide = yes(c.wideball);
  const noBall = yes(c.noball);
  const offDelivery = int(c.bat_run) + int(c.bye_run) + int(c.legbye_run);
  return {
    key: String(c.event_id),
    innings,
    overNo: int(c.over),
    ballLabel: `${int(c.over)}.${int(c.ball)}`,
    outcome: deliveryOutcome({ wicket: c.event === 'wicket', noBall, wide, runs: wide ? 0 : offDelivery }),
    runs: int(c.run),
    at: c.timestamp ? new Date(Number(c.timestamp) * 1000).toISOString() : null,
  };
}

/** The deliveries of one innings' commentary, bowled ones only (not over ends). */
export function parseCommentary(data) {
  const n = int(data?.inning?.number) || 1;
  return listOf(data?.commentaries)
    .filter((c) => c.event === 'ball' || c.event === 'wicket')
    .map((c) => parseBall(c, n));
}

/** The XIs and the rest of both squads. */
export function parseSquads(data) {
  const lineup = []; const bench = [];
  for (const [side, t] of [['A', data?.teama], ['B', data?.teamb]]) {
    for (const p of listOf(t?.squads)) {
      if (p?.player_id === undefined || p?.player_id === null) continue;
      const player = { id: String(p.player_id), name: String(p.name ?? p.player_id), team: side };
      (yes(p.playing11) ? lineup : bench).push(player);
    }
  }
  return { lineup, bench };
}

/** The scorecard's facts: status, toss, result, award and each player's figures. */
export function parseScorecard(m) {
  const status = statusOf(m);
  const winner = m?.toss?.winner ? sideOf(m, m.toss.winner) : null;
  const toss = winner && m.toss.decision ? { winner, elected: Number(m.toss.decision) === 1 ? 'BAT' : 'BOWL' } : null;
  let result = null;
  if (status === 'ABANDONED') result = 'NO_RESULT';
  if (status === 'FINISHED') {
    const side = m.winning_team_id ? sideOf(m, m.winning_team_id) : null;
    const note = String(m.result ?? m.status_note ?? '').toLowerCase();
    if (side) result = side;
    else if (/no result|abandon/.test(note)) result = 'NO_RESULT';
    else if (/draw/.test(note)) result = 'DRAW';
    else if (/tie/.test(note)) result = 'TIE';
  }
  const innings = listOf(m?.innings);
  const batting = new Map(); const bowling = new Map();
  const sixes = innings.length ? { A: 0, B: 0 } : null;
  for (const inn of innings) {
    const side = sideOf(m, inn.batting_team_id);
    for (const b of listOf(inn.batsmen)) {
      const id = String(b.batsman_id ?? '');
      if (!id) continue;
      const t = batting.get(id) ?? { playerId: id, runs: 0, balls: 0 };
      t.runs += int(b.runs); t.balls += int(b.balls_faced);
      batting.set(id, t);
      if (side) sixes[side] += int(b.sixes);
    }
    for (const b of listOf(inn.bowlers)) {
      const id = String(b.bowler_id ?? '');
      if (!id) continue;
      const t = bowling.get(id) ?? { playerId: id, wickets: 0, runs: 0 };
      t.wickets += int(b.wickets); t.runs += int(b.runs_conceded);
      bowling.set(id, t);
    }
  }
  return {
    status,
    toss,
    result,
    manOfMatchId: m?.man_of_the_match?.pid ? String(m.man_of_the_match.pid) : null,
    batting: [...batting.values()],
    bowling: [...bowling.values()],
    sixes,
    inningsNumbers: innings.map((i) => int(i.number)).filter(Boolean),
    score: {
      innings: innings.map((i) => {
        const [runs, wickets] = String(i.scores ?? '0/0').split('/');
        return { innings: int(i.number), team: sideOf(m, i.batting_team_id), runs: int(runs), wickets: int(wickets), overs: Number(i.scores_full?.match(/\(([\d.]+)/)?.[1]) || 0 };
      }),
      note: m?.status_note ?? null,
    },
  };
}

async function get(path, query, { token, fetchImpl = fetch }) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set('token', token);
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`The cricket feed answered ${res.status}`);
  const body = await res.json();
  if (body?.status && body.status !== 'ok') throw new Error(`The cricket feed refused: ${String(body.response ?? body.status).slice(0, 120)}`);
  return body?.response;
}

/** Fixtures not yet started (the provider's next pages of them). */
export async function fetchUpcoming({ token, fetchImpl }) {
  const data = await get('/matches/', { status: '1', per_page: '80', paged: '1' }, { token, fetchImpl });
  return listOf(data?.items).map(parseFixture);
}

/** One match's live facts: the scorecard, the XIs, and the last two innings' deliveries. */
export async function fetchLive(match, { token, fetchImpl }) {
  const id = encodeURIComponent(match.feedFixtureId);
  const card = parseScorecard(await get(`/matches/${id}/scorecard`, {}, { token, fetchImpl }) ?? {});
  const { lineup, bench } = parseSquads(await get(`/matches/${id}/squads`, {}, { token, fetchImpl }) ?? {});
  const deliveries = [];
  for (const n of card.inningsNumbers.slice(-2)) {
    deliveries.push(...parseCommentary(await get(`/matches/${id}/innings/${n}/commentary`, {}, { token, fetchImpl })));
  }
  deliveries.sort((a, b) => a.innings - b.innings || a.overNo - b.overNo || Number(a.key) - Number(b.key));
  const { inningsNumbers: _n, ...facts } = card;
  return { ...facts, lineup, bench, deliveries };
}

/** Both teams' whole squads (the XIs are marked in the same list). */
export async function fetchSquads(match, { token, fetchImpl }) {
  const { lineup, bench } = parseSquads(await get(`/matches/${encodeURIComponent(match.feedFixtureId)}/squads`, {}, { token, fetchImpl }) ?? {});
  return [...lineup, ...bench];
}
