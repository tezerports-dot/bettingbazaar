// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The player's own account routes: editing their profile and their bank
 * details, over HTTP against a real database.
 *
 * ── The two properties that carry weight ────────────────────────────────────
 *
 * 1. PROFILE IS AN ALLOW-LIST, NOT A SPREAD. The route reads exactly `username`
 *    off the body. The repository, on the other hand, WILL write `kyc_status`,
 *    `status`, `bank_details` and more — they are all in its UPDATABLE set — so
 *    the only thing standing between a player and setting their own KYC to
 *    APPROVED, or their status to admin, is that the route never hands those
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
import { pgConfigured, applySchema, closePg } from '#db/client.js';
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
    const me = await actor({ kycStatus: 'PENDING_APPROVAL' });
    const res = await as(app, me).put(`/user/${me.userId}/profile`).send({
      username: 'RenamedOnly',
      kycStatus: 'APPROVED',
      kyc_status: 'APPROVED',
      status: 'admin',
      isAdmin: true,
      mobile: '0000000000',
      walletAddress: 'attacker',
      warningCount: 0,
    });
    expect(res.status, res.body.message).toBe(200);

    const row = await getUser(me.userId);
    expect(row.username).toBe('RenamedOnly');
    expect(row.kycStatus, 'a player set their own KYC status through /profile').toBe('PENDING_APPROVAL');
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
  it('requires every bank field — a partial destination is no destination', async () => {
    const me = await actor({});
    const full = { accountHolderName: 'A Player', accountNumber: '123456789012', ifscCode: 'hdfc0001234', bankName: 'HDFC' };
    for (const missing of Object.keys(full)) {
      const body = { ...full }; delete body[missing];
      const res = await as(app, me).put(`/user/${me.userId}/bank-details`).send(body);
      expect(res.status, `accepted a body missing ${missing}`).toBe(400);
      expect(res.body.message).toMatch(/required/i);
    }
    expect((await getUser(me.userId)).bankDetails, 'a refused update still wrote bank details').toBeNull();
  });

  it('UPPERCASES the IFSC once, at the boundary', async () => {
    // A code stored lowercase is a different account to any comparison, and the
    // withdrawal is paid to the last spelling written.
    const me = await actor({});
    const res = await as(app, me).put(`/user/${me.userId}/bank-details`).send({
      accountHolderName: 'A Player', accountNumber: '123456789012',
      ifscCode: 'hdfc0001234', bankName: 'HDFC Bank',
    });
    expect(res.status, res.body.message).toBe(200);

    const { bankDetails } = await getUser(me.userId);
    expect(bankDetails.ifscCode).toBe('HDFC0001234');
    expect(bankDetails.accountNumber).toBe('123456789012');
    expect(bankDetails.accountHolderName).toBe('A Player');
    expect(bankDetails.bankName).toBe('HDFC Bank');
  });

  it('replaces the destination wholesale on a second write', async () => {
    // A player who re-enters their details expects the new account, not a merge
    // that leaves a stale field from the old one.
    const me = await actor({});
    const put = (b) => as(app, me).put(`/user/${me.userId}/bank-details`).send(b);
    await put({ accountHolderName: 'Old Name', accountNumber: '111', ifscCode: 'aaaa0000001', bankName: 'Old Bank' });
    await put({ accountHolderName: 'New Name', accountNumber: '222', ifscCode: 'bbbb0000002', bankName: 'New Bank' });

    expect((await getUser(me.userId)).bankDetails).toMatchObject({
      accountHolderName: 'New Name', accountNumber: '222', ifscCode: 'BBBB0000002', bankName: 'New Bank',
    });
  });
});
