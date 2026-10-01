// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A sub-admin works in exactly the areas an admin gave them (owner, 2026-10-01:
 * "the sub admin then can only do the work in those permissioned areas").
 *
 * Against the real database, through the REAL admin router — every route it
 * mounts, read off Express's own route stack rather than listed here, so a
 * route added tomorrow is in this test tomorrow:
 *
 *   - a sub-admin with NO areas is refused by every staff route, read or write,
 *     and a refused write touches nothing (it is refused before the handler);
 *   - a sub-admin holding exactly a GET route's area is NOT refused by it
 *     (the opposite behaviour, §37 step 6 — F-043's lesson: a test of the
 *     refusal alone passed while every legitimate user was locked out);
 *   - the areas that were wrong before this change, by name;
 *   - the grant itself: validated against the one list, absent ≠ empty.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getUser } from '#db/repositories/users.js';
import { mountRouter, actor, as } from './_harness.js';
import { PERMISSION_KEYS, ADMIN_ONLY_AREAS, SELF_ROUTES } from '../../domains/identity/staffPermissions.js';

const describePg = pgConfigured() ? describe : describe.skip;

/** Every route the admin router mounts, with the area its gate asks for. */
function adminRoutes(router) {
  const out = [];
  (function walk(stack) {
    for (const layer of stack) {
      if (layer.route) {
        const handles = layer.route.stack.map((x) => x.handle);
        for (const method of Object.keys(layer.route.methods)) {
          out.push({
            method,
            path: layer.route.path,
            permission: handles.find((h) => h.permission)?.permission ?? null,
            adminOnly: handles.some((h) => h.adminOnly === true),
          });
        }
      } else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  })(router.stack);
  return out;
}
const concrete = (path) => path.replace(/:(\w+)/g, 'no-such-$1');

describePg('staff permissions: every area, every route', () => {
  let app;
  let routes;
  let admin;
  let nobody;

  beforeAll(async () => {
    await applySchema();
    const router = (await import('../../routes/admin/index.js')).default;
    app = mountRouter(router);
    routes = adminRoutes(router);
    admin = await actor({ isAdmin: true });
    nobody = await actor({ isSubAdmin: true, permissions: {} });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  it('reads the real router: every route is an area, an admin-only route, or a self route', () => {
    const adminOnly = new Set(ADMIN_ONLY_AREAS.flatMap((a) => a.routes));
    expect(routes.length).toBeGreaterThan(150);
    for (const r of routes) {
      const key = `${r.method.toUpperCase()} ${r.path}`;
      if (r.adminOnly) expect(adminOnly.has(key), key).toBe(true);
      else if (!r.permission) expect(SELF_ROUTES, key).toContain(key);
      else expect(PERMISSION_KEYS, key).toContain(r.permission);
    }
  });

  it('refuses a sub-admin with no areas on EVERY staff route, reads and writes alike', async () => {
    const staff = routes.filter((r) => r.permission || r.adminOnly);
    const leaks = [];
    for (const r of staff) {
      const res = await as(app, nobody)[r.method](concrete(r.path)).send({});
      if (res.status !== 403) leaks.push(`${r.method.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  }, 120_000);

  it('lets a sub-admin holding exactly a read\'s area through it (the opposite behaviour)', async () => {
    const reads = routes.filter((r) => r.method === 'get' && r.permission);
    const byKey = new Map();
    for (const r of reads) {
      if (!byKey.has(r.permission)) byKey.set(r.permission, await actor({ isSubAdmin: true, permissions: { [r.permission]: true } }));
    }
    const lockedOut = [];
    for (const r of reads) {
      const res = await as(app, byKey.get(r.permission)).get(concrete(r.path));
      if (res.status === 403) lockedOut.push(`GET ${r.path} (${r.permission}) → 403 ${res.body?.message}`);
    }
    expect(lockedOut).toEqual([]);
  }, 120_000);

  it('a key opens ITS area and no other: the merchant manager cannot fund a merchant or edit the FAQ', async () => {
    const merchants = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
    expect((await as(app, merchants).get('/merchants')).status).toBe(200);
    expect((await as(app, merchants).post('/merchants/m-x/fund').send({ amount: 1 })).status).toBe(403);
    const faq = await as(app, merchants).post('/content/faq').send({ question: 'q', answer: 'a' });
    expect(faq.status).toBe(403);
    // The refusal says which area to ask for, in the picker's words.
    expect(faq.body.message).toMatch(/"Content and branding" permission/);
    expect(faq.body.requiredPermission).toBe('canManageContent');
  });

  // ── The specific areas that were wrong before 2026-10-01 ──────────────────
  it('the merchant screen: a sub-admin with canManageMerchants could open it and load nothing (GET /merchants was full-admin only)', async () => {
    const m = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
    expect((await as(app, m).get('/merchants')).status).toBe(200);
  });

  it('chat: the screen asked for canModerateChatPublic, every route asked for canManageSupport', async () => {
    const mod = await actor({ isSubAdmin: true, permissions: { canModerateChat: true } });
    expect((await as(app, mod).get('/chat/messages')).status).toBe(200);
    // Moderating chat is not reading support tickets.
    expect((await as(app, mod).get('/support/tickets')).status).toBe(403);
  });

  it('the settlement rail and the queue pool were open to any sub-admin', async () => {
    const chat = await actor({ isSubAdmin: true, permissions: { canModerateChat: true } });
    expect((await as(app, chat).get('/payment-mode')).status).toBe(403);
    expect((await as(app, chat).get('/queue/merchant-pool')).status).toBe(403);
    expect((await as(app, chat).get('/queue/eligible-merchants')).status).toBe(403);
  });

  it('the queue: a sub-admin holding canManageMerchants was refused inside the handler after the gate let them in', async () => {
    const m = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
    expect((await as(app, m).get('/queue/pending-orders')).status).toBe(200);
  });

  it('a queue manager still works the queue and nothing else', async () => {
    const qm = await actor({ isQueueManager: true });
    expect((await as(app, qm).get('/queue/pending-orders')).status).toBe(200);
    expect((await as(app, qm).get('/merchants')).status).toBe(403);
  });

  // ── The grant ──────────────────────────────────────────────────────────────
  describe('granting', () => {
    let sub;
    beforeAll(async () => {
      sub = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true, canManageUsers: true } });
    });
    const put = (body) => as(app, admin).put(`/sub-admins/${sub.userId}/permissions`).send(body);

    it('serves the whole list to an admin, and to nobody else', async () => {
      const res = await as(app, admin).get('/staff-permissions');
      expect(res.status).toBe(200);
      expect(res.body.permissions.map((p) => p.key)).toEqual([...PERMISSION_KEYS]);
      expect(res.body.groups.length).toBeGreaterThan(0);
      expect(res.body.adminOnly.map((a) => a.area)).toContain('Sub-admins');
      const everything = await actor({ isSubAdmin: true, permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) });
      expect((await as(app, everything).get('/staff-permissions')).status).toBe(403);
      // Holding every area is not holding the right to grant them.
      expect((await as(app, everything).post('/sub-admins').send({})).status).toBe(403);
    });

    it('stores exactly the grant, as every key true or false', async () => {
      const res = await put({ permissions: { canManageMerchants: true } });
      expect(res.status).toBe(200);
      const row = await getUser(sub.userId);
      expect(Object.keys(row.subAdminPermissions).sort()).toEqual([...PERMISSION_KEYS].sort());
      expect(Object.entries(row.subAdminPermissions).filter(([, v]) => v).map(([k]) => k)).toEqual(['canManageMerchants']);
      // And it is what the routes enforce, at once.
      expect((await as(app, sub).get('/merchants')).status).toBe(200);
      expect((await as(app, sub).get('/users')).status).toBe(403);
    });

    it('refuses a body with no `permissions` instead of revoking everything (the panel sent that shape)', async () => {
      await put({ permissions: { canManageMerchants: true } });
      const res = await put({ canManageUsers: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PERMISSIONS_REQUIRED');
      expect((await getUser(sub.userId)).subAdminPermissions.canManageMerchants).toBe(true);
    });

    it('refuses an unknown key by name, and a value that is not a boolean', async () => {
      const unknown = await put({ permissions: { canManageSupport: true } });
      expect(unknown.status).toBe(400);
      expect(unknown.body.message).toMatch(/canManageSupport/);
      const stringy = await put({ permissions: { canManageUsers: 'false' } });
      expect(stringy.status).toBe(400);
      expect((await getUser(sub.userId)).subAdminPermissions.canManageUsers).toBe(false);
    });

    it('revokes everything only when asked to in so many words', async () => {
      expect((await put({ permissions: {} })).status).toBe(200);
      expect(Object.values((await getUser(sub.userId)).subAdminPermissions).some(Boolean)).toBe(false);
    });

    it('creates a sub-admin with the grant, and refuses a bad grant before any account exists', async () => {
      const mobile = `7${String(Date.now()).slice(-9)}`;
      const bad = await as(app, admin).post('/sub-admins').send({
        username: `sa${Date.now()}`, mobile, password: 'Correct-Horse-9-Battery', permissions: { canFly: true },
      });
      expect(bad.status).toBe(400);
      const good = await as(app, admin).post('/sub-admins').send({
        username: `sa${Date.now()}`, mobile, password: 'Correct-Horse-9-Battery', permissions: ['canVerifyKYC', 'canManageGames'],
      });
      expect(good.status, JSON.stringify(good.body)).toBe(200);
      const granted = Object.entries(good.body.subAdmin.subAdminPermissions).filter(([, v]) => v).map(([k]) => k).sort();
      expect(granted).toEqual(['canManageGames', 'canVerifyKYC']);
    });
  });
});
