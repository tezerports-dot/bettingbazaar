// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What an unauthenticated visitor learns about the players at the top.
 *
 * `GET /api/leaderboard/:period` returned the repository row whole, including
 * `userId` — the internal identifier every user-scoped API takes — for the top
 * fifty players, ordered by net profit. That is not really a leaderboard
 * problem: it sets the price of every other flaw, because an IDOR against
 * random ids is a theory and the same IDOR against fifty ids the platform hands
 * out, sorted by balance, is a script.
 *
 * The assertion that matters is the SUBSET one (§24.2): a test that checks one
 * field is absent is a denylist written as a test, and the next field added to
 * the aggregate upstream would sail past it.
 */
import { describe, it, expect } from 'vitest';
import {
  PUBLIC_LEADERBOARD_FIELDS,
  publicLeaderboardEntry,
  publicLeaderboard,
} from '../../domains/analytics/leaderboardPublicView.js';

/** A row shaped like `db.stats.leaderboard()` emits, plus what it used to. */
const row = (over = {}) => ({
  rank: 1,
  userId: 'usr_0123456789abcdef',
  username: 'topplayer',
  totalBets: 120,
  wins: 71,
  totalStaked: 45_000,
  totalWon: 62_000,
  netProfit: 17_000,
  winRate: 59,
  ...over,
});

describe('publicLeaderboardEntry', () => {
  it('never emits a key outside the allowlist, whatever the row carries', () => {
    // The subset assertion. A column added to the aggregate upstream fails this
    // without anybody remembering to add a line here.
    const out = publicLeaderboardEntry(row({ someColumnAddedLater: 'x', mobile: '99…' }));
    expect(Object.keys(out).every((k) => PUBLIC_LEADERBOARD_FIELDS.includes(k))).toBe(true);
  });

  it('does not publish the internal user id', () => {
    expect(publicLeaderboardEntry(row())).not.toHaveProperty('userId');
  });

  it('still carries everything the board actually renders', () => {
    const out = publicLeaderboardEntry(row());
    for (const k of ['rank', 'username', 'totalBets', 'wins', 'totalStaked', 'totalWon', 'netProfit', 'winRate']) {
      expect(out, `the board renders ${k}`).toHaveProperty(k);
    }
  });

  it('omits a key the row does not have rather than sending undefined', () => {
    const out = publicLeaderboardEntry({ rank: 3, username: 'a' });
    expect('winRate' in out).toBe(false);
  });
});

describe('publicLeaderboard', () => {
  it('projects every entry', () => {
    const out = publicLeaderboard([row({ rank: 1 }), row({ rank: 2 })]);
    expect(out).toHaveLength(2);
    expect(out.some((e) => 'userId' in e)).toBe(false);
  });

  it('treats a missing or malformed cache as an empty board, never a throw', () => {
    // The entries come out of a JSONB cache column. A route that throws because
    // the cache has not been built yet is a 500 on a public page.
    for (const bad of [null, undefined, {}, 'nonsense', 0]) {
      expect(publicLeaderboard(bad)).toEqual([]);
    }
  });
});
