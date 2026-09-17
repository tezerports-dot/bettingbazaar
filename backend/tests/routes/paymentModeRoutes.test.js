// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The switch an admin presses, and what a merchant is told.
 *
 * ── Why the merchant read is tested as hard as the switch ───────────────────
 * Switching the rail changes the workflow every merchant performs. The news
 * reaches them three ways — a notification row, an SSE broadcast, and this
 * read — and only the read is guaranteed: a merchant with no linked player
 * account has no inbox, and a dropped socket misses the broadcast. If the read
 * is wrong, a merchant runs yesterday's workflow and a player waits for a
 * payment nobody is sending.
 *
 * ── What the projection must NOT carry ──────────────────────────────────────
 * The policy row names who switched the rail and why. A merchant is held to the
 * timers; the authorship is an admin surface. Asserted here rather than trusted,
 * because the merchant-facing leak in this codebase came from exactly this
 * shape — a payload assembled by spreading a row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import {
  PAYMENT_MODES, getActivePolicy, publishPolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
import { createMerchant, newMerchantId, generateMerchantPublicRef } from '#db/repositories/merchants.js';
import { listNotifications } from '#db/repositories/engagement.js';
import { mountRouter, actor, merchantActor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the settlement rail, through the routes that move it', () => {
  let adminApp;
  let merchantApp;
  let restore = null;

  beforeAll(async () => {
    await applySchema();
    adminApp = mountRouter((await import('../../routes/admin/index.js')).default);
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    restore = await getActivePolicy();
  }, 60_000);

  afterAll(async () => {
    const now = await getActivePolicy();
    if (restore && now?.activeMode !== restore.activeMode) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        justification: 'Restoring the rail this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    await closePg();
  });

  it('reads the rail and the rails available, with the copy a merchant will be sent', async () => {
    const admin = await actor({ isAdmin: true });
    const res = await as(adminApp, admin).get('/payment-mode');

    expect(res.status).toBe(200);
    expect(res.body.policy.activeMode).toBeTruthy();
    // The panel renders these; a hardcoded copy in the panel is a copy that
    // drifts from what the merchant is actually told.
    expect(res.body.modes.map((m) => m.mode).sort())
      .toEqual([PAYMENT_MODES.CASH_ATM, PAYMENT_MODES.P2P_UPI].sort());
    for (const m of res.body.modes) {
      expect(m.label).toBeTruthy();
      expect(m.merchantMessage).toBeTruthy();
    }
  });

  it('switches the rail, records who did it, and tells every merchant', async () => {
    const admin = await actor({ isAdmin: true });
    const merchant = await merchantActor({});
    const before = await getActivePolicy();
    const target = before.activeMode === PAYMENT_MODES.CASH_ATM
      ? PAYMENT_MODES.P2P_UPI : PAYMENT_MODES.CASH_ATM;

    const res = await as(adminApp, admin).post('/payment-mode').send({
      activeMode: target,
      justification: 'Moving the platform for the route test.',
    });
    expect(res.status).toBe(200);
    expect(res.body.policy.activeMode).toBe(target);
    expect(res.body.policy.changedBy).toBe(admin.userId);
    expect(res.body.previous.activeMode).toBe(before.activeMode);

    // And the merchant, asking independently, is told the same thing.
    const seen = await as(merchantApp, merchant).get('/payment-mode');
    expect(seen.status).toBe(200);
    expect(seen.body.activeMode).toBe(target);
    expect(seen.body.merchantMessage).toBeTruthy();
    expect(seen.body.timers.processingWindowSeconds).toBeGreaterThan(0);
  });

  it('never tells a merchant who switched the rail or why', async () => {
    const merchant = await merchantActor({});
    const res = await as(merchantApp, merchant).get('/payment-mode');
    expect(res.status).toBe(200);

    // The merchant is held to the timers. The authorship is an admin surface,
    // and a payload built by spreading the policy row would carry it.
    expect(res.body.changedBy).toBeUndefined();
    expect(res.body.changedByName).toBeUndefined();
    expect(res.body.justification).toBeUndefined();
    expect(res.body.status).toBeUndefined();
  });

  it('refuses the switch to a sub-admin, and to no token at all', async () => {
    const subAdmin = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
    const before = await getActivePolicy();

    // Reading the rail is operational; changing it is not.
    const read = await as(adminApp, subAdmin).get('/payment-mode');
    expect(read.status).toBe(200);

    const write = await as(adminApp, subAdmin).post('/payment-mode')
      .send({ activeMode: PAYMENT_MODES.CASH_ATM, justification: 'Sub-admin tries to switch.' });
    expect(write.status).toBe(403);

    const anon = await request(adminApp).post('/payment-mode')
      .send({ activeMode: PAYMENT_MODES.CASH_ATM, justification: 'No token at all.' });
    expect([401, 403]).toContain(anon.status);

    // A refusal moves NOTHING.
    const after = await getActivePolicy();
    expect(after.version).toBe(before.version);
    expect(after.activeMode).toBe(before.activeMode);
  });

  it('answers a bad change with the reason, not a 500', async () => {
    const admin = await actor({ isAdmin: true });

    const noReason = await as(adminApp, admin).post('/payment-mode')
      .send({ activeMode: PAYMENT_MODES.CASH_ATM, justification: '  ' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.reason).toBe('JUSTIFICATION_REQUIRED');

    const zero = await as(adminApp, admin).post('/payment-mode')
      .send({ timers: { utrSubmitSeconds: 0 }, justification: 'No cap on the UTR.' });
    expect(zero.status).toBe(400);
    expect(zero.body.reason).toBe('TIMER_NOT_POSITIVE');
    // The message has to be actionable: "that timer is zero", not "bad request".
    expect(zero.body.message).toMatch(/positive/i);

    const empty = await as(adminApp, admin).post('/payment-mode').send({ justification: 'Nothing at all.' });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toMatch(/nothing to change/i);
  });

  it('refuses a merchant read without a merchant token', async () => {
    const res = await request(merchantApp).get('/payment-mode');
    expect([401, 403]).toContain(res.status);
  });

  it('notifies merchants when the RAIL changes, and does not when only a timer does', async () => {
    const admin = await actor({ isAdmin: true });

    // A merchant with a linked player account — the only kind that has an
    // inbox. `merchants.user_id` is nullable, which is exactly why the panel
    // read exists as well.
    const operator = await actor({});
    const merchantId = newMerchantId();
    await createMerchant({
      merchantId, userId: operator.userId, name: 'Notified Merchant',
      publicRef: generateMerchantPublicRef(), status: 'ACTIVE',
    });

    const before = await getActivePolicy();
    const target = before.activeMode === PAYMENT_MODES.CASH_ATM
      ? PAYMENT_MODES.P2P_UPI : PAYMENT_MODES.CASH_ATM;

    const startCount = (await listNotifications(operator.userId, { limit: 50 })).length;

    await as(adminApp, admin).post('/payment-mode')
      .send({ activeMode: target, justification: 'Switching, and the merchants must be told.' });

    const afterSwitch = await listNotifications(operator.userId, { limit: 50 });
    expect(afterSwitch.length).toBe(startCount + 1);
    const note = afterSwitch[0];
    expect(note.relatedType).toBe('PaymentModePolicy');
    // It has to say what the merchant now DOES, not merely that something moved.
    expect(note.message.length).toBeGreaterThan(20);
    // And it has to answer the question every merchant asks next.
    expect(note.message).toMatch(/already.*created under|keep the process/i);

    // A timer edit does not change what a merchant does, so it does not
    // interrupt every merchant on the platform.
    await as(adminApp, admin).post('/payment-mode')
      .send({ timers: { processingWindowSeconds: 842 }, justification: 'Tuning only.' });

    const afterTimer = await listNotifications(operator.userId, { limit: 50 });
    expect(afterTimer.length).toBe(afterSwitch.length);
  });

  it('lists the version history newest first', async () => {
    const admin = await actor({ isAdmin: true });
    const res = await as(adminApp, admin).get('/payment-mode/history?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.history.length).toBeGreaterThan(0);

    const versions = res.body.history.map((h) => h.version);
    expect([...versions].sort((a, b) => b - a)).toEqual(versions);
    // Exactly one ACTIVE, however long the history is.
    expect(res.body.history.filter((h) => h.status === 'ACTIVE').length).toBe(1);
  });
});
