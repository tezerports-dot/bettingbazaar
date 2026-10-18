// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * What a player may buy with USDT, and at what price, against a real database.
 *
 * A USDT buy is paid to an address the platform derives for that order on BNB
 * Smart Chain (owner, 2026-10-18; the payment itself is
 * `usdtPlatformDepositPg.test.js`). What is pinned here is the quote: whole
 * steps of 100 USDT between the admin's bounds, the tokens from the admin's
 * rate FROZEN on the row at creation, one open USDT buy at a time, and a rate
 * that cannot be a price refused at the door.
 *
 * Driven through the real service and router, because these are money guards
 * and mocking them would prove only that a mock refuses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { db } from '#db';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { railOf } from '#db/repositories/orderRails.js';
import { createDepositOrder } from '../../domains/payment/paymentProcessing.service.js';
import { actor, mountRouter, as } from './_harness.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { tokensPerUsdt } from '../../domains/configuration/tokenRates.js';

const describePg = pgConfigured() ? describe : describe.skip;

// The account xpub of BIP-39 test vector "abandon … about" at m/44'/60'/0'.
const TEST_XPUB = 'xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt';

describePg('USDT buys: what a player may buy, and at what price', () => {
  let priorPricing = null;
  const priorEnv = {};
  const orders = [];

  const setRate = (tokensPerOneUsdt) => applySystemConfig(
    { usdtPricing: { userMerchantBuyInr: tokensPerOneUsdt } }, { actor: 'usdt-pricing-suite' },
  );

  beforeAll(async () => {
    await applySchema();
    for (const [k, v] of [['USDT_BEP20_XPUB', TEST_XPUB], ['BSC_RPC_URL', 'http://bsc.test/rpc']]) {
      priorEnv[k] = process.env[k]; process.env[k] = v;
    }
    // The USDT price is shared config and never reset between suites, so the
    // value found here is put back at the end.
    priorPricing = (await getSystemConfig())?.usdtPricing ?? null;
    // 100 tokens per USDT — the rate the owner's example uses, so the
    // expected figures below read as the specification does.
    await setRate(100);
  }, 60_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (priorPricing) await applySystemConfig({ usdtPricing: priorPricing }, { actor: 'usdt-pricing-suite' });
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM usdt_deposit_addresses WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await closePg();
  });

  describe('the quote', () => {
    /** A USDT buy of `usdt` whole USDT, as the route makes it (Step 2d). */
    const buyUsdt = async (who, usdt, chain = 'BEP20') => {
      const out = await createDepositOrder(who.userId, null, { currency: 'USDT', usdtChain: chain, usdtAmount: usdt });
      orders.push(out.order.orderId);
      return out;
    };

    // ── Whole steps of USDT, between the admin's bounds (Step 2d) ─────────
    it('serves any whole step of 100 USDT inside the bounds, on the USDT rail whatever the size', async () => {
      for (const usdt of [100, 300, 10_000]) {
        const who = await actor({});
        const { order } = await buyUsdt(who, usdt);
        // At 100 tokens per USDT.
        expect(order.tokenAmount).toBe(usdt * 100);
        // The size never moves a USDT order onto an INR rail.
        const row = await getOrderRecord(order.orderId);
        expect(railOf(row)).toBe('USDT');
      }
    });

    it('prices the TOKENS from the admin’s rate, at CREATION', async () => {
      // The USDT is what the player SENDS; the tokens are what they receive.
      for (const [usdt, tokens] of [[100, 10_000], [1_000, 100_000]]) {
        const who = await actor({});
        const { order, note } = await buyUsdt(who, usdt);
        // `fiatAmount` is what the player sends, in the ORDER's currency.
        expect(order.fiatAmount).toBe(usdt);
        expect(order.tokenAmount).toBe(tokens);
        expect(order.rateUsed).toBe(100);
        // And the sentence names USDT, not rupees.
        expect(note).toMatch(new RegExp(`Send ${usdt.toLocaleString('en-IN')} USDT on BNB Smart Chain to receive ${tokens.toLocaleString('en-IN')} BB tokens`));
        expect(note).not.toMatch(/₹/);
      }
    });

    it('takes the token count from the rate, never from the client', async () => {
      // A hand-made request naming its own token count is ignored on this rail.
      const who = await actor({});
      const { order } = await createDepositOrder(who.userId, 999_999,
        { currency: 'USDT', usdtAmount: 200 });
      orders.push(order.orderId);
      expect(order.tokenAmount).toBe(20_000);
    });

    it('REFUSES an amount off the step or outside the bounds, names them, and writes nothing', async () => {
      const who = await actor({});
      for (const bad of [150, 50, 0, 10_100, null, 'abc']) {
        await expect(buyUsdt(who, bad)).rejects.toMatchObject({ code: 'NOT_A_USDT_AMOUNT', status: 400 });
      }
      await expect(buyUsdt(who, 150)).rejects.toThrow(/100 to 10,000 USDT, in steps of 100/);
      expect(await db.orders.countOpenDeposits(who.userId, { currency: 'USDT' })).toBe(0);
    });

    it('follows the bounds the admin sets', async () => {
      const prior = (await getSystemConfig()).usdtBuy;
      await applySystemConfig({ usdtBuy: { minUsdt: 500, maxUsdt: 1_000 } }, { actor: 'usdt-pricing-suite' });
      try {
        const who = await actor({});
        await expect(buyUsdt(who, 400)).rejects.toThrow(/500 to 1,000 USDT, in steps of 100/);
        await expect(buyUsdt(who, 1_100)).rejects.toMatchObject({ code: 'NOT_A_USDT_AMOUNT' });
        expect((await buyUsdt(who, 500)).order.tokenAmount).toBe(50_000);
      } finally {
        await applySystemConfig({ usdtBuy: prior }, { actor: 'usdt-pricing-suite' });
      }
    });

    it('does NOT re-price a purchase already quoted', async () => {
      // The rate is admin-editable and assignment happens minutes later. It used
      // to read the rate again and overwrite `rateUsed`, so an admin edit in
      // between silently re-priced a purchase the player had already agreed to.
      const who = await actor({});
      const { order } = await buyUsdt(who, 500);
      expect(order.fiatAmount).toBe(500);

      // The admin doubles the rate. The order in flight must not move.
      await setRate(200);
      try {
        // The row refuses a re-quote outright, whatever any caller intends.
        await expect(db.orders.setOrderFields(order.orderId, { rateUsed: 200 }))
          .rejects.toThrow(/cannot be re-priced/);
        const row = await getOrderRecord(order.orderId);
        expect(row.rateUsed).toBe(100);
        expect(row.fiatAmount).toBe(500);
      } finally {
        await setRate(100);
      }
    });

    it('REFUSES to create a purchase it cannot price', async () => {
      // 0 is the schema default and 0 is not a rate: dividing by it gives
      // Infinity USDT, and substituting 1 would sell 50,000 tokens for 50,000
      // USDT. A caller that cannot price a purchase must refuse it by name.
      await setRate(0);
      try {
        const who = await actor({});
        await expect(buyUsdt(who, 500))
          .rejects.toMatchObject({ code: 'USDT_RATE_UNSET' });
        expect(await db.orders.countOpenDeposits(who.userId, { currency: 'USDT' })).toBe(0);
      } finally {
        await setRate(100);
      }
    });

    it('allows ONE open USDT buy at a time, per rail', async () => {
      const who = await actor({});
      await buyUsdt(who, 500);
      await expect(buyUsdt(who, 1_000))
        .rejects.toMatchObject({ code: 'BUY_ALREADY_OPEN' });
    });

    // ── The rate an admin types ────────────────────────────────────────────
    it('REFUSES to store a rate that cannot be a price', async () => {
      // One number prices the whole rail, and the sizes are large. 10,000 typed
      // for 100 sells 500,000 tokens for 50 USDT, and the first player to notice
      // does not stop at one order. Refused at the door, in a message that names
      // what to look for.
      const adminApp = mountRouter((await import('../../routes/admin/system.admin.routes.js')).default);
      const admin = await actor({ isAdmin: true });

      for (const bad of [10_000, 1, 0.5]) {
        const res = await as(adminApp, admin).put('/system/config').send({ usdtPricing: { userMerchantBuyInr: bad } });
        expect(res.status, `₹${bad}/USDT must be refused`).toBe(400);
        expect(res.body.message).toMatch(/misplaced decimal/i);
      }

      // 0 is still accepted — it is the schema default and the way to say "not
      // set", which the rail then refuses outright rather than guessing at.
      const unset = await as(adminApp, admin).put('/system/config').send({ usdtPricing: { userMerchantBuyInr: 0 } });
      expect(unset.status).toBe(200);

      // And a real rate goes through, which is what stops this being a bound
      // nobody can satisfy.
      const ok = await as(adminApp, admin).put('/system/config').send({ usdtPricing: { userMerchantBuyInr: 100 } });
      expect(ok.status).toBe(200);
      expect(tokensPerUsdt(await getSystemConfig())).toBe(100);
    });

    it('holds the TEAM POOL rate to the same band at the door (2c+)', async () => {
      // It values every USDT payment for pool tokens and had no band at all:
      // only "greater than zero". Same owner, same bound, same message.
      const adminApp = mountRouter((await import('../../routes/admin/system.admin.routes.js')).default);
      const admin = await actor({ isAdmin: true });
      const restore = (await getSystemConfig())?.usdtPricing?.merchantAdminBuyInr ?? 0; // schema default: 0
      try {
        for (const bad of [10_000, 1, 0.5]) {
          const res = await as(adminApp, admin).put('/system/config').send({ usdtPricing: { merchantAdminBuyInr: bad } });
          expect(res.status, `₹${bad}/USDT must be refused`).toBe(400);
          expect(res.body.message).toMatch(/team pool USDT rate/i);
          expect(res.body.message).toMatch(/misplaced decimal/i);
        }
        // 0 means unset and is accepted; a real rate goes through and is read.
        expect((await as(adminApp, admin).put('/system/config').send({ usdtPricing: { merchantAdminBuyInr: 0 } })).status).toBe(200);
        const ok = await as(adminApp, admin).put('/system/config').send({ usdtPricing: { merchantAdminBuyInr: 92 } });
        expect(ok.status).toBe(200);
        expect((await getSystemConfig()).usdtPricing.merchantAdminBuyInr).toBe(92);
      } finally {
        await db.config.applyConfig({
          scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: restore } },
        }).catch(() => {});
      }
    });

    it('refuses a rate with a third decimal, on both legs (Step 2d)', async () => {
      // A buy's tokens are its USDT times the rate, in paise: a third decimal
      // would price a purchase in fractions of a paisa.
      const adminApp = mountRouter((await import('../../routes/admin/system.admin.routes.js')).default);
      const admin = await actor({ isAdmin: true });
      for (const leg of ['userMerchantBuyInr', 'merchantAdminBuyInr']) {
        const res = await as(adminApp, admin).put('/system/config').send({ usdtPricing: { [leg]: 88.555 } });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/at most 2 decimals/);
      }
      expect(tokensPerUsdt(await getSystemConfig())).toBe(100);
    });

    // ── The chain, at the door ─────────────────────────────────────────────
    it('is paid on BNB Smart Chain, and refuses any other chain by name', async () => {
      const who = await actor({});
      const { order } = await buyUsdt(who, 100, undefined);
      expect((await getOrderRecord(order.orderId)).usdtChain).toBe('BEP20');
      for (const chain of ['TRC20', 'SOLANA']) {
        await expect(createDepositOrder((await actor({})).userId, null, { currency: 'USDT', usdtChain: chain, usdtAmount: 100 }))
          .rejects.toMatchObject({ code: 'USDT_CHAIN_UNSUPPORTED', status: 400 });
      }
    });

    it('records the chain on the order, and refuses to move it afterwards', async () => {
      const who = await actor({});
      const { order } = await buyUsdt(who, 100);
      // The address was derived for this chain; repointing the order would
      // hand a player an address on a network they cannot reach.
      await expect(db.orders.setOrderFields(order.orderId, { usdtChain: 'TRC20' }))
        .rejects.toThrow(/unknown field|usdtChain/i);
    });
  });
});
