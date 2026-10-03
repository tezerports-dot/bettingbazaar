// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A player sees where to pay, and nothing else about the member.
 *
 * ── The rule (owner, 2026-10-03) ────────────────────────────────────────────
 * Where to pay depends on the rail: the member's BANK ACCOUNT on a bank-
 * transfer buy (the 50,000 / 100,000 / 500,000 sizes), the ATM QR the member
 * scanned on a cash buy, the order chain's address on a USDT buy. Nothing
 * else: never the member's mobile number, never their UPI handle (usually the
 * same number), never a QR image, never the other chain's address, and on a
 * sell nothing at all, because the player pays nobody.
 *
 * ── What was shipped once ───────────────────────────────────────────────────
 * `buildMerchantSnapshot` writes every credential the member has onto the
 * order, and every player-facing response passed the whole object through, on
 * every order and every rail. The row still keeps it (a dispute is decided
 * from it); the projection is what chooses the one piece an order needs.
 *
 * ── Why these assertions are shaped this way ────────────────────────────────
 * CLOSED: the response's key set must be a SUBSET of `PLAYER_ORDER_FIELDS`
 * (plus `payTo`), and `payTo`'s keys exactly what the rail calls for. A column
 * added to `order_states` cannot reach a player without failing this.
 *
 * Driven through the real routers against a real database: the projection is
 * a pure function, and the half that was once broken is whether the handler
 * calls it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { createOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import {
  PLAYER_ORDER_FIELDS, PLAYER_FORBIDDEN_ORDER_FIELDS,
} from '../../domains/payment/playerOrderView.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('what a player is told about a merchant', () => {
  let app;
  let seq = 0;
  const made = [];
  const oid = () => {
    const id = `pp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
    made.push(id);
    return id;
  };

  // Every credential `buildMerchantSnapshot` puts on the row. The row KEEPS
  // them — a dispute months later is decided from what was true at assignment —
  // and the projection is what refuses to pass them on.
  const MERCHANT_UPI  = 'ravi@okhdfcbank';
  const MERCHANT_ACC  = '50100123456789';
  const MERCHANT_IFSC = 'HDFC0000123';
  const MERCHANT_NAME = 'Ravi Kumar';
  // Planted, as if a future snapshot carried it: nobody learns a number.
  const MERCHANT_MOBILE = '9876501234';
  // BOTH chains. A player is entitled to the one THEIR order named.
  const MERCHANT_USDT_TRC20 = 'TQ5NMqJjW8sT1u9dCUnMcGbmVpFmvbwrsi';
  const MERCHANT_USDT_BEP20 = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0';
  // The QR was removed on 2026-09-10. It stays in the fixture as a planted
  // unknown key: the projection is an allowlist, so it must be dropped.
  const MERCHANT_QR   = 'https://cdn.example/qr/ravi.png';

  const SNAPSHOT = {
    merchantRef: 'Merchant #7731',
    merchantId: 'MER-7731',
    merchantName: 'Merchant #7731',
    merchantType: 'INR',
    upiId: MERCHANT_UPI,
    mobile: MERCHANT_MOBILE,
    qrCodeUrl: MERCHANT_QR,
    bankName: 'HDFC Bank',
    accountNo: MERCHANT_ACC,
    ifsc: MERCHANT_IFSC,
    accountHolder: MERCHANT_NAME,
    usdtAddressTrc20: MERCHANT_USDT_TRC20,
    usdtAddressBep20: MERCHANT_USDT_BEP20,
    snapshotAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };

  /** What the player is given on a bank-transfer buy: the account, nothing more. */
  const BANK = { accountHolder: MERCHANT_NAME, accountNo: MERCHANT_ACC, ifsc: MERCHANT_IFSC, bankName: 'HDFC Bank' };

  /**
   * A buy its member has ACCEPTED, carrying the full snapshot exactly as
   * assignment writes it. Accepted, because that is when the player is shown
   * where to pay (`PAY_DETAIL_STATES`); `state` overrides it.
   */
  const assignedDeposit = async (player, { tokens = 50_000, state = 'PROCESSING', ...extra } = {}) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens,
      state,
      ...extra,
    });
    await setOrderFields(orderId, {
      merchantSnapshot: SNAPSHOT,
      expiresAt: new Date(Date.now() + 900_000),
    });
    return orderId;
  };

  /** What must never appear, in any form, anywhere a player reads. */
  const NEVER = [MERCHANT_UPI, MERCHANT_MOBILE, MERCHANT_USDT_TRC20, MERCHANT_USDT_BEP20, MERCHANT_QR];
  /** The account itself: allowed only inside `payTo.bankAccount` on a bank-transfer buy. */
  const ACCOUNT = [MERCHANT_ACC, MERCHANT_IFSC, MERCHANT_NAME];

  const carriesNoCredential = (payload, { bankBuy = false } = {}) => {
    const body = JSON.stringify(payload);
    for (const secret of NEVER) expect(body, `${secret} reached the player`).not.toContain(secret);
    const outsideAccount = body.replace(/"bankAccount":\{[^}]*\}/g, '"bankAccount":{}');
    for (const secret of ACCOUNT) {
      expect(outsideAccount, `${secret} reached the player outside payTo.bankAccount`).not.toContain(secret);
      if (!bankBuy) expect(body, `${secret} reached the player on an order that pays no bank account`).not.toContain(secret);
    }
  };

  /** Closed: nothing outside the declared shape. */
  const withinTheAllowlist = (order) => {
    const unexpected = Object.keys(order).filter(
      (k) => !PLAYER_ORDER_FIELDS.includes(k) && k !== 'payTo',
    );
    expect(unexpected, 'fields no player projection declares').toEqual([]);
    for (const field of PLAYER_FORBIDDEN_ORDER_FIELDS) {
      expect(order[field], `${field} reached the player`).toBeUndefined();
    }
  };

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    // Trap 10: this run's orders. A queued one left behind sits ahead of every
    // other suite's cash buy in the assignment queue.
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await closePg();
  });

  it('gives a bank-transfer buy the member\'s bank account and an opaque reference — nothing else', async () => {
    const player = await actor({});
    const orderId = await assignedDeposit(player);

    const res = await as(app, player).get(`/order/${orderId}`);
    expect(res.status).toBe(200);

    // The player CAN pay: the account to transfer to, and "Merchant #7731"
    // to talk to support about.
    expect(res.body.order.paymentMode).toBe('P2P_UPI');
    expect(res.body.order.payTo.bankAccount).toEqual(BANK);
    expect(res.body.order.payTo.merchantRef).toBe('Merchant #7731');
    expect(Object.keys(res.body.order.payTo).sort())
      .toEqual(['bankAccount', 'expiresAt', 'merchantRef']);

    withinTheAllowlist(res.body.order);
    carriesNoCredential(res.body.order, { bankBuy: true });
  });

  it('shows nowhere to pay while the member may still decline, and nothing once the order has ended', async () => {
    // ASSIGNED: the member has not accepted, and may decline or be moved. A
    // transfer made now could reach a member the order then leaves.
    const player = await actor({});
    for (const state of ['ASSIGNED', 'COMPLETED', 'CANCELLED']) {
      const orderId = await assignedDeposit(player, { state });
      const res = await as(app, player).get(`/order/${orderId}`);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.order.payTo ?? {}).sort(), state).toEqual(['expiresAt', 'merchantRef']);
      expect(JSON.stringify(res.body), state).not.toContain(MERCHANT_ACC);
    }
  });

  it('gives a cash buy no account at all: it is paid through the machine', async () => {
    const player = await actor({});
    const orderId = await assignedDeposit(player, { tokens: 1000 });

    const res = await as(app, player).get(`/order/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.order.paymentMode).toBe('CASH_ATM');
    // Before the member scans there is nothing to pay.
    expect(Object.keys(res.body.order.payTo).sort()).toEqual(['expiresAt', 'merchantRef']);
    carriesNoCredential(res.body.order);
  });

  it('gives a sell nothing about the member: the player pays nobody', async () => {
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 50_000, fiatAmountRupees: 50_000, state: 'ASSIGNED',
      userBankDetails: { accountNumber: '000111222333', ifscCode: 'ICIC0000001', bankName: 'ICICI Bank', accountHolderName: 'Asha Rao' },
    });
    await setOrderFields(orderId, { merchantSnapshot: SNAPSHOT });

    const res = await as(app, player).get(`/order/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.order.payTo.bankAccount).toBeUndefined();
    carriesNoCredential(res.body.order);
  });

  it('gives a USDT player the address for THEIR chain, and no other', async () => {
    // The sharpest case on this platform. A merchant may hold an address on
    // both networks; the player chose one. Handing them the other — or both —
    // is how tokens are sent to an address that does not exist on the chain
    // they used, and no support desk recovers that.
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 50_000, fiatAmountRupees: 50_000,
      state: 'PROCESSING', currency: 'USDT', usdtChain: 'BEP20',
    });
    await setOrderFields(orderId, {
      merchantSnapshot: {
        ...SNAPSHOT,
        // What assignment writes: the chain this order named, and the address
        // for it. The stored credentials for BOTH chains are on the row too.
        usdtChain: 'BEP20',
        usdtPayTo: MERCHANT_USDT_BEP20,
        usdtChainLabel: 'BNB Smart Chain (BEP-20)',
      },
    });

    const res = await as(app, player).get(`/order/${orderId}`);
    expect(res.status).toBe(200);

    // They CAN pay: the address and the network it belongs to, together.
    expect(res.body.order.payTo.usdtAddress).toBe(MERCHANT_USDT_BEP20);
    expect(res.body.order.payTo.usdtChain).toBe('BEP20');
    // And the other chain's address is nowhere in the response.
    expect(JSON.stringify(res.body)).not.toContain(MERCHANT_USDT_TRC20);
    withinTheAllowlist(res.body.order);

    // Before the member accepts, not even their own chain's address: USDT sent
    // to a member who then declines is not recoverable.
    const waitingId = oid();
    await createOrderRecord({
      orderId: waitingId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 50_000, fiatAmountRupees: 50_000,
      state: 'ASSIGNED', currency: 'USDT', usdtChain: 'BEP20',
    });
    await setOrderFields(waitingId, {
      merchantSnapshot: { ...SNAPSHOT, usdtChain: 'BEP20', usdtPayTo: MERCHANT_USDT_BEP20, usdtChainLabel: 'BNB Smart Chain (BEP-20)' },
    });
    const waiting = await as(app, player).get(`/order/${waitingId}`);
    expect(waiting.status).toBe(200);
    expect(waiting.body.order.payTo.usdtAddress).toBeUndefined();
    expect(JSON.stringify(waiting.body)).not.toContain(MERCHANT_USDT_BEP20);
  });

  it('keeps the snapshot ON THE ROW for the disputes desk', async () => {
    // The projection is not deletion. A dispute months later is decided from
    // what was true at assignment, so the row keeps every credential and the
    // response carries none of them.
    const player = await actor({});
    const orderId = await assignedDeposit(player);

    const { getOrderRecord } = await import('#db/repositories/orders.record.js');
    const row = await getOrderRecord(orderId);
    expect(row.merchantSnapshot.upiId).toBe(MERCHANT_UPI);
    expect(row.merchantSnapshot.accountNo).toBe(MERCHANT_ACC);
    expect(row.merchantSnapshot.usdtAddressTrc20).toBe(MERCHANT_USDT_TRC20);
    expect(row.merchantSnapshot.usdtAddressBep20).toBe(MERCHANT_USDT_BEP20);
  });

  it('carries nothing forbidden on the poll that fires every few seconds', async () => {
    const player = await actor({});
    const orderId = await assignedDeposit(player);

    const res = await as(app, player).get(`/order/${orderId}/status`);
    expect(res.status).toBe(200);
    expect(res.body.payTo.bankAccount).toEqual(BANK);
    carriesNoCredential(res.body, { bankBuy: true });
    for (const field of PLAYER_FORBIDDEN_ORDER_FIELDS) {
      expect(res.body[field], `${field} reached the player`).toBeUndefined();
    }
  });

  it('holds the whole history to the same shape', async () => {
    const player = await actor({});
    await assignedDeposit(player);
    await assignedDeposit(player);

    const res = await as(app, player).get('/orders?limit=50');
    expect(res.status).toBe(200);
    expect(res.body.orders.length).toBeGreaterThanOrEqual(2);
    for (const order of res.body.orders) {
      withinTheAllowlist(order);
      carriesNoCredential(order, { bankBuy: true });
    }
  });

  it('offers no payTo at all before a merchant is assigned', async () => {
    // Two states that must not look alike. A `payTo` with an empty link is a
    // "pay now" affordance that does nothing — the empty-state-as-success
    // failure this codebase has shipped repeatedly. Absent means absent.
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 800, fiatAmountRupees: 800, state: 'PENDING_QUEUE',
    });

    const res = await as(app, player).get(`/order/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.order.payTo).toBeUndefined();
    withinTheAllowlist(res.body.order);
  });

  it('tells the player their own allocation and their own payout account', async () => {
    // The subset assertion above is the right shape for a leak and passes just
    // as happily when a field the screen needs goes missing. This is the other
    // half: these are the PLAYER'S OWN money and the PLAYER'S OWN bank account,
    // and the sell screen renders the account masked so they can check where
    // their withdrawal is going before it moves.
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 2000, fiatAmountRupees: 2000, state: 'PENDING_QUEUE',
      userBankDetails: {
        accountNumber: '000111222333', ifscCode: 'ICIC0000001',
        bankName: 'ICICI Bank', accountHolderName: 'Asha Rao',
      },
    });

    const res = await as(app, player).get(`/order/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.order.userBankDetails.accountNumber).toBe('000111222333');
    expect(res.body.order.userBankDetails.accountHolderName).toBe('Asha Rao');
  });

  it('refuses the whole snapshot even when a route is handed one directly', async () => {
    // The projection is the gate, not the caller's care. Passing an order that
    // carries the snapshot must produce a view that does not — this is what
    // makes every responder safe by construction rather than by review.
    const { toPlayerOrderView } = await import('../../domains/payment/playerOrderView.js');
    const view = toPlayerOrderView({
      orderId: 'ORD-1', type: 'DEPOSIT', status: 'PROCESSING', tokenAmount: 50_000,
      currency: 'INR', paymentMode: 'P2P_UPI',
      merchantSnapshot: SNAPSHOT,
      merchantId: 'MER-7731',
      merchantProfit: 45,
      redFlagged: true,
      orderHmac: 'deadbeef',
    });
    expect(view.payTo).toEqual({
      merchantRef: 'Merchant #7731',
      bankAccount: BANK,
      expiresAt: SNAPSHOT.expiresAt,
    });
    carriesNoCredential(view, { bankBuy: true });
    for (const field of PLAYER_FORBIDDEN_ORDER_FIELDS) {
      expect(view[field], `${field} survived the projection`).toBeUndefined();
    }
  });
});
