// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The money assertions for a confirmed buy, on the route members USE —
 * `POST /api/merchant/confirm/:id` — with the order HELD in its team's pool as
 * assignment holds it.
 *
 * ── Where these came from ───────────────────────────────────────────────────
 * They lived in `paymentRoutes.test.js`, against `POST /api/payment/deposit/
 * :orderId/confirm`: a second confirm route that no screen and no workflow
 * called (F-017; check:ui-coverage --unused). Owner, 2026-10-01: delete a stale
 * duplicate once it is shown nothing uses it. The catch was that the split, the
 * double delivery, the race, the accounting event and the reference release
 * were asserted ONLY there — so deleting it would have left the live confirm
 * without them. They were ported here first, then the route went.
 *
 * ── What the merchant side is now ───────────────────────────────────────────
 * A member holds no tokens; their team's pool does (PROJECT_STATUS §3.10, 2c).
 * The buy's tokens are held in the pool when it is assigned and SPENT when it
 * is confirmed, so "the merchant paid once" is now "the pool's hold was spent
 * once, and TEAM_FLOAT moved to USER_FLOAT once". Both sides are asserted on
 * every money case (§9, §19).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord, listOrderTransitions } from '#db/repositories/orders.record.js';
import { getPool } from '#db/repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { getEvent } from '#db/repositories/ledger.core.js';
import { getUtr } from '#db/repositories/utr.js';
import { tryAssignMerchant, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import {
  MERCHANT_ORDER_FIELDS, MERCHANT_FORBIDDEN_ORDER_FIELDS,
} from '../../domains/merchant/merchantOrderView.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// Above the cash ceiling: a UPI_BANK buy, so no Ready press is involved.
const TOKENS = 20_000;
const PAISE = TOKENS * 100;

/** Both pockets of a pool, refusing a figure that is not a number (§32 S40). */
const poolTotal = async (teamId) => {
  const p = await getPool(teamId);
  const total = p.availablePaise + p.heldPaise;
  if (!Number.isFinite(total)) throw new Error(`pool pockets unreadable: ${JSON.stringify(p)}`);
  return total;
};

const teamFloat = async () => (await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT] ?? 0;

describePg('a member confirms a buy — the money', () => {
  let app; let seq = 0;
  const teams = teamFixture();
  const orders = [];
  const oid = () => `mcm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const nextUtr = () => String(430000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await teams.cleanup();
    await closePg();
  });

  /**
   * A PAID buy as production makes one: created with its split (as
   * `createDepositOrder` writes it from the deposit policy), assigned by the
   * router — which holds the tokens in the team's pool — and marked paid by
   * the player, whose reference the registry claims.
   */
  const heldPaidBuy = async ({ betting = 16_000, reserve = 4_000 } = {}) => {
    const member = await merchantActor();
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId] });
    const player = await actor({});
    const orderId = oid();
    orders.push(orderId);
    const utr = nextUtr();
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: TOKENS, fiatAmountRupees: TOKENS,
      depositAllocation: betting, reserveAllocation: reserve,
    });
    expect(await tryAssignMerchant(order), 'the router did not assign the buy').toBe(true);
    expect((await getOrderRecord(orderId)).merchantId).toBe(member.merchantId);
    await readyToPay(orderId);
    expect((await markOrderPaid(player.userId, orderId, utr)).status).toBe('PAID');
    return { member, player, orderId, utr, team };
  };

  // ── Who may confirm ──────────────────────────────────────────────────────
  it('refuses a member the order is not assigned to, and nothing moves', async () => {
    const { player, orderId, team } = await heldPaidBuy();
    // A member of ANOTHER working team — a real member, not a stray login.
    const stranger = await merchantActor();
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 0, include: [stranger.merchantId] });
    const poolBefore = await getPool(team.teamId);
    const before = await getBalancesPaise(player.userId);
    const res = await as(app, stranger).post(`/confirm/${orderId}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    expect(await getBalancesPaise(player.userId)).toEqual(before);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
  });

  // ── The split ────────────────────────────────────────────────────────────
  it('honours the split — betting and reserve pockets each get their share', async () => {
    const { member, player, orderId, team } = await heldPaidBuy({ betting: 16_000, reserve: 4_000 });
    const before = await getBalancesPaise(player.userId);
    const poolBefore = await poolTotal(team.teamId);
    const res = await as(app, member).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await getBalancesPaise(player.userId);
    expect(after.depositBalance - before.depositBalance).toBe(16_000_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(4_000_00);
    // The pool parts with the WHOLE amount — the split is the player's side only.
    expect(poolBefore - await poolTotal(team.teamId)).toBe(PAISE);
  });

  it('credits the whole amount to betting when the policy reserves nothing', async () => {
    // A deposit policy of 100/0 is legal, so a zero reserve share is a real
    // order; nothing reaches the reserve pocket and nothing is lost.
    const { member, player, orderId } = await heldPaidBuy({ betting: TOKENS, reserve: 0 });
    const before = await getBalancesPaise(player.userId);
    expect((await as(app, member).post(`/confirm/${orderId}`)).status).toBe(200);
    const after = await getBalancesPaise(player.userId);
    expect(after.depositBalance - before.depositBalance).toBe(PAISE);
    expect(after.reserveBalance).toBe(before.reserveBalance);
  });

  // ── Exactly once ─────────────────────────────────────────────────────────
  it('credits ONCE when the same confirm arrives twice', async () => {
    const { member, player, orderId, team } = await heldPaidBuy();
    expect((await as(app, member).post(`/confirm/${orderId}`)).status).toBe(200);
    const playerAfterFirst = await getBalancesPaise(player.userId);
    const poolAfterFirst = await poolTotal(team.teamId);
    const floatAfterFirst = await teamFloat();

    const second = await as(app, member).post(`/confirm/${orderId}`);
    expect(second.status).toBeLessThan(500);
    expect(await getBalancesPaise(player.userId)).toEqual(playerAfterFirst);
    expect(await poolTotal(team.teamId)).toBe(poolAfterFirst);
    expect(await teamFloat()).toBe(floatAfterFirst);
  });

  it('survives four confirms racing each other — the tokens move once', async () => {
    const { member, player, orderId, team } = await heldPaidBuy();
    const before = await getBalancesPaise(player.userId);
    const poolBefore = await poolTotal(team.teamId);
    const floatBefore = await teamFloat();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => as(app, member).post(`/confirm/${orderId}`)),
    );
    expect(results.every((r) => r.status < 500), results.map((r) => r.status).join(',')).toBe(true);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const after = await getBalancesPaise(player.userId);
    expect(after.depositBalance - before.depositBalance).toBe(16_000_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(4_000_00);
    expect(poolBefore - await poolTotal(team.teamId)).toBe(PAISE);
    expect(floatBefore - await teamFloat()).toBe(PAISE);
    expect(await getPool(team.teamId)).toMatchObject({ heldPaise: 0 });
  });

  // ── The books and the reference ──────────────────────────────────────────
  it('posts the accounting event with the completion', async () => {
    const { member, orderId } = await heldPaidBuy();
    expect((await as(app, member).post(`/confirm/${orderId}`)).status).toBe(200);
    const completed = (await listOrderTransitions(orderId)).filter((t) => t.toState === 'COMPLETED');
    expect(completed).toHaveLength(1);
    expect(completed[0].ledgerKey, 'the completion recorded no ledger key').toBeTruthy();
    expect(await getEvent(completed[0].ledgerKey), 'no accounting event behind the completion').toBeTruthy();
  });

  it('releases the bank reference when the buy completes', async () => {
    const { member, orderId, utr } = await heldPaidBuy();
    // Claimed by the player's mark-paid, against THIS order.
    expect(await getUtr(utr)).toMatchObject({ orderId, status: 'ACTIVE' });
    expect((await as(app, member).post(`/confirm/${orderId}`)).status).toBe(200);
    expect((await getUtr(utr)).status).toBe('RELEASED');
  });

  // ── What a member is told ────────────────────────────────────────────────
  it("answers in the member's projection — every key allowed, none forbidden", async () => {
    // The row carries what a member must never see: the snapshot written at
    // assignment (the member's own bank details, kept for disputes),
    // the player's deposit split, the tamper tag. Asserting the KEY SET rather
    // than one absent field is §24.2: a new leak fails without anybody adding
    // a line here.
    const { member, orderId } = await heldPaidBuy();
    const row = await getOrderRecord(orderId);
    expect(row.merchantSnapshot, 'the row has no snapshot, so this would prove nothing').toBeTruthy();
    expect(row.depositAllocation).toBe(16_000);

    const res = await as(app, member).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const keys = Object.keys(res.body.order);
    expect(keys.length).toBeGreaterThan(0);
    const allowed = new Set(MERCHANT_ORDER_FIELDS);
    expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
    expect(keys.filter((k) => MERCHANT_FORBIDDEN_ORDER_FIELDS.includes(k))).toEqual([]);
    // Nor the pool's bookkeeping: which team holds what is not the member's screen.
    expect(keys).not.toContain('poolHeldPaise');
  });
});
