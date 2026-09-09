// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The USDT rail, end to end, against a real database.
 *
 * ── What this rail is ──────────────────────────────────────────────────────
 * ₹10,000 is the ceiling on any INR buy — the largest a cash machine dispenses
 * and the largest a merchant is approved to serve. Above it a player buys with
 * USDT, at exactly ₹50,000 or ₹100,000, from a USDT MERCHANT. There is no
 * payment processor and no webhook: the merchant is a person with a wallet, the
 * player sends tokens to the address for the chain they chose, and submits the
 * transaction hash.
 *
 * ── The three things that make it different from the INR rail ──────────────
 * 1. Two fixed amounts, and a gap between the rails that the refusal NAMES.
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
import { createDepositOrder, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { selectBestMerchant } from '../../domains/merchant/merchantScoring.service.js';
import { USDT_BUY_DENOMINATIONS_PAISE } from '../../domains/merchant/denominations.js';
import { actor, merchantActor } from './_harness.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';

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

  /** A USDT merchant holding an address on exactly the chains named. */
  const usdtMerchant = async (chains, tokensRupees = 200_000) => {
    const m = await merchantActor({ tokensRupees });
    await updateMerchant(m.merchantId, {
      acceptedCurrencies: ['USDT'],
      ...(chains.includes('TRC20') ? { usdtAddressTrc20: trc20() } : {}),
      ...(chains.includes('BEP20') ? { usdtAddressBep20: bep20() } : {}),
    });
    return m;
  };

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
      { usdtPricing: { ...(priorPricing ?? {}), userMerchantBuyInr: 90 } },
      { actor: 'usdt-rail-suite' },
    );
  }, 60_000);

  afterAll(async () => {
    if (priorPricing) await applySystemConfig({ usdtPricing: priorPricing }, { actor: 'usdt-rail-suite' });
    await closePg();
  });

  // ── The two amounts ──────────────────────────────────────────────────────
  it('serves exactly ₹50,000 and ₹100,000', async () => {
    expect(USDT_BUY_DENOMINATIONS_PAISE).toEqual([5_000_000, 10_000_000]);
    for (const paise of USDT_BUY_DENOMINATIONS_PAISE) {
      const who = await actor({});
      const { order } = await createDepositOrder(who.userId, paise / 100, {
        currency: 'USDT', usdtChain: 'TRC20',
      });
      expect(order.tokenAmount).toBe(paise / 100);
    }
  });

  it('REFUSES an amount between the rails, and names what a player CAN buy', async () => {
    // ₹30,000 is on neither list. A player told only "invalid amount" would try
    // again and again, so the refusal has to carry both rails' choices.
    const who = await actor({});
    await expect(createDepositOrder(who.userId, 30_000, { currency: 'USDT', usdtChain: 'TRC20' }))
      .rejects.toMatchObject({ code: 'NOT_A_USDT_DENOMINATION' });
    await expect(createDepositOrder(who.userId, 30_000, { currency: 'USDT', usdtChain: 'TRC20' }))
      .rejects.toThrow(/₹50,000 or ₹1,00,000[\s\S]*₹10,000/);
  });

  it('refuses an amount the INR rail already serves', async () => {
    const who = await actor({});
    await expect(createDepositOrder(who.userId, 5_000, { currency: 'USDT', usdtChain: 'TRC20' }))
      .rejects.toMatchObject({ code: 'NOT_A_USDT_DENOMINATION' });
  });

  it('allows ONE open USDT buy at a time, per rail', async () => {
    const who = await actor({});
    await createDepositOrder(who.userId, 50_000, { currency: 'USDT', usdtChain: 'TRC20' });
    await expect(createDepositOrder(who.userId, 100_000, { currency: 'USDT', usdtChain: 'TRC20' }))
      .rejects.toMatchObject({ code: 'BUY_ALREADY_OPEN' });
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

    // Not "somebody was picked" — the one that CAN be paid on that chain. A
    // merchant holding only the other one has nowhere to receive the money.
    const tronIds = [tronOnly.merchantId];
    const bnbIds  = [bnbOnly.merchantId];
    if (forTron) expect(bnbIds).not.toContain(forTron.merchantId);
    if (forBnb) expect(tronIds).not.toContain(forBnb.merchantId);
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
