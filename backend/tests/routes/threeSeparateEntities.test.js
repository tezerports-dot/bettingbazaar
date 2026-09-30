// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Player, staff and merchant are THREE accounts, and one mobile may hold all of
 * them — with three different passwords, none of which works at another door.
 *
 * ── The owner's requirement, 2026-09-24 ────────────────────────────────────
 * "Users, merchants and admin/sub-admin are three separate entities. If a user
 * opens an account on the user panel those credentials only work for the user
 * panel, not the merchant panel or the admin panel — and the same person can
 * create each account separately with different passwords."
 *
 * ── Why this is a test and not a comment ──────────────────────────────────
 * Because it was already wrong twice while being built, in ways nothing else
 * would have caught:
 *
 *   · `users.mobile` was globally UNIQUE, so the second account was refused by
 *     an index whose message named neither panel;
 *   · merchant signup writes a `users` row too, and without a type of its own
 *     that row defaulted to PLAYER — so a merchant could have signed into the
 *     PLAYER panel with their merchant password. Merchants living in their own
 *     table made them look separate when the login row was not.
 *
 * ── The nine cases ────────────────────────────────────────────────────────
 * Three doors × three passwords. Three succeed, six must not, and the six are
 * asserted to say the SAME thing as each other — a refusal that distinguished
 * "wrong password" from "wrong panel" would let anybody map which of the three
 * account types a phone number holds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getUserByMobile, newUserId, createUser, setRoles, ACCOUNT_TYPES } from '#db/repositories/users.js';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import playerAuthRoutes from '../../domains/identity/playerAuth.routes.js';
import merchantRoutes from '../../domains/merchant/merchant.routes.js';
import { loginHandler, LOGIN_DOOR } from '../../routes.js';
import { mountRouter, request } from './_harness.js';
import express from 'express';

const describePg = pgConfigured() ? describe : describe.skip;

/** One mobile, three accounts, three passwords. Unique per RUN (§32 S19). */
const RUN = String(Math.floor(Math.random() * 90000) + 10000);
const MOBILE = `9${RUN}0007`;
const PW = {
  player:   'the-player-passphrase',
  staff:    'the-staff-passphrase-x',
  merchant: 'the-merchant-passphrase',
};

/**
 * The three doors, mounted as `server.js` mounts them.
 *
 * The STAFF door is `loginHandler` with `LOGIN_DOOR.STAFF`, which is exactly
 * what `app.post('/api/admin/login', …)` does — mounted here rather than
 * imported from server.js because importing server.js starts a server.
 */
const app = express();
app.use(express.json());
app.set('trust proxy', true);
app.use('/api/v1/auth', playerAuthRoutes);
app.post('/api/admin/login',
  (req, res, next) => { req.loginDoor = LOGIN_DOOR.STAFF; next(); }, loginHandler);
app.use('/api/merchant', merchantRoutes);

/**
 * A fresh address per request, in a fresh /24.
 *
 * The limiters are real and mounted on these routes — that is the point of
 * putting them there — so without this the second login in the file is answered
 * by the pace limiter and every assertion after it measures a 429.
 */
let addr = 0;
const from = () => { addr += 1; return `10.${(addr >> 8) & 255}.${addr & 255}.9`; };
const post = (path, body) => request(app).post(path).set('X-Forwarded-For', from()).send(body);

const DOORS = {
  PLAYER:   '/api/v1/auth/login',
  STAFF:    '/api/admin/login',
  MERCHANT: '/api/merchant/auth/login',
};

describePg('three separate entities, one mobile', () => {
  beforeAll(async () => {
    await applySchema();

    // The PLAYER, through the form's own writer.
    const { createAccountFromSignup } = await import('#db/repositories/identity.js');
    const player = await createAccountFromSignup({
      userId: newUserId(), username: 'the player', mobile: MOBILE,
      passwordHash: await hashPassword(PW.player),
      aadhaarHash: `three-${RUN}`, aadhaarEncrypted: 'cipher', aadhaarLast4: '0007',
      referralCode: `TRI${RUN}`,
    });
    expect(player.ok, 'the player account').toBe(true);

    // The STAFF account, the way `POST /admin/sub-admins` writes one.
    const staff = await createUser({
      userId: newUserId(), username: 'the staff', mobile: MOBILE,
      passwordHash: await hashPassword(PW.staff),
      status: 'ACTIVE', kycStatus: 'APPROVED', isAdmin: true, accountType: 'STAFF',
    });
    expect(staff.created, 'the staff account on the SAME mobile').toBe(true);
    await setRoles(staff.user.userId, ['admin']);
    // Staff enrol a second factor by policy, and an enrolled account is
    // answered with a CHALLENGE rather than a session — which is a different
    // assertion from the one this file is making. Off, deliberately and
    // explicitly, so the nine cases below compare like with like.
    await pgQuery('UPDATE users SET two_factor_enabled = false WHERE user_id = $1',
      [staff.user.userId]);

    // The MERCHANT, through merchant signup.
    const merchant = await createMerchantAccount({
      userId: newUserId(), username: `merchant${RUN}`, mobile: MOBILE,
      passwordHash: await hashPassword(PW.merchant), currency: 'INR',
    });
    expect(merchant.ok, 'the merchant account on the SAME mobile').toBe(true);
    await pgQuery(
      `UPDATE merchants SET status='ACTIVE', merchant_approval_status='APPROVED'
        WHERE merchant_id = $1`, [merchant.merchant.merchantId]);
  });
  afterAll(async () => { await closePg(); });

  it('writes THREE rows on one mobile, one per type', async () => {
    const { rows } = await pgQuery(
      'SELECT account_type FROM users WHERE mobile = $1 ORDER BY account_type', [MOBILE]);
    expect(rows.map((r) => r.account_type)).toEqual(['MERCHANT', 'PLAYER', 'STAFF']);
  });

  it('the repository and the SCHEMA name the same three types', async () => {
    // §32 S12, on an enum. The CHECK is what the database enforces and
    // ACCOUNT_TYPES is what every caller is validated against; a value in one
    // and not the other is either a type nobody can write or a write nobody
    // validates. Read from the constraint rather than restated here, so this
    // fails when the two drift rather than when somebody forgets to update it.
    const { rows } = await pgQuery(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'users_account_type_check'`);
    for (const type of ACCOUNT_TYPES) expect(rows[0].def).toContain(`'${type}'`);
    expect((rows[0].def.match(/'/g) || []).length / 2).toBe(ACCOUNT_TYPES.length);
  });

  it('gives each door its OWN account', async () => {
    // Read through the repository the doors read through, so a lookup that
    // stopped scoping by type fails here rather than at a login six months on.
    expect((await getUserByMobile(MOBILE, 'PLAYER')).username).toBe('the player');
    expect((await getUserByMobile(MOBILE, 'STAFF')).username).toBe('the staff');
    expect((await getUserByMobile(MOBILE, 'MERCHANT')).accountType).toBe('MERCHANT');
  });

  it('REFUSES a lookup that does not say which population it means', async () => {
    // The argument is required, with no default. A default of 'PLAYER' would
    // have made every un-updated caller silently correct for players and
    // silently wrong for staff — failing only on the accounts that move money.
    await expect(getUserByMobile(MOBILE)).rejects.toThrow(/accountType/);
  });

  it('admits each password at its OWN door, and nowhere else', async () => {
    const seen = {};
    for (const [door, path] of Object.entries(DOORS)) {
      for (const [who, password] of Object.entries(PW)) {
        const res = await post(path, { mobile: MOBILE, password });
        seen[`${door}<-${who}`] = { status: res.status, ok: res.body.success === true };
      }
    }
    const expected = {
      'PLAYER<-player': true,   'PLAYER<-staff': false,   'PLAYER<-merchant': false,
      'STAFF<-player': false,   'STAFF<-staff': true,     'STAFF<-merchant': false,
      'MERCHANT<-player': false, 'MERCHANT<-staff': false, 'MERCHANT<-merchant': true,
    };
    for (const [k, want] of Object.entries(expected)) {
      expect(seen[k]?.ok, `${k} (answered ${seen[k]?.status})`).toBe(want);
    }
  });

  it('answers every wrong-door attempt IDENTICALLY within a door', async () => {
    // Six refusals. A door that said "wrong password" for one and "this is a
    // merchant account" for another would let anybody map which of the three
    // account types a phone number holds, one request at a time.
    for (const [door, path] of Object.entries(DOORS)) {
      const wrong = Object.entries(PW).filter(([who]) => who.toUpperCase() !== door);
      const said = [];
      for (const [, password] of wrong) {
        const res = await post(path, { mobile: MOBILE, password });
        said.push(`${res.status}:${res.body.message}`);
      }
      expect(new Set(said).size, `${door} door said: ${said.join(' | ')}`).toBe(1);
    }
  });

  it('keeps one account per type — a second of the same type is refused', async () => {
    // The uniqueness rule MOVED; it did not go away.
    const again = await createUser({
      userId: newUserId(), username: 'a second staff', mobile: MOBILE,
      passwordHash: await hashPassword('another-passphrase-x'), accountType: 'STAFF',
    });
    expect(again.created).toBe(false);
    expect(again.user.username).toBe('the staff');
  });
});
