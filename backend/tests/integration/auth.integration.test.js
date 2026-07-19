// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import routes from '../../routes.js';
import { User } from '../../models/index.js';

const app = express();
app.use(express.json());
// Mirror the real mount: server.js does app.use('/api/v1/auth', authRoutes) —
// the router's own paths are /register, /login, ... (no /auth prefix inside).
app.use('/api/v1/auth', routes);

describe('Auth API', () => {
  it('should register a new user successfully', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'TestUser',
        mobile: '9876543210',
        password: 'password123'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.username).toBe('TestUser');
    
    const dbUser = await User.findOne({ mobile: '9876543210' });
    expect(dbUser).not.toBeNull();
  });

  it('should not allow duplicate mobile registration', async () => {
    await User.create({
      username: 'Existing',
      mobile: '9999999999',
      passwordHash: 'hashed'
    });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        username: 'NewGuy',
        mobile: '9999999999',
        password: 'password123'
      });

    expect(res.status).toBe(409); // routes.js returns 409 Conflict for a taken mobile
    expect(res.body.success).toBe(false);
  });
});
