// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant saying "the money never arrived" must say why, and show it.
 *
 * ── Why this route needed both, and had neither ─────────────────────────────
 * `POST /api/merchant/orders/:id/reject` cancels an order the player has
 * already claimed to pay and adds a warning to that player's account. It is the
 * heaviest thing a merchant can do to a player.
 *
 * It USED to auto-block them once they crossed the admin's threshold, with no
 * admin in the loop — see the last describe block, which is the test that keeps
 * that from coming back.
 *
 * It took an OPTIONAL reason, falling back to the string "Rejected by
 * merchant", and no evidence at all. So a player could be warned, and
 * eventually blocked, with nothing on the record explaining it — not for
 * support, not for the admin console, not for the player.
 *
 * No screen called it either, which is why nothing had noticed.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * That both halves are refused when missing, that a refusal moves NOTHING (no
 * cancellation, no warning), and that a proof staged against a different order
 * or a different merchant cannot be attached to this one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getUser, setBlocked } from '#db/repositories/users.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// The S3 boundary, stubbed so the ROUTE's rules are what is under test — the
// verification arguments it passes are asserted, which is the part that binds a
// proof to one merchant and one order. Whether S3 stores bytes is cdn.service's
// own concern and has its own coverage.
const cdn = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../../services/cdn.service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, verifyUploadedObject: cdn.verify },
  };
});

describePg('merchant rejects a paid order', () => {
  let app;
  let seq = 0;
  const oid = () => `rj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const paidOrder = async (merchant, player) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500,
      state: 'PAID', merchantId: merchant.merchantId,
    });
    return orderId;
  };

  const REASON = 'No credit against UTR 123456789012 in my statement';
  const good = { reason: REASON, proofFileKey: 'merchant-reject-proof/x.jpg', proofCdnUrl: 'https://cdn.test/x.jpg' };

  beforeAll(() => { /* placeholder so the mock is registered before imports */ });

  it('rejects with a reason and a verified proof', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: 'https://cdn.test/x.jpg', fileKey: good.proofFileKey });
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await paidOrder(merchant, player);

    const res = await as(app, merchant).post(`/orders/${orderId}/reject`).send(good);
    expect(res.status).toBe(200);

    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('CANCELLED');
    // The merchant's own words, not a canned string.
    expect(row.rejectedReason).toBe(REASON);
    // And the evidence, stored with it.
    expect(row.rejectionProofUrl).toBe('https://cdn.test/x.jpg');
  });

  it('refuses a missing or throwaway reason, and moves nothing', async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: 'https://cdn.test/x.jpg' });
    const merchant = await merchantActor({});
    const player = await actor({});

    for (const reason of [undefined, '', '   ', 'no']) {
      const orderId = await paidOrder(merchant, player);
      const res = await as(app, merchant).post(`/orders/${orderId}/reject`)
        .send({ ...good, reason });
      expect(res.status, `accepted reason ${JSON.stringify(reason)}`).toBe(400);
      expect((await getOrderRecord(orderId)).status).toBe('PAID');
    }
    // The player was never warned for any of them.
    expect(Number((await getUser(player.userId)).warningCount || 0)).toBe(0);
  });

  it('refuses without proof, and moves nothing', async () => {
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await paidOrder(merchant, player);

    const res = await as(app, merchant).post(`/orders/${orderId}/reject`)
      .send({ reason: REASON });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/proof/i);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
    expect(Number((await getUser(player.userId)).warningCount || 0)).toBe(0);
  });

  it('binds the proof to THIS merchant and THIS order', async () => {
    // Without these arguments a merchant could name a key staged against a
    // different order, or somebody else's upload, and it would be stored as
    // evidence here.
    cdn.verify.mockResolvedValue({ cdnUrl: 'https://cdn.test/x.jpg' });
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await paidOrder(merchant, player);

    await as(app, merchant).post(`/orders/${orderId}/reject`).send(good);

    expect(cdn.verify).toHaveBeenCalledWith(expect.objectContaining({
      fileKey: good.proofFileKey,
      expectedUserId: String(merchant.merchantId),
      expectedOrderId: orderId,
      expectedCategory: 'merchant-reject-proof',
    }));
  });

  it('refuses a proof that does not verify, and moves nothing', async () => {
    cdn.verify.mockRejectedValue(new Error('Uploaded object owner mismatch'));
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await paidOrder(merchant, player);

    const res = await as(app, merchant).post(`/orders/${orderId}/reject`).send(good);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/owner mismatch/i);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
    expect(Number((await getUser(player.userId)).warningCount || 0)).toBe(0);
  });

  it("refuses another merchant's order", async () => {
    cdn.verify.mockResolvedValue({ cdnUrl: 'https://cdn.test/x.jpg' });
    const mine = await merchantActor({});
    const stranger = await merchantActor({});
    const player = await actor({});
    const orderId = await paidOrder(mine, player);

    const res = await as(app, stranger).post(`/orders/${orderId}/reject`).send(good);
    expect(res.status).toBe(403);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
  });

  it('warns the player exactly once, however many times it is retried', async () => {
    // The transition is the gate. A merchant retrying a request that timed out
    // used to run the warning engine a second time and increment the count
    // again, so a network hiccup cost the player a warning.
    cdn.verify.mockResolvedValue({ cdnUrl: 'https://cdn.test/x.jpg' });
    const merchant = await merchantActor({});
    const player = await actor({});
    const orderId = await paidOrder(merchant, player);

    expect((await as(app, merchant).post(`/orders/${orderId}/reject`).send(good)).status).toBe(200);
    const afterFirst = Number((await getUser(player.userId)).warningCount || 0);
    expect(afterFirst).toBe(1);

    expect((await as(app, merchant).post(`/orders/${orderId}/reject`).send(good)).status).toBe(409);
    expect(Number((await getUser(player.userId)).warningCount || 0)).toBe(afterFirst);
  });

  /**
   * ── A merchant cannot close a player's account ──────────────────────────
   *
   * This is the whole of the owner's decision, as a test.
   *
   * A rejection is one merchant's unreviewed word about someone else's money,
   * and it used to be enough — at the default threshold of three, two honest
   * mistakes and one bad actor locked a player out of their own balance.
   * `is_blocked` is refused at `authenticate`, so a blocked player cannot see
   * their wallet, their orders, or any notice explaining why. The same merchant
   * looking at the same missing payment could instead raise a DISPUTE, which an
   * admin rules on and which touches the account not at all — but nothing
   * steered that choice and the harsher of the two closed the order sooner.
   *
   * So: the warning and the flag still happen, because support needs to see
   * them. The block does not, from here, ever. It moved to an admin looking at
   * the reason and the proof on GET /api/admin/users/flagged.
   *
   * The count is driven WELL past the default threshold of 3 on purpose. A test
   * that rejected twice would pass against the old code too.
   */
  describe('the block moved to an admin', () => {
    it('warns and flags without blocking, however far past the threshold', async () => {
      cdn.verify.mockResolvedValue({ cdnUrl: 'https://cdn.test/x.jpg' });
      const merchant = await merchantActor({});
      const player = await actor({});

      // Five, against a default `maxWarnings` of 3. The old code blocked on the
      // third; nothing here may block on any of them.
      for (let i = 1; i <= 5; i += 1) {
        const orderId = await paidOrder(merchant, player);
        const res = await as(app, merchant).post(`/orders/${orderId}/reject`).send(good);
        expect(res.status, `rejection ${i}`).toBe(200);
        // The response never claims a block happened either — a panel reading
        // `autoBlocked` would otherwise tell the merchant it had.
        expect(res.body.autoBlocked, `rejection ${i} reported a block`).toBe(false);

        const mid = await getUser(player.userId);
        expect(Number(mid.warningCount), `count after ${i}`).toBe(i);
        expect(mid.isBlocked, `blocked after rejection ${i}`).toBe(false);
      }

      const after = await getUser(player.userId);
      // Warned and flagged — the part support and the admin console need.
      expect(Number(after.warningCount)).toBe(5);
      expect(after.paymentFlagged).toBe(true);
      expect(Number(after.paymentFlagCount)).toBe(5);
      expect(after.paymentFlagReason).toBe(REASON);
      expect(after.paymentFlaggedAt).toBeTruthy();
      // And still able to sign in and see their own money.
      expect(after.isBlocked).toBe(false);
      expect(after.blockReason).toBeFalsy();
      expect(after.status).not.toBe('BLOCKED');
    });

    it('leaves an already-blocked player blocked', async () => {
      // The path passes `maxWarnings: 0`, and the UPDATE ORs into `is_blocked`.
      // A wrong fix — assigning FALSE instead of leaving it alone — would
      // silently UNBLOCK a player an admin had already acted on, which is worse
      // than the bug being fixed.
      cdn.verify.mockResolvedValue({ cdnUrl: 'https://cdn.test/x.jpg' });
      const merchant = await merchantActor({});
      const player = await actor({});
      await setBlocked(player.userId, { blocked: true, reason: 'Blocked by an admin earlier', actor: 'admin-1' });

      const orderId = await paidOrder(merchant, player);
      expect((await as(app, merchant).post(`/orders/${orderId}/reject`).send(good)).status).toBe(200);

      const after = await getUser(player.userId);
      expect(after.isBlocked).toBe(true);
      expect(after.blockReason).toBe('Blocked by an admin earlier');
    });
  });
});
