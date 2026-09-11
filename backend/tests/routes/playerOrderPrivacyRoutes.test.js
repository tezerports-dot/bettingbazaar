// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A player never learns who the merchant is.
 *
 * ── What was shipped ────────────────────────────────────────────────────────
 * `merchantOrderView.js` protected the player from the merchant. NOTHING
 * protected the merchant from the player. `buildMerchantSnapshot` writes the
 * merchant's UPI handle, their QR image, their bank name, account number, IFSC,
 * account-holder name and their USDT settlement address onto the order — and
 * every player-facing response passed the whole object through:
 *
 *     order creation · GET /order/:id · the dispute response · the assignment
 *     socket push · and the STATUS POLL, which fires every few seconds
 *
 * The player's screen rendered the handle in a copy-to-clipboard row. A player
 * could read, copy and keep a merchant's bank account from a single deposit.
 *
 * ── Why these assertions are shaped this way ────────────────────────────────
 * "merchantSnapshot is absent" one field at a time is a denylist written as a
 * test. So the assertions are CLOSED: the response's key set must be a SUBSET
 * of `PLAYER_ORDER_FIELDS` (plus `payTo`), and the `payTo` object's keys a
 * subset of the three it may carry. A column added to `order_states` and mapped
 * by `toOrder` cannot reach a player without failing this, and nobody has to
 * remember to add a line.
 *
 * Driven through the real routers against a real database, for the reason its
 * mirror is: the projection is a pure function, and testing it in isolation
 * would prove only that the function is right — not that the handler calls it,
 * which is the half that was broken.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import {
  PLAYER_ORDER_FIELDS, PLAYER_FORBIDDEN_ORDER_FIELDS,
} from '../../domains/payment/playerOrderView.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('what a player is told about a merchant', () => {
  let app;
  let seq = 0;
  const oid = () => `pp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  // Every credential `buildMerchantSnapshot` puts on the row. The row KEEPS
  // them — a dispute months later is decided from what was true at assignment —
  // and the projection is what refuses to pass them on.
  const MERCHANT_UPI  = 'ravi@okhdfcbank';
  const MERCHANT_ACC  = '50100123456789';
  const MERCHANT_IFSC = 'HDFC0000123';
  const MERCHANT_NAME = 'Ravi Kumar';
  // BOTH chains. A merchant may hold an address on each, and a player is
  // entitled to the one THEIR order named and nothing else — so the fixture
  // carries both and the assertions below refuse both as stored columns.
  const MERCHANT_USDT_TRC20 = 'TQ5NMqJjW8sT1u9dCUnMcGbmVpFmvbwrsi';
  const MERCHANT_USDT_BEP20 = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0';
  // The QR was REMOVED from the platform on 2026-09-10 — a merchant supplies a
  // UPI ID and `upiPaymentLink()` builds a dynamic intent per order. This value
  // deliberately STAYS in the fixture: it is now a regression guard rather than
  // a live field. The player projection is an ALLOWLIST (§24.1), so the property
  // being proved is that an unknown key planted in the snapshot is dropped —
  // which is exactly what must still hold if anybody ever puts a QR back.
  const MERCHANT_QR   = 'https://cdn.example/qr/ravi.png';

  const SNAPSHOT = {
    merchantRef: 'Merchant #7731',
    paymentLink: 'upi://pay?pa=ravi%40okhdfcbank&pn=Merchant+%237731&am=1500.00&cu=INR',
    merchantId: 'MER-7731',
    merchantName: 'Merchant #7731',
    merchantType: 'INR',
    upiId: MERCHANT_UPI,
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

  /** An assigned deposit carrying the full snapshot, exactly as assignment writes it. */
  const assignedDeposit = async (player, extra = {}) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 1500, fiatAmountRupees: 1500,
      state: 'ASSIGNED',
      ...extra,
    });
    await setOrderFields(orderId, {
      merchantSnapshot: SNAPSHOT,
      expiresAt: new Date(Date.now() + 900_000),
    });
    return orderId;
  };

  /** Every credential that must never appear, in any form, anywhere. */
  const CREDENTIALS = [
    MERCHANT_UPI, MERCHANT_ACC, MERCHANT_IFSC, MERCHANT_NAME,
    MERCHANT_USDT_TRC20, MERCHANT_USDT_BEP20, MERCHANT_QR,
  ];

  const carriesNoCredential = (payload) => {
    const body = JSON.stringify(payload);
    for (const secret of CREDENTIALS) {
      // `paymentLink` is the one place a handle may appear: it IS the payment
      // instruction, and a `upi://pay` intent carries the payee by protocol.
      const withoutLink = body.replace(/"paymentLink":"[^"]*"/g, '"paymentLink":""');
      expect(withoutLink, `${secret} reached the player`).not.toContain(secret);
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

  afterAll(async () => { await closePg(); });

  it('gives a payment link and an opaque reference — not the merchant', async () => {
    const player = await actor({});
    const orderId = await assignedDeposit(player);

    const res = await as(app, player).get(`/order/${orderId}`);
    expect(res.status).toBe(200);

    // The player CAN pay: they have the link and can talk to support about
    // "Merchant #7731" without knowing who that is.
    expect(res.body.order.payTo.paymentLink).toBe(SNAPSHOT.paymentLink);
    expect(res.body.order.payTo.merchantRef).toBe('Merchant #7731');
    expect(Object.keys(res.body.order.payTo).sort())
      .toEqual(['expiresAt', 'merchantRef', 'paymentLink']);

    withinTheAllowlist(res.body.order);
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
      state: 'ASSIGNED', currency: 'USDT', usdtChain: 'BEP20',
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
    expect(res.body.payTo.paymentLink).toBe(SNAPSHOT.paymentLink);
    carriesNoCredential(res.body);
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
      carriesNoCredential(order);
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
      orderId: 'ORD-1', status: 'ASSIGNED', tokenAmount: 1500,
      merchantSnapshot: SNAPSHOT,
      merchantId: 'MER-7731',
      merchantProfit: 45,
      redFlagged: true,
      orderHmac: 'deadbeef',
      cdmReceiptUrl: 'https://cdn/slip.png',
    });
    expect(view.payTo).toEqual({
      merchantRef: 'Merchant #7731',
      paymentLink: SNAPSHOT.paymentLink,
      expiresAt: SNAPSHOT.expiresAt,
    });
    carriesNoCredential(view);
    for (const field of PLAYER_FORBIDDEN_ORDER_FIELDS) {
      expect(view[field], `${field} survived the projection`).toBeUndefined();
    }
  });
});
