// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A cash withdrawal too large for one denomination, and the money it locks.
 *
 * ── The shape, and why it is this shape ────────────────────────────────────
 * An ATM dispenses denominations, not amounts, so ₹100,000 is four merchants at
 * four machines. Those are FOUR ORDINARY WITHDRAWALS — not a parent holding
 * legs. Each has its own escrow lock, its own assignment, its own cancel, its
 * own dispute and its own release, and nothing downstream branches on whether
 * it came from a split.
 *
 * The first version built a container. It worked, and it was the wrong shape:
 * every query in the system then had to decide whether it counted containers or
 * the work inside them — six of them did, one was a money guard — and a crash
 * partway through creation left a container holding an escrow with only some of
 * its legs written.
 *
 * ── What these assertions are actually protecting ──────────────────────────
 * Every failure here is a MONEY failure and none of them looks like an error:
 *
 *   • parts that do not add up to what the player asked for — short-paid,
 *     successfully, with every row looking healthy;
 *   • the escrow taken more or less than once in total;
 *   • a fee that lands on the cash side, making a part an amount no machine
 *     dispenses;
 *   • a cancelled part that refunds nothing.
 *
 * So the assertions are about the WALLET and the row set, not about responses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import {
  getOrderRecord, withdrawalBatch, stalledWithdrawals, pendingWithdrawalTotal,
} from '#db/repositories/orders.record.js';
import { getBalances } from '#db/repositories/wallets.js';
import { updateUser } from '#db/repositories/users.js';
import {
  PAYMENT_MODES, getActivePolicy, publishPolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { createWithdrawalOrder, cancelOrder } from '../../domains/payment/paymentProcessing.service.js';
import { shareFeeAcrossParts } from '../../domains/merchant/denominations.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a cash withdrawal that becomes several withdrawals', () => {
  let restore = null;
  let restoreMaxWithdrawal = null;

  /**
   * A player who can actually withdraw: KYC approved, bank details on file, and
   * winnings to draw on. The withdrawal path checks all three before it reaches
   * anything this suite is about.
   */
  const withdrawer = async (winningsRupees) => {
    const player = await actor({});
    // Through the repository, not raw SQL — `check:db-boundary` refuses SQL
    // outside `database/`, and a fixture written in hand-rolled SQL keeps
    // passing after the column it names is renamed.
    await updateUser(player.userId, {
      kycStatus: 'APPROVED',
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(
      player.userId, winningsRupees, 'split withdrawal suite seed', 'Test',
      `seed_${player.userId}`, `sw_seed_${player.userId}`,
    );
    return player;
  };

  beforeAll(async () => {
    await applySchema();
    restore = await getActivePolicy();
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      justification: 'Split withdrawal suite.', changedByName: 'test setup',
    });

    // ── The cap and the ladder have to agree ─────────────────────────────
    // `maxWithdrawal` defaults to ₹50,000 and the largest cash denomination is
    // ₹40,000, so on the default configuration the only split that exists is
    // two parts — and ₹100,000 is refused before it reaches the splitter, by a
    // limit that has nothing to do with denominations. A real operator
    // constraint, not a test inconvenience: a platform running the cash rail
    // raises this cap or the split is decoration.
    const cfg = await getSystemConfig({ fresh: true });
    restoreMaxWithdrawal = cfg?.maxWithdrawal ?? null;
    await applySystemConfig({ maxWithdrawal: 200_000 });
  }, 60_000);

  afterAll(async () => {
    if (restore) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        justification: 'Restoring the rail this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    if (restoreMaxWithdrawal !== null) {
      await applySystemConfig({ maxWithdrawal: restoreMaxWithdrawal });
    }
    await closePg();
  });

  it('creates one withdrawal per denomination, adding up to the payout', async () => {
    const player = await withdrawer(200_000);
    const result = await createWithdrawalOrder(player.userId, 100_000);

    expect(result.orders.map((o) => o.amount)).toEqual([40_000, 40_000, 10_000, 10_000]);
    // A split that loses paise pays the player LESS than they asked for,
    // successfully, and nothing about the rows looks wrong.
    expect(result.orders.reduce((sum, o) => sum + o.amount, 0)).toBe(100_000);

    // Each is a real, independent withdrawal — not a leg of anything.
    for (const part of result.orders) {
      const row = await getOrderRecord(part.orderId);
      expect(row.type).toBe('WITHDRAWAL');
      expect(row.escrowLocked).toBe(true);
      expect(row.withdrawalBatchRef).toBe(result.order.withdrawalBatchRef);
    }
  });

  it('locks exactly the withdrawal once in total, spread across the parts', async () => {
    const player = await withdrawer(200_000);
    const before = await getBalances(player.userId);
    await createWithdrawalOrder(player.userId, 100_000);
    const after = await getBalances(player.userId);

    // Four locks that sum to one withdrawal. Not four withdrawals' worth, which
    // is what a per-part debit of the whole amount would have produced, and not
    // one part's worth, which is what a single debit for the first would.
    expect(Number(before.winningsBalance) - Number(after.winningsBalance)).toBe(100_000);
    expect(Number(after.lockedBalance) - Number(before.lockedBalance)).toBe(100_000);
  });

  it('counts the withdrawal once — there is nothing to double-count', async () => {
    const player = await withdrawer(200_000);
    await createWithdrawalOrder(player.userId, 100_000);
    // Four rows, four amounts, one total. The container version had a parent
    // AND its legs in flight simultaneously, so this read ₹200,000 until every
    // list learned to filter.
    expect(await pendingWithdrawalTotal(player.userId)).toBe(100_000);
  });

  it('refuses an amount no set of denominations can make, before taking any money', async () => {
    const player = await withdrawer(200_000);
    const before = await getBalances(player.userId);

    await expect(createWithdrawalOrder(player.userId, 7_700)).rejects.toMatchObject({
      code: 'NOT_A_CASH_AMOUNT',
    });

    // Nothing moved. Discovering this after a debit means unwinding a lock that
    // has already committed.
    const after = await getBalances(player.userId);
    expect(Number(after.winningsBalance)).toBe(Number(before.winningsBalance));
    expect(Number(after.lockedBalance)).toBe(Number(before.lockedBalance));
  });

  it('creates a single ordinary withdrawal for one denomination, with no batch label', async () => {
    const player = await withdrawer(200_000);
    const result = await createWithdrawalOrder(player.userId, 10_000);
    expect(result.orders).toHaveLength(1);
    // No label: there are no siblings to group, so a screen must not offer an
    // expander promising some.
    expect(result.order.withdrawalBatchRef).toBeNull();
    expect(await withdrawalBatch(null)).toEqual([]);
  });

  it('gives the money back when a waiting part is cancelled, and leaves the others alone', async () => {
    const player = await withdrawer(200_000);
    const result = await createWithdrawalOrder(player.userId, 100_000);

    const rows = await withdrawalBatch(result.order.withdrawalBatchRef);
    const waiting = rows.find((o) => o.status === 'PENDING_QUEUE');
    expect(waiting).toBeTruthy();

    const before = await getBalances(player.userId);
    await cancelOrder(player.userId, false, waiting.orderId);
    const after = await getBalances(player.userId);

    // The ORDINARY refund path — the part carries its own escrow, so nothing
    // about this is special-cased. The container version needed a second refund
    // branch because a leg was forbidden from holding escrow at all.
    expect(Number(after.lockedBalance)).toBe(Number(before.lockedBalance) - waiting.tokenAmount);
    expect(Number(after.winningsBalance)).toBe(Number(before.winningsBalance) + waiting.tokenAmount);

    // And only that one moved.
    const stillThere = await withdrawalBatch(result.order.withdrawalBatchRef);
    expect(stillThere.filter((o) => o.status === 'CANCELLED')).toHaveLength(1);
  });

  it('groups the siblings under one label, and nothing else', async () => {
    const player = await withdrawer(200_000);
    const result = await createWithdrawalOrder(player.userId, 100_000);
    const rows = await withdrawalBatch(result.order.withdrawalBatchRef);

    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((o) => o.userId))).toEqual(new Set([String(player.userId)]));
    // The label groups; it does not decide. Every row is a full withdrawal in
    // its own right, which is exactly what makes it safe to be a label.
    for (const row of rows) expect(row.escrowLocked).toBe(true);
  });

  it('lists a withdrawal nobody has taken, so somebody is accountable for the lock', async () => {
    const player = await withdrawer(200_000);
    const result = await createWithdrawalOrder(player.userId, 100_000);
    const rows = await withdrawalBatch(result.order.withdrawalBatchRef);
    const waiting = rows.filter((o) => o.status === 'PENDING_QUEUE').map((o) => o.orderId);

    // Zero minutes — "everything waiting right now", the question an incident
    // asks and the one a falsy default silently answers differently.
    const stalled = await stalledWithdrawals({ olderThanMinutes: 0, limit: 1000 });
    const ids = stalled.map((o) => o.orderId);
    for (const id of waiting) expect(ids).toContain(id);
  });

  describe('the payout fee rides on the token side', () => {
    // The container version REFUSED to split at all while a payout fee was set,
    // because one pooled lock had no leg to account for the fee. Flat siblings
    // do not have that problem, so the refusal is gone — and this is the
    // arithmetic that replaced it.
    const parts = [4_000_000, 4_000_000, 1_000_000, 1_000_000]; // ₹100,000

    it('leaves every part a denomination, whatever the fee', () => {
      for (const fee of [0, 1, 100, 12_345, 999_999]) {
        const shared = shareFeeAcrossParts(parts, fee);
        // The CASH is untouched — a part whose fiat is not a denomination is a
        // part no cash machine can pay.
        expect(shared.map((p) => p.fiatPaise)).toEqual(parts);
      }
    });

    it('charges the fee exactly once across the parts, to the paise', () => {
      for (const fee of [0, 1, 100, 12_345, 999_999]) {
        const shared = shareFeeAcrossParts(parts, fee);
        const tokens = shared.reduce((sum, p) => sum + p.tokenPaise, 0);
        const cash   = shared.reduce((sum, p) => sum + p.fiatPaise, 0);
        // Money is integer paise. A share that floors and drops the remainder
        // charges the player an amount no row adds up to.
        expect(tokens - cash).toBe(fee);
      }
    });

    it('puts the indivisible remainder on the largest part, not nowhere', () => {
      // 7 paise across four parts does not divide. It has to land somewhere,
      // and "somewhere" being a rounding accident is how paise vanish.
      const shared = shareFeeAcrossParts(parts, 7);
      expect(shared.reduce((sum, p) => sum + p.tokenPaise, 0) - 10_000_000).toBe(7);
      expect(shared[0].tokenPaise).toBeGreaterThan(shared[0].fiatPaise);
    });
  });
});
