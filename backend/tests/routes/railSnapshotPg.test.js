// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An order runs on the rail its OWN size and currency put it on — stamped once,
 * frozen, and the only thing routing reads.
 *
 * ── What this used to guard ─────────────────────────────────────────────────
 * There was a platform-wide rail switch. `createDepositOrder` read it to judge
 * the amount, and `createOrderRecord` read it AGAIN to stamp the row, so an
 * admin flipping it between the two reads produced an order stamped on a rail
 * it was never checked for: a UPI-validated ₹7,770 born as a cash order no ATM
 * can serve (review C1).
 *
 * The switch is gone (PROJECT_STATUS §3.10, 2c). The rail is DERIVED from the
 * order — USDT is the USDT rail; INR up to 10,000 tokens is CASH; above it is
 * UPI_BANK — by one function (`paymentModeFor`) that the gate and the writer
 * both call with the same two facts. There is no second read left to race, so
 * what is asserted now is what replaced it:
 *
 *   1. a caller cannot NAME a rail — the writer refuses the field;
 *   2. the stamp is what the gate judged by, at the boundary;
 *   3. the stamp cannot change once written (a trigger, not a convention);
 *   4. routing follows the stamp: a cash order reaches a CASH team's member
 *      who is at the machine, and nobody else; a UPI order never reaches a
 *      CASH team however idle and well-funded it is.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getPool } from '#db/repositories/teamPools.js';
import { setCashReady } from '#db/repositories/teamRouting.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { PAYMENT_MODES, railOf } from '#db/repositories/orderRails.js';
import { createDepositOrder, tryAssignMerchant } from '../../domains/payment/paymentProcessing.service.js';
import { MAX_CASH_BUY_PAISE } from '../../domains/merchant/denominations.js';
import { teamFixture } from '../teamFixture.js';
import { actor, merchantActor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const CEILING = MAX_CASH_BUY_PAISE / 100;

describePg('the rail an order runs on', () => {
  const teams = teamFixture();
  const orders = [];
  let seq = 0;
  const oid = () => `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  const buy = async (rupees) => {
    const player = await actor({});
    const { order } = await createDepositOrder(player.userId, rupees);
    orders.push(order.orderId);
    return getOrderRecord(order.orderId);
  };

  beforeAll(async () => {
    await applySchema();
    // Nobody online until a test builds its own teams: a stamp is asserted on
    // a queued order, never on one some other suite's team happened to take.
    await teams.onlyOnline([]);
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

  it('cannot be named by the caller — the writer refuses the field', async () => {
    // A fixture or a future route that could pass a rail could stamp a ₹500
    // order UPI or a ₹50,000 one CASH: a row no player's choices would make
    // (§32 S16), and an order no team on that rail could serve.
    const orderId = oid();
    await expect(createOrderRecord({
      orderId, userId: 'rs-nobody', type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500, paymentMode: PAYMENT_MODES.P2P_UPI,
    })).rejects.toThrow(/unknown field\(s\): paymentMode/);
    expect(await getOrderRecord(orderId)).toBeNull();
  });

  it('is the rail the buy was judged by, either side of the cash ceiling', async () => {
    // The ceiling itself is a cash buy — it is a denomination, so the gate
    // admitted it as one — and one step above is UPI, which the gate admitted
    // as a range. Born on any other rail, either would be an order its rail
    // cannot serve.
    const atCeiling = await buy(CEILING);
    expect(atCeiling.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
    expect(railOf(atCeiling)).toBe('CASH');

    const above = await buy(CEILING + 10);
    expect(above.paymentMode).toBe(PAYMENT_MODES.P2P_UPI);
    expect(railOf(above)).toBe('UPI_BANK');
  });

  it('cannot be changed once written', async () => {
    // Not by the field allowlist — `paymentMode` is not settable — and not by
    // a raw UPDATE either: the member serving an order must never find it has
    // become a different job under them.
    const row = await buy(500);
    expect(row.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
    await expect(pgQuery(
      'UPDATE order_states SET payment_mode = $2 WHERE order_id = $1',
      [row.orderId, PAYMENT_MODES.P2P_UPI],
    )).rejects.toThrow(/cannot be moved/);
    expect((await getOrderRecord(row.orderId)).paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
  });

  it('decides who serves it: cash to a CASH member at the machine, UPI never to a CASH team', async () => {
    // Two working teams, both funded, both with a member online and free.
    const cashMember = await merchantActor();
    const upiMember = await merchantActor();
    const cashTeam = await teams.workingTeam({ rail: 'CASH', poolTokens: 50_000, include: [cashMember.merchantId] });
    const upiTeam = await teams.workingTeam({
      rail: 'UPI_BANK', poolTokens: 50_000, include: [upiMember.merchantId],
      online: [cashMember.merchantId, upiMember.merchantId],
    });
    // The cash member is at the machine, free, and their pool would cover a
    // 20,000-token buy — everything except the rail.
    expect(await setCashReady(cashMember.merchantId, true)).toEqual({ ok: true, ready: true });

    // A UPI-sized buy goes to the UPI team.
    const big = await buy(20_000);
    expect(big).toMatchObject({ status: 'ASSIGNED', merchantId: upiMember.merchantId, teamId: upiTeam.teamId });
    expect(await getPool(cashTeam.teamId)).toMatchObject({ availablePaise: 50_000_00, heldPaise: 0 });

    // A cash buy goes to the member at the machine, held in the CASH team's
    // pool, and their Ready switches itself off.
    const cash = await buy(5_000);
    expect(cash).toMatchObject({ status: 'ASSIGNED', merchantId: cashMember.merchantId, teamId: cashTeam.teamId });
    expect(await getPool(cashTeam.teamId)).toMatchObject({ availablePaise: 45_000_00, heldPaise: 5_000_00 });
    expect((await getMerchant(cashMember.merchantId)).cashReady).toBe(false);

    // With nobody at a machine, the next cash buy WAITS — it is not handed to
    // the free, funded UPI member, who cannot stand at an ATM for it.
    const waiting = await buy(1_000);
    expect(waiting).toMatchObject({ status: 'PENDING_QUEUE', teamId: null, poolHeldPaise: 0 });
    expect(waiting.merchantId ?? null).toBeNull();

    // And it is taken the moment somebody presses Ready and is free. The cash
    // member still holds the 5,000 buy (one at a time on CASH), so it is the
    // team's OTHER members who matter: put one at a machine.
    const other = cashTeam.members.find((m) => m !== cashMember.merchantId);
    await teams.onlyOnline([cashMember.merchantId, upiMember.merchantId, other]);
    expect(await setCashReady(other, true)).toEqual({ ok: true, ready: true });
    expect(await tryAssignMerchant(await getOrderRecord(waiting.orderId))).toBe(true);
    expect(await getOrderRecord(waiting.orderId)).toMatchObject({
      status: 'ASSIGNED', merchantId: other, teamId: cashTeam.teamId,
    });
  });
});
