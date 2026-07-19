// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): the Game Registry — catalogue is DATA.
// Verifies the public catalogue contract (visibility filtering), the seed
// (populates + idempotent), and admin CRUD incl. the no-orphan category guard.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import registryRoutes from '../../domains/gameRegistry/gameRegistry.routes.js';
import { seedGameRegistry } from '../../domains/gameRegistry/gameRegistry.seed.js';
import { Game, GameCategory, User } from '../../models/index.js';

// Mirror the real mount (server.js: app.use('/api/game', gameRegistryRoutes)).
const app = express();
app.use(express.json());
app.use('/api/game', registryRoutes);

async function adminToken() {
  const admin = await User.create({ username: 'GameAdmin', mobile: '9000000001', isAdmin: true });
  return jwt.sign({ userId: admin._id }, process.env.JWT_SECRET);
}

describe('Game Registry', () => {
  beforeEach(async () => {
    await GameCategory.create({ slug: 'crash', name: 'Crash', icon: '🚀', order: 1, enabled: true });
    await GameCategory.create({ slug: 'hidden-cat', name: 'Hidden', icon: '👻', order: 2, enabled: false });
    await Game.create([
      { slug: 'aviator', name: 'Aviator', providerKey: 'spribe', categorySlug: 'crash', externalGameId: 'aviator', status: 'ACTIVE', featured: true, order: 1 },
      { slug: 'jetx',    name: 'JetX',    providerKey: 'smartsoft', categorySlug: 'crash', externalGameId: 'JetX', status: 'MAINTENANCE', order: 2 },
      { slug: 'secret',  name: 'Secret',  providerKey: 'spribe', categorySlug: 'crash', status: 'INACTIVE', order: 3 },
    ]);
  });

  it('public GET /games returns ACTIVE + MAINTENANCE but hides INACTIVE', async () => {
    const res = await request(app).get('/api/game/games');
    expect(res.status).toBe(200);
    const slugs = res.body.games.map(g => g.slug);
    expect(slugs).toContain('aviator');
    expect(slugs).toContain('jetx');        // MAINTENANCE is shown (rendered locked)
    expect(slugs).not.toContain('secret');  // INACTIVE hidden from users
    // featured sorts first
    expect(res.body.games[0].slug).toBe('aviator');
  });

  it('public GET /games filters by category and provider', async () => {
    const byProvider = await request(app).get('/api/game/games?provider=spribe');
    expect(byProvider.body.games.map(g => g.slug).sort()).toEqual(['aviator']); // secret is INACTIVE
    const byCat = await request(app).get('/api/game/games?category=crash');
    expect(byCat.body.games.length).toBe(2);
  });

  it('public GET /categories returns only enabled, with a visible-game count', async () => {
    const res = await request(app).get('/api/game/categories');
    const slugs = res.body.categories.map(c => c.slug);
    expect(slugs).toContain('crash');
    expect(slugs).not.toContain('hidden-cat'); // disabled hidden
    const crash = res.body.categories.find(c => c.slug === 'crash');
    expect(crash.gameCount).toBe(2); // aviator + jetx (not the INACTIVE secret)
  });

  it('admin can create a game and it becomes publicly visible', async () => {
    const token = await adminToken();
    const create = await request(app).post('/api/game/admin/games')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Plinko', providerKey: 'smartsoft', categorySlug: 'crash', externalGameId: 'plinko' });
    expect(create.status).toBe(200);
    expect(create.body.game.slug).toBe('plinko'); // auto-slugged from name

    const pub = await request(app).get('/api/game/games?category=crash');
    expect(pub.body.games.map(g => g.slug)).toContain('plinko');
  });

  it('admin create rejects a duplicate slug', async () => {
    const token = await adminToken();
    const res = await request(app).post('/api/game/admin/games')
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'aviator', name: 'Aviator 2', categorySlug: 'crash' });
    expect(res.status).toBe(409);
  });

  it('admin cannot delete a category that still has games (no orphans)', async () => {
    const token = await adminToken();
    const cat = await GameCategory.findOne({ slug: 'crash' });
    const res = await request(app).delete(`/api/game/admin/categories/${cat._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(await GameCategory.exists({ slug: 'crash' })).toBeTruthy();
  });

  it('requires auth for admin routes', async () => {
    const res = await request(app).post('/api/game/admin/games').send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('seed populates an empty registry and is idempotent', async () => {
    await Game.deleteMany({});
    await GameCategory.deleteMany({});
    await seedGameRegistry();
    const firstGames = await Game.countDocuments();
    const firstCats  = await GameCategory.countDocuments();
    expect(firstGames).toBeGreaterThan(0);
    expect(firstCats).toBeGreaterThan(0);
    // in-house cycle game is part of the seed
    expect(await Game.exists({ slug: 'delhi-bombay', providerKey: '' })).toBeTruthy();
    // Re-seeding must not duplicate.
    await seedGameRegistry();
    expect(await Game.countDocuments()).toBe(firstGames);
    expect(await GameCategory.countDocuments()).toBe(firstCats);
  });
});
