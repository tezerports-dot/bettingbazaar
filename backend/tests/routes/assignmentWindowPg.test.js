// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An order nobody ever took, and the money it was holding.
 *
 * ── The defect this covers ─────────────────────────────────────────────────
 * `expires_at` is set at ASSIGNMENT, not at creation. So an order no merchant
 * ever took had no deadline at all — and `findExpiredOrders` opened with
 * `expires_at IS NOT NULL`, which skipped it forever.
 *
 * `expireOrders` states in its own comment that PENDING_QUEUE was added to its
 * state list precisely so an unassigned WITHDRAWAL releases its escrow rather
 * than locking a player's money with nothing scheduled to free it. That fix was
 * made in one clause and cancelled by another in the same query: the state list
 * admitted the order, the deadline test threw it back out. Every check in this
 * repository was green.
 *
 * So the assertion that matters is not "the order was cancelled" — it is that
 * the player's TOKENS CAME BACK. An order tidied away while the escrow stays
 * locked is the same defect wearing a cancelled status.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import {
  createOrderRecord, getOrderRecord, findExpiredOrders, setOrderFields,
} from '#db/repositories/orders.record.js';
import { getBalances } from '#db/repositories/wallets.js';
import { getActivePolicy, publishPolicyVersion } from '#db/repositories/paymentModePolicy.js';
import { expireOrders } from '../../domains/payment/paymentProcessing.service.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the assignment window', () => {
  let seq = 0;
  let window = 1500;
  let restore = null;
  const oid = () => `aw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    restore = await getActivePolicy();

    // ── A one-second window, published as a real policy version ───────────
    // The window is read from the ORDER's own policy version, not from the
    // caller's fallback — that fallback exists only for rows written before
    // versions did. So testing the clause means creating orders under a policy
    // whose window is short, which is also the path production takes.
    await publishPolicyVersion({
      activeMode: restore.activeMode,
      timers: { assignmentWaitSeconds: 1 },
      justification: 'Assignment window suite — a one-second wait.',
      changedByName: 'test setup',
    });
    window = (await getActivePolicy()).assignmentWaitSeconds;
    expect(window).toBe(1);
  }, 60_000);

  afterAll(async () => {
    if (restore) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        timers: { assignmentWaitSeconds: restore.assignmentWaitSeconds },
        justification: 'Restoring the window this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    await closePg();
  });

  /**
   * An order that has been waiting longer than the window, with NO deadline —
   * which is the state creation actually leaves behind.
   *
   * The age is written through `setOrderFields`, so the fixture goes through the
   * same allowlist every other writer does rather than hand-rolled SQL.
   */
  const staleUnassigned = async (player, { type = 'DEPOSIT', escrow = false } = {}) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type,
      tokenAmountRupees: 1000, fiatAmountRupees: 1000,
      state: 'PENDING_QUEUE',
      ...(escrow ? { escrowLocked: true, escrowStatus: 'LOCKED', escrowAmount: 1000 } : {}),
    });
    return orderId;
  };

  it('leaves an order alone while it is still inside the window', async () => {
    const player = await actor({});
    const orderId = await staleUnassigned(player);

    // Fresh, and with no deadline of its own — the state that used to be
    // permanent. It must NOT be swept yet: expiring an order a merchant could
    // still take cancels work that was going to happen.
    const due = await findExpiredOrders({ limit: 500 });
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
    expect((await getOrderRecord(orderId)).status).toBe('PENDING_QUEUE');
  });

  it('finds an order that has waited out the window and has no deadline', async () => {
    const player = await actor({});
    const orderId = await staleUnassigned(player);

    const due = await findExpiredOrders({ limit: 500 });
    await new Promise((r) => setTimeout(r, 1200));
    const dueAfter = await findExpiredOrders({ limit: 500 });

    // Before the second it had not aged out; after it, it has.
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
    expect(dueAfter.map((o) => o.orderId)).toContain(orderId);
  });

  it('gives the player their tokens back — not just a cancelled status', async () => {
    const player = await actor({});
    const { creditWinnings, debitWinningsForWithdrawal } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(player.userId, 5000, 'assignment window suite seed', 'Test',
      `aw_seed_${player.userId}`, `aw_seed_${player.userId}`);

    const orderId = await staleUnassigned(player, { type: 'WITHDRAWAL', escrow: true });
    // The lock a real withdrawal takes, keyed on the order, so the refund the
    // sweep issues is the reversal of a movement that actually happened.
    await debitWinningsForWithdrawal(String(player.userId), 1000, orderId);

    const locked = await getBalances(player.userId);
    expect(Number(locked.lockedBalance)).toBeGreaterThanOrEqual(1000);

    // Age it past the window by giving it a deadline in the past — the same due
    // set, reached by the other clause, so this exercises the sweep rather than
    // the clock.
    await setOrderFields(orderId, { expiresAt: new Date(Date.now() - 60_000) });
    await expireOrders();

    const after = await getBalances(player.userId);
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
    // THE assertion. An order tidied away with the escrow still locked is the
    // same defect wearing a cancelled status.
    expect(Number(after.lockedBalance)).toBe(Number(locked.lockedBalance) - 1000);
    expect(Number(after.winningsBalance)).toBe(Number(locked.winningsBalance) + 1000);
  });
});
