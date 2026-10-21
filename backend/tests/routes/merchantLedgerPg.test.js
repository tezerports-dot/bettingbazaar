// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant's business ledger (owner, 2026-10-21), driven through the real
 * routes against PostgreSQL with orders production makes (§32 S16):
 *
 *   • a member's confirmed buy and paid sell are in their buys and sells; a
 *     buy rejected as not received is in neither (not business);
 *   • the supervisor who funded the pool sees the pool bought from the
 *     platform and what they paid, and the net profit adds up from the rows;
 *   • another member sees none of it (trap 16);
 *   • the workbook carries every table, labelled, transaction ID last.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import { createDepositOrder, createWithdrawalOrder, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';
import { binary, readXlsx } from '../_xlsx.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the merchant business ledger', () => {
  let app;
  let seq = 0;
  const teams = teamFixture();
  const made = [];
  let member; let other; let supervisor;
  const ids = {};
  const utr = () => `${String(Date.now()).slice(-8)}${String((seq += 1) + 7000).slice(-4)}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    member = await merchantActor({});
    other = await merchantActor({});
    supervisor = await merchantActor({});
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000, include: [member.merchantId], supervisorId: supervisor.merchantId });
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [other.merchantId] });
    await teams.onlyOnline([member.merchantId]);

    const buy = async () => {
      const p = await actor({});
      const { order } = await createDepositOrder(p.userId, 50_000);
      const orderId = order.orderId ?? order._id;
      made.push(orderId);
      expect((await getOrderRecord(orderId)).merchantId).toBe(String(member.merchantId));
      expect((await markOrderPaid(p.userId, orderId, utr())).status).toBe('PAID');
      return orderId;
    };
    ids.confirmed = await buy();
    expect((await as(app, member).post(`/confirm/${ids.confirmed}`).send({})).status).toBe(200);
    ids.rejected = await buy();
    expect((await as(app, member).post(`/orders/${ids.rejected}/reject`).send({ reason: 'Nothing arrived' })).status).toBe(200);

    const seller = await actor({});
    await updateUser(seller.userId, {
      bankDetails: { accountNumber: '000111222334', ifscCode: 'HDFC0000001', bankName: 'HDFC Bank', accountHolderName: 'Test Player' },
    });
    await creditWinnings(seller.userId, 50_000, 'ledger suite seed', 'Test', `seed_${seller.userId}`, `led_seed_${seller.userId}`);
    const { order } = await createWithdrawalOrder(seller.userId, 50_000);
    ids.sell = order.orderId ?? order._id;
    made.push(ids.sell);
    expect((await as(app, member).post(`/confirm/${ids.sell}`).send({ utrNumber: utr() })).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM utr_registry WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM chat_messages WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  const ledger = (who) => as(app, who).get('/reports/ledger');

  it("puts a member's confirmed buy and paid sell in their tables, and the rejected buy in none", async () => {
    const res = await ledger(member);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.buys.map((r) => r.orderId)).toEqual([ids.confirmed]);
    expect(res.body.sells.map((r) => r.orderId)).toEqual([ids.sell]);
    expect(res.body.sells[0].state).toBe('PAID');
    const all = [...res.body.buys, ...res.body.sells, ...res.body.disputes].map((r) => r.orderId);
    expect(all).not.toContain(ids.rejected);
    expect(res.body.totals).toMatchObject({
      userBuys: 1, userBuysPaise: 5_000_000, userSells: 1, userSellsPaise: 5_000_000, netUserPaise: 0,
      boughtPaise: 0, netProfitPaise: 0,
    });
  });

  it('shows the supervisor the pool they bought from the platform and what they paid', async () => {
    const res = await ledger(supervisor);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.pool).toHaveLength(1);
    expect(res.body.pool[0]).toMatchObject({ direction: 'BUY', tokensPaise: 10_000_000, currency: 'INR', inrPaise: 10_000_000 });
    const t = res.body.totals;
    expect(t).toMatchObject({ boughtPaise: 10_000_000, paidToAdminPaise: 10_000_000, netWithAdminPaise: 10_000_000, pools: 1 });
    // Net profit is the rows' arithmetic: bought at par, nothing earned yet.
    expect(t.netProfitPaise).toBe((t.boughtPaise - t.paidToAdminPaise) - (t.returnedPaise - t.receivedFromAdminPaise)
      + t.commissionPaise - t.compensationPaise);
    // The pool now: what was bought, less the buy the member spent out of it.
    expect(t.poolAvailablePaise + t.poolHeldPaise).toBe(10_000_000 - 5_000_000);
  });

  it('shows another member none of it', async () => {
    const res = await ledger(other);
    expect(res.status).toBe(200);
    const theirs = [...res.body.buys, ...res.body.sells].map((r) => r.orderId);
    for (const id of Object.values(ids)) expect(theirs).not.toContain(id);
    expect(res.body.totals.userBuys).toBe(0);
  });

  it('downloads every table, labelled, with the transaction ID last', async () => {
    const res = await as(app, member).get('/reports/ledger.xlsx').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(/business-ledger-.*\.xlsx/);
    const book = readXlsx(res.body);
    expect(Object.keys(book)).toEqual(['Ledger', 'Buys', 'Sells', 'Commission', 'Pool trades', 'Disputes']);
    const sheet = book.Ledger;
    for (const heading of ['Summary', 'Player buys (1)', 'Player sells (1)', 'Commission (0)', 'Disputes (0)']) {
      expect(sheet.some((r) => r[0] === heading)).toBe(true);
    }
    const buyRow = book.Buys.find((r) => r[r.length - 1] === ids.confirmed);
    expect(buyRow).toContain(50_000);
    const header = book.Buys.find((r) => r[0] === 'Time (IST)');
    expect(header[header.length - 1]).toBe('Transaction ID');
    expect(book.Ledger.find((r) => r[0] === 'Net with players (buys − sells)')[1]).toBe(0);
    expect(book.Ledger.some((r) => r.includes(ids.rejected))).toBe(false);
  });

  it("is the business's own: a sub-member needs AUDIT (agents are their own owner)", async () => {
    // An agent's session is its owner's; covered for merchant-account
    // sub-members in merchantAccountPg.test.js (ROLE_REQUIRED without AUDIT).
    expect((await ledger(member)).status).toBe(200);
    const bad = await as(app, member).get('/reports/ledger?from=yesterday');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_REPORT_RANGE');
  });
});
