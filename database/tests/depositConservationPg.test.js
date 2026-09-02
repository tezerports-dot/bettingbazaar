// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * A confirmed deposit MOVES tokens. It never creates them.
 *
 * The merchant parts with exactly what the player receives, whatever the
 * deposit/reserve policy splits it into. The unit suite asserts that pairing by
 * observing the amounts each writer is ASKED for; this one runs the real
 * writers against a real database and checks the money afterwards.
 *
 * Both exist deliberately. A stub makes the amounts visible; only the real
 * writers prove they move. A suite that mocked the settlement writer once
 * reported settlement working while the real function threw on every call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { creditDeposit, creditReserve, getBalances } from '../repositories/wallets.js';
import {
  debitMerchantTokens, creditMerchantTokens, getMerchantTokenBalance,
} from '../repositories/merchantWallets.js';
import { createMerchantWithWallet } from '../repositories/merchants.js';

const describePg = pgConfigured() ? describe : describe.skip;

// Globally-unique ledger keys, so a fixed id would collide across runs.
const RUN = Math.random().toString(36).slice(2, 8);
let n = 0;
const next = () => (n += 1);

/** A merchant funded with tokens to dispense. */
async function fundedMerchant(tokens) {
  const id = `dc-m-${RUN}-${next()}`;
  await createMerchantWithWallet({
    merchantId: id, name: `M${id}`, username: id,
    mobile: `7${String(Date.now()).slice(-6)}${String(next()).padStart(3, '0')}`,
    bankUpiId: `${id}@test`,
  });
  await creditMerchantTokens({
    merchantId: id, amount: tokens, reason: 'test float',
    refModel: 'Test', refId: id, txId: `float_${id}`,
  });
  return id;
}

describePg('a confirmed deposit conserves tokens', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  /**
   * The move a deposit confirm makes, with the real writers, in the order the
   * route makes it: the merchant's side first — because refusing there is the
   * ordinary case and must refuse before anything else moves — then the
   * player's two pockets.
   */
  async function confirmDeposit({ merchantId, userId, orderId, depositCredit, reserveCredit }) {
    const total = depositCredit + reserveCredit;
    const { merchant } = await debitMerchantTokens({
      merchantId, amount: total,
      reason: `Deposit ${orderId} confirmed`,
      refModel: 'PaymentOrder', refId: orderId,
      txId: `mw_dep_deduct_${orderId}`,
    });
    if (!merchant) return { ok: false };
    if (depositCredit > 0) await creditDeposit(userId, depositCredit, orderId);
    if (reserveCredit > 0) await creditReserve(userId, reserveCredit, orderId);
    return { ok: true };
  }

  for (const [label, depositCredit, reserveCredit] of [
    ['a 90/10 policy', 900, 100],
    ['a 50/50 policy', 500, 500],
    ['the whole deposit to reserve', 0, 1000],
    ['no reserve share at all', 1000, 0],
    ['an awkward split', 931, 69],
  ]) {
    it(`moves exactly what it takes, under ${label}`, async () => {
      const total = depositCredit + reserveCredit;
      const merchantId = await fundedMerchant(5000);
      const userId = `dc-u-${RUN}-${next()}`;
      const orderId = `DC_${RUN}_${next()}`;

      const merchantBefore = await getMerchantTokenBalance(merchantId);
      expect(await confirmDeposit({ merchantId, userId, orderId, depositCredit, reserveCredit }))
        .toMatchObject({ ok: true });

      const merchantAfter = await getMerchantTokenBalance(merchantId);
      const player = await getBalances(userId);

      // The merchant parted with the total…
      expect(merchantBefore - merchantAfter).toBe(total);
      // …the player received it, across whichever pockets the policy chose…
      expect(player.depositBalance).toBe(depositCredit);
      expect(player.reserveBalance).toBe(reserveCredit);
      // …and the two figures are the same number. This is the invariant the
      // platform's closing check depends on: one route once debited
      // `depositAllocation` and credited `depositAllocation + reserveAllocation`,
      // so every deposit with a reserve share created tokens out of nothing.
      expect(player.depositBalance + player.reserveBalance).toBe(merchantBefore - merchantAfter);
    });
  }

  it('refuses before anything moves when the merchant is short', async () => {
    const merchantId = await fundedMerchant(100);
    const userId = `dc-u-${RUN}-${next()}`;
    const orderId = `DC_${RUN}_${next()}`;

    expect(await confirmDeposit({ merchantId, userId, orderId, depositCredit: 900, reserveCredit: 100 }))
      .toMatchObject({ ok: false });

    // The merchant's side is checked FIRST for exactly this reason: a refusal
    // must leave the player uncredited, not credited from a merchant who could
    // not fund it.
    expect(await getMerchantTokenBalance(merchantId)).toBe(100);
    const player = await getBalances(userId);
    expect(player.depositBalance).toBe(0);
    expect(player.reserveBalance).toBe(0);
  });

  it('moves once when the same confirm is delivered twice', async () => {
    const merchantId = await fundedMerchant(5000);
    const userId = `dc-u-${RUN}-${next()}`;
    const orderId = `DC_${RUN}_${next()}`;

    await confirmDeposit({ merchantId, userId, orderId, depositCredit: 900, reserveCredit: 100 });
    // A merchant clicking while an admin force-approves is the real case. Every
    // movement is keyed on the order, so the second delivery is a no-op rather
    // than a second dispensation.
    await confirmDeposit({ merchantId, userId, orderId, depositCredit: 900, reserveCredit: 100 });

    expect(await getMerchantTokenBalance(merchantId)).toBe(4000);
    const player = await getBalances(userId);
    expect(player.depositBalance).toBe(900);
    expect(player.reserveBalance).toBe(100);
  });

  it('conserves across concurrent deposits from one merchant', async () => {
    const merchantId = await fundedMerchant(5000);
    const users = Array.from({ length: 8 }, () => `dc-u-${RUN}-${next()}`);

    await Promise.all(users.map((userId) => confirmDeposit({
      merchantId, userId, orderId: `DC_${RUN}_${next()}`,
      depositCredit: 450, reserveCredit: 50,
    })));

    const merchantAfter = await getMerchantTokenBalance(merchantId);
    const credited = (await Promise.all(users.map((u) => getBalances(u))))
      .reduce((sum, b) => sum + b.depositBalance + b.reserveBalance, 0);

    // Eight × 500 against a 5,000 float: all eight fit. What is asserted is
    // that the merchant's loss equals the players' gain to the paisa, whatever
    // order the eight interleaved in.
    expect(5000 - merchantAfter).toBe(credited);
    expect(credited).toBe(4000);
  });
});
