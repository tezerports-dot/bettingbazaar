// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An admin who has not enrolled a second factor is TOLD SO on their session.
 *
 * ── The half of F-011 this covers ───────────────────────────────────────────
 * `requires2FA(user)` decides who must hold a factor, and `loginHandler`
 * branches on `user.twoFactorEnabled` — so the factor is demanded only of
 * accounts that ALREADY enrolled, and an admin who never did holds a
 * password-only session over the whole admin surface. `seedAdmin` does not
 * enrol, so the bootstrapped admin starts in exactly that state.
 *
 * Step 2 of the fix (the server refusing every route but /api/2fa/setup and
 * /activate) is the owner's switch and is deliberately NOT on. `mustEnroll2FA`
 * is what makes flipping it safe rather than a lockout, so the thing worth
 * holding is that the flag is actually on the response for the accounts that
 * need it — and absent for the ones that do not, since a panel that gates on a
 * flag present for everybody gates on nothing.
 *
 * Asserted through the REAL login handler against a real database. A unit test
 * on `requires2FA` would pass while the handler forgot to call it, which is the
 * shape this finding already is.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { db } from '#db';
import { hashPassword } from '../../domains/identity/password.util.js';
import { mountRouter, actor, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const PASSWORD = 'Correct-Horse-Battery-9!';

describePg('a staff session says whether a second factor is still owed', () => {
  let app;

  beforeAll(async () => {
    await applySchema();
    const express = (await import('express')).default;
    const cookieParser = (await import('cookie-parser')).default;
    const { loginHandler } = await import('../../routes.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // Mounted at the path server.js serves it on, with the rate limiters and
    // captcha omitted: those are separate concerns with their own coverage, and
    // including them here would make this file fail for reasons it is not about.
    app.post('/api/admin/login', loginHandler);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A staff account with a password, enrolled or not. */
  const staff = async ({ isAdmin = false, isSubAdmin = false, enrolled = false } = {}) => {
    const who = await actor({ isAdmin, isSubAdmin });
    await db.users.updateUser(who.userId, {
      passwordHash: await hashPassword(PASSWORD),
      ...(enrolled ? { twoFactorEnabled: true } : {}),
    });
    return who;
  };

  const login = (who) => request(app).post('/api/admin/login')
    .send({ mobile: who.mobile, password: PASSWORD });

  it('flags an ADMIN who has never enrolled', async () => {
    const who = await staff({ isAdmin: true });
    const res = await login(who);
    expect(res.status, res.body?.message).toBe(200);
    expect(res.body.token, 'the session is still issued — step 2 is the owner\'s switch').toBeTruthy();
    expect(res.body.mustEnroll2FA, 'an unenrolled admin was not asked to enrol').toBe(true);
  });

  it('flags a SUB-ADMIN who has never enrolled', async () => {
    // `requires2FA` keys on isAdmin/isSubAdmin — the same flags the route
    // guards use — rather than on `roles`, because deriving the policy from
    // roles alone was a real hole. A sub-admin reaches KYC approval, which
    // grants withdrawal access, so they are covered too.
    const who = await staff({ isSubAdmin: true });
    const res = await login(who);
    expect(res.status).toBe(200);
    expect(res.body.mustEnroll2FA).toBe(true);
  });

  it('does NOT flag an admin who has enrolled', async () => {
    const who = await staff({ isAdmin: true, enrolled: true });
    const res = await login(who);
    // An enrolled account gets the 2FA challenge instead of a session, which is
    // the other branch entirely — either way, it must not be told to enrol.
    expect(res.body.mustEnroll2FA ?? false).toBe(false);
  });

  it('flags on the SESSION CHECK too, not only at login', async () => {
    // The obligation does not begin at a sign-in. An account PROMOTED to staff
    // while holding a session owes a factor from the promotion, and a flag
    // established only at login leaves them password-only over the whole admin
    // surface until they next sign out. `/me` is what every panel calls on
    // load, so it is where a change of status is noticed.
    const { default: authRoutes } = await import('../../routes.js');
    const express = (await import('express')).default;
    const cookieParser = (await import('cookie-parser')).default;
    const meApp = express();
    meApp.use(express.json()); meApp.use(cookieParser());
    meApp.use('/api/v1/auth', authRoutes);

    // Signed in as an ordinary account — nothing owed.
    const who = await staff({});
    const before = await request(meApp).get('/api/v1/auth/me').set('Authorization', who.auth);
    expect(before.status, before.body?.message).toBe(200);
    expect(before.body.mustEnroll2FA ?? false).toBe(false);

    // Promoted, holding the same token.
    await db.users.updateUser(who.userId, { isAdmin: true });
    const after = await request(meApp).get('/api/v1/auth/me').set('Authorization', who.auth);
    expect(after.status).toBe(200);
    expect(
      after.body.mustEnroll2FA,
      'promoted to admin mid-session and never asked for a factor',
    ).toBe(true);
  });

  it('does NOT flag an ordinary account, so the panel gate means something', async () => {
    // A flag present for everybody gates nothing. This is what makes the
    // admin panel's obligation screen a decision rather than a wall.
    const who = await staff({});
    const res = await login(who);
    expect(res.body.mustEnroll2FA ?? false).toBe(false);
  });
});
