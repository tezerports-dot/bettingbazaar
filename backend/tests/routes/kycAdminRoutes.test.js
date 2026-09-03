// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The KYC exception path an operator uses when the bulk verifier gets one
 * wrong, over HTTP against a real database.
 *
 * ── The bug these caught ────────────────────────────────────────────────────
 * The handlers read the user through `db.users.getUser` and then passed
 * `user._id` to the decision — but the users repository returns `userId`, not
 * `_id` (that was the document store's key). So the decision ran against
 * `undefined`, matched no row, and EVERY manual approve and reject returned
 * 409 "cannot … from unknown status". The operator's only correction path for a
 * mis-verified account — and KYC is what gates withdrawals — was dead. Fixed to
 * `user.userId`; these tests are what prove approve and reject now land.
 *
 * ── The permission gate ─────────────────────────────────────────────────────
 * Both routes sit behind `hasPermission('canVerifyKYC')`. A full admin passes;
 * a sub-admin passes only with that grant; anyone else is refused. That gate is
 * the sub-admin permission catalogue (tested as data in the admin panel) doing
 * its job at the HTTP boundary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getUser } from '#db/repositories/users.js';
import { openKyc, getKyc, KYC_STATES } from '#db/repositories/kyc.core.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('KYC admin routes', () => {
  let app; let admin;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../routes/admin/kyc.admin.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A user sitting at PENDING_APPROVAL — the position a verdict is taken from. */
  const awaiting = async () => {
    const who = await actor({ kycStatus: KYC_STATES.PENDING_APPROVAL });
    await openKyc({ userId: who.userId, status: KYC_STATES.PENDING_APPROVAL });
    return who;
  };

  // ── Authorisation ─────────────────────────────────────────────────────────
  it('refuses every route without a token', async () => {
    for (const call of [
      () => request(app).get('/kyc/queue'),
      () => request(app).post('/kyc/whoever/approve').send({}),
      () => request(app).post('/kyc/whoever/reject').send({ reason: 'x' }),
    ]) {
      expect((await call()).status).toBe(401);
    }
  });

  it('refuses a signed-in user who is neither admin nor sub-admin', async () => {
    const nobody = await actor({});
    expect((await as(app, nobody).get('/kyc/queue')).status).toBe(403);
  });

  it('refuses a sub-admin WITHOUT canVerifyKYC, and admits one WITH it', async () => {
    const denied = await actor({ isSubAdmin: true, permissions: { canVerifyKYC: false } });
    const allowed = await actor({ isSubAdmin: true, permissions: { canVerifyKYC: true } });

    const deniedRes = await as(app, denied).get('/kyc/queue');
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body.requiredPermission).toBe('canVerifyKYC');

    expect((await as(app, allowed).get('/kyc/queue')).status).toBe(200);
  });

  // ── Approve — the fix ───────────────────────────────────────────────────────
  it('APPROVES a waiting user and flips the column withdrawals read', async () => {
    // The regression: this returned 409 because the decision ran against
    // user._id (undefined). users.kyc_status is the copy every authorisation
    // gate reads, so it is what the test checks.
    const who = await awaiting();
    const res = await as(app, admin).post(`/kyc/${who.userId}/approve`).send({});
    expect(res.status, res.body.message).toBe(200);

    expect((await getUser(who.userId)).kycStatus).toBe('APPROVED');
    expect((await getKyc(who.userId)).status).toBe('APPROVED');
  });

  it('records WHO approved — approvals used to be anonymous', async () => {
    // The reviewer block read a path that did not exist, so it never ran; the
    // decision now carries the actor.
    const who = await awaiting();
    await as(app, admin).post(`/kyc/${who.userId}/approve`).send({});
    expect((await getKyc(who.userId)).reviewedBy).toBe(admin.userId);
  });

  it('lets a permitted sub-admin approve, not only a full admin', async () => {
    const reviewer = await actor({ isSubAdmin: true, permissions: { canVerifyKYC: true } });
    const who = await awaiting();
    const res = await as(app, reviewer).post(`/kyc/${who.userId}/approve`).send({});
    expect(res.status, res.body.message).toBe(200);
    expect((await getKyc(who.userId)).reviewedBy).toBe(reviewer.userId);
  });

  it('404s a decision on a user who does not exist', async () => {
    expect((await as(app, admin).post('/kyc/ghost-user/approve').send({})).status).toBe(404);
    expect((await as(app, admin).post('/kyc/ghost-user/reject').send({ reason: 'x' })).status).toBe(404);
  });

  it('409s approving a user who never submitted — an illegal transition', async () => {
    // APPROVED is reachable only from PENDING_APPROVAL. A user still at
    // PENDING_SUBMISSION has no legal edge to APPROVED and is refused.
    const who = await actor({ kycStatus: KYC_STATES.PENDING_SUBMISSION });
    await openKyc({ userId: who.userId, status: KYC_STATES.PENDING_SUBMISSION });
    const res = await as(app, admin).post(`/kyc/${who.userId}/approve`).send({});
    expect(res.status).toBe(409);
    expect((await getKyc(who.userId)).status).toBe('PENDING_SUBMISSION');
  });

  it('treats a repeated approve as idempotent, not an error', async () => {
    // A reviewer double-clicking, or two reviewers acting at once, must not turn
    // a completed approval into a failure. The second call is a no-op success
    // and the reviewer of record does not change.
    const who = await awaiting();
    const first = await as(app, admin).post(`/kyc/${who.userId}/approve`).send({});
    const second = await as(app, admin).post(`/kyc/${who.userId}/approve`).send({});
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await getKyc(who.userId)).status).toBe('APPROVED');
  });

  // ── Reject — the reason must survive ─────────────────────────────────────────
  it('REFUSES a rejection with no reason — it is what the user is shown', async () => {
    const who = await awaiting();
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await as(app, admin).post(`/kyc/${who.userId}/reject`).send(body);
      expect(res.status, `accepted ${JSON.stringify(body)}`).toBe(400);
    }
    expect((await getKyc(who.userId)).status).toBe('PENDING_APPROVAL');
  });

  it('rejects with a reason, and the reason lands in the field the user reads', async () => {
    // The defect this platform shipped once: the reason was written to a
    // subdocument the schema did not have, so every rejected user saw the
    // refusal and never the explanation, and could not fix and resubmit.
    const who = await awaiting();
    const res = await as(app, admin).post(`/kyc/${who.userId}/reject`)
      .send({ reason: '  Name does not match the Aadhaar record.  ' });
    expect(res.status, res.body.message).toBe(200);

    const kyc = await getKyc(who.userId);
    expect(kyc.status).toBe('REJECTED');
    expect(kyc.rejectionReason).toBe('Name does not match the Aadhaar record.');
    expect(kyc.reviewedBy).toBe(admin.userId);
    expect((await getUser(who.userId)).kycStatus).toBe('REJECTED');
  });

  // ── The queue ───────────────────────────────────────────────────────────────
  it('lists a waiting user in the queue with a total', async () => {
    const who = await awaiting();
    const res = await as(app, admin).get('/kyc/queue');
    expect(res.status).toBe(200);
    expect(res.body.queue.some((u) => u.userId === who.userId || u.user_id === who.userId)).toBe(true);
    expect(res.body.pendingTotal).toBeGreaterThanOrEqual(1);
  });
});
