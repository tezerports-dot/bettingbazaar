// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
 *
 * ── How a payout reaches the state a slip is owed for (§3.10, 2c) ──────────
 * Through the real path, so the row is one the platform can produce (§32
 * S16): the player's ₹5,000 withdrawal is a CASH order by its size, it is
 * ROUTED to the one online member of a working CASH team, the member accepts
 * and confirms through their own routes, and — with the withdrawal hold set to
 * zero for this suite — the confirm settles it there and then: the team pool
 * is credited, the player's stake consumed, the order COMPLETED.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getOrderRecord, getCdmReceipt } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { PAYMENT_MODES } from '#db/repositories/teamRouting.js';
import { createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
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
  const teams = teamFixture();
  let merchantApp;
  let adminApp;
  let restoreHold = null;
  const players = [];
  // The members of one working CASH team. A cash member holds ONE open order
  // at a time, and every payout here completes before the next is made — so
  // they are handed out in turn and reused.
  const members = [];
  let turn = 0;
  const nextMember = () => members[(turn++) % members.length];

  const RECEIPT_URL = 'https://cdn.test/cdm-receipt/slip.jpg';
  /**
   * A DIFFERENT bank reference every time, and different across runs.
   *
   * The slip's transaction id is claimed in the same registry as a UTR, so it
   * belongs to exactly one order — for good. A shared constant made the second
   * test in the file a duplicate claim, and a constant of any kind would
   * collide with the previous RUN, because `utr_registry` is append-only and
   * this database is never reset between suites (trap 10).
   */
  const txn = () => `HDFCN${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
  const slip = (transactionId = txn()) => ({
    transactionId, receiptFileKey: 'cdm-receipt/slip.jpg', receiptCdnUrl: RECEIPT_URL,
  });

  /**
   * A ₹5,000 cash payout served by `merchant`: COMPLETED (the slip is owed), or
   * left at PROCESSING (accepted, the cash not yet deposited).
   */
  const payout = async (merchant, state = 'COMPLETED') => {
    const player = await actor({});
    players.push(player.userId);
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(player.userId, 5000, 'CDM receipt suite seed', 'Test',
      `seed_${player.userId}`, `cdm_seed_${player.userId}`);
    await teams.onlyOnline([merchant.merchantId]);
    const { order } = await createWithdrawalOrder(player.userId, 5000);
    const orderId = order.orderId ?? order._id;
    const routed = await getOrderRecord(orderId);
    expect(routed.merchantId, 'the payout was not routed to the member').toBe(String(merchant.merchantId));
    expect(routed.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
    expect((await as(merchantApp, merchant).post(`/accept/${orderId}`).send({})).status).toBe(200);
    if (state === 'COMPLETED') {
      const confirmed = await as(merchantApp, merchant).post(`/confirm/${orderId}`).send({});
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect((await getOrderRecord(orderId)).status).toBe('COMPLETED');
    }
    return { orderId, player };
  };

  beforeAll(async () => {
    await applySchema();
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    adminApp = mountRouter((await import('../../routes/admin/index.js')).default);
    for (let i = 0; i < 6; i += 1) members.push(await merchantActor({}));
    await teams.workingTeam({ rail: 'CASH', include: members.map((m) => m.merchantId) });
    // The hold switched off (admin-editable down to 0): the confirm settles the
    // payout itself, which is the moment a slip becomes owed. Put back after,
    // outside any assertion — the config row is shared by every suite (trap 10).
    restoreHold = (await getSystemConfig({ fresh: true }))?.withdrawalHoldMinutes ?? null;
    await applySystemConfig({ withdrawalHoldMinutes: 0 });
  }, 120_000);

  afterAll(async () => {
    if (restoreHold !== null) await applySystemConfig({ withdrawalHoldMinutes: restoreHold });
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await pgQuery('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await teams.cleanup();
    await closePg();
  });

  it('records a receipt bound to this merchant and this order', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: 'cdm-receipt/slip.jpg' });
    const good = slip();
    const merchant = nextMember();
    const orderId = (await payout(merchant)).orderId;

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
    expect(stored.transactionId).toBe(good.transactionId);
    expect(stored.receiptUrl).toBe(RECEIPT_URL);
  });

  it('REFUSES a bank transaction id already used on another payout', async () => {
    // A CDM slip's transaction id is a bank's reference for ONE real cash
    // deposit, exactly as a UTR is for one real transfer. It was recorded and
    // never claimed, so the same slip could be presented as proof of two
    // payouts — one deposit, two players marked paid.
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: 'cdm-receipt/slip.jpg' });
    const good = slip();
    const merchant = nextMember();

    const first = (await payout(merchant)).orderId;
    expect((await as(merchantApp, merchant).post(`/orders/${first}/cdm-receipt`).send(good)).status).toBe(200);

    const second = (await payout(merchant)).orderId;
    const res = await as(merchantApp, merchant).post(`/orders/${second}/cdm-receipt`).send(good);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('DUPLICATE_UTR');
    // WHICH payout already holds it — support answering "it says already used"
    // needs this without a second lookup.
    expect(res.body.originalOrderId).toBe(first);
    expect(res.body.message).toMatch(/already been used/i);

    // And the second payout has NO receipt: a refused claim leaves nothing.
    expect(await getCdmReceipt(second)).toBeFalsy();
  });

  it('never returns the receipt to the merchant who uploaded it', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: 'cdm-receipt/slip.jpg' });
    const good = slip();
    const merchant = nextMember();
    const orderId = (await payout(merchant)).orderId;

    const submit = await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`).send(good);
    expect(submit.status).toBe(200);
    // They are told WHAT was accepted — that confirmation is the only look they
    // get, because they cannot open it again.
    expect(submit.body.submitted.transactionId).toBe(good.transactionId);
    // But never the image itself, even in the response that accepted it.
    expect(JSON.stringify(submit.body)).not.toContain(RECEIPT_URL);

    // And not from any order read they can make afterwards.
    const list = await as(merchantApp, merchant).get('/orders?type=WITHDRAWAL');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(RECEIPT_URL);
  });

  it('keeps it out of the order record every projection is built from', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: 'cdm-receipt/slip.jpg' });
    const good = slip();
    const merchant = nextMember();
    const orderId = (await payout(merchant)).orderId;
    await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`).send(good);

    // This is the property the whole design rests on: `toOrder` does not map
    // the receipt, so nothing built from it — merchant view, player order read,
    // admin panel, a route nobody has written yet — can carry it.
    const record = await getOrderRecord(orderId);
    expect(JSON.stringify(record)).not.toContain(RECEIPT_URL);
    expect(JSON.stringify(record)).not.toContain(good.transactionId);
  });

  it('gives it to an admin, and records that they looked', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: 'cdm-receipt/slip.jpg' });
    const good = slip();
    const merchant = nextMember();
    const admin = await actor({ isAdmin: true });
    const orderId = (await payout(merchant)).orderId;
    await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`).send(good);

    const res = await as(adminApp, admin).get(`/orders/${orderId}/cdm-receipt`);
    expect(res.status).toBe(200);
    expect(res.body.receipt.receiptUrl).toBe(RECEIPT_URL);
    expect(res.body.receipt.transactionId).toBe(good.transactionId);
  });

  it('refuses it to a sub-admin without the disputes permission', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: 'cdm-receipt/slip.jpg' });
    const good = slip();
    const merchant = nextMember();
    const orderId = (await payout(merchant)).orderId;
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
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: 'cdm-receipt/slip.jpg' });
    const good = slip();
    const merchant = nextMember();
    const orderId = (await payout(merchant)).orderId;

    const noImage = await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`)
      .send({ transactionId: txn() });
    expect(noImage.status).toBe(400);
    expect(noImage.body.reason).toBe('RECEIPT_REQUIRED');

    const noId = await as(merchantApp, merchant).post(`/orders/${orderId}/cdm-receipt`)
      .send({ receiptFileKey: 'cdm-receipt/slip.jpg' });
    expect(noId.status).toBe(400);
    expect(noId.body.reason).toBe('TRANSACTION_ID_REQUIRED');

    // A refusal stores NOTHING — a half-recorded receipt is evidence nobody
    // can match against a statement.
    expect(await getCdmReceipt(orderId)).toBeNull();
  });

  it('will not let one merchant attach a receipt to another\'s order', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: 'cdm-receipt/slip.jpg' });
    const good = slip();
    const owner = nextMember();
    const other = nextMember();
    const orderId = (await payout(owner)).orderId;

    const res = await as(merchantApp, other).post(`/orders/${orderId}/cdm-receipt`).send(good);
    expect(res.status).toBe(404);
    expect(await getCdmReceipt(orderId)).toBeNull();
  });

  it('says plainly when no receipt has been submitted, rather than erroring', async () => {
    // A settled order with no receipt is expected: the confirm completes the
    // order and the evidence follows. An error here would make a normal state
    // look like a fault.
    const merchant = nextMember();
    const admin = await actor({ isAdmin: true });
    const orderId = (await payout(merchant)).orderId;

    const res = await as(adminApp, admin).get(`/orders/${orderId}/cdm-receipt`);
    expect(res.status).toBe(200);
    expect(res.body.receipt).toBeNull();
  });

  it('tells a merchant which of their own payouts still needs a slip', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: RECEIPT_URL, fileKey: 'cdm-receipt/slip.jpg' });
    const good = slip();
    const merchant = nextMember();

    const owed = (await payout(merchant)).orderId;
    const evidenced = (await payout(merchant)).orderId;
    await as(merchantApp, merchant).post(`/orders/${evidenced}/cdm-receipt`).send(good);

    // The confirm COMPLETES the order and the slip is chased afterwards, so
    // the moment to submit passes — a failed upload or an app closed at the
    // machine otherwise leaves the payout gone from every screen the merchant
    // has, and the admin queue fills with items only they can clear.
    const res = await as(merchantApp, merchant).get('/cdm-receipts/outstanding');
    expect(res.status).toBe(200);
    const ids = res.body.outstanding.map((o) => o.orderId);
    expect(ids).toContain(owed);
    // One they HAVE evidenced leaves the list. That disappearance is the only
    // other confirmation they ever get, because they cannot read it back.
    expect(ids).not.toContain(evidenced);
  });

  it('never re-identifies the player through the list of slips owed', async () => {
    const merchant = nextMember();
    const { orderId: owed, player } = await payout(merchant);

    const res = await as(merchantApp, merchant).get('/cdm-receipts/outstanding');
    expect(res.status).toBe(200);
    const row = res.body.outstanding.find((o) => o.orderId === owed);
    // Three facts: which payout, how much cash, when it completed. A list of
    // paperwork owed is not an occasion to hand back the player's identity, and
    // the safest identity is the one never read.
    expect(Object.keys(row).sort()).toEqual(['completedAt', 'fiatAmount', 'orderId']);
    expect(JSON.stringify(res.body)).not.toContain(String(player.userId));
  });

  it('shows a merchant only their OWN outstanding slips', async () => {
    const owner = nextMember();
    const other = nextMember();
    const orderId = (await payout(owner)).orderId;

    const res = await as(merchantApp, other).get('/cdm-receipts/outstanding');
    expect(res.status).toBe(200);
    expect(res.body.outstanding.map((o) => o.orderId)).not.toContain(orderId);
  });

  it('does not chase a slip for a payout that has not completed', async () => {
    const merchant = nextMember();
    // PROCESSING — the merchant has not said the cash is in the account yet, so
    // there is no deposit to have a slip for.
    const { orderId: open } = await payout(merchant, 'PROCESSING');

    const res = await as(merchantApp, merchant).get('/cdm-receipts/outstanding');
    expect(res.status).toBe(200);
    expect(res.body.outstanding.map((o) => o.orderId)).not.toContain(open);
  });

  it('lists payouts that were settled and never evidenced', async () => {
    const merchant = nextMember();
    const admin = await actor({ isAdmin: true });
    const orderId = (await payout(merchant)).orderId;

    // A merchant appearing here repeatedly is asserting payments they are not
    // evidencing — which nothing would otherwise notice, because a missing
    // receipt does not block the player.
    const res = await as(adminApp, admin).get('/orders/cdm-receipts/missing?olderThanMinutes=0');
    expect(res.status).toBe(200);
    expect(res.body.orders.map((o) => o.orderId)).toContain(orderId);
  });
});
