// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The cricket routes over HTTP against a real database (owner, 2026-10-18):
 * the player's `/api/v1/cricket` (list, quote, bet, claim) and Admin ›
 * Cricket (`canManageGames`: publish, order, polls, settle, void, report).
 * The money rules are in database/tests/cricketPg.test.js; here, admission,
 * the refusals a player can act on, and that a button's call lands.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '#db/client.js';
import { applyConfig, getConfig } from '#db/repositories/config.js';
import * as cricket from '#db/repositories/cricket.js';
import { fundWallet } from '#db/tests/_funding.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);

describePg('cricket routes', () => {
  let pub; let admin; let games; let other; let p1; let baseline; let matchId;

  beforeAll(async () => {
    await applySchema();
    baseline = await getConfig('system', { fresh: true });
    await applyConfig({ scope: 'system', actor: 'test-setup', patch: { cricket: { enabled: true, inPlayDelaySec: 0, claimHoldSec: 0 } } });
    pub = mountRouter((await import('../../domains/cricket/cricket.routes.js')).default);
    admin = mountRouter((await import('../../domains/cricket/cricket.admin.routes.js')).default);
    games = await actor({ isSubAdmin: true, permissions: { canManageGames: true } });
    other = await actor({ isSubAdmin: true, permissions: { canManageContent: true } });
    p1 = await actor();
    await fundWallet(p1.userId, 500_000, `crk-rt-${p1.userId}`);
    await cricket.upsertFixtures([{
      feedId: `${RUN}9`, seriesId: `S${RUN}`, seriesName: 'Route Cup', format: 'T20',
      teamA: { id: '1', name: 'Alpha' }, teamB: { id: '2', name: 'Bravo' }, venue: null,
      startsAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
    }]);
    matchId = cricket.matchIdFor(`${RUN}9`);
  }, 60_000);

  afterAll(async () => {
    await applyConfig({ scope: 'system', actor: 'test-teardown', patch: { cricket: baseline.cricket ?? { enabled: false, inPlayDelaySec: 5 } } }).catch(() => {});
    await closePg();
  });

  it('admits only staff holding canManageGames to Admin › Cricket', async () => {
    expect((await request(admin).get('/cricket')).status).toBe(401);
    expect((await as(admin, other).get('/cricket')).status).toBe(403);
    expect((await as(admin, other).post(`/cricket/matches/${matchId}/publish`)).status).toBe(403);
    const ok = await as(admin, games).get('/cricket');
    expect(ok.status).toBe(200);
    expect(ok.body.feed.tokenSet === true || ok.body.feed.tokenSet === false).toBe(true);
    expect(JSON.stringify(ok.body.feed)).not.toMatch(/token_enc|tokenEnc/);
    expect(ok.body.feedProviders.map((p) => p.key)).toEqual(['SPORTMONKS', 'ENTITYSPORT']);
  });

  it('saves each provider\'s token apart and switches which one lists the fixtures', async () => {
    const before = (await as(admin, games).get('/cricket')).body.feed;
    try {
      expect((await as(admin, games).put('/cricket/feed-token').send({ provider: 'NOPE', token: 'a'.repeat(32) })).body.code).toBe('UNKNOWN_PROVIDER');
      const saved = await as(admin, games).put('/cricket/feed-token').send({ provider: 'ENTITYSPORT', token: 'e'.repeat(32) });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const es = saved.body.feed.providers.find((p) => p.provider === 'ENTITYSPORT');
      expect(es).toMatchObject({ tokenSet: true });
      expect(JSON.stringify(saved.body)).not.toContain('e'.repeat(32));
      const used = await as(admin, games).put('/cricket/feed-provider').send({ provider: 'ENTITYSPORT' });
      expect(used.status).toBe(200);
      expect(used.body.feed).toMatchObject({ provider: 'ENTITYSPORT', active: true, tokenSet: true });
      expect(used.body.feed.providers.filter((p) => p.active)).toHaveLength(1);
      expect((await as(admin, games).put('/cricket/feed-provider').send({ provider: 'x' })).body.code).toBe('UNKNOWN_PROVIDER');
    } finally {
      await as(admin, games).put('/cricket/feed-provider').send({ provider: before.provider });
      await as(admin, games).put('/cricket/feed-token').send({ provider: 'ENTITYSPORT', token: '' });
    }
  });

  it('publishes a match: players see it with its toss and result polls', async () => {
    const r = await as(admin, games).post(`/cricket/matches/${matchId}/publish`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = await request(pub).get('/matches');
    const m = list.body.matches.find((x) => x.matchId === matchId);
    expect(m).toBeTruthy();
    expect(m.polls.map((p) => p.kind).sort()).toEqual(['MATCH_RESULT', 'TOSS']);
  });

  it('quotes, then places a bet with the confirmed odds and an Idempotency-Key; retries answer the same bet', async () => {
    const pollId = `${matchId}:MATCH_RESULT:0:0:0`;
    expect((await request(pub).post('/quote/bet').send({ pollId, optionKey: 'A', stake: 100 })).status).toBe(401);
    const q = await as(pub, p1).post('/quote/bet').send({ pollId, optionKey: 'A', stake: 100 });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect((await as(pub, p1).post('/bets').send({ pollId, optionKey: 'A', stake: 100, minOdds: q.body.oddsX100 })).status).toBe(400);
    const key = `crk-${RUN}-k1`;
    const placed = await as(pub, p1).post('/bets').set('Idempotency-Key', key).send({ pollId, optionKey: 'A', stake: 100, minOdds: q.body.oddsX100 });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const again = await as(pub, p1).post('/bets').set('Idempotency-Key', key).send({ pollId, optionKey: 'A', stake: 100, minOdds: q.body.oddsX100 });
    expect(again.status).toBe(200);
    expect(again.body.bet.betId).toBe(placed.body.bet.betId);
    const mine = await as(pub, p1).get(`/me/bets?matchId=${matchId}`);
    expect(mine.body.bets).toHaveLength(1);
  });

  it('answers a stake outside the bounds and odds that moved with something the player can act on', async () => {
    const pollId = `${matchId}:MATCH_RESULT:0:0:0`;
    const small = await as(pub, p1).post('/bets').set('Idempotency-Key', `crk-${RUN}-k2`).send({ pollId, optionKey: 'B', stake: 5, minOdds: 101 });
    expect(small.status).toBe(400);
    expect(small.body.code).toBe('INVALID_STAKE');
    const moved = await as(pub, p1).post('/bets').set('Idempotency-Key', `crk-${RUN}-k3`).send({ pollId, optionKey: 'B', stake: 100, minOdds: 99_999 });
    expect(moved.status).toBe(409);
    expect(moved.body).toMatchObject({ code: 'ODDS_CHANGED' });
    expect(moved.body.quote.oddsX100).toBeGreaterThan(100);
  });

  it('claims the match in one go at the confirmed total', async () => {
    const q = await as(pub, p1).post('/quote/claim').send({ matchId });
    expect(q.status).toBe(200);
    expect(q.body.lines).toHaveLength(1);
    const c = await as(pub, p1).post('/claims').send({ matchId, minTotalPaise: q.body.totalNetPaise });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.totalNetPaise).toBe(q.body.totalNetPaise);
    const none = await as(pub, p1).post('/claims').send({ matchId, minTotalPaise: 0 });
    expect(none.body.code).toBe('NOTHING_TO_CLAIM');
  });

  it('refuses to unpublish a match players bet on, and lets the admin settle and void its polls', async () => {
    expect((await as(admin, games).post(`/cricket/matches/${matchId}/unpublish`)).body.code).toBe('MATCH_HAS_BETS');
    const polls = await as(admin, games).get(`/cricket/matches/${matchId}/polls`);
    expect(polls.status).toBe(200);
    const result = polls.body.polls.find((p) => p.kind === 'MATCH_RESULT');
    expect(result.book.map((b) => b.key)).toEqual(['A', 'DRAW', 'B']);
    expect((await as(admin, games).post(`/cricket/polls/${encodeURIComponent(result.pollId)}/settle`).send({ winningOptions: ['Z'] })).status).toBe(400);
    expect((await as(admin, games).post(`/cricket/polls/${encodeURIComponent(result.pollId)}/void`).send({})).status).toBe(400);
    const settled = await as(admin, games).post(`/cricket/polls/${encodeURIComponent(result.pollId)}/settle`).send({ winningOptions: ['B'] });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect((await as(admin, games).post(`/cricket/polls/${encodeURIComponent(result.pollId)}/void`).send({ reason: 'x' })).body.code).toBe('ENDED');
    const toss = polls.body.polls.find((p) => p.kind === 'TOSS');
    expect((await as(admin, games).post(`/cricket/polls/${encodeURIComponent(toss.pollId)}/void`).send({ reason: 'Toss not reported' })).status).toBe(200);
  });

  it('reports each ended poll and exports the same rows as CSV', async () => {
    const r = await as(admin, games).get('/cricket/report');
    expect(r.status).toBe(200);
    expect(r.body.polls.some((p) => p.matchId === matchId)).toBe(true);
    const csv = await as(admin, games).get('/cricket/report.csv');
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe('settled_at,match,poll,kind,status,winner,bets,stakes,claims_paid,wins_paid,fees,refunded,house_net');
    expect((await as(admin, games).get('/cricket/report?from=2026-01-01&to=2026-12-31')).body.code).toBe('WINDOW_TOO_LONG');
  });

  it('orders published matches, and refuses one that is not published', async () => {
    expect((await as(admin, games).put('/cricket/matches/order').send({ matchIds: [matchId] })).status).toBe(200);
    expect((await as(admin, games).put('/cricket/matches/order').send({ matchIds: [matchId, 'CMnope'] })).body.code).toBe('UNKNOWN_MATCH');
    const { rows: [m] } = await pgQuery('SELECT display_order FROM cricket_matches WHERE match_id = $1', [matchId]);
    expect(m.display_order).toBe(0);
  });

  it('shows players nothing, and refuses bets, while the game is switched off', async () => {
    await applyConfig({ scope: 'system', actor: 'test', patch: { cricket: { enabled: false } } });
    try {
      expect((await request(pub).get('/matches')).body.matches).toEqual([]);
      const r = await as(pub, p1).post('/quote/bet').send({ pollId: 'x', optionKey: 'A', stake: 100 });
      expect(r.body.code).toBe('GAME_SWITCHED_OFF');
    } finally {
      await applyConfig({ scope: 'system', actor: 'test', patch: { cricket: { enabled: true, inPlayDelaySec: 0, claimHoldSec: 0 } } });
    }
  });
});
