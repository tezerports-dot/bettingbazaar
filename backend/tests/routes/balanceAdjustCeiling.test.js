// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * One admin, one click, any sum — until this.
 *
 * ── What was open ──────────────────────────────────────────────────────────
 * `POST /api/admin/balance-adjust` bounded the amount at `> 0` and nothing
 * else. A DEBIT is capped by what the player holds (the route answers
 * "Insufficient {field}: have ₹…"), so the open end was a CREDIT: any amount,
 * applied immediately, with an audit row as the only record. The form pass
 * found the field carried no `min`/`max` on the client either, so nothing
 * between the keyboard and the ledger was going to stop a slip.
 *
 * The ceiling is ₹10,00,000 per adjustment, owner-set 2026-09-23, and it lives
 * in `SYSTEM_CONFIG_SPEC.maxBalanceAdjustment` rather than as a literal in this
 * route — the settings screen renders it, the panel reads it to bound its own
 * input, and one owner means the screen cannot drift from what the route will
 * accept (§2, §4).
 *
 * Asserted here: the boundary itself (at the ceiling passes, one rupee over is
 * refused), that the refusal is the CALLER's mistake with its own wording
 * rather than a 5xx (§21), that it says what to do about it (§14), and that
 * REFUSING WRITES NOTHING — a guard that rejects after the money has moved is
 * not a guard.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { db } from '#db';
import { mountRouter, actor, as } from './_harness.js';
// §9: every balance read goes through the wallet authority, tests included.
import { getBalances } from '../../domains/wallet/walletAuthority.service.js';
import router from '../../routes/retention.routes.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the ceiling on one balance adjustment', () => {
  let app, admin, player;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter(router, { prefix: '/api' });
    admin = await actor({ isAdmin: true });
    player = await actor();
    // Own rows only, and a floor to debit against (trap 10).
    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { maxBalanceAdjustment: 1000000 },
    });
  });
  afterAll(async () => { await closePg(); });

  const adjust = (amount, type = 'CREDIT') => as(app, admin)
    .post('/api/admin/balance-adjust')
    .send({ userId: player.userId, type, field: 'depositBalance', amount, reason: 'ceiling test' });

  const balance = async () => (await getBalances(player.userId)).depositBalance ?? 0;

  it('refuses one rupee over the ceiling, as the caller\'s mistake', async () => {
    const res = await adjust(1000001);
    expect(res.status).toBe(400);              // not 500: a refusal carries its own wording (§21)
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/at most ₹10,00,000/);
  });

  it('tells the operator what to do about it', async () => {
    const res = await adjust(1000001);
    expect(res.body.message).toMatch(/raise the ceiling in System Settings/i);
  });

  it('WRITES NOTHING when it refuses', async () => {
    const before = await balance();
    await adjust(5000000);
    expect(await balance()).toBe(before);
  });

  it('accepts exactly the ceiling', async () => {
    const before = await balance();
    const res = await adjust(1000000);
    expect(res.status).toBe(200);
    expect(await balance()).toBe(before + 1000000);
  });

  it('still accepts an ordinary adjustment, and still refuses zero', async () => {
    expect((await adjust(250)).status).toBe(200);
    const zero = await adjust(0);
    expect(zero.status).toBe(400);
    expect(zero.body.message).toMatch(/positive|All fields required/);
  });

  /**
   * The ceiling is a SETTING, not a constant — so lowering it takes effect on
   * the next adjustment without a deploy. That is the whole reason it is not a
   * literal in the route.
   */
  it('follows the setting when an operator changes it', async () => {
    await db.config.applyConfig({ scope: 'system', actor: 'test', patch: { maxBalanceAdjustment: 1000 } });
    const res = await adjust(5000);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most ₹1,000/);
    await db.config.applyConfig({ scope: 'system', actor: 'test', patch: { maxBalanceAdjustment: 1000000 } });
    expect((await adjust(5000)).status).toBe(200);
  });
});
