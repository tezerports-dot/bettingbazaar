// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant who resets their password through the merchant bot can sign in
 * with the NEW password, not the old one, and every session they had is gone.
 *
 * ── What it did before (R6, 2026-09-30) ────────────────────────────────────
 * A merchant's password was stored TWICE: `users.password_hash` on the login
 * row a merchant signup writes, and `merchants.password_hash`. The reset wrote
 * the first; the merchant login door read the second. So a merchant who reset
 * through the bot was told "Your password has been changed. Sign in with it
 * now." — and the door still accepted only the OLD password, while the new one
 * was refused as invalid. And `merchantAuth` checked no session cutoff, so the
 * sessions the reset was meant to evict stayed alive.
 *
 * Driven through the real routes: the reset redemption the panel posts to,
 * the merchant login, and a merchantAuth-protected read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { newUserId } from '#db/repositories/users.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import { signToken } from '../../domains/identity/paseto.util.js';
import { startResetFromMiniApp } from '../../domains/identity/passwordReset.service.js';
import { linkTelegram, saveTestBot, removeTestBot } from '../miniAppFixture.js';

const describePg = pgConfigured() ? describe : describe.skip;

const OLD = 'Old-Merchant-Pass-9x!';
const NEW = 'New-Merchant-Pass-7q!';

describePg('a merchant password reset', () => {
  let app;
  let merchantId;
  let userId;
  let mobile;

  beforeAll(async () => {
    await applySchema();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/auth', (await import('../../domains/identity/playerAuth.routes.js')).default);
    app.use('/merchant', (await import('../../domains/merchant/merchant.routes.js')).default);
    const { initSSERoutes } = await import('../../routes/sse.routes.js');
    app.use('/sse', initSSERoutes({ addMerchantClient: () => {} }, {}));

    mobile = `8${String(Date.now()).slice(-9)}`;
    const created = await createMerchantAccount({
      userId: newUserId(), username: `rtm${Date.now()}`, mobile,
      passwordHash: await hashPassword(OLD), currency: 'INR',
    });
    expect(created.ok).toBe(true);
    merchantId = created.merchant.merchantId;
    userId = created.userId;
    await pgQuery(
      `UPDATE merchants SET status='ACTIVE', merchant_approval_status='APPROVED' WHERE merchant_id = $1`,
      [merchantId]);
    await linkTelegram(userId, { telegramUserId: `77${String(Date.now()).slice(-8)}` });
    await saveTestBot();
  }, 60_000);

  afterAll(async () => { await removeTestBot(); await closePg(); });

  it('signs in with the NEW password, refuses the old one, and evicts the old session', async () => {
    // A session the merchant opened before the reset — signed the way the
    // merchant login signs one.
    const oldSession = signToken({ merchantId, userId: merchantId, mobile, isMerchant: true, isAdmin: false, amr: ['pwd', 'tg'] });
    const before = await request(app).get('/merchant/telegram').set('Authorization', `Bearer ${oldSession}`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    // `iat` is whole seconds; the cutoff must land after it.
    await new Promise((r) => setTimeout(r, 1100));

    // Forgot password, answered in the Mini App: the contact of the linked
    // Telegram account, on the merchant's own mobile (Step 3).
    const { pgQuery: q } = await import('#db/client.js');
    const tg = (await q('SELECT telegram_user_id FROM telegram_links WHERE user_id = $1', [userId])).rows[0].telegram_user_id;
    const at = new Date(Date.now() + 300_000);
    const issued = await startResetFromMiniApp({
      panel: 'MERCHANT', telegramUser: { id: tg },
      initData: { hash: `mpr-i-${userId}`, expiresAt: at },
      contact: { hash: `mpr-c-${userId}`, expiresAt: at, userId: tg, phone: mobile },
      baseUrl: 'https://merchant.example',
    });
    expect(issued.ok, JSON.stringify(issued)).toBe(true);
    const token = issued.url.split('/#/reset/')[1];

    const reset = await request(app).post('/auth/password/reset')
      .send({ token, password: NEW, confirmPassword: NEW });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);

    // The new password is accepted: the merchant's Telegram approval is next.
    const withNew = await request(app).post('/merchant/auth/login').send({ mobile, password: NEW });
    expect(withNew.status, JSON.stringify(withNew.body)).toBe(200);
    expect(withNew.body.twoFactorRequired, JSON.stringify(withNew.body)).toBe(true);
    // The door paces one try per mobile; the pace is not what this asks.
    const { loginPaceLimiter } = await import('../../middleware/security.js');
    await loginPaceLimiter.resetKey(`p:${mobile}`);
    const withOld = await request(app).post('/merchant/auth/login').send({ mobile, password: OLD });
    expect(withOld.status).toBe(401);

    const after = await request(app).get('/merchant/telegram').set('Authorization', `Bearer ${oldSession}`);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_SUPERSEDED');
    // And the live order feed, which verifies its token inline.
    const feed = await request(app).get(`/sse/merchant/events?token=${encodeURIComponent(oldSession)}`);
    expect(feed.status).toBe(401);
    expect(feed.body.code).toBe('SESSION_SUPERSEDED');
  });
});
