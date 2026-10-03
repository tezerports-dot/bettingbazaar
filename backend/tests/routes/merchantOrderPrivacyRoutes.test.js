// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant never learns who the player is.
 *
 * ── What was shipped ────────────────────────────────────────────────────────
 * The merchant-facing order projection was a DENYLIST. It deleted `userPhone`
 * and `merchantSnapshot`, and it deleted the player's payout destinations only
 * on the DEPOSIT branch:
 *
 *     if (plain.type === 'DEPOSIT') { delete plain.userBankDetails; delete plain.upiId; … }
 *
 * So on every WITHDRAWAL the merchant received `userBankDetails.upiId`, which
 * `paymentProcessing.service.js` copies straight from `user.bankDetails.upiId`.
 * The merchant panel had a render waiting for it — OrderCard's "Send to user
 * UPI" — and its order search matched on `order.userPhone`, so a merchant could
 * look a player up by phone number. Every check in the repository was green.
 *
 * ── Why these assertions are shaped this way ────────────────────────────────
 * Asserting "userPhone is absent" one field at a time is the denylist again,
 * written as a test: it only ever refuses what somebody remembered. So the
 * assertions here are CLOSED — the response's key set must be a subset of the
 * declared allowlist, and the bank object's key set a subset of the four
 * permitted fields. A new PII column reaching a merchant fails this without
 * anybody adding a line.
 *
 * Driven through the real router against a real database. The projection is a
 * pure function and could be tested in isolation, but that would prove only
 * that the function is correct — not that the handler calls it, which is the
 * half that was actually broken.
 *
 * ── Every order is one the platform can produce (§32 S16, Step 2c) ───────────
 * A sell is the player's own withdrawal — `createWithdrawalOrder`, which copies
 * the player's bank details (UPI id included) and mobile onto the row — routed
 * to the one online member of a working team and accepted through the
 * member's panel. A buy is created queued with its split and routed the same
 * way. Nothing is planted on a row: the phone number and the UPI id this
 * suite looks for are the ones production itself writes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import { tryAssignMerchant, createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import {
  MERCHANT_ORDER_FIELDS, MERCHANT_BANK_FIELDS, MERCHANT_FORBIDDEN_ORDER_FIELDS, toMerchantOrderView,
} from '../../domains/merchant/merchantOrderView.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, merchantActor, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('what a merchant is told about a player', () => {
  let app;
  let seq = 0;
  const oid = () => `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const teams = teamFixture();
  const players = [];

  // The player's payout account, as they save it — including the UPI id a
  // merchant must never see.
  const PLAYER_UPI = 'asha@examplebank';
  const BANK = {
    accountNumber: '000111222333',
    ifscCode: 'HDFC0000001',
    bankName: 'HDFC Bank',
    accountHolderName: 'Asha Rao',
    upiId: PLAYER_UPI,
  };

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await c.query('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    });
    await teams.cleanup();
    await closePg();
  });

  /** A player with a saved payout account, whose mobile is their phone number. */
  const player = async () => {
    const who = await actor({});
    players.push(who.userId);
    await updateUser(who.userId, { bankDetails: BANK });
    return who;
  };

  // Members come in tens — a team works only at ten (2a) — and each test takes
  // ones nobody has used.
  const bench = { CASH: [], UPI_BANK: [] };
  const member = async (rail) => {
    if (!bench[rail].length) {
      const ms = [];
      for (let i = 0; i < 10; i += 1) ms.push(await merchantActor());
      await teams.workingTeam({ rail, poolTokens: 100_000, include: ms.map((m) => m.merchantId) });
      bench[rail].push(...ms);
    }
    return bench[rail].shift();
  };

  const accept = async (merchant, orderId) => {
    const res = await as(app, merchant).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);
  };

  /** The player's own withdrawal, routed to `merchant` and accepted: PROCESSING. */
  const withdrawalFor = async (merchant, who, tokens = 1_000) => {
    seq += 1;
    await creditWinnings(who.userId, tokens, 'privacy suite float', 'Test',
      `seed_${who.userId}`, `mpriv_seed_${who.userId}_${seq}`);
    await teams.onlyOnline([merchant.merchantId]);
    const { order } = await createWithdrawalOrder(who.userId, tokens);
    const orderId = order.orderId ?? order._id;
    const row = await getOrderRecord(orderId);
    expect(row.merchantId, 'the sell was not routed to the member').toBe(String(merchant.merchantId));
    // What production put on the row — the two things the merchant must not see.
    expect(row.userPhone).toBe(who.mobile);
    expect(row.userBankDetails.upiId).toBe(PLAYER_UPI);
    await accept(merchant, orderId);
    return orderId;
  };

  /** A buy, queued with its split, routed to `merchant` and accepted: PROCESSING. */
  const depositFor = async (merchant, who, tokens = 50_000) => {
    const orderId = oid();
    const order = await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens,
      depositAllocation: tokens, reserveAllocation: 0,
    });
    await teams.onlyOnline([merchant.merchantId]);
    expect(await tryAssignMerchant(order), 'the buy was not routed to the member').toBe(true);
    await accept(merchant, orderId);
    return orderId;
  };

  it('sends the payout bank account and the name on it, and nothing else that identifies the player', async () => {
    const merchant = await member('CASH');
    const who = await player();
    const orderId = await withdrawalFor(merchant, who);

    const res = await as(app, merchant).get('/orders?type=WITHDRAWAL');
    expect(res.status).toBe(200);

    const order = res.body.orders.find((o) => o.orderId === orderId);
    expect(order).toBeTruthy();

    // The merchant CAN pay the player: they have the account and the name.
    expect(order.userBankDetails.accountNumber).toBe('000111222333');
    expect(order.userBankDetails.accountHolderName).toBe('Asha Rao');

    // The bank object carries the four permitted fields and no fifth. This is
    // the assertion the old projection failed: `upiId` rode along inside it.
    expect(Object.keys(order.userBankDetails).sort())
      .toEqual([...MERCHANT_BANK_FIELDS].sort());

    // And the whole payload is a subset of what was declared — closed, so a
    // column added to order_states cannot arrive here unnoticed.
    const unexpected = Object.keys(order).filter(
      (k) => !MERCHANT_ORDER_FIELDS.includes(k) && k !== 'userBankDetails',
    );
    expect(unexpected).toEqual([]);
  });

  it('tells the merchant which rail the order was BORN on', async () => {
    // The allowlist is a SUBSET assertion, which is the right shape for a
    // leak — but it passes just as happily when a field the panel needs goes
    // missing. This is the other half: the merchant panel branches its whole
    // workflow on this value — a UTR against their own account, or cash at a
    // machine — and it is the ORDER's, derived from its size when it was
    // created (`paymentModeFor`). Without it the panel guesses, and asks for a
    // UTR on a payout that is settled at a machine.
    const merchant = await member('CASH');
    const who = await player();
    // ₹1,000 is a cash amount: the order is born on the CASH rail.
    const orderId = await withdrawalFor(merchant, who, 1_000);
    expect((await getOrderRecord(orderId)).paymentMode).toBe('CASH_ATM');

    const res = await as(app, merchant).get('/orders?type=WITHDRAWAL');
    expect(res.status).toBe(200);
    const order = res.body.orders.find((o) => o.orderId === orderId);
    expect(order).toBeTruthy();
    expect(order.paymentMode).toBe('CASH_ATM');
  });

  it('names none of the forbidden fields, on either direction', async () => {
    // A UPI member: one member holding a buy AND a sell is a UPI_BANK member's
    // ordinary day (cap 3), never a cash member's.
    const merchant = await member('UPI_BANK');
    const who = await player();
    await withdrawalFor(merchant, who, 50_000);
    await depositFor(merchant, await player());

    const res = await as(app, merchant).get('/orders');
    expect(res.status).toBe(200);
    expect(res.body.orders.length).toBeGreaterThanOrEqual(2);
    expect(new Set(res.body.orders.map((o) => o.type))).toEqual(new Set(['DEPOSIT', 'WITHDRAWAL']));

    for (const order of res.body.orders) {
      for (const field of MERCHANT_FORBIDDEN_ORDER_FIELDS) {
        expect(order[field]).toBeUndefined();
      }
      // Serialised anywhere in the payload, under any key, nested or not.
      const body = JSON.stringify(order);
      expect(body).not.toContain(who.mobile);
      expect(body).not.toContain(PLAYER_UPI);
    }
  });

  it('gives a deposit merchant no payout destination at all', async () => {
    // Money comes IN on a deposit. There is nowhere for the merchant to send
    // anything, so the account the player withdraws to is not part of the job.
    // This player HAS one saved — the one a withdrawal would copy.
    const merchant = await member('UPI_BANK');
    const who = await player();
    const orderId = await depositFor(merchant, who);

    const res = await as(app, merchant).get('/orders?type=DEPOSIT');
    expect(res.status).toBe(200);
    const mine = res.body.orders.find((o) => o.orderId === orderId);
    expect(mine).toBeTruthy();
    for (const order of res.body.orders) {
      expect(order.userBankDetails).toBeUndefined();
    }

    // ── The projection's own rule, for an input no buy carries today ────────
    // Only `createWithdrawalOrder` writes a bank object, so through the route
    // a deposit has none to leak and the case above would pass whether or not
    // the projection checked the direction. The direction rule is the defence
    // for the day something does copy one onto a buy, so it is asserted on the
    // projection itself: this very row, as the database returned it, with the
    // player's saved account added — rather than by writing a row production
    // cannot make (§32 S16).
    const row = await getOrderRecord(orderId);
    const view = toMerchantOrderView({ ...row, userBankDetails: BANK });
    expect(view.type).toBe('DEPOSIT');
    expect(view.userBankDetails, 'a buy carried the player payout account to the merchant').toBeUndefined();
  });
});
