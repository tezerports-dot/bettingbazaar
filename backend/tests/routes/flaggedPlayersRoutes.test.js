// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The review queue a merchant rejection feeds — and the decision it carries.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 * A merchant rejecting a paid order no longer blocks the player; it warns and
 * flags, and an admin decides. That decision needs somewhere to be made, and
 * for a while there was nowhere: `payment_flagged` was written on every
 * rejection, `users_flagged_idx` was created for it, `listUsers` grew a
 * `flagged` filter — and NOTHING passed the filter or read the index. Moving
 * the block to "an admin decides" without this screen would have moved it to
 * nobody, which is worse than the automatic rule it replaced.
 *
 * ── The failure this suite is really guarding ───────────────────────────────
 * `GET /users/flagged` sits above `GET /users/:userId` in one router. Express
 * matches in declaration order, so reordering them makes this path resolve to a
 * player whose id is the string "flagged" — a 404, which the screen renders as
 * its empty state. Indistinguishable from "nobody is flagged". That is exactly
 * the class of defect CLAUDE.md's "Shipped means reachable" section was written
 * for, and a route test that only ever asks for a player that exists would not
 * see it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { getUser, flagPaymentWarning, setBlocked, softDeleteUser } from '#db/repositories/users.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('flagged players — the admin review queue', () => {
  let app;
  let admin;
  let seq = 0;
  const oid = () => `fp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/admin/users.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A player flagged by a real merchant rejection, evidence and all. */
  const flaggedPlayer = async ({ reason = 'No credit against UTR 999888777666', proof = 'https://cdn.test/proof.jpg', times = 1 } = {}) => {
    const player = await actor({});
    let orderId;
    for (let i = 0; i < times; i += 1) {
      orderId = oid();
      await createOrderRecord({
        orderId, userId: player.userId, type: 'DEPOSIT',
        tokenAmountRupees: 500, fiatAmountRupees: 500, state: 'PAID',
      });
      await setOrderFields(orderId, {
        rejectedReason: reason, rejectionProofUrl: proof,
        rejectedAt: new Date(), rejectedBy: 'mrc-1',
        cancelReason: 'MERCHANT_REJECTED',
      });
      // The same single statement the reject route uses, `maxWarnings: 0`.
      await flagPaymentWarning(player.userId, { reason, maxWarnings: 0 });
    }
    return { player, orderId };
  };

  const listFlagged = async () => {
    const res = await as(app, admin).get('/users/flagged');
    expect(res.status).toBe(200);
    return res.body;
  };

  it('is not swallowed by /users/:userId', async () => {
    // Reorder the two routes and this is a 404 with `message: 'User not found'`
    // — which the screen draws as "no flagged players". The status code alone
    // is the assertion that matters; the body proves it went to the right
    // handler rather than to a player who happens to be called "flagged".
    const res = await as(app, admin).get('/users/flagged');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('players');
    expect(res.body).not.toHaveProperty('user');
  });

  it('returns the flagged player with the merchant reason and the proof image', async () => {
    const { player, orderId } = await flaggedPlayer();
    const body = await listFlagged();

    const row = body.players.find(p => p.userId === player.userId);
    expect(row, 'flagged player missing from the queue').toBeTruthy();
    expect(row.paymentFlagged).toBe(true);
    expect(Number(row.warningCount)).toBe(1);
    // The two things the decision is actually made from.
    expect(row.lastRejection).toBeTruthy();
    expect(row.lastRejection.orderId).toBe(orderId);
    expect(row.lastRejection.reason).toBe('No credit against UTR 999888777666');
    expect(row.lastRejection.proofUrl).toBe('https://cdn.test/proof.jpg');
    // BIGINT arrives as a string from node-postgres; cast at the boundary or
    // every comparison downstream is a string comparison (Trap 5).
    expect(typeof row.lastRejection.amountPaise).toBe('number');
    expect(row.lastRejection.amountPaise).toBe(50000);
  });

  it('carries the most recent rejection, not the first', async () => {
    // A LATERAL ordered the wrong way shows an admin last month's complaint
    // while they decide about this one.
    const player = await actor({});
    for (const [reason, when] of [
      ['The older complaint', new Date(Date.now() - 86_400_000)],
      ['The newest complaint', new Date()],
    ]) {
      const orderId = oid();
      await createOrderRecord({
        orderId, userId: player.userId, type: 'DEPOSIT',
        tokenAmountRupees: 500, fiatAmountRupees: 500, state: 'PAID',
      });
      await setOrderFields(orderId, {
        rejectedReason: reason, rejectionProofUrl: 'https://cdn.test/p.jpg',
        rejectedAt: when, rejectedBy: 'mrc-1', cancelReason: 'MERCHANT_REJECTED',
      });
      await flagPaymentWarning(player.userId, { reason, maxWarnings: 0 });
    }

    const body = await listFlagged();
    const row = body.players.find(p => p.userId === player.userId);
    expect(row.lastRejection.reason).toBe('The newest complaint');
  });

  it('still lists a player flagged with no rejection order behind it', async () => {
    // LEFT JOIN, not JOIN. An inner join hides a flagged player from the only
    // screen that looks for them — the same silent-empty failure as the filter
    // nothing passed.
    const player = await actor({});
    await flagPaymentWarning(player.userId, { reason: 'Flagged by another path', maxWarnings: 0 });

    const body = await listFlagged();
    const row = body.players.find(p => p.userId === player.userId);
    expect(row, 'a flagged player with no rejection was dropped').toBeTruthy();
    expect(row.lastRejection).toBeNull();
    expect(row.paymentFlagReason).toBe('Flagged by another path');
  });

  it('marks a player over the admin threshold without touching the account', async () => {
    // `maxWarnings` had exactly one consumer and it now passes 0, so the
    // admin-editable number governed NOTHING. It decides this marker instead —
    // a prompt to look, not a verdict.
    const { player } = await flaggedPlayer({ times: 4 });
    const body = await listFlagged();

    expect(body.warningThreshold).toBe(3);
    const row = body.players.find(p => p.userId === player.userId);
    expect(row.overWarningThreshold).toBe(true);
    // Marked, and nothing more.
    expect(row.isBlocked).toBe(false);
    expect((await getUser(player.userId)).isBlocked).toBe(false);
  });

  it('does not mark a player under the threshold', async () => {
    const { player } = await flaggedPlayer({ times: 1 });
    const body = await listFlagged();
    const row = body.players.find(p => p.userId === player.userId);
    expect(row.overWarningThreshold).toBe(false);
  });

  it('leaves deleted accounts out of the queue', async () => {
    const { player } = await flaggedPlayer();
    await softDeleteUser(player.userId, { actor: 'admin-1' });
    const body = await listFlagged();
    expect(body.players.find(p => p.userId === player.userId)).toBeUndefined();
  });

  it('never leaks a credential column', async () => {
    // The mapper is the only way a row becomes a user, and the LATERAL join
    // meant writing a fresh projection — the one place that guarantee could
    // have been lost.
    await flaggedPlayer();
    const body = await listFlagged();
    for (const p of body.players) {
      expect(p).not.toHaveProperty('password_hash');
      expect(p).not.toHaveProperty('passwordHash');
      expect(p).not.toHaveProperty('two_factor_secret');
      expect(p).not.toHaveProperty('twoFactorSecret');
    }
  });

  describe('clearing a flag', () => {
    it('clears the flag without needing the player to be blocked', async () => {
      // The only way to clear a flag used to be `unblock?resetWarnings=true`,
      // which needs a BLOCKED player — and under the current rule no flagged
      // player is blocked. Dismissing a merchant's complaint required blocking
      // the player first, which is the thing the rule exists to prevent.
      const { player } = await flaggedPlayer();
      expect((await getUser(player.userId)).isBlocked).toBe(false);

      const res = await as(app, admin).post(`/users/${player.userId}/clear-flag`).send({});
      expect(res.status).toBe(200);

      const after = await getUser(player.userId);
      expect(after.paymentFlagged).toBe(false);
      // '' is the column's own default — it is NOT NULL, and writing null
      // here is what made the unblock route 500 after committing the unblock.
      expect(after.paymentFlagReason).toBe('');
      expect(after.paymentFlaggedAt).toBeNull();
      // The warning history survives a dismissal by default.
      expect(Number(after.warningCount)).toBe(1);
      // And they are out of the queue.
      const body = await listFlagged();
      expect(body.players.find(p => p.userId === player.userId)).toBeUndefined();
    });

    it('resets warnings only when asked', async () => {
      const { player } = await flaggedPlayer({ times: 2 });
      await as(app, admin).post(`/users/${player.userId}/clear-flag`)
        .send({ resetWarnings: true });
      expect(Number((await getUser(player.userId)).warningCount)).toBe(0);
    });

    it('does not unblock a player an admin blocked', async () => {
      // Clearing a review flag is not a pardon. A version of this that also
      // set `is_blocked = FALSE` would quietly reopen an account somebody had
      // deliberately closed.
      const { player } = await flaggedPlayer();
      await setBlocked(player.userId, { blocked: true, reason: 'Blocked after review', actor: admin.userId });

      await as(app, admin).post(`/users/${player.userId}/clear-flag`).send({});

      const after = await getUser(player.userId);
      expect(after.paymentFlagged).toBe(false);
      expect(after.isBlocked).toBe(true);
      expect(after.blockReason).toBe('Blocked after review');
    });

    it('404s on an account that does not exist', async () => {
      const res = await as(app, admin).post('/users/no-such-user/clear-flag').send({});
      expect(res.status).toBe(404);
    });

    it('is refused to a sub-admin', async () => {
      // Reading the queue is `isAdminOrSubAdmin`; clearing is `isAdmin`. A
      // sub-admin dismissing a payment complaint is a money decision.
      const { player } = await flaggedPlayer();
      const subAdmin = await actor({ isSubAdmin: true });

      const res = await as(app, subAdmin).post(`/users/${player.userId}/clear-flag`).send({});
      expect(res.status).toBe(403);
      expect((await getUser(player.userId)).paymentFlagged).toBe(true);
    });
  });
});
