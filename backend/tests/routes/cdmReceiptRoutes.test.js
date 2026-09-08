// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The CDM receipt: written by a merchant, readable only by an admin.
 *
 * ── What the receipt is, and why it is handled this way ────────────────────
 * On the cash rail a payout is settled by the merchant depositing cash at a
 * Cash Deposit Machine into the player's bank account. The slip carries an
 * account number, a branch, a timestamp and a bank transaction reference — the
 * strongest evidence in a dispute and the least appropriate thing to hand back
 * to either party.
 *
 * So it is WRITE-ONLY: not even the merchant who uploaded it can read it again.
 *
 * ── Why the assertions are shaped as absence ───────────────────────────────
 * The enforcement is that `toOrder` never maps these columns, and every
 * projection on this platform is built from that mapper. So the tests do not
 * check "the endpoint strips it" — they check the receipt cannot be found in
 * any response either party can obtain, which is the property that actually
 * holds and the one that survives somebody adding a new endpoint.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord, getCdmReceipt } from '#db/repositories/orders.record.js';
import {
  PAYMENT_MODES, getActivePolicy, publishPolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// The S3 boundary, stubbed so the ROUTE's rules are what is under test. Whether
// S3 stores bytes is cdn.service's own concern and has its own coverage; the
// arguments this route passes are what bind a receipt to one merchant and one
// order, and those ARE asserted.
const cdn = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../../services/cdn.service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual.default, verifyUploadedObject: cdn.verify } };
});

describePg('the CDM receipt', () => {
  let merchantApp;
  let adminApp;
  let restore = null;
  let seq = 0;
  const oid = () => `cdm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  const RECEIPT_URL = 'https://cdn.test/cdm-receipt/slip.jpg';
  const TXN = 'HDFCN12345678';
  const good = { transactionId: TXN, receiptFileKey: 'cdm-receipt/slip.jpg', receiptCdnUrl: RECEIPT_URL };

  const payout = async (merchant, player, state = 'COMPLETED') => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 5000, fiatAmountRupees: 5000,
      state, merchantId: merchant.merchantId,
      completedAt: state === 'COMPLETED' ? new Date() : undefined,
    });
    return orderId;
  };

  beforeAll(async () => {
    await applySchema();
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    adminApp = mountRouter((await import('../../routes/admin/index.js')).default);
    restore = await getActivePolicy();
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      justification: 'CDM receipt suite.', changedByName: 'test setup',
    });
  }, 60_000);

  afterAll(async () => {
    if (restore) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        justification: 'Restoring the rail this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    await closePg();
  });

  it('records a receipt bound to this merchant and this order', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: good.receiptFileKey });
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await payout(merchant, player);

    const res = await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`).send(good);
    expect(res.status).toBe(200);

    // The verification arguments are what stop a merchant naming a key they
    // never uploaded, or one staged against a different order.
    expect(cdn.verify).toHaveBeenCalledWith(expect.objectContaining({
      expectedUserId: String(merchant.merchantId),
      expectedOrderId: orderId,
      expectedCategory: 'cdm-receipt',
    }));

    const stored = await getCdmReceipt(orderId);
    expect(stored.transactionId).toBe(TXN);
    expect(stored.receiptUrl).toBe(RECEIPT_URL);
  });

  it('never returns the receipt to the merchant who uploaded it', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: good.receiptFileKey });
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await payout(merchant, player);

    const submit = await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`).send(good);
    expect(submit.status).toBe(200);
    // They are told WHAT was accepted — that confirmation is the only look they
    // get, because they cannot open it again.
    expect(submit.body.submitted.transactionId).toBe(TXN);
    // But never the image itself, even in the response that accepted it.
    expect(JSON.stringify(submit.body)).not.toContain(RECEIPT_URL);

    // And not from any order read they can make afterwards.
    const list = await as(merchantApp, merchant).get('/orders?type=WITHDRAWAL');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(RECEIPT_URL);
  });

  it('keeps it out of the order record every projection is built from', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: good.receiptFileKey });
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await payout(merchant, player);
    await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`).send(good);

    // This is the property the whole design rests on: `toOrder` does not map
    // the receipt, so nothing built from it — merchant view, player order read,
    // admin panel, a route nobody has written yet — can carry it.
    const record = await getOrderRecord(orderId);
    expect(JSON.stringify(record)).not.toContain(RECEIPT_URL);
    expect(JSON.stringify(record)).not.toContain(TXN);
  });

  it('gives it to an admin, and records that they looked', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: good.receiptFileKey });
    const merchant = await merchantActor({});
    const player = await actor({});
    const admin = await actor({ isAdmin: true });
    const orderId = await payout(merchant, player);
    await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`).send(good);

    const res = await as(adminApp, admin).get(`/orders/${orderId}/cdm-receipt`);
    expect(res.status).toBe(200);
    expect(res.body.receipt.receiptUrl).toBe(RECEIPT_URL);
    expect(res.body.receipt.transactionId).toBe(TXN);
  });

  it('refuses it to a sub-admin without the disputes permission', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: good.receiptFileKey });
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await payout(merchant, player);
    await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`).send(good);

    const other = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
    const res = await as(adminApp, other).get(`/orders/${orderId}/cdm-receipt`);
    expect(res.status).toBe(403);

    // The disputes manager IS allowed — deciding these is their job.
    const dm = await actor({ isSubAdmin: true, permissions: { canResolveDisputes: true } });
    const allowed = await as(adminApp, dm).get(`/orders/${orderId}/cdm-receipt`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.receipt.receiptUrl).toBe(RECEIPT_URL);
  });

  it('refuses a transaction id with no image, and an image with no id', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: good.receiptFileKey });
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await payout(merchant, player);

    const noImage = await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`)
      .send({ transactionId: TXN });
    expect(noImage.status).toBe(400);
    expect(noImage.body.reason).toBe('RECEIPT_REQUIRED');

    const noId = await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`)
      .send({ receiptFileKey: good.receiptFileKey });
    expect(noId.status).toBe(400);
    expect(noId.body.reason).toBe('TRANSACTION_ID_REQUIRED');

    // A refusal stores NOTHING — a half-recorded receipt is evidence nobody
    // can match against a statement.
    expect(await getCdmReceipt(orderId)).toBeNull();
  });

  it('will not let one merchant attach a receipt to another\'s order', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: good.receiptFileKey });
    const owner = await merchantActor({});
    const other = await merchantActor({});
    const player = await actor({});
    const orderId = await payout(owner, player);

    const res = await as(merchantApp, other).post(`/orders/${orderId}/cdm-receipt`).send(good);
    expect(res.status).toBe(404);
    expect(await getCdmReceipt(orderId)).toBeNull();
  });

  it('says plainly when no receipt has been submitted, rather than erroring', async () => {
    // A settled order with no receipt is expected: the confirm completes the
    // order and the evidence follows. An error here would make a normal state
    // look like a fault.
    const merchant = await merchantActor({});
    const player = await actor({});
    const admin = await actor({ isAdmin: true });
    const orderId = await payout(merchant, player);

    const res = await as(adminApp, admin).get(`/orders/${orderId}/cdm-receipt`);
    expect(res.status).toBe(200);
    expect(res.body.receipt).toBeNull();
  });

  it('lists payouts that were settled and never evidenced', async () => {
    const merchant = await merchantActor({});
    const player = await actor({});
    const admin = await actor({ isAdmin: true });
    const orderId = await payout(merchant, player);

    // A merchant appearing here repeatedly is asserting payments they are not
    // evidencing — which nothing would otherwise notice, because a missing
    // receipt does not block the player.
    const res = await as(adminApp, admin).get('/orders/cdm-receipts/missing?olderThanMinutes=0');
    expect(res.status).toBe(200);
    expect(res.body.orders.map((o) => o.orderId)).toContain(orderId);
  });
});
