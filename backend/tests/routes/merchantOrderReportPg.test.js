// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant's order report (owner, 2026-10-16): one row per order, with
 * the ✓ or ✗ pressed on it and who pressed it, and totals over EVERY row, not
 * the page. Driven through the real routes against PostgreSQL:
 *
 *   • a confirmed buy is ✓, a buy rejected as not received is ✗, a paid-out
 *     sell is ✓, each by the member ("You" on an agent's report);
 *   • the totals count all three when the page holds one;
 *   • another member's report does not contain them (trap 16);
 *   • `type` filters, and an unknown type or a bad range is a 400 saying so;
 *   • the CSV carries the same rows with ✓/✗.
 *
 * Every order is one production makes (§32 S16): created by the player and
 * routed to the one online member of a working team.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import { createDepositOrder, createWithdrawalOrder, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the merchant order report', () => {
  let app;
  let seq = 0;
  const teams = teamFixture();
  const made = [];
  let member; let other;
  const ids = {};
  const utr = () => `${String(Date.now()).slice(-8)}${String((seq += 1) + 5000).slice(-4)}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    member = await merchantActor({});
    other = await merchantActor({});
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000, include: [member.merchantId] });
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
    const ok = await as(app, member).post(`/confirm/${ids.confirmed}`).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    ids.rejected = await buy();
    const no = await as(app, member).post(`/orders/${ids.rejected}/reject`).send({ reason: 'Nothing arrived' });
    expect(no.status, JSON.stringify(no.body)).toBe(200);

    const seller = await actor({});
    await updateUser(seller.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'HDFC0000001', bankName: 'HDFC Bank', accountHolderName: 'Test Player' },
    });
    await creditWinnings(seller.userId, 50_000, 'report suite seed', 'Test', `seed_${seller.userId}`, `rep_seed_${seller.userId}`);
    const { order } = await createWithdrawalOrder(seller.userId, 50_000);
    ids.sell = order.orderId ?? order._id;
    made.push(ids.sell);
    expect((await getOrderRecord(ids.sell)).merchantId).toBe(String(member.merchantId));
    const paid = await as(app, member).post(`/confirm/${ids.sell}`).send({ utrNumber: utr() });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
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

  const report = (who, query = '') => as(app, who).get(`/reports/orders${query}`);

  it('marks each order ✓ or ✗ with who pressed it', async () => {
    const res = await report(member);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byId = Object.fromEntries(res.body.rows.map((r) => [r.orderId, r]));
    expect(byId[ids.confirmed]).toMatchObject({ result: 'CONFIRMED', type: 'DEPOSIT', tokenAmount: 50_000, actedBy: { kind: 'MERCHANT', name: 'You' } });
    expect(byId[ids.confirmed].utr).toBeTruthy();
    expect(byId[ids.rejected]).toMatchObject({ result: 'REJECTED', state: 'REJECTED', actedBy: { kind: 'MERCHANT', name: 'You' } });
    expect(byId[ids.sell]).toMatchObject({ result: 'CONFIRMED', type: 'WITHDRAWAL', state: 'PAID', actedBy: { kind: 'MERCHANT' } });
  });

  it('counts the totals over every row, not the page', async () => {
    const res = await report(member, '?limit=1');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.totals).toMatchObject({ orders: 3, confirmed: 2, rejected: 1, confirmedBuyPaise: 5_000_000, confirmedSellPaise: 5_000_000 });
    expect(res.body.pagination).toMatchObject({ total: 3, limit: 1, skip: 0 });
    const second = await report(member, '?limit=1&skip=1');
    expect(second.body.rows[0].orderId).not.toBe(res.body.rows[0].orderId);
  });

  it('shows another member none of these orders', async () => {
    const res = await report(other);
    expect(res.status).toBe(200);
    const theirs = res.body.rows.map((r) => r.orderId);
    for (const id of Object.values(ids)) expect(theirs).not.toContain(id);
    expect(res.body.totals.orders).toBe(0);
  });

  it('filters by type and refuses what it cannot read', async () => {
    const sells = await report(member, '?type=WITHDRAWAL');
    expect(sells.body.rows.map((r) => r.orderId)).toEqual([ids.sell]);
    const bad = await report(member, '?type=EVERYTHING');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('UNKNOWN_ORDER_TYPE');
    const range = await report(member, '?from=yesterday');
    expect(range.status).toBe(400);
    expect(range.body.code).toBe('INVALID_REPORT_RANGE');
  });

  it('downloads the same rows as CSV', async () => {
    const res = await as(app, member).get('/reports/orders.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('transaction_id,type,user,utr,amount_tokens,time,result,acted_by,state');
    expect(lines.find((l) => l.startsWith(ids.confirmed))).toContain(',✓,You,');
    expect(lines.find((l) => l.startsWith(ids.rejected))).toContain(',✗,You,');
  });
});
