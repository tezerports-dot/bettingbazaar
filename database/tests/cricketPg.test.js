// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Cricket opinion polls (owner, 2026-10-18) against a real PostgreSQL: the
 * one writer (`database/repositories/cricket.js`) and the schema's guards.
 *
 * ── The invariants ──────────────────────────────────────────────────────────
 * 1. The house never loses more than its seed on a poll: for every option,
 *    stakes − claims paid − owed if it wins ≥ −seed × options, held by the
 *    pricing under the poll's lock AND by `bb_cricket_book_bound` at commit.
 * 2. Every token moves with its counterparty (the house), in one transaction
 *    with the bet, claim or payout (token conservation refuses anything else).
 * 3. A bet or claim pressed before a match event that reached the server
 *    during its delay is refused; a bet pressed after the ball it is about is
 *    void when that ball settles.
 * 4. A bet id is spent once; a poll ends once; a claim is all or nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { getBalancesPaise } from '../repositories/wallets.core.js';
import * as cricket from '../repositories/cricket.js';
import * as rtp from '../repositories/rtp.js';
import { optionsFor, pollIdFor, POLL_KINDS } from '../../backend/domains/cricket/cricketPolls.js';
import { fundWallet, refusedBy } from './_funding.js';

const describePg = pgConfigured() ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;
const FEE_BP = 100;        // 1 %, the schema default of winningsFeePercent
const RESERVE_BP = 0;      // whole stake from deposit, so pockets are easy to read
const past = () => new Date(Date.now() - 1000).toISOString();

async function player(depositPaise = 1_000_000) {
  const userId = `pg-crk-${RUN}-${++seq}`;
  await fundWallet(userId, depositPaise, `crk-fund-${userId}`);
  return userId;
}

async function match() {
  const feedId = `${RUN}${++seq}`;
  await cricket.upsertFixtures([{
    feedId, seriesId: null, seriesName: 'Test Series', format: 'T20',
    teamA: { id: '1', name: 'Alpha' }, teamB: { id: '2', name: 'Bravo' },
    venue: null, startsAt: new Date(Date.now() + 3600_000).toISOString(),
  }]);
  const matchId = cricket.matchIdFor(feedId);
  await cricket.publishMatch(matchId, 'test-admin');
  return cricket.getMatch(matchId);
}

/** A match-result poll with a 10 % spread and `seed` per option. */
async function resultPoll(m, { seedPaise = 50_000, spreadBp = 1000 } = {}) {
  const pollId = pollIdFor(m.matchId, POLL_KINDS.MATCH_RESULT, {});
  await cricket.openPoll({
    pollId, matchId: m.matchId, kind: POLL_KINDS.MATCH_RESULT, title: 'Match result',
    spreadBp, seedPaise, options: optionsFor(POLL_KINDS.MATCH_RESULT, m),
  });
  return pollId;
}

const bet = (userId, pollId, optionKey, stakePaise, extra = {}) => cricket.placeBet({
  betId: `b-${RUN}-${++seq}`, userId, pollId, optionKey, stakePaise,
  minOddsX100: 101, requestedAt: new Date().toISOString(), reserveBp: RESERVE_BP, ...extra,
});

/** Worst case for the house across options, from the rows. */
async function worstBook(pollId) {
  const { rows: [p] } = await pgQuery('SELECT * FROM cricket_polls WHERE poll_id = $1', [pollId]);
  const { rows: opts } = await pgQuery('SELECT * FROM cricket_poll_options WHERE poll_id = $1', [pollId]);
  const stakes = Number(p.stakes_paise) - Number(p.claims_paid_paise);
  return { worst: Math.min(...opts.map((o) => stakes - Number(o.liability_paise))), bound: -Number(p.seed_paise) * Number(p.option_count) };
}

describePg('cricket opinion polls', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('prices a bet from the pools with its own stake in, takes it from the wallet to the house, and is idempotent', async () => {
    const m = await match();
    const pollId = await resultPoll(m, { seedPaise: 50_000 });
    const u = await player();
    const before = await getBalancesPaise(u);
    const betId = `b-${RUN}-idem`;
    const r = await bet(u, pollId, 'A', 10_000, { betId });
    expect(r.ok).toBe(true);
    // T = 3 seeds of 500 + 100 staked = 1,600; P_A = 600; 0.9 × 1,600 / 600 = 2.40.
    expect(r.bet.oddsX100).toBe(240);
    expect(r.bet.potentialPaise).toBe(24_000);
    const after = await getBalancesPaise(u);
    expect(before.depositBalance - after.depositBalance).toBe(10_000);

    const again = await bet(u, pollId, 'A', 10_000, { betId });
    expect(again.ok && again.idempotent).toBe(true);
    expect((await getBalancesPaise(u)).depositBalance).toBe(after.depositBalance);

    const other = await player();
    expect((await bet(other, pollId, 'A', 10_000, { betId })).reason).toBe('BET_ID_TAKEN');
  });

  it('sends players the pool odds of the live book (seeds plus real stakes, 10 % spread)', async () => {
    const m = await match();
    const pollId = await resultPoll(m, { seedPaise: 50_000 });
    expect((await bet(await player(), pollId, 'B', 150_000)).ok).toBe(true);
    expect((await bet(await player(), pollId, 'A', 50_000)).ok).toBe(true);
    const [p] = (await cricket.playerPolls(m.matchId)).filter((x) => x.pollId === pollId);
    // Pools with seeds: A 1,000, DRAW 500, B 2,000; T 3,500 → 0.9 × 3,500 / P.
    const odds = Object.fromEntries(p.options.map((o) => [o.key, o.oddsX100]));
    expect(odds).toEqual({ A: 315, DRAW: 630, B: 157 });
  });

  it('suspends an option rather than offer odds below 1.01 (a stake that would swamp the pool)', async () => {
    const m = await match();
    const pollId = await resultPoll(m, { seedPaise: 100 });
    const r = await bet(await player(), pollId, 'A', 100_000);
    expect(r).toMatchObject({ ok: false, reason: 'OPTION_SUSPENDED' });
  });

  it('never lets the book fall below −seed × options, however the bets are drip-fed', async () => {
    const m = await match();
    const pollId = await resultPoll(m, { seedPaise: 500_000 });
    const big = await player(5_000_000);
    expect((await bet(big, pollId, 'B', 1_000_000)).ok).toBe(true);
    const drip = await player(5_000_000);
    let placed = 0; let suspended = 0;
    for (let i = 0; i < 60; i += 1) {
      const r = await bet(drip, pollId, 'A', 50_000);
      if (r.ok) placed += 1; else { expect(r.reason).toBe('OPTION_SUSPENDED'); suspended += 1; }
      const { worst, bound } = await worstBook(pollId);
      expect(worst).toBeGreaterThanOrEqual(bound);
    }
    expect(placed).toBeGreaterThan(0);
    expect(placed + suspended).toBe(60);
  });

  it('refuses at commit a book a writer pushed past the bound (bb_cricket_book_bound)', async () => {
    const m = await match();
    const pollId = await resultPoll(m, { seedPaise: 100 });
    const r = await refusedBy(pgQuery(
      `UPDATE cricket_poll_options SET liability_paise = 1000 WHERE poll_id = $1 AND option_key = 'A'`, [pollId]));
    expect(r.message).toMatch(/more than its seed/);
  });

  it('answers ODDS_CHANGED with the new quote when the odds fell below what was confirmed', async () => {
    const m = await match();
    const pollId = await resultPoll(m);
    const u = await player();
    const r = await bet(u, pollId, 'A', 10_000, { minOddsX100: 9_999 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ODDS_CHANGED');
    expect(r.quote.oddsX100).toBeGreaterThan(100);
  });

  it('refuses a bet pressed before a match event that arrived during its delay', async () => {
    const m = await match();
    const pollId = await resultPoll(m);
    const u = await player();
    const pressed = past();
    await cricket.applyMatchFacts(m.matchId, { eventAt: new Date().toISOString() });
    const r = await bet(u, pollId, 'A', 10_000, { requestedAt: pressed });
    expect(r.reason).toBe('EVENT_DURING_DELAY');
    const ok = await bet(u, pollId, 'A', 10_000, { requestedAt: new Date(Date.now() + 1000).toISOString() });
    expect(ok.ok).toBe(true);
  });

  it('settles: a winner gets payout less the 1 % fee into winnings, a loser nothing; the RTP fund gets its entry once', async () => {
    await rtp.saveSettings({ gameKey: 'CRICKET', audience: 'VIP', enabled: true, ratePercent: 90 });
    try {
      const m = await match();
      const pollId = await resultPoll(m);
      const win = await player(); const lose = await player();
      const w = await bet(win, pollId, 'A', 50_000);
      await bet(lose, pollId, 'B', 50_000);
      const wb = await getBalancesPaise(win);
      const r = await cricket.endPoll({ pollId, winningOption: 'A', feeBp: FEE_BP });
      expect(r.ok).toBe(true);
      const gross = w.bet.potentialPaise;
      const fee = Math.min(Math.floor(gross * FEE_BP / 10000), gross - 50_000);
      const wa = await getBalancesPaise(win);
      expect(wa.winningsBalance - wb.winningsBalance).toBe(gross - fee);
      expect((await cricket.endPoll({ pollId, winningOption: 'A', feeBp: FEE_BP })).reason).toBe('ENDED');
      const { rows } = await pgQuery('SELECT * FROM rtp_fund_entries WHERE cycle_id = $1', [`CRK:${pollId}`]);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].pool_paise)).toBe(100_000);
      expect(Number(rows[0].paid_back_paise)).toBe(gross - fee);
    } finally {
      await rtp.saveSettings({ gameKey: 'CRICKET', audience: 'VIP', enabled: false, ratePercent: 90 });
    }
  });

  it('voids: every stake goes back to the pocket it came from', async () => {
    const m = await match();
    const pollId = await resultPoll(m);
    const u = await player(0);
    await fundWallet(u, 3_000, `crk-w-${u}`, 'winningsBalance');
    await fundWallet(u, 10_000, `crk-d-${u}`, 'depositBalance');
    const before = await getBalancesPaise(u);
    expect((await bet(u, pollId, 'A', 12_000)).ok).toBe(true);
    const mid = await getBalancesPaise(u);
    expect(mid.depositBalance).toBe(0);
    expect(mid.winningsBalance).toBe(1_000);
    const r = await cricket.endPoll({ pollId, voidReason: 'Abandoned', feeBp: FEE_BP });
    expect(r.status).toBe('VOID');
    const after = await getBalancesPaise(u);
    expect(after.depositBalance).toBe(before.depositBalance);
    expect(after.winningsBalance).toBe(before.winningsBalance);
  });

  it('voids a next-ball bet pressed after the ball was recorded, and settles the one pressed before', async () => {
    const m = await match();
    const pollId = pollIdFor(m.matchId, POLL_KINDS.BALL, { seq: 1 });
    await cricket.openPoll({ pollId, matchId: m.matchId, kind: POLL_KINDS.BALL, seq: 1, title: 'Next ball', spreadBp: 1000, seedPaise: 10_000, options: optionsFor(POLL_KINDS.BALL, m) });
    const early = await player(); const late = await player();
    const bowledAt = new Date();
    await bet(early, pollId, 'DOT', 10_000, { requestedAt: new Date(bowledAt.getTime() - 2000).toISOString() });
    await bet(late, pollId, 'DOT', 10_000, { requestedAt: new Date(bowledAt.getTime() + 500).toISOString() });
    const lateBefore = await getBalancesPaise(late);
    const r = await cricket.endPoll({ pollId, winningOption: 'DOT', voidPressedFrom: bowledAt.toISOString(), feeBp: FEE_BP });
    const byUser = Object.fromEntries(r.payouts.map((p) => [p.userId, p.status]));
    expect(byUser).toEqual({ [early]: 'WON', [late]: 'VOID' });
    expect((await getBalancesPaise(late)).depositBalance - lateBefore.depositBalance).toBe(10_000);
  });

  it('claims every open position of a match at once, all or nothing, and holds to the confirmed total', async () => {
    const m = await match();
    const pollId = await resultPoll(m);
    const tossId = pollIdFor(m.matchId, POLL_KINDS.TOSS, {});
    await cricket.openPoll({ pollId: tossId, matchId: m.matchId, kind: POLL_KINDS.TOSS, title: 'Toss', spreadBp: 1000, seedPaise: 50_000, options: optionsFor(POLL_KINDS.TOSS, m) });
    const u = await player();
    await bet(u, pollId, 'A', 20_000);
    await bet(u, tossId, 'A_BAT', 20_000);
    // Others back A after, so the position is worth more.
    for (let i = 0; i < 3; i += 1) await bet(await player(), pollId, 'A', 50_000);

    const q = await cricket.quoteClaims({ userId: u, matchId: m.matchId, feeBp: FEE_BP });
    expect(q.lines).toHaveLength(2);
    const tooMuch = await cricket.claimPositions({ userId: u, matchId: m.matchId, minTotalNetPaise: q.totalNetPaise + 1, requestedAt: new Date().toISOString(), feeBp: FEE_BP });
    expect(tooMuch.reason).toBe('QUOTE_CHANGED');
    const before = await getBalancesPaise(u);
    const r = await cricket.claimPositions({ userId: u, matchId: m.matchId, minTotalNetPaise: q.totalNetPaise, requestedAt: new Date().toISOString(), feeBp: FEE_BP });
    expect(r.ok).toBe(true);
    expect(r.claimed).toHaveLength(2);
    expect((await getBalancesPaise(u)).winningsBalance - before.winningsBalance).toBe(r.totalNetPaise);
    for (const id of [pollId, tossId]) {
      const { worst, bound } = await worstBook(id);
      expect(worst).toBeGreaterThanOrEqual(bound);
    }
    const again = await cricket.claimPositions({ userId: u, matchId: m.matchId, minTotalNetPaise: 0, requestedAt: new Date().toISOString(), feeBp: FEE_BP });
    expect(again.reason).toBe('NOTHING_TO_CLAIM');
  });

  it('refuses a claim pressed within the hold after its bet was placed, and leaves young bets out of Claim all', async () => {
    const m = await match();
    const pollId = await resultPoll(m);
    const u = await player();
    const old = await bet(u, pollId, 'A', 20_000);
    await new Promise((r) => { setTimeout(r, 2100); });
    const young = await bet(u, pollId, 'B', 20_000);
    const at = new Date().toISOString();
    const args = { userId: u, minTotalNetPaise: 0, requestedAt: at, holdSec: 2, feeBp: FEE_BP };

    const named = await cricket.claimPositions({ ...args, betIds: [young.bet.betId] });
    expect(named.reason).toBe('CLAIM_TOO_SOON');
    const mixed = await cricket.claimPositions({ ...args, betIds: [old.bet.betId, young.bet.betId] });
    expect(mixed.reason).toBe('CLAIM_TOO_SOON');
    const q = await cricket.quoteClaims({ userId: u, matchId: m.matchId, holdSec: 2, feeBp: FEE_BP });
    expect(q.lines.map((l) => l.betId)).toEqual([old.bet.betId]);
    const all = await cricket.claimPositions({ ...args, matchId: m.matchId });
    expect(all.claimed.map((l) => l.betId)).toEqual([old.bet.betId]);
    // Only the young one left: Claim all says to wait, not that there is nothing.
    expect((await cricket.claimPositions({ ...args, matchId: m.matchId })).reason).toBe('CLAIM_TOO_SOON');
    // Pressed once the hold has passed, it is claimed.
    const later = new Date(Date.now() + 3000).toISOString();
    const ok = await cricket.claimPositions({ ...args, requestedAt: later, betIds: [young.bet.betId] });
    expect(ok.ok).toBe(true);
  });

  it('takes many players betting at once on one poll without breaking the book or losing a token', async () => {
    const m = await match();
    const pollId = await resultPoll(m, { seedPaise: 20_000 });
    const users = await Promise.all(Array.from({ length: 24 }, () => player()));
    const keys = ['A', 'B', 'DRAW'];
    const results = await Promise.all(users.map((u, i) => bet(u, pollId, keys[i % 3], 5_000 + i * 1_000)));
    const ok = results.filter((r) => r.ok);
    const { rows: [p] } = await pgQuery('SELECT stakes_paise FROM cricket_polls WHERE poll_id = $1', [pollId]);
    expect(Number(p.stakes_paise)).toBe(ok.reduce((t, r) => t + r.bet.stakePaise, 0));
    const { worst, bound } = await worstBook(pollId);
    expect(worst).toBeGreaterThanOrEqual(bound);
  });

  it('shows players only the last settled, the live and the next of the ball and over polls', async () => {
    const m = await match();
    const opts = optionsFor(POLL_KINDS.BALL, m);
    for (let s = 1; s <= 5; s += 1) {
      const id = pollIdFor(m.matchId, POLL_KINDS.BALL, { seq: s });
      await cricket.openPoll({ pollId: id, matchId: m.matchId, kind: POLL_KINDS.BALL, seq: s, title: `Ball ${s}`, spreadBp: 1000, seedPaise: 10_000, options: opts });
      if (s < 5) await cricket.endPoll({ pollId: id, winningOption: 'DOT', feeBp: FEE_BP });
    }
    for (let o = 0; o <= 3; o += 1) {
      const id = pollIdFor(m.matchId, POLL_KINDS.OVER, { innings: 1, overNo: o });
      await cricket.openPoll({ pollId: id, matchId: m.matchId, kind: POLL_KINDS.OVER, innings: 1, overNo: o, title: `Over ${o + 1}`, spreadBp: 1000, seedPaise: 10_000, options: optionsFor(POLL_KINDS.OVER, m) });
      if (o < 2) await cricket.endPoll({ pollId: id, winningOption: 'ODD', feeBp: FEE_BP });
      if (o === 2) await cricket.closePoll(id);
    }
    const polls = await cricket.playerPolls(m.matchId);
    const balls = polls.filter((p) => p.kind === 'BALL').map((p) => [p.seq, p.status]);
    const overs = polls.filter((p) => p.kind === 'OVER').map((p) => [p.overNo, p.status]);
    expect(balls).toEqual([[5, 'OPEN'], [4, 'SETTLED']]);
    expect(overs.sort()).toEqual([[1, 'SETTLED'], [2, 'CLOSED'], [3, 'OPEN']]);
  });
});
