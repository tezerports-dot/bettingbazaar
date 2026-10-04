// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The payment reference sits on the side that PAID.
 *
 * A buy and a sell are mirror images, and the reference follows the money
 * rather than the order:
 *
 *   BUY   the PLAYER pays the merchant. Their UTR arrives at `mark-paid`, is
 *         claimed against the order there, and the confirm reads it off the
 *         row. A merchant restating it would be a second writer for a value
 *         that already has an owner (§27).
 *   SELL  the MERCHANT pays the player out of their own bank account. The
 *         reference for that transfer exists only on their receipt, so it is
 *         theirs to give and there is nobody else who could.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Fixing the buy side took `utrNumber` out of the confirm body, which was right
 * for a deposit and wrong for a withdrawal: it took the merchant's payout
 * reference with it, on a route where the merchant is the only party who has
 * one. A payout then completed with nothing recorded against it and the
 * player's notification read "UTR / Ref: Provided separately" — for a transfer
 * that did have a reference, which nobody had been asked for.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * Both directions of the asymmetry, so neither can be "simplified" into the
 * other, and the CLAIM — a merchant's bank transfer is a real payment and the
 * same registry decides whether it has been spent. Without that, one transfer
 * could be presented as proof of two payouts (§27).
 *
 * Every sell is paid by bank transfer, whichever team serves it (owner,
 * 2026-10-03), so a cash-team payout is held to the same rule.
 *
 * ── How the orders get to the merchant (PROJECT_STATUS §3.10, 2c) ───────────
 * Through the real path: the player's withdrawal (or buy) is created by the
 * service, ROUTED to the one online member of a working team on the order's
 * rail, and accepted through the merchant's own route. The rail is the order's
 * size — 50,000 is UPI/bank, 1,000 is cash (Step 2d) — never a switch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { getPool } from '#db/repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { PAYMENT_MODES } from '#db/repositories/teamRouting.js';
import {
  createWithdrawalOrder, createDepositOrder, markOrderPaid,
} from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the payout reference is the MERCHANT\'s, and it is claimed', () => {
  const teams = teamFixture();
  let app;
  let seq = 0;
  // Unique per order: a reference belongs to exactly one order, by index (§27).
  const utr = () => `UTRPAY${String(Date.now()).slice(-6)}${String(seq += 1).padStart(4, '0')}`;

  const UPI_RUPEES = 50_000;   // a UPI/bank size (Step 2d)
  const CASH_RUPEES = 1_000;   // a cash denomination: CASH

  const players = [];
  // One member per case, so no case finds its member at the rail's cap with
  // an earlier case's open order.
  const upiMembers = [];
  let cashMember;
  let upiTeam;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    for (let i = 0; i < 5; i += 1) upiMembers.push(await merchantActor({}));
    cashMember = await merchantActor({});
    upiTeam = await teams.workingTeam({
      rail: 'UPI_BANK', poolTokens: 50_000, include: upiMembers.map((m) => m.merchantId),
    });
    await teams.workingTeam({ rail: 'CASH', include: [cashMember.merchantId] });
  }, 120_000);

  afterAll(async () => {
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

  const player = async () => {
    const p = await actor({});
    players.push(p.userId);
    return p;
  };

  /**
   * A withdrawal sitting where the merchant presses "I've sent the money":
   * created by the player, routed to `merchant` (the only member online),
   * accepted by them.
   */
  const payout = async (merchant, rupees = UPI_RUPEES) => {
    const p = await player();
    await updateUser(p.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(p.userId, rupees, 'payout reference suite seed', 'Test',
      `seed_${p.userId}`, `pr_seed_${p.userId}`);
    await teams.onlyOnline([merchant.merchantId]);
    const { order } = await createWithdrawalOrder(p.userId, rupees);
    const orderId = order.orderId ?? order._id;
    const routed = await getOrderRecord(orderId);
    expect(routed.status, 'the withdrawal was not routed to the member').toBe('ASSIGNED');
    expect(routed.merchantId).toBe(String(merchant.merchantId));
    const accepted = await as(app, merchant).post(`/accept/${orderId}`).send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return { orderId, player: p };
  };

  it('refuses a UPI payout with no reference, and moves nothing', async () => {
    const m = upiMembers[0];
    const { orderId, player: p } = await payout(m);
    const before = await getBalancesPaise(p.userId);

    const res = await as(app, m).post(`/confirm/${orderId}`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('PAYOUT_REFERENCE_REQUIRED');
    // The refusal lands BEFORE the transition, so the order is untouched and
    // the merchant can try again with the reference in hand.
    const row = await getOrderRecord(orderId);
    expect(row.state).toBe('PROCESSING');
    expect(row.paymentMode).toBe(PAYMENT_MODES.P2P_UPI);
    expect(await getBalancesPaise(p.userId)).toEqual(before);
  });

  it('records the merchant\'s reference on the order', async () => {
    const m = upiMembers[1];
    const { orderId } = await payout(m);
    const reference = utr();

    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: reference });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await getOrderRecord(orderId);
    // Uppercased on the way in, as every claimed reference is — a code stored
    // in two cases is two references as far as the registry is concerned.
    expect(row.utrNumber).toBe(reference.toUpperCase());
    // PAID under the hold, or COMPLETED with it disabled. Either is "the
    // merchant has asserted the payout"; this test is about the reference.
    expect(['PAID', 'COMPLETED']).toContain(row.state);
  });

  it('CLAIMS it — the same transfer cannot pay two withdrawals', async () => {
    const m = upiMembers[2];
    const first = await payout(m);
    const second = await payout(m);
    const reference = utr();

    expect((await as(app, m).post(`/confirm/${first.orderId}`).send({ utrNumber: reference })).status).toBe(200);

    const dup = await as(app, m).post(`/confirm/${second.orderId}`).send({ utrNumber: reference });
    expect(dup.status, 'one bank transfer must not settle two payouts').toBe(409);
    // And it names the order already holding it, so support can answer
    // "it says already used" without a second lookup that may disagree.
    expect(dup.body.originalOrderId).toBe(first.orderId);
    expect((await getOrderRecord(second.orderId)).state).toBe('PROCESSING');
  });

  it('refuses a reference too short to be a UTR', async () => {
    const m = upiMembers[3];
    const { orderId } = await payout(m);

    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: 'SHORT' });
    expect(res.status).toBe(400);
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
  });

  it('asks for one on a CASH-team sell too — it is a bank transfer like any other', async () => {
    const { orderId } = await payout(cashMember, CASH_RUPEES);
    expect((await getOrderRecord(orderId)).paymentMode).toBe(PAYMENT_MODES.CASH_ATM);

    // No body: refused by name, and the order is where it was. The CDM slip
    // that once stood in for a reference went with the cash-machine payout.
    const bare = await as(app, cashMember).post(`/confirm/${orderId}`).send({});
    expect(bare.status).toBe(400);
    expect(bare.body.code).toBe('PAYOUT_REFERENCE_REQUIRED');
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');

    // With the bank's UTR it goes through, and the reference is claimed.
    const reference = utr();
    const res = await as(app, cashMember).post(`/confirm/${orderId}`).send({ utrNumber: reference });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(['PAID', 'COMPLETED']).toContain((await getOrderRecord(orderId)).state);
    const claimed = await pgQuery('SELECT order_id FROM utr_registry WHERE utr = $1', [reference.toUpperCase()]);
    expect(claimed.rows[0]?.order_id).toBe(orderId);
  });

  // ── The other half of the asymmetry, so it cannot be collapsed ───────────
  it('a DEPOSIT still takes no reference from the merchant — and the pool pays the player once', async () => {
    const m = upiMembers[4];
    const p = await player();
    await teams.onlyOnline([m.merchantId]);
    const { order } = await createDepositOrder(p.userId, UPI_RUPEES);
    const orderId = order.orderId ?? order._id;
    expect((await getOrderRecord(orderId)).merchantId).toBe(String(m.merchantId));
    expect((await as(app, m).post(`/accept/${orderId}`).send({})).status).toBe(200);
    const playersReference = utr();
    await markOrderPaid(p.userId, orderId, playersReference);

    const poolBefore = await getPool(upiTeam.teamId);
    const treasuryBefore = await getTreasuryBalances();
    const walletBefore = await getBalancesPaise(p.userId);

    // The merchant posting a DIFFERENT reference on a buy. The player's is
    // already claimed against this order; writing the merchant's over it would
    // leave the row naming a reference nothing had claimed.
    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: 'MERCHANTSUPPLIED9999' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await getOrderRecord(orderId);
    expect(row.utrNumber).toBe(playersReference.toUpperCase());
    expect(row.state).toBe('COMPLETED');

    // Both sides of the money (§9, §19): the team pool's HOLD is spent, the
    // treasury moves it from TEAM_FLOAT to USER_FLOAT, and the player is
    // credited the same amount, split between their pockets.
    const A = UPI_RUPEES * 100;
    const poolAfter = await getPool(upiTeam.teamId);
    expect(poolBefore.heldPaise - poolAfter.heldPaise).toBe(A);
    expect(poolAfter.availablePaise).toBe(poolBefore.availablePaise);
    const treasuryAfter = await getTreasuryBalances();
    expect(treasuryBefore[ACCOUNTS.TEAM_FLOAT] - treasuryAfter[ACCOUNTS.TEAM_FLOAT]).toBe(A);
    expect(treasuryAfter[ACCOUNTS.USER_FLOAT] - treasuryBefore[ACCOUNTS.USER_FLOAT]).toBe(A);
    const walletAfter = await getBalancesPaise(p.userId);
    const credited = (walletAfter.depositBalance - walletBefore.depositBalance)
      + (walletAfter.reserveBalance - walletBefore.reserveBalance);
    expect(credited).toBe(A);
  });
});
