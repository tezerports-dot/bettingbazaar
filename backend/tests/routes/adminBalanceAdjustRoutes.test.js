// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * `POST /api/admin/balance-adjust` — the ONE admin path to a player's balance.
 *
 * ── Why there is a "one" to speak of ────────────────────────────────────────
 * There were two. This route, reached from the Balance Adjustment screen, and
 * `POST /api/admin/users/:userId/adjust-balance`, reached from the inline modal
 * on the Users screen. Both were live and both were in the admin panel, so the
 * same decision took a different path depending on which screen the operator
 * happened to be on.
 *
 * The MONEY was never in doubt — both handed off to `adminAdjustment`, the one
 * writer (§9). Everything around it differed, and differed silently:
 *
 *   · the other route made `reason` OPTIONAL, defaulting to the string "Admin
 *     adjustment", so a money movement could be audited with nothing on the
 *     record explaining it;
 *   · it validated the pocket against a hand-written ternary of two rather than
 *     `ADJUSTABLE_FIELDS`, the writer's own list — a second copy of a value with
 *     one owner, free to drift from the thing that decides (§2, §5);
 *   · it wrote no engagement bonus record, so a credit issued from the Users
 *     screen never appeared in reporting and the identical credit issued from
 *     the Balance Adjustment screen did.
 *
 * And it took the DIRECTION from the sign of `amount` while silently ignoring a
 * `type` field — its own test pinned that as a hazard, in as many words: "a
 * caller sending `type: 'DEBIT'` alongside a POSITIVE amount is asking to take
 * money away and will be given money instead … the shape that costs real
 * money." This route takes an explicit direction and a positive magnitude, so
 * that shape cannot be expressed on it.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * The behaviours the deleted route's tests covered, against the route that
 * survived — rehomed, not dropped — plus the three things this route does that
 * the other one did not.
 *
 * Every money assertion reads the WALLET afterwards. The response saying it
 * worked is not the assertion; that is how a route once reported a settlement
 * working while the real function threw on every call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getBalancesPaise, applyMovementPaise } from '#db/repositories/wallets.core.js';
import { ADJUSTABLE_FIELDS } from '#db/repositories/balanceAdjustments.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('admin balance adjustment — the single writer path', () => {
  let app; let admin;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/retention.routes.js')).default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A fresh subject per test: these handlers mutate the account they name. */
  const subject = () => actor({ kycStatus: 'APPROVED' });

  const seed = async (userId, field, paise) => applyMovementPaise({
    userId,
    legs: [{ field, deltaPaise: paise }],
    ledger: [{ txId: `seed_${field}_${userId}`, field, amountPaise: paise, type: 'CREDIT' }],
  });

  const adjust = (body) => as(app, admin).post('/admin/balance-adjust').send(body);

  // ── Authorisation is the first thing, not an afterthought ────────────────
  it('refuses an unauthenticated call before any handler runs', async () => {
    const res = await request(app).post('/admin/balance-adjust')
      .send({ userId: 'whoever', type: 'CREDIT', field: 'depositBalance', amount: 1, reason: 'x' });
    expect(res.status).toBe(401);
  });

  it('refuses a signed-in NON-admin', async () => {
    const nobody = await actor({});
    const res = await as(app, nobody).post('/admin/balance-adjust')
      .send({ userId: nobody.userId, type: 'CREDIT', field: 'depositBalance', amount: 1, reason: 'x' });
    // 403, not 401: they are who they say they are and still may not do this.
    expect(res.status).toBe(403);
  });

  // ── The money one ────────────────────────────────────────────────────────
  it('credits, and the money is really there afterwards', async () => {
    const plain = await subject();
    const res = await adjust({
      userId: plain.userId, type: 'CREDIT', field: 'depositBalance',
      amount: 250, reason: 'goodwill',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);
    expect((await getBalancesPaise(plain.userId)).depositBalance).toBe(250_00);
  });

  it('debits, and takes the direction from `type` rather than a sign', async () => {
    const plain = await subject();
    await seed(plain.userId, 'depositBalance', 400_00);

    // A positive magnitude with an explicit DEBIT. On the route this replaced,
    // direction came from the sign and `type` was ignored — so this exact call
    // ADDED ₹100 instead of removing it.
    const res = await adjust({
      userId: plain.userId, type: 'DEBIT', field: 'depositBalance',
      amount: 100, reason: 'clawback',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getBalancesPaise(plain.userId)).depositBalance).toBe(300_00);
  });

  it('refuses a debit the pocket cannot fund, and moves nothing', async () => {
    const plain = await subject();
    await seed(plain.userId, 'depositBalance', 100_00);

    const res = await adjust({
      userId: plain.userId, type: 'DEBIT', field: 'depositBalance',
      amount: 500, reason: 'clawback',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    // The refusal names what they actually hold, taken from the locked read —
    // never from a balance fetched separately.
    expect(res.body.message).toMatch(/Insufficient/i);
    expect((await getBalancesPaise(plain.userId)).depositBalance).toBe(100_00);
  });

  it('credits the winnings pocket when asked for it, not deposit', async () => {
    const plain = await subject();
    const res = await adjust({
      userId: plain.userId, type: 'CREDIT', field: 'winningsBalance',
      amount: 75, reason: 'prize',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = await getBalancesPaise(plain.userId);
    expect(b.winningsBalance).toBe(75_00);
    expect(b.depositBalance).toBe(0);
  });

  it('refuses a zero, negative or non-numeric amount before touching the wallet', async () => {
    const plain = await subject();
    for (const amount of [0, -5, 'abc', null]) {
      const res = await adjust({
        userId: plain.userId, type: 'CREDIT', field: 'depositBalance', amount, reason: 'nonsense',
      });
      expect(res.status, `amount=${JSON.stringify(amount)}`).toBe(400);
    }
    expect((await getBalancesPaise(plain.userId)).depositBalance).toBe(0);
  });

  // ── The three things the deleted route did not do ────────────────────────
  it('REQUIRES a reason — a money movement is not audited as "Admin adjustment"', async () => {
    const plain = await subject();
    for (const reason of [undefined, '', null]) {
      const res = await adjust({
        userId: plain.userId, type: 'CREDIT', field: 'depositBalance', amount: 10, reason,
      });
      expect(res.status, `reason=${JSON.stringify(reason)}`).toBe(400);
    }
    expect((await getBalancesPaise(plain.userId)).depositBalance).toBe(0);
  });

  it('validates the pocket against the WRITER\'s own list, not a copy', async () => {
    const plain = await subject();
    // `lockedBalance` is a real wallet field and deliberately NOT adjustable:
    // a locked balance follows the bet or withdrawal holding it. A route
    // carrying its own list of pockets is free to drift from the writer that
    // decides, and would turn this into a 500 dressed as a validation pass.
    expect(ADJUSTABLE_FIELDS).not.toContain('lockedBalance');
    const res = await adjust({
      userId: plain.userId, type: 'CREDIT', field: 'lockedBalance', amount: 10, reason: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Adjustable/i);
  });

  it('refuses an unknown type rather than guessing a direction', async () => {
    const plain = await subject();
    const res = await adjust({
      userId: plain.userId, type: 'TRANSFER', field: 'depositBalance', amount: 10, reason: 'x',
    });
    expect(res.status).toBe(400);
    expect((await getBalancesPaise(plain.userId)).depositBalance).toBe(0);
  });

  it('answers 404 for a user that does not exist, and writes nothing', async () => {
    const res = await adjust({
      userId: 'no-such-user-at-all', type: 'CREDIT', field: 'depositBalance',
      amount: 10, reason: 'ghost',
    });
    expect(res.status).toBe(404);
  });
});
