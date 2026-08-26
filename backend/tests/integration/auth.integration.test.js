// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The player password surface is gone — players sign in through Telegram.
 *
 * Two things are pinned here, and the second is the one that matters. Removing
 * `/register` and `/login` does not remove the passwords: legacy player rows
 * still carry a `passwordHash`, and `loginHandler` is still mounted, at
 * /api/admin/login. So the door has to refuse them by ROLE, not merely by being
 * mounted somewhere a player would not think to look.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import routes, { loginHandler } from '../../routes.js';
import { User } from '../../models/index.js';
import { signToken } from '../../domains/identity/jwt.util.js';
import { hashPassword } from '../../domains/identity/password.util.js';

const app = express();
app.use(express.json());
// Mirror the real mount: server.js does app.use('/api/v1/auth', authRoutes).
app.use('/api/v1/auth', routes);
// …and mounts the staff password handler on its own path, outside that router.
app.post('/api/admin/login', loginHandler);

describe('the player password surface no longer exists', () => {
  it('has no /register', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ username: 'TestUser', mobile: '9876543210', password: 'password123' });
    expect(res.status).toBe(404);
    expect(await User.findOne({ mobile: '9876543210' })).toBeNull();
  });

  it('has no /login', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ mobile: '9876543210', password: 'password123' });
    expect(res.status).toBe(404);
  });

  it('still restores a session on /me, which every page load depends on', async () => {
    const user = await User.create({ username: 'Restorable', mobile: '9876500001' });
    const token = signToken({ userId: user._id, mobile: user.mobile, role: 'user' });

    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.mobile).toBe('9876500001');
  });
});

describe('the staff password door refuses players', () => {
  it('refuses a correct password on a non-staff account', async () => {
    // The exact bypass this guards: a legacy player row with a real password,
    // posting to the staff endpoint. None of the per-role checks fire for
    // loginType 'user', so without an explicit staff test this would succeed.
    await User.create({
      username: 'LegacyPlayer', mobile: '9876500002',
      passwordHash: await hashPassword('correct-horse-battery'),
    });

    const res = await request(app).post('/api/admin/login')
      .send({ mobile: '9876500002', password: 'correct-horse-battery', loginType: 'user' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.token).toBeUndefined();
  });

  it('still admits an admin', async () => {
    await User.create({
      username: 'RealAdmin', mobile: '9876500003', isAdmin: true,
      passwordHash: await hashPassword('correct-horse-battery'),
    });

    const res = await request(app).post('/api/admin/login')
      .send({ mobile: '9876500003', password: 'correct-horse-battery', loginType: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeTruthy();
  });

  it('reports a wrong password and a non-staff account differently only after the password check', async () => {
    // A wrong password on ANY account is 401; a right password on a player is
    // 403. That ordering is deliberate — the 403 is only reachable by someone
    // who already knows the password, so the endpoint cannot be used to sort
    // numbers into staff and non-staff.
    const res = await request(app).post('/api/admin/login')
      .send({ mobile: '9876500002', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });
});
