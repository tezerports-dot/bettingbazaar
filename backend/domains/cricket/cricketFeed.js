// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricketFeed.js — the one door to the cricket data provider (owner,
 * 2026-10-18; CLAUDE.md §17.1.4: a volatile third-party surface through one
 * thin adapter). Provider: Sportmonks Cricket API v2
 * (https://docs.sportmonks.com/v2/cricket-api). Only the server calls it;
 * players read our own API and stream.
 *
 * Everything the game needs is turned here into the provider-free shapes the
 * engine reads (`parseFixture`, `parseLiveState`), so a change of provider is
 * a change to this file alone. Team A is the provider's local team.
 *
 * The token is saved on Admin › Cricket, encrypted (`cricket_feed`), and
 * decrypted here, per call; it is never logged or sent to a panel.
 */
import { db } from '#db';
import { decryptField } from '../identity/fieldCrypto.util.js';
import { deliveryOutcome } from './cricketPolls.js';

const BASE = 'https://cricket.sportmonks.com/api/v2.0';
const TIMEOUT_MS = 10_000;

const FORMATS = Object.freeze({
  T20: 'T20', T20I: 'T20', T10: 'T10', ODI: 'ODI', 'LIST A': 'ODI', TEST: 'TEST', TEST_MATCH: 'TEST', '4DAY': 'TEST',
});
export const formatOf = (type) => FORMATS[String(type ?? '').toUpperCase().replace(/\s+/g, ' ')] ?? 'OTHER';

/** The provider's status, in the game's words. */
export function statusOf(status) {
  const s = String(status ?? '').toLowerCase();
  if (s === 'finished') return 'FINISHED';
  if (s.startsWith('aban') || s.startsWith('cancl') || s.startsWith('cancel')) return 'ABANDONED';
  if (s === 'innings break') return 'INNINGS_BREAK';
  if (s === '' || s === 'ns' || s.startsWith('postp') || s === 'delayed') return 'SCHEDULED';
  return 'LIVE';
}

const team = (t, fallbackId) => ({
  id: String(t?.id ?? fallbackId),
  name: String(t?.name ?? `Team ${fallbackId}`),
  code: t?.code ?? null,
  logo: typeof t?.image_path === 'string' && t.image_path.startsWith('https://') ? t.image_path : null,
});

/** A fixture as the match list stores it. */
export function parseFixture(f) {
  const seasonName = [f.league?.name, f.season?.name].filter(Boolean).join(' ');
  return {
    feedId: String(f.id),
    seriesId: f.season_id !== undefined && f.season_id !== null ? String(f.season_id) : null,
    seriesName: seasonName || null,
    format: formatOf(f.type),
    teamA: team(f.localteam, f.localteam_id),
    teamB: team(f.visitorteam, f.visitorteam_id),
    venue: f.venue?.name ?? null,
    startsAt: new Date(f.starting_at).toISOString(),
  };
}

const sideOf = (f, teamId) => (String(teamId) === String(f.localteam_id) ? 'A'
  : String(teamId) === String(f.visitorteam_id) ? 'B' : null);
const inningsOf = (scoreboard) => {
  const n = Number(String(scoreboard ?? '').replace(/^S/i, ''));
  return Number.isInteger(n) && n >= 1 ? n : 1;
};
const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));

/**
 * One delivery. `runs` is everything conceded on it (bat, byes, leg byes and
 * the extra for a wide or a no ball), which is what an over adds up; the
 * outcome is judged from the facts (wicket, no ball, wide, runs off it).
 */
export function parseBall(b) {
  const sc = b.score ?? {};
  const noBall = int(sc.noball) > 0;
  const wide = !noBall && sc.ball === false && /wide/i.test(String(sc.name ?? ''));
  const offDelivery = int(sc.runs) + int(sc.bye) + int(sc.leg_bye);
  const conceded = offDelivery + int(sc.noball) + int(sc.noball_runs);
  const over = Math.floor(Number(b.ball) || 0);
  return {
    key: String(b.id),
    innings: inningsOf(b.scoreboard),
    overNo: over,
    ballLabel: String(b.ball ?? ''),
    outcome: deliveryOutcome({ wicket: sc.is_wicket === true, noBall, wide, runs: wide ? 0 : offDelivery }),
    runs: conceded,
    at: b.updated_at ? new Date(b.updated_at).toISOString() : null,
  };
}

/** The live facts of a fixture with its balls, lineup, scoreboards and player figures. */
export function parseLiveState(f) {
  const status = statusOf(f.status);
  const toss = f.toss_won_team_id && f.elected
    ? { winner: sideOf(f, f.toss_won_team_id), elected: /^bat/i.test(f.elected) ? 'BAT' : 'BOWL' }
    : null;
  let result = null;
  if (status === 'ABANDONED') result = 'NO_RESULT';
  if (status === 'FINISHED') {
    const winner = f.winner_team_id ? sideOf(f, f.winner_team_id) : null;
    const note = `${f.note ?? ''} ${f.draw_noresult ?? ''}`.toLowerCase();
    if (winner) result = winner;
    else if (/no result/.test(note)) result = 'NO_RESULT';
    else if (/draw/.test(note)) result = 'DRAW';
    else if (/tie/.test(note)) result = 'TIE';
  }
  const lineup = (Array.isArray(f.lineup) ? f.lineup : f.lineup?.data ?? [])
    .filter((p) => p?.lineup?.substitution !== true)
    .map((p) => ({ id: String(p.id), name: String(p.fullname ?? p.lastname ?? p.id), team: sideOf(f, p.lineup?.team_id) }))
    .filter((p) => p.team);
  const balls = (Array.isArray(f.balls) ? f.balls : f.balls?.data ?? [])
    .map(parseBall)
    .sort((a, b) => a.innings - b.innings || Number(a.key) - Number(b.key));
  const boards = Array.isArray(f.scoreboards) ? f.scoreboards : f.scoreboards?.data ?? [];
  const innings = boards.filter((s) => s.type === 'total').map((s) => ({
    innings: inningsOf(s.scoreboard), team: sideOf(f, s.team_id), runs: int(s.total), wickets: int(s.wickets), overs: Number(s.overs) || 0,
  })).sort((a, b) => a.innings - b.innings);
  // Each player's match figures, every innings added up (best batsman and bowler polls).
  const listOf = (x) => (Array.isArray(x) ? x : x?.data ?? []);
  const batting = [...listOf(f.batting).reduce((acc, b) => {
    const id = String(b.player_id ?? '');
    if (!id) return acc;
    const t = acc.get(id) ?? { playerId: id, runs: 0, balls: 0 };
    t.runs += int(b.score); t.balls += int(b.ball);
    return acc.set(id, t);
  }, new Map()).values()];
  const bowling = [...listOf(f.bowling).reduce((acc, b) => {
    const id = String(b.player_id ?? '');
    if (!id) return acc;
    const t = acc.get(id) ?? { playerId: id, wickets: 0, runs: 0 };
    t.wickets += int(b.wickets); t.runs += int(b.runs);
    return acc.set(id, t);
  }, new Map()).values()];
  return {
    status,
    toss: toss?.winner ? toss : null,
    result,
    manOfMatchId: f.man_of_match_id ? String(f.man_of_match_id) : null,
    lineup,
    deliveries: balls,
    batting,
    bowling,
    score: { innings, note: f.note ?? null },
  };
}

async function token() {
  const enc = await db.cricket.feedTokenCiphertext();
  if (!enc) throw Object.assign(new Error('The cricket data token is not set (Admin › Cricket).'), { code: 'CRICKET_FEED_NOT_SET' });
  return decryptField(enc);
}

async function get(path, query, { fetchImpl = fetch } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set('api_token', await token());
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`The cricket feed answered ${res.status}`);
  const body = await res.json();
  return body?.data;
}

/** Fixtures starting in the next `days` days. */
export async function fetchUpcoming({ days = 14, fetchImpl } = {}) {
  const day = (d) => d.toISOString().slice(0, 10);
  const from = new Date();
  const to = new Date(Date.now() + days * 24 * 3600 * 1000);
  const data = await get('/fixtures', {
    'filter[starts_between]': `${day(from)},${day(to)}`,
    include: 'localteam,visitorteam,league,season,venue',
    sort: 'starting_at',
  }, { fetchImpl });
  return (Array.isArray(data) ? data : []).map(parseFixture);
}

/** One fixture's live facts. */
export async function fetchLive(feedFixtureId, { fetchImpl } = {}) {
  const data = await get(`/fixtures/${encodeURIComponent(feedFixtureId)}`, {
    include: 'balls,lineup,scoreboards,batting,bowling',
  }, { fetchImpl });
  return parseLiveState(data ?? {});
}
