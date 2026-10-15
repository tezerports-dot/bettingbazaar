// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The board rules a player reads and accepts, and the GENERAL profile routes,
 * over HTTP against a real database (owner, 2026-10-08).
 *
 *   GET  /v1/board-rules            the text, with the winnings fee in force
 *   GET  /user/board-rules          the current version and what this player accepted
 *   POST /user/board-rules/accept   only the CURRENT version is accepted
 *   GET/PUT /admin/board-rules      an admin publishes the next version, and every
 *                                   player must accept it again (owner, 2026-10-14)
 *   GET  /user/general              profile, General balance, turnover left
 *   PUT  /user/play-profile         VIP or GENERAL, nothing else
 *
 * The bet route's refusal before acceptance is in betPlaceRoutesPg.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getSystemConfig } from '#db/repositories/config.js';
import * as promo from '#db/repositories/promo.js';
import { currentVersion } from '#db/repositories/boardRules.js';
import { DEFAULT_BOARD_RULES } from '../../domains/markets/boardRules.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('board rules and the GENERAL profile routes', () => {
  let app;
  let adminApp;
  let BOARD_RULES_VERSION;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/user/user.routes.js');
    app = mountRouter(mod.default);
    adminApp = mountRouter((await import('../../routes/admin/boardRules.admin.routes.js')).default);
    BOARD_RULES_VERSION = await currentVersion();
  }, 60_000);

  afterAll(async () => { await closePg(); });

  it('serves the rules to anyone, stating the fee in force', async () => {
    const res = await request(app).get('/v1/board-rules');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(BOARD_RULES_VERSION);
    const text = res.body.sections.map((s) => `${s.title} ${s.body}`).join(' ');
    expect(text).toMatch(/LESS real player money/);
    expect(text).toMatch(/house/i);
    expect(text).toMatch(/not real players/);
    expect(text).toMatch(/only the total of both sides is shown until the result/);
    expect(text).toMatch(/may decide or cancel a round\. A cancelled round returns every stake/);
    const fee = (await getSystemConfig()).winningsFeePercent;
    expect(text).toContain(`${fee}%`);
  });

  it('records an acceptance of the current version only, and never moves it back', async () => {
    const p = await actor({ boardRules: false });
    expect((await as(app, p).get('/user/board-rules')).body)
      .toMatchObject({ version: BOARD_RULES_VERSION, acceptedVersion: 0 });

    const stale = await as(app, p).post('/user/board-rules/accept').send({ version: BOARD_RULES_VERSION - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('BOARD_RULES_CHANGED');
    expect((await as(app, p).get('/user/board-rules')).body.acceptedVersion).toBe(0);

    // A version the player was never shown is not theirs to accept either.
    const unseen = await as(app, p).post('/user/board-rules/accept').send({ version: BOARD_RULES_VERSION + 1 });
    expect(unseen.status).toBe(409);
    expect((await as(app, p).get('/user/board-rules')).body.acceptedVersion).toBe(0);

    const ok = await as(app, p).post('/user/board-rules/accept').send({ version: BOARD_RULES_VERSION });
    expect(ok.status).toBe(200);
    expect(ok.body.acceptedVersion).toBe(BOARD_RULES_VERSION);
    expect((await as(app, p).get('/user/board-rules')).body.acceptedVersion).toBe(BOARD_RULES_VERSION);
  });

  it('lets an admin publish the next version, which every player must accept again', async () => {
    const admin = await actor({ isAdmin: true });
    const p = await actor({});
    const before = await currentVersion();
    expect((await as(app, p).get('/user/board-rules')).body.acceptedVersion).toBe(before);

    const got = await as(adminApp, admin).get('/board-rules');
    expect(got.status).toBe(200);
    expect(got.body.text.version).toBe(before);
    expect(Object.keys(got.body.tokens)).toEqual(expect.arrayContaining(['winningsFeePercent', 'payoutMultiplier', 'backingSides']));

    // The built-in rules plus one more, so the text the other tests read stays true.
    const sections = [...DEFAULT_BOARD_RULES.sections, { title: 'Responsible play', body: 'Set yourself a limit.' }];
    const typo = await as(adminApp, admin).put('/board-rules').send({ ...DEFAULT_BOARD_RULES, sections: [{ title: 'Fee', body: '{fee}%' }] });
    expect(typo.status).toBe(400);
    expect(typo.body.message).toMatch(/Unknown placeholder \{fee\}/);
    expect(await currentVersion()).toBe(before);

    const pub = await as(adminApp, admin).put('/board-rules').send({ ...DEFAULT_BOARD_RULES, sections });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.text.version).toBe(before + 1);
    BOARD_RULES_VERSION = before + 1;

    const served = await request(app).get('/v1/board-rules');
    expect(served.body.version).toBe(before + 1);
    expect(served.body.heading).toBe(DEFAULT_BOARD_RULES.heading);
    expect(served.body.sections.at(-1)).toEqual({ title: 'Responsible play', body: 'Set yourself a limit.' });
    // Placeholders are filled from the live config, never served as braces.
    expect(JSON.stringify(served.body)).not.toMatch(/\{(winningsFeePercent|payoutMultiplier|backingSides)\}/);

    // The player's earlier acceptance no longer counts, and the old version is refused.
    expect((await as(app, p).get('/user/board-rules')).body).toMatchObject({ version: before + 1, acceptedVersion: before });
    expect((await as(app, p).post('/user/board-rules/accept').send({ version: before })).status).toBe(409);
    expect((await as(app, p).post('/user/board-rules/accept').send({ version: before + 1 })).status).toBe(200);

    // A player cannot publish.
    expect((await as(adminApp, p).put('/board-rules').send({ ...DEFAULT_BOARD_RULES, sections })).status).toBe(403);
  });

  it('refuses the player routes without a token', async () => {
    expect((await request(app).get('/user/board-rules')).status).toBe(401);
    expect((await request(app).post('/user/board-rules/accept').send({ version: BOARD_RULES_VERSION })).status).toBe(401);
    expect((await request(app).get('/user/general')).status).toBe(401);
    expect((await request(app).put('/user/play-profile').send({ profile: 'GENERAL' })).status).toBe(401);
  });

  it('shows the General balance and switches profile, refusing an unknown one', async () => {
    const p = await actor({});
    await promo.creditReferralBonus({ userId: p.userId, amountPaise: 2_500, earningId: `${p.userId}-e1` });

    const g = await as(app, p).get('/user/general');
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ profile: 'VIP', promoBalance: 25, outstandingTurnover: 250, turnoverMultiplier: 10 });

    const sw = await as(app, p).put('/user/play-profile').send({ profile: 'GENERAL' });
    expect(sw.status).toBe(200);
    expect((await as(app, p).get('/user/general')).body.profile).toBe('GENERAL');

    const bad = await as(app, p).put('/user/play-profile').send({ profile: 'GOLD' });
    expect(bad.status).toBe(400);
    expect((await as(app, p).get('/user/general')).body.profile).toBe('GENERAL');
  });
});
