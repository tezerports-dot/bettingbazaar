// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Sub-admin management, over HTTP against a real database.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Three of these four handlers were DEAD until this migration: two called
 * `.save()` on a plain object the repository returned, and the create passed no
 * id to a table whose primary key is one. Every request to them was a 500, and
 * nothing caught it, because nothing exercised the route.
 *
 * These are also the handlers that hand out authority. A sub-admin can see
 * accounts and act on them, so "who is a sub-admin" is a security answer, not a
 * CRUD one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getUser, getUserCredentials } from '#db/repositories/users.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('sub-admin routes', () => {
  let app; let admin;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../routes/admin/subadmins.admin.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const uniqueMobile = () => `9${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`;

  it('refuses all four without a token', async () => {
    expect((await request(app).get('/sub-admins')).status).toBe(401);
    expect((await request(app).post('/sub-admins').send({})).status).toBe(401);
    expect((await request(app).put('/sub-admins/x/permissions').send({})).status).toBe(401);
    expect((await request(app).delete('/sub-admins/x')).status).toBe(401);
  });

  it('creates a sub-admin that actually exists afterwards', async () => {
    // The create used to pass no user id. The row could never be written, so
    // this returned 500 every time.
    const mobile = uniqueMobile();
    const res = await as(app, admin).post('/sub-admins').send({
      username: 'Sub One', mobile, password: 'a-long-enough-password-123',
      permissions: { canVerifyKYC: true },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);

    const created = await getUser(res.body.subAdmin.userId);
    expect(created.isSubAdmin).toBe(true);
    expect(created.roles).toContain('subadmin');
    expect(created.subAdminPermissions).toMatchObject({ canVerifyKYC: true });
  });

  it('never returns the password it was given', async () => {
    const res = await as(app, admin).post('/sub-admins').send({
      username: 'Sub Two', mobile: uniqueMobile(), password: 'another-long-password-456',
    });
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('another-long-password-456');
    expect(body).not.toMatch(/passwordHash|password_hash/);
  });

  it('stores the password as a hash, not as itself', async () => {
    const password = 'yet-another-long-password-789';
    const res = await as(app, admin).post('/sub-admins')
      .send({ username: 'Sub Three', mobile: uniqueMobile(), password });
    const creds = await getUserCredentials(res.body.subAdmin.userId);
    expect(creds.passwordHash).toBeTruthy();
    expect(creds.passwordHash).not.toBe(password);
    expect(creds.passwordHash).toMatch(/^\$argon2/);
  });

  it('refuses a mobile that is already registered', async () => {
    const mobile = uniqueMobile();
    const first = await as(app, admin).post('/sub-admins')
      .send({ username: 'Dup A', mobile, password: 'a-long-enough-password-123' });
    expect(first.status).toBe(200);

    // The duplicate is caught by the mobile's UNIQUE constraint inside the
    // insert, not by a read-then-write a concurrent create fits between.
    const second = await as(app, admin).post('/sub-admins')
      .send({ username: 'Dup B', mobile, password: 'a-long-enough-password-123' });
    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/already exists/i);
  });

  it('requires a mobile and a password', async () => {
    for (const body of [{ username: 'x' }, { username: 'x', mobile: uniqueMobile() }]) {
      const res = await as(app, admin).post('/sub-admins').send(body);
      expect(res.status).toBe(400);
    }
  });

  it('updates permissions — the handler that used to throw on .save()', async () => {
    const created = await as(app, admin).post('/sub-admins').send({
      username: 'Perms', mobile: uniqueMobile(), password: 'a-long-enough-password-123',
      permissions: { canVerifyKYC: true },
    });
    const id = created.body.subAdmin.userId;

    const res = await as(app, admin).put(`/sub-admins/${id}/permissions`)
      .send({ permissions: { canVerifyKYC: false, canManageOrders: true } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await getUser(id);
    expect(after.subAdminPermissions).toMatchObject({ canVerifyKYC: false, canManageOrders: true });
  });

  it('normalises permissions to booleans', async () => {
    const created = await as(app, admin).post('/sub-admins').send({
      username: 'Norm', mobile: uniqueMobile(), password: 'a-long-enough-password-123',
    });
    const id = created.body.subAdmin.userId;

    // A permission stored as the STRING "false" is truthy everywhere it is
    // read, which turns a revoked capability back on.
    await as(app, admin).put(`/sub-admins/${id}/permissions`)
      .send({ permissions: { canVerifyKYC: 'false', canManageOrders: 1 } });

    const after = await getUser(id);
    expect(after.subAdminPermissions.canVerifyKYC).toBe(true);   // "false" is a non-empty string
    expect(after.subAdminPermissions.canManageOrders).toBe(true);
    expect(typeof after.subAdminPermissions.canVerifyKYC).toBe('boolean');
  });

  it('removes the ROLE but keeps the account — the other .save() handler', async () => {
    const created = await as(app, admin).post('/sub-admins').send({
      username: 'Gone', mobile: uniqueMobile(), password: 'a-long-enough-password-123',
    });
    const id = created.body.subAdmin.userId;

    const res = await as(app, admin).delete(`/sub-admins/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Both the flag AND the role, because both are read as authority. Clearing
    // one and not the other leaves a half-revoked account.
    const after = await getUser(id);
    expect(after).toBeTruthy();                 // the ACCOUNT survives
    expect(after.isSubAdmin).toBe(false);
    expect(after.roles).not.toContain('subadmin');
    expect(after.subAdminPermissions).toEqual({});
  });

  it('404s a sub-admin that is not one, rather than acting on it', async () => {
    const plain = await actor({});
    expect((await as(app, admin).put(`/sub-admins/${plain.userId}/permissions`).send({ permissions: {} })).status).toBe(404);
    expect((await as(app, admin).delete(`/sub-admins/${plain.userId}`)).status).toBe(404);
    expect((await as(app, admin).delete('/sub-admins/not-a-user')).status).toBe(404);
  });

  it('lists sub-admins without leaking a credential', async () => {
    await as(app, admin).post('/sub-admins').send({
      username: 'Listed', mobile: uniqueMobile(), password: 'a-long-enough-password-123',
    });
    const res = await as(app, admin).get('/sub-admins');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.subAdmins)).toBe(true);
    expect(res.body.subAdmins.length).toBeGreaterThan(0);

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/passwordHash|password_hash/);
    expect(body).not.toMatch(/twoFactorSecret|two_factor_secret/);
    expect(body).not.toMatch(/backupCodes|backup_codes/);
  });
});
