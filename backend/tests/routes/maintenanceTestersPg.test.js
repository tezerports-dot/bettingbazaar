// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Maintenance testers (owner, 2026-10-20): while maintenance mode is on, a
 * player session is refused 503 MAINTENANCE on the player's routes unless the
 * account is a maintenance tester; staff are never refused, and the grant is
 * a player's only. Through the real routers and a real database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { applySystemConfig, getSystemConfig } from '#db/repositories/config.js';
import { getUser } from '#db/repositories/users.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('maintenance mode and its testers', () => {
  let player; let tester; let admin; let userApp; let adminApp; let prior;
  const setMaintenance = (on) => applySystemConfig({ maintenanceMode: on }, { actor: 'maintenance-suite' });

  beforeAll(async () => {
    await applySchema();
    prior = (await getSystemConfig({ fresh: true })).maintenanceMode;
    userApp = mountRouter((await import('../../domains/user/user.routes.js')).default, { prefix: '/api' });
    adminApp = mountRouter((await import('../../routes/admin/users.admin.routes.js')).default);
    player = await actor({});
    tester = await actor({});
    admin = await actor({ isAdmin: true });
  }, 60_000);

  afterAll(async () => {
    await setMaintenance(prior === true);
    await closePg();
  });

  it('an admin makes a player a tester, audited, and it shows in the list', async () => {
    const res = await as(adminApp, admin).put(`/users/${tester.userId}/maintenance-tester`).send({ on: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.maintenanceTester).toBe(true);
    expect((await getUser(tester.userId)).maintenanceTester).toBe(true);
    const list = await as(adminApp, admin).get('/maintenance-testers');
    expect(list.body.testers.map((t) => t.userId)).toContain(tester.userId);
  });

  it('refuses the grant on a staff account, by name', async () => {
    const res = await as(adminApp, admin).put(`/users/${admin.userId}/maintenance-tester`).send({ on: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_A_PLAYER_ACCOUNT');
    expect((await getUser(admin.userId)).maintenanceTester).toBe(false);
  });

  it('refuses a value that is not true or false', async () => {
    const res = await as(adminApp, admin).put(`/users/${player.userId}/maintenance-tester`).send({ on: 'yes' });
    expect(res.status).toBe(400);
  });

  it('with maintenance off, every player passes', async () => {
    await setMaintenance(false);
    const res = await as(userApp, player).get('/api/user/maintenance-pass');
    expect(res.status).toBe(200);
    expect(res.body.tester).toBe(false);
  });

  it('with maintenance on, a player is refused 503 MAINTENANCE on their routes and a tester is not', async () => {
    await setMaintenance(true);
    const refused = await as(userApp, player).get('/api/user/maintenance-pass');
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe('MAINTENANCE');
    const elsewhere = await as(userApp, player).get('/api/user/notifications');
    expect(elsewhere.status).toBe(503);

    const passes = await as(userApp, tester).get('/api/user/maintenance-pass');
    expect(passes.status).toBe(200);
    expect(passes.body.tester).toBe(true);
    const works = await as(userApp, tester).get('/api/user/notifications');
    expect(works.status).not.toBe(503);
  });

  it('staff keep working while maintenance is on', async () => {
    await setMaintenance(true);
    const res = await as(adminApp, admin).get('/maintenance-testers');
    expect(res.status).toBe(200);
  });

  it('switching a tester off sends them to the maintenance screen too', async () => {
    await setMaintenance(true);
    await as(adminApp, admin).put(`/users/${tester.userId}/maintenance-tester`).send({ on: false });
    const res = await as(userApp, tester).get('/api/user/maintenance-pass');
    expect(res.status).toBe(503);
  });

  it('the database refuses the flag on a staff row', async () => {
    const { updateUser } = await import('#db/repositories/users.js');
    await expect(updateUser(admin.userId, { maintenance_tester: true })).rejects.toMatchObject({ constraint: 'users_maintenance_tester_player' });
  });
});
