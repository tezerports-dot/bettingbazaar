// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Two-factor enrolment, over HTTP against a real database.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Every handler here was DEAD. They read the account through the repository —
 * which deliberately omits the credential columns — and then called `.save()`
 * on the plain object they got back. `/status` reported zero recovery codes for
 * everyone, and setup, activate and disable all threw.
 *
 * None of that was visible to a unit test, because a mocked account object has
 * whatever method the handler reaches for. It is visible here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getUserCredentials, updateUser } from '#db/repositories/users.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('two-factor routes', () => {
  let app;
  let totp;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/identity/twoFactor.routes.js');
    app = mountRouter(mod.default);
    totp = await import('../../domains/identity/totp.service.js');
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** Enrol an account the whole way, returning its recovery codes. */
  async function enrol(who) {
    const setup = await as(app, who).post('/setup').send({});
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);

    // The secret is handed back once, for the "cannot scan the QR" path.
    const secret = setup.body.secret;
    expect(secret).toBeTruthy();

    const otp = totp.generateToken(secret, Date.now());
    const activated = await as(app, who).post('/activate').send({ otp });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    return { secret, backupCodes: activated.body.backupCodes };
  }

  it('refuses without a token', async () => {
    expect((await request(app).get('/status')).status).toBe(401);
    expect((await request(app).post('/setup').send({})).status).toBe(401);
  });

  it('reports 2FA off for a fresh account', async () => {
    const who = await actor({});
    const res = await as(app, who).get('/status');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.backupCodesRemaining).toBe(0);
  });

  it('mints a PENDING secret that does not yet guard the account', async () => {
    const who = await actor({});
    const res = await as(app, who).post('/setup').send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.otpauthUri).toMatch(/^otpauth:\/\//);

    // PENDING, not live. If setup enabled 2FA immediately, closing the tab
    // before scanning would lock the account out of a code nobody can generate.
    const creds = await getUserCredentials(who.userId);
    expect(creds.twoFactorPendingSecret).toBeTruthy();
    expect(creds.twoFactorEnabled).toBe(false);
    expect(creds.twoFactorSecret).toBeFalsy();
  });

  it('refuses to activate without a setup first', async () => {
    const who = await actor({});
    const res = await as(app, who).post('/activate').send({ otp: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('2FA_NO_PENDING_SETUP');
  });

  it('refuses to activate on a wrong code, leaving 2FA off', async () => {
    const who = await actor({});
    await as(app, who).post('/setup').send({});
    const res = await as(app, who).post('/activate').send({ otp: '000000' });
    expect(res.status).toBe(400);
    expect((await getUserCredentials(who.userId)).twoFactorEnabled).toBe(false);
  });

  it('activates on a real code, and issues recovery codes ONCE', async () => {
    const who = await actor({});
    const { backupCodes } = await enrol(who);

    expect(Array.isArray(backupCodes)).toBe(true);
    expect(backupCodes.length).toBeGreaterThan(0);

    const creds = await getUserCredentials(who.userId);
    expect(creds.twoFactorEnabled).toBe(true);
    expect(creds.twoFactorSecret).toBeTruthy();
    // The pending secret is cleared in the SAME update that makes it live, so
    // the account is never found holding two.
    expect(creds.twoFactorPendingSecret).toBeFalsy();
    // Stored as HASHES. A dump must not yield a usable recovery code.
    expect(creds.backupCodes.length).toBe(backupCodes.length);
    for (const plain of backupCodes) expect(creds.backupCodes).not.toContain(plain);
    // And the activation code is spent, so it cannot be replayed to log in.
    expect(creds.twoFactorLastCounter).toBeGreaterThan(0);
  });

  it('counts the recovery codes it actually holds — this reported 0 for everyone', async () => {
    const who = await actor({});
    const { backupCodes } = await enrol(who);
    const res = await as(app, who).get('/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    // The count used to come off the account record, where the column is
    // absent, so every enrolled user was told they had none left.
    expect(res.body.backupCodesRemaining).toBe(backupCodes.length);
  });

  it('refuses to re-enrol while 2FA is already active', async () => {
    const who = await actor({});
    await enrol(who);
    const res = await as(app, who).post('/setup').send({});
    // Silently re-enrolling would invalidate the authenticator the account is
    // currently protected by.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('2FA_ALREADY_ENABLED');
  });

  it('refuses to disable without a current code', async () => {
    const who = await actor({});
    await enrol(who);
    const res = await as(app, who).post('/disable').send({ otp: '000000' });
    expect(res.status).toBe(400);
    expect((await getUserCredentials(who.userId)).twoFactorEnabled).toBe(true);
  });

  it('disables with a current code, clearing every trace in one update', async () => {
    const who = await actor({});
    const { secret } = await enrol(who);

    // The replay guard refuses any counter at or below the one activation
    // spent, so a real user disabling 2FA does it with a LATER code — i.e.
    // after at least one 30-second step has passed.
    //
    // Waiting 30 seconds in a test is not an option, and generating a code for
    // a future step is not either: the verifier checks the code against the
    // real clock and accepts only ±1 step of drift, so a code far enough ahead
    // to beat the guard is too far ahead to verify. Rolling the stored counter
    // back by one is exactly equivalent to that wait, and is deterministic —
    // it does not depend on where in a step the test happens to run.
    const spent = (await getUserCredentials(who.userId)).twoFactorLastCounter;
    await updateUser(who.userId, { twoFactorLastCounter: spent - 1 });

    const res = await as(app, who).post('/disable').send({ otp: totp.generateToken(secret, Date.now()) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const creds = await getUserCredentials(who.userId);
    expect(creds.twoFactorEnabled).toBe(false);
    // An account readable as "2FA off" while its secret is still on file is a
    // half-disabled account.
    expect(creds.twoFactorSecret).toBeFalsy();
    expect(creds.twoFactorPendingSecret).toBeFalsy();
    expect(creds.backupCodes).toEqual([]);
  });

  it('refuses to disable at all for a role where 2FA is mandatory', async () => {
    const boss = await actor({ isAdmin: true, roles: ['admin'] });
    await enrol(boss);
    const res = await as(app, boss).post('/disable').send({ otp: '123456' });
    // An admin who can switch off their own second factor does not have one in
    // any meaningful sense.
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('2FA_MANDATORY');
    expect((await getUserCredentials(boss.userId)).twoFactorEnabled).toBe(true);
  });

  it('reports 2FA as mandatory for an admin and optional for a player', async () => {
    const boss = await actor({ isAdmin: true, roles: ['admin'] });
    const player = await actor({});
    expect((await as(app, boss).get('/status')).body.mandatory).toBe(true);
    expect((await as(app, player).get('/status')).body.mandatory).toBe(false);
  });
});
