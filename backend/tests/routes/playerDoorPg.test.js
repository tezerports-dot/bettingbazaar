// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The PLAYER's routes admit a player's session and nobody else's.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * The login doors scope by `account_type` (§2, LOGIN_DOOR); the SESSION door
 * did not. `authenticate` loaded whatever row a token named and admitted it,
 * so a session minted at one panel's door worked at another's:
 *
 *   · a MERCHANT's session (its token names the merchant's login row, §33.5)
 *     passed `authenticate`, which also copied `req.merchantId` out of the
 *     token — and the order guard then recognised it as "the assigned
 *     merchant", admitting it to the PLAYER's actions on the player's order.
 *     Measured: `GET /api/payment/order/:id` answered 200 with the player's
 *     projection, and `GET /api/payment/orders` answered 200.
 *   · a STAFF session — a full admin's and a sub-admin's — created a deposit
 *     through `POST /api/payment/deposit/create` (200, an order in the staff
 *     account's name) and read the player's profile and bet limits.
 *
 * Owner, 2026-10-01: the three accounts are separate, and "if he has his admin
 * account that account can only be used for admin activity". So the player's
 * routes take `authenticatePlayer`, the shared door refuses a merchant, and the
 * refusal names the panel the account belongs to (§32 S14).
 *
 * No admin or merchant screen calls a player route (checked 2026-10-01), and
 * phantom agents are PLAYER accounts, so nothing legitimate is refused. The
 * opposite cases — each session still working where it belongs — are asserted
 * beside the refusals (§37 step 6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { createMerchantAccount, updateMerchant } from '#db/repositories/merchants.js';
import { newUserId } from '#db/repositories/users.js';
import { signToken } from '../../domains/identity/paseto.util.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

/** A socket with the real handlers attached, and a record of what it joined. */
async function connectSocket(token) {
  const { attachSocketHandlers } = await import('../../startup/socketHandlers.js');
  const handlers = {};
  const joined = [];
  const socket = {
    id: 'door-socket', handshake: { headers: {}, auth: { token } },
    on: (event, fn) => { handlers[event] = fn; },
    emit: () => {}, join: (room) => joined.push(...[room].flat()), leave: () => {},
  };
  let connect;
  attachSocketHandlers(
    { on: (_e, fn) => { connect = fn; } },
    { sendCycleSnapshot: () => {}, getCycleSnapshotData: async () => [] },
    { getGameState: async () => ({}) },
  );
  await connect(socket);
  return { handlers, joined };
}

/**
 * Every route a player's session is for, as the routers declare them. The
 * refusal happens at the door, before a parameter is read, so the ids in the
 * paths need not exist.
 */
const PLAYER_ROUTES = {
  payments: [
    ['post', '/deposit/create'], ['post', '/usdt/deposit/create'], ['post', '/withdrawal/create'],
    ['post', '/order/x/retry'], ['post', '/order/x/payment-reference'], ['post', '/order/x/utr-grace'],
    ['post', '/order/x/mark-paid'], ['get', '/orders'], ['get', '/order/x'],
    ['post', '/order/cancel'], ['get', '/order/x/status'], ['post', '/order/x/dispute'],
  ],
  users: [
    ['get', '/v1/user/x/data'], ['put', '/user/x/profile'], ['put', '/user/x/bank-details'],
    ['get', '/user/referrals'], ['get', '/user/bet-limits'], ['get', '/v1/wallet/ledger'],
    ['get', '/user/notifications'], ['get', '/user/notifications/unread-count'],
    ['post', '/user/notifications/read'], ['get', '/v1/user/profile'],
  ],
  bets: [['post', '/place'], ['post', '/phantom']],
  support: [
    ['post', '/ask'], ['post', '/tickets'], ['get', '/tickets'], ['get', '/tickets/x'],
    ['post', '/tickets/x/reply'],
  ],
  playerAuth: [['get', '/telegram']],
  game: [['post', '/launch']],
  uploads: [['post', '/user/profile/picture/upload-url'], ['post', '/user/profile/picture/confirm-upload']],
  retention: [['get', '/bonuses/my']],
};

const ROUTERS = {
  payments: '../../domains/payment/payment.routes.js',
  users: '../../domains/user/user.routes.js',
  bets: '../../domains/markets/bet.routes.js',
  support: '../../domains/support/support.routes.js',
  playerAuth: '../../domains/identity/playerAuth.routes.js',
  game: '../../domains/casino/gameProvider.routes.js',
  uploads: '../../routes/upload.routes.js',
  retention: '../../routes/retention.routes.js',
};

describePg('the player door', () => {
  const apps = {};
  let merchantApp; let authApp; let staffApp; let seq = 0;
  const oid = () => `pdr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    for (const [name, path] of Object.entries(ROUTERS)) apps[name] = mountRouter((await import(path)).default);
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    staffApp = mountRouter((await import('../../routes/admin/users.admin.routes.js')).default);
    authApp = express();
    authApp.use(express.json());
    authApp.use(cookieParser());
    authApp.use('/api/v1/auth', (await import('../../routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /**
   * A merchant as production makes one: a LOGIN row in `users` (account type
   * MERCHANT) and the trading row in `merchants`, and the session minted with
   * exactly the claims `issueMerchantSession` signs. The harness's
   * `merchantActor` has no login row and signs `userId: merchantId`, so the
   * door finds nobody and answers 401 — which made the first draft of this file
   * pass on code that admitted every REAL merchant (§32 S16).
   */
  const realMerchant = async () => {
    const mobile = `7${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
    const created = await createMerchantAccount({
      userId: newUserId(), username: `pdr${Date.now()}${Math.floor(Math.random() * 1000)}`, mobile,
      passwordHash: await hashPassword('Merchant-Door-Pass-9!'), currency: 'INR',
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const merchantId = created.merchant.merchantId;
    await updateMerchant(merchantId, { status: 'ACTIVE', merchantApprovalStatus: 'APPROVED' });
    const token = signToken({ merchantId, userId: created.userId, mobile, isMerchant: true, isAdmin: false, amr: ['pwd', 'tg'] });
    return { merchantId, loginUserId: created.userId, mobile, token, auth: `Bearer ${token}` };
  };

  /** A buy belonging to `player`, assigned to `merchant`, in `state`. */
  const assignedBuy = async (player, merchant, state) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500, state, merchantId: merchant.merchantId,
    });
    return orderId;
  };

  const refusedFor = (panel) => (res) => {
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('WRONG_PANEL');
    // Names the panel the account BELONGS to — the one thing the person can act on.
    expect(res.body.message).toContain(`${panel} panel`);
  };

  const ordersOf = async (userId) => Number((await pgQuery(
    'SELECT count(*)::int AS n FROM order_states WHERE user_id = $1', [userId], 'player_door_orders',
  )).rows[0].n);

  // ── A merchant's session ─────────────────────────────────────────────────
  it("refuses the assigned merchant on the player's own order routes, and nothing changes", async () => {
    const player = await actor({});
    const merchant = await realMerchant();
    const orderId = await assignedBuy(player, merchant, 'PROCESSING');
    const refused = refusedFor('merchant');

    const read = await as(apps.payments, merchant).get(`/order/${orderId}`);
    refused(read);
    expect(read.body.order).toBeUndefined();
    refused(await as(apps.payments, merchant).post(`/order/${orderId}/mark-paid`).send({ utrNumber: '555566667777' }));
    refused(await as(apps.payments, merchant).post(`/order/${orderId}/dispute`).send({ reason: 'raised for the player' }));

    const after = await getOrderRecord(orderId);
    expect(after.status).toBe('PROCESSING');
    expect(after.utrNumber ?? null).toBeNull();
    expect(after.disputeRaisedBy ?? null).toBeNull();
  });

  it('refuses a merchant session on /me, the endpoint a panel restores a session from', async () => {
    const merchant = await realMerchant();
    const res = await request(authApp).get('/api/v1/auth/me').set('Authorization', merchant.auth);
    refusedFor('merchant')(res);
    expect(res.body.user).toBeUndefined();
  });

  it('still admits the same merchant session on the merchant routes (the opposite behaviour)', async () => {
    const merchant = await realMerchant();
    const res = await as(merchantApp, merchant).get('/profile');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  // ── A staff session ──────────────────────────────────────────────────────
  it('refuses a full admin and a sub-admin a deposit in their own name, and no order is written', async () => {
    const admin = await actor({ isAdmin: true });
    const sub = await actor({ isSubAdmin: true, permissions: { canResolveDisputes: true } });
    for (const staff of [admin, sub]) {
      const before = await ordersOf(staff.userId);
      refusedFor('admin')(await as(apps.payments, staff).post('/deposit/create').send({ tokenAmount: 500 }));
      expect(await ordersOf(staff.userId)).toBe(before);
    }
  });

  it('still admits a staff session on /me and on its own routes (the opposite behaviour)', async () => {
    const admin = await actor({ isAdmin: true });
    const me = await request(authApp).get('/api/v1/auth/me').set('Authorization', admin.auth);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.user.id).toBe(admin.userId);
    const list = await as(staffApp, admin).get('/users');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
  });

  // ── Every player route, not just the ones above (§37 step 3) ─────────────
  it('refuses a staff and a merchant session on EVERY player route', async () => {
    const admin = await actor({ isAdmin: true });
    const merchant = await realMerchant();
    const misses = [];
    for (const [router, routes] of Object.entries(PLAYER_ROUTES)) {
      for (const [method, path] of routes) {
        for (const [who, session, panel] of [['admin', admin, 'admin'], ['merchant', merchant, 'merchant']]) {
          const res = await as(apps[router], session)[method](path).send({});
          if (res.status !== 403 || res.body.code !== 'WRONG_PANEL' || !String(res.body.message).includes(`${panel} panel`)) {
            misses.push(`${who} ${method.toUpperCase()} ${router}${path} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
          }
        }
      }
    }
    expect(misses, misses.join('\n')).toEqual([]);
  });

  it('still admits the player on their own order (the opposite behaviour)', async () => {
    const player = await actor({});
    const merchant = await realMerchant();
    const orderId = await assignedBuy(player, merchant, 'PROCESSING');
    const res = await as(apps.payments, player).get(`/order/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.orderId).toBe(orderId);
    const me = await request(authApp).get('/api/v1/auth/me').set('Authorization', player.auth);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
  });

  // ── The same door on the socket (§37 step 3: which other path gets here?) ─
  // A player's room carries their balance pushes, order updates and support
  // replies. It admitted any full admin to ANY player's room, and a merchant's
  // or staff member's session to a room under its own login id.
  it("admits a full admin's session to no player's socket room", async () => {
    const player = await actor({});
    const admin = await actor({ isAdmin: true });
    const s = await connectSocket(admin.token);
    await s.handlers.join_user_room(player.userId);
    await s.handlers.join_user_room(admin.userId);
    expect(s.joined).toEqual([]);
  });

  it("admits a merchant's session to no player room, its own login id included", async () => {
    const merchant = await realMerchant();
    const s = await connectSocket(merchant.token);
    await s.handlers.join_user_room(merchant.loginUserId);
    expect(s.joined).toEqual([]);
    // The merchant room join had no client and is gone; the merchant panel's
    // live feed is its SSE stream.
    expect(s.handlers.join_merchant_room).toBeUndefined();
  });

  it("still admits a player to their own room and to nobody else's (the opposite behaviour)", async () => {
    const player = await actor({});
    const other = await actor({});
    const s = await connectSocket(player.token);
    await s.handlers.join_user_room(other.userId);
    await s.handlers.join_user_room(player.userId);
    expect(s.joined).toEqual([`user-${player.userId}`]);
  });

  it('refuses no PLAYER at the door on any player route (the opposite behaviour, swept)', async () => {
    const player = await actor({});
    const wrongPanel = [];
    for (const [router, routes] of Object.entries(PLAYER_ROUTES)) {
      for (const [method, path] of routes) {
        const res = await as(apps[router], player)[method](path).send({});
        if (res.body?.code === 'WRONG_PANEL' || res.status === 401) {
          wrongPanel.push(`${method.toUpperCase()} ${router}${path} → ${res.status} ${res.body?.code ?? ''}`);
        }
      }
    }
    expect(wrongPanel, wrongPanel.join('\n')).toEqual([]);
  });
});
