// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The USDT rail, end to end, against a real database.
 *
 * ── What this rail is ──────────────────────────────────────────────────────
 * (Step 2d: a USDT buy is now chosen in whole steps of 100 USDT, and the
 * tokens follow from the rate.) It was denominated in what the player RECEIVES — 50,000, 100,000 or
 * 500,000 PLATFORM TOKENS — and served by a member of a USDT TEAM (a team
 * whose supervisor is approved for the USDT rail, PROJECT_STATUS §3.10 2c).
 * What the player SENDS is derived from the admin's rate at creation: at 100
 * tokens per USDT those three sizes cost 500, 1,000 and 5,000 USDT. There is
 * no payment processor and no webhook: the member is a person with a wallet,
 * the player sends to the address for the chain they chose, and submits the
 * transaction hash. The tokens the player receives come from the team's pool,
 * held at assignment like every other buy.
 *
 * ── The three things that make it different from the INR rails ─────────────
 * 1. Three fixed sizes in TOKENS, priced from a rate that is FROZEN on the row
 *    the moment the order is created.
 * 2. A chain. USDT sent to a Tron address from a BEP-20 wallet is gone, so the
 *    player picks the network they hold funds on and is shown only the address
 *    that can receive them. A member without one on that chain is not a
 *    candidate at all.
 * 3. The reference is a transaction hash, not a bank UTR — and it is claimed in
 *    the same registry, so one payment cannot be presented twice.
 *
 * Driven through the real service and router against a real database, because
 * the last two are money guards and mocking them would prove only that a mock
 * refuses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { db } from '#db';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { getPool } from '#db/repositories/teamPools.js';
import { routingCandidates } from '#db/repositories/teamRouting.js';
import { PAYMENT_MODES, railOf } from '#db/repositories/orderRails.js';
import { createDepositOrder, markOrderPaid, tryAssignMerchant } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { actor, merchantActor, mountRouter, as } from './_harness.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { tokensPerUsdt } from '../../domains/configuration/tokenRates.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the USDT merchant rail', () => {
  let seq = 0;
  let priorPricing = null;
  const teams = teamFixture();
  const orders = [];
  const oid = () => `usdt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  // Distinct every time. A wallet address is UNIQUE across merchants and a
  // transaction hash is claimed FOREVER, so a constant collides with the row
  // the previous RUN left behind — this database is never reset (trap 10).
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const trc20 = () => `T${Array.from({ length: 33 },
    () => BASE58[Math.floor(Math.random() * BASE58.length)]).join('')}`;
  const bep20 = () => `0x${Array.from({ length: 40 },
    () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}`;
  const hex64 = () => Array.from({ length: 64 },
    () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

  const setRate = (tokensPerOneUsdt) => applySystemConfig(
    { usdtPricing: { userMerchantBuyInr: tokensPerOneUsdt } }, { actor: 'usdt-rail-suite' },
  );

  /** A USDT member holding an address on exactly the chains named. */
  const usdtMember = async (chains) => {
    const m = await merchantActor();
    await updateMerchant(m.merchantId, {
      acceptedCurrencies: ['USDT'],
      ...(chains.includes('TRC20') ? { usdtAddressTrc20: trc20() } : {}),
      ...(chains.includes('BEP20') ? { usdtAddressBep20: bep20() } : {}),
    });
    return m;
  };

  /**
   * A working USDT team whose members are the ones named, online and nobody
   * else — so the router's choice is between exactly these.
   */
  const usdtTeam = async (members, poolTokens = 500_000) => teams.workingTeam({
    rail: 'USDT', poolTokens, include: members.map((m) => m.merchantId),
  });

  /** A queued USDT buy, quoted at creation as `createDepositOrder` quotes it. */
  const queuedUsdtBuy = async ({ owner, chain = 'TRC20', tokens = 50_000, usdt = 500 }) => {
    const orderId = oid();
    orders.push(orderId);
    return createOrderRecord({
      orderId, userId: owner.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: usdt,
      currency: 'USDT', usdtChain: chain, rateUsed: tokens / usdt,
    });
  };

  beforeAll(async () => {
    await applySchema();
    // The USDT price is shared config and never reset between suites, so the
    // value found here is put back at the end.
    priorPricing = (await getSystemConfig())?.usdtPricing ?? null;
    // 100 tokens per USDT — the rate the owner's example uses, so the
    // expected figures below read as the specification does.
    await setRate(100);
  }, 60_000);

  afterAll(async () => {
    if (priorPricing) await applySystemConfig({ usdtPricing: priorPricing }, { actor: 'usdt-rail-suite' });
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await teams.cleanup();
    await closePg();
  });

  // ══ Pricing and admission — nobody is online, so every buy waits queued ══
  describe('what a player may buy, and at what price', () => {
    /** A USDT buy of `usdt` whole USDT, as the route makes it (Step 2d). */
    const buyUsdt = async (who, usdt, chain = 'TRC20') => {
      const out = await createDepositOrder(who.userId, null, { currency: 'USDT', usdtChain: chain, usdtAmount: usdt });
      orders.push(out.order.orderId);
      return out;
    };

    beforeAll(async () => { await teams.onlyOnline([]); });

    // ── Whole steps of USDT, between the admin's bounds (Step 2d) ─────────
    it('serves any whole step of 100 USDT inside the bounds, on the USDT rail whatever the size', async () => {
      for (const usdt of [100, 300, 10_000]) {
        const who = await actor({});
        const { order } = await buyUsdt(who, usdt);
        // At 100 tokens per USDT.
        expect(order.tokenAmount).toBe(usdt * 100);
        // The size never moves a USDT order onto an INR rail.
        const row = await getOrderRecord(order.orderId);
        expect(row.paymentMode).toBe(PAYMENT_MODES.P2P_UPI);
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
        expect(note).toMatch(new RegExp(`send ${usdt.toLocaleString('en-IN')} USDT to receive ${tokens.toLocaleString('en-IN')} BB tokens`));
        expect(note).not.toMatch(/₹/);
      }
    });

    it('takes the token count from the rate, never from the client', async () => {
      // A hand-made request naming its own token count is ignored on this rail.
      const who = await actor({});
      const { order } = await createDepositOrder(who.userId, 999_999,
        { currency: 'USDT', usdtChain: 'TRC20', usdtAmount: 200 });
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
      await applySystemConfig({ usdtBuy: { minUsdt: 500, maxUsdt: 1_000 } }, { actor: 'usdt-rail-suite' });
      try {
        const who = await actor({});
        await expect(buyUsdt(who, 400)).rejects.toThrow(/500 to 1,000 USDT, in steps of 100/);
        await expect(buyUsdt(who, 1_100)).rejects.toMatchObject({ code: 'NOT_A_USDT_AMOUNT' });
        expect((await buyUsdt(who, 500)).order.tokenAmount).toBe(50_000);
      } finally {
        await applySystemConfig({ usdtBuy: prior }, { actor: 'usdt-rail-suite' });
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
    it('refuses a USDT buy that names no chain', async () => {
      // A USDT order with no chain matches no member, so it would sit in the
      // queue until it expired while the screen said "waiting for a merchant".
      const who = await actor({});
      await expect(createDepositOrder(who.userId, 50_000, { currency: 'USDT' }))
        .rejects.toMatchObject({ code: 'USDT_CHAIN_REQUIRED' });
      await expect(createDepositOrder(who.userId, 50_000, { currency: 'USDT', usdtChain: 'SOLANA' }))
        .rejects.toMatchObject({ code: 'USDT_CHAIN_REQUIRED' });
    });

    it('records the chain on the order, and refuses to move it afterwards', async () => {
      const who = await actor({});
      const order = await queuedUsdtBuy({ owner: who, chain: 'BEP20' });
      expect((await getOrderRecord(order.orderId)).usdtChain).toBe('BEP20');

      // The snapshot carries the address for THIS chain alone, so repointing the
      // order would hand a player an address on a network they did not choose.
      await expect(db.orders.setOrderFields(order.orderId, { usdtChain: 'TRC20' }))
        .rejects.toThrow(/unknown field|usdtChain/i);
    });
  });

  // ══ Who serves it ════════════════════════════════════════════════════════
  describe('who serves a USDT buy', () => {
    it('assigns at the price the ORDER holds, not the price live at assignment', async () => {
      // The re-pricing window, through the path that used to open it. Creation
      // and assignment are minutes apart, and assignment used to read the rate
      // again — so an admin edit in between re-priced a purchase the player had
      // already agreed to, without either of them being told.
      const member = await usdtMember(['TRC20']);
      const team = await usdtTeam([member]);
      const who = await actor({});
      // Built queued and already quoted: this is about the OTHER path, the
      // assignment sweep picking a queued order up minutes later.
      const order = await queuedUsdtBuy({ owner: who, chain: 'TRC20' });

      await setRate(200);
      try {
        // Assignment must SUCCEED — re-reading the rate would collide with the
        // row's own freeze and leave the order queued, which is the same defect
        // wearing a quieter costume: nobody is re-priced, and nobody is served.
        expect(await tryAssignMerchant(await getOrderRecord(order.orderId))).toBe(true);

        const row = await getOrderRecord(order.orderId);
        expect(row).toMatchObject({ status: 'ASSIGNED', merchantId: member.merchantId, rateUsed: 100, fiatAmount: 500 });
        // The tokens the player will receive are held in the team's pool.
        expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 450_000_00, heldPaise: 50_000_00 });
      } finally {
        await setRate(100);
      }
    });

    /**
     * Two members, one per chain, and a second order on `chain` arriving when
     * the member who CAN be paid on it is the busier of the two. Without the
     * chain filter the router's own ordering (fewest open orders) would hand it
     * to the other member — so landing on the right one proves the filter, not
     * a coincidence of ranking.
     */
    const provesChainFilter = async (chain) => {
      const other = chain === 'TRC20' ? 'BEP20' : 'TRC20';
      const right = await usdtMember([chain]);
      const wrong = await usdtMember([other]);
      await usdtTeam([right, wrong]);

      const first = await queuedUsdtBuy({ owner: await actor({}), chain });
      expect(await tryAssignMerchant(first), `a ${chain} order must reach a member`).toBe(true);
      expect((await getOrderRecord(first.orderId)).merchantId).toBe(right.merchantId);

      // `right` now has one open order and `wrong` none.
      const second = await queuedUsdtBuy({ owner: await actor({}), chain });
      expect(await tryAssignMerchant(second)).toBe(true);
      const row = await getOrderRecord(second.orderId);
      expect(row.merchantId, `a ${chain} order went to a member with no ${chain} address`).toBe(right.merchantId);

      // And the player is shown THAT chain's address, with its network — never
      // the member's other one, which this member does not even hold.
      expect(row.merchantSnapshot.usdtChain).toBe(chain);
      expect(row.merchantSnapshot.usdtPayTo).toBeTruthy();
    };

    it('routes a Tron buy only to a member holding a Tron address', async () => {
      await provesChainFilter('TRC20');
    });

    it('routes a BEP-20 buy only to a member holding a BEP-20 address', async () => {
      await provesChainFilter('BEP20');
    });

    it('offers a USDT buy to NOBODY when no member online holds that chain — and holds nothing', async () => {
      // Asked for a chain no available member can receive on, the router
      // returns nobody rather than falling back to a member who cannot be paid.
      const tronOnly = await usdtMember(['TRC20']);
      const team = await usdtTeam([tronOnly]);
      const before = await getPool(team.teamId);

      const order = await queuedUsdtBuy({ owner: await actor({}), chain: 'BEP20' });
      expect(await tryAssignMerchant(order)).toBe(false);
      const row = await getOrderRecord(order.orderId);
      expect(row.status).toBe('PENDING_QUEUE');
      expect(row.poolHeldPaise).toBe(0);
      expect(await getPool(team.teamId)).toEqual(before);
    });

    it('refuses an unknown chain LOUDLY rather than matching nobody', async () => {
      // Silently returning an empty list would read as "no merchant is
      // available" on a screen, which is a different fact and one a player
      // waits through.
      await expect(routingCandidates({
        orderId: 'usdt-unknown-chain', type: 'DEPOSIT', currency: 'USDT',
        usdtChain: 'SOLANA', tokenAmountPaise: 5_000_000,
      }, { cap: 3 })).rejects.toThrow(/unknown usdtChain/);
    });
  });

  // ══ The transaction hash ═════════════════════════════════════════════════
  describe('the transaction hash', () => {
    let hashTeam = null;

    /**
     * An ASSIGNED USDT buy, as the router assigns it, to one of three members
     * holding both chains. The team is built once and put back online on every
     * call, because a team built by another test takes this one offline.
     */
    /** A USDT buy its member has accepted: from then on the player is given the address. */
    const assignedUsdtBuy = async (owner, chain = 'TRC20') => {
      if (!hashTeam) {
        const members = [];
        for (let i = 0; i < 3; i += 1) members.push(await usdtMember(['TRC20', 'BEP20']));
        hashTeam = { team: await usdtTeam(members, 1_000_000), members };
      }
      await teams.onlyOnline(hashTeam.members.map((m) => m.merchantId));
      const order = await queuedUsdtBuy({ owner, chain });
      expect(await tryAssignMerchant(order)).toBe(true);
      expect((await getOrderRecord(order.orderId)).status).toBe('ASSIGNED');
      await readyToPay(order.orderId);
      return order.orderId;
    };

    it('takes the chain’s own hash shape, and refuses the other chain’s', async () => {
      const who = await actor({});
      const orderId = await assignedUsdtBuy(who, 'TRC20');

      // A BEP-20 hash on a Tron order is proof of a payment on a network the
      // member is not watching.
      await expect(markOrderPaid(who.userId, orderId, `0x${hex64()}`))
        .rejects.toMatchObject({ code: 'INVALID_PAYMENT_REFERENCE' });
      // And a bank UTR is not a transaction hash at all.
      await expect(markOrderPaid(who.userId, orderId, 'HDFCN12345678'))
        .rejects.toMatchObject({ code: 'INVALID_PAYMENT_REFERENCE' });

      const paid = await markOrderPaid(who.userId, orderId, hex64());
      expect(paid.status).toBe('PAID');
    });

    it('REFUSES a transaction id already used on another order, and says so', async () => {
      // The rule the whole registry exists for, on this rail: one payment cannot
      // be presented twice. The refusal is phrased in the submitter's own
      // vocabulary — "this UTR was already used" shown to somebody holding a
      // Tron hash reads as another system's error and they submit it again.
      const hash = hex64();
      const first = await actor({});
      const firstOrder = await assignedUsdtBuy(first, 'TRC20');
      await markOrderPaid(first.userId, firstOrder, hash);

      const second = await actor({});
      const secondOrder = await assignedUsdtBuy(second, 'TRC20');

      await expect(markOrderPaid(second.userId, secondOrder, hash)).rejects.toMatchObject({
        status: 409,
        code: 'DUPLICATE_UTR',
        // WHICH order holds it — support answering "it says already used" needs
        // this without a second lookup.
        originalOrderId: firstOrder,
      });
      await expect(markOrderPaid(second.userId, secondOrder, hash))
        .rejects.toThrow(/transaction ID has already been used/i);

      // And the second order did NOT move: a refused claim leaves nothing behind.
      expect((await getOrderRecord(secondOrder)).state).toBe('PROCESSING');
    });

    it('lets the SAME order resubmit its own hash', async () => {
      // A retried submission is not a duplicate. Without this a player whose
      // request timed out after the claim landed can never finish their order.
      const who = await actor({});
      const orderId = await assignedUsdtBuy(who, 'TRC20');
      const hash = hex64();

      await markOrderPaid(who.userId, orderId, hash);
      // The order is PAID now, so the state machine refuses — but on the STATE,
      // never on the reference being taken by somebody else.
      await expect(markOrderPaid(who.userId, orderId, hash))
        .rejects.not.toMatchObject({ code: 'DUPLICATE_UTR' });
    });

    it('is claimed in the one registry bank UTRs use, case-folded', async () => {
      // The registry is shared across rails deliberately: two registries would
      // let one string be claimed once on each. What this asserts is that a
      // chain hash lands THERE, under the upper-cased key that makes `0xab…`
      // and `0xAB…` one transaction (§27) — not a cross-rail collision, which
      // no pair of valid formats can produce.
      const shared = hex64();
      const who = await actor({});
      const usdtId = await assignedUsdtBuy(who, 'BEP20');
      await markOrderPaid(who.userId, usdtId, `0x${shared}`);

      const entry = await db.utr.getUtr(`0X${shared.toUpperCase()}`);
      expect(entry?.orderId).toBe(usdtId);
    });
  });
});
