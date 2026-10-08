// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The order's timeline names nobody's mobile number or UPI handle (§24, Step 2d).
 *
 * The owner's rule (2026-10-03): the player sees the member's bank account on a
 * bank-transfer buy, the member sees the player's on a sell, and NOBODY sees
 * anyone's mobile number. A UPI handle is usually a mobile number with a bank
 * suffix, so it counts as one.
 *
 * The order views are allowlists and tested elsewhere. This is the text built
 * BESIDE them: the system messages the accept route writes into the order's
 * thread, which the player and the member both read in a dispute. The accept
 * message once said "UPI ID: <the member's handle>" to the player.
 *
 * Every order is one production makes (§32 S16): routed by `createDepositOrder`
 * or `createWithdrawalOrder` to a member of a working team, and accepted
 * through the member's own route.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { listMessages } from '#db/repositories/chat.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import { createDepositOrder, createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the order timeline names nobody\'s mobile or UPI handle', () => {
  let merchantApp;
  const RUN = Math.random().toString(36).slice(2, 8);
  const teams = teamFixture();
  const made = [];

  beforeAll(async () => {
    await applySchema();
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    // Trap 10: this run's orders and their thread, then its teams.
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM chat_messages WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  /**
   * A member. They once held a UPI handle (usually their mobile with a bank
   * suffix) that the accept message printed; the handle is gone with its
   * column (`merchants.bank_upi_id`), so it is their MOBILE that is looked for.
   */
  const aMember = () => merchantActor({});

  const thread = async (orderId) => (await listMessages(orderId)).map((m) => m.message).join('\n');

  it('a bank-transfer buy: the accept message points at the account, not the handle', async () => {
    const player = await actor({});
    const member = await aMember();
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId] });
    const { order } = await createDepositOrder(player.userId, 50_000);
    const orderId = order.orderId ?? order._id;
    made.push(orderId);
    expect((await getOrderRecord(orderId)).merchantId, 'the buy was not routed').toBe(String(member.merchantId));

    const res = await as(merchantApp, member).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);

    const text = await thread(orderId);
    expect(text, 'the accept message was not written').toMatch(/Order Accepted/);
    expect(text).toMatch(/bank account shown on the order/);
    expect(text).not.toContain(member.mobile);
    expect(text).not.toMatch(/@ybl|UPI ID/i);
  });

  it('a sell: the member is told the player\'s account, and not the player\'s handle or number', async () => {
    const player = await actor({});
    const member = await aMember();
    await teams.workingTeam({ rail: 'CASH', include: [member.merchantId] });
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'TEST0000001', bankName: 'Test Bank',
        accountHolderName: 'Timeline Test',
      },
    });
    await creditWinnings(player.userId, 1000, 'timeline float', 'Test', `tl-${RUN}`, `tl_${RUN}`);
    const { orderId } = (await createWithdrawalOrder(player.userId, 1000)).order;
    made.push(orderId);
    const row = await getOrderRecord(orderId);
    expect(row.merchantId, 'the sell was not routed').toBe(String(member.merchantId));
    // A player keeps no UPI handle (`users_bank_details_bank_account_only`), so
    // one is PLANTED on the order's copy, as if a future copy carried it: the
    // message is built from that copy and must still not print it.
    await setOrderFields(orderId, { userBankDetails: { ...row.userBankDetails, upiId: `${player.mobile}@okaxis` } });

    const res = await as(merchantApp, member).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);

    const text = await thread(orderId);
    expect(text, 'the accept message was not written').toMatch(/Accepted/);
    expect(text).not.toContain(player.mobile);
    expect(text).not.toContain(member.mobile);
    expect(text).not.toMatch(/@okaxis|@ybl|UPI ID/i);
  });
});
