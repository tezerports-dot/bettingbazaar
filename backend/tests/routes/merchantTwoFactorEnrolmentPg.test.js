// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant enrols an authenticator: setup, then activate.
 *
 * Route coverage (`npm run report:routes`, 2026-10-01) recorded
 * `POST /api/merchant/2fa/setup` and `/2fa/activate` as reached by NOTHING in
 * any tier, while the merchant panel tells every merchant two-factor is
 * "Required for every merchant account". These are the only way to meet that
 * requirement, and there is deliberately no disable route — so a defect here
 * would have no workaround on the panel at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import router from '../../domains/merchant/merchant.routes.js';
import { generateToken } from '../../domains/identity/totp.service.js';
import { mountRouter, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('merchant two-factor enrolment', () => {
  let app;
  beforeAll(async () => { await applySchema(); app = mountRouter(router); }, 60_000);
  afterAll(async () => { await closePg(); });

  const row = async (merchantId) => (await pgQuery(
    `SELECT two_factor_enabled, two_factor_secret IS NOT NULL AS live,
            two_factor_pending_secret IS NOT NULL AS pending, two_factor_last_counter,
            COALESCE(array_length(backup_codes, 1), 0) AS codes
       FROM merchants WHERE merchant_id = $1`, [merchantId])).rows[0];

  it('setup gives a secret that is PENDING, and activation makes it live and spends the code', async () => {
    const m = await merchantActor({});
    const setup = await as(app, m).post('/2fa/setup').send({});
    expect(setup.status, setup.body?.message).toBe(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const afterSetup = await row(m.merchantId);
    expect(afterSetup.pending, 'the secret was not held as pending').toBe(true);
    expect(afterSetup.two_factor_enabled, 'setup alone switched 2FA on').toBe(false);

    const activate = await as(app, m).post('/2fa/activate').send({ code: generateToken(setup.body.secret) });
    expect(activate.status, activate.body?.message).toBe(200);
    expect(activate.body.backupCodes.length).toBeGreaterThan(0);
    const after = await row(m.merchantId);
    expect(after.two_factor_enabled).toBe(true);
    expect(after.live).toBe(true);
    expect(after.pending, 'the pending secret was left behind').toBe(false);
    expect(after.two_factor_last_counter, 'the activation code was not spent').not.toBeNull();
    // Only hashes are stored, one per code shown.
    expect(after.codes).toBe(activate.body.backupCodes.length);
  });

  it('a wrong code does not activate, and leaves the secret pending (the opposite case)', async () => {
    const m = await merchantActor({});
    const setup = await as(app, m).post('/2fa/setup').send({});
    const wrong = String((Number(generateToken(setup.body.secret)) + 1) % 1_000_000).padStart(6, '0');
    const res = await as(app, m).post('/2fa/activate').send({ code: wrong });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/did not match/);
    const after = await row(m.merchantId);
    expect(after.two_factor_enabled).toBe(false);
    expect(after.pending).toBe(true);
  });

  it('activate before setup says to start setup first', async () => {
    const m = await merchantActor({});
    const res = await as(app, m).post('/2fa/activate').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Start setup first/);
  });

  it('setup refuses a merchant who is already enrolled, so a live secret cannot be swapped', async () => {
    const m = await merchantActor({});
    const setup = await as(app, m).post('/2fa/setup').send({});
    expect((await as(app, m).post('/2fa/activate').send({ code: generateToken(setup.body.secret) })).status).toBe(200);
    const again = await as(app, m).post('/2fa/setup').send({});
    expect(again.status).toBe(400);
    // It names steps that exist: there is no merchant disable route.
    expect(again.body.message).not.toMatch(/Disable it first/);
    expect(again.body.message).toMatch(/recovery code|admin/);
    expect((await row(m.merchantId)).two_factor_enabled).toBe(true);
  });
});
