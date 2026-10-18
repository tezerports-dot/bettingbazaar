// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * USDT buys paid to the platform on BNB Smart Chain, end to end, against a
 * real database (owner, 2026-10-18: BSC only, one address per order).
 *
 * The chain is the only thing faked: `fetch` answers `eth_blockNumber` and
 * `eth_getLogs` from a list of transfers the test writes. Everything after
 * that (the rows, the credit, the ledger, expiry) is the real code.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction, pgQuery } from '#db/client.js';
import { db } from '#db';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { createDepositOrder, markOrderPaid, expireOrders } from '../../domains/payment/paymentProcessing.service.js';
import { creditIfCovered, watchUsdtDeposits } from '../../domains/payment/usdtDeposit.service.js';
import {
  BSC_USDT_CONTRACT, TRANSFER_TOPIC, addressTopic, configuredAccountKey, deriveDepositAddress,
} from '../../domains/payment/usdtBsc.js';
import { actor, as, mountRouter } from './_harness.js';
import usdtDepositAdminRoutes from '../../domains/payment/usdtDeposit.admin.routes.js';

const describePg = pgConfigured() ? describe : describe.skip;

// The account xpub of BIP-39 test vector "abandon … about" at m/44'/60'/0'.
// Its first address (0/0) is the well-known 0x9858effd232b4033e47d90003d41ec34ecaeda94.
const TEST_XPUB = 'xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt';

const hex64 = () => `0x${Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}`;
const RAW_PER_USDT = 10n ** 18n;
const raw = (usdt) => BigInt(Math.round(usdt * 1e6)) * 10n ** 12n;

describePg('USDT buys paid to the platform on BSC', () => {
  const orders = [];
  const env = {};
  let priorPricing = null;

  const setEnv = (k, v) => { env[k] = process.env[k]; process.env[k] = v; };

  /** A USDT buy as the route makes it. */
  const buy = async (who, usdt = 100) => {
    const out = await createDepositOrder(who.userId, null, { currency: 'USDT', usdtChain: 'BEP20', usdtAmount: usdt });
    orders.push(out.order.orderId);
    out.order.usdtAddress = out.order.payTo?.usdtAddress;
    return out;
  };

  /** A transfer, recorded as the watcher records one. */
  const pay = (address, usdt, { blockNumber = 100, txHash = hex64(), logIndex = 0 } = {}) => db.usdtDeposits.recordTransfer({
    txHash, logIndex, to: address, from: `0x${'1'.repeat(40)}`, amountMicro: BigInt(Math.round(usdt * 1e6)), blockNumber,
  });

  const wallet = async (userId) => db.wallets.getBalances(userId);

  beforeAll(async () => {
    await applySchema();
    setEnv('USDT_BEP20_XPUB', TEST_XPUB);
    setEnv('BSC_RPC_URL', 'http://bsc.test/rpc');
    priorPricing = (await getSystemConfig())?.usdtPricing ?? null;
    await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 100 } }, { actor: 'usdt-platform-suite' });
  }, 60_000);

  afterEach(() => { vi.unstubAllGlobals(); });

  afterAll(async () => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (priorPricing) await applySystemConfig({ usdtPricing: priorPricing }, { actor: 'usdt-platform-suite' });
    // The rows are append-only by trigger; the test's own are removed with
    // triggers off, as every suite on this shared database does.
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      for (const table of ['usdt_deposit_transfers', 'usdt_deposit_addresses', 'order_transitions', 'order_states']) {
        await c.query(`DELETE FROM ${table} WHERE order_id = ANY($1)`, [orders]);
      }
    });
    await closePg();
  });

  it('derives the known first address of the test key', () => {
    expect(deriveDepositAddress(configuredAccountKey(), 0)).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94');
  });

  it('opens a buy already started, with its own address that nobody else has', async () => {
    const who = await actor({});
    const a = await buy(who, 100);
    const b = await buy(await actor({}), 200);
    expect(a.order.status).toBe('PROCESSING');
    expect(a.order.usdtAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(a.order.usdtAddress).not.toBe(b.order.usdtAddress);
    expect(a.order.usdtReceived).toBe(0);
    expect(a.note).toMatch(/Send 100 USDT on BNB Smart Chain to receive 10,000 BB tokens/);

    // The address on the order is the one derived from its recorded index.
    const dep = await db.usdtDeposits.depositFor(a.order.orderId);
    expect(deriveDepositAddress(configuredAccountKey(), dep.derivationIndex)).toBe(a.order.usdtAddress);

    // The address on an order cannot be changed.
    await expect(pgQuery('UPDATE order_states SET usdt_pay_address = $2 WHERE order_id = $1',
      [a.order.orderId, `0x${'2'.repeat(40)}`])).rejects.toThrow();
  });

  it('refuses before writing anything when the deployment has no xpub', async () => {
    const who = await actor({});
    const saved = process.env.USDT_BEP20_XPUB;
    delete process.env.USDT_BEP20_XPUB;
    try {
      await expect(buy(who)).rejects.toMatchObject({ status: 503, code: 'USDT_DEPOSITS_UNAVAILABLE' });
    } finally { process.env.USDT_BEP20_XPUB = saved; }
    expect(await db.orders.countOpenDeposits(who.userId, { currency: 'USDT' })).toBe(0);
  });

  it('waits on a part payment, then credits once the rest arrives, exactly once', async () => {
    const who = await actor({});
    const { order } = await buy(who, 100);
    const before = await wallet(who.userId);

    await pay(order.usdtAddress, 60);
    expect(await creditIfCovered(order.orderId)).toMatchObject({ credited: false, reason: 'not_covered' });
    expect((await getOrderRecord(order.orderId)).status).toBe('PROCESSING');

    await pay(order.usdtAddress, 40);
    expect(await creditIfCovered(order.orderId)).toEqual({ credited: true });
    const done = await getOrderRecord(order.orderId);
    expect(done.status).toBe('COMPLETED');

    const after = await wallet(who.userId);
    const total = (w) => w.depositBalance + w.reserveBalance + w.promoBalance;
    // 10,000 tokens bought, plus whatever first-deposit bonus applies.
    expect(total(after) - total(before)).toBeGreaterThanOrEqual(10_000);

    // Again: nothing more.
    expect(await creditIfCovered(order.orderId)).toMatchObject({ credited: false });
    const again = await wallet(who.userId);
    expect(total(again)).toBe(total(after));

    // The movement balances: tokens out of supply, into the players' float.
    const { rows } = await pgQuery(
      `SELECT account, amount_paise::bigint AS a FROM treasury_entries WHERE movement_id = $1`,
      [`usdt_buy_${order.orderId}`]);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + Number(r.a), 0)).toBe(0);
    expect(Number(rows.find((r) => r.account === 'USER_FLOAT').a)).toBe(1_000_000);
  });

  it('records the same transfer once, however often it is seen', async () => {
    const who = await actor({});
    const { order } = await buy(who, 100);
    const txHash = hex64();
    expect((await pay(order.usdtAddress, 100, { txHash })).recorded).toBe(true);
    expect((await pay(order.usdtAddress, 100, { txHash })).recorded).toBe(false);
    expect((await db.usdtDeposits.depositFor(order.orderId)).receivedMicro).toBe(100_000_000);
  });

  it('ignores a transfer to an address that is not one of ours', async () => {
    expect((await pay(`0x${'3'.repeat(40)}`, 100)).recorded).toBe(false);
  });

  it('credits an overpaid buy for what was bought and flags the excess', async () => {
    const who = await actor({});
    const { order } = await buy(who, 100);
    await pay(order.usdtAddress, 150);
    expect(await creditIfCovered(order.orderId)).toEqual({ credited: true });
    const { rows } = await db.usdtDeposits.listDeposits({ filter: 'ATTENTION' });
    expect(rows.find((r) => r.orderId === order.orderId)?.attention).toBe('OVERPAID');
  });

  it('refuses mark-paid on a USDT buy: the chain is the proof', async () => {
    const who = await actor({});
    const { order } = await buy(who, 100);
    await expect(markOrderPaid(who.userId, order.orderId, hex64().slice(2)))
      .rejects.toMatchObject({ code: 'USDT_CONFIRMED_ON_CHAIN' });
  });

  it('expires an unpaid buy, and money that comes later is held for an admin, not credited', async () => {
    const who = await actor({});
    const { order } = await buy(who, 100);
    await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [order.orderId]);
    await expireOrders();
    const closed = await getOrderRecord(order.orderId);
    expect(['CANCELLED', 'EXPIRED']).toContain(closed.status);

    const r = await pay(order.usdtAddress, 100);
    expect(r).toMatchObject({ recorded: true });
    expect(r.orderState).not.toBe('PROCESSING');
    expect(await creditIfCovered(order.orderId)).toMatchObject({ credited: false });
    const { rows } = await db.usdtDeposits.listDeposits({ filter: 'ATTENTION' });
    expect(rows.find((x) => x.orderId === order.orderId)?.attention).toBe('LATE');
  });

  it('credits at expiry when the money arrived in time', async () => {
    const who = await actor({});
    const { order } = await buy(who, 100);
    await pay(order.usdtAddress, 100);
    await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [order.orderId]);
    await expireOrders();
    expect((await getOrderRecord(order.orderId)).status).toBe('COMPLETED');
  });

  it('the watcher reads the chain, records the transfer and credits the buy', async () => {
    const who = await actor({});
    const { order } = await buy(who, 100);
    const cursor = await db.usdtDeposits.readCursor();
    const block = (cursor?.nextBlock ?? 1_000_000) + 3;
    const head = block + 20;
    const txHash = hex64();
    const calls = [];
    vi.stubGlobal('fetch', async (_url, init) => {
      const { id, method, params } = JSON.parse(init.body);
      calls.push(method);
      let result;
      if (method === 'eth_blockNumber') result = `0x${head.toString(16)}`;
      else if (method === 'eth_getLogs') {
        const [{ fromBlock, toBlock, topics }] = params;
        const inRange = block >= Number(fromBlock) && block <= Number(toBlock);
        result = inRange && topics[2].includes(addressTopic(order.usdtAddress)) ? [{
          address: BSC_USDT_CONTRACT, topics: [TRANSFER_TOPIC, addressTopic(`0x${'1'.repeat(40)}`), addressTopic(order.usdtAddress)],
          data: `0x${(100n * RAW_PER_USDT).toString(16)}`, blockNumber: `0x${block.toString(16)}`,
          transactionHash: txHash, logIndex: '0x0', removed: false,
        }] : [];
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 });
    });
    if (!cursor) await db.usdtDeposits.advanceCursor({ nextBlock: block - 3, headBlock: head });

    const out = await watchUsdtDeposits();
    expect(calls[0]).toBe('eth_blockNumber');
    expect(out.recorded).toBeGreaterThanOrEqual(1);
    expect((await getOrderRecord(order.orderId)).status).toBe('COMPLETED');
    expect(raw(1)).toBe(RAW_PER_USDT);
  });

  describe('Admin › USDT Deposits', () => {
    const app = mountRouter(usdtDepositAdminRoutes, { prefix: '/api/admin' });

    /** A buy whose order has closed, with `usdt` arrived after it closed. */
    const latePaid = async (usdt = 100) => {
      const { order } = await buy(await actor({}), 100);
      await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [order.orderId]);
      await expireOrders();
      await pay(order.usdtAddress, usdt);
      return order;
    };

    it('is the canManageUsdtDeposits area and nothing weaker', async () => {
      const other = await actor({ isSubAdmin: true, permissions: { canManageUtr: true } });
      expect((await as(app, other).get('/api/admin/usdt-deposits')).status).toBe(403);
      const granted = await actor({ isSubAdmin: true, permissions: { canManageUsdtDeposits: true } });
      expect((await as(app, granted).get('/api/admin/usdt-deposits')).status).toBe(200);
    });

    it('lists what needs a person, with the watcher and totals, and refuses an unknown filter', async () => {
      const admin = await actor({ isAdmin: true });
      const late = await latePaid();
      const res = await as(app, admin).get('/api/admin/usdt-deposits?filter=ATTENTION&limit=200');
      expect(res.status).toBe(200);
      expect(res.body.filters).toEqual(['ALL', 'WAITING', 'ATTENTION', 'UNSWEPT']);
      expect(res.body.deposits.find((d) => d.orderId === late.orderId)).toMatchObject({ attention: 'LATE', usdtReceived: 100 });
      expect(res.body.watcher).toMatchObject({ configured: true });
      expect(typeof res.body.totals.usdtUnswept).toBe('number');
      const bad = await as(app, admin).get('/api/admin/usdt-deposits?filter=OPEN');
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('UNKNOWN_DEPOSIT_FILTER');
    });

    it('marks late money handled once, with a note, and never on an open order', async () => {
      const admin = await actor({ isAdmin: true });
      const late = await latePaid(50);
      const transfers = await as(app, admin).get(`/api/admin/usdt-deposits/${late.orderId}/transfers`);
      expect(transfers.body.transfers).toHaveLength(1);
      expect(transfers.body.transfers[0]).toMatchObject({ usdt: 50, handledAt: null });

      expect((await as(app, admin).post(`/api/admin/usdt-deposits/${late.orderId}/handled`).send({ note: ' ' })).status).toBe(400);
      const ok = await as(app, admin).post(`/api/admin/usdt-deposits/${late.orderId}/handled`).send({ note: 'Refunded to the sender' });
      expect(ok.body).toMatchObject({ success: true, marked: 1 });
      const again = await as(app, admin).post(`/api/admin/usdt-deposits/${late.orderId}/handled`).send({ note: 'Again' });
      expect(again.status).toBe(409);
      const list = await as(app, admin).get('/api/admin/usdt-deposits?filter=ATTENTION&limit=200');
      expect(list.body.deposits.find((d) => d.orderId === late.orderId)).toBeUndefined();

      const { order: open } = await buy(await actor({}), 100);
      await pay(open.usdtAddress, 10);
      expect((await as(app, admin).post(`/api/admin/usdt-deposits/${open.orderId}/handled`).send({ note: 'x' })).status).toBe(409);
    });

    it('offers an ended address with coins to the sweep, never an open one, and records each sweep once', async () => {
      const admin = await actor({ isAdmin: true });
      const { order: done } = await buy(await actor({}), 100);
      await pay(done.usdtAddress, 100);
      await creditIfCovered(done.orderId);
      const { order: open } = await buy(await actor({}), 100);
      await pay(open.usdtAddress, 40);

      const csv = await as(app, admin).get('/api/admin/usdt-deposits/sweep.csv');
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      const line = csv.text.split('\n').find((l) => l.includes(done.orderId));
      expect(line).toContain(done.usdtAddress);
      expect(line).toContain(String((await db.usdtDeposits.depositFor(done.orderId)).derivationIndex));
      expect(csv.text).not.toContain(open.orderId);

      expect((await as(app, admin).post(`/api/admin/usdt-deposits/${done.orderId}/sweep`).send({ txHash: '0x12' })).status).toBe(400);
      expect((await as(app, admin).post(`/api/admin/usdt-deposits/${open.orderId}/sweep`).send({ txHash: hex64() })).status).toBe(409);
      expect((await as(app, admin).post(`/api/admin/usdt-deposits/${done.orderId}/sweep`).send({ txHash: hex64() })).body.success).toBe(true);
      expect((await as(app, admin).post(`/api/admin/usdt-deposits/${done.orderId}/sweep`).send({ txHash: hex64() })).status).toBe(409);
      expect((await as(app, admin).get('/api/admin/usdt-deposits/sweep.csv')).text).not.toContain(done.orderId);
    });

    it('records the sweep tool results file line by line', async () => {
      const admin = await actor({ isAdmin: true });
      const a = await latePaid(100);
      const b = await latePaid(100);
      const res = await as(app, admin).post('/api/admin/usdt-deposits/sweeps').send({
        results: `orderId,txHash\n${a.orderId},${hex64()}\n${b.orderId},not-a-hash\n`,
      });
      expect(res.status).toBe(200);
      expect(res.body.recorded).toBe(1);
      expect(res.body.results.find((r) => r.orderId === b.orderId)).toMatchObject({ recorded: false });
      expect((await db.usdtDeposits.listDeposits({ filter: 'UNSWEPT', limit: 5000 })).rows.find((r) => r.orderId === a.orderId)).toBeUndefined();
      expect((await as(app, admin).post('/api/admin/usdt-deposits/sweeps').send({ results: '' })).status).toBe(400);
    });
  });
});
