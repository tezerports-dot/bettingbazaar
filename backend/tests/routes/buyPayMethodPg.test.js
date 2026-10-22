// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A UPI/bank buy is paid by UPI or by bank transfer, as the player chooses
 * (owner, 2026-10-21), on a real database through the player's route.
 *
 * - The route refuses a UPI/bank-size buy that names neither, and writes
 *   nothing; a cash-size buy needs no choice and carries none.
 * - A UPI buy goes only to a member with a UPI ID, and the player is given a
 *   link built from it for the order's exact amount, never the bank account.
 * - A BANK buy goes to a member's bank account, and the player is given that.
 * - Each has its own window (`SystemConfig.buyPayWindowSeconds`).
 * - The choice is frozen on the row.
 *
 * The suite writes the windows and the size lists and puts them back (trap 10).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { routingCandidates } from '#db/repositories/teamRouting.js';
import { ORDER_SIZES } from '../../domains/merchant/denominations.js';
import { toPlayerOrderView } from '../../domains/payment/playerOrderView.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('how a player pays a UPI/bank buy', () => {
  const teams = teamFixture();
  const players = [];
  let app, prior, team, withUpi, bankOnly;
  const WINDOWS = { UPI: 600, BANK: 2400 };

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    const cfg = await getSystemConfig();
    prior = {
      buyOrderSizes: cfg.buyOrderSizes, merchantBuySizes: cfg.merchantBuySizes,
      buyPayWindowSeconds: cfg.buyPayWindowSeconds,
    };
    await applySystemConfig({
      buyOrderSizes: [...ORDER_SIZES], merchantBuySizes: [], buyPayWindowSeconds: WINDOWS,
    }, { actor: 'buy-pay-method-suite' });
    team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 400_000 });
    [withUpi, bankOnly] = team.members;
    await updateMerchant(withUpi, { upiId: 'shop.counter@okaxis' });
    await teams.onlyOnline([withUpi, bankOnly]);
  }, 60_000);

  afterAll(async () => {
    await applySystemConfig(prior, { actor: 'buy-pay-method-suite' });
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await c.query('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    });
    await teams.cleanup();
    await closePg();
  });

  const player = async () => { const p = await actor({}); players.push(p.userId); return p; };
  const buy = (who, body) => as(app, who).post('/deposit/create').send(body);
  const finish = (orderId) => pgQuery("UPDATE order_states SET state = 'CANCELLED' WHERE order_id = $1", [orderId]);

  it('refuses a UPI/bank-size buy that names no way to pay, and writes nothing', async () => {
    const p = await player();
    for (const body of [{ tokenAmount: 50_000 }, { tokenAmount: 50_000, payMethod: 'CHEQUE' }]) {
      const res = await buy(p, body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe('PAY_METHOD_REQUIRED');
      expect(res.body.payMethods).toEqual(['UPI', 'BANK']);
    }
    const { rows } = await pgQuery('SELECT 1 FROM order_states WHERE user_id = $1', [p.userId]);
    expect(rows).toHaveLength(0);
  });

  it('a cash-size buy needs no choice and carries none', async () => {
    const p = await player();
    const res = await buy(p, { tokenAmount: 1_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await getOrderRecord(res.body.order.orderId);
    expect(row).toMatchObject({ paymentMode: 'CASH_ATM', buyPayMethod: null });
    await finish(row.orderId);
  });

  it('a UPI buy goes to the member with a UPI ID, and the player pays a link for the exact amount', async () => {
    const p = await player();
    expect((await routingCandidates({ orderId: 'probe', type: 'DEPOSIT', paymentMode: 'P2P_UPI', currency: 'INR',
      tokenAmountPaise: 5_000_000, buyPayMethod: 'UPI' }, { cap: 3 })).map((c) => c.merchantId)).toEqual([withUpi]);
    const before = Date.now();
    const res = await buy(p, { tokenAmount: 50_000, payMethod: 'upi' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await getOrderRecord(res.body.order.orderId);
    expect(row).toMatchObject({ buyPayMethod: 'UPI', status: 'PROCESSING', merchantId: withUpi });
    // Its own window.
    const left = (new Date(row.expiresAt).getTime() - before) / 1000;
    expect(left).toBeGreaterThan(WINDOWS.UPI - 30);
    expect(left).toBeLessThanOrEqual(WINDOWS.UPI + 5);
    const payTo = toPlayerOrderView(row).payTo;
    expect(payTo.bankAccount).toBeUndefined();
    const q = new URLSearchParams(payTo.paymentLink.slice('upi://pay?'.length));
    expect(q.get('pa')).toBe('shop.counter@okaxis');
    expect(q.get('am')).toBe('50000.00');
    // Frozen on the row.
    await expect(pgQuery("UPDATE order_states SET buy_pay_method = 'BANK' WHERE order_id = $1", [row.orderId]))
      .rejects.toThrow(/is paid by UPI and cannot be moved to BANK/);
    await finish(row.orderId);
  });

  it('a BANK buy is paid to a member\'s bank account, in its own window', async () => {
    const p = await player();
    const before = Date.now();
    const res = await buy(p, { tokenAmount: 50_000, payMethod: 'BANK' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await getOrderRecord(res.body.order.orderId);
    expect(row.buyPayMethod).toBe('BANK');
    expect([withUpi, bankOnly]).toContain(row.merchantId);
    const left = (new Date(row.expiresAt).getTime() - before) / 1000;
    expect(left).toBeGreaterThan(WINDOWS.BANK - 30);
    expect(left).toBeLessThanOrEqual(WINDOWS.BANK + 5);
    const payTo = toPlayerOrderView(row).payTo;
    expect(payTo.paymentLink).toBeUndefined();
    expect(payTo.bankAccount.accountNo).toMatch(/^5020/);
    await finish(row.orderId);
  });

  it('no member with a UPI ID online: a UPI buy waits, it is never sent to a bank account', async () => {
    await teams.onlyOnline([bankOnly]);
    try {
      const p = await player();
      const res = await buy(p, { tokenAmount: 50_000, payMethod: 'UPI' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await getOrderRecord(res.body.order.orderId);
      expect(row).toMatchObject({ status: 'PENDING_QUEUE', merchantId: null, buyPayMethod: 'UPI' });
      await finish(row.orderId);
    } finally {
      await teams.onlyOnline([withUpi, bankOnly]);
    }
  });
});
