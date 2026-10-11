// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sizes an INR order may be (Step 2d, owner 2026-10-02), on a real database.
 *
 * Seven fixed sizes (`denominations.js`): 500, 1,000, 5,000 and 10,000 tokens
 * on the cash rail, 50,000, 100,000 and 500,000 on UPI/bank. The admin chooses
 * which are on offer to buy (`SystemConfig.buyOrderSizes`) and which to sell
 * (`SystemConfig.sellOrderSizes`); an order is exactly one of its direction's
 * list, and the size decides the rail. One open INR buy at a
 * time. Every refusal names what the player CAN choose (§25) and writes
 * nothing: a refused sell locks no stake.
 *
 * The suite writes both size lists and `payoutFeePercent` and puts them back
 * (trap 10).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { countOpenDeposits, getOrderRecord } from '#db/repositories/orders.record.js';
import { cancelOrder } from '#db/repositories/orders.core.js';
import { updateUser } from '#db/repositories/users.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { PAYMENT_MODES } from '#db/repositories/orderRails.js';
import { createDepositOrder, createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import {
  CASH_SIZES, UPI_BANK_SIZES, ORDER_SIZES, railForSize, offeredSizes, offeredSizesFor,
} from '../../domains/merchant/denominations.js';
import { teamFixture } from '../teamFixture.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the sizes an order may be', () => {
  const teams = teamFixture();
  const orders = [];
  let prior;
  const ALL = { buyOrderSizes: [...ORDER_SIZES], sellOrderSizes: [...ORDER_SIZES] };
  const offer = (patch) => applySystemConfig(patch, { actor: 'order-sizes-suite' });

  const buy = async (userId, tokens) => {
    const { order } = await createDepositOrder(userId, tokens);
    orders.push(order.orderId);
    return order;
  };
  const sell = async (userId, tokens) => {
    const out = await createWithdrawalOrder(userId, tokens);
    orders.push(out.order.orderId);
    return out.order;
  };
  /** A player who can sell: bank details, and winnings. */
  const seller = async (winnings) => {
    const player = await actor({});
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(player.userId, winnings, 'order sizes suite seed', 'Test',
      `seed_${player.userId}`, `os_seed_${player.userId}`);
    return player;
  };

  beforeAll(async () => {
    await applySchema();
    // Nobody online, so nothing an admitted order could be held against.
    await teams.onlyOnline([]);
    // Every size on offer and no payout fee, set here rather than assumed
    // (§32 S19), and put back afterwards (trap 10).
    const cfg = await getSystemConfig();
    prior = {
      buyOrderSizes: cfg.buyOrderSizes, sellOrderSizes: cfg.sellOrderSizes, payoutFeePercent: cfg.payoutFeePercent,
    };
    await offer({ ...ALL, payoutFeePercent: 0 });
  }, 60_000);

  afterAll(async () => {
    await applySystemConfig(prior, { actor: 'order-sizes-suite' });
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await teams.cleanup();
    await closePg();
  });

  // ── The list ──────────────────────────────────────────────────────────────
  it('is seven sizes, four cash and three UPI/bank, and the size names the rail', () => {
    expect(CASH_SIZES).toEqual([500, 1_000, 5_000, 10_000]);
    expect(UPI_BANK_SIZES).toEqual([50_000, 100_000, 500_000]);
    expect(ORDER_SIZES).toEqual([...CASH_SIZES, ...UPI_BANK_SIZES]);
    for (const size of CASH_SIZES) expect(railForSize(size)).toBe('CASH');
    for (const size of UPI_BANK_SIZES) expect(railForSize(size)).toBe('UPI_BANK');
    for (const bad of [0, 499, 2_000, 20_000, 40_000, 1_000_000, '500x']) expect(railForSize(bad)).toBeNull();
  });

  // ── Buys ──────────────────────────────────────────────────────────────────
  it('admits a buy of every size on offer, on the rail its size names', async () => {
    for (const size of ORDER_SIZES) {
      const player = await actor({});
      const order = await buy(player.userId, size);
      const row = await getOrderRecord(order.orderId);
      expect(row.tokenAmount).toBe(size);
      expect(row.paymentMode).toBe(railForSize(size) === 'CASH' ? PAYMENT_MODES.CASH_ATM : PAYMENT_MODES.P2P_UPI);
      expect(row.status).toBe('PENDING_QUEUE');
    }
  });

  it('refuses a buy that is not a size, names the sizes, and writes nothing', async () => {
    // 20,000 was a legal UPI buy before 2d; 7,770 never was.
    for (const bad of [7_770, 20_000, 1_000_000]) {
      const player = await actor({});
      await expect(buy(player.userId, bad)).rejects.toMatchObject({ code: 'NOT_AN_ORDER_SIZE', status: 400 });
      await expect(buy(player.userId, bad)).rejects.toThrow(/is not an order size\. Choose one of 500, 1,000, 5,000, 10,000, 50,000, 1,00,000, 5,00,000 tokens/);
      expect(await countOpenDeposits(player.userId)).toBe(0);
    }
  });

  it('answers a missing amount with a 400 that names the sizes, never a 500', async () => {
    const player = await actor({});
    for (const bad of [undefined, null, NaN, 'abc', -500]) {
      await expect(buy(player.userId, bad)).rejects.toMatchObject({ code: 'AMOUNT_REQUIRED', status: 400 });
    }
    expect(await countOpenDeposits(player.userId)).toBe(0);
  });

  // ── Sells ─────────────────────────────────────────────────────────────────
  it('admits a sell of a size, as one order on its rail, locking exactly its stake', async () => {
    for (const [size, mode] of [[1_000, PAYMENT_MODES.CASH_ATM], [50_000, PAYMENT_MODES.P2P_UPI]]) {
      const player = await seller(size);
      const before = await getBalancesPaise(player.userId);
      const order = await sell(player.userId, size);
      const row = await getOrderRecord(order.orderId);
      expect(row.paymentMode).toBe(mode);
      expect(row.tokenAmount).toBe(size);
      expect(row.escrowLocked).toBe(true);
      const after = await getBalancesPaise(player.userId);
      expect(before.winningsBalance - after.winningsBalance).toBe(size * 100);
      expect(after.lockedBalance - before.lockedBalance).toBe(size * 100);
    }
  });

  it('refuses a sell that is not a size BEFORE any stake is locked', async () => {
    // 12,340 was a legal UPI sell before 2d, and 1,500 a refused cash one.
    // Neither is a size; nothing is split (owner 2026-10-02).
    const player = await seller(20_000);
    const before = await getBalancesPaise(player.userId);
    for (const bad of [1_500, 12_340, 15_000]) {
      await expect(sell(player.userId, bad)).rejects.toMatchObject({ code: 'NOT_AN_ORDER_SIZE', status: 400 });
    }
    expect(await getBalancesPaise(player.userId)).toEqual(before);
  });

  // ── The admin's offer ─────────────────────────────────────────────────────
  it('refuses a size the admin switched off, for buys and sells, and still admits the rest', async () => {
    await offer({ buyOrderSizes: [500, 5_000, 100_000], sellOrderSizes: [500, 5_000, 100_000] });
    try {
      expect(offeredSizes(await getSystemConfig(), 'DEPOSIT')).toEqual([500, 5_000, 100_000]);
      const buyer = await actor({});
      await expect(buy(buyer.userId, 1_000)).rejects.toThrow(/1,000 tokens is not on offer to buy right now\. Choose one of 500, 5,000, 1,00,000 tokens/);
      await expect(buy(buyer.userId, 50_000)).rejects.toMatchObject({ code: 'NOT_AN_ORDER_SIZE' });
      expect(await countOpenDeposits(buyer.userId)).toBe(0);

      const holder = await seller(10_000);
      const before = await getBalancesPaise(holder.userId);
      await expect(sell(holder.userId, 10_000)).rejects.toThrow(/not on offer to sell right now/);
      expect(await getBalancesPaise(holder.userId)).toEqual(before);

      // The opposite case (§37 step 6): a size still on offer goes through.
      expect((await buy(buyer.userId, 5_000)).tokenAmount).toBe(5_000);
      expect((await sell(holder.userId, 500)).tokenAmount).toBe(500);
    } finally {
      await offer(ALL);
    }
  });

  // ── Each direction has its own list (Phase A, owner) ─────────────────────
  it('admits a size on offer to buy but not to sell for a buy, and refuses it for a sell', async () => {
    await offer({ buyOrderSizes: [1_000, 50_000], sellOrderSizes: [500, 100_000] });
    try {
      const cfg = await getSystemConfig();
      expect(offeredSizes(cfg, 'DEPOSIT')).toEqual([1_000, 50_000]);
      expect(offeredSizes(cfg, 'WITHDRAWAL')).toEqual([500, 100_000]);
      expect(offeredSizesFor(cfg, 'CASH', 'DEPOSIT')).toEqual([1_000]);
      expect(offeredSizesFor(cfg, 'UPI_BANK', 'WITHDRAWAL')).toEqual([100_000]);

      // 1,000: buy yes, sell no.
      const buyer = await actor({});
      expect((await buy(buyer.userId, 1_000)).tokenAmount).toBe(1_000);
      const holder = await seller(2_000);
      const before = await getBalancesPaise(holder.userId);
      await expect(sell(holder.userId, 1_000)).rejects.toMatchObject({ code: 'NOT_AN_ORDER_SIZE', status: 400, sizes: [500, 100_000] });
      await expect(sell(holder.userId, 1_000)).rejects.toThrow(/1,000 tokens is not on offer to sell right now\. Choose one of 500, 1,00,000 tokens/);
      // A refused sell locks no stake.
      expect(await getBalancesPaise(holder.userId)).toEqual(before);
    } finally {
      await offer(ALL);
    }
  });

  it('admits a size on offer to sell but not to buy for a sell, and refuses it for a buy', async () => {
    await offer({ buyOrderSizes: [1_000, 50_000], sellOrderSizes: [500, 100_000] });
    try {
      // 500: sell yes, buy no.
      const holder = await seller(500);
      const before = await getBalancesPaise(holder.userId);
      const order = await sell(holder.userId, 500);
      expect(order.tokenAmount).toBe(500);
      expect(before.winningsBalance - (await getBalancesPaise(holder.userId)).winningsBalance).toBe(500 * 100);

      const buyer = await actor({});
      await expect(buy(buyer.userId, 500)).rejects.toMatchObject({ code: 'NOT_AN_ORDER_SIZE', status: 400, sizes: [1_000, 50_000] });
      await expect(buy(buyer.userId, 500)).rejects.toThrow(/500 tokens is not on offer to buy right now\. Choose one of 1,000, 50,000 tokens/);
      expect(await countOpenDeposits(buyer.userId)).toBe(0);
    } finally {
      await offer(ALL);
    }
  });

  it('refuses a direction that is neither buy nor sell rather than guessing a list', () => {
    expect(() => offeredSizes({}, 'BUY')).toThrow(TypeError);
    expect(() => offeredSizes({}, undefined)).toThrow(TypeError);
    // A row with no list at all is a fresh install: every size, both ways.
    expect(offeredSizes({}, 'DEPOSIT')).toEqual([...ORDER_SIZES]);
    expect(offeredSizes({}, 'WITHDRAWAL')).toEqual([...ORDER_SIZES]);
  });

  it('stores only sizes from the seven, at least one, once each, in the fixed order, per list', async () => {
    for (const field of ['buyOrderSizes', 'sellOrderSizes']) {
      const before = (await getSystemConfig())[field];
      await expect(applySystemConfig({ [field]: [500, 7_777] })).rejects.toThrow(/may only contain .*got 7777/);
      await expect(applySystemConfig({ [field]: [40_000] })).rejects.toThrow(/may only contain/);
      await expect(applySystemConfig({ [field]: [500, 500] })).rejects.toThrow(/lists a value twice/);
      await expect(applySystemConfig({ [field]: [] })).rejects.toThrow(/at least 1 value/);
      expect((await getSystemConfig())[field]).toEqual(before);

      await offer({ [field]: [500_000, 500, 10_000] });
      try {
        expect((await getSystemConfig())[field]).toEqual([500, 10_000, 500_000]);
      } finally {
        await offer(ALL);
      }
    }
    // The single list is gone: a patch naming it is refused, not ignored.
    await expect(applySystemConfig({ orderSizes: [500] })).rejects.toThrow(/undeclared setting 'orderSizes'/);
  });

  // ── One purchase at a time ───────────────────────────────────────────────
  it('refuses a second buy while one is in flight, across both INR rails', async () => {
    // Per CURRENCY, not per rail: a player holding a cash buy and a UPI buy at
    // once would occupy two members during a shortage.
    const player = await actor({});
    await buy(player.userId, 500);
    await expect(buy(player.userId, 1_000)).rejects.toMatchObject({ code: 'BUY_ALREADY_OPEN', status: 409 });
    await expect(buy(player.userId, 50_000)).rejects.toMatchObject({ code: 'BUY_ALREADY_OPEN' });
  });

  it('lets them buy again once the first is finished', async () => {
    const player = await actor({});
    const first = await buy(player.userId, 500);
    expect((await cancelOrder({ orderId: first.orderId, reason: 'finished for the test' })).ok).toBe(true);
    expect(await buy(player.userId, 500)).toBeTruthy();
  });
});
