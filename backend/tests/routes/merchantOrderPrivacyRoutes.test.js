// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord } from '#db/repositories/orders.record.js';
import {
  MERCHANT_ORDER_FIELDS, MERCHANT_BANK_FIELDS, MERCHANT_FORBIDDEN_ORDER_FIELDS,
} from '../../domains/merchant/merchantOrderView.js';
import { mountRouter, merchantActor, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('what a merchant is told about a player', () => {
  let app;
  let seq = 0;
  const oid = () => `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  // Everything paymentProcessing.service.js actually writes onto a withdrawal,
  // including the two fields a merchant must never see.
  const PLAYER_PHONE = '9876500011';
  const PLAYER_UPI   = 'asha@examplebank';

  const withdrawalFor = async (merchant, player, state = 'PROCESSING') => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000,
      state, merchantId: merchant.merchantId,
      userPhone: PLAYER_PHONE,
      userBankDetails: {
        accountNumber: '000111222333',
        ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank',
        accountHolderName: 'Asha Rao',
        upiId: PLAYER_UPI,
      },
      userUsdtAddress: 'TQ5NMqJjW8sT1u9dCUnMcGbmVpFmvbwrsi',
    });
    return orderId;
  };

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  it('sends the payout bank account and the name on it, and nothing else that identifies the player', async () => {
    const merchant = await merchantActor({});
    const player = await actor({});
    await withdrawalFor(merchant, player);

    const res = await as(app, merchant).get('/orders?type=WITHDRAWAL');
    expect(res.status).toBe(200);

    const order = res.body.orders.find((o) => o.userBankDetails);
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

  it('names none of the forbidden fields, on either direction', async () => {
    const merchant = await merchantActor({});
    const player = await actor({});
    await withdrawalFor(merchant, player);
    await createOrderRecord({
      orderId: oid(), userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500,
      state: 'PROCESSING', merchantId: merchant.merchantId,
      userPhone: PLAYER_PHONE,
    });

    const res = await as(app, merchant).get('/orders');
    expect(res.status).toBe(200);
    expect(res.body.orders.length).toBeGreaterThanOrEqual(2);

    for (const order of res.body.orders) {
      for (const field of MERCHANT_FORBIDDEN_ORDER_FIELDS) {
        expect(order[field]).toBeUndefined();
      }
      // Serialised anywhere in the payload, under any key, nested or not.
      const body = JSON.stringify(order);
      expect(body).not.toContain(PLAYER_PHONE);
      expect(body).not.toContain(PLAYER_UPI);
    }
  });

  it('gives a deposit merchant no payout destination at all', async () => {
    const merchant = await merchantActor({});
    const player = await actor({});
    await createOrderRecord({
      orderId: oid(), userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 750, fiatAmountRupees: 750,
      state: 'PROCESSING', merchantId: merchant.merchantId,
      userBankDetails: { accountNumber: '999888777666', accountHolderName: 'Asha Rao' },
    });

    const res = await as(app, merchant).get('/orders?type=DEPOSIT');
    expect(res.status).toBe(200);
    // Money comes IN on a deposit. There is nowhere for the merchant to send
    // anything, so the account the player withdraws to is not part of the job.
    for (const order of res.body.orders) {
      expect(order.userBankDetails).toBeUndefined();
    }
  });
});
