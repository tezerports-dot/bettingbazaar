// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The SECOND leg of a login, at all three doors, through the real routers and
 * a real database.
 *
 * Route coverage (`npm run report:routes`, 2026-10-01) recorded
 * `POST /api/admin/login/2fa`, `POST /api/v1/auth/login/2fa` and
 * `POST /api/merchant/auth/login/2fa` as reached by NOTHING — no unit, pg, e2e
 * or browser request. 2FA is mandatory for staff and required for merchants,
 * so this is the step that completes every staff and merchant sign-in, and the
 * only tests near it proved the challenge TOKEN in isolation.
 *
 * Each case uses its own account: the second leg is paced to one attempt per
 * ten seconds per account (`loginPace`), on purpose.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { newUserId } from '#db/repositories/users.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import { generateSecret, generateToken, encryptSecret } from '../../domains/identity/totp.service.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const PASSWORD = 'Second-Factor-Pass-7q!';

describePg('the second leg of a login', () => {
  let app;

  beforeAll(async () => {
    await applySchema();
    const { loginHandler, loginTwoFactorHandler } = await import('../../routes.js');
    const { loginPaceLimiter, twoFactorLimiter } = await import('../../middleware/security.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // The staff door as server.js mounts it, less the captcha and subnet tiers
    // (separate concerns, separately tested).
    app.post('/api/admin/login', loginPaceLimiter, loginHandler);
    app.post('/api/admin/login/2fa', loginPaceLimiter, twoFactorLimiter, loginTwoFactorHandler);
    app.use('/api/v1/auth', (await import('../../domains/identity/playerAuth.routes.js')).default);
    app.use('/api/merchant', (await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A USERS-table account (staff or player) with a password and an enrolled authenticator. */
  const enrolledUser = async (kind) => {
    const who = await actor(kind === 'staff' ? { isAdmin: true } : {});
    const secret = generateSecret();
    await db.users.updateUser(who.userId, { passwordHash: await hashPassword(PASSWORD) });
    await pgQuery(
      `UPDATE users SET two_factor_enabled = TRUE, two_factor_secret = $2, two_factor_last_counter = NULL
        WHERE user_id = $1`, [who.userId, encryptSecret(secret)]);
    return { ...who, secret };
  };

  const enrolledMerchant = async () => {
    const mobile = `7${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
    const created = await createMerchantAccount({
      userId: newUserId(), username: `m2f${Date.now()}${Math.floor(Math.random() * 1000)}`, mobile,
      passwordHash: await hashPassword(PASSWORD), currency: 'INR',
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const secret = generateSecret();
    await pgQuery(
      `UPDATE merchants SET status = 'ACTIVE', merchant_approval_status = 'APPROVED',
              two_factor_enabled = TRUE, two_factor_secret = $2
        WHERE merchant_id = $1`, [created.merchant.merchantId, encryptSecret(secret)]);
    return { merchantId: created.merchant.merchantId, mobile, secret };
  };

  // ── Staff ───────────────────────────────────────────────────────────────
  it('STAFF: a correct code turns the challenge into a session', async () => {
    const admin = await enrolledUser('staff');
    const first = await request(app).post('/api/admin/login').send({ mobile: admin.mobile, password: PASSWORD });
    expect(first.status, first.body?.message).toBe(200);
    expect(first.body.twoFactorRequired).toBe(true);
    expect(first.body.token, 'a session was issued before the second factor').toBeUndefined();

    const second = await request(app).post('/api/admin/login/2fa')
      .send({ challengeToken: first.body.challengeToken, code: generateToken(admin.secret) });
    expect(second.status, second.body?.message).toBe(200);
    expect(second.body.token, 'the second leg issued no session').toBeTruthy();
  });

  it('STAFF: a wrong code is refused and issues nothing (the opposite case)', async () => {
    const admin = await enrolledUser('staff');
    const first = await request(app).post('/api/admin/login').send({ mobile: admin.mobile, password: PASSWORD });
    const wrong = String((Number(generateToken(admin.secret)) + 1) % 1_000_000).padStart(6, '0');
    const second = await request(app).post('/api/admin/login/2fa')
      .send({ challengeToken: first.body.challengeToken, code: wrong });
    expect(second.status).toBe(401);
    expect(second.body.token).toBeUndefined();
    expect(second.body.message).toBe('Invalid authentication code');
  });

  // ── Player ──────────────────────────────────────────────────────────────
  it('PLAYER: an enrolled player completes the second leg at the player door', async () => {
    const player = await enrolledUser('player');
    const first = await request(app).post('/api/v1/auth/login').send({ mobile: player.mobile, password: PASSWORD });
    expect(first.status, first.body?.message).toBe(200);
    expect(first.body.twoFactorRequired).toBe(true);
    const second = await request(app).post('/api/v1/auth/login/2fa')
      .send({ challengeToken: first.body.challengeToken, code: generateToken(player.secret) });
    expect(second.status, second.body?.message).toBe(200);
    expect(second.body.token).toBeTruthy();
  });

  it('a PLAYER\'s challenge cannot be redeemed at the STAFF door, even with the right code', async () => {
    const player = await enrolledUser('player');
    const first = await request(app).post('/api/v1/auth/login').send({ mobile: player.mobile, password: PASSWORD });
    expect(first.body.twoFactorRequired).toBe(true);
    const crossed = await request(app).post('/api/admin/login/2fa')
      .send({ challengeToken: first.body.challengeToken, code: generateToken(player.secret) });
    expect(crossed.status).toBe(403);
    expect(crossed.body.token).toBeUndefined();
  });

  // ── Merchant ────────────────────────────────────────────────────────────
  it('MERCHANT: a correct code turns the challenge into a merchant session', async () => {
    const m = await enrolledMerchant();
    const first = await request(app).post('/api/merchant/auth/login').send({ mobile: m.mobile, password: PASSWORD });
    expect(first.status, first.body?.message).toBe(200);
    expect(first.body.twoFactorRequired).toBe(true);
    expect(first.body.token).toBeUndefined();
    const second = await request(app).post('/api/merchant/auth/login/2fa')
      .send({ challengeToken: first.body.challengeToken, code: generateToken(m.secret) });
    expect(second.status, second.body?.message).toBe(200);
    expect(second.body.token).toBeTruthy();
  });

  it('MERCHANT: a wrong code is refused and issues nothing', async () => {
    const m = await enrolledMerchant();
    const first = await request(app).post('/api/merchant/auth/login').send({ mobile: m.mobile, password: PASSWORD });
    const wrong = String((Number(generateToken(m.secret)) + 1) % 1_000_000).padStart(6, '0');
    const second = await request(app).post('/api/merchant/auth/login/2fa')
      .send({ challengeToken: first.body.challengeToken, code: wrong });
    expect(second.status).toBe(401);
    expect(second.body.token).toBeUndefined();
  });

  it('a STAFF challenge cannot be redeemed at the MERCHANT door', async () => {
    const admin = await enrolledUser('staff');
    const first = await request(app).post('/api/admin/login').send({ mobile: admin.mobile, password: PASSWORD });
    const crossed = await request(app).post('/api/merchant/auth/login/2fa')
      .send({ challengeToken: first.body.challengeToken, code: generateToken(admin.secret) });
    expect(crossed.status).toBe(401);
    expect(crossed.body.token).toBeUndefined();
  });
});
