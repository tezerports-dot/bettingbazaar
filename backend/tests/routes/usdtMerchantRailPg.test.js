// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The USDT rail, end to end, against a real database.
 *
 * ── What this rail is ──────────────────────────────────────────────────────
 * A USDT buy is denominated in what the player RECEIVES — 50,000, 100,000 or
 * 500,000 PLATFORM TOKENS — and served by a USDT MERCHANT. What the player
 * SENDS is derived from the admin's rate at creation: at 100 tokens per USDT
 * those three sizes cost 500, 1,000 and 5,000 USDT. There is no payment
 * processor and no webhook: the merchant is a person with a wallet, the player
 * sends tokens to the address for the chain they chose, and submits the
 * transaction hash.
 *
 * ── The three things that make it different from the INR rail ──────────────
 * 1. Three fixed sizes in TOKENS, priced from a rate that is FROZEN on the row
 *    the moment the order is created.
 * 2. A chain. USDT sent to a Tron address from a BEP-20 wallet is gone, so the
 *    player picks the network they hold funds on and is shown only the address
 *    that can receive them. A merchant without one on that chain is not a
 *    candidate at all.
 * 3. The reference is a transaction hash, not a bank UTR — and it is claimed in
 *    the same registry, so one payment cannot be presented twice.
 *
 * Driven through the real service against a real database, because that last
 * one is a money guard and mocking it would prove only that a mock refuses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { db } from '#db';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { createDepositOrder, markOrderPaid, tryAssignMerchant } from '../../domains/payment/paymentProcessing.service.js';
import { selectBestMerchant } from '../../domains/merchant/merchantScoring.service.js';
import { USDT_BUY_DENOMINATIONS_PAISE } from '../../domains/merchant/denominations.js';
import { actor, merchantActor, mountRouter, as } from './_harness.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { tokensPerUsdt } from '../../domains/configuration/tokenRates.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the USDT merchant rail', () => {
  let seq = 0;
  let priorPricing = null;
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

  /**
   * A USDT merchant holding an address on exactly the chains named, and
   * ACTUALLY ASSIGNABLE.
   *
   * `is_online` defaults to FALSE, and `assignmentCandidates` requires it. A
   * first draft of this helper left it alone, so every merchant it made was
   * invisible to the query — and the routing assertions below, written as
   * `if (forTron) expect(...)`, skipped their bodies and passed while
   * measuring nothing. That is trap 11's shape in a fixture: a check that
   * cannot fail reads exactly like one that holds.
   */
  const usdtMerchant = async (chains, tokensRupees = 200_000) => {
    const m = await merchantActor({ tokensRupees });
    await updateMerchant(m.merchantId, {
      acceptedCurrencies: ['USDT'],
      isOnline: true,
      ...(chains.includes('TRC20') ? { usdtAddressTrc20: trc20() } : {}),
      ...(chains.includes('BEP20') ? { usdtAddressBep20: bep20() } : {}),
    });
    online.push(m.merchantId);
    return m;
  };

  /** Every merchant this suite has put online, taken back off at the end. */
  const online = [];

  const usdtOrder = async ({ owner, chain = 'TRC20', tokens = 50_000, state = 'PENDING_QUEUE', merchantId = null }) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: owner.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens,
      state, currency: 'USDT', usdtChain: chain,
      ...(merchantId ? { merchantId } : {}),
    });
    return orderId;
  };

  beforeAll(async () => {
    await applySchema();
    // The USDT price is shared config and never reset between suites, so the
    // value found here is put back at the end.
    priorPricing = (await getSystemConfig())?.usdtPricing ?? null;
    await applySystemConfig(
      // 100 tokens per USDT — the rate the owner's example uses, so the
      // expected figures below read as the specification does.
      { usdtPricing: { ...(priorPricing ?? {}), userMerchantBuyInr: 100 } },
      { actor: 'usdt-rail-suite' },
    );
  }, 60_000);

  afterAll(async () => {
    if (priorPricing) await applySystemConfig({ usdtPricing: priorPricing }, { actor: 'usdt-rail-suite' });
    // Taken back offline. This database is shared and never reset, so a
    // merchant left online here is a merchant every later suite's assignment
    // query can pick — including suites that count candidates.
    for (const merchantId of online) {
      await updateMerchant(merchantId, { isOnline: false }).catch(() => {});
    }
    await closePg();
  });

  // ── The three sizes, in TOKENS ───────────────────────────────────────────
  it('serves exactly 50,000, 100,000 and 500,000 tokens', async () => {
    expect(USDT_BUY_DENOMINATIONS_PAISE).toEqual([5_000_000, 10_000_000, 50_000_000]);
    for (const paise of USDT_BUY_DENOMINATIONS_PAISE) {
      const who = await actor({});
      const { order } = await createDepositOrder(who.userId, paise / 100, {
        currency: 'USDT', usdtChain: 'TRC20',
      });
      expect(order.tokenAmount).toBe(paise / 100);
    }
  });

  it('quotes the USDT to send from the admin’s rate, at CREATION', async () => {
    // The denomination is what the player RECEIVES; the USDT is what they SEND.
    // At 100 tokens per USDT: 50,000 → 500, 100,000 → 1,000, 500,000 → 5,000.
    for (const [tokens, usdt] of [[50_000, 500], [100_000, 1_000], [500_000, 5_000]]) {
      const who = await actor({});
      const { order, note } = await createDepositOrder(who.userId, tokens, {
        currency: 'USDT', usdtChain: 'TRC20',
      });
      // `fiatAmount` is what the player sends, in the ORDER's currency.
      expect(order.fiatAmount).toBe(usdt);
      expect(order.rateUsed).toBe(100);
      // And the sentence names USDT, not rupees — "you will pay ₹500" to
      // somebody about to transfer 500 USDT names the wrong thing entirely.
      expect(note).toMatch(new RegExp(`send ${usdt.toLocaleString('en-IN')} USDT`));
      expect(note).not.toMatch(/₹/);
    }
  });

  it('REFUSES a size it does not serve, and names the sizes in TOKENS', async () => {
    const who = await actor({});
    await expect(createDepositOrder(who.userId, 30_000, { currency: 'USDT', usdtChain: 'TRC20' }))
      .rejects.toMatchObject({ code: 'NOT_A_USDT_DENOMINATION' });
    await expect(createDepositOrder(who.userId, 30_000, { currency: 'USDT', usdtChain: 'TRC20' }))
      .rejects.toThrow(/50,000, 1,00,000, 5,00,000 tokens/);
  });

  it('does NOT re-price a purchase already quoted', async () => {
    // The rate is admin-editable and assignment happens minutes later. It used
    // to read the rate again and overwrite `rateUsed`, so an admin edit in
    // between silently re-priced a purchase the player had already agreed to.
    const who = await actor({});
    const { order } = await createDepositOrder(who.userId, 50_000, {
      currency: 'USDT', usdtChain: 'TRC20',
    });
    expect(order.fiatAmount).toBe(500);

    // The admin doubles the rate. The order in flight must not move.
    await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 200 } }, { actor: 'usdt-rail-suite' });
    try {
      // The row refuses a re-quote outright, whatever any caller intends.
      await expect(db.orders.setOrderFields(order.orderId, { rateUsed: 200 }))
        .rejects.toThrow(/cannot be re-priced/);
      const row = await getOrderRecord(order.orderId);
      expect(row.rateUsed).toBe(100);
      expect(row.fiatAmount).toBe(500);
    } finally {
      await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 100 } }, { actor: 'usdt-rail-suite' });
    }
  });

  it('assigns at the price the ORDER holds, not the price live at assignment', async () => {
    // The re-pricing window, through the path that used to open it. Creation
    // and assignment are minutes apart, and assignment used to read the rate
    // again — so an admin edit in between re-priced a purchase the player had
    // already agreed to, without either of them being told.
    const who = await actor({});
    const m = await usdtMerchant(['TRC20']);
    // Built queued and already quoted, because creation assigns synchronously
    // when a merchant is free — and this is about the OTHER path, the retry
    // loop that picks a queued order up minutes later.
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: 50_000, fiatAmountRupees: 500,
      state: 'PENDING_QUEUE', currency: 'USDT', usdtChain: 'TRC20',
      // Named explicitly: the USDT rail is not the cash rail, and a leftover
      // CASH_ATM policy from another suite would send this order down the
      // link-claiming path instead of the scorer (this database is shared).
      paymentMode: 'P2P_UPI',
      rateUsed: 100,
    });

    await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 200 } }, { actor: 'usdt-rail-suite' });
    try {
      // Assignment must SUCCEED — re-reading the rate would collide with the
      // row's own freeze and leave the order queued, which is the same defect
      // wearing a quieter costume: nobody is re-priced, and nobody is served.
      expect(await tryAssignMerchant(await getOrderRecord(orderId), m)).toBe(true);

      const row = await getOrderRecord(orderId);
      expect(row.rateUsed).toBe(100);
      expect(row.fiatAmount).toBe(500);
    } finally {
      await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 100 } }, { actor: 'usdt-rail-suite' });
    }
  });

  it('REFUSES to create a purchase it cannot price', async () => {
    // 0 is the schema default and 0 is not a rate: dividing by it gives
    // Infinity USDT, and substituting 1 would sell 50,000 tokens for 50,000
    // USDT. A caller that cannot price a purchase must refuse it by name.
    await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 0 } }, { actor: 'usdt-rail-suite' });
    try {
      const who = await actor({});
      await expect(createDepositOrder(who.userId, 50_000, { currency: 'USDT', usdtChain: 'TRC20' }))
        .rejects.toMatchObject({ code: 'USDT_RATE_UNSET' });
      expect(await db.orders.countOpenDeposits(who.userId, { currency: 'USDT' })).toBe(0);
    } finally {
      await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 100 } }, { actor: 'usdt-rail-suite' });
    }
  });

  it('allows ONE open USDT buy at a time, per rail', async () => {
    const who = await actor({});
    await createDepositOrder(who.userId, 50_000, { currency: 'USDT', usdtChain: 'TRC20' });
    await expect(createDepositOrder(who.userId, 100_000, { currency: 'USDT', usdtChain: 'TRC20' }))
      .rejects.toMatchObject({ code: 'BUY_ALREADY_OPEN' });
  });

  // ── The rate an admin types ──────────────────────────────────────────────
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

  // ── The chain ────────────────────────────────────────────────────────────
  it('refuses a USDT buy that names no chain', async () => {
    // A USDT order with no chain matches no merchant, so it would sit in the
    // queue until it expired while the screen said "waiting for a merchant".
    const who = await actor({});
    await expect(createDepositOrder(who.userId, 50_000, { currency: 'USDT' }))
      .rejects.toMatchObject({ code: 'USDT_CHAIN_REQUIRED' });
    await expect(createDepositOrder(who.userId, 50_000, { currency: 'USDT', usdtChain: 'SOLANA' }))
      .rejects.toMatchObject({ code: 'USDT_CHAIN_REQUIRED' });
  });

  it('records the chain on the order, and refuses to move it afterwards', async () => {
    const who = await actor({});
    const orderId = await usdtOrder({ owner: who, chain: 'BEP20' });
    expect((await getOrderRecord(orderId)).usdtChain).toBe('BEP20');

    // The snapshot carries the address for THIS chain alone, so repointing the
    // order would hand a player an address on a network they did not choose.
    await expect(db.orders.setOrderFields(orderId, { usdtChain: 'TRC20' }))
      .rejects.toThrow(/unknown field|usdtChain/i);
  });

  it('routes a buy only to a merchant holding an address ON THAT CHAIN', async () => {
    const tronOnly = await usdtMerchant(['TRC20']);
    const bnbOnly  = await usdtMerchant(['BEP20']);

    const forTron = await selectBestMerchant('DEPOSIT', 50_000, 'USDT', { usdtChain: 'TRC20' });
    const forBnb  = await selectBestMerchant('DEPOSIT', 50_000, 'USDT', { usdtChain: 'BEP20' });

    // SOMEBODY must be picked. An earlier draft wrote these as
    // `if (forTron) expect(...)`, and every merchant it created was offline —
    // so both were null, both bodies were skipped, and the test passed without
    // executing a single assertion.
    expect(forTron, 'a Tron order must reach a merchant').toBeTruthy();
    expect(forBnb, 'a BEP-20 order must reach a merchant').toBeTruthy();

    // And not just anybody — one that CAN be paid on that chain. A merchant
    // holding only the other address has nowhere to receive the money.
    expect(forTron.merchantId).not.toBe(bnbOnly.merchantId);
    expect(forBnb.merchantId).not.toBe(tronOnly.merchantId);
    expect(forTron.usdtAddressTrc20).toBeTruthy();
    expect(forBnb.usdtAddressBep20).toBeTruthy();
  });

  it('offers a USDT order to NOBODY when no merchant holds that chain', async () => {
    // Every USDT merchant in this database is set up by this suite, so the
    // assertion is about the QUERY: asked for a chain nothing is stored under,
    // it returns nobody rather than falling back to a merchant who cannot be
    // paid. `usdt_address_*` is only ever written by these tests.
    const candidates = await db.merchants.assignmentCandidates({
      currency: 'USDT', direction: 'DEPOSIT', usdtChain: 'BEP20',
    });
    for (const c of candidates) expect(c.usdtAddressBep20).toBeTruthy();
  });

  it('refuses an unknown chain LOUDLY rather than matching nobody', async () => {
    // Silently returning an empty list would read as "no merchant is available"
    // on a screen, which is a different fact and one a player waits through.
    await expect(db.merchants.assignmentCandidates({
      currency: 'USDT', direction: 'DEPOSIT', usdtChain: 'SOLANA',
    })).rejects.toThrow(/unknown usdtChain/);
  });

  // ── The transaction hash ─────────────────────────────────────────────────
  it('takes the chain’s own hash shape, and refuses the other chain’s', async () => {
    const who = await actor({});
    const m = await usdtMerchant(['TRC20']);
    const orderId = await usdtOrder({ owner: who, chain: 'TRC20', state: 'ASSIGNED', merchantId: m.merchantId });

    // A BEP-20 hash on a Tron order is proof of a payment on a network the
    // merchant is not watching.
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
    // vocabulary — "this UTR was already used" shown to somebody holding a Tron
    // hash reads as another system's error and they submit it again.
    const hash = hex64();
    const first = await actor({});
    const m1 = await usdtMerchant(['TRC20']);
    const firstOrder = await usdtOrder({ owner: first, chain: 'TRC20', state: 'ASSIGNED', merchantId: m1.merchantId });
    await markOrderPaid(first.userId, firstOrder, hash);

    const second = await actor({});
    const m2 = await usdtMerchant(['TRC20']);
    const secondOrder = await usdtOrder({ owner: second, chain: 'TRC20', state: 'ASSIGNED', merchantId: m2.merchantId });

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
    expect((await getOrderRecord(secondOrder)).state).toBe('ASSIGNED');
  });

  it('lets the SAME order resubmit its own hash', async () => {
    // A retried submission is not a duplicate. Without this a player whose
    // request timed out after the claim landed can never finish their order.
    const who = await actor({});
    const m = await usdtMerchant(['TRC20']);
    const orderId = await usdtOrder({ owner: who, chain: 'TRC20', state: 'ASSIGNED', merchantId: m.merchantId });
    const hash = hex64();

    await markOrderPaid(who.userId, orderId, hash);
    // The order is PAID now, so the state machine refuses — but on the STATE,
    // never on the reference being taken by somebody else.
    await expect(markOrderPaid(who.userId, orderId, hash))
      .rejects.not.toMatchObject({ code: 'DUPLICATE_UTR' });
  });

  it('is one registry: a hash cannot be spent on a bank reference too', async () => {
    // The registry is shared across rails deliberately. Two registries would
    // let one string be claimed once on each.
    const shared = hex64();
    const who = await actor({});
    const m = await usdtMerchant(['BEP20']);
    const usdtId = await usdtOrder({ owner: who, chain: 'BEP20', state: 'ASSIGNED', merchantId: m.merchantId });
    await markOrderPaid(who.userId, usdtId, `0x${shared}`);

    const entry = await db.utr.getUtr(`0X${shared.toUpperCase()}`);
    expect(entry?.orderId).toBe(usdtId);
  });
});
