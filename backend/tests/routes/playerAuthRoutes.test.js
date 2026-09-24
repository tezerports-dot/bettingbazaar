// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The signup form and the login form, through a real database.
 *
 * ── Why this tier, and what it can and cannot see ──────────────────────────
 * The unit suite proves the rules (what a valid Aadhaar looks like, what the
 * password policy refuses). This one proves the HANDLER: that a submitted form
 * writes a row, that a duplicate is refused by the index rather than by a read
 * the route did first, and that the refusal a player is shown names the field
 * they have to change.
 *
 * What it cannot see — stated because §29 says absence of a failing check is
 * not evidence when no check covers the claim:
 *
 *   · the CAPTCHA. `requireCaptcha` is a pass-through with no
 *     TURNSTILE_SECRET_KEY, which is how it ships and how every environment
 *     that has not configured Turnstile runs it. There is no secret key in this
 *     repository and there cannot be one, so no automated tier here exercises a
 *     real challenge.
 *   · the LIMITERS. They are mounted on the route in `playerAuth.routes.js` and
 *     keyed by IP; this harness mounts the router directly. The limiters have
 *     their own suite (`authLimiterSessions.test.js`) and the SCOPING decision —
 *     which limiter guards which kind of path — is asserted at the bottom of
 *     this file against the source, because that is where it was got wrong.
 *
 * Every assertion reads the DATABASE afterwards. A 200 is not the assertion:
 * that is how a route once reported a settlement working while the function it
 * called threw on every call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getUser, getUserByMobile, getUserCredentials } from '#db/repositories/users.js';
import { verifyPassword } from '../../domains/identity/password.util.js';
import { hashAadhaarCandidates } from '../../domains/identity/aadhaarHash.util.js';
import { findRegisteredAadhaar } from '#db/repositories/identity.js';
import playerAuthRoutes from '../../domains/identity/playerAuth.routes.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const app = mountRouter(playerAuthRoutes, { prefix: '/api/v1/auth' });

/**
 * Every request arrives from a DIFFERENT address, in a different /24.
 *
 * The limiters are real and mounted per route — that is the point of putting
 * them there — so without this the second login in the file is answered by the
 * pace limiter and every assertion after it measures a 429. Supertest always
 * connects from 127.0.0.1, so the address has to be forwarded, which needs
 * `trust proxy`.
 *
 * This does NOT weaken anything. It says "these are twenty different people",
 * which is what the assertions are about: they are about the handler. The
 * limiters' own behaviour is asserted in `authLimiterSessions.test.js` and, for
 * the scoping decision, against the source at the bottom of this file.
 */
app.set('trust proxy', true);
let addr = 0;
const from = () => {
  addr += 1;
  // A fresh /24 each time, so the SUBNET limiter is not the thing being
  // measured either.
  return `10.${(addr >> 8) & 255}.${addr & 255}.7`;
};
const post = (path, body) => request(app).post(`/api/v1/auth${path}`)
  .set('X-Forwarded-For', from()).send(body);

/**
 * A fresh, valid form.
 *
 * Unique per RUN, not merely per call. The database survives between runs, so a
 * sequence starting at 1 every time collides with the accounts the last run
 * created and the whole suite reads as "duplicate" — §32 S19, a test asserting
 * a precondition it never established. The run prefix is random; the counter
 * keeps calls inside one run apart.
 */
const RUN = String(Math.floor(Math.random() * 90000) + 10000);   // 5 digits
let seq = 0;
const form = (over = {}) => {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    // 12 digits: 3 fixed + 5 run + 4 counter.
    aadhaar: `777${RUN}${n}`,
    // 10 digits, starting 6-9 as an Indian mobile must: 1 + 5 run + 4 counter.
    mobile: `9${RUN}${n}`,
    password: 'a-long-enough-phrase',
    confirmPassword: 'a-long-enough-phrase',
    ...over,
  };
};

describePg('POST /api/v1/auth/register — the signup form', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('creates the account, and the ROW says so', async () => {
    const f = form();
    const res = await post('/register', f);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const user = await getUserByMobile(f.mobile);
    expect(user).not.toBeNull();
    expect(user.kycStatus).toBe('PENDING_APPROVAL');
    // The Aadhaar is queued, hashed. Looked up through the candidate hashes so
    // the assertion survives an HMAC secret rotation the way the route does.
    expect(await findRegisteredAadhaar(hashAadhaarCandidates(f.aadhaar))).toBeTruthy();
  });

  it('stores a VERIFIABLE hash, not the password', async () => {
    const f = form();
    await post('/register', f);
    const user = await getUserByMobile(f.mobile);
    const creds = await getUserCredentials(user.userId);
    expect(creds.passwordHash).not.toContain(f.password);
    // The real assertion: the login path can verify what signup wrote. A hash
    // stored in a format `verifyPassword` cannot read would look perfectly fine
    // in the column and reject every login.
    expect((await verifyPassword(creds.passwordHash, f.password)).valid).toBe(true);
  });

  it('signs the new player in, so the gate knows who is standing at it', async () => {
    const res = await post('/register', form());
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('user');
    // No joining number yet — the channel join claims it. Asserted here too
    // because this is the route somebody would "helpfully" add it to.
    const user = await getUser(res.body.user.id);
    expect(user.joiningNumber).toBeFalsy();
  });

  it('names the FIELD in every refusal', async () => {
    // §32 S14. A form that answers "invalid details" to six different mistakes
    // sends the player back to guess which box is wrong, and the commonest
    // wrong box — the mobile, where they typed +91 as well — looks identical to
    // a correct one.
    const cases = [
      [{ aadhaar: '123' }, /aadhaar/i],
      [{ mobile: '12345' }, /mobile/i],
      [{ confirmPassword: 'something-else' }, /passwords do not match/i],
      [{ password: 'short', confirmPassword: 'short' }, /at least 8 characters/i],
      [{ referralCode: 'NOSUCHCODE' }, /invite code/i],
    ];
    for (const [over, pattern] of cases) {
      const res = await post('/register', form(over));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.body.message, JSON.stringify(over)).toMatch(pattern);
    }
  });

  it('writes NOTHING when a refusal fires', async () => {
    const f = form({ confirmPassword: 'different' });
    await post('/register', f);
    expect(await getUserByMobile(f.mobile)).toBeNull();
  });

  it('refuses a second account on one mobile, and says to log in', async () => {
    const f = form();
    await post('/register', f);
    const again = await post('/register', form({ mobile: f.mobile }));
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/log in instead/i);
  });

  it('refuses a second account on one Aadhaar', async () => {
    const f = form();
    await post('/register', f);
    const again = await post('/register', form({ aadhaar: f.aadhaar }));
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/one account/i);
  });

  it('attributes a referral, and REFUSES a code that matches nobody', async () => {
    const referrer = form();
    await post('/register', referrer);
    const inviter = await getUserByMobile(referrer.mobile);

    // Refused, not silently dropped. The path this replaced looked the code up
    // at contact-share time and wrote null on a miss: the signup succeeded, the
    // referrer never earned, and afterwards nobody could tell whether the code
    // had been wrong or the payout had failed.
    expect((await post('/register', form({ referralCode: 'GHOSTCODE' }))).status).toBe(400);

    const invited = form({ referralCode: inviter.referralCode.toLowerCase() });
    expect((await post('/register', invited)).status).toBe(200);
    // Lower case on purpose: codes are generated upper case and looked up by
    // exact match, so an un-normalised code matches nothing and costs the
    // referrer their earning with no error anywhere.
    expect((await getUserByMobile(invited.mobile)).referredBy).toBe(inviter.userId);
  });
});

describePg('GET /api/v1/auth/invite/:code', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('confirms a real code and names who it belongs to', async () => {
    const f = form();
    await post('/register', f);
    const inviter = await getUserByMobile(f.mobile);
    const res = await request(app).get(`/api/v1/auth/invite/${inviter.referralCode}`)
      .set('X-Forwarded-For', from());
    expect(res.body).toMatchObject({ valid: true, invitedBy: inviter.username });
  });

  it('answers a nonsense code without an error', async () => {
    // The signup form pre-fills this from a link and makes it non-editable when
    // it arrived that way, so it asks before the player can act. A 500 here
    // would render as a broken form for somebody who did nothing wrong.
    const res = await request(app).get('/api/v1/auth/invite/NOSUCHCODE')
      .set('X-Forwarded-For', from());
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('leaks nothing beyond the username for a code somebody already holds', async () => {
    const f = form();
    await post('/register', f);
    const inviter = await getUserByMobile(f.mobile);
    const res = await request(app).get(`/api/v1/auth/invite/${inviter.referralCode}`)
      .set('X-Forwarded-For', from());
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(inviter.mobile);
    expect(body).not.toContain(inviter.userId);
  });
});

describePg('POST /api/v1/auth/login — the login form', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('signs a player in with the password the form set', async () => {
    const f = form();
    await post('/register', f);
    const res = await post('/login', { mobile: f.mobile, password: f.password });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeTruthy();
  });

  it('answers a wrong password and an unknown number IDENTICALLY', async () => {
    // A login form that says "no such account" is a way to test whether a given
    // person gambles here.
    const f = form();
    await post('/register', f);
    const wrong   = await post('/login', { mobile: f.mobile, password: 'not-the-password' });
    const unknown = await post('/login', { mobile: '9111111111', password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('refuses a STAFF account at the player door, and says where to go', async () => {
    // Built by signing an ordinary player up and then PROMOTING them, so the
    // password hash is a real one this route produced. Setting a role on a
    // harness actor would leave no hash at all, and the 403 would then be
    // reachable without ever passing the password check — which is the ordering
    // property the next test but one depends on.
    const f = form();
    await post('/register', f);
    const user = await getUserByMobile(f.mobile);
    await pgQuery(`UPDATE users SET is_admin = true WHERE user_id = $1`, [user.userId]);

    const res = await post('/login', { mobile: f.mobile, password: f.password });
    expect(res.status).toBe(403);
    // §32 S14: a refusal the reader cannot act on is a support ticket.
    expect(res.body.message).toMatch(/admin panel/i);

    // And the 403 is only reachable WITH the right password, or this endpoint
    // becomes a way to sort phone numbers into staff and non-staff.
    //
    // A SECOND promoted account, not a second attempt on the first. The pace
    // limiter keys on `req.body.mobile` rather than the IP — which is the right
    // choice, because it paces per ACCOUNT rather than per address — so two
    // logins for one number inside ten seconds are answered by the pace and the
    // assertion would measure a 429 instead of the ordering it is about.
    const g = form();
    await post('/register', g);
    const other = await getUserByMobile(g.mobile);
    await pgQuery(`UPDATE users SET is_admin = true WHERE user_id = $1`, [other.userId]);
    const guessing = await post('/login', { mobile: g.mobile, password: 'not-the-password' });
    expect(guessing.status).toBe(401);
  });

  it('refuses a BLOCKED account with a reason a person can act on', async () => {
    const f = form();
    await post('/register', f);
    const user = await getUserByMobile(f.mobile);
    await pgQuery(`UPDATE users SET is_blocked = true, block_reason = 'x', blocked_at = now()
                    WHERE user_id = $1`, [user.userId]);
    const res = await post('/login', { mobile: f.mobile, password: f.password });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/blocked/i);
  });

  it('issues a 2FA CHALLENGE instead of a session for an enrolled account', async () => {
    const f = form();
    await post('/register', f);
    const user = await getUserByMobile(f.mobile);
    await pgQuery(`UPDATE users SET two_factor_enabled = true WHERE user_id = $1`, [user.userId]);
    const res = await post('/login', { mobile: f.mobile, password: f.password });
    // Deliberately NOT a logged-in success: a challenge is issued INSTEAD of a
    // session, so nothing downstream can mistake it for one.
    expect(res.body.success).toBe(false);
    expect(res.body.twoFactorRequired).toBe(true);
    expect(res.body.challengeToken).toBeTruthy();
    expect(res.body.token).toBeFalsy();
  });
});

describePg('GET /api/v1/auth/verification — the gate', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('refuses an anonymous caller', async () => {
    expect((await request(app).get('/api/v1/auth/verification')).status).toBe(401);
  });

  it('reports NO BOT as the platform state, never as the player fault', async () => {
    // A launch sits in exactly this state between deploying and registering the
    // first bot, and the player can do nothing about it. The reason has to say
    // so, or the screen tells them to open a bot that does not exist.
    await pgQuery(`UPDATE telegram_bots SET status = 'RETIRED', retired_at = now()
                    WHERE role = 'signin' AND status = 'ACTIVE'`);
    const who = await actor();
    const res = await as(app, who).get('/api/v1/auth/verification');
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
    expect(res.body.reason).toBe('no_bot');
  });
});

/**
 * ── Which limiter guards which kind of path ────────────────────────────────
 *
 * Asserted against the SOURCE, because this is a mounting decision and there is
 * no runtime tier that can see it: the route tests mount the router directly,
 * and the limiters are keyed by IP.
 *
 * It is asserted at all because getting it wrong was measured, twice, on a
 * running server:
 *
 *   · `authLimiter` on the session router counted an expired-token `GET /me` as
 *     a failed login, so four page loads locked a player out of logging OUT
 *     (§32 S27);
 *   · `createSubnetLimiter('auth')` on the `/api/v1/auth` PREFIX counted every
 *     request at 32 per /24 per 30 minutes, so `GET /me` answered 429 from an
 *     address that had submitted no credential at all — and most Indian mobile
 *     traffic sits behind carrier-grade NAT, where a /24 is thousands of people.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = (p) => readFileSync(join(here, p), 'utf8');

describe('the limiters guard credentials, and only credentials', () => {
  const routes = source('../../domains/identity/playerAuth.routes.js');
  const server = source('../../server.js');

  it('puts the failure budget and the subnet limiter on the LOGIN route', () => {
    const chain = routes.slice(routes.indexOf('const credentialChain'),
                               routes.indexOf('const signupChain'));
    expect(chain).toMatch(/loginPaceLimiter/);
    expect(chain).toMatch(/authLimiter/);
    expect(chain).toMatch(/createSubnetLimiter\('auth'\)/);
    expect(chain).toMatch(/globalSurgeBreaker\('auth'\)/);
    expect(routes).toMatch(/router\.post\('\/login', \.\.\.credentialChain/);
  });

  it('keeps BOTH off the signup route, which submits no secret', () => {
    const chain = routes.slice(routes.indexOf('const signupChain'),
                               routes.indexOf('router.post(\'/register\''));
    expect(chain).not.toMatch(/authLimiter/);
    expect(chain).not.toMatch(/loginPaceLimiter/);
    expect(chain).toMatch(/signupLimiter/);
  });

  it('counts SUCCESSES on signup, so a typo never costs the next attempt', () => {
    // §32 S13. The failures here are typos and the successes are the cost, so
    // this limiter counts the opposite of every other one in the file.
    expect(source('../../middleware/security.js'))
      .toMatch(/signupLimiter[\s\S]{0,600}skipFailedRequests: true/);
    expect(routes).toMatch(/createSubnetLimiter\('signup', \{ countOnly: 'successes' \}\)/);
  });

  it('mounts no subnet limiter or surge breaker on either /api/v1/auth PREFIX', () => {
    const mounts = server.split('\n').filter((l) => l.includes("app.use('/api/v1/auth'"));
    expect(mounts.length).toBe(2);
    for (const line of mounts) {
      expect(line).not.toMatch(/createSubnetLimiter/);
      expect(line).not.toMatch(/globalSurgeBreaker/);
    }
  });
});
