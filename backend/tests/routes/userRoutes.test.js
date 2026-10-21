// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The player's own account routes: editing their profile and their bank
 * details, over HTTP against a real database.
 *
 * ── The two properties that carry weight ────────────────────────────────────
 *
 * 1. PROFILE IS AN ALLOW-LIST, NOT A SPREAD. The route reads exactly `username`
 *    off the body. The repository, on the other hand, WILL write `status`,
 *    `bank_details` and more — they are all in its UPDATABLE set — so the only
 *    thing standing between a player and setting their own status to admin, is that the route never hands those
 *    fields down. Strict mode would not save it: they are declared columns. So
 *    the test sends them and proves they did not land — this is a
 *    privilege-escalation guard, tested as one.
 *
 * 2. THE IFSC IS UPPERCASED ONCE, AT THE BOUNDARY. A bank code stored in two
 *    cases is two different accounts to any comparison, and a withdrawal is paid
 *    to whichever spelling was written last. Bank details are the withdrawal
 *    payout destination, so this is money-adjacent.
 *
 * Nothing below the HTTP boundary is mocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getUser } from '#db/repositories/users.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('user account routes', () => {
  let app;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/user/user.routes.js');
    app = mountRouter(mod.default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  // ── Auth ────────────────────────────────────────────────────────────────
  it('refuses the account mutations without a token', async () => {
    for (const call of [
      () => request(app).put('/user/someone/profile').send({ username: 'x' }),
      () => request(app).put('/user/someone/bank-details').send({}),
    ]) {
      expect((await call()).status).toBe(401);
    }
  });

  // ── Ownership ─────────────────────────────────────────────────────────────
  it('refuses editing SOMEONE ELSE’s profile or bank details', async () => {
    const me = await actor({});
    const them = await actor({});
    expect((await as(app, me).put(`/user/${them.userId}/profile`).send({ username: 'nope' })).status).toBe(403);
    expect((await as(app, me).put(`/user/${them.userId}/bank-details`)
      .send({ accountHolderName: 'A', accountNumber: '1', ifscCode: 'x', bankName: 'b' })).status).toBe(403);

    // And nothing changed on the victim.
    expect((await getUser(them.userId)).username).toBe(them.userId);
  });

  // ── Profile: the allow-list ────────────────────────────────────────────────
  it('changes the username, trimmed', async () => {
    const me = await actor({});
    const res = await as(app, me).put(`/user/${me.userId}/profile`).send({ username: '  NewName  ' });
    expect(res.status, res.body.message).toBe(200);
    expect(res.body.user.username).toBe('NewName');
    expect((await getUser(me.userId)).username).toBe('NewName');
  });

  it('REFUSES a profile update that changes nothing', async () => {
    const me = await actor({});
    const res = await as(app, me).put(`/user/${me.userId}/profile`).send({ profilePic: 'x.png' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nothing to update/i);
  });

  it('IGNORES every field except username — the escalation guard', async () => {
    // The repository would write all of these. The route is the only thing
    // that does not hand them down.
    const me = await actor({});
    const res = await as(app, me).put(`/user/${me.userId}/profile`).send({
      username: 'RenamedOnly',
      status: 'admin',
      isAdmin: true,
      mobile: '0000000000',
      walletAddress: 'attacker',
      warningCount: 0,
    });
    expect(res.status, res.body.message).toBe(200);

    const row = await getUser(me.userId);
    expect(row.username).toBe('RenamedOnly');
    expect(row.status, 'a player set their own account status through /profile').not.toBe('admin');
    expect(String(row.mobile), 'a player rewrote their mobile through /profile').toBe(String(me.mobile));
    expect(row.walletAddress ?? null, 'a player set a wallet address through /profile').toBeNull();
  });

  it('does not expose more of the account than id, username and picture', async () => {
    const me = await actor({});
    const res = await as(app, me).put(`/user/${me.userId}/profile`).send({ username: 'Shown' });
    expect(Object.keys(res.body.user).sort()).toEqual(['id', 'profilePic', 'username']);
  });

  // ── Bank details: the withdrawal destination ───────────────────────────────
  it('requires every bank field and the UPI ID — a partial destination is no destination', async () => {
    const me = await actor({});
    const full = { accountHolderName: 'A Player', accountNumber: '123456789012', ifscCode: 'hdfc0001234', bankName: 'HDFC', upiId: 'a.player@okaxis' };
    for (const missing of Object.keys(full)) {
      const body = { ...full }; delete body[missing];
      const res = await as(app, me).put(`/user/${me.userId}/bank-details`).send(body);
      expect(res.status, `accepted a body missing ${missing}`).toBe(400);
      expect(res.body.message).toMatch(/fill in all the bank details and your UPI ID/i);
    }
    expect((await getUser(me.userId)).bankDetails, 'a refused update still wrote bank details').toBeNull();
  });

  it('UPPERCASES the IFSC once, at the boundary', async () => {
    // A code stored lowercase is a different account to any comparison, and the
    // withdrawal is paid to the last spelling written.
    const me = await actor({});
    const res = await as(app, me).put(`/user/${me.userId}/bank-details`).send({
      accountHolderName: 'A Player', accountNumber: '123456789012',
      ifscCode: 'hdfc0001234', bankName: 'HDFC Bank', upiId: 'a.player@okaxis',
    });
    expect(res.status, res.body.message).toBe(200);

    const { bankDetails } = await getUser(me.userId);
    expect(bankDetails.ifscCode).toBe('HDFC0001234');
    expect(bankDetails.accountNumber).toBe('123456789012');
    expect(bankDetails.accountHolderName).toBe('A Player');
    expect(bankDetails.bankName).toBe('HDFC Bank');
  });

  it('locks the details 48 hours after a save, and says until when (owner, 2026-10-21)', async () => {
    const me = await actor({});
    const put = (b) => as(app, me).put(`/user/${me.userId}/bank-details`).send(b);
    const first = await put({ accountHolderName: 'Old Name', accountNumber: '111', ifscCode: 'aaaa0000001', bankName: 'Old Bank', upiId: 'old.name@okaxis' });
    expect(first.status, first.body.message).toBe(200);
    expect(new Date(first.body.payoutDetailsLockedUntil).getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    const second = await put({ accountHolderName: 'New Name', accountNumber: '222', ifscCode: 'bbbb0000002', bankName: 'New Bank', upiId: 'new.name@okaxis' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PAYOUT_DETAILS_LOCKED');
    expect(new Date(second.body.lockedUntil).getTime()).toBe(new Date((await getUser(me.userId)).payoutDetailsLockedUntil).getTime());
    expect((await getUser(me.userId)).bankDetails.accountNumber).toBe('111');
  });

  it('refuses a change while an order is in progress, in words the player can act on', async () => {
    const me = await actor({});
    const put = (accountNumber) => as(app, me).put(`/user/${me.userId}/bank-details`).send({
      accountHolderName: 'A Player', accountNumber, ifscCode: 'HDFC0001234', bankName: 'HDFC Bank', upiId: 'a.player@okaxis',
    });
    expect((await put('111')).status).toBe(200);
    await pgQuery('UPDATE users SET payout_details_locked_until = NULL WHERE user_id = $1', [me.userId]);
    const orderId = `o-inuse-${me.userId}`;
    await pgQuery(`INSERT INTO order_states (order_id, user_id, order_type, state, token_amount_paise)
                   VALUES ($1, $2, 'WITHDRAWAL', 'PENDING_QUEUE', 100000)`, [orderId, me.userId]);
    try {
      const res = await put('222');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PAYOUT_DETAILS_IN_USE');
      expect(res.body.message).toMatch(/order in progress/);
      expect((await getUser(me.userId)).bankDetails.accountNumber).toBe('111');
    } finally {
      await pgQuery('DELETE FROM order_states WHERE order_id = $1', [orderId]);
    }
  });

  it('replaces the destination wholesale once the lock has passed', async () => {
    // A player who re-enters their details expects the new account, not a merge
    // that leaves a stale field from the old one.
    const me = await actor({});
    const put = (b) => as(app, me).put(`/user/${me.userId}/bank-details`).send(b);
    await put({ accountHolderName: 'Old Name', accountNumber: '111', ifscCode: 'aaaa0000001', bankName: 'Old Bank', upiId: 'old.name@okaxis' });
    await pgQuery("UPDATE users SET payout_details_locked_until = now() - interval '1 second' WHERE user_id = $1", [me.userId]);
    const res = await put({ accountHolderName: 'New Name', accountNumber: '222', ifscCode: 'bbbb0000002', bankName: 'New Bank', upiId: 'New.Name@OKAXIS' });
    expect(res.status, res.body.message).toBe(200);
    expect((await getUser(me.userId)).bankDetails).toEqual({
      accountHolderName: 'New Name', accountNumber: '222', ifscCode: 'BBBB0000002', bankName: 'New Bank', upiId: 'new.name@okaxis',
    });
  });

  it('refuses a UPI ID that is a mobile, or not a UPI ID, and names which', async () => {
    const me = await actor({});
    const put = (upiId) => as(app, me).put(`/user/${me.userId}/bank-details`).send({
      accountHolderName: 'A Player', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC Bank', upiId,
    });
    for (const upiId of [`${me.mobile}@ybl`, '9876543210@paytm', `91${me.mobile}@okaxis`]) {
      const res = await put(upiId);
      expect(res.status, upiId).toBe(400);
      expect(res.body.code).toBe('UPI_ID_IS_A_MOBILE');
      expect(res.body.message).toMatch(/not your mobile number/);
    }
    expect((await put('not-a-upi-id')).body.code).toBe('UPI_ID_INVALID');
    expect((await getUser(me.userId)).bankDetails ?? null).toBeNull();
  });
});
